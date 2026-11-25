import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  ACP_PROTOCOL_VERSION,
  type AcpAgentInfo,
  type AcpMcpServer,
  cancelParams,
  INTERNAL_ERROR,
  initializeParams,
  METHOD_NOT_FOUND,
  METHODS,
  newSessionParams,
  optionFor,
  type PermissionRequest,
  permissionOutcome,
  promptParams,
  readInitialize,
  readPermissionRequest,
  readSessionId,
  readStopReason,
  readUpdate,
} from "./acp-protocol.ts";
import { type AcpSettings, type AgentRun, type AgentRunner, killProcessGroup, trackProcessGroup } from "./agent.ts";

/** One answer Seshat gave to a `session/request_permission`, as the build's record keeps it. */
export interface PermissionAnswer {
  toolCallId: string;
  kind: string;
  title?: string;
  paths: string[];
  decision: "allow" | "deny";
  reason: string;
  /** The option chosen, or `cancelled` when none fitted or the turn was being cancelled. */
  answer: string;
}

/** What the agent reported of its usage (`usage_update`): the last values, and how many reports came. */
export interface AcpUsage {
  reports: number;
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
}

/** What an ACP run recorded besides the agent's text: the build's provenance keeps it, and `recordBuild` journals it. */
export interface AcpRecord {
  agent?: AcpAgentInfo;
  sessionId?: string;
  stopReason?: string;
  /** The names of the MCP servers passed in `session/new`. */
  mcpServers: string[];
  permissions: PermissionAnswer[];
  /** Requests of the agent that Seshat does not serve (`fs/*`, `terminal/*`, anything else), answered "method not found". */
  refused: Array<{ method: string; path?: string }>;
  usage?: AcpUsage;
  /** Why Seshat sent `session/cancel`: the time limit, an abort, or a reported cost at the dollar budget. */
  cancelled?: "timeout" | "abort" | "budget";
  /** Lines of the agent's standard output that were not JSON-RPC messages. */
  ignoredLines: number;
}

export interface AcpRunnerConfig {
  settings?: AcpSettings;
  /** The build's dollar budget: a reported cost (in USD) at or above it makes Seshat cancel the turn; the files are judged as usual. */
  budgetUsd?: number;
  /** The longest line the agent may write, in bytes; a longer one ends the run. Default 4 MiB. */
  maxLineBytes?: number;
}

/** The tool kinds denied when the settings name none: the network is the sandbox's to give, and the CLI transport's print mode denies a fetch too. */
export const DEFAULT_DENIED_KINDS: readonly string[] = ["fetch"];

const TAIL = 8000;
const MAX_ANSWERS = 200;
const MAX_REFUSED = 50;

/** The most links followed in one path, as the kernel's limit (ELOOP); a path with more is judged outside. */
const MAX_LINKS = 40;

/**
 * `path` (absolute) resolved one component at a time as the kernel would: a link is read where it stands and followed, and `..`
 * goes to the parent of what the components before it resolved to, not of what they spell. The part that does not exist yet is
 * appended as written; a `..` in that part has no parent to resolve, and the path is refused (undefined), as it is past MAX_LINKS.
 * An error other than a missing component (a name too long, a directory that cannot be searched) is thrown.
 */
function physicalPath(path: string): string | undefined {
  const todo = path.split("/").reverse();
  let current = "/";
  let links = 0;
  let missing = false;
  while (todo.length > 0) {
    const part = todo.pop() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (missing) return undefined;
      current = dirname(current);
      continue;
    }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    if (!missing) {
      let stat: Stats;
      try {
        stat = lstatSync(next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        missing = true;
        current = next;
        continue;
      }
      if (stat.isSymbolicLink()) {
        links += 1;
        if (links > MAX_LINKS) return undefined;
        const target = readlinkSync(next);
        todo.push(...target.split("/").reverse());
        if (target.startsWith("/")) current = "/";
        continue;
      }
    }
    current = next;
  }
  return current;
}

