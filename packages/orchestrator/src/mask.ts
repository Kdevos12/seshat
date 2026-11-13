import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Masking of old check results (plan change CA6, documentation/m0-loop.md, "Masked old checks"). In a session of many checks the
 * answers to the old ones fill the context, and what the model needs of them is little: that they failed, and how. Results older than the
 * last `KEEP_CHECKS` are replaced, in what is sent to the model, by their one-line summary (`summarizeCheck`, carried in the result's
 * `details`). The journal and the session's own messages are never rewritten.
 */

/** The check results that stay whole. */
export const KEEP_CHECKS = 4;

/**
 * Results are masked in batches of this many: nothing changes until this many more are maskable. A request is cached by its prefix, and a
 * mask that moved with every check would change the prefix with every check; masked in batches, a prefix of the history stays byte for byte the
 * same from one request to the next for `MASK_BATCH` checks at a time.
 */
export const MASK_BATCH = 4;

const CHECK_TOOLS = new Set(["lean_check", "lean_edit"]);

/** A result of a check: a tool result of `lean_check` or `lean_edit` that ran Lean (a refusal, a veto or a miss of an edit has no summary and is no check). */
function summaryOf(message: AgentMessage): string | undefined {
  if (!("role" in message) || message.role !== "toolResult" || !CHECK_TOOLS.has(message.toolName) || message.isError) return undefined;
  const details = message.details as { summary?: unknown } | undefined;
  return typeof details?.summary === "string" ? details.summary : undefined;
}

/** How many of `checks` results are masked: all but the last `keep`, rounded down to whole batches. */
export function maskedCount(checks: number, keep: number = KEEP_CHECKS, batch: number = MASK_BATCH): number {
  return checks <= keep ? 0 : Math.floor((checks - keep) / batch) * batch;
}

/**
 * The messages with the oldest check results masked. A masked result keeps its place, its tool call id and its details; its text is
 * `Earlier check, masked: SUMMARY.` It depends on that result alone, so the masked part of a history never changes once it is masked.
 */
export function maskOldChecks(messages: AgentMessage[], keep: number = KEEP_CHECKS, batch: number = MASK_BATCH): AgentMessage[] {
  const checks = messages.filter((m) => summaryOf(m) !== undefined).length;
  let toMask = maskedCount(checks, keep, batch);
  if (toMask === 0) return messages;
  return messages.map((message) => {
    const summary = summaryOf(message);
    if (summary === undefined || toMask === 0 || !("role" in message) || message.role !== "toolResult") return message;
    toMask -= 1;
    return { ...message, content: [{ type: "text" as const, text: `Earlier check, masked: ${summary}.` }] };
  });
}
