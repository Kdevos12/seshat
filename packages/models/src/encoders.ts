import { type Json, sha256Hex } from "@seshat/core";
import { completeJson, isInterrupted, type Llm, type ProblemContext, withAntiSycophancy } from "@seshat/lines";
import type { JsonSchema } from "@seshat/registry";
import { makeBattery } from "./battery.ts";
import { confirmHit, type GraphFilter } from "./graph-hunt.ts";
import type { GraphStatement } from "./graph-statement.ts";
import { graphObject } from "./graphs.ts";
import type { Law, Term } from "./laws.ts";
import { type MagmaObject, magmaObject } from "./objects.ts";
import { describeCounterModel, recordCounterModel, submitRefutation } from "./refutation.ts";
import { Cnf, CnfTooLarge, type Lit, MAX_ENCODER_LENGTH, type SatAnswer, type SatCompute, solveCnf, solveModelEncoder } from "./sat.ts";
import { compileMagmaStatement, type MagmaStatement, splitSignature } from "./statement.ts";

/**
 * The SAT encoders of line M11 (plan change CX6): for a statement the line reads, a CNF whose models are its counterexamples of
 * one order, with lex-leader symmetry breaking, solved by python-sat in the host's compute tool (`sat.ts`). A model is decoded
 * into a magma or a graph, written into the line's Lean templates from its numbers (never from text a model wrote) and checked
 * by Lean's `decide` through `validate`, as every counter-model of M11 is. UNSAT is evidence, a `sat_search` node: "no
 * counterexample of order up to n", never a status. documentation/models.md, "SAT encoders".
 */

// --- Symmetry breaking ---------------------------------------------------------------------------

/**
 * Lex-leader constraints for the transpositions of neighbours (i, i+1): the object's cells, in a fixed order, are lexicographically
 * at most those of its image. Each isomorphism class keeps its lex-least member, so the constraints remove no class.
 */
function lexLeader(cnf: Cnf, n: number, cells: number, cell: (perm: (x: number) => number, j: number) => Lit[]): void {
  for (let i = 0; i + 1 < n; i++) {
    const swap = (x: number): number => (x === i ? i + 1 : x === i + 1 ? i : x);
    const same = (x: number): number => x;
    cnf.lexLeq(
      Array.from({ length: cells }, (_, j) => cell(same, j)),
      Array.from({ length: cells }, (_, j) => cell(swap, j)),
    );
  }
}

// --- Magmas --------------------------------------------------------------------------------------

/** A CNF for one order, the last variable that describes the object, and how a model becomes the object. */
export interface Encoding<T> {
  cnf: Cnf;
  show: number;
  decode(trueVariables: readonly number[]): T | undefined;
}

/**
 * The counter-models of a statement of magmas of order `n`: a table (variable `a·n² + b·n + c + 1` says `a * b = c`) on which every
 * hypothesis holds for every value of its variables and the conclusion fails for one. Each subterm whose value is not a table
 * entry gets one-hot auxiliary variables.
 */
