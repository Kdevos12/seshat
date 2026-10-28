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

test("fairness: a heavy old clause is given within one cycle however many light ones keep arriving", () => {
  const g = new GivenClause<Clause>({ age: 1, weight: 4 });
  g.add(c("heavy", 0, 1000));
  let n = 1;
  let given = -1;
  for (let step = 0; step < 5; step++) {
    g.add(c(`light${n}`, n, 1));
    n += 1;
    g.add(c(`light${n}`, n, 1));
    n += 1;
    const p = g.select();
    if (p?.clause.id === "heavy") given = step;
  }
  assert.ok(given >= 0 && given < 5, "the age pick reaches it within a cycle");
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
