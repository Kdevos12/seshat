import type { Json, LeanChecker, LeanCheckResult } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import { clean } from "./text.ts";

/**
 * Statement hygiene at intake (plan change CA21): tests of the statement itself, before any paid proving, each an evidence node of kind
 * `hygiene` and never a status. The vacuity test asks Lean for one object that satisfies the hypotheses (and, when none is found,
 * whether Lean can show that none exists); `plausible` looks for a counterexample with Lean's property-testing tactic where the
 * project has it; the test lemmas are the first cases of the statement tried by `decide` (the induction package's `testLemmas`, which
 * the orchestrator passes in). A statement is flagged `vacuous` only when Lean proved its hypotheses unsatisfiable.
 */
export const HYGIENE_KIND = "hygiene";

export type HygieneCheck = "vacuity" | "plausible" | "test_lemmas";

/** The data of a `hygiene` node. */
export interface HygieneData {
  check: HygieneCheck;
  /** vacuity: `satisfiable`, `vacuous`, `unknown`, `skipped`; plausible: `no_counterexample`, `counterexample`, `unavailable`, `skipped`; test lemmas: `passed`, `failed`, `skipped`, `inconclusive`. */
  result: string;
  /** A line on what was found, from Lean's answer or from this step; cleaned and short. */
  detail?: string;
  /** vacuity `satisfiable`: the values that satisfy the hypotheses. */
  witness?: string;
}

export interface Binder {
  open: string;
  names: string[];
  type: string;
}

const CLOSE: Record<string, string> = { "(": ")", "{": "}", "[": "]", "⦃": "⦄" };
const DATA_TYPES: Record<string, string> = { "ℕ": "ℕ", Nat: "ℕ", "ℤ": "ℤ", Int: "ℤ", "ℚ": "ℚ", Rat: "ℚ", "ℝ": "ℝ", Real: "ℝ" };

