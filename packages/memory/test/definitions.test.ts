import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { DEFINITION_KIND, MemoryStore, mentionsDeclaration } from "../src/index.ts";

function open(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-defs-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")), now: () => new Date("2026-11-03T00:00:00Z") });
}

const INPUT = { name: "SeshatLib.Foo.mulDiv", keyword: "def", module: "SeshatLib.Foo.Basic", buildId: "nod_build", testLemmas: ["mulDiv_one"] };
const STATEMENT = "(n : ℕ) : SeshatLib.Foo.mulDiv n 1 = n";

describe("the review status of definitions (LC5)", () => {
  it("records a new definition unreviewed", () => {
    const memory = open();
    const d = memory.recordDefinition(INPUT);
    assert.equal(d.status, "unreviewed");
    assert.equal(memory.definition("SeshatLib.Foo.mulDiv")?.nodeId, d.nodeId);
    assert.equal(memory.nodes(DEFINITION_KIND).length, 1);
  });

  it("refuses a claim statement or header that uses a definition that is not reviewed, by full or short name", async () => {
    const memory = open();
    memory.recordDefinition(INPUT);
    await assert.rejects(memory.ensureClaim({ statement: STATEMENT, origin: "test" }), /uses SeshatLib\.Foo\.mulDiv \(unreviewed\)/);
    await assert.rejects(memory.ensureClaim({ statement: "(n : ℕ) : mulDiv n 1 = n", origin: "test" }), /unreviewed/);
    await assert.rejects(memory.ensureClaim({ statement: "(n : ℕ) : n = n", header: "import Mathlib\ndef x := mulDiv 1 1", origin: "test" }), /unreviewed/);
    // Prose, comments and a longer name are not mentions; an informal claim is not Lean.
    assert.equal((await memory.ensureClaim({ statement: "(n : ℕ) : n = n -- mulDiv", origin: "test" })).created, true);
    assert.equal((await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n ∧ mulDivish n = n", origin: "test" })).created, true);
    assert.equal((await memory.ensureClaim({ statement: "mulDiv is a definition", kind: "informal", origin: "test" })).created, true);
  });

  it("lets a person or two checkers review it, and then a statement may use it", async () => {
    const memory = open();
    memory.recordDefinition(INPUT);
    const reviewed = memory.reviewDefinition("SeshatLib.Foo.mulDiv", { by: { kind: "human", name: "ana" } });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.review?.actor, "human:ana");
    assert.equal(reviewed.review?.at, "2026-11-03T00:00:00.000Z");
    assert.equal((await memory.ensureClaim({ statement: STATEMENT, origin: "test" })).created, true);
    const other = open();
    other.recordDefinition({ ...INPUT, name: "SeshatLib.Foo.divMul" });
    other.reviewDefinition("SeshatLib.Foo.divMul", { by: { kind: "faithfulness", checkers: ["family-a/x", "family-b/y"], verdict: "faithful" } });
    assert.equal(other.definition("SeshatLib.Foo.divMul")?.status, "reviewed");
  });

  it("refuses a review by a view, by one checker or by an unnamed person, and a second review", () => {
    const memory = open();
    memory.recordDefinition(INPUT);
    const name = "SeshatLib.Foo.mulDiv";
    const view = memory.withActor("line:M3");
    assert.throws(() => view.withActor("human:ana"), /cannot write as/);
    assert.throws(() => view.reviewDefinition(name, { by: { kind: "human", name: "ana" } }), /view/);
    assert.throws(() => view.recordDefinition({ ...INPUT, name: "SeshatLib.Foo.other" }), /view/);
    assert.throws(() => memory.reviewDefinition(name, { by: { kind: "faithfulness", checkers: ["a", "a"], verdict: "faithful" } }), /two distinct/);
    assert.throws(() => memory.reviewDefinition(name, { by: { kind: "human", name: " " } }), /names the person/);
    memory.reviewDefinition(name, { by: { kind: "human", name: "ana" } });
    assert.throws(() => memory.reviewDefinition(name, { by: { kind: "human", name: "ana" } }), /is reviewed/);
    assert.throws(() => memory.reviewDefinition("SeshatLib.Foo.nothing", { by: { kind: "human", name: "ana" } }), /unknown/);
  });

  it("does not let a node write or patch the status around the review", () => {
    const memory = open();
    const d = memory.recordDefinition(INPUT);
    const line = memory.withActor("line:M3");
    assert.throws(() => line.recordNode({ kind: DEFINITION_KIND, data: { name: "SeshatLib.Foo.sneaky", status: "reviewed" } }), /recordDefinition only/);
    assert.throws(() => line.updateNode(d.nodeId, { status: "reviewed" }, "x"), /only through reviewDefinition/);
    assert.equal(memory.definition(INPUT.name)?.status, "unreviewed");
  });

  it("refuses a definition without a test lemma to review, a duplicate name and a short name", () => {
    const memory = open();
    memory.recordDefinition({ ...INPUT, name: "SeshatLib.Foo.noTests", testLemmas: [] });
    assert.throws(() => memory.reviewDefinition("SeshatLib.Foo.noTests", { by: { kind: "human", name: "ana" } }), /no proved test lemma/);
    memory.recordDefinition(INPUT);
    assert.throws(() => memory.recordDefinition(INPUT), /never edited in place/);
    assert.throws(() => memory.recordDefinition({ ...INPUT, name: "SeshatLib.Foo.f" }), /shorter than three/);
    assert.throws(() => memory.recordDefinition({ ...INPUT, name: "not a name" }), /not a dotted Lean name/);
  });

  it("deprecates a wrong definition in a new version without editing it, and records its replacement", async () => {
    const memory = open();
    memory.recordDefinition(INPUT);
    memory.reviewDefinition(INPUT.name, { by: { kind: "human", name: "ana" } });
    assert.throws(() => memory.withActor("line:M3").deprecateDefinition(INPUT.name, { reason: "wrong" }), /view/);
    assert.throws(() => memory.deprecateDefinition(INPUT.name, { reason: " " }), /with a reason/);
    const d = memory.deprecateDefinition(INPUT.name, { reason: "divides by zero wrongly", envHash: "sha256:new", by: "ana" });
    assert.equal(d.status, "deprecated");
    assert.equal(d.deprecated?.envHash, "sha256:new");
    assert.equal(d.name, INPUT.name);
    assert.equal(d.keyword, "def");
    await assert.rejects(memory.ensureClaim({ statement: STATEMENT, origin: "test" }), /deprecated/);
    // The replacement is a new record under the name, unreviewed again.
    const again = memory.recordDefinition({ ...INPUT, buildId: "nod_build2" });
    assert.equal(again.status, "unreviewed");
    assert.equal(memory.definitions().length, 2);
  });
});

describe("mentionsDeclaration", () => {
  it("reads names as Lean does", () => {
    assert.equal(mentionsDeclaration("x = Foo.mulDiv 1 2", "A.Foo.mulDiv"), true);
    assert.equal(mentionsDeclaration("x = mulDiv' 1 2", "A.Foo.mulDiv"), false);
    assert.equal(mentionsDeclaration("x = my_mulDiv 1 2", "A.Foo.mulDiv"), false);
    assert.equal(mentionsDeclaration("/- mulDiv -/ x = 1", "A.Foo.mulDiv"), false);
    assert.equal(mentionsDeclaration("x = (mulDiv)", "A.Foo.mulDiv"), true);
  });
});
