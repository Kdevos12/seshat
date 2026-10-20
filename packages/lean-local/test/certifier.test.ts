import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type CertificationRequest, CertifyFailedError, STANDARD_AXIOMS } from "@seshat/core";
import { CERTIFY_PROGRAM, LakeCertifier, type LakeCertifierOptions, nameComponents } from "../src/index.ts";

const FAKE_LAKE = fileURLToPath(new URL("./fixtures/fake-lake.ts", import.meta.url));
const FAKE_SANDBOX = fileURLToPath(new URL("./fixtures/fake-sandbox.ts", import.meta.url));
const NODE = ["--disable-warning=ExperimentalWarning"];

interface Call {
  args: string[];
  cwd: string;
  env: string[];
  request?: { reference: string; candidate: string; target: string[]; allowedAxioms: string[][] };
  /** The file a compile (`-o`) read. */
  source?: string;
  /** The program a replay (`--run`) read. */
  program?: string;
  values: { tmpdir?: string; home?: string };
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
    // The tests that look at the sandbox give their own.
    ...(options.sandbox === undefined ? { unsandboxed: true } : {}),
    ...options,
    env: { FAKE_LAKE_LOG: log, FAKE_LAKE_PIDFILE: join(dir, "child.pid"), FAKE_LAKE_VERSION_PIDFILE: join(dir, "version.pid"), ...options.env },
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
    // The program is the repository's, as the certifier read it when it was made, in the directory of the replay.
    assert.match(seen[3]?.args[3] ?? "", /replay-[^\\/]+[\\/]Main\.lean$/);
    assert.equal(seen[3]?.program, readFileSync(CERTIFY_PROGRAM, "utf8"));
  });

  it("gives the program the two object files, the target and the allowed axioms", async () => {
    const { certifier, calls } = setup();
    await certifier.certify(request("", { allowedAxioms: ["propext"], target: "Ns.«odd name»" }));
    const asked = calls()[3]?.request;
    assert.ok(asked !== undefined);
    // Copies, in the directory of the replay, so that the replay needs nothing else that a compile wrote.
    assert.match(asked.reference, /replay-[^\\/]+[\\/]reference\.olean$/);
    assert.match(asked.candidate, /replay-[^\\/]+[\\/]candidate\.olean$/);
    assert.deepEqual(asked.target, ["Ns", "odd name"]);
    assert.deepEqual(asked.allowedAxioms, [["propext"]]);
  });

  describe("names", () => {
    it("are split at the dots outside «», with the guillemets taken off", () => {
      const cases: [string, string[]][] = [
        ["T", ["T"]],
        ["Demo.add_zero'", ["Demo", "add_zero'"]],
        ["Classical.choice", ["Classical", "choice"]],
        ["Arxiv.«1609.08688».maximalLength_le", ["Arxiv", "1609.08688", "maximalLength_le"]],
        ["A.«odd name_negation»", ["A", "odd name_negation"]],
        ["«A.B».c", ["A.B", "c"]],
        ["«propext»", ["propext"]],
        ["ErdosProblems.«125».erdos_125", ["ErdosProblems", "125", "erdos_125"]],
      ];
      for (const [name, parts] of cases) assert.deepEqual(nameComponents(name), parts, name);
      for (const bad of ["", "a..b", ".a", "a.", "«open", "a.«b", "«»"]) {
        assert.throws(() => nameComponents(bad), /empty component|never closes/, JSON.stringify(bad));
      }
    });

    it("reach the program as components, as bench names and negation names need", async () => {
      const { certifier, calls } = setup();
      const targets = ["Arxiv.«1609.08688».maximalLength_le", "A.«odd name_negation»"];
      for (const target of targets) await certifier.certify(request("", { target, allowedAxioms: ["Classical.choice", "A.«odd axiom»"] }));
      const asked = calls().flatMap((c) => (c.request === undefined ? [] : [c.request]));
      assert.deepEqual(asked.map((r) => r.target), [["Arxiv", "1609.08688", "maximalLength_le"], ["A", "odd name_negation"]]);
      assert.deepEqual(asked[0]?.allowedAxioms, [["Classical", "choice"], ["A", "odd axiom"]]);
    });

    it("are refused before anything runs when they are not Lean names", async () => {
      const { certifier, calls } = setup();
      for (const target of ["a..b", "«open", ""]) {
        const error = await failure(certifier.certify(request("", { target })));
        assert.equal(error.reason, "failed", target);
        assert.match(error.message, /something that is not a Lean name/, target);
      }
      const axiom = await failure(certifier.certify(request("", { allowedAxioms: ["propext", "Classical..choice"] })));
      assert.match(axiom.message, /not a Lean name/);
      assert.deepEqual(calls(), [], "not even the version was asked");
    });

    it("are compared as names when the axioms are checked, however they are spelled", async () => {
      const { certifier } = setup();
      // The program prints Classical.choice, Quot.sound and propext; the request spells them with «».
      const spelled = await certifier.certify(request("", { allowedAxioms: ["«Classical».choice", "Quot.«sound»", "«propext»"] }));
      assert.equal(spelled.verdict, "certified");
      assert.deepEqual(spelled.reasons, []);
    });
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
    // The reference was compiled as well, to see that the errors are the candidate's; the program was not run.
    assert.deepEqual(calls().map((c) => c.args[2]), ["--version", "-o", "-o"]);
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("does not blame the candidate when Lean cannot compile the reference either: a broken environment is no verdict", async () => {
    // An unbuilt project, or the wrong checkout: Lean ends with 1 for the import errors of every file.
    const { certifier, workDir, calls } = setup({ env: { FAKE_LAKE_BROKEN_IMPORTS: "1" } });
    const error = await failure(certifier.certify(request("")));
    assert.equal(error.reason, "failed");
    assert.match(error.message, /neither the candidate nor the reference compiles/);
    assert.match(error.message, /unknown module prefix 'FormalConjectures'/);
    assert.match(error.message, /Lean environment/);
    // The reference was compiled after the candidate's process had ended; the program was not run.
    assert.deepEqual(calls().map((c) => c.args[2]), ["--version", "-o", "-o"]);
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("still rejects a candidate with errors when the reference compiles", async () => {
    const { certifier, calls } = setup();
    const result = await certifier.certify(request(marker("compile-error")));
    assert.equal(result.verdict, "rejected");
    assert.deepEqual(
      calls().filter((c) => c.args[2] === "-o").map((c) => c.args[4]?.replace(/^.*[\\/]/, "")),
      ["candidate.lean", "reference.lean"],
    );
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
      // What the program does with an exception that is not a refusal of the candidate's (an object file it cannot read).
      ["unreadable-object", /the replay program ended with code 1: seshat-certify: failed to read file/],
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
    const down = await missing.certifier.health();
    assert.equal(down.ok, false);
    assert.match(down.detail, /cannot start \/nonexistent\/lake/);

    const other = setup({ env: { FAKE_LAKE_VERSION: "Lean (version 4.26.0, x86_64-unknown-linux-gnu, commit 0123456789ab, Release)" } });
    const wrong = await failure(other.certifier.certify(request("")));
    assert.equal(wrong.reason, "unavailable");
    assert.match(wrong.message, /the pinned version is 4\.27\.0/);
    assert.equal(other.calls().length, 1, "nothing was compiled");
    const mismatch = await other.certifier.health();
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.detail, /the pinned version is 4\.27\.0/);

    const fine = setup();
    const up = await fine.certifier.health();
    assert.equal(up.ok, true);
    assert.match(up.detail, /version 4\.27\.0/);
  });

  describe("the probe", () => {
    const PROBE = "import FormalConjectures.Util.ProblemImports";

    it("is compiled once, after the version check, and not again for the certifications that follow", async () => {
      const { certifier, workDir, calls } = setup({ probe: PROBE });
      const up = await certifier.health();
      assert.equal(up.ok, true);
      assert.match(up.detail, /probe/);
      await certifier.certify(request(""));
      await certifier.certify(request(""));
      const seen = calls();
      assert.deepEqual(seen.map((c) => c.args.slice(2, 5).map((a) => a.replace(/^.*[\\/]/, ""))).slice(0, 3), [
        ["--version"],
        ["-o", "probe.olean", "probe.lean"],
        ["-o", "candidate.olean", "candidate.lean"],
      ]);
      assert.equal(seen[1]?.source, `${PROBE}\n`, "the probe file holds the import");
      assert.equal(seen.filter((c) => c.args[2] === "--version").length, 1);
      assert.equal(seen.filter((c) => c.args.some((a) => a.endsWith("probe.lean"))).length, 1);
      assert.deepEqual(readdirSync(workDir), [], "the probe's directory is removed");
    });

    it("makes the health check say why the project cannot be used, and keeps certifications from compiling candidates against it", async () => {
      const { certifier, workDir, calls } = setup({ probe: PROBE, env: { FAKE_LAKE_BROKEN_IMPORTS: "1" } });
      const down = await certifier.health();
      assert.equal(down.ok, false);
      assert.match(down.detail, /cannot compile the probe file \(import FormalConjectures\.Util\.ProblemImports\)/);
      assert.match(down.detail, /unknown module prefix 'FormalConjectures'/);
      const error = await failure(certifier.certify(request("")));
      assert.equal(error.reason, "unavailable");
      assert.match(error.message, /unknown module prefix 'FormalConjectures'/);
      // No candidate was compiled, and the failure is not kept: the second call looked again.
      const compiles = calls().filter((c) => c.args[2] === "-o");
      assert.equal(compiles.length, 2);
      assert.ok(compiles.every((c) => c.args[4]?.endsWith("probe.lean")));
      assert.deepEqual(readdirSync(workDir), []);
    });

    it("is the pinned Lean's to compile: another version is refused before the probe is made", async () => {
      const { certifier, calls } = setup({ probe: PROBE, env: { FAKE_LAKE_VERSION: "Lean (version 4.26.0, x86_64-unknown-linux-gnu, commit 0123456789ab, Release)" } });
      const down = await certifier.health();
      assert.equal(down.ok, false);
      assert.deepEqual(calls().map((c) => c.args[2]), ["--version"]);
    });
  });

  describe("an abort during the version check", () => {
    it("ends the certification at once, and kills the version process", { timeout: 20_000 }, async () => {
      const { certifier, dir } = setup({ env: { FAKE_LAKE_HANG_VERSION: "1" } });
      const controller = new AbortController();
      const pending = failure(certifier.certify(request(""), { signal: controller.signal }));
      await waitUntil(() => existsSync(join(dir, "version.pid")));
      const pid = Number(readFileSync(join(dir, "version.pid"), "utf8"));
      assert.ok(alive(pid), "the version check is running");
      const aborted = performance.now();
      controller.abort();
      const error = await pending;
      assert.equal(error.reason, "aborted");
      assert.ok(performance.now() - aborted < 5_000, "the abort was not left waiting for the version check's own limit");
      await waitUntil(() => !alive(pid));
      assert.equal(alive(pid), false, "the version process is gone");
    });

    it("also stops the health check, which says it was aborted", { timeout: 20_000 }, async () => {
      const { certifier, dir } = setup({ env: { FAKE_LAKE_HANG_VERSION: "1" } });
      const controller = new AbortController();
      const pending = certifier.health(controller.signal);
      await waitUntil(() => existsSync(join(dir, "version.pid")));
      const pid = Number(readFileSync(join(dir, "version.pid"), "utf8"));
      const aborted = performance.now();
      controller.abort();
      const down = await pending;
      assert.equal(down.ok, false);
      assert.match(down.detail, /aborted/);
      assert.ok(performance.now() - aborted < 5_000);
      await waitUntil(() => !alive(pid));
      assert.equal(alive(pid), false);
    });

    it("does not stop the check that another certification waits for", { timeout: 20_000 }, async () => {
      const { certifier, calls } = setup({ env: { FAKE_LAKE_VERSION_DELAY_MS: "1500" } });
      const controller = new AbortController();
      const first = failure(certifier.certify(request(""), { signal: controller.signal }));
      const second = certifier.certify(request(""));
      await waitUntil(() => calls().some((c) => c.args[2] === "--version"));
      const aborted = performance.now();
      controller.abort();
      assert.equal((await first).reason, "aborted");
      assert.ok(performance.now() - aborted < 1_000, "the first certification did not wait for the check");
      assert.equal((await second).verdict, "certified");
      assert.equal(calls().filter((c) => c.args[2] === "--version").length, 1, "one check served the one that stayed");
    });

    it("starts a new check after the only one that waited has gone", { timeout: 20_000 }, async () => {
      const { certifier, calls, dir } = setup({ env: { FAKE_LAKE_VERSION_DELAY_MS: "800" } });
      const controller = new AbortController();
      const first = failure(certifier.certify(request(""), { signal: controller.signal }));
      await waitUntil(() => existsSync(join(dir, "version.pid")));
      controller.abort();
      assert.equal((await first).reason, "aborted");
      const result = await certifier.certify(request(""));
      assert.equal(result.verdict, "certified");
      assert.equal(calls().filter((c) => c.args[2] === "--version").length, 2, "the stopped check was not reused");
    });
  });

  it("gives the child a minimal environment: the path, the home elan needs, a temporary directory of its own, the settings' variables", async () => {
    // What the harness's own environment holds that the child must not get.
    const parent = {
      ANTHROPIC_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp-secret",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONFIG: "/home/parent/.docker",
      LD_PRELOAD: "/tmp/evil.so",
      HOME: "/home/parent",
    };
    const saved = Object.fromEntries(Object.keys(parent).map((name) => [name, process.env[name]]));
    Object.assign(process.env, parent);
    try {
      const { certifier, calls, workDir } = setup({ env: { OWN: "1" } });
      await certifier.certify(request(""));
      const seen = calls();
      assert.equal(seen.length, 4);
      for (const call of seen) {
        // Exactly these, for every process of a certification.
        assert.deepEqual(call.env, ["FAKE_LAKE_LOG", "FAKE_LAKE_PIDFILE", "FAKE_LAKE_VERSION_PIDFILE", "HOME", "OWN", "PATH", "TMPDIR"]);
        assert.equal(call.values.home, "/home/parent", "elan looks for its toolchains in $HOME/.elan when ELAN_HOME says nothing");
        assert.ok(call.values.tmpdir?.startsWith(`${workDir}${sep}`), "the temporary directory is one of the certifier's");
      }
      assert.equal(new Set(seen.map((c) => c.values.tmpdir)).size, 4, "each process has a temporary directory of its own");

      // With an ELAN_HOME of the settings, elan needs no home.
      const elan = setup({ env: { ELAN_HOME: "/opt/elan" } });
      await elan.certifier.certify(request(""));
      for (const call of elan.calls()) {
        assert.deepEqual(call.env, ["ELAN_HOME", "FAKE_LAKE_LOG", "FAKE_LAKE_PIDFILE", "FAKE_LAKE_VERSION_PIDFILE", "PATH", "TMPDIR"]);
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("puts the sandbox command before every call of lake, each with a directory of its own for {work}", async () => {
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
    assert.ok(wrapped.every((w) => w.args[0] === "--bind" && w.args[2] === "--ro-bind" && w.args[3] === project));
    assert.ok(wrapped.every((w) => !w.args.some((a) => a.includes("{"))));
    // {work} is the directory of the call alone: one for the version check, and for the candidate's compile,
    // the reference's and the replay, one each inside the certification's, none inside another.
    const dirs = wrapped.map((w) => w.args[1] as string);
    assert.deepEqual(dirs.map((d) => basename(d).replace(/-[^-]*$/, "")), ["seshat-check", "candidate", "reference", "replay"]);
    assert.ok(dirs.every((d) => d.startsWith(`${workDir}${sep}`)));
    for (const a of dirs) for (const b of dirs) assert.ok(a === b || !b.startsWith(`${a}${sep}`), `${b} is inside ${a}`);
    assert.equal(new Set(dirs).size, 4);
  });

  describe("what the candidate's compile can write", () => {
    /** A certifier whose sandbox lets the compile write in {work} only, as the fake sandbox says to the fake lake. */
    const sandboxed = (env: Record<string, string> = {}) =>
      setup({ sandbox: [process.execPath, ...NODE, FAKE_SANDBOX, "--bind", "{work}", "--ro-bind", "{project}", "--"], env });

    it("cannot make request.json a pipe that the certification would wait on for ever", { timeout: 15_000 }, async () => {
      const { certifier, workDir } = sandboxed();
      const result = await certifier.certify(request(marker("plant-fifo")), { timeoutSec: 10 });
      assert.equal(result.verdict, "certified");
      assert.deepEqual(readdirSync(workDir), []);
    });

    it("cannot make the directory of the reference exist before the certifier does", { timeout: 15_000 }, async () => {
      const { certifier, workDir } = sandboxed();
      const result = await certifier.certify(request(marker("plant-dir")), { timeoutSec: 10 });
      assert.equal(result.verdict, "certified");
      assert.deepEqual(readdirSync(workDir), []);
    });
  });

  it("replays with the program it read when it was made, whatever a compile did to the file since", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seshat-program-"));
    const program = join(dir, "Main.lean");
    copyFileSync(CERTIFY_PROGRAM, program);
    const original = readFileSync(program, "utf8");
    const { certifier, calls } = setup({ program, env: { FAKE_LAKE_TAMPER: program } });
    assert.equal((await certifier.certify(request(marker("tamper-program")))).verdict, "certified");
    assert.match(readFileSync(program, "utf8"), /^-- tampered/, "the compile rewrote the file");
    assert.equal((await certifier.certify(request(""))).verdict, "certified");
    const runs = calls().filter((c) => c.args[2] === "--run");
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(run.program, original, "the replay ran the program as it was read");
  });

  it("is not a verdict when the object file is a link, not a file the compile wrote", async () => {
    const { certifier } = setup();
    const error = await failure(certifier.certify(request(marker("symlink-object"))));
    assert.equal(error.reason, "failed");
    assert.match(error.message, /wrote no object file/);
  });

  describe("without a sandbox", () => {
    const base = { projectDir: tmpdir(), command: "lake" };

    it("is not made unless the options say that the code may run as the harness's user", () => {
      assert.throws(() => new LakeCertifier(base), /refuses to run the candidate's code without a sandbox/);
      assert.throws(() => new LakeCertifier({ ...base, sandbox: [] }), /without a sandbox/);
      assert.throws(() => new LakeCertifier({ ...base, unsandboxed: false }), /without a sandbox/);
      assert.doesNotThrow(() => new LakeCertifier({ ...base, unsandboxed: true }));
      assert.doesNotThrow(() => new LakeCertifier({ ...base, sandbox: ["bwrap", "--"] }));
    });

    it("says in its health check whether it runs the code in a sandbox", async () => {
      const bare = await setup().certifier.health();
      assert.equal(bare.ok, true);
      assert.match(bare.detail, /no sandbox: the candidate's code runs as the harness's user/);
      const wrapped = await setup({ sandbox: [process.execPath, ...NODE, FAKE_SANDBOX, "--bind", "{work}", "--"] }).certifier.health();
      assert.equal(wrapped.ok, true);
      assert.match(wrapped.detail, /sandbox command: .*node/);
      assert.doesNotMatch(wrapped.detail, /no sandbox/);
    });

    it("is not made when the replay program cannot be read: nothing was run yet", () => {
      assert.throws(() => new LakeCertifier({ ...base, unsandboxed: true, program: "/nonexistent/Main.lean" }), /cannot read the replay program \/nonexistent\/Main\.lean/);
    });
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
