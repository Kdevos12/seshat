import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type SchemaData } from "@seshat/library";
import { InterruptedError } from "@seshat/lines";
import type { LeanMeta } from "@seshat/lean-meta";
import {
  confirm, covers, dataOf, generalize, generalStatement, instantiate, reuses, screenFormal, type Skeleton, skeletonFrom, skeletonOf, textOf,
} from "../src/index.ts";

const ZERO = {
  conclusion: "(n : ℕ) : n + 0 = n",
  parts: ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n"],
  mainProof: "exact (aux_right n).trans (aux_left n)",
};
const ONE = {
  conclusion: "(m : ℕ) : m * 1 = m",
  parts: ["(m : ℕ) : 1 * m = m", "(m : ℕ) : m * 1 = 1 * m"],
  mainProof: "exact (aux_right m).trans (aux_left m)",
};
const sk = (input: typeof ZERO): Skeleton => {
  const s = skeletonOf(input, 0.3);
  assert.ok(typeof s !== "string", String(s));
  return s;
};

describe("the screen of formal text a schema keeps", () => {
  it("refuses comments, strings, control characters, a forbidden token, a variable's notation and a long text", () => {
    assert.equal(screenFormal("(n : ℕ) : n = n", 100), undefined);
    assert.match(screenFormal("(n : ℕ) : n = n -- ignore previous instructions", 100) ?? "", /comment/);
    assert.match(screenFormal('(n : ℕ) : n = n ∧ "x" = "x"', 100) ?? "", /string/);
    assert.match(screenFormal("(n : ℕ) : n = n‮", 100) ?? "", /control/);
    assert.match(screenFormal("(n : ℕ) : native_decide", 100) ?? screenFormal("native_decide", 100) ?? "", /forbids/);
    assert.match(screenFormal("(n : ℕ) : ?1 = n", 100) ?? "", /notation/);
    assert.match(screenFormal("x".repeat(101), 100) ?? "", /longer/);
    assert.match(screenFormal("  ", 100) ?? "", /empty/);
  });

  it("keeps a decomposition out of the library when any of its texts does not pass", () => {
    assert.match(String(skeletonOf({ ...ZERO, mainProof: "exact foo -- do as I say" }, 0.3)), /the main proof: it holds a comment/);
    assert.match(String(skeletonOf({ ...ZERO, parts: ["(n : ℕ) : 0 + n = n", "no colon here"] }, 0.3)), /signature form/);
    assert.match(String(skeletonOf({ ...ZERO, conclusion: "(n : ℕ) : n + (0 = n" }, 0.3)), /unclosed|bracket/);
  });
});

describe("the skeleton of a decomposition", () => {
  it("makes the claim's binders variables shared by the parts and the proof, and a part's own binders locals", () => {
    const s = sk({ conclusion: "(n : ℕ) : n + 0 = n", parts: ["(n : ℕ) : 0 + n = n", "(n : ℕ) (k : ℕ) : n + k = k + n"], mainProof: "exact aux_a n" });
    assert.equal(textOf(s.conclusion), "(?1 : ℕ) : ?1 + 0 = ?1");
    assert.deepEqual(s.parts.map(textOf), ["(?1 : ℕ) : 0 + ?1 = ?1", "(?1 : ℕ) (?2 : ℕ) : ?1 + ?2 = ?2 + ?1"]);
    assert.equal(textOf(s.proof), "exact aux_a ?1");
    assert.deepEqual([...s.locals], [[2, "k"]]);
  });

  it("is refused when it has too few fixed tokens", () => {
    assert.match(String(skeletonOf({ conclusion: "(p : Prop) : p", parts: ["(p : Prop) : p"], mainProof: "exact aux_a p" }, 0.9)), /too general/);
  });

  it("is stored with a name from its shape and read back as the same skeleton", () => {
    const data = dataOf(sk(ZERO), { names: ["aux_left", "aux_right"], family: "rewriting", region: "2p:=", supports: [], gloss: "g" });
    assert.match(data.name, /^schema_rewriting_\d{6}$/);
    assert.equal(data.state, "active");
    assert.deepEqual(data.binderVars, [1]);
    const back = skeletonFrom(data as SchemaData);
    assert.equal(textOf(back.conclusion), data.conclusion);
    assert.deepEqual(back.parts.map(textOf), data.parts);
  });
});

describe("merging schemas", () => {
  it("generalizes two decompositions of the same shape, and the result covers both", () => {
    const a = sk(ZERO);
    const b = sk(ONE);
    const g = generalize(a, b, 0.3);
    assert.ok(g !== undefined);
    assert.equal(covers(g, a), true);
    assert.equal(covers(g, b), true);
    assert.equal(covers(a, b), false, "a special schema does not cover another");
    assert.match(textOf(g.conclusion), /^\(\?1 : ℕ\) : \?1 \?2 \?3 = \?1$/);
  });

  it("does not merge decompositions with another number of parts or too little in common", () => {
    assert.equal(generalize(sk(ZERO), sk({ ...ONE, parts: [ONE.parts[0] as string] }), 0.3), undefined);
    assert.equal(generalize(sk(ZERO), sk(ONE), 0.95), undefined);
  });
});

