import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { BlobStore, Journal } from "@seshat/core";
import type { Llm, ProblemContext, ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import type { Registry } from "@seshat/registry";
import {
  allMagmas,
  canonicalTable,
  Cnf,
  compileMagmaStatement,
  createM11,
  encodeGraph,
  encodeMagma,
  type GraphHitData,
  graphFormula,
  M11_DEFAULTS,
  type M11Options,
  type MagmaStatement,
  readOptions,
  recognizeGraphStatement,
  recognizeStatement,
  type SatCompute,
  type SatSearchData,
  solveCnf,
  vertexPairs,
} from "../src/index.ts";

// --- A tiny DPLL -----------------------------------------------------------------------------------

/** A model (the true variables) of the clauses under the assumptions, or undefined when there is none. Unit propagation and branching, nothing more. */
function dpll(clauses: number[][], variables: number, assumptions: number[] = []): number[] | undefined {
  const value = new Int8Array(variables + 1);
  const trail: number[] = [];
  const set = (l: number): boolean => {
    const v = Math.abs(l);
    const want = l > 0 ? 1 : -1;
    if (value[v] === want) return true;
    if (value[v] === -want) return false;
    value[v] = want;
    trail.push(v);
    return true;
  };
  const truth = (l: number): number => (value[Math.abs(l)] as number) * (l > 0 ? 1 : -1);
  const propagate = (): boolean => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of clauses) {
        let free = 0;
        let last = 0;
        let satisfied = false;
        for (const l of c) {
          const t = truth(l);
          if (t > 0) {
            satisfied = true;
            break;
          }
          if (t === 0) {
            free++;
            last = l;
          }
        }
        if (satisfied) continue;
        if (free === 0) return false;
        if (free === 1) {
          set(last);
          changed = true;
        }
      }
    }
    return true;
  };
  const undo = (mark: number): void => {
    while (trail.length > mark) value[trail.pop() as number] = 0;
  };
  const search = (): boolean => {
    if (!propagate()) return false;
    let pick = 0;
    let best = Infinity;
    for (const c of clauses) {
      if (c.some((l) => truth(l) > 0)) continue;
      const free = c.filter((l) => truth(l) === 0);
      if (free.length < best) {
        best = free.length;
        pick = free[0] as number;
      }
    }
    if (pick === 0) return true;
    for (const l of [pick, -pick]) {
      const mark = trail.length;
      set(l);
      if (search()) return true;
      undo(mark);
    }
    return false;
  };
  for (const a of assumptions) if (!set(a)) return undefined;
  if (!search()) return undefined;
  return Array.from({ length: variables }, (_, i) => i + 1).filter((v) => value[v] === 1);
}

// --- A compute tool that speaks the solver's protocol ------------------------------------------------

type Solver = (clauses: number[][], variables: number, show: number) => number[] | undefined;

