import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { hashDirectory } from "@seshat/lean-env";
import { MemoryStore } from "@seshat/memory";
import {
  adoptBuild,
  BUILD_KIND,
  type Gap,
  GapTracker,
  NoneBuilder,
  openGaps,
  processGaps,
  recordBuild,
  recordGap,
  unknownIdentifiers,
} from "../src/index.ts";
import { harness, SPEC } from "./fixtures.ts";

function memory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-lb-mem-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_lb"), blobs: new BlobStore(join(dir, "blobs")) });
}

const OPTIONS = { budget: { usd: 1, seconds: 60 }, timeoutSec: 60 };

describe("the journal record of a build", () => {
  it("holds the agent, model, budget, prompt, diff and gate results, and the definitions unreviewed", async () => {
    const h = harness();
    const result = await h.builder("good", {}, { model: "m-1", env: { FAKE_SCENARIO: "good", AGENT_API_KEY: "sekret" } }).build(SPEC, OPTIONS);
    const m = memory();
    const { node, definitions } = recordBuild(m, result, { envHash: "sha256:env1" });
    const data = node.data as Record<string, any>;
    assert.equal(node.kind, BUILD_KIND);
    assert.equal(data.status, "accepted");
    assert.equal(data.agent, "pi");
    assert.equal(data.model, "m-1");
    assert.deepEqual(data.budget, { usd: 1, seconds: 60 });
    assert.equal(data.baseCommit, result.provenance.baseCommit);
    assert.equal(m.blobs.get(data.promptBlob), result.provenance.prompt);
    assert.match(m.blobs.get(data.diffBlob) ?? "", /\+def mulDiv/);
    assert.deepEqual(data.gate.map((c: { rule: string; ok: boolean }) => `${c.rule}:${c.ok}`), ["diff:true", "content:true", "spec:true", "build:true", "build_output:true", "certify:true"]);
    assert.deepEqual(data.files.map((f: { path: string }) => f.path), ["lean/SeshatLib/Combinatorics/Basic.lean"]);
    assert.ok(!JSON.stringify(data).includes("sekret"), "the agent's secrets are not in the journal");
    assert.deepEqual(definitions, ["SeshatLib.Combinatorics.mulDiv"]);
    const def = m.definition("SeshatLib.Combinatorics.mulDiv");
    assert.equal(def?.status, "unreviewed");
    assert.equal(def?.buildId, node.nodeId);
    assert.equal(def?.envHash, "sha256:env1");
  });

  it("lets a proof use the definition and keeps it out of a claim statement until a person reviews it", async () => {
    const h = harness();
    const m = memory();
    recordBuild(m, await h.builder("good").build(SPEC, OPTIONS));
    // A claim about the definition is refused; a claim that does not use it is not.
    await assert.rejects(m.ensureClaim({ statement: "(n : Nat) : SeshatLib.Combinatorics.mulDiv n 1 = n", origin: "line:M3" }), /unreviewed/);
    await assert.rejects(m.ensureClaim({ statement: "(n : Nat) : mulDiv n 1 = n", header: "import Mathlib\nopen SeshatLib.Combinatorics", origin: "line:M3" }), /unreviewed/);
    assert.equal((await m.ensureClaim({ statement: "(n : Nat) : n + 0 = n", origin: "line:M3" })).created, true);
    // Its proof is just Lean text: nothing in the memory refuses a submission that names it (the kernel checks it).
    m.reviewDefinition("SeshatLib.Combinatorics.mulDiv", { by: { kind: "human", name: "ana" } });
    assert.equal((await m.ensureClaim({ statement: "(n : Nat) : mulDiv n 1 = n", header: "import Mathlib\nopen SeshatLib.Combinatorics", origin: "line:M3" })).created, true);
  });

  it("records a rejected build with its reasons and no definition", async () => {
    const h = harness();
    const m = memory();
    const result = await h.builder("sorry").build(SPEC, OPTIONS);
    const { node, definitions } = recordBuild(m, result);
    assert.equal((node.data as Record<string, unknown>).status, "rejected");
    assert.match(String((node.data as { reason: string }).reason), /sorry is not allowed/);
    assert.deepEqual(definitions, []);
    assert.equal(m.definitions().length, 0);
  });

  it("is a record only: no claim is created and no status moves", async () => {
    const h = harness();
    const m = memory();
    recordBuild(m, await h.builder("good").build(SPEC, OPTIONS));
    assert.equal(m.claims().length, 0);
  });
});

describe("adopting a build between runs", () => {
  it("lands the files, which gives the library another hash, and never during a run", async () => {
    const h = harness();
    const result = await h.builder("good").build(SPEC, OPTIONS);
    const root = mkdtempSync(join(tmpdir(), "mh-lb-adopt-"));
    const libDir = join(root, "lean/SeshatLib");
    await import("node:fs").then((fs) => fs.mkdirSync(libDir, { recursive: true }));
    const before = hashDirectory(libDir);
    assert.throws(() => adoptBuild(result, { root, runActive: () => true }), /a run is going/);
    assert.ok(!existsSync(join(libDir, "Combinatorics")), "nothing landed while a run was going");
    const written = adoptBuild(result, { root, runActive: () => false });
    assert.deepEqual(written, [join(root, "lean/SeshatLib/Combinatorics/Basic.lean")]);
    assert.equal(readFileSync(written[0] as string, "utf8"), result.files[0]?.content);
    assert.notEqual(hashDirectory(libDir), before);
    // Again: same content is a no-op; other content is an edit in place and refused.
    assert.deepEqual(adoptBuild(result, { root, runActive: () => false }), []);
    const edited = { ...result, files: [{ path: result.files[0]!.path, content: "import Mathlib\n" }] };
    assert.throws(() => adoptBuild(edited, { root, runActive: () => false }), /never edited in place/);
  });

  it("lands nothing of a build that was not accepted", async () => {
    const h = harness();
    const result = await h.builder("sorry").build(SPEC, OPTIONS);
    assert.throws(() => adoptBuild(result, { root: tmpdir(), runActive: () => false }), /is rejected, not accepted/);
  });
});