/**
 * Whether `path` (absolute, or relative to `root`) is `root` or inside it, every component resolved physically (`physicalPath`).
 * A path that is empty, holds a NUL byte, starts with `~` (a home the agent's tools may expand) or is a URI (`file://...`) is
 * judged outside: what it names is the agent's to interpret, not Seshat's.
 */
export function insideDirectory(root: string, path: string): boolean {
  if (path === "" || path.includes("\0") || path.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
  const absolute = (p: string) => (isAbsolute(p) ? p : `${process.cwd()}/${p}`);
  const realRoot = physicalPath(absolute(root));
  const real = physicalPath(isAbsolute(path) ? path : `${absolute(root)}/${path}`);
  if (realRoot === undefined || real === undefined) return false;
  return real === realRoot || real.startsWith(realRoot === "/" ? "/" : `${realRoot}/`);
}

/**
 * The policy of plan change EA2: a denied kind is refused, a path outside the clone is refused, everything else is allowed. A path
 * that cannot be resolved is refused with the reason. The answer is advisory: the agent's tool acts after it, on a path that may have
 * changed in between, so only the sandbox confines the agent (documentation/library-builder.md, "Transports").
 */
export function decidePermission(request: PermissionRequest, o: { clone: string; deny: readonly string[] }): { decision: "allow" | "deny"; reason: string } {
  if (o.deny.includes(request.kind)) return { decision: "deny", reason: `the settings deny the tool kind ${request.kind}` };
  for (const path of request.paths) {
    let inside: boolean;
    try {
      inside = insideDirectory(o.clone, path);
    } catch (error) {
      return { decision: "deny", reason: `${path.slice(0, 200)} could not be resolved: ${(error as Error).message.slice(0, 200)}` };
    }
    if (!inside) return { decision: "deny", reason: `${path.slice(0, 200)} is outside the clone` };
  }
  return { decision: "allow", reason: request.paths.length > 0 ? "inside the clone" : "no path outside the clone" };
}

/** `{clone}` in a server's command, arguments and variables, replaced by the clone's directory. */
function inClone(server: AcpMcpServer, clone: string): AcpMcpServer {
  const fill = (v: string) => v.replaceAll("{clone}", clone);
  return {
    name: server.name,
    command: fill(server.command),
    args: (server.args ?? []).map(fill),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, fill(v)])),
  };
}

type Stop = { stop: "timeout" | "abort" | "exit" | "fatal"; code?: number | null; detail?: string };
type Outcome = { value: unknown } | { error: string } | Stop;

interface Launched {
  child: ChildProcessWithoutNullStreams | undefined;
  send(message: Record<string, unknown>): void;
  /** Settles once, with the first of: the time limit, the abort, the end of the process, a line too long. */
  stopped: Promise<Stop>;
  /** The agent's answer, or the stop that came first. */
  request(method: string, params: Record<string, unknown>): Promise<Outcome>;
  /** The agent's answer alone: it never settles if none comes. */
  answer(method: string, params: Record<string, unknown>): Promise<{ value: unknown } | { error: string }>;
  kill(): void;
}

/**
 * Starts the agent in a process group of its own and speaks JSON-RPC 2.0 to it, one message per line. Requests of the agent go to
 * `onRequest`, notifications to `onNotification`; a line that is not a JSON-RPC message is counted and ignored.
 */
