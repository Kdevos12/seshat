import assert from "node:assert/strict";
import { test } from "node:test";
import { ProofNumbers } from "../src/index.ts";

test("a leaf is its price; an AND sums, an OR takes the least", () => {
  const pn = new ProofNumbers(
    [{ id: "root", prove: 10 }, { id: "a", prove: 2 }, { id: "b", prove: 3 }],
    [{ parent: "root", parts: ["a", "b"] }],
  );
  assert.equal(pn.of("root").pn, 5);
  assert.equal(pn.of("a").pn, 2);
  assert.equal(pn.of("root").dpn, 10 + 2);
});

test("settled parts cost nothing and a dead part kills its decomposition", () => {
  const pn = new ProofNumbers(
    [{ id: "r", prove: 9 }, { id: "a", settled: true }, { id: "b", prove: 4 }, { id: "d", dead: true }],
    [{ parent: "r", parts: ["a", "b"] }, { parent: "r", parts: ["a", "d"] }],
  );
  assert.equal(pn.of("r").pn, 4);
  assert.equal(pn.of("a").dpn, Infinity);
  assert.equal(pn.of("d").pn, Infinity);
});

test("a settled root has pn 0 and no most proving leaf", () => {
  const pn = new ProofNumbers([{ id: "r", settled: true }], []);
  assert.equal(pn.of("r").pn, 0);
  assert.equal(pn.mostProving("r"), undefined);
});

test("a shared part is counted in each parent; a cycle is cut", () => {
  const pn = new ProofNumbers(
    [{ id: "r" }, { id: "p", prove: 1 }, { id: "q", prove: 1 }, { id: "s", prove: 5 }],
    [
      { parent: "r", parts: ["p", "q"] },
      { parent: "p", parts: ["s"] },
      { parent: "q", parts: ["s"] },
      { parent: "s", parts: ["r"] },
    ],
  );
  assert.equal(pn.of("r").pn, 2);
  assert.ok(Number.isFinite(pn.of("s").pn));
});

test("the most proving leaf: the direct proof when it is cheapest, else the part that fails soonest", () => {
  const pn = new ProofNumbers([{ id: "r", prove: 3 }, { id: "a", prove: 2 }, { id: "b", prove: 2 }], [{ parent: "r", parts: ["a", "b"] }]);
  assert.equal(pn.mostProving("r"), "r");
  const pn2 = new ProofNumbers(
    [{ id: "r", prove: 30 }, { id: "a", prove: 2, disprove: 9 }, { id: "b", prove: 3, disprove: 1 }],
    [{ parent: "r", parts: ["a", "b"] }],
  );
  assert.equal(pn2.mostProving("r"), "b");
  const pn3 = new ProofNumbers([{ id: "r", prove: 30 }, { id: "a", settled: true }, { id: "b", prove: 3 }], [{ parent: "r", parts: ["a", "b"] }]);
  assert.equal(pn3.mostProving("r"), "b");
});

test("a claim with no way is unreachable", () => {
  const pn = new ProofNumbers([{ id: "r" }], []);
  assert.equal(pn.of("r").pn, Infinity);
  assert.equal(pn.mostProving("r"), undefined);
});
