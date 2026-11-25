// A stand-in for a coding agent that speaks the Agent Client Protocol over its standard input and output (JSON-RPC 2.0, one
// message per line), as the scenario in FAKE_SCENARIO says. Every message it receives is appended to FAKE_LOG when that is set,
// so a test can see what Seshat sent (the capabilities, the MCP servers, the cancel). It writes its files with its own tools.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("fake-acp 0.1.0");
  process.exit(0);
}

const scenario = process.env.FAKE_SCENARIO ?? "good";
const log = process.env.FAKE_LOG;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const DIR = "lean/SeshatLib/Combinatorics";
const GOOD = `import Mathlib

namespace SeshatLib.Combinatorics

/-- Multiply, then divide. -/
def mulDiv (a b : Nat) : Nat := a * b / b

theorem mulDiv_one (n : Nat) : mulDiv n 1 = n := by
  simp [mulDiv]

end SeshatLib.Combinatorics
`;

let next = 1000;
const waiting = new Map();
/** A request of the agent to the client; resolves with the client's answer (its result or its error). */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const say = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const usage = (sessionId, amount) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount, currency: "USD" } } } });
const permission = (sessionId, kind, path) =>
  ask("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: `call_${kind}`, title: `${kind} ${path ?? ""}`.trim(), kind, ...(path !== undefined ? { locations: [{ path }] } : {}) },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
const allowed = (answer) => answer?.result?.outcome?.outcome === "selected" && String(answer.result.outcome.optionId).startsWith("allow");

let cwd = process.cwd();
let cancelled;
const cancelSeen = new Promise((resolve) => {
  cancelled = resolve;
});

async function onPrompt(id, sessionId) {
  say(sessionId, `env keys: ${Object.keys(process.env).sort().join(",")}\ncwd: ${cwd}\n`);
  switch (scenario) {
    case "good":
    case "garbage_between": {
      if (scenario === "garbage_between") process.stdout.write("this is not JSON\n[1,2,3]\n");
      const answer = await permission(sessionId, "edit", join(cwd, DIR, "Basic.lean"));
      if (allowed(answer)) put(join(cwd, DIR, "Basic.lean"), GOOD);
      usage(sessionId, 0.02);
      say(sessionId, "done");
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "denied": {
      // A fetch, and an edit of a file outside the clone: both are denied, and the agent writes its file anyway.
      const fetch = await permission(sessionId, "fetch");
      const outside = await permission(sessionId, "edit", "/etc/passwd");
      const dotdot = await permission(sessionId, "edit", `${cwd}/../escape.lean`);
      say(sessionId, `fetch allowed: ${allowed(fetch)}; outside allowed: ${allowed(outside)}; dotdot allowed: ${allowed(dotdot)}`);
      put(join(cwd, DIR, "Basic.lean"), GOOD);
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "fs_outside": {
      // Seshat declares no fs capability: these are refused, and nothing is written for the agent.
      const write = await ask("fs/write_text_file", { sessionId, path: process.env.FAKE_OUTSIDE ?? "/tmp/seshat-fake-acp-outside", content: "planted" });
      const read = await ask("fs/read_text_file", { sessionId, path: "/etc/passwd" });
      const term = await ask("terminal/create", { sessionId, command: "sh", args: ["-c", "echo hi"] });
      say(sessionId, `write error: ${write?.error?.code}; read error: ${read?.error?.code}; terminal error: ${term?.error?.code}`);
      return send({ id, result: { stopReason: "end_turn" } });
    }
    case "outside_spec":
      put(join(cwd, DIR, "Basic.lean"), GOOD);
      put(join(cwd, "lean/Other/Elsewhere.lean"), "import Mathlib\n");
      return send({ id, result: { stopReason: "end_turn" } });
    case "prompt_error":
      put(join(cwd, DIR, "Basic.lean"), GOOD);
      return send({ id, error: { code: -32603, message: "internal error" } });
    case "budget":
      put(join(cwd, DIR, "Basic.lean"), GOOD);
      usage(sessionId, 9);
      await cancelSeen;
      return send({ id, result: { stopReason: "cancelled" } });
    case "hang":
      await cancelSeen;
      return send({ id, result: { stopReason: "cancelled" } });
    case "deaf":
      // Ignores the cancel: its process group is killed after the grace period.
      return;
    case "exit_mid_turn":
      put(join(cwd, DIR, "Basic.lean"), GOOD);
      process.exit(0);
      return;
    case "long_line":
      process.stdout.write("x".repeat(64 * 1024));
      return;
    default:
      process.stderr.write(`unknown scenario ${scenario}\n`);
      process.exit(2);
  }
}

if (scenario === "garbage") {
  process.stdout.write("Welcome to the fake agent!\n{not json\n");
  process.stderr.write("fatal: no protocol here\n");
  process.exit(3);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (log !== undefined) appendFileSync(log, `${line}\n`);
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message);
    return;
  }
  if (scenario === "silent") return;
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: {
          protocolVersion: scenario === "bad_version" ? 99 : 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, mcpCapabilities: { http: true, sse: false } },
          agentInfo: { name: "fake-acp", version: "0.1.0" },
          authMethods: [],
        },
      });
    case "session/new":
      cwd = message.params.cwd;
      return send({ id: message.id, result: { sessionId: "sess_fake" } });
    case "session/prompt":
      void onPrompt(message.id, message.params.sessionId);
      return;
    case "session/cancel":
      cancelled();
      return;
    default:
      return send({ id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
