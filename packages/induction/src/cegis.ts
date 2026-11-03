import { hashJson, type Json } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import type { DataTable } from "./datatable.ts";
import { executeHypotheses, type Hypothesis } from "./hypotheses.ts";
import type { ProgramLimits } from "./sandbox.ts";

/**
 * The CEGIS rule (plan change PD5) for the lines M8, M14 and M16. The counterexamples already found for a claim form
 * a set, kept in the memory with the checker that produced each one. The set goes into the proposer's prompt, and a
 * new candidate is run against the whole set before anything else is spent on it: a candidate that fails a known
 * counterexample is dropped without a model-priced check. A model's own claim of a counterexample is not in the set
 * until a checker confirms it (`admitCounterexample` takes only a checker's name as a source).
 */

export const COUNTEREXAMPLE_KIND = "counterexample";
export const CEGIS_DROP_KIND = "cegis_drop";

/** What can put an object in the set: a program run on a table object, a fingerprint run, `plausible`, a finite model (Task 7), a Lean `decide`. */
export const COUNTEREXAMPLE_SOURCES = ["table_run", "fingerprint", "plausible", "finite_model", "lean_decide"] as const;
export type CounterexampleSource = (typeof COUNTEREXAMPLE_SOURCES)[number];

export const isCheckerSource = (source: unknown): source is CounterexampleSource => typeof source === "string" && (COUNTEREXAMPLE_SOURCES as readonly string[]).includes(source);

export interface Counterexample {
  /** The object as the programs receive it (a number, a magma). */
  object: Json;
  /** Its name in the table, or the number as text. */
  id: string;
  source: CounterexampleSource;
  /** What it refuted: the id of a hypothesis, or a short name of the candidate. */
  refutes: string;
}

export type Admission = { admitted: true; created: boolean } | { admitted: false; reason: string };

/** Puts a counterexample in the claim's set when a checker produced it. Anything else is refused and leaves the set as it was. */
export function admitCounterexample(memory: MemoryStore, claimId: string, ce: { object: Json; id: string; source: string; refutes: string }): Admission {
  if (!isCheckerSource(ce.source)) return { admitted: false, reason: `"${ce.source}" is not a checker (${COUNTEREXAMPLE_SOURCES.join(", ")}): a claim of a counterexample stays out of the set until a checker confirms it` };
  if (readCounterexamples(memory, claimId).some((x) => x.id === ce.id && x.refutes === ce.refutes && x.source === ce.source)) return { admitted: true, created: false };
  memory.recordNode({ kind: COUNTEREXAMPLE_KIND, claimId, data: { object: ce.object, id: ce.id, source: ce.source, refutes: ce.refutes } as unknown as Json });
  return { admitted: true, created: true };
}

/** The claim's set, oldest first. A node that is not in the shape (a hand-written one) is not read. */
export function readCounterexamples(memory: MemoryStore, claimId: string): Counterexample[] {
  const out: Counterexample[] = [];
  for (const node of memory.nodes(COUNTEREXAMPLE_KIND, { claimId })) {
    const d = node.data as Partial<Counterexample> | undefined;
    if (d === undefined || d === null || !isCheckerSource(d.source) || typeof d.id !== "string" || typeof d.refutes !== "string" || d.object === undefined) continue;
    out.push({ object: d.object, id: d.id, source: d.source, refutes: d.refutes });
  }
  return out;
}

/** The set as the proposer sees it: one line for each object, with what it refuted and who found it. Empty when the set is. */
export function describeCounterexamples(set: readonly Counterexample[], max = 12, programs = false): string {
  if (set.length === 0) return "";
  const shown = new Map<string, Counterexample>();
  for (const c of set) if (!shown.has(c.id)) shown.set(c.id, c);
  const lines = [...shown.values()].slice(-max).map((c) => `- ${c.id} (checked by ${c.source.replace("_", " ")}; it refuted: ${c.refutes})`);
  return programs
    ? `Outputs a checker already refuted for this task, each confirmed (Lean rejected it). A program that builds one is dropped before it is scored:\n${lines.join("\n")}`
    : `Objects already shown to refute earlier candidates, each confirmed by a checker. A candidate that fails on one is dropped before anything is spent on it:\n${lines.join("\n")}`;
}