export function encodeMagma(statement: MagmaStatement, n: number, maxClauses = Number.POSITIVE_INFINITY): Encoding<MagmaObject> {
  const cnf = new Cnf(maxClauses);
  const x = (a: number, b: number, c: number): Lit => a * n * n + b * n + c + 1;
  cnf.variables = n * n * n;
  const values = Array.from({ length: n }, (_, c) => c);
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) cnf.exactlyOne(values.map((c) => x(a, b, c)));
  type Value = { constant: number } | { lits: Lit[] };
  const memo = new Map<string, Lit[]>();
  const print = (t: Term): string => (t.kind === "var" ? t.name : `(${print(t.left)}*${print(t.right)})`);
  const valueOf = (t: Term, at: ReadonlyMap<string, number>): Value => {
    if (t.kind === "var") return { constant: at.get(t.name) as number };
    const l = valueOf(t.left, at);
    const r = valueOf(t.right, at);
    if ("constant" in l && "constant" in r) return { lits: values.map((c) => x(l.constant, r.constant, c)) };
    const key = `${print(t)}|${[...at.entries()].map(([k, v]) => `${k}=${v}`).join(",")}`;
    const known = memo.get(key);
    if (known !== undefined) return { lits: known };
    const y = values.map(() => cnf.fresh());
    const options = (v: Value): Array<[number, Lit | undefined]> => ("constant" in v ? [[v.constant, undefined]] : v.lits.map((lit, a) => [a, lit] as [number, Lit]));
    for (const [a, la] of options(l)) {
      for (const [b, lb] of options(r)) {
        for (const c of values) cnf.add([...(la !== undefined ? [-la] : []), ...(lb !== undefined ? [-lb] : []), -x(a, b, c), y[c] as Lit]);
      }
    }
    cnf.atMostOne(y);
    memo.set(key, y);
    return { lits: y };
  };
  /** The literal of "the value is c", or a constant. */
  const is = (v: Value, c: number): Lit | boolean => ("constant" in v ? v.constant === c : (v.lits[c] as Lit));
  const assignments = function* (law: Law): Generator<Map<string, number>> {
    const k = law.variables.length;
    for (let code = 0; code < n ** k; code++) {
      const at = new Map<string, number>();
      let rest = code;
      for (const name of law.variables) {
        at.set(name, rest % n);
        rest = Math.floor(rest / n);
      }
      yield at;
    }
  };
  const clause = (parts: Array<Lit | boolean>): void => {
    if (parts.some((p) => p === true)) return;
    cnf.add(parts.filter((p): p is Lit => typeof p === "number"));
  };
  const not = (p: Lit | boolean): Lit | boolean => (typeof p === "boolean" ? !p : -p);
  for (const { law } of statement.hypotheses) {
    for (const at of assignments(law)) {
      const l = valueOf(law.left, at);
      const r = valueOf(law.right, at);
      for (const c of values) clause([not(is(l, c)), is(r, c)]);
    }
  }
  const selectors: Lit[] = [];
  for (const at of assignments(statement.conclusion.law)) {
    const l = valueOf(statement.conclusion.law.left, at);
    const r = valueOf(statement.conclusion.law.right, at);
    const s = cnf.fresh();
    selectors.push(s);
    for (const c of values) clause([-s, not(is(l, c)), not(is(r, c))]);
  }
  cnf.add(selectors);
  const cells = n * n;
  lexLeader(cnf, n, cells, (perm, j) => {
    const a = Math.floor(j / n);
    const b = j % n;
    return values.map((c) => x(perm(a), perm(b), perm(c)));
  });
  return {
    cnf,
    show: n * n * n,
    decode: (trueVariables) => {
      const table = new Array<number>(cells).fill(-1);
      for (const v of trueVariables) {
        const i = v - 1;
        const cell = Math.floor(i / n);
        if (table[cell] !== -1) return undefined;
        table[cell] = i % n;
      }
      return table.includes(-1) ? undefined : magmaObject(n, table);
    },
  };
}

// --- Graphs --------------------------------------------------------------------------------------

/** The number a graph statement compares: its edges, its vertices, its least or greatest degree. */
type Measure = "edges" | "order" | "minDegree" | "maxDegree";
type Op = "≤" | "<" | "=" | "≥" | ">" | "≠";

/** The fragment of graph statements the template encoder reads. */
export type GraphFormula =
  | { kind: "not"; f: GraphFormula }
  | { kind: "and" | "or"; fs: GraphFormula[] }
  | { kind: "cliqueFree"; complement: boolean; k: number }
  | { kind: "compare"; measure: Measure; op: Op; value: number }
  | { kind: "degrees"; op: Op; value: number };

