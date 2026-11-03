import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@seshat/core";

/**
 * `bench-ext` (plan change PD6): a source that reads the equational-theories challenge's data (the SAIR Foundation's benchmark dataset
 * on Hugging Face) from a LOCAL CACHE and turns its rows into problems, to measure the battery, the fingerprints and the small-model
 * and first-order tools on implication problems, and to report the share closed without a model per step of plan section 15's order.
 *
 * - Nothing downloads, here or in the tests, and no row is copied into the repository. The cache is a directory the user fills.
 * - The dataset's licence is not stated where this was written: `licenceNote` says what to check before any row is copied anywhere.
 * - No submission to the challenge is planned; its rules are unread.
 * - The row shape below is the one assumed from the dataset's description (an implication between two equations of a magma and
 *   whether it holds); it must be checked against the real files the first time they are read.
 */
export interface ExtRow {
  id: string;
  /** The two equations of the implication, written with `◇` for the magma operation (`x = y ◇ (x ◇ z)`). */
  equation1: string;
  equation2: string;
  /** True: the first equation implies the second (a proof); false: it does not (a magma that satisfies the first and not the second). */
  answer: boolean;
}

export interface ExtProblem {
  id: string;
  source: "bench-ext";
  equation1: string;
  equation2: string;
  answer: boolean;
  /** The Lean statement in signature form, for a claim. */
  statement: string;
}

export const licenceNote =
  "The licence of the equational-theories benchmark dataset is not stated where this was written. Check it before copying any row into a repository; read the rows from a local cache, never vendor them. The Lean judge package (stage2-judge) is Apache 2.0 on Reservoir.";

const ALIASES: Record<keyof Omit<ExtRow, "answer">, string[]> = { id: ["id", "name", "problem_id"], equation1: ["equation1", "eq1", "lhs_equation"], equation2: ["equation2", "eq2", "rhs_equation"] };
const ANSWERS = ["answer", "implies", "label"];

/** A row of the dataset's shape, or an explanation of what is missing. */
export function parseRow(raw: unknown, line: number): ExtRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`row ${line}: not an object`);
  const r = raw as Record<string, unknown>;
  const pick = (names: string[]): unknown => names.map((n) => r[n]).find((v) => v !== undefined);
  const id = pick(ALIASES.id);
  const equation1 = pick(ALIASES.equation1);
  const equation2 = pick(ALIASES.equation2);
  const answer = pick(ANSWERS);
  if (typeof id !== "string" && typeof id !== "number") throw new Error(`row ${line}: no id`);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(id))) throw new Error(`row ${line}: an id is 1 to 64 letters, digits, dots, dashes and underscores`);
  if (typeof equation1 !== "string" || typeof equation2 !== "string") throw new Error(`row ${line}: the two equations are strings`);
  const verdict = typeof answer === "string" ? ({ true: true, false: false } as Record<string, boolean | undefined>)[answer.toLowerCase()] : answer;
  if (typeof verdict !== "boolean") throw new Error(`row ${line}: the answer is true or false`);
  return { id: String(id), equation1, equation2, answer: verdict };
}

/** An equation as Lean source over `Mul`, with the variables it uses in order of first appearance. */
export function equationToLean(equation: string): { body: string; variables: string[] } {
  const sides = equation.split("=");
  if (sides.length !== 2 || sides.some((s) => s.trim() === "")) throw new Error(`not an equation: ${JSON.stringify(equation)}`);
  const body = equation.replace(/◇/g, "*").replace(/\s+/g, " ").trim();
  if (/[^A-Za-z0-9_*=()\s]/.test(body)) throw new Error(`an equation of a magma uses variables, ◇, parentheses and =: ${JSON.stringify(equation)}`);
  // Each side is a term: operands joined by *, parentheses balanced and holding a term, no operator left dangling.
  for (const side of body.split("=")) checkTerm(side, equation);
  const variables = [...new Set(body.match(/\b[A-Za-z][A-Za-z0-9_]*\b/g) ?? [])];
  const reserved = variables.filter((v) => RESERVED.has(v));
  if (reserved.length > 0) throw new Error(`a variable cannot be a Lean keyword or the name of the statement's own parts (${reserved.join(", ")}): ${JSON.stringify(equation)}`);
  return { body, variables };
}

/** Words a variable may not be: Lean's keywords that could change the parse, and the names the generated statement uses. */
const RESERVED: ReadonlySet<string> = new Set(["G", "Mul", "Type", "Prop", "sorry", "fun", "by", "let", "have", "show", "from", "at", "do", "if", "then", "else", "match", "with", "in", "where", "end", "theorem", "lemma", "def", "instance", "example", "open", "import", "namespace", "section", "variable", "axiom", "forall", "exists", "this", "id"]);