describe("the triggers", () => {
  it("reads unknown identifiers from Lean's messages", () => {
    assert.deepEqual(unknownIdentifiers(["unknown identifier 'Nat.fooBar'", "unknown constant 'baz'", "type mismatch"]), ["Nat.fooBar", "baz"]);
  });

  it("raises a gap when distinct attempts show the same unknown identifier often enough, once", () => {
    const t = new GapTracker({ unknownIdentifier: 3 });
    assert.deepEqual(t.observeFailure({ attemptId: "a1", messages: ["unknown identifier 'mulDiv'"] }), []);
    assert.deepEqual(t.observeFailure({ attemptId: "a1", messages: ["unknown identifier 'mulDiv'"] }), [], "the same attempt twice counts once");
    assert.deepEqual(t.observeFailure({ attemptId: "a2", messages: ["unknown identifier 'mulDiv'"] }), []);
    const gaps = t.observeFailure({ attemptId: "a3", messages: ["unknown identifier 'mulDiv'"] });
    assert.equal(gaps.length, 1);
    assert.deepEqual({ trigger: gaps[0]?.trigger, concept: gaps[0]?.concept, job: gaps[0]?.job, count: gaps[0]?.count }, { trigger: "unknown_identifier", concept: "mulDiv", job: "fill", count: 3 });
    assert.deepEqual(t.observeFailure({ attemptId: "a4", messages: ["unknown identifier 'mulDiv'"] }), [], "raised once");
  });

  it("raises a gap at once for a lemma a prover asks for, and for a standard subgoal left open in two problems", () => {
    const t = new GapTracker();
    assert.equal(t.observeRequest({ attemptId: "a1", concept: "  a   lemma on mulDiv " })?.concept, "a lemma on mulDiv");
    assert.equal(t.observeRequest({ attemptId: "a2", concept: "a lemma on mulDiv" }), undefined);
    assert.equal(t.observeSubgoal({ problemId: "p1", goal: "a ∣ b", closed: false, standard: true }), undefined);
    assert.equal(t.observeSubgoal({ problemId: "p2", goal: "a  ∣ b", closed: true, standard: true }), undefined, "a closed subgoal is no gap");
    assert.equal(t.observeSubgoal({ problemId: "p2", goal: "a ∣ b", closed: false, standard: false }), undefined, "not a standard-looking one");
    assert.equal(t.observeSubgoal({ problemId: "p2", goal: "a  ∣ b", closed: false, standard: true })?.trigger, "unsolved_subgoal");
  });

  it("raises a port for a package with no compatible tag", () => {
    const gap = new GapTracker().observePackage({ name: "Foo", reason: "no tag v4.27.0" });
    assert.deepEqual({ trigger: gap?.trigger, job: gap?.job }, { trigger: "no_compatible_tag", job: "port" });
  });
});

describe("gaps and the service", () => {
  const gap: Gap = { trigger: "prover_request", concept: "mulDiv", job: "fill", count: 1, evidence: [] };

  it("records a gap once, and with the none builder builds nothing", async () => {
    const m = memory();
    assert.equal(recordGap(m, gap).created, true);
    assert.equal(recordGap(m, gap).created, false);
    assert.equal(openGaps(m).length, 1);
    let asked = 0;
    const results = await processGaps({ builder: new NoneBuilder(), memory: m, specFor: async () => (asked++, SPEC), build: OPTIONS, runActive: () => false });
    assert.deepEqual(results, []);
    assert.equal(asked, 0);
    assert.equal(openGaps(m).length, 1);
  });

  it("builds an open gap that has a spec, journals it, and closes the gap only when the build is accepted", async () => {
    const m = memory();
    recordGap(m, gap);
    const h = harness();
    const specFor = async () => SPEC;
    const rejected = await processGaps({ builder: h.builder("sorry"), memory: m, specFor, build: OPTIONS, runActive: () => false });
    assert.equal(rejected[0]?.status, "rejected");
    assert.equal(openGaps(m).length, 1, "a rejected build leaves the gap open");
    const accepted = await processGaps({ builder: h.builder("good"), memory: m, specFor, build: OPTIONS, runActive: () => false });
    assert.equal(accepted[0]?.status, "accepted");
    assert.equal(openGaps(m).length, 0);
    assert.equal(m.nodes(BUILD_KIND).length, 2);
    assert.equal(m.definition("SeshatLib.Combinatorics.mulDiv")?.status, "unreviewed");
  });

  it("leaves a gap open when nobody gives it a spec, and starts nothing during a run", async () => {
    const m = memory();
    recordGap(m, gap);
    const h = harness();
    assert.deepEqual(await processGaps({ builder: h.builder("good"), memory: m, specFor: async () => undefined, build: OPTIONS, runActive: () => false }), []);
    await assert.rejects(processGaps({ builder: h.builder("good"), memory: m, specFor: async () => SPEC, build: OPTIONS, runActive: () => true }), /a run is going/);
    assert.equal(h.commands.length, 0);
  });
});
