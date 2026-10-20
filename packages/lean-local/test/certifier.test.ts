import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type CertificationRequest, CertifyFailedError, STANDARD_AXIOMS } from "@seshat/core";
import { CERTIFY_PROGRAM, LakeCertifier, type LakeCertifierOptions } from "../src/index.ts";

const FAKE_LAKE = fileURLToPath(new URL("./fixtures/fake-lake.ts", import.meta.url));
const FAKE_SANDBOX = fileURLToPath(new URL("./fixtures/fake-sandbox.ts", import.meta.url));
const NODE = ["--disable-warning=ExperimentalWarning"];

interface Call {
  args: string[];
  cwd: string;
  env: string[];
  request?: { reference: string; candidate: string; target: string; allowedAxioms: string[] };
}

/** A certifier over the fake lake, in a project directory of its own, and what the fake saw. */
function setup(options: Partial<LakeCertifierOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seshat-lean-local-"));
  const project = join(dir, "project");
  const workDir = join(dir, "work");
  mkdirSync(project);
  mkdirSync(workDir);
  const log = join(dir, "calls.jsonl");
  const certifier = new LakeCertifier({
    projectDir: project,
    command: process.execPath,
    args: [...NODE, FAKE_LAKE],
    workDir,
    lean: "v4.27.0",
    ...options,
    env: { FAKE_LAKE_LOG: log, FAKE_LAKE_PIDFILE: join(dir, "child.pid"), ...options.env },
  });
  const calls = (): Call[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as Call)
      : [];
  return { certifier, dir, project, workDir, calls };
}

const REFERENCE = "theorem T : True := by\n  sorry\n";
const request = (candidate: string, extra: Partial<CertificationRequest> = {}): CertificationRequest => ({
  original: REFERENCE,
  candidate: `theorem T : True := by\n  trivial\n${candidate}`,
  target: "T",
  allowedAxioms: STANDARD_AXIOMS,
  ...extra,
});
const marker = (name: string) => `-- fake: ${name}\n`;