function launch(
  argv: readonly string[],
  o: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    maxLineBytes: number;
    keep: (text: string) => void;
    onRequest: (method: string, params: unknown) => Promise<{ result: unknown } | { error: { code: number; message: string } }>;
    onNotification: (method: string, params: unknown) => void;
    onIgnored: () => void;
  },
): Launched {
  let settle: (s: Stop) => void = () => {};
  const stopped = new Promise<Stop>((r) => {
    settle = r;
  });
  let done = false;
  const stop = (s: Stop) => {
    if (done) return;
    done = true;
    settle(s);
  };
  const pending = new Map<number, (outcome: { value: unknown } | { error: string }) => void>();
  let next = 1;
  const [program, ...args] = argv;
  if (program === undefined) {
    stop({ stop: "exit", code: null, detail: "no command" });
    return { child: undefined, send: () => {}, stopped, request: async () => await stopped, answer: async () => await new Promise(() => {}), kill: () => {} };
  }
  const child = spawn(program, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  trackProcessGroup(child);
  const kill = () => killProcessGroup(child);
  const timer = setTimeout(() => stop({ stop: "timeout" }), o.timeoutMs);
  const onAbort = () => stop({ stop: "abort" });
  if (o.signal?.aborted === true) onAbort();
  else o.signal?.addEventListener("abort", onAbort, { once: true });
  void stopped.then(() => {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  });

  const send = (message: Record<string, unknown>) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  child.stdin.on("error", () => {});

  const handle = (line: string) => {
    if (line.trim() === "") return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).jsonrpc !== "2.0") throw new Error("not JSON-RPC");
      message = parsed as Record<string, unknown>;
    } catch {
      o.onIgnored();
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      if (id === undefined || id === null) {
        o.onNotification(message.method, message.params);
        return;
      }
      if (typeof id !== "string" && typeof id !== "number") return o.onIgnored();
      // A handler that throws answers an internal error: an unhandled rejection would end the harness and leave the agent running.
      const method = message.method;
      void o
        .onRequest(method, message.params)
        .catch((error: unknown) => ({ error: { code: INTERNAL_ERROR, message: `the client failed on ${method.slice(0, 60)}: ${String((error as Error | undefined)?.message ?? error).slice(0, 200)}` } }))
        .then((answer) => send({ id, ...answer }));
      return;
    }
    if (typeof id === "number" && pending.has(id)) {
      const resolveCall = pending.get(id) as (outcome: { value: unknown } | { error: string }) => void;
      pending.delete(id);
      if ("error" in message) {
        const error = (message.error ?? {}) as Record<string, unknown>;
        resolveCall({ error: `${typeof error.message === "string" ? error.message.slice(0, 300) : "error"} (${String(error.code ?? "?")})` });
      } else resolveCall({ value: message.result });
      return;
    }
    o.onIgnored();
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      handle(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > o.maxLineBytes) {
      buffer = "";
      stop({ stop: "fatal", detail: `the agent wrote a line longer than ${o.maxLineBytes} bytes` });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => o.keep(chunk));
  child.on("error", (error) => {
    o.keep(error.message);
    stop({ stop: "exit", code: null, detail: error.message });
  });
  child.on("close", (code) => stop({ stop: "exit", code }));
  // A descendant that left the process group keeps the pipes open and `close` never comes: a second after the exit, the pipes are cut.
  child.on("exit", (code) => {
    setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      stop({ stop: "exit", code });
    }, 1000).unref();
  });

  const answer = (method: string, params: Record<string, unknown>): Promise<{ value: unknown } | { error: string }> => {
    const id = next++;
    const answered = new Promise<{ value: unknown } | { error: string }>((r) => pending.set(id, r));
    send({ id, method, params });
    return answered;
  };
  const request = async (method: string, params: Record<string, unknown>): Promise<Outcome> => await Promise.race([answer(method, params), stopped]);
  return { child, send, stopped, request, answer, kill };
}

const said = (o: Outcome): string => ("error" in o ? o.error : "stop" in o ? (o.detail ?? o.stop) : "");

/**
 * The ACP transport of the `coding-agent` builder (plan change EA2): a runner with the shape of the CLI's, so the builder and its gate
 * are the same for both. It starts the agent's ACP command (the sandbox in front, the environment the builder gives), then
 * `initialize` (no `fs`, no `terminal`), `session/new` in the clone with the settings' MCP servers, and `session/prompt` with the
 * spec's prompt; it answers permission requests by the settings' policy and refuses every other request of the agent. At the time
 * limit, on abort, or at a reported cost that reaches the dollar budget it sends `session/cancel`; after the time limit or an abort
 * it waits `cancelGraceSec` and kills the process group, as the CLI transport does. The exit code it returns is 0 when the turn
 * ended, 1 when the agent answered the prompt with an error, and null when the protocol never reached the prompt: like the CLI's,
 * it is never a verdict, and the gate reads the files.
 */
