import type { Sketch } from "@seshat/core";

/** The lean-lsp-mcp release that the manifest pins and this package is written against. */
export const LEAN_LSP_MCP_VERSION = "0.31.0";

/**
 * The leanclient release that the pinned server was seen with. The server only asks for `>=` this
 * one, and leanclient decides what a goal, a barrier and a position are, which the handshake cannot
 * see change: so the default command line pins it exactly.
 */
export const LEANCLIENT_VERSION = "0.13.2";

/** The operations of the capability: the interactive tools of the plan's PC7, and nothing else. */
export const OPS = [
  "goal",
  "term_goal",
  "diagnostics",
  "multi_attempt",
  "loogle",
  "leansearch",
  "state_search",
  "hammer_premise",
] as const;
export type Op = (typeof OPS)[number];

/** The prover's two regions of the sketch file. */
export const REGIONS = ["aux", "proof"] as const;
export type Region = (typeof REGIONS)[number];

/** Where a line of the sketch file is: in a region (counted from 1), or in the fixed part (the file's line). */
export type Place = { region: Region | "fixed"; line: number };

/** The operations that read the sketch file; the others only ask a search site. */
export const FILE_OPS: readonly Op[] = ["goal", "term_goal", "diagnostics", "multi_attempt", "state_search", "hammer_premise"];

/**
 * The only tools of the server that the harness ever calls. `state_search` has no tool of its
 * own in 0.31.0 (`lean_state_search` was removed after 0.30.0): it reads the goal with
 * `lean_goal` and asks `lean_leanfinder` about it.
 */
export const ALLOWED_TOOLS = [
  "lean_goal",
  "lean_term_goal",
  "lean_diagnostic_messages",
  "lean_multi_attempt",
  "lean_loogle",
  "lean_leansearch",
  "lean_leanfinder",
  "lean_hammer_premise",
] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/**
 * Every other tool of lean-lsp-mcp 0.31.0, switched off in the server (LEAN_MCP_DISABLED_TOOLS)
 * as well as never called: building the project, running code, reading files and declarations.
 */
export const DISABLED_TOOLS = [
  "lean_build",
  "lean_file_outline",
  "lean_code_actions",
  "lean_hover_info",
  "lean_completions",
  "lean_declaration_file",
  "lean_references",
  "lean_local_search",
  "lean_run_code",
  "lean_verify",
  "lean_minimal_hypotheses",
  "lean_profile_proof",
  "lean_get_widgets",
  "lean_get_widget_source",
] as const;

export function isAllowedTool(name: string): name is AllowedTool {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

/** The remote services that the server asks: network sites, which can be down or refuse a rate. */
export const SITES = ["loogle", "leansearch", "leanfinder", "hammer"] as const;
export type Site = (typeof SITES)[number];

export const SITE_NAMES: Record<Site, string> = {
  loogle: "Loogle",
  leansearch: "LeanSearch",
  leanfinder: "Lean Finder",
  hammer: "the premise server",
};

/** The site that each tool of the server asks, when it asks one. */
export const SITE_OF_TOOL: Partial<Record<AllowedTool, Site>> = {
  lean_loogle: "loogle",
  lean_leansearch: "leansearch",
  lean_leanfinder: "leanfinder",
  lean_hammer_premise: "hammer",
};

export const SEVERITIES = ["error", "warning", "info", "hint"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The input of `lean.lsp` (the manifest's schema is the reference). */
export interface LeanLspInput {
  op: Op;
  /** Set by the harness, never by a prover: the problem's sketch. Only the file operations need it. */
  sketch?: Sketch;
  /** The regions to put in the file; default: the last that were checked, otherwise the sketch's own. */
  aux?: string;
  proof?: string;
  /** The region that `line` counts in. Default `proof`. */
  region?: Region;
  line?: number;
  column?: number;
  tactics?: string[];
  query?: string;
  limit?: number;
  severity?: Severity;
  timeoutSec?: number;
}

/** A message of Lean, located in the prover's terms. */
export interface Message {
  severity: string;
  /** `fixed` for a line outside both regions; then `line` is the file's. */
  region: Region | "fixed";
  line: number;
  column: number;
  /** The source line, trimmed. */
  code?: string;
  message: string;
  category?: string;
  hint?: string;
}

/** The result of one tactic of `multi_attempt`. */
export interface Attempt {
  tactic: string;
  /** `closed`: no goal left and no error; `open`: goals left; `error`: Lean reported an error. */
  result: "closed" | "open" | "error";
  goals: string[];
  messages: Message[];
}

/** A declaration found by a search. */
export interface Hit {
  name: string;
  type?: string;
  module?: string;
  kind?: string;
  description?: string;
}

export interface LeanLspOutput {
  op: Op;
  status: string;
  /** The position that was asked about, in the prover's terms. */
  region?: Region;
  line?: number;
  column?: number;
  /** The line as it stands in the file (with the indentation of the proof). */
  lineText?: string;
  goals?: string[];
  goalsBefore?: string[];
  goalsAfter?: string[];
  expectedType?: string;
  messages?: Message[];
  errors?: number;
  warnings?: number;
  attempts?: Attempt[];
  /** `state_search`: the goal that was searched for. */
  goal?: string;
  results?: Hit[];
  premises?: string[];
  /** Items that the answer does not show. */
  more?: number;
  /** A remote site that could not be asked, and why. */
  unavailable?: string;
  note?: string;
}
