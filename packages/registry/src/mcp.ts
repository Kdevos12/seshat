import { McpClient, StdioTransport, StreamableHttpTransport, type CallToolResult, type McpTransport } from "@earendil-works/pi-mcp";
import type { Json } from "@seshat/core";
import type { McpImplementationSpec, McpServerSpec } from "./manifest.ts";
import { messageOf, UnavailableError, type HealthCheck, type ImplementationInstance, type InvokeContext } from "./implementation.ts";

const CLIENT = { name: "seshat", version: "0.0.0" };
/** pi-mcp's own request timer is set past the registry's, so that the registry's fires first. */
const REQUEST_SLACK_MS = 5_000;

/**
 * The variables a stdio server gets from the harness's environment, besides its own `env`: what
 * programs need to start (and Docker to find its daemon), never the harness's credentials.
 */
export const PASSED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "XDG_RUNTIME_DIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
] as const;

export function serverEnv(own: Record<string, string> | undefined, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...own };
}

export function defaultMcpTransport(server: McpServerSpec): McpTransport {
  if (server.transport === "stdio") {
    return new StdioTransport({
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      env: serverEnv(server.env),
      inheritEnv: false,
      stderr: "pipe",
    });
  }
  return new StreamableHttpTransport({ url: server.url, ...(server.headers !== undefined ? { headers: server.headers } : {}) });
}

/**
 * A capability provided by one tool of an MCP server. The connection is opened on first use,
 * kept, and opened again after the server goes away. On connection the server must report the
 * pinned version (unless `versionCheck` is false) and offer the tool.
 *
 * The capability's input is passed as the tool's arguments, with the call's scope under the
 * spec's scope argument. The output is the result's `structuredContent`, or else its single text
 * block read as JSON. A result with `isError` is a failure.
 */
export class McpImplementation implements ImplementationInstance {
  private readonly spec: McpImplementationSpec;
  private readonly server: McpServerSpec;
  private readonly transport: (server: McpServerSpec, spec: McpImplementationSpec) => McpTransport;
  private pending: Promise<Connection> | undefined;

  constructor(spec: McpImplementationSpec, server: McpServerSpec, transport: (server: McpServerSpec, spec: McpImplementationSpec) => McpTransport) {
    this.spec = spec;
    this.server = server;
    this.transport = transport;
  }

  async invoke(input: Json, context: InvokeContext): Promise<Json> {
    const { client, scopes } = await this.connect();
    const args = { ...(input as Record<string, unknown>) };
    const scope = this.spec.scope;
    if (scope !== undefined && context.scope !== undefined) {
      args[scope.argument] = context.scope;
      scopes.add(context.scope);
    }
    const result = await client.callTool(this.spec.tool, args, {
      signal: context.signal,
      timeoutMs: context.timeoutMs + REQUEST_SLACK_MS,
    });
    return toOutput(result);
  }

  async release(scope: string, context: { signal: AbortSignal }): Promise<void> {
    // Only the current connection's scopes: a server that went away took its state with it.
    const connection = await this.pending?.catch(() => undefined);
    if (connection === undefined || !connection.scopes.delete(scope)) return;
    const release = this.spec.scope?.release;
    if (release !== undefined) await connection.client.callTool(release.tool, { [release.argument]: scope }, { signal: context.signal });
  }

  async health(context: { signal: AbortSignal }): Promise<HealthCheck> {
    const { client } = await this.connect();
    await client.ping({ signal: context.signal });
    const info = client.serverInfo;
    return { ok: true, detail: info ? `${info.name} ${info.version}` : "connected" };
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
    const transport = this.transport(this.server, this.spec);
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      throw new UnavailableError(`cannot connect to the MCP server: ${messageOf(error)}${stderrOf(transport)}`);
    }
    client.onClose(onClose);
    try {
      const reported = client.serverInfo?.version;
      if (this.spec.versionCheck !== false && reported !== this.spec.version) {
        throw new UnavailableError(`the MCP server reports version ${reported}, the manifest pins ${this.spec.version}`);
      }
      const tools = await client.listTools();
      if (!tools.some((tool) => tool.name === this.spec.tool)) {
        throw new UnavailableError(`the MCP server has no tool ${this.spec.tool} (it has ${tools.map((t) => t.name).join(", ") || "none"})`);
      }
    } catch (error) {
      await client.close().catch(() => {});
      throw error instanceof UnavailableError ? error : new UnavailableError(messageOf(error));
    }
    return { client, scopes: new Set() };
  }
}

/** One connection to the server, and the scopes called on it. */
interface Connection {
  client: McpClient;
  scopes: Set<string>;
}

/** A result with `isError`: the tool ran and refused or failed on this input. */
export class McpToolError extends Error {
  /** The tool's own message, as it wrote it (possibly empty). */
  readonly toolMessage: string;

  constructor(toolMessage: string) {
    super(`the tool reported an error: ${toolMessage.slice(0, 1000) || "(no message)"}`);
    this.toolMessage = toolMessage;
  }
}

export function toOutput(result: CallToolResult): Json {
  const texts = result.content.filter((block) => block.type === "text").map((block) => block.text);
  if (result.isError === true) throw new McpToolError(texts.join("\n"));
  if (result.structuredContent !== undefined) return result.structuredContent as Json;
  if (texts.length !== 1) throw new Error("the tool returned no structured content and not exactly one text block");
  try {
    return JSON.parse(texts[0] as string) as Json;
  } catch {
    throw new Error(`the tool returned text that is not JSON: ${(texts[0] as string).slice(0, 200)}`);
  }
}

function stderrOf(transport: McpTransport): string {
  if (!(transport instanceof StdioTransport)) return "";
  const text = transport.stderr.trim();
  return text === "" ? "" : ` (stderr: ${text.slice(-500)})`;
}
