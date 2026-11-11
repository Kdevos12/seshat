import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import type { Llm, ProblemContext, ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import {
  countedLlm,
  GRAPH_HUNT,
  type GraphHitData,
  type GraphSearchData,
  type GraphSearchRunner,
  graphBattery,
  M11_DEFAULTS,
  type M11Options,
  createM11,
  describeFindings,
  describeGraphFindings,
  readOptions,
  runProgram,
  toGraph6,
} from "../src/index.ts";

const HAM = "(V : Type) [Fintype V] [DecidableEq V] (G : SimpleGraph V) [DecidableRel G.Adj] (h : G.Connected) (h3 : 3 ≤ Fintype.card V) : ∃ p : G.Walk _ _, p.IsHamiltonian";
const CONNECTED_NO_HAM_PATH = `(g) => {
  const n = g.n; if (n < 3) return false;
  const adj = Array.from({length: n}, () => Array(n).fill(false));
  for (const [u, v] of g.edges) { adj[u][v] = true; adj[v][u] = true; }
  const seen = new Set([0]); const stack = [0];
  while (stack.length) { const u = stack.pop(); for (let v = 0; v < n; v++) if (adj[u][v] && !seen.has(v)) { seen.add(v); stack.push(v); } }
  if (seen.size < n) return false;
  const go = (u, used) => { if (used.size === n) return true; for (let v = 0; v < n; v++) if (adj[u][v] && !used.has(v)) { used.add(v); if (go(v, used)) return true; used.delete(v); } return false; };
  for (let s = 0; s < n; s++) if (go(s, new Set([s]))) return false;
  return true;
}`;

function openMemory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-graph-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M11");
}

interface Answer {
  predicate: string;
  score?: string;
  filter?: Record<string, unknown>;
}