/** A term of a magma: operands (a variable or a parenthesised term) joined by `*`. */
function checkTerm(term: string, whole: string): void {
  const tokens = term.match(/[A-Za-z][A-Za-z0-9_]*|[*()]|\S/g) ?? [];
  let at = 0;
  const operand = (): void => {
    const t = tokens[at];
    if (t === "(") {
      at += 1;
      expression();
      if (tokens[at] !== ")") throw new Error(`unbalanced parentheses: ${JSON.stringify(whole)}`);
      at += 1;
    } else if (t !== undefined && /^[A-Za-z]/.test(t)) {
      at += 1;
    } else {
      throw new Error(`not a term of a magma: ${JSON.stringify(whole)}`);
    }
  };
  const expression = (): void => {
    operand();
    while (tokens[at] === "*") {
      at += 1;
      operand();
    }
  };
  expression();
  if (at !== tokens.length) throw new Error(`not a term of a magma (parentheses unbalanced or a stray token): ${JSON.stringify(whole)}`);
}

const forall = (e: { body: string; variables: string[] }): string => (e.variables.length === 0 ? e.body : `∀ ${e.variables.join(" ")} : G, ${e.body}`);

/** The problem a row states, as a Lean statement in signature form. */
export function toProblem(row: ExtRow): ExtProblem {
  const e1 = equationToLean(row.equation1);
  const e2 = equationToLean(row.equation2);
  const statement = row.answer
    ? `: ∀ (G : Type) [Mul G], (${forall(e1)}) → ${forall(e2)}`
    : `: ∃ (G : Type) (_ : Mul G), (${forall(e1)}) ∧ ¬ (${forall(e2)})`;
  return { id: `bench-ext#${row.id}`, source: "bench-ext", equation1: row.equation1, equation2: row.equation2, answer: row.answer, statement };
}

/** Converts rows (JSON objects, one per line, or a JSON array). */
export function convertRows(text: string): ExtProblem[] {
  const trimmed = text.trim();
  const raws: unknown[] = trimmed.startsWith("[") ? (JSON.parse(trimmed) as unknown[]) : trimmed.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
  return raws.map((r, i) => toProblem(parseRow(r, i + 1)));
}

/** Reads the rows of a local cache directory (`*.jsonl` and `*.json` files, sorted). Nothing is fetched: a missing cache is an error that says so. */
export function readCache(dir: string): ExtProblem[] {
  if (!existsSync(dir)) throw new Error(`no cache at ${dir}: bench-ext reads a local copy of the dataset and never downloads it`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`${dir} holds no .jsonl or .json file of rows`);
  return files.flatMap((f) => convertRows(readFileSync(join(dir, f), "utf8")));
}

/** The steps of plan section 15's order that a program closes, then the model. */
export const STEPS = ["subsumption", "fingerprint", "battery", "atp_smt", "model", "unsolved"] as const;
export type Step = (typeof STEPS)[number];

export interface StepReport {
  problems: number;
  byStep: Record<Step, number>;
  /** The share closed without a model: every step but `model` and `unsolved`. */
  withoutModel: number;
  perProblem: Array<{ problemId: string; step: Step }>;
}

/**
 * Per problem, the first step of the order that closed it, read from the journal of a run over bench-ext problems: the actor of the
 * claim's first valid Lean check, and for the battery's actor whether a first-order tool or a tactic settled it.
 */
export function closedByStep(events: readonly HarnessEvent[]): StepReport {
  const claimOf = new Map<string, string>();
  const firstValid = new Map<string, string>();
  // The first valid fast check of the claim itself: a proof of the negation, or a certification, is not the step that closed the problem.
  const firstOrder = new Set<string>();
  const nodes = new Map<string, { kind: string; claimId?: string; data: unknown }>();
  for (const e of events) {
    if (e.type === "problem.registered") claimOf.set(e.data.problemId, e.data.claimId);
    else if (e.type === "validation.finished" && e.data.verdict === "valid" && e.data.method === "repl" && e.data.negation !== true && !firstValid.has(e.data.claimId)) firstValid.set(e.data.claimId, e.actor);
    else if (e.type === "node.recorded") nodes.set(e.data.nodeId, { kind: e.data.kind, ...(e.data.claimId !== undefined ? { claimId: e.data.claimId } : {}), data: e.data.data });
  }
  for (const n of nodes.values()) {
    if (n.kind !== "first_order_run" || n.claimId === undefined) continue;
    const d = n.data as { solved?: unknown } | null;
    if (d !== null && typeof d === "object" && d.solved !== undefined && d.solved !== false && d.solved !== null) firstOrder.add(n.claimId);
  }
  const byStep = Object.fromEntries(STEPS.map((s) => [s, 0])) as Record<Step, number>;
  const perProblem: StepReport["perProblem"] = [];
  for (const [problemId, claimId] of claimOf) {
    const actor = firstValid.get(claimId);
    let step: Step;
    if (actor === undefined) step = "unsolved";
    else if (actor === "line:M12") step = "subsumption";
    else if (actor === "line:M11") step = "fingerprint";
    else if (actor === "line:M10") step = firstOrder.has(claimId) ? "atp_smt" : "battery";
    else step = "model";
    byStep[step] += 1;
    perProblem.push({ problemId, step });
  }
  const problems = perProblem.length;
  const closed = problems - byStep.model - byStep.unsolved;
  return { problems, byStep, withoutModel: problems === 0 ? 0 : closed / problems, perProblem };
}
