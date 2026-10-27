/**
 * A fake lean-lsp-mcp 0.31.0 for tests: no Python, no Lean, no network.
 *
 * Imported, `FakeLeanLspMcp.transport()` serves a new in-memory connection per call; run as a script
 * (`node fake-lean-lsp-mcp.ts`), it serves stdio and lists the tools that the environment's
 * LEAN_MCP_DISABLED_TOOLS leaves, as the real server does (`lean_loogle` with the query `env:NAME`
 * then answers with the value of that variable, to see what the harness passed to the child).
 *
 * It lists the eight tools the harness uses (or the ones given), checks every call against the
 * arguments recorded from the real server (lean-lsp-mcp-0.31.0-tools.json) as pydantic does there,
 * reads the file named by `file_path` from the project like the real server (a path outside the
 * project, or a missing file, is an error), and answers with canned values of the real server's
 * shapes. `on` replaces the answer of a tool, `failing` makes a tool fail with a message as the
 * server words it, and `crash()` ends the connection.
 */
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";

interface Recorded {
  tools: Array<{ name: string; required: string[]; properties: Record<string, { types: string[]; minimum?: number; enum?: string[] }> }>;
}

const RECORD = JSON.parse(readFileSync(new URL("./lean-lsp-mcp-0.31.0-tools.json", import.meta.url), "utf8")) as Recorded;

/** The 22 tools of 0.31.0. */
export const ALL_TOOLS: readonly string[] = RECORD.tools.map((t) => t.name);

/** The eight the harness uses: what a server lists when it is started with the harness's LEAN_MCP_DISABLED_TOOLS. */
export const USED_TOOLS = [
  "lean_goal",
  "lean_term_goal",
  "lean_diagnostic_messages",
  "lean_multi_attempt",
  "lean_loogle",
  "lean_leansearch",
  "lean_leanfinder",
  "lean_hammer_premise",
] as const;

/** The goal of the canned answers. */
export const GOAL = "n : Nat\n⊢ n + 0 = n";

type Args = Record<string, unknown>;
export type Outcome = { structured: unknown } | { error: string };
export type Handler = (args: Args, fake: FakeLeanLspMcp) => Outcome;
type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };
type Reply = Record<string, unknown>;