const FLIP: Readonly<Record<Op, Op>> = { "≤": "≥", "<": ">", "=": "=", "≥": "≤", ">": "<", "≠": "≠" };
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reads one formula of the fragment, or says why not. */
function parseFormula(text: string, statement: GraphStatement): GraphFormula | string {
  const g = escape(statement.graph);
  const V = escape(statement.vertexType);
  const tokens = text.match(/[()¬∧∨→]|[^()¬∧∨→]+/gu)?.map((t) => t.trim()).filter((t) => t !== "") ?? [];
  let at = 0;
  const measure = (side: string): Measure | undefined => {
    const s = side.replace(/\s+/g, " ").trim();
    if (new RegExp(`^(?:${g}\\.edgeFinset\\.card|#${g}\\.edgeFinset)$`, "u").test(s)) return "edges";
    if (new RegExp(`^Fintype\\.card ${V}$`, "u").test(s)) return "order";
    if (new RegExp(`^${g}\\.minDegree$`, "u").test(s)) return "minDegree";
    if (new RegExp(`^${g}\\.maxDegree$`, "u").test(s)) return "maxDegree";
    return undefined;
  };
  const comparison = (s: string, side: (t: string) => boolean): { op: Op; value: number; term: string } | undefined => {
    const m = /^(.+?)\s*(≤|<|=|≥|>|≠)\s*(.+)$/u.exec(s);
    if (m === null) return undefined;
    const [, left, op, right] = m as unknown as [string, string, Op, string];
    if (/^\d+$/u.test(right.trim()) && side(left)) return { op, value: Number(right.trim()), term: left.trim() };
    if (/^\d+$/u.test(left.trim()) && side(right)) return { op: FLIP[op], value: Number(left.trim()), term: right.trim() };
    return undefined;
  };
  const atom = (s: string): GraphFormula | string => {
    const clique = new RegExp(`^(${g}|${g}ᶜ)\\.CliqueFree (\\d+)$`, "u").exec(s);
    if (clique !== null) return { kind: "cliqueFree", complement: (clique[1] as string).endsWith("ᶜ"), k: Number(clique[2]) };
    const all = new RegExp(`^∀ ([\\p{L}_][\\p{L}\\p{N}_']*)(?: : ${V})?,\\s*(.+)$`, "u").exec(s);
    if (all !== null) {
      const v = escape(all[1] as string);
      const c = comparison(all[2] as string, (t) => new RegExp(`^${g}\\.degree ${v}$`, "u").test(t.trim()));
      return c === undefined ? `not a bound on every degree: ${s}` : { kind: "degrees", op: c.op, value: c.value };
    }
    const c = comparison(s, (t) => measure(t) !== undefined);
    if (c !== undefined) return { kind: "compare", measure: measure(c.term) as Measure, op: c.op, value: c.value };
    return `outside the fragment: ${s.slice(0, 80)}`;
  };
  const expr = (): GraphFormula | string => {
    const left = disjunction();
    if (typeof left === "string") return left;
    if (tokens[at] !== "→") return left;
    at++;
    const right = expr();
    return typeof right === "string" ? right : { kind: "or", fs: [{ kind: "not", f: left }, right] };
  };
  const disjunction = (): GraphFormula | string => {
    const fs: GraphFormula[] = [];
    for (;;) {
      const f = conjunction();
      if (typeof f === "string") return f;
      fs.push(f);
      if (tokens[at] !== "∨") return fs.length === 1 ? (fs[0] as GraphFormula) : { kind: "or", fs };
      at++;
    }
  };
  const conjunction = (): GraphFormula | string => {
    const fs: GraphFormula[] = [];
    for (;;) {
      const f = unary();
      if (typeof f === "string") return f;
      fs.push(f);
      if (tokens[at] !== "∧") return fs.length === 1 ? (fs[0] as GraphFormula) : { kind: "and", fs };
      at++;
    }
  };
  const unary = (): GraphFormula | string => {
    const t = tokens[at];
    if (t === undefined) return "the formula ends early";
    if (t === "¬") {
      at++;
      const f = unary();
      return typeof f === "string" ? f : { kind: "not", f };
    }
    if (t === "(") {
      at++;
      const f = expr();
      if (typeof f === "string") return f;
      if (tokens[at] !== ")") return "a parenthesis is not closed";
      at++;
      return f;
    }
    if (t === ")" || t === "∧" || t === "∨" || t === "→") return `unexpected ${t}`;
    at++;
    return atom(t);
  };
  const f = expr();
  if (typeof f === "string") return f;
  return at === tokens.length ? f : `unexpected ${tokens[at]}`;
}

/**
 * The statement as a formula of the template's fragment: its hypotheses imply its conclusion, each built from `G.CliqueFree k`,
 * `Gᶜ.CliqueFree k`, comparisons of `G.edgeFinset.card` (or `#G.edgeFinset`), `Fintype.card V`, `G.minDegree`, `G.maxDegree` with
 * a numeral, and `∀ v, G.degree v ≤ d` (any comparison), joined by `¬`, `∧`, `∨`, `→` and parentheses. Anything else: the reason.
 */
