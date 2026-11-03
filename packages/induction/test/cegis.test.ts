import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LeanSnippet } from "@seshat/core";
import type { Line, ProblemContext } from "@seshat/lines";
import { CapabilityError, type Registry } from "@seshat/registry";
import { SimulatedDecide } from "../../models/test/simulated-lean.ts";
import { admitCounterexample, cegisCounter, COUNTEREXAMPLE_KIND, createM8, describeCounterexamples, M8_OPTIONS, readCounterexamples, screenBySet } from "../src/index.ts";
import { openMemory, scriptedLlm } from "./helpers.ts";

const TARGET = "(n : ℕ) : n ≤ n * n";
const lean = new SimulatedDecide({ truth: () => true });
const registry = {
  hash: "0".repeat(64),
  invoke: async (name: string, input: unknown) => {
    if (name === "lean.check") return { output: { results: await lean.check((input as { snippets: LeanSnippet[] }).snippets) } };
    throw new CapabilityError("unavailable", name, `the test host does not offer ${name}`);
  },
} as unknown as Registry;

const liar = { id: "all_prime", level: "pattern", informal: "every number is prime", conclusion: "(n) => n === 2 || n % 2 === 1", uses: ["prime"] };
const beyond = { id: "not_a_thousand", level: "observation", informal: "no number is a thousand", conclusion: "(n) => n !== 1000", uses: ["n"] };
const dag = { proof: "p", steps: [{ id: "s1", statement: "a step", dependsOn: [] }, { id: "s2", statement: "the claim", dependsOn: ["s1"] }] };

async function setup(proposals: unknown[], options: Record<string, unknown> = {}) {
  const memory = openMemory("orchestrator-test");
  const { claimId } = await memory.ensureClaim({ statement: TARGET, header: "import Mathlib", origin: "bench:test" });
  const logs: string[] = [];
  let round = 0;
  const llm = scriptedLlm([
    (r: { site?: string }) => {
      switch (r.site) {
        case "induction.hypotheses":
          return { hypotheses: proposals[Math.min(round++, proposals.length - 1)] };
        case "induction.dag":
          return dag;
        case "induction.formalize":
          return { statement: "(n : ℕ) : n ≠ 1000" };
        case "conjecture.relevance":
          return { score: 0.5 };
        default:
          throw new Error(`unexpected site ${r.site}`);
      }
    },
  ]);
  const problem = {
    line: "M8", runId: "run_1", problemId: "p1", claimId, memory, registry, llm, log: (t: string) => logs.push(t),
    signal: new AbortController().signal,
    options: { ...M8_OPTIONS, rounds: 2, classical: false, triviality: false, testCases: 0, ...options },
  } as unknown as ProblemContext;
  return { problem, memory, claimId, llm, logs };
}

const hook = <K extends keyof Line["hooks"]>(line: Line, name: K): NonNullable<Line["hooks"][K]> => {
  const found = line.hooks[name];
  assert.ok(found !== undefined);
  return found;
};

describe("the CEGIS rule: the counterexample set of a claim (PD5)", () => {
  it("stops a scripted proposer that repeats a refuted candidate, and shows the set in its next prompt", async () => {
    const { problem, memory, claimId, llm } = await setup([[liar], [liar]]);
    await hook(createM8(), "beforeProvers")(problem);
    const set = readCounterexamples(memory, claimId);
    assert.ok(set.length > 0 && set.every((c) => c.source === "table_run" && c.refutes === "all_prime"), "the table run put its counterexamples in the set");
    const counter = cegisCounter(memory, claimId);
    assert.deepEqual([counter.dropped, counter.byLine["line:M8"], counter.bySource["table_run"]], [1, 1, 1], "the second round's repeat was dropped by the set");
    const prompts = llm.requests.filter((r) => r.site === "induction.hypotheses").map((r) => r.prompt);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0] ?? "", /confirmed by a checker/);
    assert.match(prompts[1] ?? "", /confirmed by a checker/);
    assert.match(prompts[1] ?? "", /checked by table run; it refuted: all_prime/);
    assert.equal(llm.requests.filter((r) => r.site === "induction.dag" || r.site === "induction.formalize").length, 0, "nothing model-priced was spent on it");
  });

  it("keeps a model's claim of a counterexample out of the set until a checker confirms it", async () => {
    const { memory, claimId } = await setup([[]]);
    const refused = admitCounterexample(memory, claimId, { object: 7, id: "7", source: "model", refutes: "all_prime" });
    assert.equal(refused.admitted, false);
    assert.match("reason" in refused ? refused.reason : "", /stays out of the set until a checker confirms it/);
    assert.deepEqual(readCounterexamples(memory, claimId), []);
    assert.equal(memory.nodes(COUNTEREXAMPLE_KIND, { claimId }).length, 0);
    // A hand-written node that names no checker is not read either.
    memory.recordNode({ kind: COUNTEREXAMPLE_KIND, claimId, data: { object: 9, id: "9", source: "the model said so", refutes: "x" } });
    assert.deepEqual(readCounterexamples(memory, claimId), []);
    assert.equal(describeCounterexamples(readCounterexamples(memory, claimId)), "");
    const confirmed = admitCounterexample(memory, claimId, { object: 7, id: "7", source: "plausible", refutes: "all_prime" });
    assert.deepEqual(confirmed, { admitted: true, created: true });
    assert.equal(readCounterexamples(memory, claimId).length, 1);
    assert.deepEqual(admitCounterexample(memory, claimId, { object: 7, id: "7", source: "plausible", refutes: "all_prime" }), { admitted: true, created: false });
  });

  it("drops a candidate that fails an object beyond the table, which the table cannot see, and counts the tokens it saved", async () => {
    const { problem, memory, claimId, llm } = await setup([[beyond]], { rounds: 1 });
    admitCounterexample(memory, claimId, { object: 1000, id: "1000", source: "plausible", refutes: "earlier" });
    await hook(createM8(), "beforeProvers")(problem);
    const counter = cegisCounter(memory, claimId);
    assert.equal(counter.dropped, 1);
    assert.equal(counter.bySource["plausible"], 1);
    assert.ok(counter.tokensSaved > 0, "the table would have let it through: the DAG and the formalization were saved");
    assert.equal(llm.requests.filter((r) => r.site === "induction.dag" || r.site === "induction.formalize").length, 0);
    assert.equal(memory.claims().filter((c) => c.origin === "line:M8" && c.kind === "formal").length, 0);
  });

  it("screens a list of candidates by the set alone", async () => {
    const set = [{ object: 1000, id: "1000", source: "lean_decide" as const, refutes: "x" }];
    const { kept, dropped } = await screenBySet([beyond, { ...beyond, id: "fine", conclusion: "(n) => n >= 0" }] as never, set);
    assert.deepEqual([kept.map((h) => h.id), dropped.map((d) => d.hypothesis.id)], [["fine"], ["not_a_thousand"]]);
    assert.deepEqual((await screenBySet([beyond] as never, [])).kept.length, 1);
  });
});
