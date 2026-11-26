import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { isInterrupted } from "@seshat/lines";

/**
 * SAT for finite counterexamples (plan change CX6): a CNF builder with the encodings the template encoders need (exactly one,
 * cardinality by a totalizer, lexicographic order for lex-leader symmetry breaking), and the solver, python-sat in the host's
 * compute tool (`compute.python`). Nothing here decides a status: a model is decoded into an object that Lean checks, and an
 * UNSAT answer is evidence (documentation/models.md, "SAT encoders").
 */

/** A literal: a variable from 1, negative for its negation. */
export type Lit = number;

/** The CNF is larger than the cap the caller set. */
export class CnfTooLarge extends Error {}

export class Cnf {
  variables = 0;
  readonly clauses: Lit[][] = [];
  /** True once an empty clause was added: the formula is unsatisfiable without a solver. */
  contradiction = false;
  readonly #maxClauses: number;
  readonly #totalizers = new Map<string, Lit[]>();

  constructor(maxClauses = Number.POSITIVE_INFINITY) {
    this.#maxClauses = maxClauses;
  }

  fresh(): Lit {
    return ++this.variables;
  }

  /** Adds a clause; a clause with a literal and its negation is dropped, an empty one makes the formula a contradiction. */
  add(clause: readonly Lit[]): void {
    const set = new Set(clause);
    for (const l of set) if (set.has(-l)) return;
    if (set.size === 0) {
      this.contradiction = true;
      return;
    }
    if (this.clauses.length >= this.#maxClauses) throw new CnfTooLarge(`more than ${this.#maxClauses} clauses`);
    this.clauses.push([...set]);
  }

  atMostOne(lits: readonly Lit[]): void {
    for (let i = 0; i < lits.length; i++) for (let j = i + 1; j < lits.length; j++) this.add([-(lits[i] as Lit), -(lits[j] as Lit)]);
  }

  exactlyOne(lits: readonly Lit[]): void {
    this.add(lits);
    this.atMostOne(lits);
  }

  /** A literal equivalent to the conjunction of `lits` (true for none). */
  and(lits: readonly Lit[]): Lit {
    const y = this.fresh();
    for (const l of lits) this.add([-y, l]);
    this.add([y, ...lits.map((l) => -l)]);
    return y;
  }

  /** A literal equivalent to the disjunction of `lits` (false for none). */
  or(lits: readonly Lit[]): Lit {
    const y = this.fresh();
    this.add([-y, ...lits]);
    for (const l of lits) this.add([y, -l]);
    return y;
  }

  /**
   * The unary count of `lits` (a totalizer, both directions): output `i` (from 0) is true exactly when at least `i + 1` of them are.
   * Shared by every caller asking for the same literals.
   */
  count(lits: readonly Lit[]): Lit[] {
    const key = lits.join(",");
    const known = this.#totalizers.get(key);
    if (known !== undefined) return known;
    const build = (part: readonly Lit[]): Lit[] => {
      if (part.length <= 1) return [...part];
      const half = Math.floor(part.length / 2);
      const a = build(part.slice(0, half));
      const b = build(part.slice(half));
      const c = Array.from({ length: a.length + b.length }, () => this.fresh());
      // a[i-1] ∧ b[j-1] → c[i+j-1], and ¬a[i] ∧ ¬b[j] → ¬c[i+j], with a[-1] true and a[len] false.
      for (let i = 0; i <= a.length; i++) {
        for (let j = 0; j <= b.length; j++) {
          if (i + j > 0) this.add([...(i > 0 ? [-(a[i - 1] as Lit)] : []), ...(j > 0 ? [-(b[j - 1] as Lit)] : []), c[i + j - 1] as Lit]);
          if (i + j < c.length) this.add([...(i < a.length ? [a[i] as Lit] : []), ...(j < b.length ? [b[j] as Lit] : []), -(c[i + j] as Lit)]);
        }
      }
      return c;
    };
    const out = build(lits);
    this.#totalizers.set(key, out);
    return out;
  }

  /** A literal for "at least `k` of `lits`", or a constant. */
  atLeast(lits: readonly Lit[], k: number): Lit | boolean {
    if (k <= 0) return true;
    if (k > lits.length) return false;
    return this.count(lits)[k - 1] as Lit;
  }

  /**
   * `a ≤ b` in the lexicographic order, where each entry is a one-hot vector (the literal of each value, in the order of the values).
   * The models of the clauses, on the entries' literals, are exactly the pairs with `a ≤ b`.
   */
  lexLeq(a: ReadonlyArray<readonly Lit[]>, b: ReadonlyArray<readonly Lit[]>): void {
    let equalSoFar: Lit | true = true;
    for (let j = 0; j < a.length; j++) {
      const x = a[j] as readonly Lit[];
      const y = b[j] as readonly Lit[];
      if (x.length === y.length && x.every((l, i) => l === y[i])) continue;
      const guard = equalSoFar === true ? [] : [-equalSoFar];
      // While equal so far, a's value is not above b's.
      for (let c = 0; c < x.length; c++) for (let d = 0; d < c; d++) this.add([...guard, -(x[c] as Lit), -(y[d] as Lit)]);
      if (j === a.length - 1) break;
      const next = this.fresh();
      for (let c = 0; c < x.length; c++) this.add([...guard, -(x[c] as Lit), -(y[c] as Lit), next]);
      equalSoFar = next;
    }
  }

  /** The clauses as the body of a DIMACS file: the literals of each clause, then 0. */
  dimacs(): string {
    return this.clauses.map((c) => `${c.join(" ")} 0`).join("\n");
  }
}

/** A compute tool as the solver needs it: the shape of `registryCompute`'s tool in `@seshat/classical`, which this package cannot import. */
export interface SatCompute {
  readonly capability: string;
  run(code: string, options: { timeoutSec: number; signal?: AbortSignal }): Promise<{ stdout: string; result?: string | null }>;
}

export type SatStatus = "sat" | "unsat" | "unknown";

export interface SatAnswer {
  status: SatStatus;
  /** For `sat`: the true variables among 1..`show`. */
  trueVariables?: number[];
  solver?: string;
  note?: string;
}

/** The longest code of one call: under `compute.python`'s 20 000 characters. */
const CODE_LIMIT = 19_000;

/** The most calls that carry a CNF's chunks before the solving call. */
export const SAT_MAX_CHUNKS = 40;

/**
 * The Python that solves the clauses in `_seshat_clauses` with python-sat (CaDiCaL, then Glucose, then MiniSat, the first that
 * the installed python-sat has) and prints one JSON line: whether it is satisfiable, and the true variables up to `show`. When
 * `_seshat_clauses` is None (the chunks did not join to what was sent), it prints an error and solves nothing.
 */
function solvePython(show: number): string {
  return [
    "import json",
    "_seshat_out = None",
    "if _seshat_clauses is None:",
    "    _seshat_out = {'error': 'the chunks of the CNF do not join to what was sent (length or SHA-256)'}",
    "else:",
    "    from pysat.solvers import Solver",
    "    for _seshat_name in ('cadical153', 'glucose4', 'minisat22'):",
    "        try:",
    "            _seshat_solver = Solver(name=_seshat_name, bootstrap_with=_seshat_clauses)",
    "        except Exception:",
    "            continue",
    "        with _seshat_solver:",
    "            _seshat_ok = _seshat_solver.solve()",
    "            _seshat_model = _seshat_solver.get_model() if _seshat_ok else []",
    `        _seshat_out = {"sat": bool(_seshat_ok), "true": [v for v in (_seshat_model or []) if 0 < v <= ${show}], "solver": _seshat_name}`,
    "        break",
    "print(json.dumps(_seshat_out if _seshat_out is not None else {'error': 'no solver of python-sat could start'}))",
  ].join("\n");
}

/**
 * The Python that reads the chunks of `_seshat_cnf` (deflated DIMACS, base64) into `_seshat_clauses`, after checking that they
 * join to `data`, by its length and SHA-256: a lost reset or a stale chunk of the session would otherwise decode to another CNF
 * (zlib ignores what follows the end of its stream), and that CNF's answer would be taken for this one's. On a mismatch
 * `_seshat_clauses` is None.
 */
function readChunks(data: string): string {
  return [
    "import base64, hashlib, zlib",
    "_seshat_joined = ''.join(_seshat_cnf)",
    "_seshat_clauses = None",
    `if len(_seshat_joined) == ${data.length} and hashlib.sha256(_seshat_joined.encode('ascii')).hexdigest() == '${createHash("sha256").update(data, "ascii").digest("hex")}':`,
    "    _seshat_clauses = []",
    "    _seshat_clause = []",
    "    for _seshat_t in zlib.decompress(base64.b64decode(_seshat_joined)).decode().split():",
    "        _seshat_v = int(_seshat_t)",
    "        if _seshat_v == 0:",
    "            _seshat_clauses.append(_seshat_clause)",
    "            _seshat_clause = []",
    "        else:",
    "            _seshat_clause.append(_seshat_v)",
  ].join("\n");
}

/** Reads the solver's line: strict JSON, the variables integers in range. */
function readAnswer(stdout: string, show: number): SatAnswer {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { status: "unknown", note: `the solver's answer is not JSON: ${line.slice(0, 160)}` };
  }
  const o = parsed as { sat?: unknown; true?: unknown; solver?: unknown; error?: unknown };
  if (typeof o.error === "string") return { status: "unknown", note: o.error.slice(0, 200) };
  if (typeof o.sat !== "boolean" || typeof o.solver !== "string") return { status: "unknown", note: "the solver's answer has no verdict" };
  if (!o.sat) return { status: "unsat", solver: o.solver };
  if (!Array.isArray(o.true) || !o.true.every((v) => Number.isInteger(v) && v >= 1 && v <= show)) return { status: "unknown", note: "the solver's model is not a list of variables in range" };
  return { status: "sat", trueVariables: o.true as number[], solver: o.solver };
}

