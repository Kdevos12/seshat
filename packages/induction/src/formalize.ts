import { type LeanChecker, maskCommentsAndStrings, type Json } from "@seshat/core";
import { checkStepDag, type StepDag, stepDagSchema } from "@seshat/fleet";
import { completeJson, type Llm, withAntiSycophancy } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { evaluateWithLean, recognizeStatement } from "@seshat/models";
import type { Hypothesis } from "./hypotheses.ts";
import { statementProblem } from "./screen.ts";

/**
 * From an informal hypothesis to a statement Lean can be asked about (plan change PC11 item 2): an informal
 * hypothesis goes through the step DAG first, the way an informal-first session does (`checkStepDag` of the
 * fleet: acyclic, no forward reference, every step used), and only then is formalized; the model's Lean text
 * goes through the strict screen. Test lemmas on the first cases and a triviality filter come after.
 */

/** The node kind of the DAG of an informal hypothesis. */
export const HYPOTHESIS_DAG_KIND = "hypothesis_dag";

export interface HypothesisDag {
  nodeId: string;
  dag: StepDag;
  claims: { [stepId: string]: string };
}

const MAX_STEPS = 6;

/** Asks for the DAG of the argument for a hypothesis (site `induction.dag`); one retry with what was wrong. Undefined when two tries do not check. */
export async function proposeHypothesisDag(llm: Llm, hypothesis: Hypothesis, target: string, o: { model?: string; round?: number } = {}): Promise<{ dag?: StepDag; problems: string[] }> {
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const fix = problems.length === 0 ? "" : `\n\nYour previous DAG was refused: ${problems.slice(0, 6).join("; ")}.\nWrite it again so that it checks.`;
    const answer = await completeJson<StepDag>(llm, {
      system: withAntiSycophancy("You write informal mathematical arguments as step graphs. Your answer is read by a program."),
      prompt:
        `Target: ${target}\n\nHypothesis (${hypothesis.level}): ${hypothesis.informal}\n\n` +
        `Before any Lean, break the argument that this hypothesis holds into at most ${MAX_STEPS} steps, each a statement in plain mathematical language that a later step uses. ` +
        "List them in order, each after the ones it uses; the last is the hypothesis itself; every other step must be used by a later one. " +
        `If you come to believe it is false, say why in \`doubt\`.${fix}${o.round !== undefined ? `\n(round ${o.round})` : ""}`,
      schema: stepDagSchema(MAX_STEPS),
      site: "induction.dag",
      reuse: true,
      ...(o.model !== undefined ? { model: o.model } : {}),
    });
    problems = checkStepDag(answer.value, MAX_STEPS);
    if (problems.length === 0) return { dag: answer.value, problems };
  }
  return { problems };
}

/** Records a checked DAG: an informal claim for each step, `decomposes_into` proposals, and the node (written last). */
export async function recordHypothesisDag(memory: MemoryStore, claimId: string, hypothesisId: string, dag: StepDag): Promise<HypothesisDag> {
  const claims: { [stepId: string]: string } = {};
  for (const step of dag.steps) claims[step.id] = (await memory.ensureClaim({ statement: step.statement, kind: "informal", origin: "line:M8", parentId: claimId })).claimId;
  const link = (from: string, to: string[]): void => {
    const known = memory.edges({ from, kinds: ["decomposes_into"] }).some((e) => e.to.length === to.length && e.to.every((id, i) => id === to[i]));
    if (!known) memory.addEdge({ kind: "decomposes_into", from, to, note: `step DAG of the hypothesis ${hypothesisId}` });
  };
  for (const step of dag.steps) if (step.dependsOn.length > 0) link(claims[step.id] as string, step.dependsOn.map((id) => claims[id] as string));
  const last = dag.steps.at(-1);
  if (last !== undefined) link(claimId, [claims[last.id] as string]);
  const node = memory.recordNode({ kind: HYPOTHESIS_DAG_KIND, claimId, learned: true, data: { hypothesis: hypothesisId, proof: dag.proof, steps: dag.steps as unknown as Json, claims, ...(dag.doubt !== undefined ? { doubt: dag.doubt } : {}) } });
  return { nodeId: node.nodeId, dag, claims };
}

/**
 * ProofScore's dependency-match term, as a fidelity measure: how well the formalization's dependencies agree
 * with the DAG's. The formalization writes one lemma `aux_<id>` for each step; the edges it uses are the other
 * `aux_` names each lemma mentions. The measure is the F1 of the two edge sets (1 when both are empty).
 */
export function dependencyMatch(dag: StepDag, source: string): { score: number; declared: number; found: number } {
  const text = maskCommentsAndStrings(source, { strict: true });
  const ids = new Set(dag.steps.map((s) => s.id));
  const heads = [...text.matchAll(/\b(?:lemma|theorem)\s+aux_([a-z][a-z0-9_]*)/g)];
  const found = new Set<string>();
  heads.forEach((m, k) => {
    const id = m[1] as string;
    if (!ids.has(id)) return;
    const body = text.slice((m.index ?? 0) + m[0].length, heads[k + 1]?.index ?? text.length);
    for (const used of body.matchAll(/\baux_([a-z][a-z0-9_]*)/g)) if (used[1] !== id && ids.has(used[1] as string)) found.add(`${used[1]}>${id}`);
  });
  const declared = new Set(dag.steps.flatMap((s) => s.dependsOn.map((d) => `${d}>${s.id}`)));
  if (declared.size === 0 && found.size === 0) return { score: 1, declared: 0, found: 0 };
  const both = [...found].filter((e) => declared.has(e)).length;
  const p = found.size === 0 ? 0 : both / found.size;
  const r = declared.size === 0 ? 0 : both / declared.size;
  return { score: p + r === 0 ? 0 : (2 * p * r) / (p + r), declared: declared.size, found: found.size };
}

