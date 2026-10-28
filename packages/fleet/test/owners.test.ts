import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProblemContext, TaskInfo } from "@seshat/lines";
import { chooseOwner, createFleet, FLEET_OPTIONS, seeded, workerPosterior, type Worker } from "../src/index.ts";

const worker = (owner: string, load: number, done = 0, failed = 0): Worker => ({ owner, load, done, failed });

describe("the choice of an owner", () => {
  it("takes the least loaded worker", () => {
    const choice = chooseOwner(seeded(1), [worker("prover:p1", 2), worker("prover:p2", 0), worker("prover:p3", 1)]);
    assert.equal(choice?.owner, "prover:p2");
    assert.match(choice?.reason ?? "", /the fleet: prover:p2 holds 0 task/);
  });

  it("draws among the least loaded by Thompson sampling on their results: the one that keeps succeeding wins more often", () => {
    const wins = { good: 0, bad: 0 };
    for (let seed = 0; seed < 200; seed++) {
      const choice = chooseOwner(seeded(seed), [worker("prover:good", 0, 8, 0), worker("prover:bad", 0, 0, 8)]);
      if (choice?.owner === "prover:good") wins.good += 1;
      else wins.bad += 1;
    }
    assert.ok(wins.good > 180, `good won ${wins.good} of 200`);
    assert.ok(wins.bad > 0 || wins.good === 200);
  });

  it("repeats under one seed, and has no choice without workers", () => {
    const workers = [worker("prover:p1", 0), worker("prover:p2", 0), worker("prover:p3", 0)];
    assert.equal(chooseOwner(seeded(42), workers)?.owner, chooseOwner(seeded(42), workers)?.owner);
    assert.equal(chooseOwner(seeded(1), []), undefined);
  });

  it("starts a worker from the flat posterior", () => {
    assert.deepEqual(workerPosterior(worker("a", 0)), { alpha: 1, beta: 1 });
    assert.deepEqual(workerPosterior(worker("a", 0, 2, 1)), { alpha: 3, beta: 2 });
  });
});

describe("the fleet assigns the owners of the tasks lines proposed (Ruling 29)", () => {
  const info = (taskId: string, extra: Partial<TaskInfo>): TaskInfo => ({
    taskId, kind: "prove", status: "ready", dependsOn: [], acceptance: { type: "claim", claimId: "clm_1", minStatus: "computed" }, budget: {}, ...extra,
  });

  /** A problem with two provers running and `n` ready tasks that line M12 proposed, owned by the line until the fleet assigns them. */
  function setup(n: number, options: Record<string, unknown> = {}) {
    const store: TaskInfo[] = [
      info("tsk_p1", { status: "running", owner: "prover:p1" }),
      info("tsk_p2", { status: "running", owner: "prover:p2" }),
      ...Array.from({ length: n }, (_, k) => info(`tsk_h${k}`, { owner: "line:M12", proposedBy: "line:M12", claimId: `clm_h${k}` })),
    ];
    const assigned: Array<[string, string, string]> = [];
    const problem = {
      line: "fleet", runId: "run_1", problemId: "prb_1", claimId: "clm_1", options: { ...FLEET_OPTIONS, ...options }, log: () => undefined,
      tasks: {
        list: () => store,
        assign: (taskId: string, owner: string, reason: string) => {
          const task = store.find((t) => t.taskId === taskId);
          if (task === undefined) return { assigned: false as const, reason: "unknown" };
          store[store.indexOf(task)] = { ...task, owner };
          assigned.push([taskId, owner, reason]);
          return { assigned: true as const };
        },
      },
    } as unknown as ProblemContext;
    return { problem, store, assigned, ready: () => store.filter((t) => t.proposedBy !== undefined) };
  }

  it("gives each task to the least loaded prover, and leaves the provers' own tasks alone", async () => {
    const { problem, store, assigned, ready } = setup(4);
    await createFleet().hooks.assignOwners?.(problem, ready());
    assert.equal(assigned.length, 4);
    const owners = store.filter((t) => t.proposedBy !== undefined).map((t) => t.owner);
    assert.equal(owners.filter((o) => o === "prover:p1").length, 2);
    assert.equal(owners.filter((o) => o === "prover:p2").length, 2);
    assert.match(assigned[0]?.[2] ?? "", /^the fleet: prover:p[12] holds 0 task/);
    assert.deepEqual(store.slice(0, 2).map((t) => t.owner), ["prover:p1", "prover:p2"]);
    // A task that has a prover already is not given away again.
    await createFleet().hooks.assignOwners?.(problem, ready());
    assert.equal(assigned.length, 4);
  });

  it("draws with the option seed, so that the same seed assigns the same", async () => {
    const run = async (seed: number) => {
      const { problem, store, ready } = setup(3, { seed });
      await createFleet().hooks.assignOwners?.(problem, ready());
      return store.filter((t) => t.proposedBy !== undefined).map((t) => t.owner);
    };
    assert.deepEqual(await run(5), await run(5));
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) seen.add((await run(seed)).join());
    assert.ok(seen.size > 1, "other seeds assign differently");
  });

  it("does nothing when the problem has no prover task to name a worker", async () => {
    const { problem, store, ready, assigned } = setup(1);
    store.splice(0, 2);
    await createFleet().hooks.assignOwners?.(problem, ready());
    assert.deepEqual(assigned, []);
  });
});
