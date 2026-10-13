import {
  AUX_BEGIN,
  AUX_END,
  PROOF_BEGIN,
  PROOF_END,
  STANDARD_AXIOMS,
  type LeanMessage,
  type ValidationReport,
} from "@math-harness/core";

/** Limits on what one check sends back to the model. */
export interface FeedbackLimits {
  /** Items shown per list (errors, holes, other messages). */
  items: number;
  /** Characters kept of each Lean message. */
  messageChars: number;
}

export const DEFAULT_FEEDBACK_LIMITS: FeedbackLimits = { items: 8, messageChars: 1500 };

/** Where a line of the checked file is, in the prover's terms. */
export function locate(checked: string, line: number): string {
  const lines = checked.split("\n");
  const at = (marker: string) => lines.findIndex((l) => l.trim() === marker.trim()) + 1;
  const [auxBegin, auxEnd, proofBegin, proofEnd] = [at(AUX_BEGIN), at(AUX_END), at(PROOF_BEGIN), at(PROOF_END)];
  const text = (lines[line - 1] ?? "").trim();
  const shown = text === "" ? "" : `, \`${text.length > 120 ? `${text.slice(0, 117)}...` : text}\``;
  if (auxBegin > 0 && line > auxBegin && line < auxEnd) return `AUX line ${line - auxBegin}${shown}`;
  if (proofBegin > 0 && line > proofBegin && line < proofEnd) return `PROOF line ${line - proofBegin}${shown}`;
  return `line ${line} of the fixed part${shown}`;
}

function clip(text: string, chars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= chars ? trimmed : `${trimmed.slice(0, chars)}\n[... ${trimmed.length - chars} more characters]`;
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : by + line))
    .join("\n");
}

function list(
  title: string,
  items: Array<{ where: string; text: string }>,
  limits: FeedbackLimits,
): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, limits.items);
  const out = [`${title} (${items.length}):`];
  shown.forEach((item, k) => {
    out.push(`${k + 1}. ${item.where}:`, indent(clip(item.text, limits.messageChars), "   "));
  });
  if (items.length > shown.length) out.push(`[${items.length - shown.length} more not shown]`);
  return out;
}

const COVERED_REASON = /^lean: \d+ (error|sorry)\(s\)|^the file still has holes/;

function isSorryWarning(message: LeanMessage): boolean {
  return message.severity === "warning" && /declaration uses 'sorry'/.test(message.text);
}

/** A check of the prover's file, written for the prover: what happened, then Lean's messages by region and line. */
export function formatCheck(report: ValidationReport, limits: FeedbackLimits = DEFAULT_FEEDBACK_LIMITS): string {
  const where = (line: number) => locate(report.checked, line);
  const errors = report.messages.filter((m) => m.severity === "error");
  const others = report.messages.filter((m) => m.severity !== "error" && m.severity !== "trace" && !isSorryWarning(m));
  // A file with holes depends on sorryAx; saying so again is noise.
  const otherReasons = report.reasons.filter((r) => !COVERED_REASON.test(r) && !(report.holes && / depends on sorryAx$/.test(r)));
  const out: string[] = [];

  if (report.verdict === "valid") {
    out.push(
      "Accepted. Lean checked the whole file with no error and no hole, the theorem depends only on the standard " +
        `axioms (${STANDARD_AXIOMS.join(", ")}), and its statement is unchanged. The theorem is proved: stop here.`,
    );
  } else if (report.leanStatus === undefined) {
    out.push("Refused before Lean ran; nothing was checked:", ...report.reasons.map((r) => `- ${r}`));
    return out.join("\n");
  } else if (report.leanStatus === "timeout" && report.messages.length === 0) {
    out.push("Lean did not finish within the time limit. Make the proof cheaper: avoid large `decide`, `simp` or `norm_num` calls on big terms.");
    return out.join("\n");
  } else if (report.leanStatus === "server_error" && report.messages.length === 0) {
    out.push(`Lean could not be reached, so nothing was checked: ${report.reasons.join("; ")}`);
    return out.join("\n");
  } else if (report.holes) {
    const holes = report.sorries.length;
    out.push(
      errors.length === 0
        ? `Checked the sketch: no error, ${holes} hole(s) left. A file with holes is never accepted; prove each hole.`
        : `Checked the sketch: ${errors.length} error(s), ${holes} hole(s).`,
    );
  } else if (errors.length > 0) {
    out.push(`Not accepted: ${errors.length} error(s).`);
  } else {
    out.push("Not accepted.");
  }

  if (report.verdict !== "valid" && otherReasons.length > 0) out.push(...otherReasons.map((r) => `- ${r}`));
  out.push(
    ...list("Errors", errors.map((m) => ({ where: where(m.pos.line), text: m.text })), limits),
    ...list("Holes, with their goals", report.sorries.map((s) => ({ where: where(s.pos.line), text: s.goal })), limits),
    ...list("Other messages", others.map((m) => ({ where: `${m.severity}, ${where(m.pos.line)}`, text: m.text })), limits),
  );
  return out.join("\n");
}

/** One line about a check, for logs and for the next session's prompt header. */
export function summarizeCheck(report: ValidationReport): string {
  if (report.verdict === "valid") return "accepted";
  if (report.leanStatus === undefined) return `refused before Lean: ${report.reasons[0] ?? ""}`;
  const errors = report.messages.filter((m) => m.severity === "error").length;
  if (report.leanStatus === "timeout" && report.messages.length === 0) return "Lean timed out";
  if (report.leanStatus === "server_error" && report.messages.length === 0) return "Lean could not be reached";
  return `${errors} error(s), ${report.sorries.length} hole(s)`;
}

/**
 * The kind of failure of a check, for `attempt.finished`: `refused` (never reached Lean),
 * `lean_unavailable`, `timeout`, `lean_error`, `holes`, `axioms`, `statement_changed`, `other`.
 */
export function failureClass(report: ValidationReport): string | undefined {
  if (report.verdict === "valid") return undefined;
  if (report.leanStatus === undefined) return "refused";
  if (report.leanStatus === "server_error" && report.messages.length === 0) return "lean_unavailable";
  if (report.leanStatus === "timeout" && report.messages.length === 0) return "timeout";
  if (report.messages.some((m) => m.severity === "error")) return "lean_error";
  if (report.holes || report.sorries.length > 0) return "holes";
  if (report.reasons.some((r) => / depends on /.test(r))) return "axioms";
  if (report.reasons.some((r) => /original type/.test(r))) return "statement_changed";
  return "other";
}
