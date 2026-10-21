import type { Json } from "@seshat/core";
import { lineText, type Layout, placeOf } from "./layout.ts";
import { type AllowedTool, type Attempt, type Hit, type Message, SITE_OF_TOOL, type Site } from "./protocol.ts";

/** Characters kept of a Lean message, as in `lean_check`'s answers. */
export const MESSAGE_CHARS = 1500;
/** Characters kept of a goal. */
export const GOAL_CHARS = 4000;
const TYPE_CHARS = 500;
const DESCRIPTION_CHARS = 300;
const CODE_CHARS = 120;

/** Cleans a text before a prover reads it. */
export type Scrub = (text: string) => string;

export function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 3)}...`;
}

export function asRecord(value: Json | undefined): Record<string, Json> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function text(value: Json | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A goal list of the server. The text format gives strings; a structured goal gives its pretty form. */
export function goalList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((goal) => {
    const pretty = typeof goal === "string" ? goal : text(asRecord(goal)?.pretty);
    return pretty === undefined ? [] : [clip(pretty, GOAL_CHARS)];
  });
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/**
 * Lean's messages as the server gives them (file lines and columns from 1), located in the
 * prover's terms: the region and the line in it. Errors come first. `code` is the source line,
 * which only means something for a message about the file as it is (not for a trial document).
 * `scrub` cleans the text of a message and its hint, which are Lean's own words and may name the
 * host's paths.
 */
export function messagesOf(items: Json | undefined, layout: Layout, options: { code: boolean; scrub?: Scrub }): Message[] {
  const scrub = options.scrub ?? ((text: string) => text);
  if (!Array.isArray(items)) return [];
  const messages = items.flatMap((item): Message[] => {
    const raw = asRecord(item);
    const message = text(raw?.message);
    if (raw === undefined || message === undefined) return [];
    const fileLine = typeof raw.line === "number" ? raw.line : 0;
    const place = placeOf(layout, fileLine);
    const source = options.code ? lineText(layout, fileLine).trim() : "";
    const category = text(raw.category);
    const hint = text(raw.hint);
    return [
      {
        severity: text(raw.severity) ?? "info",
        region: place.region,
        line: place.line,
        column: typeof raw.column === "number" ? raw.column : 0,
        ...(source !== "" ? { code: clip(source, CODE_CHARS) } : {}),
        message: clip(scrub(message.trim()), MESSAGE_CHARS),
        ...(category !== undefined && category !== "diagnostic" ? { category } : {}),
        ...(hint !== undefined ? { hint: clip(scrub(hint), 300) } : {}),
      },
    ];
  });
  return messages
    .map((message, k) => ({ message, k }))
    .sort((a, b) => (SEVERITY_ORDER[a.message.severity] ?? 4) - (SEVERITY_ORDER[b.message.severity] ?? 4) || a.k - b.k)
    .map((entry) => entry.message);
}

/** What `multi_attempt` found for each tactic, with the server's lines and goals read as above. */
export function attemptsOf(items: Json | undefined, layout: Layout, scrub?: Scrub): Attempt[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): Attempt[] => {
    const raw = asRecord(item);
    const tactic = text(raw?.snippet);
    if (raw === undefined || tactic === undefined) return [];
    const goals = goalList(raw.goals);
    const messages = messagesOf(raw.diagnostics, layout, { code: false, ...(scrub !== undefined ? { scrub } : {}) });
    const result = messages.some((m) => m.severity === "error") ? "error" : goals.length === 0 ? "closed" : "open";
    return [{ tactic, result, goals, messages }];
  });
}

/** The declarations a search found. `tool` says which of the server's three search answers this is. */
export function hitsOf(tool: "lean_loogle" | "lean_leansearch" | "lean_leanfinder", items: Json | undefined): Hit[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): Hit[] => {
    const raw = asRecord(item);
    if (raw === undefined) return [];
    const name = text(tool === "lean_leanfinder" ? raw.formal_name : raw.name);
    if (name === undefined) return [];
    const type = text(raw.type);
    const module = text(tool === "lean_loogle" ? raw.module : tool === "lean_leansearch" ? raw.module_name : raw.path);
    const kind = text(raw.kind);
    const informal = [text(raw.informal_name), text(raw.informal_description)].filter((t): t is string => t !== undefined).join(": ");
    return [
      {
        name,
        ...(type !== undefined ? { type: clip(type, TYPE_CHARS) } : {}),
        ...(module !== undefined ? { module } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(tool === "lean_leanfinder" && informal !== "" ? { description: clip(informal, DESCRIPTION_CHARS) } : {}),
      },
    ];
  });
}

/** The answer of the diagnostics tool: the server wraps it in `result`, unlike its other tools. */
export function unwrapDiagnostics(result: Json): Record<string, Json> | undefined {
  const record = asRecord(result);
  // The diagnostics tool wraps its answer in `result`; the others answer the model itself.
  return asRecord(record?.result) ?? record;
}

/** The text of a tool's error without the prefix the server's framework adds. */
export function stripToolPrefix(tool: string, message: string): string {
  const prefix = `Error executing tool ${tool}: `;
  return (message.startsWith(prefix) ? message.slice(prefix.length) : message).trim();
}

/** Why a tool of the server failed, as far as the harness can tell. */
export type Failure =
  /** A search site could not be asked, or refused the rate: the tool degrades. */
  | { kind: "site"; site: Site; reason: string }
  /** The site understood the query and refused it (a malformed Loogle pattern). */
  | { kind: "query"; message: string }
  /** `hammer_premise` found no goal where it was asked. */
  | { kind: "no_goal"; status: string }
  /** Anything else: the tool ran and refused or failed on this input. */
  | { kind: "tool"; message: string };

/**
 * What the network call of a site tool raises when the site is out of reach, in the words of the
 * exceptions that urllib, http.client and ssl raise (a failed lookup or a refused connection, an HTTP
 * status, a connection that was cut, a time limit of the socket), and what the server says when its
 * own client-side limit refuses the call. A time limit of the language server names its method and
 * says "after N s": it is not here.
 */
const NETWORK_FAILURE = [
  /^<urlopen error\b/i,
  /^HTTP Error \d{3}\b/i,
  /^(?:Rate|Tool) limit exceeded\b/i,
  /^Remote end closed connection\b/i,
  /^(?:\[Errno \d+\] )?Connection (?:reset by peer|aborted)\b/i,
  /^(?:_ssl\.c:\d+: )?(?:The (?:read|write|handshake) operation )?timed out\.?$/i,
];

/**
 * Sorts the failure of a tool. A tool that asks a site is out of reach only when its failure is one
 * of the network's (`NETWORK_FAILURE`): that is no fault of the query, and the site is left alone for
 * a while. The failures that the site or the server answer about the query or the position are told
 * apart first. Anything else is a failure of the call, even from a tool that asks a site: the premise
 * tool reads the goal from the language server before it asks its site, and what goes wrong there is
 * Lean's, not the site's.
 */
export function classify(tool: AllowedTool, message: string): Failure {
  const said = stripToolPrefix(tool, message);
  const site = SITE_OF_TOOL[tool];
  if (site === undefined) return { kind: "tool", message: said };
  if (/^loogle query error:/i.test(said)) return { kind: "query", message: said };
  const noGoal = /^No goals found at line \d+, column \d+ \(status: ([^)]*)\)/.exec(said);
  if (noGoal !== null) return { kind: "no_goal", status: noGoal[1] as string };
  // Loogle puts what went wrong with its remote call on the line after its own name.
  const first = said.split("\n").find((line) => line.trim() !== "" && !/^loogle error:?$/i.test(line.trim())) ?? said;
  // The server's hint to switch Loogle to a local copy is for the host, not for a prover.
  const reason = first.replace(/\s*Use --loogle-local to avoid limits\.?/i, "").trim();
  if (!NETWORK_FAILURE.some((pattern) => pattern.test(reason))) return { kind: "tool", message: said };
  return { kind: "site", site, reason: clip(reason, 300) };
}