export function graphFormula(statement: GraphStatement): { formula: GraphFormula } | { reason: string } {
  const split = splitSignature(statement.text);
  if ("reason" in split) return { reason: split.reason };
  const hypotheses: GraphFormula[] = [];
  let afterGraph = false;
  for (const binder of split.binders) {
    if (binder.type === `SimpleGraph ${statement.vertexType}`) {
      afterGraph = true;
      continue;
    }
    if (!afterGraph || binder.bracket === "[") continue;
    const f = parseFormula(binder.type, statement);
    if (typeof f === "string") return { reason: `the hypothesis ${binder.names.join(" ")}: ${f}` };
    for (let i = 0; i < binder.names.length; i++) hypotheses.push(f);
  }
  const conclusion = parseFormula(split.conclusion, statement);
  if (typeof conclusion === "string") return { reason: `the conclusion: ${conclusion}` };
  return { formula: { kind: "or", fs: [...hypotheses.map((h): GraphFormula => ({ kind: "not", f: h })), conclusion] } };
}

/** A formula over literals and constants, which `assert` writes as clauses. */
type Low = { kind: "const"; value: boolean } | { kind: "lit"; lit: Lit } | { kind: "not"; f: Low } | { kind: "and" | "or"; fs: Low[] };

const constant = (value: boolean): Low => ({ kind: "const", value });

/** A literal (or constant) equivalent to `f`. */
function define(cnf: Cnf, f: Low): Lit | boolean {
  if (f.kind === "const") return f.value;
  if (f.kind === "lit") return f.lit;
  if (f.kind === "not") {
    const d = define(cnf, f.f);
    return typeof d === "boolean" ? !d : -d;
  }
  const absorbing = f.kind === "or";
  const lits: Lit[] = [];
  for (const child of f.fs) {
    const d = define(cnf, child);
    if (d === absorbing) return absorbing;
    if (typeof d === "number") lits.push(d);
  }
  if (lits.length === 0) return !absorbing;
  if (lits.length === 1) return lits[0] as Lit;
  return f.kind === "and" ? cnf.and(lits) : cnf.or(lits);
}

/** Adds the clauses that make `f` take `value`: a conjunction asserted true (a disjunction false) is asserted part by part. */
function assert(cnf: Cnf, f: Low, value: boolean): void {
  if (f.kind === "not") return assert(cnf, f.f, !value);
  if ((f.kind === "and" && value) || (f.kind === "or" && !value)) {
    for (const child of f.fs) assert(cnf, child, value);
    return;
  }
  if (f.kind === "and" || f.kind === "or") {
    const lits: Lit[] = [];
    for (const child of f.fs) {
      const d = define(cnf, child);
      const wanted = value ? d : typeof d === "boolean" ? !d : -d;
      if (wanted === true) return;
      if (typeof wanted === "number") lits.push(wanted);
    }
    cnf.add(lits);
    return;
  }
  const d = define(cnf, f);
  if (typeof d === "boolean") {
    if (d !== value) cnf.add([]);
  } else cnf.add([value ? d : -d]);
}

function subsets(n: number, k: number): number[][] {
  const out: number[][] = [];
  const go = (start: number, chosen: number[]): void => {
    if (chosen.length === k) {
      out.push([...chosen]);
      return;
    }
    for (let v = start; v < n; v++) go(v + 1, [...chosen, v]);
  };
  if (k >= 0 && k <= n) go(0, []);
  return out;
}

/** The pairs u < v of n vertices in the variables' order: (0,1), (0,2), ..., (1,2), ... */
export function vertexPairs(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let u = 0; u < n; u++) for (let v = u + 1; v < n; v++) out.push([u, v]);
  return out;
}

/**
 * The counterexamples of order `n` to a statement of the fragment (`graphFormula`): variable `k` (from 1) is the k-th pair of
 * `vertexPairs(n)`, true when it is an edge. The negation of the statement is asserted: a model is a graph on which the hypotheses
 * hold and the conclusion fails.
 */
