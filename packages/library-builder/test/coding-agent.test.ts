import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type BuildOptions, NoneBuilder, type LibraryBuildResult } from "../src/index.ts";
import { harness, SPEC } from "./fixtures.ts";

const OPTIONS: BuildOptions = { budget: { usd: 2, seconds: 60 }, timeoutSec: 60 };

async function run(scenario: string, spec = SPEC, options: BuildOptions = OPTIONS): Promise<{ result: LibraryBuildResult; h: ReturnType<typeof harness> }> {
  const h = harness();
  const result = await h.builder(scenario).build(spec, options);
  return { result, h };
}

const failedRule = (r: LibraryBuildResult): string | undefined => r.gate.find((c) => !c.ok)?.rule;

describe("the none builder", () => {
  it("builds nothing and says so", async () => {
    const result = await new NoneBuilder().build(SPEC, OPTIONS);
    assert.equal(result.status, "skipped");
    assert.deepEqual(result.files, []);
    assert.match(result.reason, /only recorded/);
    assert.equal(result.provenance.builder, "none");
  });
});

describe("the coding-agent builder and Seshat's gate", () => {
  it("accepts a build that passes every rule and keeps the files, the definitions and the provenance", async () => {
    const { result, h } = await run("good");
    assert.equal(result.status, "accepted", result.reason);
    assert.deepEqual(result.files.map((f) => f.path), ["lean/SeshatLib/Combinatorics/Basic.lean"]);
    assert.deepEqual(result.gate.map((c) => c.rule), ["diff", "content", "spec", "build", "build_output", "certify"]);
    assert.ok(result.gate.every((c) => c.ok));
    assert.deepEqual(result.theorems, ["SeshatLib.Combinatorics.mulDiv_one"]);
    assert.deepEqual(result.definitions, [{ name: "SeshatLib.Combinatorics.mulDiv", keyword: "def", module: "SeshatLib.Combinatorics.Basic", testLemmas: ["mulDiv_one"] }]);
    assert.match(result.diff, /^diff --git a\/lean\/SeshatLib\/Combinatorics\/Basic\.lean/m);
    assert.match(result.diff, /\+def mulDiv/);
    assert.equal(result.needsApproval, false);
    // A fresh checkout was built, with the module named after the file, and the certifier ran there.
    assert.deepEqual(h.commands, ["lake build SeshatLib.Combinatorics.Basic (in " + h.commands[0]?.match(/\(in (.*)\)$/)?.[1] + ")"]);
    assert.equal(h.certifier.calls.length, 1);
    assert.match(h.certifier.projectDirs[0] as string, /seshat-build-.*\/seshat-gate-.*\/checkout/);
    const p = result.provenance;
    assert.equal(p.builder, "coding-agent");
    assert.equal(p.agent, "pi");
    assert.match(p.baseCommit ?? "", /^[0-9a-f]{40}$/);
    assert.match(p.prompt ?? "", /Add files only under lean\/SeshatLib\/Combinatorics\//);
    assert.match(p.prompt ?? "", /theorem mulDiv_one \(n : Nat\) : mulDiv n 1 = n/);
    assert.match(p.promptHash ?? "", /^sha256:/);
    assert.deepEqual(p.budget, { usd: 2, seconds: 60 });
  });

  it("judges the files and not the agent's exit code or its git directory", async () => {
    assert.equal((await run("good_exit1")).result.status, "accepted");
    assert.equal((await run("ignore_git")).result.status, "accepted");
  });

  it("removes its clones when it is done", async () => {
    const work = mkdtempSync(join(tmpdir(), "mh-lb-work-"));
    const h = harness();
    await h.builder("good", { workRoot: work }).build(SPEC, OPTIONS);
    assert.deepEqual(readdirSync(work), []);
  });

  it("rejects a diff that goes outside the spec's directory", async () => {
    const { result } = await run("outside");
    assert.equal(result.status, "rejected");
    assert.equal(failedRule(result), "diff");
    assert.match(result.reason, /lean\/Other\/Elsewhere\.lean: outside lean\/SeshatLib\/Combinatorics\//);
    assert.deepEqual(result.files, []);
  });

  it("rejects a change to an existing file, a deletion and a link", async () => {
    const modify = await run("modify");
    assert.match(modify.result.reason, /lakefile\.toml: an existing file was modified/);
    const del = await run("delete");
    assert.match(del.result.reason, /Base\.lean: an existing file was deleted/);
    const link = await run("symlink");
    assert.match(link.result.reason, /Link\.lean: not a regular file/);
    for (const r of [modify, del, link]) {
      assert.equal(r.result.status, "rejected");
      assert.equal(r.h.certifier.calls.length, 0);
      assert.equal(r.h.commands.length, 0, "nothing is built for a diff that breaks the rules");
    }
  });

  it("rejects a file at the repository's root, a path that could not stay inside", async () => {
    const { result } = await run("traversal");
    assert.match(result.reason, /escape\.lean: outside/);
  });

  it("rejects sorry, an axiom and code that runs at elaboration, before any build", async () => {
    for (const [scenario, pattern] of [["sorry", /sorry is not allowed/], ["axiom", /axiom is not allowed/], ["elab", /elab is not allowed in a fill/], ["import_lean", /imports Lean, which the spec does not allow/]] as const) {
      const { result, h } = await run(scenario);
      assert.equal(result.status, "rejected", scenario);
      assert.equal(failedRule(result), scenario === "import_lean" ? "content" : "content");
      assert.match(result.reason, pattern, scenario);
      assert.equal(h.commands.length, 0, `${scenario}: no build`);
    }
  });

  it("rejects work that lacks a test lemma of the spec", async () => {
    const { result } = await run("no_test_lemma");
    assert.equal(failedRule(result), "spec");
    assert.match(result.reason, /missing from the new files: test lemma mulDiv_one/);
  });

  it("rejects a test lemma that states something other than the spec's statement of it", async () => {
    const { result, h } = await run("weak_test_lemma");
    assert.equal(result.status, "rejected");
    assert.equal(failedRule(result), "certify");
    assert.match(result.reason, /mulDiv_one \(a test lemma, against the spec's statement\) was rejected: the statement is not the reference's/);
    // The reference the certifier was given carries the spec's statement, not the agent's.
    const request = h.certifier.calls[0];
    assert.match(request?.original ?? "", /theorem mulDiv_one \(n : Nat\) : mulDiv n 1 = n := by sorry/);
    assert.match(request?.candidate ?? "", /mulDiv n 1 = n ∨ n = 0/);
  });

  it("rejects a build that fails, and one whose output reports sorry", async () => {
    const fail = await run("buildfail");
    assert.equal(fail.result.status, "rejected");
    assert.equal(failedRule(fail.result), "build");
    assert.match(fail.result.reason, /exited with 1/);
    assert.equal(fail.h.certifier.calls.length, 0);
    const warns = await run("build_warns_sorry");
    assert.equal(failedRule(warns.result), "build_output");
  });

  it("rejects when the certifier rejects any new theorem, even one the spec does not list", async () => {
    const { result, h } = await run("certfail");
    assert.equal(result.status, "rejected");
    assert.equal(failedRule(result), "certify");
    assert.match(result.reason, /extra_fact was rejected: the kernel refuses/);
    assert.ok(h.certifier.calls.length >= 2);
  });

  it("is undecided, not rejected, when the certifier gives no verdict", async () => {
    const { result } = await run("cert_unavailable");
    assert.equal(result.status, "failed");
    assert.match(result.reason, /could not decide at certify: .*no verdict \(unavailable\)/);
  });

  it("fails, and rejects nothing, when the agent changes nothing, times out or is aborted", async () => {
    const nothing = await run("nothing");
    assert.equal(nothing.result.status, "rejected");
    assert.match(nothing.result.reason, /the agent changed nothing/);
    const hang = await run("hang", SPEC, { budget: { seconds: 0.4 }, timeoutSec: 1 });
    assert.equal(hang.result.status, "failed");
    assert.match(hang.result.reason, /did not finish within 0.4 seconds/);
    assert.equal(hang.h.certifier.calls.length, 0);
    const controller = new AbortController();
    const h = harness();
    const pending = h.builder("hang").build(SPEC, { ...OPTIONS, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    assert.match((await pending).reason, /aborted/);
  });

  it("refuses a spec with no test lemma for a definition, without starting the agent", async () => {
    const { result } = await run("good", { ...SPEC, testLemmas: [] });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /the definition mulDiv has no test lemma/);
    assert.equal(result.provenance.command, undefined);
  });

  it("gives the agent a prompt on standard input, only the environment the settings name, and a home of its own", async () => {
    process.env.HARNESS_SECRET_KEY = "do-not-leak";
    try {
      const h = harness();
      const result = await h.builder("good", {}, { env: { FAKE_SCENARIO: "good", AGENT_API_KEY: "k" }, model: "m-1" }).build(SPEC, OPTIONS);
      const out = result.provenance.agentOutput ?? "";
      const keys = /env keys: (.*)/.exec(out)?.[1]?.split(",") ?? [];
      assert.deepEqual(keys.filter((k) => !["PATH", "HOME", "TMPDIR", "FAKE_SCENARIO", "AGENT_API_KEY", "PWD", "SHLVL", "_", "OLDPWD"].includes(k)), []);
      assert.ok(keys.includes("AGENT_API_KEY"));
      assert.ok(!out.includes("do-not-leak") && !keys.includes("HARNESS_SECRET_KEY"));
      assert.deepEqual(result.provenance.envKeys, ["AGENT_API_KEY", "FAKE_SCENARIO", "HOME", "PATH", "TMPDIR"]);
      assert.ok(!JSON.stringify(result.provenance).includes("\"k\""), "values are not recorded");
      assert.match(out, /prompt bytes: [1-9]/);
    } finally {
      delete process.env.HARNESS_SECRET_KEY;
    }
  });

  it("will not start without a sandbox or an explicit opt-out", () => {
    assert.throws(() => harness().builder("good", {}, { unsandboxed: false }), /needs a sandbox command/);
    assert.ok(harness().builder("good", {}, { unsandboxed: false, sandbox: ["bwrap", "--ro-bind", "/", "/"] }));
  });

  it("does not touch the project it was given", async () => {
    const h = harness();
    await h.builder("good").build(SPEC, OPTIONS);
    assert.ok(!existsSync(join(h.repo, "lean/SeshatLib/Combinatorics")));
  });
});