/** A rough count of the tokens of a text: four characters each. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * The tokens a dropped candidate would have cost in the model-priced steps that follow the check: the step DAG and the
 * formalization of an informal hypothesis (the prompts and a typical answer), or nothing for a candidate that came with
 * its Lean statement (the Lean test lemma is not priced in tokens). An estimate, stated as one in the documentation.
 */
export const STEP_TOKENS = 350;
export function tokensSavedFor(h: Pick<Hypothesis, "informal" | "statement">, target: string): number {
  return h.statement === undefined ? 2 * (STEP_TOKENS + estimateTokens(h.informal) + estimateTokens(target)) : 0;
}

export interface Dropped {
  hypothesis: Hypothesis;
  by: Counterexample;
}

/**
 * Runs the hypotheses on the objects of the set only, and returns those that hold on all of them and those that fail on
 * one. The set is small and its objects are known: this costs a sandbox run, not a model call.
 */
export async function screenBySet(hypotheses: readonly Hypothesis[], set: readonly Counterexample[], limits?: Partial<ProgramLimits>, signal?: AbortSignal): Promise<{ kept: Hypothesis[]; dropped: Dropped[] }> {
  if (set.length === 0 || hypotheses.length === 0) return { kept: [...hypotheses], dropped: [] };
  const pseudo = { objects: set.map((c) => c.object) } as unknown as DataTable;
  const executed = await executeHypotheses(pseudo, hypotheses, limits, signal);
  const kept: Hypothesis[] = [];
  const dropped: Dropped[] = [];
  for (const e of executed) {
    const first = e.counterexamples[0];
    if (first === undefined) kept.push(e.hypothesis);
    else dropped.push({ hypothesis: e.hypothesis, by: set[first] as Counterexample });
  }
  return { kept, dropped };
}

/** One candidate dropped by the set: a node, written once for a (line, candidate) of the claim, which the counter reads. */
export function recordDrop(memory: MemoryStore, claimId: string, drop: { line: string; candidate: string; by: Counterexample; tokensSaved: number }): boolean {
  const key = hashJson({ line: drop.line, candidate: drop.candidate } as unknown as Json).slice(0, 16);
  if (memory.nodes(CEGIS_DROP_KIND, { claimId }).some((n) => (n.data as { key?: string }).key === key)) return false;
  memory.recordNode({ kind: CEGIS_DROP_KIND, claimId, data: { key, line: drop.line, candidate: drop.candidate, object: drop.by.id, source: drop.by.source, tokensSaved: drop.tokensSaved } as unknown as Json });
  return true;
}

export interface CegisCounter {
  /** Candidates dropped by the set. */
  dropped: number;
  /** The tokens the model-priced steps they skipped would have cost, against a baseline without the set (an estimate). */
  tokensSaved: number;
  byLine: Record<string, number>;
  bySource: Record<string, number>;
}

/** The counter of Task 14's table: what the set dropped, for one claim or (with no claim) for all of the memory. */
export function cegisCounter(memory: MemoryStore, claimId?: string): CegisCounter {
  const out: CegisCounter = { dropped: 0, tokensSaved: 0, byLine: {}, bySource: {} };
  for (const node of memory.nodes(CEGIS_DROP_KIND, claimId !== undefined ? { claimId } : {})) {
    const d = node.data as { line?: string; source?: string; tokensSaved?: number };
    out.dropped++;
    out.tokensSaved += typeof d.tokensSaved === "number" ? d.tokensSaved : 0;
    if (typeof d.line === "string") out.byLine[d.line] = (out.byLine[d.line] ?? 0) + 1;
    if (typeof d.source === "string") out.bySource[d.source] = (out.bySource[d.source] ?? 0) + 1;
  }
  return out;
}
