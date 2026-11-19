import type { HarnessEvent } from "@seshat/core";
import { roleOfSite } from "./roles.ts";

/**
 * What a run's model output is made of, by role (plan change CL0, documentation/audit.md, "Output tokens by role and kind"): the output tokens of each role
 * split into thinking, text outside tool calls, and tool-call arguments. Called by `audit` (audit.ts) for its table; it reads the events, the blobs and the
 * transcripts it is given and writes nothing.
 *
 * Three sources, in this order of trust:
 * - a session's transcript (`transcripts/ID.json`, pi's messages): each assistant message's `usage.output` is split across its parts in proportion to their
 *   characters; a message with no usage counts characters / `CHARS_PER_TOKEN` and is counted as estimated;
 * - a one-shot call's response blob (the planner): the blob is the text only, so text is `min(outputTokens, ceil(chars / CHARS_PER_TOKEN))` and the rest of
 *   the call's output is thinking that was not stored;
 * - nothing: a call whose session has no transcript (a hole session of an older run) has no split, and the row says so.
 */

/** The characters of text that one token stands for, where the provider reported no count: the usual rough ratio for English and Lean text. */
export const CHARS_PER_TOKEN = 4;

export interface OutputKindsSources {
  events: readonly HarnessEvent[];
  /** The text of a blob, or undefined. */
  blob?: (hash: string) => string | undefined;
  /** The messages of a session's transcript, or undefined. */
  transcript?: (sessionId: string) => unknown;
}

export interface OutputKindRow {
  /** The role, else the site, else "other". */
  role: string;
  calls: number;
  outputTokens: number;
  /** The tokens that have a split: `thinking + text + toolCalls`. Zero: the row's split is not recorded. */
  split: number;
  thinking: number;
  /** Of `thinking`, the tokens of one-shot calls whose thinking is not stored (the call's output less its text). */
  thinkingNotStored: number;
  text: number;
  toolCalls: number;
  /** The assistant messages whose split was estimated from characters because they carried no usage. */
  estimatedMessages: number;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The split of a transcript's assistant messages: tokens by kind, and how many messages had no usage. */
function transcriptSplit(messages: unknown): { thinking: number; text: number; toolCalls: number; estimated: number } | undefined {
  if (!Array.isArray(messages)) return undefined;
  const sum = { thinking: 0, text: 0, toolCalls: 0, estimated: 0 };
  for (const message of messages) {
    const m = obj(message);
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const chars = { thinking: 0, text: 0, toolCalls: 0 };
    for (const part of m.content) {
      const p = obj(part);
      if (p?.type === "thinking") chars.thinking += typeof p.thinking === "string" ? p.thinking.length : 0;
      else if (p?.type === "text") chars.text += typeof p.text === "string" ? p.text.length : 0;
      else if (p?.type === "toolCall") chars.toolCalls += JSON.stringify(p.arguments ?? {}).length;
    }
    const all = chars.thinking + chars.text + chars.toolCalls;
    const reported = obj(m.usage)?.output;
    const tokens = typeof reported === "number" ? reported : all / CHARS_PER_TOKEN;
    if (typeof reported !== "number") sum.estimated++;
    // Tokens with no characters to share them (a redacted reasoning) are thinking.
    if (all === 0) sum.thinking += tokens;
    else for (const kind of ["thinking", "text", "toolCalls"] as const) sum[kind] += (tokens * chars[kind]) / all;
  }
  return sum;
}

/** The `sessionId` a hole session wrote into its calls' request blobs; absent in older runs. */
function holeSessionOf(raw: string | undefined): string | undefined {
  try {
    const id = obj(raw === undefined ? undefined : JSON.parse(raw))?.sessionId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** One row for each role seen, in order of first appearance: its calls and output tokens, with the split of the ones whose kinds are known. */
export function outputKinds(src: OutputKindsSources): OutputKindRow[] {
  const rows = new Map<string, OutputKindRow>();
  const row = (role: string): OutputKindRow => {
    let r = rows.get(role);
    if (r === undefined) rows.set(role, (r = { role, calls: 0, outputTokens: 0, split: 0, thinking: 0, thinkingNotStored: 0, text: 0, toolCalls: 0, estimatedMessages: 0 }));
    return r;
  };
  const blob = (hash: string): string | undefined => {
    try {
      return src.blob?.(hash);
    } catch {
      return undefined;
    }
  };
  const addSplit = (r: OutputKindRow, s: { thinking: number; text: number; toolCalls: number; estimated?: number }) => {
    r.thinking += s.thinking;
    r.text += s.text;
    r.toolCalls += s.toolCalls;
    r.split += s.thinking + s.text + s.toolCalls;
    r.estimatedMessages += s.estimated ?? 0;
  };
  // Sessions of provers: their calls are the attempt's charges, and the split is the attempt's transcript.
  const attemptRole = new Map<string, string>();
  const transcribed = new Set<string>();
  const ofSession = (r: OutputKindRow, sessionId: string) => {
    if (transcribed.has(sessionId)) return;
    transcribed.add(sessionId);
    const split = transcriptSplit(src.transcript?.(sessionId));
    if (split !== undefined) addSplit(r, split);
  };
  for (const e of src.events) {
    if (e.type === "attempt.started") attemptRole.set(e.data.attemptId, roleOfSite(e.data.site ?? "prover.session") ?? e.data.site ?? "other");
    else if (e.type === "attempt.charged") {
      const r = row(attemptRole.get(e.data.attemptId) ?? "prover");
      // A response cut by a transient error and sent again is one call.
      if (e.data.retry === undefined) r.calls++;
      r.outputTokens += e.data.outputTokens;
      ofSession(r, e.data.attemptId);
    } else if (e.type === "model_call.finished" && e.data.attemptId === undefined) {
      // A call made inside an attempt is in the attempt's charges.
      const r = row(e.data.role ?? roleOfSite(e.data.site) ?? e.data.site ?? "other");
      r.calls++;
      r.outputTokens += e.data.outputTokens;
      const text = e.data.responseHash === undefined ? undefined : blob(e.data.responseHash);
      if (text !== undefined) {
        const kept = Math.min(e.data.outputTokens, Math.ceil(text.length / CHARS_PER_TOKEN));
        addSplit(r, { thinking: e.data.outputTokens - kept, text: kept, toolCalls: 0 });
        r.thinkingNotStored += e.data.outputTokens - kept;
      } else {
        const sessionId = holeSessionOf(blob(e.data.requestHash));
        if (sessionId !== undefined) ofSession(r, sessionId);
      }
    }
  }
  return [...rows.values()];
}
