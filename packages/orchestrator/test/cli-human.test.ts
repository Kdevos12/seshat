import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { readEvents } from "@seshat/core";
import { check, demoRun, ofType, tempDir } from "./m0-helpers.ts";
import { scriptedJournal } from "./scripted-journal.ts";
import { consortium } from "./turns-helpers.ts";

const exec = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function harness(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: { ...process.env, HARNESS_HOST: "", ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("harness run in consortium mode", () => {
  const base = ["run", "--model", "faux/prover", "--checkout", "/nonexistent", "--sample", "1"];

  it("refuses a turn limit or --human with an ablation: the configs would no longer differ by their lines alone", async () => {
    for (const flag of [["--turn-tokens", "100"], ["--turn-usd", "1"], ["--turn-minutes", "5"], ["--human"], ["--turn-narrative"]]) {
      const { code, stderr } = await harness([...base, "--ablation", "M1", ...flag]);
      assert.equal(code, 2, flag.join(" "));
      assert.match(stderr, /a turn limit or --human cannot go with an ablation/);
    }
  });

  it("refuses limits that are not positive numbers, and impasse options without the mode", async () => {
    assert.match((await harness([...base, "--turn-tokens", "0"])).stderr, /--turn-tokens must be positive, got 0/);
    assert.match((await harness([...base, "--turn-usd", "abc"])).stderr, /--turn-usd must be a number/);
    assert.match((await harness([...base, "--impasse-attempts", "3"])).stderr, /go with --human or a turn limit/);
  });

  it("refuses --human when resuming, and a resume with no checkout", async () => {
    assert.match((await harness(["resume", tempDir(), "--human", "--checkout", tempDir()])).stderr, /a run resumed keeps the mode it began with/);
    const { code, stderr } = await harness(["resume", tempDir()]);
    assert.equal(code, 2);
    assert.match(stderr, /--resume needs --checkout/);
    assert.equal((await harness(["resume"])).code, 2);
  });

  it("lists the commands in its usage", async () => {
    const { stdout } = await harness(["--help"]);
    for (const text of ["harness hint RUN_DIR --claim ID", "harness sign RUN_DIR EDGE_ID", "harness steer RUN_DIR", "harness resume RUN_DIR", "--turn-tokens N", "--human", "Consortium mode"]) {
      assert.ok(stdout.includes(text), text);
    }
  });
});

describe("harness hint, sign and steer", () => {
  it("record a person's answers in the journal under their name, and say what each does", async () => {
    const run = await demoRun({ config: { sessions: 3, consortium: consortium({ tokens: 1 }) }, responses: Array.from({ length: 4 }, () => check("bad")) });
    const claimId = ofType(run.events, "problem.registered")[0]?.data.claimId ?? "";
    const env = { SESHAT_USER: "dana" };

    const hint = await harness(["hint", run.dir, "--claim", claimId, "Try induction on n."], env);
    assert.equal(hint.code, 0, hint.stderr);
    assert.match(hint.stdout, /^dana: hint nod_\w+ recorded on claim clm_\w+\./);
    assert.match(hint.stdout, /Resume with: harness resume .* --checkout DIR/);

    const steer = await harness(["steer", run.dir, "--forbid", "automation", "--turn-tokens", "500", "--as", "eve"], env);
    assert.equal(steer.code, 0, steer.stderr);
    assert.match(steer.stdout, /eve: steer nod_\w+ recorded: forbid the strategy automation\./);
    assert.match(steer.stdout, /eve: steer nod_\w+ recorded: limit the next turn to \{"tokens":500\}\./);

    const written = readEvents(join(run.dir, "journal.jsonl")).slice(run.events.length);
    assert.deepEqual(written.map((e) => [e.type, e.actor]), [["node.recorded", "human:dana"], ["node.recorded", "human:eve"], ["node.recorded", "human:eve"]]);
    assert.deepEqual(written.map((e) => (e.type === "node.recorded" ? e.data.kind : "")), ["hint", "steer", "steer"]);
  });

  it("sign an edge, and refuse what cannot be signed, with exit code 2", async () => {
    const s = scriptedJournal();
    s.journal.close();
    const signed = await harness(["sign", s.dir, s.edges.implies, "--note", "checked by hand", "--as", "frank"]);
    assert.equal(signed.code, 0, signed.stderr);
    assert.match(signed.stdout, /^frank: edge edg_\w+ signed \(proposed -> human_signed\)\. A signature is not a Lean check/);
    const change = readEvents(join(s.dir, "journal.jsonl")).at(-1);
    assert.deepEqual([change?.type, change?.actor], ["edge.status_changed", "human:frank"]);
    assert.match(change?.type === "edge.status_changed" ? change.data.reason : "", /signed by frank: checked by hand/);

    const again = await harness(["sign", s.dir, s.edges.implies, "--as", "frank"]);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /is human_signed already/);
    assert.equal((await harness(["sign", s.dir, "--as", "frank"])).code, 2);
    assert.equal((await harness(["hint", s.dir, "text"])).code, 2, "a hint names its claim");
    assert.equal((await harness(["hint", tempDir(), "--claim", "clm_x", "text"])).code, 2);
    assert.match((await harness(["steer", s.dir, "--as", "frank"])).stderr, /steer needs something to say/);
    assert.ok(readFileSync(join(s.dir, "journal.jsonl"), "utf8").length > 0);
  });
});
