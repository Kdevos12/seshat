import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { started, type Started, until } from "./helpers.ts";

const FAUX = fileURLToPath(new URL("./fixtures/faux-harness.ts", import.meta.url));
const open: Started[] = [];
after(async () => {
  for (const s of open) await s.server.close();
});
// The grace between the interrupt and SIGTERM is the real default: on a loaded machine the stopped run can take more than the two
// seconds of the other tests to write RESULT.md, and SIGTERM would end it before.
const faux = (env: Record<string, string> = {}) =>
  started({ graceMs: 10_000, env: { PATH: process.env.PATH ?? "", ...env }, command: (argv) => ({ file: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAUX, ...argv] }) });

describe("a run started through the API with the faux provider", () => {
  it("formalizes, waits for the signature, runs, and the journal reader says proved", async () => {
    const s = await faux();
    open.push(s);
    const { job } = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "Adding zero changes nothing.", mode: "prose", maxUsd: 2 })).json();
    const get = async () => (await s.call("GET", `/api/jobs/${job.id}`)).json().job;
    await until(async () => (await get()).state === "awaiting_signature", "the signature");
    const waiting = await get();
    assert.equal(waiting.signature.source, "prose");
    assert.equal(waiting.signature.prose, "Adding zero changes nothing.");
    assert.match(waiting.signature.theorem, /n \+ 0 = n/);
    assert.equal(existsSync(join(s.runsDir, job.runId, "journal.jsonl")), false, "before the signature no run has begun");
    await s.call("POST", `/api/jobs/${job.id}/answer`, { yes: true });
    await until(async () => ["exited", "failed"].includes((await get()).state), "the run to end", 20000);
    const done = await get();
    assert.equal(done.exitCode, 0, JSON.stringify(done.lines.slice(-5)));
    const run = (await s.call("GET", `/api/runs/${job.runId}`)).json().run;
    assert.equal(run.signature.by, "alice");
    assert.equal(run.status[0].level, "proved");
    assert.equal(run.proof.certified.length, 1);
    assert.match(run.resultMd, /Proved/);
  });

  it("stops a run that is working, through the stop endpoint, and RESULT.md says where it stood", async () => {
    const s = await faux({ FAUX_SLOW: "1" });
    open.push(s);
    const { job } = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "Adding zero changes nothing.", mode: "prose", maxUsd: 2 })).json();
    const get = async () => (await s.call("GET", `/api/jobs/${job.id}`)).json().job;
    await until(async () => (await get()).state === "awaiting_signature", "the signature");
    await s.call("POST", `/api/jobs/${job.id}/answer`, { yes: true });
    await until(async () => (await s.call("GET", `/api/runs/${job.runId}`)).json().run?.turns !== undefined && existsSync(join(s.runsDir, job.runId, "journal.jsonl")), "the run", 30_000);
    await new Promise((r) => setTimeout(r, 500));
    await s.call("POST", `/api/jobs/${job.id}/stop`);
    await until(async () => ["stopped", "exited"].includes((await get()).state), "the stop", 20000);
    assert.notEqual((await get()).state, "running");
    const run = (await s.call("GET", `/api/runs/${job.runId}`)).json().run;
    assert.notEqual(run.status[0].level, "proved", "a stopped run does not claim a proof");
    assert.ok(existsSync(join(s.runsDir, job.runId, "RESULT.md")));
  });
});
