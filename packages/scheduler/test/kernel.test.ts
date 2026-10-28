import assert from "node:assert/strict";
import { test } from "node:test";
import { seeded } from "@seshat/core";
import { GivenClause, type Clause } from "../src/index.ts";

const c = (id: string, age: number, weight: number): Clause => ({ id, age, weight });

test("the cycle takes the oldest on its age picks and the lightest on the others", () => {
  const g = new GivenClause<Clause>({ age: 1, weight: 2 });
  for (let i = 0; i < 6; i++) g.add(c(`c${i}`, i, 10 - i));
  const rules: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const p = g.select();
    assert.ok(p);
    rules.push(p.rule);
    ids.push(p.clause.id);
  }
  assert.deepEqual(rules, ["age", "weight", "weight", "age", "weight", "weight"]);
  assert.deepEqual(ids, ["c0", "c5", "c4", "c1", "c3", "c2"]);
  assert.equal(g.select(), undefined);
});

/** A heavy old clause against a stream of two light new ones per step, from a given position in the cycle; the step that gives it, or -1. */
function givenAt(ratio: { age: number; weight: number }, start: number, steps: number): number {
  const g = new GivenClause<Clause>(ratio, start);
  g.add(c("heavy", 0, 1000));
  let n = 1;
  for (let step = 0; step < steps; step++) {
    g.add(c(`light${n}`, n, 1));
    g.add(c(`light${n + 1}`, n + 1, 1));
    n += 2;
    if (g.select()?.clause.id === "heavy") return step;
  }
  return -1;
}

test("fairness: a heavy old clause is given within one cycle wherever in the cycle the loop stands, and only the age pick can give it", () => {
  const ratio = { age: 1, weight: 4 };
  for (let start = 0; start < 5; start++) {
    const at = givenAt(ratio, start, 5);
    assert.ok(at >= 0 && at < 5, `from pick ${start}: given at step ${at}`);
    // The first pick of a cycle that starts after the age pick is a weight pick, which the light clauses win: the heavy one waits for the age pick.
    if (start > 0) assert.equal(at, 5 - start, `from pick ${start} the weight picks come first`);
  }
  // With the age pick disabled the heavy clause starves, however long the stream.
  assert.equal(givenAt({ age: 0, weight: 5 }, 1, 200), -1);
});

test("a restart at the same pick count continues the cycle; ties follow the seeded source", () => {
  const a = new GivenClause<Clause>({ age: 1, weight: 1 }, 1);
  assert.equal(a.nextRule(), "weight");
  const pool = () => [c("x", 0, 1), c("y", 1, 1), c("z", 2, 1)];
  const run = (seed: number) => {
    const g = new GivenClause<Clause>({ age: 0, weight: 1 });
    pool().forEach((p) => g.add(p));
    return g.select(seeded(seed))?.clause.id;
  };
  assert.equal(run(7), run(7));
  const g = new GivenClause<Clause>({ age: 0, weight: 1 });
  pool().forEach((p) => g.add(p));
  assert.equal(g.select()?.clause.id, "x");
});

test("remove drops a clause from both sets", () => {
  const g = new GivenClause<Clause>();
  g.add(c("a", 0, 1));
  g.add(c("b", 1, 1));
  g.select();
  assert.equal(g.remove("a"), true);
  assert.equal(g.remove("b"), true);
  assert.equal(g.remove("b"), false);
});
