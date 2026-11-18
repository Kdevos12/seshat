import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEvents } from "@seshat/core";
import { progressLine, progressOf, watchProgress } from "../src/index.ts";
import { check, demoRun, say, tempDir } from "./m0-helpers.ts";

/** Two sessions: the first checks a wrong proof and stops, the second finds one. */
const TWO_SESSIONS = [check("bad"), say("I stop here."), check("exact trivial_proof")];

describe("live progress on the command line (UX3)", () => {
  it("counts sessions, checks and problems from the journal, with the spend RESULT.md shows", async () => {
    const run = await demoRun({ config: { sessions: 3 }, responses: TWO_SESSIONS });
    const p = progressOf(readEvents(join(run.dir, "journal.jsonl")));
    assert.equal(p.sessions, 2);
    assert.ok(p.checks >= 2, `checks ${p.checks}`);
    assert.equal(p.problems, 1);
    assert.ok(p.usd > 0);
    assert.match(progressLine(p), /^\[\d+:\d\d\] \$[\d.]+( of \$[\d.]+)? · 2 sessions · \d+ Lean checks · /);
  });

  it("prints a line only when the run moved, nothing before the first session, and survives a torn last line", async () => {
    const run = await demoRun({ config: { sessions: 3 }, responses: TWO_SESSIONS });
    const all = readFileSync(join(run.dir, "journal.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    const firstEnd = all.findIndex((l) => JSON.parse(l).type === "attempt.finished");
    const dir = tempDir();
    const file = join(dir, "journal.jsonl");
    const lines: string[] = [];
    const watch = watchProgress(dir, (l) => lines.push(l), { intervalMs: 60_000 });
    watch.poll();
    assert.deepEqual(lines, [], "no journal yet: nothing");
    writeFileSync(file, `${all.slice(0, firstEnd).join("\n")}\n`);
    watch.poll();
    assert.deepEqual(lines, [], "no session ended yet: nothing (a signature asked on the terminal is not interrupted)");
    appendFileSync(file, `${all[firstEnd]}\n{"torn`);
    watch.poll();
    assert.equal(lines.length, 1, "the first session ended");
    assert.match(lines[0] ?? "", /· 1 session ·/);
    watch.poll();
    assert.equal(lines.length, 1, "nothing moved: no new line");
    writeFileSync(file, `${all.join("\n")}\n`);
    watch.stop();
    assert.equal(lines.length, 2, "stop reads the journal a last time");
    assert.match(lines[1] ?? "", /· 2 sessions ·/);
  });
});
