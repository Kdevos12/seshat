import { hash32, maskCommentsAndStrings, forbiddenTokensIn } from "@seshat/core";
import { parseSignature } from "@seshat/graph";
import { type LeanMeta, LeanMetaError } from "@seshat/lean-meta";
import type { SchemaData } from "@seshat/library";
import {
  abstractNames, antiUnify, type Bindings, binderNames, fillNodes, matchNodes, newAuContext, type Node, parseNodes, renderNodes, renumber, specificity, varsOf,
} from "./terms.ts";

/**
 * Schemas, instantiation and reuse for line M15 (documentation/schemas.md). A schema is read from a decomposition Lean checked and
 * whose leaves are all closed: its statements and main proof with the claim's binders as variables. It is learned from an outcome
 * and not from Lean, so it is stamped and shown only as unverified advice.
 */

/** A schema as token trees. */
export interface Skeleton {
  conclusion: Node[];
  parts: Node[][];
  proof: Node[];
  /** The variables that are a part's own binders, with the name the source gave them. */
  locals: Map<number, string>;
}

const MAX_STATEMENT = 600;
const MAX_PROOF = 2000;

/**
 * The strict screen of formal text that a mechanism keeps and later shows to a prover (Global Constraint 16): a statement or a proof
 * that came from a model's sketch. No comment (it could hold an instruction), no string, no control character, no token the validator
 * forbids, no `?` followed by a digit (a variable's notation), and a length. Returns the reason, or undefined when the text passes.
 */
