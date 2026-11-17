import { type Journal, type Json, newId, type Projection } from "@seshat/core";
import { INFORMAL_PROOF_KIND, informalProofOfNodes } from "@seshat/memory";

/**
 * The formal-cost triage (plan change PA14, documentation/scheduler.md, "The budget gate"): before money goes into a problem, a guess at how large its
 * formalization will be, from what the journal already holds, so that the gate can put its spending where a proof is likely to fit. A pure function of
 * its input: no model call, no Lean. It is a prior and nothing more: it changes no claim's status, and a probe that made Lean progress is stronger
 * evidence than it is (the gate reads it only where the probe made none).
 */

/** The `formal_triage` node of a problem's claim. */
export const TRIAGE_KIND = "formal_triage";

/** The classes: `invest` (work it as usual), `short` (a try capped at a few probes), `skip` (the probe alone). */
export type TriageClass = "invest" | "short" | "skip";

/** An informal proof longer than this many characters is a large formalization. */
export const MAX_PROOF_CHARS = 6000;
/** More numbered steps or claims than this in the informal proof is a large formalization. */
export const MAX_STEPS = 12;
/** A proof this short, with every fact found and nothing against it, is worth the whole allowance. Between this and `MAX_PROOF_CHARS` the problem is a short try. */
export const SHORT_PROOF_CHARS = 4000;
/** When more than this share of the facts the proof relies on is not found in Mathlib by `lean.search`, the formalization starts with missing lemmas. */
export const MIN_FACT_SHARE = 0.5;
/** A statement longer than this many characters is not `invest`: its formalization starts large. */
export const LONG_STATEMENT_CHARS = 1500;
/** An allowance under this many dollars is small: a problem that would be a `short` try is a `skip`, since a short try has no room in it. */
export const SMALL_BUDGET_USD = 1;
/** A `short` problem may spend this many times the probe's cap in all (a probe with its one extension spends at most three). */
export const SHORT_PROBES = 3;

export interface TriageInput {
  /** The problem's newest `informal_proof` node; absent when the loop did not run. `text` is empty when the blob is not there. */
  informal?: { accepted: boolean; text: string; facts: readonly string[]; hits: readonly string[] } | undefined;
  /** Whether `lean.search` was available to look the facts up: when not, the facts are not judged. Default true. */
  searched?: boolean | undefined;
  /** `plausible`'s result (`counterexample`, `no_counterexample`, ...), from the problem's hygiene nodes. */
  plausible?: string | undefined;
  /** The first-cases table, when one was computed: its rows, and whether both sides differ on one of them. */
  firstCases?: { rows: number; differs: boolean } | undefined;
  /** The statement's length in characters. */
  statementChars?: number | undefined;
  /** The problem's allowance in dollars; absent: not small. */
  budgetUsd?: number | undefined;
}

export interface TriageResult {
  class: TriageClass;
  reasons: string[];
}

/** The steps a proof's text shows: lines that open with a number ("1.", "2)") or a "Step", "Claim" or "Lemma" and a number. */
export function proofSteps(text: string): number {
  return (text.match(/^[ \t]*(?:\(?\d{1,2}[.):]|(?:step|claim|lemma)\s+\d{1,2}\b)/gim) ?? []).length;
}

/** The share of the facts that `lean.search` found, taking the names that came back over the facts (at most 1); no fact: 1. */
export function factShare(facts: readonly string[], hits: readonly string[]): number {
  return facts.length === 0 ? 1 : Math.min(1, hits.length / facts.length);
}

