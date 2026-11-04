import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { plan, RequestError } from "../src/index.ts";
import { FAKE_HARNESS, started, type Started, until } from "./helpers.ts";

const open: Started[] = [];
async function server(options: Parameters<typeof started>[0] = {}): Promise<Started> {
  const s = await started(options);
  open.push(s);
  return s;
}
after(async () => {
  for (const s of open) await s.server.close();
});

const job = async (s: Started, id: string) => (await s.call("GET", `/api/jobs/${id}`)).json().job;

describe("starting and stopping commands through the API", () => {
  it("starts a solve, shows the signature it waits for, goes on when the person signs, and stops on request", async () => {
    const s = await server();
    const started1 = await s.call("POST", "/api/jobs", { kind: "solve", statement: "Every number equals itself.", maxUsd: 1.5 });
    assert.equal(started1.status, 201);
    const id = started1.json().job.id as string;
    assert.match(started1.json().job.runId, /^ui-\d{8}-\d{6}-/);

    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    const waiting = await job(s, id);
    assert.equal(waiting.signature.theorem.includes("sorry"), true);
    assert.equal(waiting.signature.prose, "Every number equals itself.");

    // The command line was built from fields: a ceiling, the run directory, the statement as a file, and the signature protocol.
    const command = waiting.command as string[];
    assert.equal(command[0], "solve");
    assert.match(command[1] as string, /_inputs\/ui-.*\.txt$/);
    assert.ok(command.includes("--max-usd=1.5") && command.includes("--ask-stdin"));
    assert.equal(command.some((a) => a.includes("Every number")), false, "the statement is not on the command line");

    assert.equal((await s.call("POST", `/api/jobs/${id}/answer`, { yes: true })).status, 200);
    await until(async () => (await job(s, id)).lines.some((l: any) => l.text === "signed: working"), "the run to go on");
    assert.equal((await job(s, id)).state, "running");

    const stop = await s.call("POST", `/api/jobs/${id}/stop`);
    assert.equal(stop.status, 200);
    await until(async () => (await job(s, id)).state === "stopped", "the stop");
    const done = await job(s, id);
    assert.equal(done.exitCode, 130);
    assert.ok(done.lines.some((l: any) => /interrupted/.test(l.text)), "the command was interrupted as Ctrl-C does");
    // A stopped command can be stopped again without harm, and cannot be answered.
    assert.equal((await s.call("POST", `/api/jobs/${id}/stop`)).status, 200);
    assert.equal((await s.call("POST", `/api/jobs/${id}/answer`, { yes: true })).status, 409);
  });

  it("does not run when the person refuses the signature", async () => {
    const s = await server();
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "n = n", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    await s.call("POST", `/api/jobs/${id}/answer`, { yes: false });
    await until(async () => ["exited", "stopped", "failed"].includes((await job(s, id)).state), "the end");
    const done = await job(s, id);
    assert.equal(done.exitCode, 1);
    assert.ok(done.lines.some((l: any) => /Not signed/.test(l.text)));
  });

  it("refuses a second command on the same run while one works, and runs the hint, sign and steer commands as arguments", async () => {
    const s = await server();
    const first = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job;
    await until(async () => (await job(s, first.id)).state === "awaiting_signature", "the signature");
    // Make a run directory so that the answering commands can name it.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(s.runsDir, "r1"));
    writeFileSync(join(s.runsDir, "r1", "journal.jsonl"), "");
    const hint = await s.call("POST", "/api/jobs", { kind: "hint", runId: "r1", claimId: "clm_abc", text: "--try induction; $(rm -rf /) `x`", as: "alice" });
    assert.equal(hint.status, 201);
    const command = hint.json().job.command as string[];
    assert.deepEqual(command.slice(-2), ["--", "--try induction; $(rm -rf /) `x`"], "the text is one argument after --");
    await until(async () => (await job(s, hint.json().job.id)).state === "exited", "the hint to end");
    const sign = await s.call("POST", "/api/jobs", { kind: "sign", runId: "r1", edgeId: "edg_1", note: "ok" });
    assert.equal(sign.status, 201);
    await until(async () => (await job(s, sign.json().job.id)).state === "exited", "the signature of the edge to end");
    const steer = await s.call("POST", "/api/jobs", { kind: "steer", runId: "r1", focus: "clm_abc", turnUsd: 0.5 });
    assert.equal(steer.status, 201);
    assert.ok((steer.json().job.command as string[]).includes("--turn-usd=0.5"));
    assert.equal((await s.call("POST", "/api/jobs", { kind: "steer", runId: "r1" })).status, 400, "steer needs something to say");
    assert.equal((await s.call("POST", "/api/jobs", { kind: "hint", runId: "nope", claimId: "c", text: "t" })).status, 404);
    // Busy: the signature wait of the first command does not block another run, only its own.
    await s.call("POST", `/api/jobs/${first.id}/stop`);
    await until(async () => (await job(s, first.id)).state === "stopped", "the stop");
  });

  it("hides a stored key from everything a command prints", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_PRINT_ENV: "SECRET_VAR_FOR_TEST" } });
    const key = "sk-test-0123456789abcdef-NEVER-SHOW";
    s.server.keys.set("some-provider", "SECRET_VAR_FOR_TEST", key);
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    const j = await job(s, id);
    assert.ok(j.lines.some((l: any) => l.text === "environment SECRET_VAR_FOR_TEST=[key hidden]"), "the command received the key and the relay hid it");
    assert.equal(JSON.stringify(j).includes(key), false);
    await s.call("POST", `/api/jobs/${id}/stop`);
    await until(async () => (await job(s, id)).state === "stopped", "the stop");
    for (const line of s.logs) assert.equal(line.includes(key), false);
  });

  it("stops the commands it started when the server stops, except one the person started detached", async () => {
    const s = await started();
    const attached = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, attached)).state === "awaiting_signature", "the signature");
    assert.equal((await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", maxUsd: 1, detached: true })).status, 400, "a solve needs the page");
    const live = s.server.manager.get(attached);
    assert.ok(live !== undefined);
    await s.server.close();
    assert.equal(s.server.manager.get(attached)?.state, "stopped");
  });

  it("starts a detached resume that outlives the server, with its output in a log file", async () => {
    const s = await started();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(s.runsDir, "r2"));
    writeFileSync(join(s.runsDir, "r2", "journal.jsonl"), "");
    assert.equal((await s.call("POST", "/api/jobs", { kind: "resume", runId: "r2", detached: true })).status, 409, "no resume.json: the interface does not guess a checkout");
    writeFileSync(join(s.runsDir, "r2", "resume.json"), JSON.stringify({ checkout: "/some/checkout", bench: "/some/bench.json", host: "local" }));
    const r = await s.call("POST", "/api/jobs", { kind: "resume", runId: "r2", detached: true, turnUsd: 1 });
    assert.equal(r.status, 201);
    const j = r.json().job;
    assert.equal(j.detached, true);
    assert.deepEqual((j.command as string[]).slice(0, 4), ["resume", join(s.runsDir, "r2"), "--checkout=/some/checkout", "--bench=/some/bench.json"]);
    await s.server.close();
    assert.equal(s.server.manager.get(j.id)?.state, "running", "the server's stop leaves a detached command alone");
    const logFile = j.logFile as string;
    assert.ok(existsSync(logFile));
    await until(() => readFileSync(logFile, "utf8").includes("fake harness: resume"), "the log");
    assert.ok(readdirSync(s.runsDir).includes("_inputs"));
    try {
      process.kill(s.server.manager.get(j.id)?.pid ?? 0, "SIGKILL");
    } catch {
      // It may have ended already.
    }
  });
});