export function encodeGraph(formula: GraphFormula, n: number, maxClauses = Number.POSITIVE_INFINITY): Encoding<{ n: number; edges: Array<[number, number]> }> {
  const cnf = new Cnf(maxClauses);
  const pairs = vertexPairs(n);
  cnf.variables = pairs.length;
  const index = new Map(pairs.map(([u, v], i) => [`${u},${v}`, i + 1]));
  const edge = (u: number, v: number): Lit => index.get(u < v ? `${u},${v}` : `${v},${u}`) as Lit;
  const at = (lits: Lit[], t: number): Low => {
    const d = cnf.atLeast(lits, t);
    return typeof d === "boolean" ? constant(d) : { kind: "lit", lit: d };
  };
  /** `count(lits) op value` as a formula. */
  const bound = (lits: Lit[], op: Op, value: number): Low => {
    const ge = (t: number): Low => at(lits, t);
    const le = (t: number): Low => ({ kind: "not", f: at(lits, t + 1) });
    switch (op) {
      case "≤":
        return le(value);
      case "<":
        return le(value - 1);
      case "≥":
        return ge(value);
      case ">":
        return ge(value + 1);
      case "=":
        return { kind: "and", fs: [ge(value), le(value)] };
      case "≠":
        return { kind: "or", fs: [le(value - 1), ge(value + 1)] };
    }
  };
  const compare = (a: number, op: Op, b: number): boolean => ({ "≤": a <= b, "<": a < b, "=": a === b, "≥": a >= b, ">": a > b, "≠": a !== b })[op];
  const degreeLits = (v: number): Lit[] => Array.from({ length: n }, (_, w) => w).filter((w) => w !== v).map((w) => edge(v, w));
  const vertices = Array.from({ length: n }, (_, v) => v);
  /** `minDegree op value` (or max): for n ≥ 1, the least degree is at least t when every degree is, at most t when one is. */
  const extreme = (which: "minDegree" | "maxDegree", op: Op, value: number): Low => {
    const every = (t: (v: number) => Low): Low => ({ kind: "and", fs: vertices.map(t) });
    const some = (t: (v: number) => Low): Low => ({ kind: "or", fs: vertices.map(t) });
    const atLeast = (t: number): Low => (which === "minDegree" ? every((v) => at(degreeLits(v), t)) : some((v) => at(degreeLits(v), t)));
    const atMost = (t: number): Low => (which === "minDegree" ? some((v) => ({ kind: "not", f: at(degreeLits(v), t + 1) })) : every((v) => ({ kind: "not", f: at(degreeLits(v), t + 1) })));
    switch (op) {
      case "≤":
        return atMost(value);
      case "<":
        return atMost(value - 1);
      case "≥":
        return atLeast(value);
      case ">":
        return atLeast(value + 1);
      case "=":
        return { kind: "and", fs: [atLeast(value), atMost(value)] };
      case "≠":
        return { kind: "or", fs: [atMost(value - 1), atLeast(value + 1)] };
    }
  };
  const lower = (f: GraphFormula): Low => {
    switch (f.kind) {
      case "not":
        return { kind: "not", f: lower(f.f) };
      case "and":
      case "or":
        return { kind: f.kind, fs: f.fs.map(lower) };
      case "cliqueFree":
        // No k-set whose pairs are all edges (all non-edges for the complement).
        return { kind: "and", fs: subsets(n, f.k).map((s): Low => ({ kind: "or", fs: subsets(s.length, 2).map(([i, j]): Low => { const l = edge(s[i as number] as number, s[j as number] as number); return { kind: "lit", lit: f.complement ? l : -l }; }) })) };
      case "degrees":
        return { kind: "and", fs: vertices.map((v) => bound(degreeLits(v), f.op, f.value)) };
      case "compare":
        if (f.measure === "order") return constant(compare(n, f.op, f.value));
        if (f.measure === "edges") return bound(pairs.map((_, i) => i + 1), f.op, f.value);
        return extreme(f.measure, f.op, f.value);
    }
  };
  assert(cnf, lower(formula), false);
  lexLeader(cnf, n, pairs.length, (perm, j) => {
    const [u, v] = pairs[j] as [number, number];
    const l = edge(perm(u), perm(v));
    return [-l, l];
  });
  return {
    cnf,
    show: pairs.length,
    decode: (trueVariables) => ({ n, edges: trueVariables.map((v) => pairs[v - 1] as [number, number]) }),
  };
}

// --- The line's steps -----------------------------------------------------------------------------

export const SAT_SEARCH_KIND = "sat_search";

/** The bounds of the SAT step, from M11's options. */
export interface SatSettings {
  magmaOrder: number;
  graphOrder: number;
  timeoutSec: number;
  maxClauses: number;
}

/** What one order came to. */
export interface SatOrderRecord {
  order: number;
  status: SatAnswer["status"] | "too_large" | "rejected";
  variables?: number;
  clauses?: number;
  solver?: string;
  note?: string;
}

/** The data of a `sat_search` node: one SAT search of a claim, its encoder, every order tried and the outcome. */
export interface SatSearchData {
  family: "magma" | "graph";
  encoder: "template" | "model";
  statementHash: string;
  /** The orders asked: from, to. */
  orders: [number, number];
  tried: SatOrderRecord[];
  /** `found`: a model was decoded and sent to Lean (`confirmed` says whether Lean accepted it). `unsat`: no model at any order asked, the evidence. */
  outcome: "found" | "unsat" | "unknown" | "not_run";
  confirmed?: boolean;
  capability?: string;
  /** For a model's encoder: its hash (the code is in the journal's model call). */
  encoderHash?: string;
  note?: string;
  summary: string;
}

