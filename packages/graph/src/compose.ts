import { collapseWhitespace, extractSubmission, readDeclarationHead, splitCommands, type Submission } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import type { Explanation } from "./engine.ts";
import type { Fact, Goal } from "./rules.ts";
import { applied, closedProp, parseSignature } from "./signature.ts";

/** Where composed proofs find their pieces: the claims' statements and proofs, and the link lemmas. */
export interface ProofSource {
  /** A formal claim's statement in signature form. */
  statementOf(claimId: string): string | undefined;
  /** A valid proof of a claim (`proved`) or of its negation (`refuted`), as the two editable regions. */
  proofOf(claimId: string, goal: Goal): Submission | undefined;
  /** The link lemma of a `lean_checked` edge with the proof that checked it, and the edge's targets. */
  link(edgeId: string): Promise<{ statement: string; submission: Submission; to: string[] } | undefined>;
}

/**
 * The pieces of the memory: validations name a submission by its hash, which the blob store keeps.
 * `headerOf` gives the header a claim is read under (the one `realize` is given): a link lemma is
 * stated under the header of its edge's `from` claim, and an identity that reads the header gives
 * the same text another id under another header.
 */
export function memorySource(memory: MemoryStore, headerOf?: (claimId: string) => string | undefined): ProofSource {
  const submissionOf = (hash: string): Submission | undefined => {
    try {
      const text = memory.blobs.get(hash);
      return text === undefined ? undefined : extractSubmission(text);
    } catch {
      return undefined;
    }
  };
  return {
    statementOf: (claimId) => {
      const claim = memory.claim(claimId);
      return claim === undefined || claim.kind !== "formal" ? undefined : claim.statement;
    },
    proofOf: (claimId, goal) => {
      for (const v of memory.validations(claimId).reverse()) {
        if (v.verdict !== "valid" || v.negation !== (goal === "refuted")) continue;
        const submission = submissionOf(v.submissionHash);
        if (submission !== undefined) return submission;
      }
      return undefined;
    },
    link: async (edgeId) => {
      const edge = memory.edge(edgeId);
      if (edge?.link === undefined || edge.validationId === undefined) return undefined;
      for (const header of new Set([headerOf?.(edge.from), memory.claim(edge.from)?.header, undefined])) {
        let id: string | undefined;
        try {
          id = await memory.identity.id(edge.link.statement, header === undefined ? {} : { header });
        } catch {
          // An identity that elaborates statements may refuse one it cannot read under this header: try the next.
          continue;
        }
        const lemma = memory.claimByStatement(id);
        const validation = lemma === undefined ? undefined : memory.validations(lemma.claimId).find((v) => v.validationId === edge.validationId);
        const submission = validation === undefined ? undefined : submissionOf(validation.submissionHash);
        if (submission !== undefined) return { statement: edge.link.statement, submission, to: edge.to };
      }
      return undefined;
    },
  };
}

export type Composition =
  | { ok: true; negation: boolean; submission: Submission; pieces: number }
  | { ok: false; reason: string };

class ComposeError extends Error {}

/**
 * Writes the proof of a derived fact from its derivation tree: a Lean proof of the claim (or of its
 * negation) made of the proofs of the premises and the link lemmas of the edges, that `validate`
 * checks like any other. Each proof it reuses becomes an auxiliary theorem (`aux_m2_p1`, `aux_m2_l1`,
 * ...) with its own auxiliary declarations renamed apart; each derived step becomes one more, whose
 * body applies the link lemma to the premises; the last step is the proof itself.
 *
 * It fails, with the reason, when a premise has no proof on record, an edge lost its link proof, or
 * the claims do not share a header (their statements would not be read in the same context).
 */
