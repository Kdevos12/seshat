import type { FrozenPacket } from "@seshat/lines";

/** The heading of the list of facts learned since the session started. */
export const NEW_SINCE_HEADING = "New since this session started:";

/**
 * What a session keeps of its frozen packet (plan change PE5): the prefix of the first request, and
 * the facts that prefix holds. One per session.
 */
export interface FrozenState {
  prefix: string;
  start: ReadonlySet<string>;
}

/** The two texts of a request that a `FrozenPacket` answers, after the session's prefix is frozen. */
export interface ComposedPacket {
  prefix: string;
  tail: string;
}

/**
 * Freezes the prefix at the first answer and reads the tail of every answer. Returns the state to
 * keep for the next request and the texts to send. The prefix of a later answer is not read.
 */
export function composePacket(answer: FrozenPacket, frozen: FrozenState | undefined): { state: FrozenState; texts: ComposedPacket } {
  const state = frozen ?? { prefix: answer.prefix, start: new Set(answer.facts ?? []) };
  const news = (answer.newSince ?? 0) > 0 ? newSince(answer.facts ?? [], state.start, answer.newSince ?? 0) : "";
  return { state, texts: { prefix: state.prefix, tail: news === "" ? answer.tail : `${answer.tail}${answer.tail === "" ? "" : "\n\n"}${news}` } };
}

/** The facts that are not in `start`, in the order given, at most `max` of them, as a list under `NEW_SINCE_HEADING`; "" when there is none. */
function newSince(facts: readonly string[], start: ReadonlySet<string>, max: number): string {
  const fresh = [...new Set(facts.filter((fact) => !start.has(fact)))];
  if (fresh.length === 0) return "";
  const shown = fresh.slice(0, max).map((fact) => `- ${fact}`);
  if (fresh.length > max) shown.push(`- (${fresh.length - max} more)`);
  return `${NEW_SINCE_HEADING}\n${shown.join("\n")}`;
}

/** Why `value` is not an answer of `contextPacket`, or undefined when it is one. */
export function packetFault(value: unknown): string | undefined {
  if (value === undefined || typeof value === "string") return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it must answer a string, a { prefix, tail } object or undefined";
  const v = value as Record<string, unknown>;
  if (typeof v.prefix !== "string" || typeof v.tail !== "string") return "a { prefix, tail } answer needs two strings";
  if (v.facts !== undefined && (!Array.isArray(v.facts) || v.facts.some((fact) => typeof fact !== "string"))) return "facts must be a list of strings";
  if (v.newSince !== undefined && (typeof v.newSince !== "number" || !Number.isInteger(v.newSince) || v.newSince < 0)) {
    return "newSince must be a whole number of at least 0";
  }
  return undefined;
}