function priorSearch(problem: ProblemContext, statementHash: string, encoder: SatSearchData["encoder"]): SatSearchData | undefined {
  return problem.memory
    .nodes(SAT_SEARCH_KIND, { claimId: problem.claimId })
    .map((n) => n.data as unknown as SatSearchData)
    .find((d) => d.statementHash === statementHash && d.encoder === encoder);
}

function recordSearch(problem: ProblemContext, data: Omit<SatSearchData, "summary">): SatSearchData {
  const [from, to] = data.orders;
  const what = data.family === "magma" ? "magma" : "graph";
  const summary =
    data.outcome === "unsat"
      ? `SAT (${data.encoder} encoder): no counterexample ${what} of order ${from === to ? from : `${from} to ${to}`}. Computed evidence, not a proof.`
      : data.outcome === "found"
        ? `SAT (${data.encoder} encoder): a counterexample ${what} of order ${data.tried.at(-1)?.order}, ${data.confirmed === true ? "and a Lean proof of the negation passed the fast check" : "which Lean did not confirm"}.`
        : `SAT (${data.encoder} encoder): ${data.outcome}${(data.note ?? data.tried.at(-1)?.note) !== undefined ? ` (${data.note ?? data.tried.at(-1)?.note})` : ""}. Nothing about the statement follows.`;
  const full = { ...data, summary } as SatSearchData;
  problem.memory.recordNode({ kind: SAT_SEARCH_KIND, claimId: problem.claimId, data: full as unknown as Json });
  problem.log(`M11: ${summary}`);
  return full;
}

/** Tries the orders from 1 up: the first model ends the loop. */
async function eachOrder<T>(
  to: number,
  build: (n: number) => Encoding<T> | undefined,
  solve: (encoding: Encoding<T>, n: number) => Promise<SatAnswer>,
  tried: SatOrderRecord[],
): Promise<{ object: T; order: number } | undefined> {
  for (let n = 1; n <= to; n++) {
    let encoding: Encoding<T> | undefined;
    try {
      encoding = build(n);
    } catch (error) {
      if (!(error instanceof CnfTooLarge)) throw error;
      tried.push({ order: n, status: "too_large", note: error.message });
      return undefined;
    }
    if (encoding === undefined) continue;
    const answer = encoding.cnf.contradiction ? { status: "unsat" as const, solver: "none (false as written)" } : await solve(encoding, n);
    const record: SatOrderRecord = { order: n, status: answer.status, variables: encoding.cnf.variables, clauses: encoding.cnf.clauses.length, ...(answer.solver !== undefined ? { solver: answer.solver } : {}), ...(answer.note !== undefined ? { note: answer.note } : {}) };
    tried.push(record);
    if (answer.status === "unknown") return undefined;
    if (answer.status === "sat") {
      const object = encoding.decode(answer.trueVariables ?? []);
      if (object === undefined) {
        record.status = "rejected";
        record.note = "the solver's model does not decode to an object";
        return undefined;
      }
      return { object, order: n };
    }
  }
  return undefined;
}

const outcomeOf = (tried: SatOrderRecord[], found: boolean): SatSearchData["outcome"] => (found ? "found" : tried.length > 0 && tried.every((t) => t.status === "unsat") ? "unsat" : tried.length === 0 ? "not_run" : "unknown");

/**
 * A statement of magmas that the battery did not refute: the template encoder from order 1 to `magmaOrder`. A model is a magma that
 * the law evaluator must also see failing; it is recorded as a counter-model and its negation goes through `validate`, as the
 * battery's do. Once per statement (a `sat_search` node).
 */
