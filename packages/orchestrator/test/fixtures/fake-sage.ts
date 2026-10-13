/**
 * A stand-in for sagemath-mcp 0.9.5 in tests, over an in-memory transport: `evaluate_sage` runs a
 * toy language in the workspace named by `session`, `stop_sage_session` ends a workspace.
 *
 * The toy language: `name = text` defines a name (a statement); `name` alone returns its text, or
 * is refused with the server's message when the workspace has not assigned it; `print(text)`
 * prints; `fail` fails with an empty message, as some of Sage's errors do; anything else returns
 * `eval(code)`.
 */
import type { JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

export interface FakeSage {
  /** The workspaces, by name, each a map of the names it defined. */
  workspaces: Map<string, Map<string, string>>;
  /** Every tool call, in order. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** A client transport to a fresh connection of this server, for `Registry`'s `mcpTransport`. */
  transport(): McpTransport;
}

export function fakeSage(version = "0.9.5"): FakeSage {
  const workspaces = new Map<string, Map<string, string>>();
  const calls: FakeSage["calls"] = [];
  const tools = ["evaluate_sage", "stop_sage_session"].map((name) => ({ name, inputSchema: { type: "object" } }));
  const evaluate = (code: string, session: string) => {
    const space = workspaces.get(session) ?? new Map<string, string>();
    workspaces.set(session, space);
    const value = (result_type: string, result: string | null, stdout = "") => ({ result_type, result, latex: null, stdout, elapsed_ms: 1.5 });
    const assignment = /^(\w+)\s*=\s*(.+)$/.exec(code);
    if (assignment) {
      space.set(assignment[1] as string, assignment[2] as string);
      return value("statement", null);
    }
    const printed = /^print\((.*)\)$/.exec(code);
    if (printed) return value("expression", null, `${printed[1]}\n`);
    if (code === "fail") return new Error("");
    if (/^\w+$/.test(code)) return space.has(code) ? value("expression", space.get(code) as string) : new Error(refusal(code));
    return value("expression", `eval(${code})`);
  };
  const answer = (message: Message): Record<string, unknown> | undefined => {
    if (message.id === undefined) return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    const toolError = (text: string) => ok({ content: [{ type: "text", text }], isError: true });
    switch (message.method) {
      case "initialize":
        return ok({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sagemath-mcp", version } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools });
      case "tools/call": {
        const tool = String(message.params?.name);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        calls.push({ tool, args });
        if (tool === "stop_sage_session") {
          const name = String(args.name);
          if (!workspaces.delete(name)) return toolError(`No Sage session named ${name} for this client`);
          return ok({ content: [{ type: "text", text: "stopped" }], structuredContent: { message: `Session ${name} stopped` } });
        }
        const result = evaluate(String(args.code), String(args.session ?? "default"));
        if (result instanceof Error) return toolError(result.message);
        return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
    }
  };
  return {
    workspaces,
    calls,
    transport() {
      const { client, server } = createInMemoryTransportPair();
      void server.start().then(() =>
        server.onMessage((message) => {
          const reply = answer(message as Message);
          if (reply !== undefined) void server.send(reply as unknown as JsonRpcMessage);
        }),
      );
      return client;
    },
  };
}

/** What sagemath-mcp 0.9.5 says of a name the session has not assigned. */
export function refusal(name: string): string {
  return (
    `'${name}' is not a name this server offers. If it is a typo, check the spelling; if it is a SageMath ` +
    "function that should be available, it needs to be added to the allowlist"
  );
}
