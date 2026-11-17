import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Projection } from "@seshat/core";
import { frontier, type FrontierEntry, type FrontierOptions, frontierScore, MemoryStore, topEntries } from "@seshat/memory";
import { chainProblems, modelFreePart } from "./consolidate.ts";
import { JUDGMENT_KIND } from "./breakpoints.ts";
import { HINT_KIND, STEER_KIND } from "./team.ts";
import { turnRecords } from "./turns.ts";

/**
 * The digest of a campaign (`campaign/digest.md`, documentation/campaign.md, "The digest"): what a person reads to see where the run stands without
 * having been asked for anything. It is rebuilt by code from the journal after each turn: the frontier, what changed in the turn, the open questions,
 * the spend. No model writes it, and it is bounded: every list is cut at a few lines and the page at `DIGEST_CHARS` characters, so it does not grow with
 * the campaign's age.
 */

/** The most characters of a digest. */
export const DIGEST_CHARS = 7000;
/** The most lines of each list in it. */
const LIST = 8;
const STATEMENT = 140;

const clip = (text: string, chars: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`;
};
const money = (usd: number): string => `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;

/** What the supervisor knows that the journal does not hold as one fact: the pacing and the clock. */
export interface DigestContext {
  /** The state of the campaign: still working, or why it ended (`settled`, or the reason it stopped). */
  state: "working" | string;
  usdPerDay?: number;
  until?: string;
  /** The UTC day's spend so far, and the day. */
  today?: { day: string; usd: number };
  /** The run's allowance, the run's budget. */
  allowanceUsd?: number;
  /** What the next turn waits for, in a phrase, when it waits. */
  waiting?: string;
  frontierOptions?: FrontierOptions;
}

/** One list, cut: the lines shown, then how many more there were. */
function listed(lines: readonly string[], none: string): string[] {
  if (lines.length === 0) return [none];
  return [...lines.slice(0, LIST), ...(lines.length > LIST ? [`- and ${lines.length - LIST} more`] : [])];
}

function entryLine(e: FrontierEntry, fresh: boolean): string {
  return `- ${e.kind}: ${clip(e.statement, STATEMENT)}${e.status !== undefined ? ` [${e.status}]` : ""}${fresh ? " (new)" : ""}`;
}

/** The score of the entries established by `seq`. */
function scoreAt(entries: readonly FrontierEntry[], seq: number, options: FrontierOptions): number {
  return frontierScore(entries.filter((e) => e.seq <= seq), options);
}

/** The score of the frontier at the end of each completed turn, for the spiral guard and the digest: one number for each turn, in order. */
export function scoresByTurn(events: readonly HarnessEvent[], p: Projection, options: FrontierOptions): Array<{ turn: number; score: number; usd: number }> {
  const store = MemoryStore.readOnly(p);
  const entries = p.problems().flatMap((row) => frontier(store, row.claim_id, options).entries);
  return turnRecords(events).flatMap((t) => (t.end === undefined || t.endedSeq === undefined ? [] : [{ turn: t.turn, score: scoreAt(entries, t.endedSeq, options), usd: t.end.spent.turn.usd }]));
}

/** The text of the digest, from the journal's events and its projection. */
export function renderDigest(events: readonly HarnessEvent[], p: Projection, ctx: DigestContext): string {
  const options = ctx.frontierOptions ?? {};
  const store = MemoryStore.readOnly(p);
  const problems = p.problems();
  const turns = turnRecords(events);
  const last = [...turns].reverse().find((t) => t.end !== undefined);
  const before = last === undefined ? undefined : turns.filter((t) => t.turn < last.turn && t.end !== undefined).at(-1);
  const lines: string[] = [];
  const targets = problems.map((row) => clip(row.target, 80));
  lines.push(`# Campaign digest${targets.length > 0 ? `: ${targets.slice(0, 2).join("; ")}${targets.length > 2 ? ", ..." : ""}` : ""}`, "");
  const claimStates = problems.map((row) => `${p.claim(row.claim_id)?.status ?? "open"}`);
  lines.push(
    `State: ${ctx.state === "working" ? "working" : ctx.state === "settled" ? "settled (the certifier's kernel replay settled the target)" : `stopped (${ctx.state})`}. ` +
      `Turn ${last?.turn ?? 0} of the campaign has ended${last?.end !== undefined ? `: ${last.end.reason}` : ""}. The target is ${claimStates.join(", ") || "not registered yet"}.` +
      `${ctx.waiting !== undefined ? ` Next: ${ctx.waiting}.` : ""}`,
    "",
  );

  // The frontier: what is established so far, never a claim's status.
  lines.push("## Frontier", "");
  const all: FrontierEntry[] = [];
  for (const row of problems) all.push(...frontier(store, row.claim_id, options).entries);
  const score = frontierScore(all, options);
  const was = before === undefined ? 0 : scoreAt(all, before.endedSeq ?? 0, options);
  const wasLast = last?.endedSeq === undefined ? score : scoreAt(all, last.endedSeq, options);
  lines.push(`Score ${score} from ${all.length} established item(s) (${score - (last === undefined ? 0 : was) >= 0 ? "+" : ""}${Math.round((wasLast - was) * 100) / 100} in the last turn).`, "");
  const startSeq = last?.startedSeq ?? 0;
  const top = topEntries({ claimId: "", entries: all, score, counts: {} as never }, LIST, options);
  lines.push(...listed(top.map((e) => entryLine(e, e.seq > startSeq)), "Nothing is established yet."), "");

  // What changed in the last turn, from the events after it began.
  lines.push("## This turn", "");
  if (last?.end === undefined) lines.push("No turn has ended yet.", "");
  else {
    const end = last.end;
    const inTurn = events.filter((e) => e.seq > last.startedSeq && e.seq < (last.endedSeq ?? Infinity));
    const finished = inTurn.flatMap((e) => (e.type === "attempt.finished" ? [e.data.outcome] : []));
    const by = (o: string): number => finished.filter((x) => x === o).length;
    lines.push(
      `- Turn ${end.turn} ended: ${end.reason}${end.detail !== "" ? ` (${clip(end.detail, 200)})` : ""}.`,
      `- It spent ${money(end.spent.turn.usd)} in ${end.minutes} minute(s); the run has spent ${money(end.spent.run.usd)}.`,
      `- ${finished.length} session(s) ended: ${by("valid")} valid, ${by("invalid")} invalid, ${by("no_submission")} with no submission, ${by("error")} with an error, ${by("aborted")} cut.`,
    );
    const claims = inTurn.flatMap((e) => (e.type === "claim.status_changed" ? [`${e.data.claimId}: ${e.data.from} to ${e.data.to}`] : []));
    if (claims.length > 0) lines.push(`- Claim status changes (by Lean): ${claims.slice(0, LIST).join("; ")}${claims.length > LIST ? `; and ${claims.length - LIST} more` : ""}.`);
    const fresh = all.filter((e) => e.seq > startSeq);
    lines.push(`- ${fresh.length} new frontier item(s)${fresh.length > 0 ? ":" : "."}`, ...fresh.slice(0, LIST).map((e) => `  ${entryLine(e, false)}`), ...(fresh.length > LIST ? [`  - and ${fresh.length - LIST} more`] : []));
    const modes = events.filter((e) => e.type === "campaign.mode_changed" && e.data.turn === end.turn);
    for (const m of modes) if (m.type === "campaign.mode_changed") lines.push(`- Change of mode after the impasse: ${m.data.mode} (${clip(m.data.reason, 200)}).`);
    lines.push("");
  }

  // The questions that nobody had to answer for the run to go on.
  lines.push("## Open questions", "");
  const questions: string[] = [];
  const answered = (claimId: string | null, afterSeq: number): boolean => [HINT_KIND, STEER_KIND].some((kind) => p.nodes(kind, claimId ?? undefined).some((n) => n.created_seq > afterSeq));
  for (const t of turns) {
    const bp = t.end?.breakpoint;
    if (bp === undefined) continue;
    if (bp.kind === "disagreement") {
      const node = bp.nodeId === undefined ? undefined : p.nodes(JUDGMENT_KIND).find((n) => n.node_id === bp.nodeId);
      if (!answered(node?.claim_id ?? null, t.endedSeq ?? 0)) questions.push(`- Two informal validators disagreed (turn ${t.turn}): ${clip(t.end?.detail ?? "", 200)}. The campaign went on without an answer; \`harness hint\` or \`harness sign\` tells it.`);
    } else if (bp.kind === "literature" || bp.kind === "vacuous") {
      questions.push(`- Before the first session (turn ${t.turn}): ${clip(t.end?.detail ?? "", 200)}. A run with a person would have waited here; the campaign went on without an answer.`);
    }
  }
  lines.push(...listed(questions.slice(-LIST), "None. (A question a line would ask the team goes here, and the campaign goes on without the answer.)"), "");
  const hints = p.nodes(HINT_KIND);
  if (hints.length > 0) lines.push(`${hints.length} hint(s) from the team are in force; the sessions are shown them as hints, never as facts.`, "");

  // The consolidation without a model (CA24): a count, and the page of the turn's account has the cards.
  try {
    const part = modelFreePart(store, chainProblems(events));
    lines.push(`Consolidation (no model): ${part.cards.length} open state card(s), ${part.merges.length} group(s) of duplicate lessons, ${part.flags.length} unsupported lesson(s).`, "");
  } catch {
    // The count is a courtesy: without it the digest is what it was.
  }

  lines.push("## Spend", "");
  const total = p.totalSpend().usd;
  lines.push(`- The run has spent ${money(total)}${ctx.allowanceUsd !== undefined ? ` of its allowance of ${money(ctx.allowanceUsd)}` : ""}.`);
  if (ctx.usdPerDay !== undefined) lines.push(`- Today (UTC ${ctx.today?.day ?? "?"}) it has spent ${money(ctx.today?.usd ?? 0)} of the daily cap ${money(ctx.usdPerDay)}.`);
  if (ctx.until !== undefined) lines.push(`- It stops at ${ctx.until} at the latest.`);
  lines.push("");

  let text = lines.join("\n");
  if (text.length > DIGEST_CHARS) text = `${text.slice(0, DIGEST_CHARS - 40).trimEnd()}\n\n(cut: the digest is bounded)\n`;
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Writes `campaign/digest.md` of a run directory, whole or not at all. Returns its path, relative to the run directory. */
export function writeDigest(dir: string, text: string): string {
  const folder = join(dir, "campaign");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "digest.md");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
  return join("campaign", "digest.md");
}