export async function satMagma(problem: ProblemContext, statement: MagmaStatement, settings: SatSettings, compute: SatCompute | undefined): Promise<void> {
  const statementHash = sha256Hex(problem.target.statement);
  if (priorSearch(problem, statementHash, "template") !== undefined) return;
  const base = { family: "magma" as const, encoder: "template" as const, statementHash, orders: [1, settings.magmaOrder] as [number, number] };
  if (compute === undefined) {
    recordSearch(problem, { ...base, tried: [], outcome: "not_run", note: "the host offers no compute tool" });
    return;
  }
  const tried: SatOrderRecord[] = [];
  const found = await eachOrder(
    settings.magmaOrder,
    (n) => encodeMagma(statement, n, settings.maxClauses),
    (e) => solveCnf(compute, e.cnf, { show: e.show, timeoutSec: settings.timeoutSec, signal: problem.signal }),
    tried,
  );
  if (found === undefined) {
    recordSearch(problem, { ...base, tried, outcome: outcomeOf(tried, false), capability: compute.capability });
    return;
  }
  const verdict = compileMagmaStatement(statement)(found.object);
  if (verdict.verdict !== "fails") {
    (tried.at(-1) as SatOrderRecord).status = "rejected";
    (tried.at(-1) as SatOrderRecord).note = `the law evaluator says the magma ${verdict.verdict === "holds" ? "satisfies" : "fails a hypothesis of"} the statement`;
    recordSearch(problem, { ...base, tried, outcome: "unknown", capability: compute.capability });
    return;
  }
  const battery = makeBattery({ id: `magmas:sat:${found.order}`, family: "magmas", objects: [found.object], generator: { name: "sat", params: { order: found.order, encoder: "template" } } });
  const { node } = recordCounterModel(problem.memory, { claimId: problem.claimId, battery, index: 0, object: found.object, evaluator: "law", ...(verdict.witness !== undefined ? { witness: verdict.witness } : {}) });
  problem.log(`M11: SAT found that the statement fails on ${describeCounterModel(found.object)}`);
  problem.memory.recordObstruction({ claimId: problem.claimId, reason: "counterexample", detail: `the statement fails on ${describeCounterModel(found.object)}` });
  const attempts = await submitRefutation(problem.validate, { claimId: problem.claimId, statement, object: found.object });
  problem.memory.updateNode(node.nodeId, { refutation: attempts }, "the negation was submitted through validate");
  recordSearch(problem, { ...base, tried, outcome: "found", confirmed: attempts.some((a) => a.verdict === "valid"), capability: compute.capability });
}

const SAT_FILTER = (n: number): GraphFilter => ({ connected: false, minVertices: n, maxVertices: n, minEdges: 0, maxEdges: null });

/**
 * A statement about graphs in the template's fragment: the encoder from order 1 to `graphOrder`. A model is a graph handed to M11's
 * Lean check (`confirmHit`, source `sat`). Returns `outside` when the statement is not in the fragment, `refuted` when Lean
 * accepted a negation, and `done` otherwise. Once per statement.
 */
export async function satGraphTemplate(problem: ProblemContext, statement: GraphStatement, settings: SatSettings, compute: SatCompute | undefined): Promise<"outside" | "refuted" | "done"> {
  const recognized = graphFormula(statement);
  if ("reason" in recognized) {
    problem.log(`M11: the graph statement is outside the SAT template: ${recognized.reason}`);
    return "outside";
  }
  const statementHash = sha256Hex(statement.text);
  const prior = priorSearch(problem, statementHash, "template");
  if (prior !== undefined) return prior.confirmed === true ? "refuted" : "done";
  const base = { family: "graph" as const, encoder: "template" as const, statementHash, orders: [1, settings.graphOrder] as [number, number] };
  if (compute === undefined) {
    recordSearch(problem, { ...base, tried: [], outcome: "not_run", note: "the host offers no compute tool" });
    return "done";
  }
  const tried: SatOrderRecord[] = [];
  const found = await eachOrder(
    settings.graphOrder,
    (n) => encodeGraph(recognized.formula, n, settings.maxClauses),
    (e) => solveCnf(compute, e.cnf, { show: e.show, timeoutSec: settings.timeoutSec, signal: problem.signal }),
    tried,
  );
  if (found === undefined) {
    recordSearch(problem, { ...base, tried, outcome: outcomeOf(tried, false), capability: compute.capability });
    return "done";
  }
  const graph = graphObject(found.order, found.object.edges);
  const confirmed = await confirmHit(problem, statement, { graph, source: "sat", filter: SAT_FILTER(found.order), program: `sat template encoder of ${statementHash}`, detail: `order ${found.order}, template encoder` });
  recordSearch(problem, { ...base, tried, outcome: "found", confirmed, capability: compute.capability });
  return confirmed ? "refuted" : "done";
}