/** Asks for the Lean statement of an informal hypothesis (site `induction.formalize`). The text is screened: undefined with the reason when it fails. */
export async function formalizeHypothesis(llm: Llm, hypothesis: Hypothesis, target: string, header: string, o: { model?: string; dag?: StepDag } = {}): Promise<{ statement?: string; problem?: string }> {
  const steps = o.dag === undefined ? "" : `\nThe argument, in steps: ${o.dag.steps.map((s) => `${s.id}: ${s.statement}`).join(" ")}`;
  const answer = await completeJson<{ statement: string }>(llm, {
    system: withAntiSycophancy("You write Lean 4 statements. Your answer is read by a program."),
    prompt:
      `Target: ${target}\nLean header:\n${header}\n\nHypothesis: ${hypothesis.informal}${steps}\n\n` +
      "Write the hypothesis as a Lean 4 statement in signature form: the binders, then ':' and the proposition. No ':=', no proof, no theorem keyword.",
    schema: { type: "object", properties: { statement: { type: "string", minLength: 1 } }, required: ["statement"], additionalProperties: false },
    site: "induction.formalize",
    reuse: true,
    ...(o.model !== undefined ? { model: o.model } : {}),
  });
  const problem = statementProblem(answer.value.statement);
  return problem === undefined ? { statement: answer.value.statement } : { problem };
}

// --- Test lemmas on the first cases ------------------------------------------------------------

export interface TestLemmas {
  /** `passed`: Lean's `decide` accepted the statement on every case it settled; `failed`: it refuted one; `skipped`: the statement is not of a shape the cases can be tried in. */
  result: "passed" | "failed" | "skipped" | "inconclusive";
  /** The cases tried, and the first one that failed. */
  tried: number;
  failedAt?: number;
  note?: string;
}

/**
 * The statement tried in Lean on the first `cases` natural numbers (`decide` on each instance, the evaluator of
 * M11). A statement the evaluator does not read is `skipped`, with the reason; a case Lean refutes is `failed`,
 * and the hypothesis is dropped (its program and its statement disagree).
 */
export async function testLemmas(checker: LeanChecker, header: string, statement: string, cases: number, o: { timeoutSec?: number; signal?: AbortSignal; maxFiles?: number } = {}): Promise<TestLemmas> {
  const recognized = recognizeStatement(statement);
  if (!("statement" in recognized)) return { result: "skipped", tried: 0, note: recognized.reason };
  if (recognized.statement.kind !== "nat") return { result: "skipped", tried: 0, note: "only statements about a natural number are tried on their first cases" };
  const objects = Array.from({ length: cases }, (_, i) => ({ kind: "integer" as const, id: String(i), value: i }));
  const evaluation = await evaluateWithLean(checker, { header, statement: recognized.statement, objects }, { timeoutSec: o.timeoutSec ?? 60, ...(o.signal !== undefined ? { signal: o.signal } : {}), ...(o.maxFiles !== undefined ? { maxFiles: o.maxFiles } : {}) });
  if (evaluation.unusable !== undefined) return { result: "skipped", tried: 0, note: evaluation.unusable };
  const failedAt = evaluation.verdicts.findIndex((v) => v === false);
  if (failedAt >= 0) return { result: "failed", tried: evaluation.verdicts.length, failedAt };
  const settled = evaluation.verdicts.filter((v) => v === true).length;
  return settled === 0 ? { result: "inconclusive", tried: evaluation.verdicts.length, note: "decide settled none of the cases" } : { result: "passed", tried: settled };
}

// --- Triviality --------------------------------------------------------------------------------

/** Whether the statement is closed by cheap automation: then it is not interesting. */
export type TrivialityTest = (statement: string, header: string, signal?: AbortSignal) => Promise<{ trivial: boolean; by?: string }>;

/** The tactics of the default triviality test: the cheapest ones, tried in order in one `first` combinator. */
export const CHEAP_TACTICS = ["rfl", "decide", "omega", "simp", "norm_num"] as const;

/**
 * The default triviality test: the statement as a theorem proved by `first | rfl | decide | ...`, checked with
 * Lean. It is a filter and nothing more: the file is checked and thrown away, and no claim moves. The battery of
 * the classical line (Task 6) replaces it through `createM8({triviality})` when it merges.
 */
export function cheapTactics(checker: LeanChecker, o: { timeoutSec?: number; tactics?: readonly string[] } = {}): TrivialityTest {
  const tactics = o.tactics ?? CHEAP_TACTICS;
  return async (statement, header, signal) => {
    const reasons = statementProblem(statement);
    if (reasons !== undefined) return { trivial: false };
    const code = `${header}\n\ntheorem induction_triviality_probe ${statement} := by\n  first | ${tactics.join(" | ")}\n`;
    const [result] = await checker.check([{ id: "triviality", code }], { timeoutSec: o.timeoutSec ?? 20, ...(signal !== undefined ? { signal } : {}) });
    return result?.status === "valid" ? { trivial: true, by: tactics.join(" | ") } : { trivial: false };
  };
}