/** Runs a call; an error that is not an interruption is an unknown answer, never an UNSAT. */
async function call(compute: SatCompute, code: string, timeoutSec: number, signal: AbortSignal | undefined, show: number): Promise<SatAnswer> {
  try {
    const answer = await compute.run(code, { timeoutSec, ...(signal !== undefined ? { signal } : {}) });
    return readAnswer(answer.stdout, show);
  } catch (error) {
    if (isInterrupted(error) || signal?.aborted === true) throw error;
    return { status: "unknown", note: `the compute tool failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}` };
  }
}

/**
 * Solves a CNF with python-sat in the compute tool's session: the DIMACS body deflated and in base64, in chunks of one call each
 * when it does not fit in one (at most `SAT_MAX_CHUNKS`), then the solving call. `show` is the last variable the answer reports
 * (the object's). A contradiction is UNSAT without a call; a timeout or a failure is `unknown`.
 */
export async function solveCnf(compute: SatCompute, cnf: Cnf, options: { show: number; timeoutSec: number; signal?: AbortSignal }): Promise<SatAnswer> {
  if (cnf.contradiction) return { status: "unsat", solver: "none (the formula is false as written)" };
  const data = deflateSync(Buffer.from(cnf.dimacs(), "utf8")).toString("base64");
  const solve = `${readChunks(data)}\n${solvePython(options.show)}`;
  if (data.length + solve.length + 40 <= CODE_LIMIT) return call(compute, `_seshat_cnf = ['${data}']\n${solve}`, options.timeoutSec, options.signal, options.show);
  const size = CODE_LIMIT - 100;
  const chunks = Math.ceil(data.length / size);
  if (chunks > SAT_MAX_CHUNKS) return { status: "unknown", note: `the CNF takes ${chunks} calls to send, over ${SAT_MAX_CHUNKS}` };
  for (let i = 0; i < chunks; i++) {
    const chunk = data.slice(i * size, (i + 1) * size);
    const code = `${i === 0 ? "_seshat_cnf = []\n" : ""}_seshat_cnf.append('${chunk}')\nprint('{"sat": false, "solver": "chunk"}')`;
    try {
      await compute.run(code, { timeoutSec: options.timeoutSec, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    } catch (error) {
      if (isInterrupted(error) || options.signal?.aborted === true) throw error;
      return { status: "unknown", note: `the compute tool failed on a chunk: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}` };
    }
  }
  return call(compute, solve, options.timeoutSec, options.signal, options.show);
}

/** The longest encoder a model may write (its code and the solving code make one call). */
export const MAX_ENCODER_LENGTH = 12_000;

/**
 * Runs a model-written encoder (Python, `def encode(n)` returning a list of clauses) for order `n` in the compute tool, then
 * solves its clauses in the same call. The model's code runs in the compute tool as any code a model writes does; whatever
 * model comes back is only a candidate the caller decodes and sends to Lean.
 */
export async function solveModelEncoder(compute: SatCompute, encoder: string, n: number, options: { show: number; timeoutSec: number; signal?: AbortSignal }): Promise<SatAnswer> {
  if (encoder.length > MAX_ENCODER_LENGTH) return { status: "unknown", note: `the encoder has ${encoder.length} characters, over ${MAX_ENCODER_LENGTH}` };
  const code = [
    encoder,
    "_seshat_clauses = [[int(l) for l in c] for c in encode(" + String(n) + ")]",
    solvePython(options.show),
  ].join("\n");
  return call(compute, code, options.timeoutSec, options.signal, options.show);
}
