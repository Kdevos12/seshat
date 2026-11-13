/**
 * The refusals of a model provider that a retry cannot cure: a missing balance, a key that is not accepted, an account that is not allowed.
 * The run stops on one of them at once, since every later request would fail the same way and be booked as an attempt.
 */

/** The HTTP statuses that are a refusal of the account, not of the moment. */
export const FATAL_STATUSES: readonly number[] = [401, 402, 403];

/** The phrases (compared in lower case) that show such a refusal. */
export const FATAL_PHRASES: readonly string[] = [
  "insufficient balance",
  "insufficient_balance",
  "insufficient quota",
  "invalid api key",
  "incorrect api key",
  "authentication",
  "unauthorized",
  "billing",
];

/** A short reason when the error text of a model request shows a refusal that a retry cannot cure; else undefined (a 429, a 5xx and a timeout are not one). */
export function fatalProviderError(message: string): string | undefined {
  const text = message.trim();
  const status = /^(?:\w+ )?(?:status |http )?(\d{3})\b/i.exec(text)?.[1] ?? /\b(?:status|http|code)[ :=]+(\d{3})\b/i.exec(text)?.[1];
  if (status !== undefined && FATAL_STATUSES.includes(Number(status))) return text.slice(0, 200);
  // A rate limit or an overload passes by itself, whatever its text says about the account.
  if (status !== undefined && (Number(status) === 429 || Number(status) >= 500)) return undefined;
  const lower = text.toLowerCase();
  return FATAL_PHRASES.some((phrase) => lower.includes(phrase)) ? text.slice(0, 200) : undefined;
}

/** The line a person reads when the run stopped on such a refusal. */
export function refusalLine(reason: string): string {
  return `the model provider refused the request (${reason}): the run stopped; nothing more was spent`;
}
