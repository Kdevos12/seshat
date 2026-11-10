import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildGraded, writeGraded } from "@seshat/bench";
import { buildReport } from "../src/index.ts";
import { compareProbe, probeDirOf } from "../src/probe.ts";
import { measureRun } from "../src/measures.ts";
import { scriptedRun } from "./ablate-helpers.ts";
import { freshLeanEnvDir, tempDir } from "./m0-helpers.ts";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
/** The Lean environments as a fresh checkout has them, whatever this machine resolved or built; the Lean server address answers nothing. */
const LEAN_ENV_DIR = freshLeanEnvDir();

async function harness(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: { ...process.env, HARNESS_HOST: "", SESHAT_LEAN_ENV_DIR: LEAN_ENV_DIR, LEAN_SERVER_API_URL: "http://127.0.0.1:9" } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("harness ablate", () => {
  it("needs a checkout and a model, and says what it does in the usage", async () => {
    const none = await harness(["ablate", "--all"]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /ablate needs --checkout/);
    assert.match(none.stderr, /harness ablate --checkout DIR/);
  });

  it("refuses a human breakpoint, an off-peak wait and the flags that belong to run, before anything is spent", async () => {
    const checkout = tempDir("mh-cli-checkout-");
    const human = await harness(["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--human", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.equal(human.code, 2);
    assert.match(human.stderr, /cannot go with an ablation/);
    const offpeak = await harness(["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--offpeak", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.equal(offpeak.code, 2);
    assert.match(offpeak.stderr, /--offpeak/);
    const own = await harness(["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--ablation", "M1"]);
    assert.equal(own.code, 2);
    assert.match(own.stderr, /chooses the lines itself/);
  });

  it("refuses an unknown experiment and a configuration that is not cumulative", async () => {
    const checkout = tempDir("mh-cli-checkout-");
    const e = await harness(["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--experiment", "nothing", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.equal(e.code, 2);
    assert.match(e.stderr, /unknown experiment/);
    const c = await harness(["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--configs", "M99", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.equal(c.code, 2);
    assert.match(c.stderr, /not a cumulative configuration/);
  });
});

describe("the graded bench on the command line", () => {
  /** A graded bench built from two fixture checkouts, without a Lean: every entry is unchecked. */
  function gradedFile(): string {
    const fc = tempDir("mh-cli-fc-");
    mkdirSync(join(fc, "FormalConjectures"), { recursive: true });
    writeFileSync(join(fc, "FormalConjectures", "T.lean"), "import FormalConjectures.Util.ProblemImports\n\n@[category textbook, AMS 11]\ntheorem t0 (n : ℕ) : n = n := by\n  sorry\n\n@[category research solved, AMS 11,\nformal_proof using lean4 at \"https://example.org/p.lean\"]\ntheorem c0 (n : ℕ) : n = n := by\n  sorry\n");
    const putnam = tempDir("mh-cli-putnam-");
    mkdirSync(join(putnam, "lean4", "src"), { recursive: true });
    writeFileSync(join(putnam, "lean4", "src", "putnam_1.lean"), "import Mathlib\n\ntheorem putnam_1\n(n : ℕ)\n: n = n :=\nsorry\n");
    const file = join(tempDir("mh-cli-graded-"), "graded-v1.json");
    writeGraded(file, buildGraded({ fc, putnam, seed: "s", sizeB: 1, sizeC: 1 }));
    return file;
  }

  it("needs a grade, refuses unchecked entries unless told otherwise, and refuses a grade for an ordinary index", async () => {
    const file = gradedFile();
    const checkout = tempDir("mh-cli-checkout-");
    const args = ["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--bench", file, "--out", join(tempDir("mh-cli-out-"), "a")];
    const none = await harness(args);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /is a graded bench: choose a grade with --grade A, B or C/);
    const unchecked = await harness([...args, "--grade", "B"]);
    assert.equal(unchecked.code, 2);
    assert.match(unchecked.stderr, /never admitted by a Lean.*--allow-unchecked/);
    const wrong = await harness([...args, "--grade", "D"]);
    assert.match(wrong.stderr, /one of A, B, C/);
    const run = await harness(["run", "--checkout", checkout, "--model", "faux/x", "--all", "--bench", file, "--grade", "B"]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /never admitted/);
    const plain = await harness(["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--grade", "B", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.equal(plain.code, 2);
    assert.match(plain.stderr, /go with a graded bench/);
  });

  it("takes the baseline and the target of the protocol, refusing a baseline that is not an arm and a target that is not a ratio, before anything is spent", async () => {
    const checkout = tempDir("mh-cli-checkout-");
    const base = ["ablate", "--checkout", checkout, "--model", "faux/x", "--all", "--configs", "M0,M1"];
    const baseline = await harness([...base, "--baseline", "nope", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.notEqual(baseline.code, 0);
    assert.match(baseline.stderr, /the baseline arm nope is not in the table/);
    const target = await harness([...base, "--target", "fast", "--out", join(tempDir("mh-cli-out-"), "a")]);
    assert.equal(target.code, 2);
    assert.match(target.stderr, /--target must be a number/);
    for (const bad of ["0", "-1", "Infinity"]) {
      const r = await harness([...base, `--target=${bad}`, "--out", join(tempDir("mh-cli-out-"), "a")]);
      assert.notEqual(r.code, 0, `--target ${bad}`);
      assert.match(r.stderr, /--target (is a ratio above 0|must be a number)/, `--target ${bad}`);
    }
  });
});

describe("harness chunks and the probe in the report", () => {
  it("prints the curves of a run directory", async () => {
    const dir = tempDir("mh-cli-chunks-");
    scriptedRun({ problems: [{ id: "p1", outcome: "candidate", attempts: [{ usd: 0.1 }, { outcome: "valid", usd: 0.1 }] }] }, dir);
    const r = await harness(["chunks", dir, "--chunk-k", "1,2"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Cost to first success/);
    assert.match(r.stdout, /Not run, or not checked/);
    assert.equal((await harness(["chunks", dir, "--chunk-k", "0"])).code, 2);
    assert.equal((await harness(["chunks"])).code, 2);
  });

  it("shows the probe of a run beside its report", async () => {
    const dir = tempDir("mh-cli-probe-");
    const r = scriptedRun({ problems: [{ id: "p1", outcome: "candidate", attempts: [{ usd: 0.1, outcome: "valid" }] }] }, dir);
    void buildReport(r.events);
    const m = measureRun(r.events);
    mkdirSync(probeDirOf(dir));
    writeFileSync(join(probeDirOf(dir), "probe.json"), JSON.stringify({ probeSet: ["p1"], memoryDir: "m", verified: { events: 1, dropped: 2 }, on: m, off: m, verdict: compareProbe(m, m) }));
    const out = await harness(["report", dir]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /## Memory probe/);
    assert.match(out.stdout, /No alarm/);
  });
});

describe("choosing problems by sequence or tag", () => {
  it("refuses an unknown sequence, a bench without the tag, a concurrency above 1 and two ways at once", async () => {
    const checkout = tempDir("mh-cli-checkout-");
    const base = ["run", "--checkout", checkout, "--model", "faux/x"];
    const seq = await harness([...base, "--sequence", "nope"]);
    assert.equal(seq.code, 2);
    assert.match(seq.stderr, /no sequence/);
    const tag = await harness([...base, "--tag", "induction"]);
    assert.equal(tag.code, 2);
    assert.match(tag.stderr, /has no problem tagged induction/);
    assert.match((await harness([...base, "--tag", "magic"])).stderr, /--tag must be one of analogy, induction/);
    assert.match((await harness([...base, "--sequence", "x", "--concurrency", "3"])).stderr, /--concurrency 1/);
    assert.match((await harness([...base, "--sequence", "x", "--all"])).stderr, /exactly one of/);
  });
});

describe("run --probe-every", () => {
  it("takes a whole number of at least 1, and says so before anything runs", async () => {
    const checkout = tempDir("mh-cli-checkout-");
    for (const bad of ["0", "x", "1.5"]) {
      const r = await harness(["run", "--checkout", checkout, "--model", "a/b", "--all", "--probe-every", bad]);
      assert.equal(r.code, 2, bad);
      assert.match(r.stderr, /--probe-every must be a whole number of at least 1/);
    }
  });
});

describe("harness optimize-prompts", () => {
  it("needs a checkout, a model and a cutoff, and refuses the flags of run, a split other than dev and a protected directory", async () => {
    const checkout = tempDir("mh-cli-checkout-");
    const out = join(tempDir("mh-cli-out-"), "a");
    assert.match((await harness(["optimize-prompts", "--all"])).stderr, /needs --checkout/);
    assert.match((await harness(["optimize-prompts", "--all", "--checkout", checkout])).stderr, /needs --model/);
    assert.match((await harness(["optimize-prompts", "--all", "--checkout", checkout, "--model", "faux/x"])).stderr, /needs --cutoff/);
    const nocap = await harness(["optimize-prompts", "--all", "--checkout", checkout, "--model", "faux/x", "--cutoff", "2026-01-01"]);
    assert.equal(nocap.code, 2);
    assert.match(nocap.stderr, /needs --max-usd/);
    const lines = await harness(["optimize-prompts", "--all", "--checkout", checkout, "--model", "faux/x", "--cutoff", "2026-01-01", "--lines", "M1"]);
    assert.equal(lines.code, 2);
    assert.match(lines.stderr, /measures the prover alone/);
    const split = await harness(["optimize-prompts", "--all", "--checkout", checkout, "--model", "faux/x", "--cutoff", "2026-01-01", "--max-usd", "10", "--split", "heldout", "--out", out]);
    assert.equal(split.code, 2);
    assert.match(split.stderr, /--split takes dev/);
    const guarded = await harness(["optimize-prompts", "--all", "--checkout", checkout, "--model", "faux/x", "--cutoff", "2026-01-01", "--max-usd", "10", "--out", new URL("../../guards/x", import.meta.url).pathname]);
    assert.equal(guarded.code, 2);
    assert.match(guarded.stderr, /no write access/);
  });
});
