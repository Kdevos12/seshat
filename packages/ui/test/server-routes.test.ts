import assert from "node:assert/strict";
import { appendFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scriptedJournal } from "../../orchestrator/test/scripted-journal.ts";
import { started, type Started, until } from "./helpers.ts";

const open: Started[] = [];
async function server(): Promise<Started> {
  const s = await started();
  open.push(s);
  return s;
}
after(async () => {
  for (const s of open) await s.server.close();
});

/** Reads server-sent events from a stream until `done` says stop. */
async function events(s: Started, path: string, done: (all: Array<{ event: string; data: string }>) => boolean): Promise<Array<{ event: string; data: string }>> {
  const controller = new AbortController();
  const response = await fetch(`${s.server.origin}${path}`, { headers: { authorization: `Bearer ${s.server.token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const all: Array<{ event: string; data: string }> = [];
  let buffer = "";
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    while (!done(all)) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        all.push({ event, data });
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return all;
}

describe("reading runs through the API", () => {
  it("lists runs and gives the projection of one, and the text of RESULT.md", async () => {
    const s = await server();
    const scripted = scriptedJournal();
    scripted.journal.close();
    cpSync(scripted.dir, join(s.runsDir, "recorded"), { recursive: true });
    const list = (await s.call("GET", "/api/runs")).json().runs;
    assert.deepEqual(list.map((r: any) => r.id), ["recorded"]);
    const view = (await s.call("GET", "/api/runs/recorded")).json();
    assert.equal(view.run.state, "paused");
    assert.equal(view.activeJob, null);
    assert.equal(view.run.claims.find((c: any) => c.id === scripted.claims.proved).status, "proved");
    const md = await s.call("GET", "/api/runs/recorded/result");
    assert.match(md.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(md.text, /Lean proofs certified so far/);
    assert.equal((await s.call("GET", "/api/runs/missing")).status, 404);
    assert.equal((await s.call("PUT", "/api/runs/recorded", {})).status, 404, "a run cannot be written through the API");
  });

  it("says when a journal grows, without sending the events", async () => {
    const s = await server();
    const scripted = scriptedJournal();
    scripted.journal.close();
    cpSync(scripted.dir, join(s.runsDir, "live"), { recursive: true });
    const path = join(s.runsDir, "live", "journal.jsonl");
    const received = events(s, "/api/runs/live/events", (all) => all.some((e) => e.event === "journal"));
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(path, `${JSON.stringify({ v: 1, seq: 9999, id: "x", ts: "2026-01-01T00:00:00Z", run: "r", actor: "orchestrator", type: "run.finished", data: { secret: "do not send" } })}\n`);
    const all = await received;
    assert.equal(all[0]?.event, "ready");
    const news = JSON.parse(all.find((e) => e.event === "journal")?.data ?? "[]");
    assert.deepEqual(news.map((e: any) => e.type), ["run.finished"]);
    assert.equal(JSON.stringify(news).includes("do not send"), false);
  });

  it("streams a command's output and its end", async () => {
    const s = await server();
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await s.call("GET", `/api/jobs/${id}`)).json().job.state === "awaiting_signature", "the signature");
    const received = events(s, `/api/jobs/${id}/events`, (all) => all.some((e) => e.event === "job" && /"state":"stopped"/.test(e.data)));
    await new Promise((r) => setTimeout(r, 100));
    await s.call("POST", `/api/jobs/${id}/stop`);
    const all = await received;
    const lines = all.filter((e) => e.event === "job").map((e) => JSON.parse(e.data)).filter((d) => d.line).map((d) => d.line.text);
    assert.ok(lines.some((l: string) => /^fake harness: solve \d+ argument/.test(l)), JSON.stringify(lines));
    assert.ok(lines.some((l: string) => /interrupted/.test(l)));
    assert.equal(JSON.parse(all[0]?.data ?? "{}").state, "awaiting_signature");
  });
});

describe("the doctor through the API", () => {
  it("gives the checklist of harness doctor as data and writes nothing", async () => {
    const s = await server();
    const report = (await s.call("GET", "/api/doctor")).json();
    assert.equal(report.ok, false, "a bare machine lacks what a run needs");
    // The credentials are the server's environment's and the stored keys, never those of the machine that runs the test.
    assert.deepEqual(report.checks.map((c: any) => c.id), ["lean", "kimina", "credentials", "network", "isolation", "defaults"]);
    assert.equal(report.checks.find((c: any) => c.id === "credentials").status, "missing");
    assert.ok(report.checks.find((c: any) => c.id === "lean").fix, "a missing thing says what to do");
    // A stored key counts: the cheapest model it gives is priced, and the network to it is checked.
    assert.equal((await s.call("PUT", "/api/providers/deepseek/key", { key: "test-key-not-real-0001" })).status, 200);
    const keyed = (await s.call("GET", "/api/doctor")).json();
    assert.deepEqual(keyed.checks.map((c: any) => c.id), ["lean", "kimina", "credentials", "prices", "network", "isolation", "defaults"]);
    assert.equal(keyed.checks.find((c: any) => c.id === "credentials").status, "ok");
    assert.deepEqual(readdirSync(join(s.dir, "config-dir", "hosts")), ["local.json"], "no isolation profile was written");
    assert.equal((await s.call("GET", "/api/doctor?model=--yes%20x")).status, 400);
  });
});
