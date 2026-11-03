import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scriptedOrderer } from "@seshat/decide";
import { seeded } from "@seshat/core";
import { ALPHAS, type GoalClient, posteriorOrderer, routeGoalText, searchGoal, UnsafeText } from "../src/index.ts";

/**
 * A goal-state machine in a table: a state is a list of goals; a tactic maps (goal list, tactic) to
 * the next goals, or fails. It stands in for Pantograph, which says what Lean does with a tactic.
 */
function machine(rules: Record<string, Record<string, string[] | "error">>, start: string[]): GoalClient & { calls: Array<{ state: number; tactic: string }> } {
  const states: string[][] = [start];
  const calls: Array<{ state: number; tactic: string }> = [];
  return {
    calls,
    async start() {
      return { state: 0, goals: start };
    },
    async tactic(state, tactic) {
      calls.push({ state, tactic });
      const goals = states[state] as string[];
      const next = rules[goals.join("|")]?.[tactic];
      if (next === undefined || next === "error") return { error: `${tactic} failed` };
      states.push(next);
      return { state: states.length - 1, goals: next };
    },
  };
}

const RULES: Record<string, Record<string, string[] | "error">> = {
  "∀ n, n + 0 = n": { "intro n": ["n + 0 = n"], simp: "error" as const },
  "n + 0 = n": { simp: [], omega: [], "rw [foo]": ["n = n"] },
  "n = n": { rfl: [] },
};

const base = { header: "import Mathlib", statement: ": ∀ n : ℕ, n + 0 = n" };

describe("the goal-level search", () => {
  it("finds a two-step proof from the model's tactic and a battery tactic", async () => {
    const client = machine(RULES, ["∀ n, n + 0 = n"]);
    const out = await searchGoal({ ...base, proposals: ["intro n"], nodes: 30, alpha: 0.5 }, { client, orderer: posteriorOrderer(), random: seeded(1), tactics: ["simp", "omega"] });
    assert.ok(out.solved);
    assert.equal(out.script[0], "intro n");
    assert.ok(["simp", "omega"].includes(out.script[1] as string));
    assert.equal(out.alpha, 0.5);
  });

  it("keeps the model's own ranking for its tactics and orders the others by the orderer", async () => {
    const client = machine({ "n + 0 = n": { simp: "error" } }, ["n + 0 = n"]);
    const orderer = scriptedOrderer(["battery:omega"]);
    await searchGoal({ statement: "(n : ℕ) : n + 0 = n", header: "", proposals: ["zeta", "alpha"], nodes: 4, alpha: 0 }, { client, orderer, random: seeded(1), tactics: ["simp", "omega", "ring"] });
    assert.deepEqual(client.calls.map((c) => c.tactic), ["zeta", "alpha", "omega", "simp"], "the model's tactics first and in its order, then the orderer's");
    assert.deepEqual(orderer.asked[0]?.ids, ["battery:simp", "battery:omega", "battery:ring"], "only candidates that come without a model call are put to the orderer");
  });

  it("spends at most the budget in tactics", async () => {
    const client = machine({ "g": { a: ["g2"], b: ["g3"] } }, ["g"]);
    const out = await searchGoal({ statement: ": True", header: "", proposals: ["a", "b", "c", "d"], nodes: 3, alpha: 1 }, { client, orderer: posteriorOrderer(), random: seeded(1), tactics: [] });
    assert.equal(out.solved, false);
    assert.equal(out.tried, 3);
    assert.equal(client.calls.length, 3);
  });

  it("explores deeper states first when alpha is high, and shallower ones when it is 0", async () => {
    // Two children of the root: a deep chain by 'go' (rank 1), a dead end by 'stop' (rank 2).
    const rules = { root: { go: ["s1"], stop: ["t1"] }, s1: { go: ["s2"] }, s2: { go: [] } };
    const client = machine(rules, ["root"]);
    const out = await searchGoal({ statement: ": True", header: "", proposals: ["go", "stop"], nodes: 10, alpha: 1 }, { client, orderer: posteriorOrderer(), random: seeded(1), tactics: [] });
    assert.deepEqual(out.script, ["go", "go", "go"]);
  });

  it("draws alpha from {0, 0.5, 1} by the seed, and a run replays", async () => {
    const draw = async (seed: number) => (await searchGoal({ statement: ": True", header: "", nodes: 1 }, { client: machine({}, ["g"]), orderer: posteriorOrderer(), random: seeded(seed), tactics: [] })).alpha;
    const seen = new Set<number>();
    for (let s = 1; s < 40; s++) seen.add(await draw(s));
    assert.deepEqual([...seen].sort(), [...ALPHAS]);
    assert.equal(await draw(5), await draw(5));
  });

  it("reads a printed goal for the router", () => {
    const r = routeGoalText("n m : ℕ\nh : n < m\n⊢ n + 1 ≤ m");
    assert.equal(r.domains[0], "presburger");
  });
});

describe("model-written text is screened before it reaches Pantograph (review I5)", () => {
  const search = (input: Partial<Parameters<typeof searchGoal>[0]>) => {
    const client = machine({ g: { simp: [] } }, ["g"]);
    return searchGoal({ statement: ": True", header: "", nodes: 5, alpha: 0, ...input }, { client, orderer: posteriorOrderer(), random: seeded(1), tactics: ["simp"] });
  };
  it("refuses a statement, a tactic or a lemma with a command, a comment or a second line", async () => {
    await assert.rejects(search({ statement: ": True\n#eval 1" }), UnsafeText);
    await assert.rejects(search({ statement: ": True -- x" }), UnsafeText);
    await assert.rejects(search({ proposals: ["simp\nrun_tac skip"] }), /more than one line/);
    await assert.rejects(search({ proposals: ["simp; #eval 1"] }), UnsafeText);
    await assert.rejects(search({ lemmas: ["foo\n  exact bar"] }), /more than one line/);
    await assert.rejects(search({ lemmas: ["foo /- x"] }), UnsafeText);
  });
  it("lets an honest search through", async () => {
    assert.equal((await search({ proposals: ["simp"] })).solved, true);
  });
});