export function acpAgentRunner(config: AcpRunnerConfig = {}): AgentRunner {
  return async (argv, { cwd, env, stdin, timeoutMs, signal }) => {
    const started = performance.now();
    const servers = (config.settings?.mcpServers ?? []).map((s) => inClone(s, cwd));
    const deny = config.settings?.deny ?? DEFAULT_DENIED_KINDS;
    const graceMs = (config.settings?.cancelGraceSec ?? 5) * 1000;
    const record: AcpRecord = { mcpServers: servers.map((s) => s.name), permissions: [], refused: [], ignoredLines: 0 };
    let tail = "";
    const keep = (text: string) => {
      tail = (tail + text).slice(-TAIL);
    };
    let sessionId: string | undefined;
    let cancelling = false;
    let agent: Launched | undefined;
    const cancel = (why: NonNullable<AcpRecord["cancelled"]>) => {
      if (cancelling || sessionId === undefined) return;
      cancelling = true;
      record.cancelled = why;
      agent?.send({ method: METHODS.cancel, params: cancelParams(sessionId) });
    };
    agent = launch(argv, {
      cwd,
      env,
      timeoutMs,
      signal,
      maxLineBytes: config.maxLineBytes ?? 4 * 1024 * 1024,
      keep,
      onIgnored: () => {
        record.ignoredLines += 1;
      },
      onRequest: async (method, params) => {
        if (method === METHODS.requestPermission) {
          const request = readPermissionRequest(params);
          const { decision, reason } = cancelling ? { decision: "deny" as const, reason: "the turn is being cancelled" } : decidePermission(request, { clone: cwd, deny });
          const optionId = cancelling ? undefined : optionFor(request, decision);
          if (record.permissions.length < MAX_ANSWERS) {
            record.permissions.push({ toolCallId: request.toolCallId, kind: request.kind, ...(request.title !== undefined ? { title: request.title } : {}), paths: request.paths.slice(0, 5).map((p) => p.slice(0, 200)), decision, reason, answer: optionId ?? "cancelled" });
          }
          return { result: permissionOutcome(optionId) };
        }
        const path = (params as Record<string, unknown> | null)?.path;
        if (record.refused.length < MAX_REFUSED) record.refused.push({ method: method.slice(0, 60), ...(typeof path === "string" ? { path: path.slice(0, 200) } : {}) });
        return { error: { code: METHOD_NOT_FOUND, message: `${method.slice(0, 60)} is not served: Seshat declares no fs and no terminal capability` } };
      },
      onNotification: (method, params) => {
        if (method !== METHODS.update) return;
        const update = readUpdate(params);
        if (update.kind === "text") keep(update.text);
        else if (update.kind === "usage") {
          const usage: AcpUsage = { ...(record.usage ?? { reports: 0 }) };
          usage.reports += 1;
          if (update.used !== undefined) usage.used = update.used;
          if (update.size !== undefined) usage.size = update.size;
          if (update.cost !== undefined) usage.cost = update.cost;
          record.usage = usage;
          if (config.budgetUsd !== undefined && usage.cost?.currency === "USD" && usage.cost.amount >= config.budgetUsd) cancel("budget");
        }
      },
    });
    const a = agent;
    const end = (code: number | null, flags: { timedOut?: boolean; aborted?: boolean } = {}, note?: string): AgentRun => {
      a.kill();
      if (note !== undefined) keep(`\nacp: ${note}`);
      if (sessionId !== undefined) record.sessionId = sessionId;
      return { code, timedOut: flags.timedOut === true, aborted: flags.aborted === true, output: tail, ms: Math.round(performance.now() - started), acp: record };
    };
    const stopped = (o: Outcome, step: string): AgentRun | undefined => {
      if ("value" in o) return undefined;
      if ("error" in o) return end(null, {}, `the agent refused ${step}: ${o.error}`);
      if (o.stop === "timeout") return end(null, { timedOut: true }, `no answer to ${step} within the time limit`);
      if (o.stop === "abort") return end(null, { aborted: true });
      return end(null, {}, o.stop === "fatal" ? `${said(o)}, before answering ${step}` : `the agent exited before answering ${step}${o.detail !== undefined ? `: ${o.detail}` : ""}`);
    };

    const init = await a.request(METHODS.initialize, initializeParams());
    const initStop = stopped(init, METHODS.initialize);
    if (initStop !== undefined) return initStop;
    record.agent = readInitialize((init as { value: unknown }).value);
    if (record.agent.protocolVersion !== ACP_PROTOCOL_VERSION) return end(null, {}, `the agent speaks protocol version ${String(record.agent.protocolVersion)}, and Seshat speaks ${ACP_PROTOCOL_VERSION}`);

    const created = await a.request(METHODS.newSession, newSessionParams(cwd, servers));
    const createdStop = stopped(created, METHODS.newSession);
    if (createdStop !== undefined) return createdStop;
    sessionId = readSessionId((created as { value: unknown }).value);
    if (sessionId === undefined) return end(null, {}, `${METHODS.newSession} answered no sessionId`);

    const turn = a.answer(METHODS.prompt, promptParams(sessionId, stdin));
    const first: Outcome = await Promise.race([turn, a.stopped]);
    if ("stop" in first && (first.stop === "timeout" || first.stop === "abort")) {
      cancel(first.stop);
      // The agent has the grace period to answer the cancelled turn; then its process group is killed whatever it does.
      const late = await Promise.race([turn, new Promise<undefined>((r) => setTimeout(() => r(undefined), graceMs).unref())]);
      if (late !== undefined && "value" in late) {
        const reason = readStopReason(late.value);
        if (reason !== undefined) record.stopReason = reason;
      }
      return first.stop === "timeout" ? end(null, { timedOut: true }, "cancelled at the time limit") : end(null, { aborted: true });
    }
    if ("value" in first) {
      const reason = readStopReason(first.value);
      if (reason !== undefined) record.stopReason = reason;
      return end(0);
    }
    if ("error" in first) return end(1, {}, `the agent answered ${METHODS.prompt} with an error: ${first.error}`);
    if (first.stop === "fatal") return end(null, {}, said(first));
    return end(first.code ?? null, {}, `the agent exited before answering ${METHODS.prompt}`);
  };
}