/** A server that answers or closes after the connection went away must not leave a rejection behind. */
function quietly(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export interface FakeOptions {
  version?: string;
  /** The tools the server lists; default: the eight the harness uses. */
  tools?: readonly string[];
  /** The Lean project: `file_path` is read from it. */
  projectDir?: string;
}

export class FakeLeanLspMcp {
  version: string;
  listed: Set<string>;
  projectDir: string | undefined;
  /** Every `tools/call` received, in order, valid or not; `file` is the text of the file the call names, as it was when the call came. */
  readonly calls: Array<{ tool: string; args: Args; file?: string }> = [];
  /** The documents the real server would build for the tactics of each `lean_multi_attempt`, in order (see `buildAttemptText`). */
  readonly trials: Array<{ tactic: string; text: string }> = [];
  /** Connections opened with `transport()`. */
  connections = 0;
  /** The text a tool fails with, until removed. It is worded as the server words an error: the framework adds the prefix. */
  readonly failing = new Map<string, string>();
  private readonly handlers = new Map<string, Handler>();
  private current: { client: InMemoryTransport; server: InMemoryTransport } | undefined;

  constructor(options: FakeOptions = {}) {
    this.version = options.version ?? "0.31.0";
    this.listed = new Set(options.tools ?? USED_TOOLS);
    this.projectDir = options.projectDir;
  }

  /** The calls of one tool. */
  of(tool: string): Args[] {
    return this.calls.filter((c) => c.tool === tool).map((c) => c.args);
  }

  /** Replaces the answer of a tool. */
  on(tool: string, handler: Handler): this {
    this.handlers.set(tool, handler);
    return this;
  }

  /** A new in-memory connection to this server. */
  transport(): McpTransport {
    this.connections++;
    const pair = createInMemoryTransportPair();
    this.current = pair;
    quietly(pair.server.start());
    pair.server.onMessage((message) => {
      const reply = this.answer(message as unknown as Message);
      if (reply === "crash") quietly(pair.server.close());
      else if (reply !== undefined) quietly(pair.server.send(reply as unknown as JsonRpcMessage));
    });
    return pair.client;
  }

  /** Ends the current connection, as a server that dies does. */
  crash(): void {
    if (this.current !== undefined) quietly(this.current.server.close());
  }

  /** The answer to a message, `undefined` for none, `"crash"` when the server must go away. */
  answer(message: Message): Reply | undefined | "crash" {
    if (message.id === undefined) return undefined;
    const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return ok({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Lean LSP", version: this.version } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: [...this.listed].map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object", properties: {} } })) });
      case "tools/call":
        return this.call(message, ok);
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
    }
  }

  private call(message: Message, ok: (result: unknown) => Reply): Reply {
    const tool = String(message.params?.name);
    const args = (message.params?.arguments ?? {}) as Args;
    this.calls.push({ tool, args, ...this.snapshot(args) });
    if (!this.listed.has(tool)) return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${tool}` } };
    const failure = (text: string) => ok({ content: [{ type: "text", text: `Error executing tool ${tool}: ${text}` }], isError: true });
    const invalid = validate(tool, args);
    if (invalid !== undefined) return failure(invalid);
    const said = this.failing.get(tool);
    if (said !== undefined) return failure(said);
    const outcome = (this.handlers.get(tool) ?? DEFAULTS[tool] ?? (() => ({ error: `the fake has no answer for ${tool}` })))(args, this);
    if ("error" in outcome) return failure(outcome.error);
    return ok({ content: [{ type: "text", text: JSON.stringify(outcome.structured, null, 2) }], structuredContent: outcome.structured, isError: false });
  }

  private snapshot(args: Args): { file?: string } {
    if (typeof args.file_path !== "string" || this.projectDir === undefined) return {};
    try {
      return { file: this.lines(args.file_path).join("\n") };
    } catch {
      return {};
    }
  }

  /** The lines of a file of the project, as the real server reads them; throws as it does for a path outside it. */
  lines(filePath: string): string[] {
    if (this.projectDir === undefined) throw new Error("the fake has no project");
    const absolute = isAbsolute(filePath) ? filePath : resolve(this.projectDir, filePath);
    const inside = relative(resolve(this.projectDir), absolute);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Path ${filePath} is outside the Lean project`);
    if (!existsSync(absolute)) throw new Error(`File not found: ${inside}`);
    const lines = readFileSync(absolute, "utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}

/** The arguments of a call against the recorded schema; the text of the error pydantic would give, or undefined. */
function validate(tool: string, args: Args): string | undefined {
  const spec = RECORD.tools.find((t) => t.name === tool);
  if (spec === undefined) return undefined;
  const errors: string[] = [];
  for (const name of spec.required) if (!(name in args)) errors.push(`${name}\n  Field required [type=missing]`);
  for (const [name, value] of Object.entries(args)) {
    const property = spec.properties[name];
    if (property === undefined) {
      errors.push(`${name}\n  Unexpected keyword argument [type=unexpected_keyword_argument]`);
      continue;
    }
    const type = typeOf(value);
    if (!property.types.some((t) => t === type || (t === "number" && type === "integer") || t === "array" && type === "array")) {
      errors.push(`${name}\n  Input should be ${property.types.join(" or ")} [type=${type}_type, input_value=${JSON.stringify(value)}]`);
    } else if (property.minimum !== undefined && typeof value === "number" && value < property.minimum) {
      errors.push(`${name}\n  Input should be greater than or equal to ${property.minimum}`);
    } else if (property.enum !== undefined && !property.enum.includes(value as string)) {
      errors.push(`${name}\n  Input should be ${property.enum.map((e) => `'${e}'`).join(", ")}`);
    } else if (type === "array" && !(value as unknown[]).every((item) => typeof item === "string")) {
      errors.push(`${name}\n  Input should be a valid string`);
    }
  }
  return errors.length === 0 ? undefined : `${errors.length} validation error${errors.length > 1 ? "s" : ""} for ${tool}Arguments\n${errors.join("\n")}`;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

// --- the canned answers, written in the shapes the real server gives. Nothing compares this stand-in with the real server. real-server.test.ts (opt-in: documentation/lean-lsp.md, "Tests") runs the harness against the real one, with its language server and its network call canned: it shows that the harness reads the real shapes and the words of the real errors, and that the documents it screens are those the real server builds; a difference between this file and the real server is found only by reading that test's results ---

const isMarkerOrBlank = (line: string) => line.trim() === "" || line.trim().startsWith("-- HARNESS");

/** Whether no goal is left at the column of a line: after a tactic that closes it, or at a `done`. */
const closes = (line: string, column: number) => line.includes("done") || (column > line.length && /^\s*(simp|omega|rfl|trivial|decide)\b/.test(line));

/** The names that the fake's Lean does not know. */
const UNKNOWN = /\b(bad|notDefinedAnywhere)\b/;

function lineOf(fake: FakeLeanLspMcp, args: Args): { lines: string[]; line: number; context: string } | { error: string } {
  let lines: string[];
  try {
    lines = fake.lines(String(args.file_path));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const line = Number(args.line);
  if (line < 1 || line > lines.length) return { error: `Line ${line} out of range (file has ${lines.length} lines)` };
  return { lines, line, context: lines[line - 1] as string };
}

/**
 * The document that lean-lsp-mcp 0.31.0 builds for one tactic of `lean_multi_attempt`: a port of
 * `build_attempt_text` (lean_lsp_mcp/attempt_utils.py). `column` counts from 0 in characters, `line` from 1.
 * From the line asked, as many lines of the file are replaced as the tactic has; the first becomes the
 * line's first `column` characters and the tactic's first line, and each further one the same
 * characters and the tactic's next line.
 */
export function buildAttemptText(lines: readonly string[], line: number, context: string, column: number, snippet: string): string {
  const text = snippet.replace(/\n+$/, "");
  const parts = text === "" ? [""] : text.split("\n");
  const indent = [...context].slice(0, column).join("");
  const payload = parts.map((part) => indent + part);
  const end = Math.min(line - 1 + parts.length, lines.length);
  return `${[...lines.slice(0, line - 1), ...payload, ...lines.slice(end)].join("\n")}\n`;
}

const DEFAULTS: Record<string, Handler> = {
  lean_goal(args, fake) {
    const at = lineOf(fake, args);
    if ("error" in at) return at;
    const sorry = at.context.includes("sorry");
    if (args.column === undefined) {
      return { structured: { line_context: at.context, goals: null, goals_before: [GOAL], goals_after: sorry ? [] : [GOAL], status: null } };
    }
    const status = isMarkerOrBlank(at.context) ? "no_goal_at_position" : closes(at.context, Number(args.column)) ? "complete" : "goals";
    return { structured: { line_context: at.context, goals: status === "goals" ? [GOAL] : [], goals_before: null, goals_after: null, status } };
  },
  lean_term_goal(args, fake) {
    const at = lineOf(fake, args);
    if ("error" in at) return at;
    return { structured: { line_context: at.context, expected_type: "n + 0 = n" } };
  },
  lean_diagnostic_messages(args, fake) {
    let lines: string[];
    try {
      lines = fake.lines(String(args.file_path));
    } catch (error) {
      return { error: (error as Error).message };
    }
    const header = lines.findIndex((l) => l.startsWith("theorem")) + 1;
    const items: unknown[] = [];
    lines.forEach((text, k) => {
      if (text.includes("sorry") && !isMarkerOrBlank(text)) {
        items.push({ severity: "warning", message: "declaration uses 'sorry'", line: header, column: 9, lean_tags: null, category: "sorry", hint: null });
      }
      const unknown = UNKNOWN.exec(text);
      if (unknown !== null) {
        items.push({ severity: "error", message: `unknown identifier '${unknown[1]}'`, line: k + 1, column: unknown.index + 1, lean_tags: null, category: "diagnostic", hint: null });
      }
    });
    const shown = args.severity === undefined ? items : items.filter((i) => (i as { severity: string }).severity === args.severity);
    return {
      structured: {
        result: { partial: false, still_elaborating_lines: null, success: !items.some((i) => (i as { severity: string }).severity === "error"), timed_out: false, items: shown, failed_dependencies: [] },
      },
    };
  },
  lean_multi_attempt(args, fake) {
    const at = lineOf(fake, args);
    if ("error" in at) return at;
    const column = args.column === undefined ? Math.max(0, at.context.search(/\S/)) : Number(args.column) - 1;
    for (const snippet of args.snippets as string[]) fake.trials.push({ tactic: snippet, text: buildAttemptText(at.lines, at.line, at.context, column, snippet) });
    const items = (args.snippets as string[]).map((snippet) => ({
      snippet,
      goals: /^(omega|simp|done)\b/.test(snippet) ? [] : [GOAL],
      diagnostics: UNKNOWN.test(snippet)
        ? [{ severity: "error", message: `unknown identifier '${UNKNOWN.exec(snippet)?.[1]}'`, line: at.line, column: column + 1 + (UNKNOWN.exec(snippet)?.index ?? 0), lean_tags: null, category: "diagnostic", hint: null }]
        : [],
      timed_out: false,
      proof_status: null,
    }));
    return { structured: { items } };
  },
  lean_loogle(args) {
    const query = String(args.query);
    const variable = /^env:(.+)$/.exec(query);
    if (variable !== null) return { structured: { items: [{ name: process.env[variable[1] as string] ?? "(unset)", type: "", module: "" }] } };
    return {
      structured: {
        items: [
          { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Init.Core" },
          { name: "Nat.add_zero", type: "∀ (n : ℕ), n + 0 = n", module: "Init.Core" },
        ].slice(0, Number(args.num_results ?? 8)),
      },
    };
  },
  lean_leansearch(args) {
    return {
      structured: {
        items: [
          { name: "Nat.add_comm", module_name: "Mathlib.Algebra.Group.Nat", kind: "theorem", type: "∀ (n m : ℕ), n + m = m + n" },
          { name: "add_comm", module_name: "Mathlib.Algebra.Group.Defs", kind: "theorem", type: null },
        ].slice(0, Number(args.num_results ?? 5)),
      },
    };
  },
  lean_leanfinder(args) {
    return {
      structured: {
        items: [
          { formal_name: "Nat.add_zero", informal_name: "adding zero", kind: "theorem", type: "∀ (n : ℕ), n + 0 = n", informal_description: "Adding zero to a natural number changes nothing.", path: "Init.Core" },
        ].slice(0, Number(args.num_results ?? 5)),
      },
    };
  },
  lean_hammer_premise(args, fake) {
    const at = lineOf(fake, args);
    if ("error" in at) return at;
    const status = isMarkerOrBlank(at.context) ? "no_goal_at_position" : "goals";
    if (status !== "goals") return { error: `No goals found at line ${args.line}, column ${args.column} (status: ${status}). Try a different position.` };
    return { structured: { items: [{ name: "Nat.add_zero" }, { name: "Nat.zero_add" }].slice(0, Number(args.num_results ?? 32)) } };
  },
};

if (import.meta.main) {
  const disabled = new Set((process.env.LEAN_MCP_DISABLED_TOOLS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""));
  const fake = new FakeLeanLspMcp({
    version: process.env.FAKE_LEAN_LSP_VERSION ?? "0.31.0",
    tools: ALL_TOOLS.filter((t) => !disabled.has(t)),
    ...(process.env.LEAN_PROJECT_PATH ? { projectDir: process.env.LEAN_PROJECT_PATH } : {}),
  });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const reply = fake.answer(JSON.parse(line) as Message);
    if (reply === "crash") process.exit(1);
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