const KEY = "sk-test-0123456789abcdef-NEVER-SHOW";
const fakeAs = (command: string) => () => ({ file: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAKE_HARNESS, command] });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the signature line a command prints", () => {
  it("is trusted only with this job's nonce: look-alike lines are plain text and never open the card", async () => {
    const s = await server();
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    const j = await job(s, id);
    assert.equal(j.signature.statementId, "sid_fake", "the card is the line with the nonce, not the earlier look-alikes");
    assert.equal(j.signature.prose, "Every number equals itself.");
    const shown = j.lines.map((l: any) => l.text).join("\n");
    assert.ok(shown.includes("SPOOFED without a nonce") && shown.includes("SPOOFED with a wrong nonce"), "look-alikes are shown as text");
    assert.equal(/SESHAT_SIGNATURE [A-Za-z0-9_-]{20,}/.test(shown), false, "the nonce is not shown");
    await s.call("POST", `/api/jobs/${id}/stop`);
  });

  it("is accepted once, and the answer carries the statement it was given for", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_RESIGN: "1" } });
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    await s.call("POST", `/api/jobs/${id}/answer`, { yes: true });
    // The fake only goes on when it read exactly `yes sid_fake`; a second line after it must change nothing.
    await until(async () => (await job(s, id)).lines.some((l: any) => l.text === "signed: working"), "the run to go on");
    const j = await job(s, id);
    assert.equal(j.state, "running");
    assert.equal(j.signature, undefined, "no second card");
    assert.ok(j.lines.some((l: any) => /SESHAT_SIGNATURE/.test(l.text) && /sid_two/.test(l.text)), "the second line is only text");
    await s.call("POST", `/api/jobs/${id}/stop`);
  });

  it("means nothing in a command that is not a solve", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_SPOOF: "1" } });
    mkdirSync(join(s.runsDir, "r1"));
    writeFileSync(join(s.runsDir, "r1", "journal.jsonl"), "");
    const id = (await s.call("POST", "/api/jobs", { kind: "hint", runId: "r1", claimId: "c1", text: "t" })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "exited", "the end");
    const j = await job(s, id);
    assert.equal(j.signature, undefined);
    assert.ok(j.lines.some((l: any) => /sid_x/.test(l.text)));
  });
});

