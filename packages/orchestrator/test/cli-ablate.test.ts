import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildReport } from "../src/index.ts";
import { compareProbe } from "../src/probe.ts";
import { measureRun } from "../src/measures.ts";
import { scriptedRun } from "./ablate-helpers.ts";
import { tempDir } from "./m0-helpers.ts";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function harness(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: { ...process.env, HARNESS_HOST: "" } });
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

describe("harness chunks and the probe in the report", () => {
  it("prints the curves of a run directory", async () => {
    const dir = tempDir("mh-cli-chunks-");
    scriptedRun({ problems: [{ id: "p1", outcome: "candidate", attempts: [{ usd: 0.1 }, { outcome: "valid", usd: 0.1 }] }] }, dir);
    const r = await harness(["chunks", dir, "--chunk-k", "1,2"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Cost to first success/);
    assert.equal((await harness(["chunks", dir, "--chunk-k", "0"])).code, 2);
    assert.equal((await harness(["chunks"])).code, 2);
  });

  it("shows the probe of a run beside its report", async () => {
    const dir = tempDir("mh-cli-probe-");
    const r = scriptedRun({ problems: [{ id: "p1", outcome: "candidate", attempts: [{ usd: 0.1, outcome: "valid" }] }] }, dir);
    void buildReport(r.events);
    const m = measureRun(r.events);
    mkdirSync(join(dir, "probe"));
    writeFileSync(join(dir, "probe", "probe.json"), JSON.stringify({ probeSet: ["p1"], memoryDir: "m", verified: { events: 1, dropped: 2 }, on: m, off: m, verdict: compareProbe(m, m) }));
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
