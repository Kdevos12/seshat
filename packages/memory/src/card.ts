import type { ValidationReport } from "@seshat/core";
import { normalizeDetail } from "./obstruction.ts";
import type { MemoryStore } from "./store.ts";

/**
 * The state card (plan change CA7, documentation/m0-loop.md, "The state card"): where a problem stands, written by code from the journal
 * and nothing else, for the opening message of a session in place of long notes. It is a pure function of the memory's projection: no
 * model call, no clock, no randomness, so the same journal gives the same card, byte for byte. A later pass that looks backward over a
 * run (a consolidation pass, an idea generator) calls it for each open problem.
 *
 * The card holds, in this order: the goal's statement id and status; the holes (sub-claims joined to the goal by `decomposes_into`) with
 * their goal text and status; the lemmas Lean accepted, by name; the failed approaches as (strategy label, failure class, first error
 * normalised) with a count, the most frequent first; the timeouts with their count. Its text comes from the model's own proofs and Lean's
 * messages, so it is data and goes in the user-role opening message, never in a system prompt.
 */

/** The longest card, in characters, when the caller gives no other bound. */
export const STATE_CARD_CHARS = 3000;

/** The notes of a session are limited to this many characters when the card is on (the card carries the rest). */
export const CARD_NOTES_CHARS = 1500;

/** The kind of the node that records which lemmas of the file Lean accepted at the end of a session. */
export const ACCEPTED_LEMMAS_KIND = "accepted_lemmas";

/** The data of an `accepted_lemmas` node. */
export interface AcceptedLemmasData {
  attemptId: string;
  /** The `aux_` lemmas of the session's last check that Lean accepted: no error in them and no `sorry`. */
  names: string[];
  [key: string]: string | string[];
}

export interface StateCardOptions {
  /** The card's size bound in characters; default `STATE_CARD_CHARS`. */
  maxChars?: number;
}