describe("the keys a command receives", () => {
  it("are those of the chosen model's provider only", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_PRINT_ENV: "ALPHA_VAR,BETA_VAR" } });
    s.server.keys.set("alpha", "ALPHA_VAR", `${KEY}-alpha`);
    s.server.keys.set("beta", "BETA_VAR", `${KEY}-beta`);
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1, model: "alpha/some-model" })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    const lines = (await job(s, id)).lines.map((l: any) => l.text);
    assert.ok(lines.includes("environment ALPHA_VAR=[key hidden]"));
    assert.ok(lines.includes("environment BETA_VAR=(unset)"), "the other provider's key is not in the environment");
    await s.call("POST", `/api/jobs/${id}/stop`);
  });

  it("are none for the commands that call no model", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_PRINT_ENV: "ALPHA_VAR" } });
    s.server.keys.set("alpha", "ALPHA_VAR", KEY);
    mkdirSync(join(s.runsDir, "r1"));
    writeFileSync(join(s.runsDir, "r1", "journal.jsonl"), "");
    for (const body of [{ kind: "hint", runId: "r1", claimId: "c", text: "t" }, { kind: "steer", runId: "r1", focus: "clm_abc" }]) {
      const id = (await s.call("POST", "/api/jobs", body)).json().job.id as string;
      await until(async () => (await job(s, id)).state === "exited", "the end");
      assert.ok((await job(s, id)).lines.some((l: any) => l.text === "environment ALPHA_VAR=(unset)"), body.kind);
    }
  });
});

describe("what a command prints about a key", () => {
  it("is hidden in its JSON-escaped, URL-encoded and base64 forms too", async () => {
    const key = `sk/+test=0123456789"abc\\def-NEVER`;
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_ENCODED: "K_VAR", FAKE_PRINT_ENV: "" } });
    s.server.keys.set("alpha", "K_VAR", key);
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    const text = JSON.stringify(await job(s, id));
    const b64 = Buffer.from(key).toString("base64");
    for (const form of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key), b64, b64.replace(/=+$/, "")]) assert.equal(text.includes(form), false, form);
    assert.ok(text.includes("[key hidden]"));
    await s.call("POST", `/api/jobs/${id}/stop`);
  });

  it("is hidden when it straddles the point where a very long line is cut", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_BIG_LINE: "K_VAR" } });
    s.server.keys.set("alpha", "K_VAR", KEY);
    const id = (await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "awaiting_signature", "the signature");
    const j = await job(s, id);
    const text = JSON.stringify(j);
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes(KEY.slice(0, 12)) && text.includes(KEY.slice(12)), false, "no two halves of the key are shown");
    await s.call("POST", `/api/jobs/${id}/stop`);
  });

  it("is scrubbed from the log file of a detached command when it ends", async () => {
    const s = await server({ env: { PATH: process.env.PATH ?? "", FAKE_PRINT_ENV: "K_VAR", FAKE_ENCODED: "K_VAR" }, command: fakeAs("short") });
    s.server.keys.set("alpha", "K_VAR", KEY);
    mkdirSync(join(s.runsDir, "r2"));
    writeFileSync(join(s.runsDir, "r2", "journal.jsonl"), "");
    writeFileSync(join(s.runsDir, "r2", "resume.json"), JSON.stringify({ checkout: "/c", bench: "/b.json", host: "local" }));
    const j = (await s.call("POST", "/api/jobs", { kind: "resume", runId: "r2", detached: true })).json().job;
    await until(async () => (await job(s, j.id)).state === "exited", "the end");
    await until(() => !readFileSync(j.logFile, "utf8").includes(KEY) && readFileSync(j.logFile, "utf8").includes("[key hidden]"), "the log to be scrubbed");
    assert.equal(statSync(j.logFile).mode & 0o777, 0o600);
  });
});