export function screenFormal(text: string, max: number): string | undefined {
  if (text.trim() === "") return "it is empty";
  if (text.length > max) return `it is longer than ${max} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/u.test(text)) return "it holds control characters";
  if (/--|\/-|-\//.test(text)) return "it holds a comment";
  if (/"/.test(text)) return "it holds a string";
  if (/\?\d/.test(text)) return "it holds a variable's notation";
  const forbidden = forbiddenTokensIn(maskCommentsAndStrings(text));
  if (forbidden.length > 0) return `it holds a Lean token the validator forbids (${forbidden.join(", ")})`;
  return undefined;
}

/** The variable ids that are named in the binder groups of a skeleton conclusion: `(?1 : ℕ)` names ?1. */
export function binderVarsOf(conclusion: readonly Node[]): number[] {
  const ids: number[] = [];
  for (const n of conclusion) {
    if (n.kind === "leaf" && n.text === ":") break;
    if (n.kind === "group") {
      for (const kid of n.kids) {
        if (kid.kind === "leaf" && kid.text === ":") break;
        if (kid.kind === "var" && !ids.includes(kid.id)) ids.push(kid.id);
      }
    } else if (n.kind === "var" && !ids.includes(n.id)) ids.push(n.id);
  }
  return ids;
}

/**
 * The skeleton of a decomposition: the claim's binders become the variables `?1`, `?2`..., the same in the parts and the proof; the
 * binders a part adds become variables of their own, remembered by name. Returns why it cannot be one when a text does not pass
 * the screen, is not a statement in signature form, or the skeleton says too little (fewer fixed tokens than `minSpecificity`).
 */
export function skeletonOf(input: { conclusion: string; parts: readonly string[]; mainProof: string }, minSpecificity: number): Skeleton | string {
  const texts: Array<[string, string, number]> = [
    ["the claim", input.conclusion, MAX_STATEMENT],
    ...input.parts.map((p, k): [string, string, number] => [`part ${k + 1}`, p, MAX_STATEMENT]),
    ["the main proof", input.mainProof, MAX_PROOF],
  ];
  for (const [what, text, max] of texts) {
    const why = screenFormal(text, max);
    if (why !== undefined) return `${what}: ${why}`;
  }
  let conclusion: Node[];
  let parts: Node[][];
  let proof: Node[];
  try {
    parseSignature(input.conclusion);
    for (const p of input.parts) parseSignature(p);
    conclusion = parseNodes(input.conclusion);
    parts = input.parts.map((p) => parseNodes(p));
    proof = parseNodes(input.mainProof);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const shared = new Map<string, number>();
  for (const name of binderNames(conclusion)) if (!shared.has(name)) shared.set(name, shared.size + 1);
  let next = shared.size + 1;
  const local = new Map<number, string>();
  const abstractedParts = parts.map((part) => {
    const names = new Map(shared);
    for (const name of binderNames(part)) {
      if (names.has(name)) continue;
      names.set(name, next);
      local.set(next, name);
      next += 1;
    }
    return abstractNames(part, names);
  });
  const numbered = renumber([abstractNames(conclusion, shared), ...abstractedParts, abstractNames(proof, shared)]);
  const locals = new Map<number, string>();
  for (const [old, name] of local) {
    const id = numbered.map.get(old);
    if (id !== undefined) locals.set(id, name);
  }
  const [head, ...rest] = numbered.skeleton as [Node[], ...Node[][]];
  const skeleton: Skeleton = { conclusion: head, parts: rest.slice(0, -1), proof: rest.at(-1) as Node[], locals };
  if (specificity([skeleton.conclusion, ...skeleton.parts]) < minSpecificity) return "the skeleton is too general: it has too few fixed tokens";
  return skeleton;
}

// -- the stored form ------------------------------------------------------------------------------------------------

export const textOf = (nodes: readonly Node[]): string => renderNodes(nodes);

/** The fields of a `library_schema` node that come from a skeleton. */
export function dataOf(skeleton: Skeleton, rest: Pick<SchemaData, "names" | "family" | "region" | "supports" | "gloss">): SchemaData {
  const conclusion = textOf(skeleton.conclusion);
  const parts = skeleton.parts.map(textOf);
  const stem = rest.family.replace(/[^A-Za-z0-9]/g, "");
  return {
    name: `schema_${stem}_${String(hash32(`${conclusion}\n${parts.join("\n")}`) % 1_000_000).padStart(6, "0")}`,
    conclusion, parts, mainProof: textOf(skeleton.proof), binderVars: binderVarsOf(skeleton.conclusion),
    locals: Object.fromEntries([...skeleton.locals].map(([id, name]) => [String(id), name])),
    state: "active", ...rest,
  };
}

/** The skeleton of a stored schema. */
export function skeletonFrom(data: SchemaData): Skeleton {
  return {
    conclusion: parseNodes(data.conclusion), parts: data.parts.map((p) => parseNodes(p)), proof: parseNodes(data.mainProof),
    locals: new Map(Object.entries(data.locals).map(([id, name]) => [Number(id), name])),
  };
}

// -- merging --------------------------------------------------------------------------------------------------------

/** Whether `general` covers `special`: its skeleton matches the special one with one set of bindings for the conclusion and the parts, in order. */
export function covers(general: Skeleton, special: Skeleton): boolean {
  if (general.parts.length !== special.parts.length) return false;
  let bound: Bindings | undefined = matchNodes(general.conclusion, special.conclusion);
  for (let k = 0; bound !== undefined && k < general.parts.length; k++) bound = matchNodes(general.parts[k] as Node[], special.parts[k] as Node[], bound);
  return bound !== undefined && matchNodes(general.proof, special.proof, bound) !== undefined;
}

/**
 * The least general skeleton that covers both, by anti-unification of the claim, the parts and the main proof with one set of
 * variables: undefined when they do not line up (another number of parts, a proof of another shape) or the result says too little.
 */
export function generalize(a: Skeleton, b: Skeleton, minSpecificity: number): Skeleton | undefined {
  if (a.parts.length !== b.parts.length) return undefined;
  const c = newAuContext();
  const joined: Node[][] = [];
  for (const [x, y] of [[a.conclusion, b.conclusion], ...a.parts.map((p, k) => [p, b.parts[k] as Node[]]), [a.proof, b.proof]] as Array<[Node[], Node[]]>) {
    const g = antiUnify(x, y, c);
    if (g === undefined) return undefined;
    joined.push(g);
  }
  const numbered = renumber(joined);
  const locals = new Map<number, string>();
  for (const [key, id] of c.pairs) {
    const m = /^a(\d+)\u0000b(\d+)$/.exec(key);
    if (m === null) continue;
    const name = a.locals.get(Number(m[1]));
    if (name !== undefined && b.locals.has(Number(m[2]))) {
      const now = numbered.map.get(id);
      if (now !== undefined) locals.set(now, name);
    }
  }
  const [head, ...rest] = numbered.skeleton as [Node[], ...Node[][]];
  const out: Skeleton = { conclusion: head, parts: rest.slice(0, -1), proof: rest.at(-1) as Node[], locals };
  return specificity([out.conclusion, ...out.parts]) < minSpecificity ? undefined : out;
}

// -- instantiation --------------------------------------------------------------------------------------------------

export interface Instance {
  /** What the conclusion's variables are bound to in the goal. */
  bindings: Bindings;
  /** The parts as statements of the goal's problem, with the names the source gave the holes. */
  parts: Array<{ name: string; statement: string }>;
  /** The main proof with the goal's terms in place of the variables. */
  mainProof: string;
}

const named = (text: string): Node => ({ kind: "leaf", text, pre: "" });

/**
 * The schema at a goal: the conclusion's skeleton matched against the goal's statement (a lexical match, which `lean.meta` confirms
 * afterwards), and the parts and the main proof written with what the variables are bound to. A part's own binders keep the source's
 * names. Undefined when the goal does not match, or when a part or the proof has a variable the goal does not determine.
 */
export function instantiate(skeleton: Skeleton, names: readonly string[], goal: string): Instance | undefined {
  let target: Node[];
  try {
    target = parseNodes(goal);
  } catch {
    return undefined;
  }
  const bindings = matchNodes(skeleton.conclusion, target);
  if (bindings === undefined) return undefined;
  const all = new Map(bindings);
  for (const [id, name] of skeleton.locals) if (!all.has(id)) all.set(id, [named(name)]);
  const parts: Instance["parts"] = [];
  for (const [k, part] of skeleton.parts.entries()) {
    const filled = fillNodes(part, all);
    if (filled.free.length > 0) return undefined;
    parts.push({ name: names[k] ?? `aux_part_${k + 1}`, statement: renderNodes(filled.nodes) });
  }
  const proof = fillNodes(skeleton.proof, all);
  if (proof.free.length > 0) return undefined;
  return { bindings, parts, mainProof: renderNodes(proof.nodes) };
}

/**
 * The conclusion as a statement `lean.meta` can ask whether a goal is an instance of: the variables written as `x1`, `x2`...; the ones
 * that are not the claim's binders become binders with the type left to Lean (`(x3 : _)`), those that occur in a binder's type
 * before the claim's binders and the others after them.
 */
export function generalStatement(skeleton: Skeleton): string {
  const name = (id: number) => `x${id}`;
  const colon = skeleton.conclusion.findIndex((n) => n.kind === "leaf" && n.text === ":");
  const head = colon < 0 ? skeleton.conclusion : skeleton.conclusion.slice(0, colon);
  const tail = colon < 0 ? [] : skeleton.conclusion.slice(colon);
  const named = new Set(binderVarsOf(skeleton.conclusion));
  const gaps = varsOf(skeleton.conclusion).filter((id) => !named.has(id));
  const inHead = new Set(varsOf(head));
  const binder = (id: number) => `(${name(id)} : _)`;
  return [...gaps.filter((id) => inHead.has(id)).map(binder), renderNodes(head, name), ...gaps.filter((id) => !inHead.has(id)).map(binder), renderNodes(tail, name)]
    .filter((s) => s !== "")
    .join(" ");
}

/**
 * Whether `lean.meta` says the goal is an instance of the schema's conclusion. A refusal by Lean is a definite "no"; no answer (the
 * server is down, the call timed out) is "no" too, but `retry` says it may be different next time.
 */
export async function confirm(meta: LeanMeta, skeleton: Skeleton, goal: string, header: string, signal?: AbortSignal): Promise<{ ok: boolean; why?: string; retry?: boolean }> {
  try {
    const answer = await meta.instances(goal, [{ name: "schema", statement: generalStatement(skeleton) }], { header, ...(signal !== undefined ? { signal } : {}) });
    return answer.instanceOf.includes("schema") ? { ok: true } : { ok: false, why: "lean.meta: the goal is not an instance of the schema's conclusion" };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { ok: false, why: `lean.meta: ${error instanceof Error ? error.message : String(error)}`, retry: !(error instanceof LeanMetaError && error.kind === "rejected") };
  }
}

// -- reuse ----------------------------------------------------------------------------------------------------------

/**
 * Whether a decomposition has the shape of a schema: the schema's conclusion matches the claim, and its parts match the holes one
 * to one, under one set of bindings. This is how reuse is measured, whoever suggested the schema: a session reuses a schema when
 * its sketch is an instance of it.
 */
export function reuses(skeleton: Skeleton, claim: string, holes: readonly string[]): { reused: boolean; matched: number } {
  let target: Node[];
  let nodes: Node[][];
  try {
    target = parseNodes(claim);
    nodes = holes.map((h) => parseNodes(h));
  } catch {
    return { reused: false, matched: 0 };
  }
  const bound = matchNodes(skeleton.conclusion, target);
  if (bound === undefined) return { reused: false, matched: 0 };
  // A part's own binders match whatever the hole calls them.
  const best = (k: number, taken: ReadonlySet<number>, b: Bindings): number => {
    if (k === skeleton.parts.length) return 0;
    let most = best(k + 1, taken, b);
    for (const [j, hole] of nodes.entries()) {
      if (taken.has(j)) continue;
      const next = matchNodes(skeleton.parts[k] as Node[], hole, b);
      if (next !== undefined) most = Math.max(most, 1 + best(k + 1, new Set([...taken, j]), next));
    }
    return most;
  };
  const matched = best(0, new Set(), bound);
  return { reused: matched === skeleton.parts.length && holes.length === skeleton.parts.length, matched };
}
