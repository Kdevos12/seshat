/**
 * A small MCP server for tests. Imported, `attach` serves an in-memory transport; run as a script
 * (`node fake-mcp-server.ts --version 1.0.0`), it serves stdio.
 *
 * Tools: `add` (structured result), `add_text` (JSON in a text block), `fail` (isError), `slow`
 * (never answers), `crash` (the server goes away), `store` (a value per key in the workspace named
 * by `session`; the key `error` is refused), `drop` (ends the workspace `name`), `workspaces` (their
 * names), `env` (a variable of the server's environment).
 */
import { createInterface } from "node:readline";
import type { JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };
type Reply = Record<string, unknown>;

const TOOLS = ["add", "add_text", "fail", "slow", "crash", "store", "drop", "workspaces", "env"].map((name) => ({
  name,
  description: `test tool ${name}`,
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
}));

/** The state of one server: its workspaces, each a map of keys to values. */
export type Workspaces = Map<string, Map<string, unknown>>;

/** The answer to a message, `undefined` for none, `"crash"` when the server must go away. */
export function answer(message: Message, version: string, workspaces: Workspaces = new Map()): Reply | undefined | "crash" {
  if (message.id === undefined) return undefined;
  const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-math", version },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as { a?: number; b?: number };
      const sum = (args.a ?? 0) + (args.b ?? 0);
      if (name === "add") return ok({ content: [{ type: "text", text: `sum ${sum}` }], structuredContent: { sum } });
      if (name === "add_text") return ok({ content: [{ type: "text", text: JSON.stringify({ sum }) }] });
      if (name === "fail") return ok({ content: [{ type: "text", text: "a must be positive" }], isError: true });
      if (name === "slow") return undefined;
      if (name === "crash") return "crash";
      if (name === "store") {
        const { key, value, session } = (message.params?.arguments ?? {}) as { key?: string; value?: unknown; session?: string };
        if (key === "error") return ok({ content: [{ type: "text", text: "the key error is refused" }], isError: true });
        const space = workspaces.get(session ?? "default") ?? new Map<string, unknown>();
        workspaces.set(session ?? "default", space);
        if (value !== undefined) space.set(key ?? "", value);
        const stored = space.get(key ?? "") ?? null;
        return ok({ content: [{ type: "text", text: JSON.stringify({ value: stored }) }], structuredContent: { value: stored } });
      }
      if (name === "drop") {
        const workspace = (message.params?.arguments as { name?: string } | undefined)?.name ?? "";
        if (!workspaces.delete(workspace)) return ok({ content: [{ type: "text", text: `no workspace ${workspace}` }], isError: true });
        return ok({ content: [{ type: "text", text: "dropped" }], structuredContent: { dropped: workspace } });
      }
      if (name === "workspaces") return ok({ content: [{ type: "text", text: "" }], structuredContent: { names: [...workspaces.keys()].sort() } });
      if (name === "env") {
        const variable = (message.params?.arguments as { name?: string } | undefined)?.name ?? "";
        return ok({ content: [{ type: "text", text: "" }], structuredContent: { value: process.env[variable] ?? null } });
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${String(name)}` } };
    }
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}

export async function attach(server: McpTransport, version: string, workspaces: Workspaces = new Map()): Promise<void> {
  await server.start();
  server.onMessage((message) => {
    const reply = answer(message as Message, version, workspaces);
    if (reply === "crash") void server.close();
    else if (reply !== undefined) void server.send(reply as unknown as JsonRpcMessage);
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--version");
  const version = i >= 0 ? (process.argv[i + 1] as string) : "0.0.0";
  if (process.argv.includes("--fail-start")) {
    process.stderr.write("cannot load the solver\n");
    process.exit(3);
  }
  const workspaces: Workspaces = new Map();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const reply = answer(JSON.parse(line) as Message, version, workspaces);
    if (reply === "crash") process.exit(1);
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