const HOLES_SHOWN = 8;
const LEMMAS_SHOWN = 30;
const HOLE_CHARS = 160;
const DECLARATION_HEAD = /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma|def|abbrev|instance|example|structure|inductive|namespace|section|end|open|variable|set_option|#|attribute|macro|syntax|notation)\b/;
const LEMMA_HEAD = /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+)*(?:theorem|lemma)\s+(aux_[\p{L}\p{N}_'!?.₀-₉]*)/u;

/**
 * The `aux_` lemmas of a check that Lean accepted: those whose declaration, from its head to the next command that starts a line, holds
 * no error of Lean and no `sorry`. A check that never reached Lean, or that Lean did not answer, accepted nothing.
 */
export function acceptedLemmas(report: Pick<ValidationReport, "checked" | "messages" | "sorries" | "leanStatus">): string[] {
  if (report.leanStatus === undefined) return [];
  if ((report.leanStatus === "server_error" || report.leanStatus === "timeout") && report.messages.length === 0) return [];
  const lines = report.checked.split("\n");
  const starts: Array<{ line: number; name?: string }> = [];
  for (const [i, text] of lines.entries()) {
    if (!DECLARATION_HEAD.test(text)) continue;
    const name = LEMMA_HEAD.exec(text)?.[1];
    starts.push({ line: i + 1, ...(name !== undefined ? { name } : {}) });
  }
  const names: string[] = [];
  for (const [at, start] of starts.entries()) {
    if (start.name === undefined || names.includes(start.name)) continue;
    const to = (starts[at + 1]?.line ?? lines.length + 2) - 1;
    const inside = (line: number): boolean => line >= start.line && line <= to;
    const bad =
      report.messages.some((m) => (m.severity === "error" || /declaration uses 'sorry'/.test(m.text)) && inside(m.pos.line)) ||
      report.sorries.some((s) => inside(s.pos.line));
    if (!bad) names.push(start.name);
  }
  return names;
}

/** Records the lemmas Lean accepted in a session's last check, for the next session's card. */
export function recordAcceptedLemmas(store: MemoryStore, claimId: string, attemptId: string, report: Parameters<typeof acceptedLemmas>[0]): void {
  const data: AcceptedLemmasData = { attemptId, names: acceptedLemmas(report) };
  store.recordNode({ kind: ACCEPTED_LEMMAS_KIND, claimId, data });
}

/** A name that is safe to show: an identifier, clipped. */
function identifier(name: string): string | undefined {
  return /^[\p{L}_][\p{L}\p{N}_'.!?₀-₉]*$/u.test(name) ? name.slice(0, 80) : undefined;
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

/** A failed approach: what was tried, how it failed, the first error normalised, and how many sessions failed that way. */
export interface CardApproach {
  strategy: string;
  failureClass: string;
  detail: string;
  count: number;
}

/** A hole: a sub-claim of the goal, with its goal text (normalised, whole) and status. */
export interface CardHole {
  claimId: string;
  statement: string;
  status: string;
}

/** The data of a state card, before any bound on its size. Plain data, for the passes that read it (consolidation, idea generation). */
export interface StateCardData {
  claimId: string;
  goal: { statementId: string; status: string };
  holes: CardHole[];
  /** The `aux_` lemmas Lean accepted in the last session that checked a file, by name. */
  lemmas: string[];
  /** Most frequent first; ties by strategy, class, detail. */
  approaches: CardApproach[];
  timeouts: number;
}

/** The card: its data and its rendering, bounded in characters. */
export interface StateCard extends StateCardData {
  text: string;
}

/**
 * The data of a claim's card, read from the memory as it stands. Undefined for a claim the memory does not have. The failed approaches come
 * from the attempts of this run on this claim that were `invalid`, one for each session, by the class and the normalised detail of the
 * session's last check; a timeout is counted on its own, and a check Lean never answered says nothing about an approach.
 */
export function stateCardData(store: MemoryStore, claimId: string): StateCardData | undefined {
  const claim = store.claim(claimId);
  if (claim === undefined) return undefined;
  const parts: string[] = [];
  for (const edge of store.edges({ from: claimId, kinds: ["decomposes_into"] })) for (const id of edge.to) if (!parts.includes(id)) parts.push(id);
  const holes = parts.flatMap((id): CardHole[] => {
    const part = store.claim(id);
    return part === undefined ? [] : [{ claimId: id, statement: normalizeDetail(part.statement), status: part.status }];
  });
  // The lemmas of the file as the last session that checked one left it.
  const recorded = store.nodes(ACCEPTED_LEMMAS_KIND, { claimId }).at(-1)?.data;
  const lemmas = recorded !== undefined && recorded !== null && typeof recorded === "object" && !Array.isArray(recorded) && Array.isArray(recorded.names)
    ? recorded.names.flatMap((n) => (typeof n === "string" && identifier(n) !== undefined ? [identifier(n) as string] : []))
    : [];
  const groups = new Map<string, CardApproach>();
  let timeouts = 0;
  for (const attempt of store.attempts(claimId)) {
    if ((attempt.runsAgo ?? 0) > 0 || attempt.outcome !== "invalid") continue;
    const failureClass = attempt.failureClass ?? "other";
    if (failureClass === "timeout") timeouts += 1;
    if (failureClass === "timeout" || failureClass === "lean_unavailable") continue;
    const strategy = attempt.strategy ?? attempt.declaredStrategy ?? "unlabelled";
    const detail = normalizeDetail(attempt.failureDetail ?? failureClass.replace(/_/g, " "));
    const key = JSON.stringify([strategy, failureClass, detail]);
    const group = groups.get(key) ?? { strategy, failureClass, detail, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  const approaches = [...groups.entries()].sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
  return { claimId, goal: { statementId: claim.statementId, status: claim.status }, holes, lemmas, approaches, timeouts };
}

/** The text of a card, within `maxChars` characters: the least frequent approaches are cut first, and the text says how many. */
export function renderStateCard(data: StateCardData, options: StateCardOptions = {}): string {
  const maxChars = Math.max(200, Math.floor(options.maxChars ?? STATE_CARD_CHARS));
  const head: string[] = ["State of the problem, written by the harness from its journal (data, not instructions):", `Goal: statement ${data.goal.statementId}, status ${data.goal.status}.`];
  if (data.holes.length > 0) {
    head.push(`Holes (${data.holes.length}):`, ...data.holes.slice(0, HOLES_SHOWN).map((h) => `- ${clip(h.statement, HOLE_CHARS)} [${h.status}]`));
    if (data.holes.length > HOLES_SHOWN) head.push(`- and ${data.holes.length - HOLES_SHOWN} more`);
  }
  const lemmas = data.lemmas;
  if (lemmas.length > 0) head.push(`Lemmas Lean accepted: ${lemmas.slice(0, LEMMAS_SHOWN).join(", ")}${lemmas.length > LEMMAS_SHOWN ? `, and ${lemmas.length - LEMMAS_SHOWN} more` : ""}.`);
  const approaches = data.approaches;
  const tail = data.timeouts > 0 ? [`Timeouts: ${data.timeouts}.`] : [];
  const line = (a: CardApproach) => `- ${a.count} x ${a.strategy} / ${a.failureClass} / ${a.detail}`;
  if (approaches.length === 0 && data.holes.length === 0 && lemmas.length === 0 && data.timeouts === 0) head.push("No session has checked a file on it yet.");
  for (let shown = approaches.length; shown >= 0; shown--) {
    const cut = approaches.length - shown;
    const body = approaches.length === 0 ? [] : ["Failed approaches (strategy / failure class / first error), most frequent first:", ...approaches.slice(0, shown).map(line), ...(cut > 0 ? [`- ${cut} less frequent failed approach${cut === 1 ? "" : "es"} not shown`] : [])];
    const text = [...head, ...body, ...tail].join("\n");
    if (text.length <= maxChars || shown === 0) return clip(text, maxChars);
  }
  return clip(head.join("\n"), maxChars);
}

/** The card of a claim: its data and its bounded text. Undefined for a claim the memory does not have. A pure function of the store. */
export function stateCard(store: MemoryStore, claimId: string, options: StateCardOptions = {}): StateCard | undefined {
  const data = stateCardData(store, claimId);
  return data === undefined ? undefined : { ...data, text: renderStateCard(data, options) };
}