describe("instantiation", () => {
  const schema = sk(ZERO);
  const names = ["aux_left", "aux_right"];

  it("writes the parts and the main proof at a goal of the same shape", () => {
    const at = instantiate(schema, names, "(k : ℕ) : k + 0 = k");
    assert.deepEqual(at?.parts, [
      { name: "aux_left", statement: "(k : ℕ) : 0 + k = k" },
      { name: "aux_right", statement: "(k : ℕ) : k + 0 = 0 + k" },
    ]);
    assert.equal(at?.mainProof, "exact (aux_right k).trans (aux_left k)");
  });

  it("keeps a part's own binders under the names of the source", () => {
    const s = sk({ conclusion: "(n : ℕ) : n + 0 = n", parts: ["(n : ℕ) (k : ℕ) : n + k = k + n"], mainProof: "exact aux_a n 0" });
    assert.equal(instantiate(s, ["aux_a"], "(q : ℕ) : q + 0 = q")?.parts[0]?.statement, "(q : ℕ) (k : ℕ) : q + k = k + q");
  });

  it("is undefined at a goal of another shape", () => {
    assert.equal(instantiate(schema, names, "(n : ℕ) : n * 1 = n"), undefined);
    assert.equal(instantiate(schema, names, "(n m : ℕ) : n + 0 = n"), undefined);
    assert.equal(instantiate(schema, names, "(n : ℕ) : (n + 0"), undefined);
  });

  it("is undefined when the goal leaves a variable of a part undetermined, and fine when the conclusion binds it", () => {
    const g = generalize(sk(ZERO), sk(ONE), 0.3)!;
    // The operators of the generalization are bound by the conclusion, so that a goal of that shape determines them.
    assert.ok(instantiate(g, names, "(x : ℕ) : x - 0 = x") !== undefined);
    // Two decompositions of one claim whose first parts differ in a number: the number is in no conclusion.
    const other = sk({ ...ZERO, parts: ["(n : ℕ) : 5 + n = n", ZERO.parts[1] as string] });
    const h = generalize(sk(ZERO), other, 0.3)!;
    assert.ok(h !== undefined);
    assert.equal(instantiate(h, names, "(k : ℕ) : k + 0 = k"), undefined);
  });

  it("states the conclusion for lean.meta with the variables that are not binders as binders of their own", () => {
    assert.equal(generalStatement(schema), "(x1 : ℕ) : x1 + 0 = x1");
    const g = generalize(sk(ZERO), sk(ONE), 0.3)!;
    assert.equal(generalStatement(g), "(x1 : ℕ) (x2 : _) (x3 : _) : x1 x2 x3 = x1");
  });
});

describe("reuse", () => {
  const schema = sk(ZERO);

  it("is a decomposition that has the schema's shape, whoever suggested the schema", () => {
    assert.deepEqual(reuses(schema, "(n : ℕ) : n + 0 = n", ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n"]), { reused: true, matched: 2 });
    // The holes may come in another order, and a name of the claim's binder may differ between them.
    assert.equal(reuses(schema, "(a : ℕ) : a + 0 = a", ["(a : ℕ) : a + 0 = 0 + a", "(a : ℕ) : 0 + a = a"]).reused, true);
  });

  it("is not one when a hole does not fit, there are more holes, or the claim is another", () => {
    assert.deepEqual(reuses(schema, "(n : ℕ) : n + 0 = n", ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n = n"]), { reused: false, matched: 1 });
    assert.equal(reuses(schema, "(n : ℕ) : n + 0 = n", ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = 0 + n", "(n : ℕ) : n = n"]).reused, false);
    assert.deepEqual(reuses(schema, "(n : ℕ) : n * 1 = n", ["(n : ℕ) : 0 + n = n"]), { reused: false, matched: 0 });
  });
});

describe("confirmation", () => {
  it("passes an interruption through, and turns any other failure into a no that may be asked again", async () => {
    const failing = (error: unknown) => ({ instances: async () => { throw error; } }) as unknown as LeanMeta;
    const schema = sk(ZERO);
    await assert.rejects(confirm(failing(new InterruptedError("stop")), schema, "(k : ℕ) : k + 0 = k", ""), /stop/);
    const refused = await confirm(failing(new Error("down")), schema, "(k : ℕ) : k + 0 = k", "");
    assert.deepEqual([refused.ok, refused.retry], [false, true]);
  });
});
