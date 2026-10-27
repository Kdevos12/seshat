import { join } from "node:path";
import { AUX_BEGIN, AUX_END, BlobStore, extractSubmission, Journal, PROOF_BEGIN, PROOF_END, statementIdV0 } from "@seshat/core";
import type { EdgeKind } from "@seshat/core";
import type { Llm, ValidateResult } from "@seshat/lines";
import { MemoryStore, type StatementIdentity } from "@seshat/memory";
import { FakeChecker, type FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { ClaimBenches } from "../../orchestrator/src/validate.ts";
import { DemoLean, demoAnswer, demoRegistry, proofOf, tempDir } from "../../orchestrator/test/m0-helpers.ts";
import { checkEdge, proposeEdge, type ValidateFn } from "../src/index.ts";

export { FakeChecker, proofOf, tempDir };

/** The header every test claim is read under. */
export const HEADER = "import Mathlib";

/**
 * The simulated Lean of these tests. A reference file checks; a proof with `exact trivial_proof` is
 * accepted (the stand-in for any proof Lean would accept), and so is `exact Iff.rfl`; a composed proof (it uses the
 * `aux_m2_...` theorems of the graph) is accepted when every theorem it uses is declared before it
 * is used, which is the one thing about its structure a test can see without Lean. Anything else is
 * what `demoAnswer` says. No tactic is run: the composed proofs are not checked by a real Lean here.
 */
export function toyAnswer(code: string): FakeLeanAnswer {
  const direct = proofOf(code);
  if (direct === undefined) return {};
  // The proof Lean would accept for the link lemma of a negation edge.
  if (direct.trim() === "exact Iff.rfl") return {};
  if (!code.includes("aux_m2_")) return demoAnswer(code);
  const { aux, proof } = extractSubmission(code);
  const declared = new Set<string>();
  const body = (text: string): FakeLeanAnswer => {
    for (const [name] of text.matchAll(/aux_m2_[A-Za-z0-9_]+/g)) {
      if (!declared.has(name)) return { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: `unknown identifier '${name}'` }] };
    }
    return {};
  };
  for (const piece of aux.split(/\n(?=theorem |lemma |def |abbrev )/)) {
    const head = /^(?:theorem|lemma|def|abbrev)\s+(\S+)/.exec(piece.trim());
    const [, name] = head ?? [];
    const rest = head === null ? piece : piece.replace(/^(?:theorem|lemma|def|abbrev)\s+\S+/, "");
    const wrong = body(rest);
    if (wrong.messages !== undefined) return wrong;
    if (name !== undefined) declared.add(name);
  }
  return body(proof);
}

export { AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END };

/**
 * A statement identity that tells one text under two headers apart, as the text identity of a run
 * does: the same statement under another header is another claim.
 */
export const headerIdentity: StatementIdentity = {
  version: "st0",
  id: (statement, context = {}) => statementIdV0(context.header === undefined ? statement : `${context.header} ⊢ ${statement}`),
};

export interface World {
  journal: Journal;
  memory: MemoryStore;
  lean: DemoLean;
  validate: ValidateFn;
  close: () => void;
  dir: string;
}

/**
 * A journal and a memory over it, with the lines' `validate` of a run (`ClaimBenches`: a workbench
 * per claim) over a simulated Lean, so that a test runs the real validation path without a run.
 */
export function world(answer: (code: string) => FakeLeanAnswer = toyAnswer, identity?: StatementIdentity): World {
  const dir = tempDir("mh-graph-");
  const journal = Journal.open(dir, "run_graph");
  const blobs = new BlobStore(join(dir, "blobs"));
  const memory = new MemoryStore({ journal, blobs, actor: "line:M2", ...(identity !== undefined ? { identity } : {}) });
  const lean = new DemoLean(answer);
  const registry = demoRegistry(lean)(journal, blobs);
  const benches = new ClaimBenches({ journal, registry, memory, blobs });
  const signal = new AbortController().signal;
  const validate: ValidateFn = (request): Promise<ValidateResult> => benches.validate(request, { actor: "line:M2", signal });
  return { journal, memory, lean, validate, close: () => journal.close(), dir };
}

