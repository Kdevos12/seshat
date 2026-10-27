import { type CallToolResult, McpClient, type McpTransport, StdioTransport } from "@earendil-works/pi-mcp";
import type { Json } from "@seshat/core";
import { McpToolError, messageOf, toOutput, UnavailableError } from "@seshat/registry";
import { ALLOWED_TOOLS, type AllowedTool, isAllowedTool } from "./protocol.ts";

const CLIENT = { name: "seshat", version: "0.0.0" };
/** pi-mcp's own request timer is set past the registry's, so that the registry's fires first. */
const REQUEST_SLACK_MS = 5_000;

/** The tool ran and refused or failed on this input; `said` is its message as it wrote it. */
export class ServerFailure extends Error {
  readonly tool: AllowedTool;
  readonly said: string;

  constructor(tool: AllowedTool, said: string) {
    super(`${tool}: ${said.slice(0, 300) || "(no message)"}`);
    this.tool = tool;
    this.said = said;
  }
}

interface Connection {
  client: McpClient;
  transport: McpTransport;
  /** Tools the server lists that the harness does not use (it never calls them). */
  extra: string[];
}

export interface ServerOptions {
  /** The version the server must report (the manifest's pin). */
  version: string;
  /** Opens a new transport to a new server process; called at every (re)connection. */
  transport: () => McpTransport;
}

/**
 * A connection to a lean-lsp-mcp server, opened on first use, kept, and opened again after the
 * server goes away. It checks the pinned version and the eight tools the harness uses, and it
 * calls nothing else: the allowlist is enforced here, on every call, whatever the server offers.
 */
export class LeanLspServer {
  private readonly options: ServerOptions;
  private pending: Promise<Connection> | undefined;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  /** Calls one of the allowed tools. A server that went away is `UnavailableError`; a tool's refusal is `ServerFailure`. */
  async call(tool: AllowedTool, args: Record<string, unknown>, context: { signal: AbortSignal; timeoutMs: number }): Promise<Json> {
    if (!isAllowedTool(tool)) throw new Error(`the harness does not call ${String(tool)}`);
    const { client, transport } = await this.connect();
    let result: CallToolResult;
    try {
      result = await client.callTool(tool, args, { signal: context.signal, timeoutMs: context.timeoutMs + REQUEST_SLACK_MS });
    } catch (error) {
      if (!context.signal.aborted && client.connectionState === "closed") {
        throw new UnavailableError(`the Lean language server stopped: ${messageOf(error)}${stderrOf(transport)}`);
      }
      throw error;
    }
    try {
      return toOutput(result);
    } catch (error) {
      if (error instanceof McpToolError) throw new ServerFailure(tool, error.toolMessage);
      throw error;
    }
  }

  /** Connects if needed and pings; what the server reports, for the health check. Does not touch Lean. */
  async health(signal: AbortSignal): Promise<string> {
    const { client, extra } = await this.connect();
    await client.ping({ signal });
    const info = client.serverInfo;
    const others = extra.length > 0 ? `; it also lists ${extra.length} tool(s) that the harness never calls` : "";
    return `${info ? `${info.name} ${info.version}` : "lean-lsp-mcp"}, ${ALLOWED_TOOLS.length} tools used${others}`;
  }

  async close(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    const connection = await pending?.catch(() => undefined);
    await connection?.client.close();
  }

  private connect(): Promise<Connection> {
    if (this.pending === undefined) {
      const pending: Promise<Connection> = this.open(() => {
        if (this.pending === pending) this.pending = undefined;
      });
      this.pending = pending;
      pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    return this.pending;
  }

  private async open(onClose: () => void): Promise<Connection> {
    const client = new McpClient(CLIENT);
    const transport = this.options.transport();
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      throw new UnavailableError(`cannot start the Lean language server: ${messageOf(error)}${stderrOf(transport)}`);
    }
    client.onClose(onClose);
    try {
      const reported = client.serverInfo?.version;
      if (reported !== this.options.version) {
        throw new UnavailableError(`the MCP server reports version ${reported}, the manifest pins ${this.options.version}`);
      }
      const listed = (await client.listTools()).map((tool) => tool.name);
      const missing = ALLOWED_TOOLS.filter((tool) => !listed.includes(tool));
      if (missing.length > 0) throw new UnavailableError(`the MCP server has no tool ${missing.join(", ")} (it has ${listed.join(", ") || "none"})`);
      return { client, transport, extra: listed.filter((name) => !isAllowedTool(name)) };
    } catch (error) {
      await client.close().catch(() => {});
      throw error instanceof UnavailableError ? error : new UnavailableError(messageOf(error));
    }
  }
}

function stderrOf(transport: McpTransport): string {
  if (!(transport instanceof StdioTransport)) return "";
  const text = transport.stderr.replace(/\s+/g, " ").trim();
  return text === "" ? "" : ` (stderr: ${text.slice(-400)})`;
}
