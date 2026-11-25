/**
 * The messages of the Agent Client Protocol (ACP) that the `coding-agent` builder speaks as a client (plan change EA2,
 * documentation/library-builder.md, "Transports"). Every method name and field name Seshat sends or reads is in this module and
 * nowhere else.
 *
 * They follow ACP protocol version 1, as agentclientprotocol.com documents it on 2026-11-25 (protocol/v1: initialization, session
 * setup, prompt turn, tool calls, and the `usage_update` session update stabilized on 2026-06-05). Seshat implements them itself
 * over JSON-RPC 2.0, one message per line on the agent's standard input and output, with no SDK. They have been run against a fake
 * agent only: check them against a real agent before relying on them (documentation/library-builder.md, "Not run").
 */

/** The one protocol version Seshat speaks. An agent that answers another is refused. */
export const ACP_PROTOCOL_VERSION = 1;

export const METHODS = {
  initialize: "initialize",
  newSession: "session/new",
  prompt: "session/prompt",
  cancel: "session/cancel",
  update: "session/update",
  requestPermission: "session/request_permission",
} as const;

/** The JSON-RPC error code for a method the client does not serve (`fs/*`, `terminal/*`, anything else). */
export const METHOD_NOT_FOUND = -32601;

/** The JSON-RPC error code Seshat answers when its own handling of a request failed. */
export const INTERNAL_ERROR = -32603;

/** The tool kinds ACP names; `fetch` is the one that reaches the network. */
export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"] as const;

/**
 * `initialize`: Seshat declares no `fs` and no `terminal` capability, so the agent reads and writes files with its own tools,
 * inside the sandbox, and the gate reads what it left.
 */
export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "seshat", version: "0" },
  };
}

/** What `initialize` answered, as far as Seshat reads it. */
export interface AcpAgentInfo {
  protocolVersion: number | undefined;
  loadSession: boolean;
  mcp: { http: boolean; sse: boolean };
  /** The agent's own name and version, when it says them (`agentInfo`). */
  name?: string;
  version?: string;
}

export function readInitialize(result: unknown): AcpAgentInfo {
  const r = (result ?? {}) as Record<string, unknown>;
  const caps = (r.agentCapabilities ?? {}) as Record<string, unknown>;
  const mcp = (caps.mcpCapabilities ?? {}) as Record<string, unknown>;
  const info = (r.agentInfo ?? {}) as Record<string, unknown>;
  return {
    protocolVersion: typeof r.protocolVersion === "number" ? r.protocolVersion : undefined,
    loadSession: caps.loadSession === true,
    mcp: { http: mcp.http === true, sse: mcp.sse === true },
    ...(typeof info.name === "string" ? { name: info.name.slice(0, 80) } : {}),
    ...(typeof info.version === "string" ? { version: info.version.slice(0, 40) } : {}),
  };
}

/** An MCP server the agent is asked to connect to, as the settings write it. `{clone}` in any value is the clone's directory. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** `session/new`: the clone as the working directory, and the MCP servers (stdio) in ACP's shape. */
export function newSessionParams(cwd: string, servers: readonly AcpMcpServer[]): Record<string, unknown> {
  return {
    cwd,
    mcpServers: servers.map((s) => ({ name: s.name, command: s.command, args: [...(s.args ?? [])], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) })),
  };
}

export function readSessionId(result: unknown): string | undefined {
  const id = (result as Record<string, unknown> | null)?.sessionId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** `session/prompt`: the spec's prompt as one text block. */
export function promptParams(sessionId: string, text: string): Record<string, unknown> {
  return { sessionId, prompt: [{ type: "text", text }] };
}

export function readStopReason(result: unknown): string | undefined {
  const reason = (result as Record<string, unknown> | null)?.stopReason;
  return typeof reason === "string" ? reason.slice(0, 40) : undefined;
}

export function cancelParams(sessionId: string): Record<string, unknown> {
  return { sessionId };
}

/** What one `session/update` notification says that Seshat keeps: the agent's text, and what it reports of its usage. */
export type AcpUpdate =
  | { kind: "text"; text: string }
  | { kind: "usage"; used?: number; size?: number; cost?: { amount: number; currency: string } }
  | { kind: "other"; name: string };

export function readUpdate(params: unknown): AcpUpdate {
  const update = ((params as Record<string, unknown> | null)?.update ?? {}) as Record<string, unknown>;
  const name = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  if (name === "agent_message_chunk") {
    const content = (update.content ?? {}) as Record<string, unknown>;
    return { kind: "text", text: content.type === "text" && typeof content.text === "string" ? content.text : "" };
  }
  if (name === "usage_update") {
    const cost = (update.cost ?? undefined) as Record<string, unknown> | undefined;
    const amount = cost?.amount;
    return {
      kind: "usage",
      ...(typeof update.used === "number" ? { used: update.used } : {}),
      ...(typeof update.size === "number" ? { size: update.size } : {}),
      ...(typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && typeof cost?.currency === "string" ? { cost: { amount, currency: cost.currency.slice(0, 16) } } : {}),
    };
  }
  return { kind: "other", name: name.slice(0, 40) };
}

/** A `session/request_permission` as Seshat reads it: the tool call's id, kind, title and paths, and the options offered. */
export interface PermissionRequest {
  toolCallId: string;
  kind: string;
  title?: string;
  paths: string[];
  options: Array<{ optionId: string; kind: string }>;
}

export function readPermissionRequest(params: unknown): PermissionRequest {
  const p = (params ?? {}) as Record<string, unknown>;
  const call = (p.toolCall ?? {}) as Record<string, unknown>;
  const locations = Array.isArray(call.locations) ? call.locations : [];
  const options = Array.isArray(p.options) ? p.options : [];
  return {
    toolCallId: typeof call.toolCallId === "string" ? call.toolCallId.slice(0, 120) : "",
    kind: typeof call.kind === "string" ? call.kind.slice(0, 40) : "other",
    ...(typeof call.title === "string" ? { title: call.title.slice(0, 200) } : {}),
    paths: locations.map((l) => (l as Record<string, unknown> | null)?.path).filter((x): x is string => typeof x === "string"),
    options: options
      .map((o) => o as Record<string, unknown> | null)
      .filter((o): o is Record<string, unknown> => o !== null && typeof o.optionId === "string" && typeof o.kind === "string")
      .map((o) => ({ optionId: o.optionId as string, kind: o.kind as string })),
  };
}

/** The answer to a permission request: the option chosen, or `cancelled` when none fits or the turn is being cancelled. */
export function permissionOutcome(optionId: string | undefined): Record<string, unknown> {
  return { outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId } };
}

/**
 * The option of a permission request for a decision. An allow is `allow_once` only, so that every later request is asked again:
 * when none is offered the answer is `cancelled` (undefined), never `allow_always`. A denial is `reject_once`, else `reject_always`.
 */
export function optionFor(request: PermissionRequest, decision: "allow" | "deny"): string | undefined {
  const order = decision === "allow" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const found = request.options.find((o) => o.kind === kind);
    if (found !== undefined) return found.optionId;
  }
  return undefined;
}