/** Reads the chunks and the solving call of `solveCnf` (and a model encoder's call), and answers with `solve` as python-sat would. */
function fakeCompute(solve: Solver, encoderAnswer?: (code: string, n: number, show: number) => number[] | undefined, o: { staleSession?: boolean } = {}): SatCompute & { calls: string[] } {
  let chunks: string[] = [];
  const calls: string[] = [];
  return {
    capability: "compute.python",
    calls,
    async run(code) {
      calls.push(code);
      const show = Number(/0 < v <= (\d+)/.exec(code)?.[1] ?? 0);
      if (code.includes("def encode(")) {
        const n = Number(/encode\((\d+)\)\]/.exec(code)?.[1]);
        const model = encoderAnswer?.(code, n, show);
        return { stdout: JSON.stringify(model === undefined ? { sat: false, solver: "fake" } : { sat: true, true: model, solver: "fake" }) };
      }
      // A stale session loses the reset of `_seshat_cnf`, so that the chunks of an earlier CNF stay in front.
      if (/^_seshat_cnf = \[\]/m.test(code) && o.staleSession !== true) chunks = [];
      if (/^_seshat_cnf = \['/m.test(code)) chunks = [];
      for (const m of code.matchAll(/_seshat_cnf(?: = \[|\.append\()'([A-Za-z0-9+/=]*)'/g)) chunks.push(m[1] as string);
      if (!code.includes("from pysat.solvers import Solver")) return { stdout: '{"sat": false, "solver": "chunk"}' };
      // The check of the joined chunks, as the Python makes it.
      const check = /len\(_seshat_joined\) == (\d+) and hashlib\.sha256\(.*\)\.hexdigest\(\) == '([0-9a-f]{64})'/.exec(code);
      const joined = chunks.join("");
      if (check !== null && (joined.length !== Number(check[1]) || createHash("sha256").update(joined).digest("hex") !== check[2])) {
        return { stdout: JSON.stringify({ error: "the chunks of the CNF do not join to what was sent (length or SHA-256)" }) };
      }
      const text = inflateSync(Buffer.from(joined, "base64")).toString("utf8");
      const clauses: number[][] = [];
      let variables = 0;
      for (const line of text.split("\n")) {
        const lits = line.trim().split(/\s+/).map(Number).filter((x) => x !== 0);
        for (const l of lits) variables = Math.max(variables, Math.abs(l));
        clauses.push(lits);
      }
      const model = solve(clauses, variables, show);
      return { stdout: JSON.stringify(model === undefined ? { sat: false, solver: "fake-dpll" } : { sat: true, true: model.filter((v) => v <= show), solver: "fake-dpll" }) };
    },
  };
}

const plainDpll: Solver = (clauses, variables) => dpll(clauses, variables);

// --- The encodings, against brute force --------------------------------------------------------------

describe("the CNF builder", () => {
  /** Whether the clauses have a model that agrees with `base` on the variables 1..base.length. */
  const extends_ = (cnf: Cnf, base: boolean[]) => dpll(cnf.clauses, cnf.variables, base.map((b, i) => (b ? i + 1 : -(i + 1)))) !== undefined;

  it("counts with a totalizer in both directions", () => {
    for (const k of [0, 1, 2, 3, 4, 5, 6]) {
      for (let mask = 0; mask < 32; mask++) {
        const cnf = new Cnf();
        cnf.variables = 5;
        const lit = cnf.atLeast([1, 2, 3, 4, 5], k);
        const ones = [0, 1, 2, 3, 4].filter((i) => (mask >> i) & 1).length;
        if (typeof lit === "boolean") assert.equal(lit, ones >= k || k <= 0);
        else {
          cnf.add([lit]);
          const yes = extends_(cnf, [0, 1, 2, 3, 4].map((i) => ((mask >> i) & 1) === 1));
          assert.equal(yes, ones >= k, `mask ${mask}, k ${k}`);
        }
      }
    }
  });

  it("orders one-hot vectors lexicographically, exactly", () => {
    // Two words of three bits, as one-hot vectors [¬x, x].
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        const cnf = new Cnf();
        cnf.variables = 6;
        cnf.lexLeq([1, 2, 3].map((v) => [-v, v]), [4, 5, 6].map((v) => [-v, v]));
        const bits = (x: number) => [2, 1, 0].map((i) => ((x >> i) & 1) === 1);
        assert.equal(extends_(cnf, [...bits(a), ...bits(b)]), a <= b, `${a} ≤ ${b}`);
      }
    }
  });
});

describe("the template encoders", () => {
  const magma = (text: string) => (recognizeStatement(text) as { statement: MagmaStatement }).statement;

  it("encodes the counter-models of a statement of magmas: every model fails it, and every class of failing magmas has one", () => {
    const statement = magma("(M : Type) [Mul M] (h : ∀ x y : M, x * y = y * x) : ∀ x y z : M, x * (y * z) = (x * y) * z");
    const verdict = compileMagmaStatement(statement);
    for (const n of [1, 2, 3]) {
      const e = encodeMagma(statement, n);
      const found = new Set<string>();
      const clauses = [...e.cnf.clauses];
      for (;;) {
        const model = dpll(clauses, e.cnf.variables);
        if (model === undefined) break;
        const object = e.decode(model.filter((v) => v <= e.show));
        assert.ok(object !== undefined);
        assert.equal(verdict(object).verdict, "fails", object.id);
        found.add(canonicalTable(object).join(","));
        clauses.push(model.filter((v) => v <= e.show).map((v) => -v));
      }
      const classes = new Set(allMagmas(n).filter((m) => verdict(m).verdict === "fails").map((m) => canonicalTable(m).join(",")));
      assert.deepEqual([...found].sort(), [...classes].sort(), `order ${n}`);
    }
  });

  const GRAPH = (body: string) => `(V : Type) [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] ${body}`;
  const formula = (text: string) => {
    const g = recognizeGraphStatement(text);
    assert.ok("statement" in g);
    return graphFormula(g.statement);
  };

  it("reads the fragment of graph statements, and says why a statement is outside it", () => {
    assert.ok("formula" in formula(GRAPH("(h : Fintype.card V = 10) (h3 : G.CliqueFree 3) : ¬ Gᶜ.CliqueFree 5")));
    assert.ok("formula" in formula(GRAPH("(h : ∀ v, 3 ≤ G.degree v) : G.edgeFinset.card ≥ 6 ∨ G.maxDegree < 2 → G.minDegree ≠ 1")));
    const outside = formula(GRAPH("(h : G.Connected) : ∃ p : G.Walk _ _, p.IsHamiltonian"));
    assert.match((outside as { reason: string }).reason, /outside the fragment: G\.Connected/);
    // Lean reads `∀ v, P v → Q` as `∀ v, (P v → Q)`, false on three vertices with one edge; read as `(∀ v, P v) → Q` it is a tautology,
    // which would be UNSAT evidence for a false statement. It is outside the fragment; with the parentheses, inside.
    for (const body of [": ∀ v, G.degree v ≥ 1 → G.minDegree ≥ 1", ": ∀ v, G.degree v ≥ 1 ∧ G.minDegree ≥ 1", ": G.minDegree ≥ 0 ∧ ∀ v, G.degree v ≥ 1 ∨ G.maxDegree = 2", "(h : ∀ v, G.degree v ≥ 1 → G.minDegree ≥ 1) : G.maxDegree ≥ 0"]) {
      assert.match((formula(GRAPH(body)) as { reason: string }).reason ?? "", /a ∀ whose body is more than one degree bound/, body);
    }
    assert.ok("formula" in formula(GRAPH(": (∀ v, G.degree v ≥ 1) → G.minDegree ≥ 1")));
    assert.ok("formula" in formula(GRAPH(": ¬ ∀ v, G.degree v ≥ 1")));
  });

  it("encodes the graphs that break a statement of the fragment: every model breaks it, and every class of them has one", () => {
    // On 5 vertices: a triangle-free graph has at most 6 edges (false: C5 plus nothing has 5; the bound fails above 6 only).
    const text = GRAPH("(h3 : G.CliqueFree 3) (hd : ∀ v, 1 ≤ G.degree v) : G.edgeFinset.card ≤ 4 ∨ Gᶜ.CliqueFree 3");
    const f = formula(text);
    assert.ok("formula" in f);
    const n = 5;
    const pairs = vertexPairs(n);
    const breaks = (edges: Array<[number, number]>) => {
      const adj = (u: number, v: number) => edges.some(([a, b]) => (a === u && b === v) || (a === v && b === u));
      const triples = [];
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) triples.push([a, b, c] as const);
      const triangleFree = triples.every(([a, b, c]) => !(adj(a, b) && adj(b, c) && adj(a, c)));
      const degreeOk = Array.from({ length: n }, (_, v) => v).every((v) => edges.some(([a, b]) => a === v || b === v));
      const independentTriple = triples.some(([a, b, c]) => !adj(a, b) && !adj(b, c) && !adj(a, c));
      return triangleFree && degreeOk && !(edges.length <= 4 || !independentTriple);
    };
    const e = encodeGraph(f.formula, n);
    const clauses = [...e.cnf.clauses];
    let models = 0;
    for (;;) {
      const model = dpll(clauses, e.cnf.variables);
      if (model === undefined) break;
      const shown = model.filter((v) => v <= e.show);
      assert.ok(breaks(e.decode(shown)?.edges ?? []), JSON.stringify(shown));
      models++;
      clauses.push(Array.from({ length: e.show }, (_, i) => (shown.includes(i + 1) ? -(i + 1) : i + 1)));
    }
    const any = Array.from({ length: 2 ** pairs.length }, (_, mask) => pairs.filter((_, i) => (mask >> i) & 1)).some(breaks);
    assert.equal(models > 0, any, "a model exactly when a breaking graph exists");
  });
});

