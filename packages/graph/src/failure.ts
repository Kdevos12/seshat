import type { ValidateResult } from "@seshat/lines";

/**
 * What went wrong in a check, as a model reads it: Lean's error messages when the validator has
 * them (`unsolved goals ...` says far more than `lean: 1 error(s)`), else the validator's reasons.
 */
export function failureLines(result: Pick<ValidateResult, "reasons" | "report">, limit = 3): string[] {
  const errors = (result.report?.messages ?? []).filter((message) => message.severity === "error").map((message) => message.text.trim());
  return (errors.length > 0 ? errors : result.reasons).slice(0, limit).map((line) => line.slice(0, 300));
}
