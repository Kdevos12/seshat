/**
 * A small MCP server for tests. Imported, `attach` serves an in-memory transport; run as a script
 * (`node fake-mcp-server.ts --version 1.0.0`), it serves stdio.
 *
 * Tools: `add` (structured result), `add_text` (JSON in a text block), `fail` (isError), `slow`
 * (never answers), `crash` (the server goes away).
 */
import { createInterface } from "node:readline";
import type { JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };
type Reply = Record<string, unknown>;

const TOOLS = ["add", "add_text", "fail", "slow", "crash"].map((name) => ({
  name,
  description: `test tool ${name}`,
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
}));

/** The answer to a message, `undefined` for none, `"crash"` when the server must go away. */
export function answer(message: Message, version: string): Reply | undefined | "crash" {
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
      return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${String(name)}` } };
    }
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}

export async function attach(server: McpTransport, version: string): Promise<void> {
  await server.start();
  server.onMessage((message) => {
    const reply = answer(message as Message, version);
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
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const reply = answer(JSON.parse(line) as Message, version);
    if (reply === "crash") process.exit(1);
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