// --- The line ----------------------------------------------------------------------------------------

function openMemory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-sat-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M11");
}

async function setup(input: { statement: string; compute?: SatCompute; options?: Partial<M11Options>; validate?: (r: ValidateRequest) => ValidateResult; answers?: unknown[] }) {
  const memory = openMemory();
  const { claimId } = await memory.ensureClaim({ statement: input.statement, origin: "bench:test" });
  const requests: ValidateRequest[] = [];
  const logs: string[] = [];
  const sites: string[] = [];
  let asked = 0;
  const llm: Llm = {
    complete: async () => {
      throw new Error("unused");
    },
    completeJson: async (request: { site?: string }) => {
      sites.push(request.site ?? "");
      const value = input.answers?.[asked++];
      if (value === undefined) throw new Error("no model here");
      return { value, text: JSON.stringify(value), cost: { usd: 0 }, model: "p/m", modelCallIds: [] } as never;
    },
  } as unknown as Llm;
  const problem = {
    line: "M11", runId: "run_1", problemId: "p1", claimId,
    target: { theorem: "T.t", statement: input.statement, source: "", sketch: { prefix: "import Mathlib\n" } },
    domain: [], memory, llm, budget: { exhausted: false },
    registry: { hash: "0".repeat(64), offers: () => false, invoke: async () => { throw new Error("no capability"); } } as unknown as Registry,
    validate: async (r: ValidateRequest) => (requests.push(r), (input.validate ?? (() => ({ verdict: "valid", status: "open", reasons: [], validationId: "val_1" })))(r)),
    log: (t: string) => logs.push(t),
    signal: new AbortController().signal,
    options: { ...M11_DEFAULTS, neighbors: 0, sat: true, ...input.options },
    seed: 3,
  } as unknown as ProblemContext;
  const line = createM11(input.compute !== undefined ? { compute: () => input.compute } : {});
  const run = () => (line.hooks.beforeProvers as (p: ProblemContext) => Promise<void>)(problem);
  const sat = () => memory.nodes("sat_search", { claimId }).map((n) => n.data as unknown as SatSearchData);
  return { problem, memory, claimId, requests, logs, sites, run, sat, line };
}