/** The simulated Lean: reads the graph back from the auxiliary text and says whether it refutes "connected graphs have a Hamiltonian path". */
function simulatedLean(accept: (n: number, edges: Array<[number, number]>) => boolean): (r: ValidateRequest) => ValidateResult {
  return (r) => {
    const n = Number(/Fin (\d+)\)/.exec(r.aux ?? "")?.[1]);
    const list = /\[((?:\(\d+, \d+\)(?:, )?)*)\]/.exec(r.aux ?? "")?.[1] ?? "";
    const edges = [...list.matchAll(/\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
    return accept(n, edges) ? { verdict: "valid", status: "open", reasons: [], validationId: "val_g" } : { verdict: "invalid", status: "open", reasons: ["failed to synthesize Decidable"] };
  };
}

async function setup(input: { answers?: Answer[]; options?: Partial<M11Options>; validate?: (r: ValidateRequest) => ValidateResult; statement?: string; sage?: boolean; sageOutput?: string; graphSearch?: GraphSearchRunner; seed?: number; memory?: MemoryStore }) {
  const memory = input.memory ?? openMemory();
  const statement = input.statement ?? HAM;
  const { claimId } = await memory.ensureClaim({ statement, origin: "bench:test" });
  const answers = input.answers ?? [];
  let asked = 0;
  const llm: Llm = {
    complete: async () => {
      throw new Error("unused");
    },
    completeJson: async () => {
      const value = answers[Math.min(asked, answers.length - 1)];
      asked++;
      return { value, text: JSON.stringify(value), cost: { usd: 0 }, model: "p/m", modelCallIds: [] } as never;
    },
  };
  const logs: string[] = [];
  const requests: ValidateRequest[] = [];
  const sageCalls: string[] = [];
  const sageTimeouts: Array<number | undefined> = [];
  const registry = {
    hash: "0".repeat(64),
    offers: (id: string) => id === "compute.sage" && input.sage === true,
    invoke: async (name: string, request: { code?: string; timeout?: number }) => {
      if (name !== "compute.sage" || input.sage !== true) throw new CapabilityError("unavailable", name, "not offered");
      sageCalls.push(request.code ?? "");
      sageTimeouts.push(request.timeout);
      if (input.sageOutput !== undefined) return { output: { result: input.sageOutput } };
      if (!(request.code ?? "").includes('nauty_geng("9')) return { output: { result: "[]" } };
      return { output: { result: `['${toGraph6(9, Array.from({ length: 8 }, (_, i) => [i, i + 1] as [number, number])).replace(/\\/g, "\\\\")}']` } };
    },
  } as unknown as Registry;
  const problem = {
    line: "M11",
    runId: "run_1",
    problemId: "p1",
    claimId,
    target: { theorem: "T.t", statement, source: "", sketch: { prefix: "import Mathlib\n" } },
    domain: [],
    memory,
    registry,
    llm,
    budget: { exhausted: false },
    validate: async (r: ValidateRequest) => {
      requests.push(r);
      return (input.validate ?? simulatedLean(() => true))(r);
    },
    log: (t: string) => logs.push(t),
    signal: new AbortController().signal,
    options: { ...M11_DEFAULTS, graphs: true, ...input.options },
    seed: input.seed ?? 7,
  } as unknown as ProblemContext;
  const line = createM11(input.graphSearch !== undefined ? { graphSearch: input.graphSearch } : {});
  const run = () => (line.hooks.beforeProvers as (p: ProblemContext) => Promise<void>)(problem);
  return { problem, memory, claimId, logs, requests, run, asked: () => asked, sageCalls, sageTimeouts };
}

const hits = (memory: MemoryStore, claimId: string) => memory.nodes("graph_hit", { claimId }).map((n) => n.data as unknown as GraphHitData);
const searches = (memory: MemoryStore, claimId: string) => memory.nodes("graph_search", { claimId }).map((n) => n.data as unknown as GraphSearchData);

describe("statements about graphs, with the option on", () => {
  it("refutes a false statement with a certificate, after the simulated Lean accepts the generated negation", async () => {
    const t = await setup({
      answers: [{ predicate: CONNECTED_NO_HAM_PATH, filter: { connected: true, minVertices: 1, maxVertices: 5, minEdges: 0 } }],
      validate: simulatedLean((n, edges) => n === 4 && edges.length === 3 && [0, 1, 2, 3].some((c) => edges.every(([u, v]) => u === c || v === c))),
    });
    await t.run();
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]?.negation, true);
    const [hit] = hits(t.memory, t.claimId);
    assert.equal(hit?.confirmation, "confirmed");
    assert.equal(hit?.n, 4);
    assert.equal(hit?.source, "battery");
    const certificate = t.memory.blobs.getJson(hit?.certificate ?? "") as { edges: unknown; graph6: string; predicate: string; filter: unknown; lean: string };
    const star = certificate.edges as Array<[number, number]>;
    assert.ok([0, 1, 2, 3].some((c) => star.length === 3 && star.every(([u, v]) => u === c || v === c)), "the star K_{1,3}");
    assert.ok(star.every(([u, v]) => (t.requests[0]?.aux ?? "").includes(`(${u}, ${v})`)), "the edge list of the generated Lean is the certificate's");
    assert.equal(certificate.predicate, CONNECTED_NO_HAM_PATH);
    assert.deepEqual(certificate.filter, { connected: true, minVertices: 1, maxVertices: 5, minEdges: 0, maxEdges: null });
    assert.match(certificate.lean, /degreeSeq witness = \[/);
    assert.equal(t.memory.edges({ from: t.claimId, kinds: ["refuted_by"] }).length, 1);
    assert.equal(t.memory.claim(t.claimId)?.status, "open");
    assert.match(describeGraphFindings(t.memory, t.claimId) ?? "", /passed the fast check/);
    assert.equal(describeFindings(t.memory, t.claimId), undefined);
  });

  it("leaves the claim open, with an unconfirmed evidence node and the class of the error, when Lean refuses", async () => {
    const t = await setup({
      answers: [{ predicate: CONNECTED_NO_HAM_PATH, filter: { connected: true, minVertices: 1, maxVertices: 4, minEdges: 0 } }],
      validate: simulatedLean(() => false),
    });
    await t.run();
    const [hit] = hits(t.memory, t.claimId);
    assert.equal(hit?.confirmation, "unconfirmed");
    assert.equal(hit?.errorClass, "instance");
    assert.equal(t.requests.length, 2);
    assert.equal(t.memory.edges({ from: t.claimId, kinds: ["refuted_by"] }).length, 0);
    assert.equal(t.memory.claim(t.claimId)?.status, "open");
    assert.match(describeGraphFindings(t.memory, t.claimId) ?? "", /Lean has not confirmed it \(instance/);
  });

  it("records no counterexample up to N as evidence with its filters, never as a status", async () => {
    const t = await setup({ answers: [{ predicate: "(g) => false", filter: { connected: true, minVertices: 2, maxVertices: 5, minEdges: 1, maxEdges: 9 } }] });
    await t.run();
    const [s] = searches(t.memory, t.claimId);
    assert.equal(s?.outcome, "none_found");
    assert.deepEqual(s?.filter, { connected: true, minVertices: 2, maxVertices: 5, minEdges: 1, maxEdges: 9 });
    assert.equal(s?.battery?.size, graphBattery(5, { connected: true }).objects.filter((g) => g.n >= 2 && g.edges.length >= 1 && g.edges.length <= 9).length);
    assert.match(s?.programHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(t.requests.length, 0);
    assert.equal(t.memory.claim(t.claimId)?.status, "open");
    assert.match(describeGraphFindings(t.memory, t.claimId) ?? "", /evidence and no proof/);
  });

  it("is idempotent: a second call of the hook does not try again", async () => {
    const t = await setup({ answers: [{ predicate: "(g) => false", filter: { connected: false, minVertices: 1, maxVertices: 3, minEdges: 0 } }] });
    await t.run();
    await t.run();
    assert.equal(t.asked(), 1);
    assert.equal(searches(t.memory, t.claimId).length, 1);
  });

  it("asks again for a program that does not run, and stops at the cap of requests", async () => {
    const t = await setup({ answers: [{ predicate: "(g) => g.nothing.at.all", filter: { connected: false, minVertices: 1, maxVertices: 3, minEdges: 0 } }] });
    await t.run();
    assert.equal(t.asked(), 3);
    assert.deepEqual([hits(t.memory, t.claimId).length, searches(t.memory, t.claimId).length], [0, 0]);
    assert.match(t.logs.join("\n"), /no predicate on graphs that runs/);
  });

  it("stays at 8 vertices without compute.sage, and lists 9 with it", async () => {
    const answer = { predicate: "(g) => g.n === 9", filter: { connected: true, minVertices: 9, maxVertices: 10, minEdges: 0 } };
    const without = await setup({ answers: [{ ...answer, filter: { ...answer.filter, maxEdges: 3 } }] });
    await without.run();
    const refused = searches(without.memory, without.claimId)[0];
    assert.equal(refused?.outcome, "not_run");
    assert.match(refused?.notes.join(" ") ?? "", /need the host's compute\.sage/);
    const withSage = await setup({ answers: [answer], sage: true });
    await withSage.run();
    assert.ok(withSage.sageCalls.some((c) => c.includes("nauty_geng(\"9 -c\")")));
    const [hit] = hits(withSage.memory, withSage.claimId);
    assert.equal(hit?.n, 9);
    assert.equal(searches(withSage.memory, withSage.claimId)[0]?.filter.maxVertices, 9);
  });

  it("runs the search beyond the lists only when nothing was found and a score was given, with the seed journaled", async () => {
    const calls: number[] = [];
    const t = await setup({
      answers: [{ predicate: "(g) => false", score: "(g) => 0", filter: { connected: false, minVertices: 1, maxVertices: 3, minEdges: 0 } }],
      graphSearch: async (input) => {
        calls.push(input.seed);
        return { hits: [{ graph: { n: 4, edges: [[0, 1], [0, 2], [0, 3]] }, source: "local_search", detail: "test" }], effort: { steps: 1 }, notes: [] };
      },
    });
    await t.run();
    assert.equal(calls.length, 1);
    const found = searches(t.memory, t.claimId).find((s) => s.method === "local_search");
    assert.equal(found?.seed, calls[0]);
    assert.equal(hits(t.memory, t.claimId)[0]?.source, "local_search");
  });
});

describe("the option off, and statements that are not about graphs", () => {
  it("changes nothing with the option off", async () => {
    const t = await setup({ answers: [{ predicate: "(g) => true", filter: { connected: false, minVertices: 1, maxVertices: 3, minEdges: 0 } }], options: { graphs: false } });
    await t.run();
    assert.equal(t.asked(), 0);
    assert.equal(t.memory.nodes("graph_hit", { claimId: t.claimId }).length + t.memory.nodes("graph_search", { claimId: t.claimId }).length, 0);
    assert.match(t.logs.join("\n"), /left alone/);
    assert.equal(M11_DEFAULTS.graphs, false);
    assert.equal(readOptions({ ...M11_DEFAULTS }).graphs, false);
  });

  it("spends nothing on a statement that is not about graphs", async () => {
    const t = await setup({ statement: "(s : Set ℕ) : s = s", answers: [{ predicate: "(g) => true" }] });
    await t.run();
    assert.equal(t.asked(), 0);
  });
});

describe("the sandbox of the predicate", () => {
  it("gives a program no network, no file system and no process", async () => {
    const run = await runProgram("(g) => typeof fetch === 'undefined' && typeof require === 'undefined' && typeof process === 'undefined' && typeof XMLHttpRequest === 'undefined'", graphBattery(2).objects);
    assert.deepEqual(run.verdicts, [true, true, true]);
  });
  it("ends a call that loops, without a verdict", async () => {
    const run = await runProgram("(g) => { while (true) {} }", graphBattery(1).objects, { callMs: 50 });
    assert.deepEqual(run.verdicts, [null]);
    assert.match(run.notes[0] ?? "", /timeout/);
  });
});

describe("the reach of the Lean recheck", () => {
  const smallHits = { predicate: "(g) => g.n >= 3 && g.edges.length >= g.n - 1", filter: { connected: true, minVertices: 1, maxVertices: 5, minEdges: 0 } };

  it("sends the smallest hits first, at most three", async () => {
    const t = await setup({ answers: [smallHits], validate: simulatedLean(() => false) });
    await t.run();
    const sizes = t.requests.map((r) => [Number(/Fin (\d+)\)/.exec(r.aux ?? "")?.[1]), (r.aux ?? "").match(/\(\d+, \d+\)/g)?.length ?? 0]);
    assert.equal(sizes.length, 6);
    assert.deepEqual(sizes[0], [3, 8]);
    assert.ok(sizes.every(([n], i) => i === 0 || (n as number) >= (sizes[i - 1]?.[0] as number)));
    assert.equal(hits(t.memory, t.claimId).length, 3);
  });

  it("does not send a graph above the vertex limit: unconfirmed, too_large", async () => {
    const t = await setup({ answers: [{ predicate: "(g) => g.n === 9", filter: { connected: true, minVertices: 9, maxVertices: 9, minEdges: 0 } }], sage: true });
    await t.run();
    assert.equal(t.requests.length, 0);
    const [hit] = hits(t.memory, t.claimId);
    assert.equal(hit?.confirmation, "unconfirmed");
    assert.equal(hit?.errorClass, "too_large");
    assert.ok(GRAPH_HUNT.leanVertices < 9);
  });

  it("tells the provers, for an unconfirmed hit, the witness, the definitions, the error class and that it is evidence; bounded", async () => {
    const t = await setup({ answers: [{ predicate: CONNECTED_NO_HAM_PATH, filter: { connected: true, minVertices: 1, maxVertices: 4, minEdges: 0 } }], validate: simulatedLean(() => false) });
    await t.run();
    const text = describeGraphFindings(t.memory, t.claimId) ?? "";
    assert.match(text, /^Evidence, not a verdict\. A program found this graph: 4 vertices 0\.\.3, edges /);
    assert.match(text, /Lean has not confirmed it \(instance/);
    assert.match(text, /candidate route/);
    assert.match(text, /abbrev aux_g_[0-9a-f]{12} : SimpleGraph \(Fin 4\)/);
    assert.match(text, /aux_gd_[0-9a-f]{12}/);
    assert.doesNotMatch(text, /is false as written/);
    assert.ok(text.length <= GRAPH_HUNT.briefingChars + 10);
  });

  it("prints where the certificate is, and the report lists the hit", async () => {
    const t = await setup({ answers: [{ predicate: CONNECTED_NO_HAM_PATH, filter: { connected: true, minVertices: 1, maxVertices: 4, minEdges: 0 } }], validate: simulatedLean(() => true) });
    await t.run();
    const [hit] = hits(t.memory, t.claimId);
    assert.ok(t.logs.some((l) => l.includes(`certificate of the graph`) && l.includes(hit?.certificate ?? "?") && l.includes("blobs")));
    assert.match(hit?.description ?? "", /confirmed by Lean, certificate [0-9a-f]{12}/);
  });
});

describe("the 10-vertex path", () => {
  it("gives the compute call its timeout and the filter to geng", async () => {
    const t = await setup({ answers: [{ predicate: "(g) => false", filter: { connected: true, minVertices: 9, maxVertices: 9, minEdges: 8, maxEdges: 12 } }], sage: true });
    await t.run();
    assert.deepEqual(t.sageTimeouts, [GRAPH_HUNT.sageTimeoutSec]);
    assert.match(t.sageCalls[0] ?? "", /nauty_geng\("9 -c 8:12"\)/);
  });

  it("refuses a battery over the cap after one call and records why", async () => {
    const many = `[${Array.from({ length: 20_001 }, () => "'Bw'").join(", ")}]`;
    const t = await setup({ answers: [{ predicate: "(g) => false", filter: { connected: true, minVertices: 9, maxVertices: 10, minEdges: 0 } }], sage: true, sageOutput: many });
    await t.run();
    assert.equal(t.sageCalls.length, 1);
    const [s] = searches(t.memory, t.claimId);
    assert.equal(s?.outcome, "not_run");
    assert.match(s?.notes.join(" ") ?? "", /more than 20000 graphs/);
  });
});

describe("a search that fails or is cut", () => {
  const answer = { predicate: "(g) => false", score: "(g) => 0", filter: { connected: false, minVertices: 1, maxVertices: 3, minEdges: 0 } };

  it("leaves a graph_search record with the seed, and a resumed process runs the search again without the lists", async () => {
    const memory = openMemory();
    const failing = await setup({ answers: [answer], memory, graphSearch: async () => { throw new Error("cap reached"); } });
    await failing.run();
    const first = searches(memory, failing.claimId);
    assert.deepEqual(first.map((r) => [r.method, r.outcome, r.final]), [["battery", "none_found", false], ["local_search", "failed", false]]);
    assert.equal(typeof first[1]?.seed, "number");
    assert.match(first[1]?.reason ?? "", /cap reached/);
    let ran = 0;
    const resumed = await setup({ answers: [answer], memory, graphSearch: async () => { ran++; return { hits: [], effort: { steps: 1 }, notes: [] }; } });
    // The same claim in the same memory.
    await resumed.run();
    assert.equal(ran, 1);
    const all = searches(memory, failing.claimId);
    assert.equal(all.filter((r) => r.method === "battery").length, 1, "the lists were not tried again");
    assert.equal(all.at(-1)?.final, true);
    await resumed.run();
    assert.equal(ran, 1, "a final record ends the work");
  });
});

describe("the cap of model requests", () => {
  it("refuses the request after the cap", async () => {
    let made = 0;
    const base = { complete: async () => { made++; return { text: "", cost: { usd: 0 }, model: "p/m", modelCallId: "m" }; }, completeJson: async () => { made++; return { value: {}, text: "", cost: { usd: 0 }, model: "p/m", modelCallIds: [] } as never; } } as unknown as Llm;
    const { llm, left } = countedLlm(base, GRAPH_HUNT.modelRequests);
    for (let i = 0; i < GRAPH_HUNT.modelRequests; i++) await llm.complete({ prompt: "x" });
    assert.equal(left(), 0);
    await assert.rejects(llm.complete({ prompt: "x" }), /cap of 6 model requests/);
    await assert.rejects(llm.completeJson?.({ prompt: "x", schema: { type: "object" } }) as Promise<unknown>, /cap of 6/);
    assert.equal(made, 6);
    assert.equal(GRAPH_HUNT.modelRequests, 6);
  });
});