/** A formal claim of the test header. */
export async function claim(w: World, statement: string, extra: { gloss?: string; parentId?: string } = {}): Promise<string> {
  return (await w.memory.ensureClaim({ statement, origin: "test", header: HEADER, ...extra })).claimId;
}

/** A valid proof of a claim, which makes it `computed`. */
export async function prove(w: World, claimId: string, proof = "exact trivial_proof"): Promise<ValidateResult> {
  const result = await w.validate({ claimId, proof });
  if (result.verdict !== "valid") throw new Error(`the proof of ${claimId} was refused: ${result.reasons.join("; ")}`);
  return result;
}

/** An edge between claims, proposed and then checked by its link lemma (proved by `exact trivial_proof`). */
export async function link(w: World, kind: EdgeKind, from: string, ...to: string[]): Promise<string> {
  const edge = proposeEdge(w.memory, { kind, from, to });
  const checked = await checkEdge({ memory: w.memory, validate: w.validate, header: HEADER, closers: ["exact trivial_proof"] }, edge.edgeId);
  if (!checked.checked) throw new Error(`the ${kind} edge was not checked: ${checked.reason}`);
  return edge.edgeId;
}

/** The last valid proof (or, for `negation`, refutation) the memory holds for a claim. */
function lastValid(w: World, claimId: string, negation: boolean, verb: string) {
  const last = w.memory
    .validations(claimId)
    .filter((v) => v.verdict === "valid" && v.negation === negation)
    .at(-1);
  if (last === undefined) throw new Error(`${verb}: claim ${claimId} has no valid ${negation ? "refutation" : "proof"}`);
  return last;
}

/**
 * Certifies the last valid proof (or, for `negation`, refutation) of a claim, as the certifier on the
 * host would: a `kernel_replay` validation, and the claim `proved` (`refuted`). A test writes these
 * events itself because certification is not wired for the claims a line validates.
 */
export function certify(w: World, claimId: string, negation = false): void {
  const last = lastValid(w, claimId, negation, "certify");
  const validationId = `val_kernel_${last.validationId}`;
  w.journal.emit(
    "validation.finished",
    { validationId, claimId, method: "kernel_replay", verdict: "valid", reasons: [], axioms: [], submissionHash: last.submissionHash, ...(negation ? { negation: true } : {}) },
    "certifier",
  );
  const from = w.memory.claim(claimId)?.status;
  if (from === undefined) throw new Error(`certify: unknown claim ${claimId}`);
  w.journal.emit("claim.status_changed", { claimId, from, to: negation ? "refuted" : "proved", reason: "certified", validationId }, "orchestrator");
}

/**
 * Records that the certifier rejected the last valid proof (or, for `negation`, refutation) of a
 * claim: an invalid `kernel_replay` validation of the same file. The claim keeps its status, as it
 * does in a run.
 */
export function reject(w: World, claimId: string, negation = false): void {
  const last = lastValid(w, claimId, negation, "reject");
  w.journal.emit(
    "validation.finished",
    {
      validationId: `val_kernel_${last.validationId}`,
      claimId,
      method: "kernel_replay",
      verdict: "invalid",
      reasons: ["kernel: declaration has metavariables"],
      axioms: [],
      submissionHash: last.submissionHash,
      ...(negation ? { negation: true } : {}),
    },
    "certifier",
  );
}

/** A model that answers from a script: `answer(prompt, call number)`. Records every prompt. */
export function scripted(answer: (prompt: string, call: number) => string | Promise<string>): { llm: Llm; prompts: string[] } {
  const prompts: string[] = [];
  const llm: Llm = {
    complete: async (request) => {
      prompts.push(request.prompt);
      const text = await answer(request.prompt, prompts.length);
      return { text, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, model: "test/model", modelCallId: `mc_${prompts.length}` };
    },
  };
  return { llm, prompts };
}

/** A fenced Lean block, as a model writes it. */
export const lean = (text: string): string => `\`\`\`lean\n${text}\n\`\`\``;