const ENCODER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    encoder: { type: "string", minLength: 1, maxLength: MAX_ENCODER_LENGTH, description: "Python that defines encode(n), returning a list of clauses, each a list of nonzero integers." },
  },
  required: ["encoder"],
  additionalProperties: false,
};

function encoderPrompt(statement: GraphStatement): string {
  return (
    `A Lean statement about simple graphs:\n${statement.text}\n\n` +
    "Write Python that defines `encode(n)`, returning a CNF (a list of clauses, each a list of nonzero integers as in DIMACS) whose models are exactly the counterexamples " +
    "to the statement on n vertices: graphs where its hypotheses hold and its conclusion fails. Variable k, for 1 ≤ k ≤ n(n-1)/2, is true when the k-th pair is an edge, " +
    "the pairs in the order (0,1), (0,2), ..., (0,n-1), (1,2), ..., (n-2,n-1); variables above n(n-1)/2 are yours, as auxiliaries. Plain Python, no import is needed. " +
    "A model the solver finds is checked by Lean; a wrong encoder costs a try."
  );
}

/**
 * A statement about graphs outside the template's fragment: one model request (site `encode.sat`, counted against M11's cap of
 * model requests for graphs) for an encoder, run in the compute tool for each order from 1 to `graphOrder` until a model comes
 * back; the graph goes to Lean through `confirmHit`. A wrong encoder costs this try and changes nothing. Once per statement.
 */
export async function satGraphModel(problem: ProblemContext, statement: GraphStatement, settings: SatSettings, compute: SatCompute | undefined, counted: { llm: Llm; left: () => number }): Promise<void> {
  const statementHash = sha256Hex(statement.text);
  if (priorSearch(problem, statementHash, "model") !== undefined) return;
  if (compute === undefined || counted.left() <= 0 || problem.budget.exhausted || problem.signal.aborted) return;
  const base = { family: "graph" as const, encoder: "model" as const, statementHash, orders: [1, settings.graphOrder] as [number, number] };
  let encoder: string;
  try {
    const answer = await completeJson<{ encoder: string }>(counted.llm, {
      system: withAntiSycophancy("You write SAT encoders in Python for counterexamples to conjectures about graphs. Your answer is read by a program."),
      prompt: encoderPrompt(statement),
      schema: ENCODER_SCHEMA as never,
      site: "encode.sat",
      reuse: true,
    });
    encoder = answer.value.encoder;
  } catch (error) {
    if (isInterrupted(error) || problem.signal.aborted) throw error;
    problem.log(`M11: no SAT encoder from the model: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return;
  }
  const encoderHash = sha256Hex(encoder);
  const tried: SatOrderRecord[] = [];
  let found: { n: number; edges: Array<[number, number]> } | undefined;
  for (let n = 1; n <= settings.graphOrder && found === undefined; n++) {
    const pairs = vertexPairs(n);
    const answer = await solveModelEncoder(compute, encoder, n, { show: pairs.length, timeoutSec: settings.timeoutSec, signal: problem.signal });
    tried.push({ order: n, status: answer.status, ...(answer.solver !== undefined ? { solver: answer.solver } : {}), ...(answer.note !== undefined ? { note: answer.note } : {}) });
    if (answer.status === "unknown") break;
    if (answer.status === "sat") found = { n, edges: (answer.trueVariables ?? []).map((v) => pairs[v - 1] as [number, number]) };
  }
  if (found === undefined) {
    // An UNSAT of a model's encoder says nothing about the statement, since the encoder may be wrong: it is not evidence, and is recorded as unknown.
    recordSearch(problem, { ...base, tried, outcome: "unknown", note: "no model from an encoder the model wrote, which is no evidence", capability: compute.capability, encoderHash });
    return;
  }
  const graph = graphObject(found.n, found.edges);
  const confirmed = await confirmHit(problem, statement, { graph, source: "sat", filter: SAT_FILTER(found.n), program: encoder, detail: `order ${found.n}, an encoder the model wrote (${encoderHash.slice(0, 12)})` });
  recordSearch(problem, { ...base, tried, outcome: "found", confirmed, capability: compute.capability, encoderHash });
}

/** What the SAT searches of a claim say, for the briefing; undefined when none ran. */
export function describeSatFindings(problem: Pick<ProblemContext, "memory">, claimId: string): string | undefined {
  const lines = problem.memory.nodes(SAT_SEARCH_KIND, { claimId }).map((n) => (n.data as unknown as SatSearchData).summary);
  return lines.length === 0 ? undefined : lines.join("\n");
}
