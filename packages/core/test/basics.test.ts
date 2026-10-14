import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BlobStore,
  canonicalJson,
  canTransition,
  collapseWhitespace,
  edgeStatusRank,
  hashJson,
  mergePatch,
  newId,
  sha256Hex,
  statementIdV0,
  stripLeanComments,
} from "../src/index.ts";

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("gives the same hash for equal values written in another order", () => {
    assert.equal(hashJson({ a: 1, b: [1, 2] }), hashJson({ b: [1, 2], a: 1 }));
    assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
  });

  it("refuses values JSON cannot round-trip", () => {
    assert.throws(() => canonicalJson({ x: Number.NaN }), /non-finite number at \$\.x/);
    assert.throws(() => canonicalJson([new Date(0)]), /unsupported object at \$\[0\]/);
    assert.throws(() => canonicalJson({ f: () => 1 }), /unsupported function/);
  });
});

describe("mergePatch", () => {
  it("sets, replaces and removes keys recursively, as RFC 7386 says", () => {
    const target = { a: "b", c: { d: "e", f: "g" }, list: [1, 2] };
    assert.deepEqual(mergePatch(target, { a: "z", c: { f: null, h: 1 }, list: [3] }), { a: "z", c: { d: "e", h: 1 }, list: [3] });
    assert.deepEqual(target, { a: "b", c: { d: "e", f: "g" }, list: [1, 2] }, "the target is not changed");
    assert.deepEqual(mergePatch({ a: 1 }, ["x"]), ["x"]);
    assert.deepEqual(mergePatch(["x"], { a: { b: null, c: 2 } }), { a: { c: 2 } });
    assert.deepEqual(mergePatch(undefined, { a: null, b: 1 }), { b: 1 });
    assert.equal(mergePatch({ a: 1 }, null), null);
  });

  it("keeps a __proto__ key as a plain key", () => {
    const merged = mergePatch({}, JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.deepEqual(Object.keys(merged), ["__proto__"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe("newId", () => {
  it("is prefixed, 26 characters after the prefix, and sorts by time", () => {
    const zeros = new Uint8Array(10);
    const a = newId("att", 1_700_000_000_000, zeros);
    const b = newId("att", 1_700_000_000_001, zeros);
    assert.match(a, /^att_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(a < b);
    assert.equal(newId("att", 0, zeros), "att_00000000000000000000000000");
    assert.equal(newId("x", 0, new Uint8Array(10).fill(255)), "x_0000000000ZZZZZZZZZZZZZZZZ");
  });

  it("refuses bad prefixes", () => {
    assert.throws(() => newId("Bad"), /bad prefix/);
    assert.throws(() => newId("toolongprefix"), /bad prefix/);
  });
});

describe("statement ids", () => {
  it("removes nested and line comments but keeps strings", () => {
    assert.equal(stripLeanComments('a /- x /- y -/ z -/ b -- c\n"--not a comment"'), 'a  b \n"--not a comment"');
  });

  it("ignores comments and whitespace, not content", () => {
    const a = statementIdV0("theorem t : 1 + 1 = 2 := by\n  sorry");
    const b = statementIdV0("theorem t :  1 + 1 = 2 := by /- note -/\n\tsorry -- todo");
    assert.equal(a, b);
    assert.notEqual(a, statementIdV0("theorem t : 1 + 1 = 3 := by sorry"));
    assert.match(a, /^st0_[0-9a-f]{32}$/);
    assert.equal(collapseWhitespace("  a \n b  "), "a b");
  });

  it("keeps the id of a statement with no header, and hashes a header with the statement", () => {
    const statement = "(n : ℕ) : n + 0 = n";
    // The ids of statements with no header are the ones this function always gave.
    assert.equal(statementIdV0(statement), "st0_84d25b8a326e7ae4ad6b194c8aa9c597");
    assert.equal(statementIdV0(": 1 + 1 = 2"), "st0_aedbc542c3d26b2fd9404138d67e753d");
    const header = "import Mathlib\nopen Nat";
    const id = statementIdV0(statement, header);
    assert.match(id, /^st0_[0-9a-f]{32}$/);
    assert.notEqual(id, statementIdV0(statement));
    // The header is normalized as the statement is: comments and spacing do not count.
    assert.equal(statementIdV0(" (n : ℕ)  :  n + 0 = n -- zero", "import   Mathlib /- all of it -/\n\nopen Nat\n"), id);
    // Another header, another statement; the header and the statement cannot trade text.
    assert.notEqual(statementIdV0(statement, "import Mathlib"), id);
    assert.notEqual(statementIdV0(statement, "import Mathlib\nopen Nat\nopen Real"), id);
    assert.notEqual(statementIdV0("n : ℕ) : n + 0 = n", "import Mathlib\nopen Nat\n("), statementIdV0("(n : ℕ) : n + 0 = n", "import Mathlib\nopen Nat"));
    // A header with nothing in it is none.
    assert.equal(statementIdV0(statement, ""), statementIdV0(statement));
    assert.equal(statementIdV0(statement, "  -- nothing here\n/- or here -/ "), statementIdV0(statement));
  });
});

describe("claim statuses", () => {
  it("only lets a revocation undo a proof", () => {
    assert.ok(canTransition("open", "computed"));
    assert.ok(canTransition("computed", "proved"));
    assert.ok(canTransition("proved", "retracted"));
    assert.ok(!canTransition("proved", "open"));
    assert.ok(!canTransition("refuted", "proved"));
    assert.ok(!canTransition("open", "retracted"));
  });

  it("ranks edge statuses with lean_checked last", () => {
    assert.equal(edgeStatusRank("proposed"), 0);
    assert.ok(edgeStatusRank("human_signed") < edgeStatusRank("lean_checked"));
    assert.ok(edgeStatusRank("computed") < edgeStatusRank("informal_checked"));
  });
});

describe("BlobStore", () => {
  it("stores texts and JSON under their hash, once", () => {
    const store = new BlobStore(mkdtempSync(join(tmpdir(), "mh-blobs-")));
    const hash = store.put("theorem t : True := trivial");
    assert.equal(hash, sha256Hex("theorem t : True := trivial"));
    assert.equal(store.put("theorem t : True := trivial"), hash);
    assert.equal(store.get(hash), "theorem t : True := trivial");
    const value = { b: [1, 2], a: "x" };
    const jsonHash = store.putJson(value);
    assert.equal(jsonHash, hashJson(value));
    assert.deepEqual(store.getJson(jsonHash), { a: "x", b: [1, 2] });
    assert.equal(store.get(sha256Hex("absent")), undefined);
    assert.deepEqual(readdirSync(join(store.dir, hash.slice(0, 2))), [hash]);
  });

  it("refuses a blob whose content does not match its name, and names that are not hashes", () => {
    const store = new BlobStore(mkdtempSync(join(tmpdir(), "mh-blobs-")));
    const hash = store.put("a");
    writeFileSync(join(store.dir, hash.slice(0, 2), hash), "b");
    assert.throws(() => store.get(hash), /does not match its content/);
    assert.throws(() => store.get("../x"), /not a sha256/);
  });
});