export async function composeProof(tree: Explanation, source: ProofSource, headerOf: (claimId: string) => string | undefined): Promise<Composition> {
  if (tree.base) return { ok: false, reason: "the fact has a proof of its own" };
  const pieces: string[] = [];
  const named = new Map<string, string>();
  const links = new Map<string, string>();
  const headers = new Set<string>();
  const counters = { p: 0, r: 0, l: 0, d: 0 };
  const fresh = (kind: keyof typeof counters) => `aux_m2_${kind}${++counters[kind]}`;

  const statementOf = (claimId: string): string => {
    const statement = source.statementOf(claimId);
    if (statement === undefined) throw new ComposeError(`claim ${claimId} has no Lean statement`);
    headers.add(collapseWhitespace(headerOf(claimId) ?? ""));
    return statement;
  };
  /** The statement of the theorem that proves a fact: the claim's, or its negation as one proposition. */
  const theoremStatement = (fact: Fact): string =>
    fact.goal === "proved" ? statementOf(fact.claim).trim() : `: ¬ (${closedProp(parseSignature(statementOf(fact.claim)))})`;
  const reuse = (name: string, statement: string, submission: Submission): void => {
    const prefix = name.slice("aux_".length);
    const { aux, proof } = renameAux(submission, prefix);
    if (aux.trim() !== "") pieces.push(aux.trimEnd());
    pieces.push(`theorem ${name} ${statement} := by\n${indent(proof)}`);
  };

  const declare = async (node: Explanation): Promise<string> => {
    const key = `${node.fact.goal}:${node.fact.claim}`;
    const known = named.get(key);
    if (known !== undefined) return known;
    let name: string;
    if (node.base) {
      const submission = source.proofOf(node.fact.claim, node.fact.goal);
      if (submission === undefined) throw new ComposeError(`claim ${node.fact.claim} has no proof ${node.fact.goal === "proved" ? "" : "of its negation "}on record`);
      name = fresh(node.fact.goal === "proved" ? "p" : "r");
      reuse(name, theoremStatement(node.fact), submission);
    } else {
      const step = await derive(node);
      name = fresh("d");
      pieces.push(`theorem ${name} ${theoremStatement(node.fact)} := by\n${indent(step)}`);
    }
    named.set(key, name);
    return name;
  };

  /** The tactic of a derived step, after the pieces it uses are declared. */
  const derive = async (node: Explanation): Promise<string> => {
    const premises = [];
    for (const premise of node.premises ?? []) premises.push(await declare(premise));
    const edgeId = node.edge as string;
    const link = await source.link(edgeId);
    if (link === undefined) throw new ComposeError(`edge ${edgeId} has no link proof on record`);
    let linkName = links.get(edgeId);
    if (linkName === undefined) {
      linkName = fresh("l");
      links.set(edgeId, linkName);
      reuse(linkName, link.statement.trim(), link.submission);
    }
    const args = node.fact.goal === "proved" ? applied("", parseSignature(statementOf(node.fact.claim))) : "";
    return tacticOf(node, linkName, premises, args, link.to);
  };

  try {
    const proof = await derive(tree);
    if (headers.size > 1) return { ok: false, reason: "the claims do not share a header" };
    return { ok: true, negation: tree.fact.goal === "refuted", submission: { aux: pieces.join("\n\n"), proof }, pieces: pieces.length };
  } catch (error) {
    if (error instanceof ComposeError) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * The tactic that gives a derived fact from the link lemma `L` and the premises `X` (names of
 * theorems, in the order of the rule's premises). `args` applies a proof of a closed proposition to
 * the binders of the goal (` n m`), for a conclusion that is a claim's own statement.
 */
function tacticOf(node: Explanation, L: string, X: readonly string[], args: string, targets: readonly string[]): string {
  const x = (k: number) => X[k] as string;
  switch (node.rule) {
    case "implies/proved":
    case "strengthens/proved":
    case "special_case_of/proved":
    case "instance_of/proved":
      return `exact ${L} ${x(0)}${args}`;
    case "implies/refuted":
    case "strengthens/refuted":
    case "special_case_of/refuted":
    case "instance_of/refuted":
      return `exact fun h => ${x(0)} (${L} h)`;
    case "equiv/proved-forward":
      return `exact ${L}.mp ${x(0)}${args}`;
    case "equiv/proved-backward":
      return `exact ${L}.mpr ${x(0)}${args}`;
    case "equiv/refuted-forward":
      return `exact fun h => ${x(0)} (${L}.mpr h)`;
    case "equiv/refuted-backward":
      return `exact fun h => ${x(0)} (${L}.mp h)`;
    case "negation_of/proved":
      return `exact ${L}.mp ${x(0)}`;
    case "negation_of/refuted":
      return `exact Classical.not_not.mp (fun h => ${x(0)} (${L}.mpr h))${args}`;
    case "negation_of/proved-back":
      return `exact fun h => (${L}.mp h) ${x(0)}`;
    case "negation_of/refuted-back":
      return `exact ${L}.mpr ${x(0)}${args}`;
    case "decomposes_into/parts":
      return `exact ${L} ${X.join(" ")}${args}`;
    case "decomposes_into/last-part": {
      // X: the refutation of the whole, then the other parts in order; `h` stands for the missing one.
      const missing = targets.indexOf(node.fact.claim);
      const others = X.slice(1);
      const parts = targets.map((_, k) => (k === missing ? "h" : (others[k < missing ? k : k - 1] as string)));
      return `exact fun h => ${x(0)} (${L} ${parts.join(" ")})`;
    }
    case "refuted_by/counterexample":
      return `exact ${L} ${x(0)}`;
    default:
      throw new ComposeError(`no composition for the rule ${String(node.rule)}`);
  }
}

/** Gives the auxiliary declarations of a submission names of their own (`aux_foo` → `aux_<prefix>_foo`). */
function renameAux(submission: Submission, prefix: string): Submission {
  const renames = new Map<string, string>();
  for (const command of splitCommands(submission.aux)) {
    if (command.kind !== "code") continue;
    let text = command.text;
    for (;;) {
      const scoped = /^\s*(?:open\s[^\n]*?\sin|set_option\s+\S+\s+\S+\s+in)\s+/.exec(text);
      if (scoped === null) break;
      text = text.slice(scoped[0].length);
    }
    const name = readDeclarationHead(text)?.name;
    if (name !== undefined && name.startsWith("aux_")) renames.set(name, `aux_${prefix}_${name.slice("aux_".length)}`);
  }
  const rename = (text: string): string => {
    let out = text;
    for (const [from, to] of renames) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_'.!?])${escaped}(?![\\p{L}\\p{N}_'!?])`, "gu"), to);
    }
    return out;
  };
  return { aux: rename(submission.aux), proof: rename(submission.proof) };
}

/** A block of tactic lines, dedented and indented by two spaces, as the body of a theorem. */
function indent(text: string): string {
  const lines = text.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const widths = lines.filter((line) => line.trim() !== "").map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const cut = widths.length === 0 ? 0 : Math.min(...widths);
  return lines.map((line) => (line.trim() === "" ? "" : `  ${line.slice(cut)}`)).join("\n");
}