describe("line M11 with the option sat", () => {
  // Semigroups are commutative: false, and the battery is cut to the one-element magma, so only the SAT step can refute it.
  const SEMIGROUPS = "(M : Type) [Mul M] (h : ∀ x y z : M, x * (y * z) = (x * y) * z) : ∀ x y : M, x * y = y * x";

  it("finds a planted magma counter-model of order 5 with the template encoder, and Lean checks its negation", async () => {
    // The planted world: no counter-model below order 5, and at 5 the left-zero band (x * y = x), up to the renaming the lex-leader asks.
    const planted = Array.from({ length: 25 }, (_, i) => Math.floor(i / 5));
    const solve: Solver = (clauses, variables, show) => {
      if (show !== 125) return undefined;
      return dpll(clauses, variables, planted.map((c, cell) => cell * 5 + c + 1));
    };
    const compute = fakeCompute(solve);
    const t = await setup({ statement: SEMIGROUPS, compute, options: { exhaustive: 1, samples: 0 } });
    await t.run();
    const [search] = t.sat();
    assert.equal(search?.outcome, "found");
    assert.equal(search?.confirmed, true);
    assert.deepEqual(search?.tried.map((x) => [x.order, x.status]), [[1, "unsat"], [2, "unsat"], [3, "unsat"], [4, "unsat"], [5, "sat"]]);
    assert.ok(compute.calls.length > 6, "the order-5 CNF went in chunks");
    // Lean got the negation, written from the table's numbers.
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]?.negation, true);
    assert.match(t.requests[0]?.proof ?? "", /\(Fin 5\)/);
    assert.match(t.requests[0]?.proof ?? "", /\[0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4\]/);
    const counter = t.memory.nodes("counter_model", { claimId: t.claimId });
    assert.equal(counter.length, 1);
    // A resumed process does not search again.
    const calls = compute.calls.length;
    await t.run();
    assert.equal(compute.calls.length, calls);
    assert.equal(t.sat().length, 1);
  });

  it("with refute off, records the SAT counter-model and submits nothing, as for the battery's", async () => {
    const planted = Array.from({ length: 25 }, (_, i) => Math.floor(i / 5));
    const solve: Solver = (clauses, variables, show) => (show !== 125 ? undefined : dpll(clauses, variables, planted.map((c, cell) => cell * 5 + c + 1)));
    const t = await setup({ statement: SEMIGROUPS, compute: fakeCompute(solve), options: { exhaustive: 1, samples: 0, refute: false } });
    await t.run();
    assert.equal(t.requests.length, 0, "nothing went to validate");
    assert.equal(t.memory.nodes("counter_model", { claimId: t.claimId }).length, 1);
    const [search] = t.sat();
    assert.equal(search?.outcome, "found");
    assert.equal(search?.confirmed, undefined);
    assert.match(search?.note ?? "", /refute is off/);
  });

  it("records UNSAT as computed evidence and no status: R(3,3) = 6", async () => {
    const statement = "(V : Type) [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] (h : Fintype.card V = 6) (h3 : G.CliqueFree 3) : ¬ Gᶜ.CliqueFree 3";
    const compute = fakeCompute(plainDpll);
    const t = await setup({ statement, compute, options: { graphs: true, satGraphOrder: 6 } });
    await t.run();
    const [search] = t.sat();
    assert.equal(search?.outcome, "unsat");
    assert.match(search?.summary ?? "", /no counterexample graph of order 1 to 6\. Computed evidence, not a proof/);
    assert.equal(compute.calls.length, 1, "orders 1 to 5 are false as written, without a call");
    assert.equal(t.requests.length, 0, "nothing went to validate");
    assert.equal(t.memory.claim(t.claimId)?.status, "open");
    assert.equal(t.memory.edges({ from: t.claimId }).length, 0);
    const briefing = await t.line.hooks.briefing?.({ ...t.problem } as never);
    assert.match(briefing?.text ?? "", /no counterexample graph of order 1 to 6/);
  });

  it("finds a planted graph of order 10 with the template encoder: triangle-free, no independent set of 5", async () => {
    const statement = "(V : Type) [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] (h : Fintype.card V = 10) (h3 : G.CliqueFree 3) : ¬ Gᶜ.CliqueFree 5";
    // Two disjoint 5-cycles, renamed by swaps of neighbours until the lex-leader constraints hold (each swap makes the edge word smaller), then completed by the DPLL.
    const pairs = vertexPairs(10);
    let edges: Array<[number, number]> = [0, 5].flatMap((o) => [0, 1, 2, 3, 4].map((i) => [o + i, o + ((i + 1) % 5)] as [number, number]));
    const word = (es: Array<[number, number]>) => pairs.map(([u, v]) => (es.some(([a, b]) => (a === u && b === v) || (a === v && b === u)) ? 1 : 0)).join("");
    for (let moved = true; moved; ) {
      moved = false;
      for (let i = 0; i + 1 < 10; i++) {
        const swap = (x: number) => (x === i ? i + 1 : x === i + 1 ? i : x);
        const image = edges.map(([a, b]) => [swap(a), swap(b)] as [number, number]);
        if (word(image) < word(edges)) {
          edges = image;
          moved = true;
        }
      }
    }
    const planted = word(edges).split("").map((bit, i) => (bit === "1" ? i + 1 : -(i + 1)));
    const compute = fakeCompute((clauses, variables, show) => (show === 45 ? dpll(clauses, variables, planted) : dpll(clauses, variables)));
    const t = await setup({ statement, compute, options: { graphs: true } });
    await t.run();
    const [search] = t.sat();
    assert.equal(search?.outcome, "found");
    const hits = t.memory.nodes("graph_hit", { claimId: t.claimId }).map((n) => n.data as unknown as GraphHitData);
    assert.equal(hits.length, 1);
    const hit = hits[0] as GraphHitData;
    assert.deepEqual([hit.n, hit.source], [10, "sat"]);
    const adj = (u: number, v: number) => hit.edges.some(([a, b]) => (a === u && b === v) || (a === v && b === u));
    const sets = (k: number, from = 0, chosen: number[] = []): number[][] => (chosen.length === k ? [chosen] : Array.from({ length: 10 - from }, (_, i) => from + i).flatMap((v) => sets(k, v + 1, [...chosen, v])));
    assert.ok(sets(3).every(([a, b, c]) => !(adj(a as number, b as number) && adj(b as number, c as number) && adj(a as number, c as number))), "triangle-free");
    assert.ok(sets(5).every((s) => s.some((u, i) => s.slice(i + 1).some((v) => adj(u, v)))), "no independent set of 5");
    // Above the 8 vertices sent to Lean: evidence, unconfirmed, and no status.
    assert.deepEqual([hit.confirmation, hit.errorClass], ["unconfirmed", "too_large"]);
    assert.equal(t.requests.length, 0);
  });

  it("a wrong encoder the model wrote costs a try: Lean rejects its graph and the claim is unchanged", async () => {
    const statement = "(V : Type) [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] (h : G.Connected) (h3 : 3 ≤ Fintype.card V) : ∃ p : G.Walk _ _, p.IsHamiltonian";
    // The predicate finds nothing on the lists; then the encoder, which says every graph is a counterexample.
    const answers = [{ predicate: "(g) => false", filter: { connected: true, minVertices: 3, maxVertices: 4, minEdges: 0 } }, { encoder: "def encode(n):\n    return []" }];
    const compute = fakeCompute(plainDpll, (_code, n) => (n === 3 ? [1, 2] : undefined));
    const t = await setup({ statement, compute, options: { graphs: true, satGraphOrder: 4 }, answers, validate: () => ({ verdict: "invalid", status: "open", reasons: ["decide failed: the proposition is true"] }) });
    await t.run();
    assert.deepEqual(t.sites, ["models.graph.programs", "encode.sat"]);
    const search = t.sat().find((s) => s.encoder === "model");
    assert.equal(search?.outcome, "found");
    assert.equal(search?.confirmed, false);
    assert.ok(t.requests.length >= 1 && t.requests.every((r) => r.negation === true));
    // The graph reached Lean from its numbers: the path 0-1, 0-2 on Fin 3.
    assert.match(t.requests[0]?.aux ?? "", /SimpleGraph \(Fin 3\)/);
    assert.match(t.requests[0]?.aux ?? "", /\[\(0, 1\), \(0, 2\)\]/);
    assert.equal(t.memory.claim(t.claimId)?.status, "open");
    assert.equal(t.memory.validations(t.claimId).filter((v) => v.verdict === "valid").length, 0);
    const hit = t.memory.nodes("graph_hit", { claimId: t.claimId })[0]?.data as unknown as GraphHitData;
    assert.deepEqual([hit.source, hit.confirmation], ["sat", "unconfirmed"]);
  });

  it("is off by default, and says nothing ran without a compute tool", async () => {
    assert.equal(M11_DEFAULTS.sat, false);
    const { sat: _s, satMagmaOrder: _m, satGraphOrder: _g, satTimeoutSec: _t, satMaxClauses: _c, ...older } = M11_DEFAULTS;
    assert.equal(readOptions(older).sat, false, "options written before CX6");
    const off = await setup({ statement: SEMIGROUPS, compute: fakeCompute(plainDpll), options: { exhaustive: 1, samples: 0, sat: false } });
    await off.run();
    assert.equal(off.sat().length, 0);
    const none = await setup({ statement: SEMIGROUPS, options: { exhaustive: 1, samples: 0 } });
    await none.run();
    assert.deepEqual([none.sat()[0]?.outcome, none.requests.length], ["not_run", 0]);
  });

  it("checks the length and SHA-256 of the joined chunks before solving: a stale session's CNF is never solved for this one", async () => {
    // Two CNFs too large for one call each, made of pseudo-random clauses; the session keeps the first one's chunks in front of the second's.
    const big = (seed: number, unit: number) => {
      const cnf = new Cnf();
      cnf.variables = 3000;
      let x = seed;
      const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
      for (let i = 0; i < 20_000; i++) cnf.add([(next() % 3000) + 1, -((next() % 3000) + 1), (next() % 3000) + 1]);
      cnf.add([unit]);
      return cnf;
    };
    const seen: number[] = [];
    const compute = fakeCompute((clauses) => (seen.push(clauses.length), undefined), undefined, { staleSession: true });
    const first = await solveCnf(compute, big(1, 1), { show: 0, timeoutSec: 1 });
    assert.equal(first.status, "unsat");
    const chunked = compute.calls.length;
    assert.ok(chunked > 2, "the CNF went in chunks");
    const second = await solveCnf(compute, big(2, -1), { show: 0, timeoutSec: 1 });
    assert.equal(second.status, "unknown", "the first CNF's answer is not taken for the second's");
    assert.match(second.note ?? "", /do not join to what was sent/);
    assert.equal(seen.length, 1, "nothing was solved for the second CNF");
  });

  it("solves a contradiction without a call, and treats a failing tool as unknown, never UNSAT", async () => {
    const cnf = new Cnf();
    cnf.add([]);
    const calls: string[] = [];
    const tool: SatCompute = { capability: "compute.python", run: async (code) => (calls.push(code), { stdout: "" }) };
    assert.equal((await solveCnf(tool, cnf, { show: 0, timeoutSec: 1 })).status, "unsat");
    assert.equal(calls.length, 0);
    const one = new Cnf();
    one.variables = 1;
    one.add([1]);
    const failing: SatCompute = { capability: "compute.python", run: async () => { throw new Error("timeout"); } };
    assert.equal((await solveCnf(failing, one, { show: 1, timeoutSec: 1 })).status, "unknown");
    const garbage: SatCompute = { capability: "compute.python", run: async () => ({ stdout: '{"sat": true, "true": [7], "solver": "x"}' }) };
    assert.equal((await solveCnf(garbage, one, { show: 1, timeoutSec: 1 })).status, "unknown", "a variable out of range");
  });
});