async function failure(promise: Promise<unknown>): Promise<CertifyFailedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CertifyFailedError, `expected a CertifyFailedError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "the certification did not fail" });
}

describe("LakeCertifier", () => {
  it("certifies a candidate the program accepts, with the axioms sorted and the work directory removed", async () => {
    const { certifier, project, workDir, calls } = setup();
    const result = await certifier.certify(request(""));
    assert.equal(result.verdict, "certified");
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.axioms, ["Classical.choice", "Quot.sound", "propext"]);
    assert.ok(result.timeMs >= 0);
    assert.deepEqual(readdirSync(workDir), []);

    // The version, the candidate, then the reference, then the program; all in the Lean project.
    const seen = calls();
    assert.deepEqual(seen.map((c) => c.args.slice(0, 4).map((a) => a.replace(/^.*[\\/]/, ""))), [
      ["env", "lean", "--version"],
      ["env", "lean", "-o", "candidate.olean"],
      ["env", "lean", "-o", "reference.olean"],
      ["env", "lean", "--run", "Main.lean"],
    ]);
    for (const call of seen) assert.equal(call.cwd.replace(/^\/private/, ""), project.replace(/^\/private/, ""));
    assert.equal(seen[3]?.args[3], CERTIFY_PROGRAM);
    assert.ok(existsSync(CERTIFY_PROGRAM), "the Lean program is where the certifier looks for it");
  });

  it("gives the program the two object files, the target and the allowed axioms", async () => {
    const { certifier, calls } = setup();
    await certifier.certify(request("", { allowedAxioms: ["propext"], target: "Ns.«odd name»" }));
    const asked = calls()[3]?.request;
    assert.ok(asked !== undefined);
    assert.match(asked.reference, /reference[\\/]reference\.olean$/);
    assert.match(asked.candidate, /candidate[\\/]candidate\.olean$/);
    assert.equal(asked.target, "Ns.«odd name»");
    assert.deepEqual(asked.allowedAxioms, ["propext"]);
  });

  it("rejects a candidate that the program rejects, with the program's reasons", async () => {
    const { certifier } = setup();
    const kernel = await certifier.certify(request(marker("kernel-reject")));
    assert.equal(kernel.verdict, "rejected");
    assert.deepEqual(kernel.reasons, ["the kernel refused the module: (kernel) declaration type mismatch at Foo.bar"]);
    const mismatch = await certifier.certify(request(marker("type-mismatch")));
    assert.equal(mismatch.verdict, "rejected");
    assert.deepEqual(mismatch.reasons, ["T does not state what the reference states"]);
  });

  it("rejects a target that depends on axioms outside the allowed set", async () => {
    const { certifier } = setup();
    const result = await certifier.certify(request(marker("extra-axioms")));
    assert.equal(result.verdict, "rejected");
    assert.deepEqual(result.axioms, ["propext", "sorryAx"]);
    assert.match(result.reasons.join(), /axioms that are not allowed: \[sorryAx\]/);
  });

  it("checks the axioms itself too: a program that certifies a target with an axiom outside the set does not certify it", async () => {
    const { certifier } = setup();
    const result = await certifier.certify(request(marker("lying-certified")));
    assert.equal(result.verdict, "rejected");
    assert.deepEqual(result.reasons, ["T depends on axioms that are not allowed: sorryAx"]);
    assert.deepEqual(result.axioms, ["propext", "sorryAx"]);
  });

  it("rejects a candidate that does not compile, with Lean's errors and no path of the work directory", async () => {
    const { certifier, workDir, calls } = setup();
    const result = await certifier.certify(request(marker("compile-error")));
    assert.equal(result.verdict, "rejected");
    assert.deepEqual(result.reasons, [
      "does not compile: candidate.lean:3:2: error: unknown identifier 'foo'",
      "does not compile: candidate.lean:5:7: error: type mismatch",
    ]);
    assert.deepEqual(result.axioms, []);
    // Nothing else was run: not the reference, not the program.
    assert.equal(calls().length, 2);
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("is not a verdict when the reference does not compile, or the program cannot replay it", async () => {
    const { certifier } = setup();
    const broken = await failure(certifier.certify({ ...request(""), original: `${marker("compile-error")}${REFERENCE}` }));
    assert.equal(broken.reason, "failed");
    assert.match(broken.message, /the reference does not compile: .*reference\.lean:3:2: error/);
    const replay = await failure(certifier.certify({ ...request(""), original: `${marker("program-fails-on-reference")}${REFERENCE}` }));
    assert.equal(replay.reason, "failed");
    assert.match(replay.message, /the replay program ended with code 1: the reference does not declare T/);
  });

  it("is not a verdict when Lean or the program fail in a way that is not the candidate's", async () => {
    const { certifier } = setup();
    const cases: [string, RegExp][] = [
      ["crash", /lean ended with the signal SIGKILL while compiling the candidate/],
      ["exit-3", /lean ended with code 3 while compiling the candidate/],
      ["no-object-file", /lean compiled the candidate and wrote no object file/],
      ["program-crash", /the replay program ended with code 134: Stack overflow detected/],
      ["garbage", /the replay program printed \{"verdict": "certified", "reasons": \[, which is not JSON/],
      ["no-verdict", /the replay program printed no verdict/],
      ["not-a-verdict", /which is not a verdict/],
      ["certified-with-reasons", /certified with reasons against/],
      ["rejected-without-reason", /rejected without a reason/],
    ];
    for (const [name, message] of cases) {
      const error = await failure(certifier.certify(request(marker(name))));
      assert.equal(error.reason, "failed", name);
      assert.match(error.message, message, name);
    }
  });

  it("stops at the time limit and kills what the compile started", async () => {
    const { certifier, dir, workDir } = setup();
    const started = performance.now();
    const error = await failure(certifier.certify(request(marker("hang-with-child")), { timeoutSec: 2 }));
    assert.equal(error.reason, "timeout");
    assert.match(error.message, /longer than its limit of 2 s/);
    assert.ok(performance.now() - started < 15_000, "the limit was kept");
    assert.deepEqual(readdirSync(workDir), []);
    // The grandchild was in the group that was killed.
    const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    await waitUntil(() => !alive(pid));
    assert.equal(alive(pid), false, "the process the compile started is gone");
  });

  it("also times out in the replay, and uses the limit of the constructor when the call gives none", async () => {
    const { certifier } = setup({ timeoutSec: 1 });
    const error = await failure(certifier.certify(request(marker("hang-replay"))));
    assert.equal(error.reason, "timeout");
    assert.match(error.message, /limit of 1 s/);
  });

  it("stops when it is aborted, before or during a call", async () => {
    const { certifier, calls } = setup();
    const before = AbortSignal.abort();
    assert.equal((await failure(certifier.certify(request(""), { signal: before }))).reason, "aborted");
    const controller = new AbortController();
    const pending = failure(certifier.certify(request(marker("hang")), { signal: controller.signal, timeoutSec: 60 }));
    await waitUntil(() => calls().some((c) => c.args[2] === "-o"));
    controller.abort();
    const error = await pending;
    assert.equal(error.reason, "aborted");
  });

  it("is unavailable when lake is not there, or runs another Lean than the pinned one", async () => {
    const missing = setup({ command: "/nonexistent/lake", args: [] });
    const gone = await failure(missing.certifier.certify(request("")));
    assert.equal(gone.reason, "unavailable");
    assert.match(gone.message, /cannot start \/nonexistent\/lake/);
    assert.equal(await missing.certifier.health(), false);

    const other = setup({ env: { FAKE_LAKE_VERSION: "Lean (version 4.26.0, x86_64-unknown-linux-gnu, commit 0123456789ab, Release)" } });
    const wrong = await failure(other.certifier.certify(request("")));
    assert.equal(wrong.reason, "unavailable");
    assert.match(wrong.message, /the pinned version is 4\.27\.0/);
    assert.equal(other.calls().length, 1, "nothing was compiled");
    assert.equal(await other.certifier.health(), false);

    const fine = setup();
    assert.equal(await fine.certifier.health(), true);
  });

  it("runs lake with a few variables of its own and none of the parent's secrets", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    try {
      const { certifier, calls } = setup({ env: { ELAN_HOME: "/opt/elan" } });
      await certifier.certify(request(""));
      for (const call of calls()) {
        assert.ok(call.env.includes("PATH") && call.env.includes("ELAN_HOME") && call.env.includes("FAKE_LAKE_LOG"));
        assert.ok(!call.env.includes("ANTHROPIC_API_KEY"), "a secret of the parent reached the child");
      }
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("puts the sandbox command before every call of lake, with the placeholders filled in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seshat-sandbox-"));
    const sandboxLog = join(dir, "sandbox.jsonl");
    const { certifier, project, workDir, calls } = setup({
      sandbox: [process.execPath, ...NODE, FAKE_SANDBOX, "--bind", "{work}", "--ro-bind", "{project}", "--"],
      env: { FAKE_SANDBOX_LOG: sandboxLog },
    });
    const result = await certifier.certify(request(""));
    assert.equal(result.verdict, "certified");
    const wrapped = readFileSync(sandboxLog, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { args: string[] });
    // The version, two compiles and the replay all went through it.
    assert.equal(wrapped.length, 4);
    assert.equal(calls().length, 4);
    assert.deepEqual(wrapped[0]?.args, ["--bind", workDir, "--ro-bind", project]);
    assert.equal(wrapped[1]?.args[1]?.startsWith(workDir), true, "the work directory of the call, not a placeholder");
    assert.ok(wrapped.every((w) => !w.args.some((a) => a.includes("{"))));
  });

  it("keeps certifications apart when they run together", async () => {
    const { certifier, workDir } = setup();
    const [a, b, c] = await Promise.all([
      certifier.certify(request("")),
      certifier.certify(request(marker("kernel-reject"))),
      certifier.certify(request(marker("type-mismatch"))),
    ]);
    assert.deepEqual([a.verdict, b.verdict, c.verdict], ["certified", "rejected", "rejected"]);
    assert.deepEqual(readdirSync(workDir), []);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition() && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}