/** What `harness doctor` learns from an ACP agent: `initialize` and nothing else, so no session, no prompt and no model call. */
export type AcpProbe = { ok: true; agent: AcpAgentInfo; ms: number } | { ok: false; reason: string; ms: number };

export async function probeAcp(argv: readonly string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<AcpProbe> {
  const started = performance.now();
  let tail = "";
  const agent = launch(argv, {
    ...o,
    maxLineBytes: 1024 * 1024,
    keep: (text) => {
      tail = (tail + text).slice(-2000);
    },
    onIgnored: () => {},
    onRequest: async (method) => ({ error: { code: METHOD_NOT_FOUND, message: `${method.slice(0, 60)} is not served` } }),
    onNotification: () => {},
  });
  const answer = await agent.request(METHODS.initialize, initializeParams());
  agent.kill();
  const ms = Math.round(performance.now() - started);
  if ("value" in answer) return { ok: true, agent: readInitialize(answer.value), ms };
  const last = tail.trim().split("\n").pop() ?? "";
  if ("error" in answer) return { ok: false, reason: `initialize was refused: ${answer.error}`, ms };
  if (answer.stop === "timeout") return { ok: false, reason: `no answer to initialize within ${o.timeoutMs / 1000} s`, ms };
  return { ok: false, reason: `${answer.stop === "fatal" ? said(answer) : "the program exited before answering initialize"}${last !== "" ? ` (it said: ${last.slice(0, 200)})` : ""}`, ms };
}