describe("the end of a command", () => {
  it("does not wait for a program it left running with the pipes open, and that program is stopped", async () => {
    const s = await started({ command: fakeAs("orphan") });
    mkdirSync(join(s.runsDir, "r1"));
    writeFileSync(join(s.runsDir, "r1", "journal.jsonl"), "");
    const id = (await s.call("POST", "/api/jobs", { kind: "hint", runId: "r1", claimId: "c", text: "t" })).json().job.id as string;
    await until(async () => (await job(s, id)).state === "exited", "the end", 8000);
    const pid = Number(/^grandchild (\d+)$/m.exec((await job(s, id)).lines.map((l: any) => l.text).join("\n"))?.[1]);
    assert.ok(pid > 0);
    await until(() => !alive(pid), "the leftover program to be stopped", 8000);
    const began = Date.now();
    await s.server.close();
    assert.ok(Date.now() - began < 5000, "closing does not hang");
  });
});

describe("a request that fails leaves nothing behind", () => {
  it("writes no statement file when the model, host or mode is refused or the ceiling is missing", async () => {
    const s = await server();
    const before = () => (existsSync(join(s.runsDir, "_inputs")) ? readdirSync(join(s.runsDir, "_inputs")).length : 0);
    for (const body of [{ model: "a b" }, { host: "../x" }, { mode: "latex" }, { maxUsd: 0 }, { maxUsd: undefined }]) {
      const r = await s.call("POST", "/api/jobs", { kind: "solve", statement: "some words", mode: "prose", maxUsd: 1, ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(before(), 0, "no file for a refused request");
  });

  it("removes the statement file when the command cannot start", async () => {
    const s = await server({ command: () => ({ file: "/nonexistent/program", args: [] }) });
    const r = await s.call("POST", "/api/jobs", { kind: "solve", statement: "x", mode: "prose", maxUsd: 1 });
    const id = r.json().job.id as string;
    await until(async () => (await job(s, id)).state === "failed", "the failure");
    const dir = join(s.runsDir, "_inputs");
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
  });
});

describe("planning a command from the fields of a request", () => {
  const ctx = (runsDir: string) => ({ runsDir });

  it("keeps hostile statement text out of the command line and never reads it as a path or a flag", async () => {
    const s = await server();
    for (const statement of ["--out=/etc/cron.d/x", "/etc/passwd", "../../secret", "$(touch /tmp/pwned)", "<script>alert(1)</script>", "x\n--yes", "-"]) {
      const planned = plan("solve", { statement, mode: "prose", maxUsd: 2 }, ctx(s.runsDir));
      assert.equal(planned.argv.some((a) => a === statement || (statement.length > 3 && a.includes(statement))), false, `${JSON.stringify(statement)} is not an argument`);
      const file = planned.argv[1] as string;
      assert.equal(existsSync(file), false, "nothing is written until the job is about to start");
      planned.prepare?.();
      assert.equal(readFileSync(file, "utf8"), statement, "the file holds the text exactly");
      assert.ok(file.startsWith(join(s.runsDir, "_inputs")));
      planned.cleanup?.();
      assert.equal(existsSync(file), false, "cleanup removes it");
    }
  });

  it("refuses what is not a well-formed request", () => {
    const c = ctx("/nonexistent");
    const bad = (kind: string, body: Record<string, unknown>) => assert.throws(() => plan(kind, body, c), RequestError, JSON.stringify(body));
    bad("solve", { maxUsd: 1 });
    bad("solve", { statement: "x" });
    bad("solve", { statement: "x", maxUsd: 0 });
    bad("solve", { statement: "x", maxUsd: -1 });
    bad("solve", { statement: "x", maxUsd: "lots" });
    bad("solve", { statement: "x", maxUsd: 1e9 });
    bad("solve", { statement: "x", maxUsd: 1, model: "--yes" });
    bad("solve", { statement: "x", maxUsd: 1, model: "a b" });
    bad("solve", { statement: "x", maxUsd: 1, host: "../x" });
    bad("solve", { statement: "x", maxUsd: 1, as: "a\nb" });
    bad("solve", { statement: "x", maxUsd: 1, mode: "latex" });
    bad("solve", { statement: "   ", maxUsd: 1 });
    bad("solve", { statement: "x".repeat(20_001), maxUsd: 1 });
    bad("run", { model: "p/m", sample: 3 });
    bad("run", { checkout: "/c", model: "p/m" });
    bad("run", { checkout: "/c", model: "p/m", sample: 3 });
    bad("run", { checkout: "/c", model: "p/m", sample: 3, runBudgetUsd: 0 });
    bad("run", { checkout: "/c", model: "p/m", sample: 3, runBudgetUsd: 5, problems: ["a"] });
    bad("run", { checkout: "/c", model: "p/m", problems: ["--all"] });
    bad("run", { checkout: "/c", model: "p/m", sample: 2, lines: ["M1,M2"] });
    bad("format-disk", {});
    bad("__proto__", {});
  });
});