/** The leading binder groups of a signature-form statement (`(n : ℕ) (h : 0 < n) : P`), and the rest after the colon; undefined when it has none. */
export function parseBinders(statement: string): { binders: Binder[]; conclusion: string } | undefined {
  const text = statement.trim();
  const binders: Binder[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
    const open = text[i];
    const close = open === undefined ? undefined : CLOSE[open];
    if (open === undefined || close === undefined) break;
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      const c = text[i] as string;
      if (c === open) depth++;
      else if (c === close && --depth === 0) break;
    }
    if (depth !== 0) return undefined;
    const inner = text.slice(start + 1, i);
    i++;
    const colon = inner.indexOf(":");
    if (open === "[") {
      binders.push({ open, names: [], type: inner.trim() });
    } else {
      if (colon < 0) return undefined;
      const names = inner.slice(0, colon).trim().split(/\s+/).filter((n) => n !== "");
      if (names.length === 0 || !names.every((n) => /^[\p{L}_][\p{L}\p{N}_'₀-₉]*$/u.test(n))) return undefined;
      binders.push({ open, names, type: inner.slice(colon + 1).trim() });
    }
  }
  if (text[i] !== ":" || text[i + 1] === "=") return undefined;
  return { binders, conclusion: text.slice(i + 1).trim() };
}

const WITNESSES = [0, 1, 2, 3];
const MAX_SNIPPETS = 24;

function substitute(text: string, values: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [name, value] of values) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_'.])${name.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "gu"), value);
  return out;
}

const DISCHARGE = "first | decide | norm_num | simp | omega | nlinarith";

/** Why a statement's hypotheses cannot be tried, or the data variables and the hypotheses in a form the test can use. */
function readHypotheses(statement: string): { data: Array<{ name: string; type: string }>; hypotheses: string[] } | { skip: string } {
  const parsed = parseBinders(statement);
  if (parsed === undefined) return { skip: "the statement is not in signature form (binders, then a colon)" };
  const data: Array<{ name: string; type: string }> = [];
  const hypotheses: string[] = [];
  for (const b of parsed.binders) {
    if (b.open === "[") return { skip: "the statement has an instance binder" };
    const type = DATA_TYPES[b.type];
    if (type !== undefined) {
      for (const name of b.names) data.push({ name, type });
    } else if (/[<≤=≠∣∈>≥∧∨¬]|\bPrime\b|\bEven\b|\bOdd\b/.test(b.type) && data.length > 0) {
      hypotheses.push(b.type);
    } else {
      return { skip: `the binder (${b.names.join(" ")} : ${b.type}) is not a number or a hypothesis about numbers` };
    }
  }
  return { data, hypotheses };
}

/** The assignments of small numbers to the data variables the test tries: at most `MAX_SNIPPETS`. */
function assignments(count: number): number[][] {
  const choices = count <= 2 ? WITNESSES : count === 3 ? [1, 2] : [1];
  let all: number[][] = [[]];
  for (let k = 0; k < count; k++) all = all.flatMap((a) => choices.map((c) => [...a, c]));
  return all.slice(0, MAX_SNIPPETS);
}

/**
 * The vacuity test: Lean is asked for one object that satisfies the hypotheses (each small assignment to the number variables, the
 * hypotheses discharged by `decide`, `norm_num`, `simp`, `omega`), and, when none does, for a proof that none exists. Only that proof
 * makes the statement `vacuous`; failing to find an object is `unknown`.
 */
export async function vacuityTest(checker: LeanChecker, header: string, statement: string, o: { timeoutSec?: number; signal?: AbortSignal } = {}): Promise<HygieneData> {
  const read = readHypotheses(statement);
  if ("skip" in read) return { check: "vacuity", result: "skipped", detail: read.skip };
  if (read.hypotheses.length === 0) return { check: "vacuity", result: "satisfiable", detail: "the statement has no hypothesis to satisfy" };
  const options = { timeoutSec: o.timeoutSec ?? 60, ...(o.signal !== undefined ? { signal: o.signal } : {}) };
  const tried = assignments(read.data.length);
  const prove = read.hypotheses.length === 1 ? DISCHARGE : `refine ⟨${read.hypotheses.map(() => "?_").join(", ")}⟩ <;> ${DISCHARGE}`;
  const snippets = tried.map((values, k) => {
    const map = new Map(read.data.map((d, j) => [d.name, `(${values[j] as number} : ${d.type})`] as const));
    return { id: `w${k}`, code: `${header}\n\nexample : ${read.hypotheses.map((h) => `(${substitute(h, map)})`).join(" ∧ ")} := by\n  ${prove}\n` };
  });
  const results = await checker.check(snippets, options);
  const found = results.findIndex((r) => r.status === "valid");
  if (found >= 0) {
    const values = tried[found] as number[];
    return { check: "vacuity", result: "satisfiable", witness: read.data.map((d, j) => `${d.name} = ${values[j] as number}`).join(", ") };
  }
  const binders = read.data.map((d) => `(${d.name} : ${d.type})`).join(" ");
  const names = read.data.map((d) => d.name);
  const hyps = read.hypotheses.map((h) => `(${h})`).join(" ∧ ");
  const hs = read.hypotheses.map((_, j) => `h${j}`);
  const pattern = `⟨${[...names, hs.length === 1 ? (hs[0] as string) : `⟨${hs.join(", ")}⟩`].join(", ")}⟩`;
  const refute = `${header}\n\nexample : ¬ ∃ ${binders}, ${hyps} := by\n  rintro ${pattern}\n  ${DISCHARGE}\n`;
  const [impossible] = await checker.check([{ id: "none", code: refute }], options);
  if (impossible?.status === "valid") return { check: "vacuity", result: "vacuous", detail: "Lean proved that no values satisfy the hypotheses" };
  return { check: "vacuity", result: "unknown", detail: `no object among ${tried.length} small assignments satisfied the hypotheses, and Lean did not show that none exists` };
}

/** What `plausible` said: a counterexample (with Lean's own words), none found, or that the tactic is not there. */
export async function plausibleTest(checker: LeanChecker, header: string, statement: string, o: { timeoutSec?: number; signal?: AbortSignal } = {}): Promise<HygieneData> {
  if (parseBinders(statement) === undefined) return { check: "plausible", result: "skipped", detail: "the statement is not in signature form" };
  const [result] = await checker.check([{ id: "plausible", code: `${header}\n\nexample ${statement} := by\n  plausible\n` }], { timeoutSec: o.timeoutSec ?? 60, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
  return plausibleVerdict(result);
}

export function plausibleVerdict(result: LeanCheckResult | undefined): HygieneData {
  if (result === undefined) return { check: "plausible", result: "unavailable", detail: "Lean gave no answer" };
  const text = result.messages.map((m) => m.text).join("\n");
  const found = /Found a counter-?example!?([\s\S]*)/i.exec(text);
  if (found !== null) return { check: "plausible", result: "counterexample", detail: clean(found[1] ?? "", 300) };
  if (result.status === "server_error" || result.status === "repl_error" || result.status === "timeout") return { check: "plausible", result: "unavailable", detail: clean(result.error ?? result.status, 200) };
  if (/unknown (?:tactic|namespace|identifier)|expected token|Plausible/i.test(text) && !/Gave up|no counter/i.test(text) && result.status === "lean_error") {
    return { check: "plausible", result: "unavailable", detail: "this Lean project has no `plausible` tactic" };
  }
  return { check: "plausible", result: "no_counterexample", detail: "plausible found none in its samples; that is no proof" };
}

/** Records a hygiene result as an evidence node of the claim. It changes no status. */
export function recordHygiene(memory: MemoryStore, claimId: string, data: HygieneData): string {
  return memory.recordNode({ kind: HYGIENE_KIND, claimId, data: data as unknown as Json }).nodeId;
}