export function triageProblem(input: TriageInput): TriageResult {
  const bad: string[] = [];
  const notInvest: string[] = [];
  const proof = input.informal;
  const text = proof?.text ?? "";
  if (proof === undefined || !proof.accepted) bad.push(proof === undefined ? "no informal proof was written" : "no informal proof was accepted");
  else {
    if (text.length > MAX_PROOF_CHARS) bad.push(`the informal proof has ${text.length} characters, over ${MAX_PROOF_CHARS}`);
    else if (text.length === 0) notInvest.push("the informal proof's text is not in the run: its length is not known");
    else if (text.length > SHORT_PROOF_CHARS) notInvest.push(`the informal proof has ${text.length} characters, over ${SHORT_PROOF_CHARS}`);
    const steps = proofSteps(text);
    if (steps > MAX_STEPS) bad.push(`the informal proof has ${steps} numbered steps, over ${MAX_STEPS}`);
    if (proof.facts.length > 0) {
      if (input.searched === false) notInvest.push(`${proof.facts.length} Mathlib fact(s) were not looked up (no lean.search)`);
      else {
        const share = factShare(proof.facts, proof.hits);
        if (share < MIN_FACT_SHARE) bad.push(`${proof.hits.length} name(s) found for ${proof.facts.length} Mathlib fact(s): under half are in Mathlib`);
        else if (share < 1) notInvest.push(`${proof.hits.length} name(s) found for ${proof.facts.length} Mathlib fact(s): not all are in Mathlib`);
      }
    }
  }
  if (input.statementChars !== undefined && input.statementChars > LONG_STATEMENT_CHARS) notInvest.push(`the statement has ${input.statementChars} characters, over ${LONG_STATEMENT_CHARS}`);
  if (input.plausible === "counterexample") notInvest.push("plausible found a counterexample: the statement is probably false, and a refutation is a short try");
  if (input.firstCases?.differs === true) notInvest.push(`the first cases differ on one of ${input.firstCases.rows} row(s): the statement is probably false, and a refutation is a short try`);
  if (bad.length > 0) {
    const small = input.budgetUsd !== undefined && input.budgetUsd < SMALL_BUDGET_USD;
    return { class: small ? "skip" : "short", reasons: [...bad, ...notInvest, small ? `the allowance of $${(input.budgetUsd as number).toFixed(4)} is under $${SMALL_BUDGET_USD}: a short try has no room` : "the allowance has room for a short try"] };
  }
  if (notInvest.length > 0) return { class: "short", reasons: notInvest };
  return { class: "invest", reasons: [`an accepted informal proof of ${text.length} characters, ${proofSteps(text)} numbered step(s), whose facts are found in Mathlib`] };
}

/** The `formal_triage` node's data: the class and the reasons, with the problem. */
export interface TriageData extends TriageResult {
  problemId: string;
}

/** Journals a triage as a `formal_triage` node of the claim (a record of the harness: no status changes). */
export function recordTriage(journal: Journal, o: { claimId: string; problemId: string; result: TriageResult }): string {
  const nodeId = newId("nod");
  const data: TriageData = { problemId: o.problemId, class: o.result.class, reasons: o.result.reasons };
  journal.emit("node.recorded", { nodeId, kind: TRIAGE_KIND, claimId: o.claimId, data: data as unknown as Json }, "orchestrator");
  return nodeId;
}

/** The newest triage among a claim's `formal_triage` nodes, or undefined. */
export function triageOfNodes(nodes: ReadonlyArray<{ data: unknown }>): TriageResult | undefined {
  for (const node of [...nodes].reverse()) {
    const d = node.data as Partial<TriageData> | null;
    if (typeof d !== "object" || d === null) continue;
    if ((d.class === "invest" || d.class === "short" || d.class === "skip") && Array.isArray(d.reasons)) return { class: d.class, reasons: d.reasons.map(String) };
  }
  return undefined;
}

/** What a live projection holds of a problem, as the triage's input: its newest informal proof (the text from `read`) and its `plausible` hygiene node's result. */
export function triageInputOfProjection(p: Projection, claimId: string, read: (hash: string) => string | undefined): Pick<TriageInput, "informal" | "plausible"> {
  const informal = informalProofOfNodes(p.nodes(INFORMAL_PROOF_KIND, claimId), read);
  const plausible = p
    .nodes("hygiene", claimId)
    .map((n) => n.data as { check?: unknown; result?: unknown })
    .filter((d) => d?.check === "plausible")
    .at(-1)?.result;
  return {
    informal: informal === undefined ? undefined : { accepted: informal.accepted, text: informal.text, facts: informal.facts, hits: informal.hits },
    plausible: typeof plausible === "string" ? plausible : undefined,
  };
}
