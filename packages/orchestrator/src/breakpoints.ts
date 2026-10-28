import { type HarnessEvent, type Journal, type Projection, type ProblemRow } from "@seshat/core";
import { HINT_KIND, STEER_KIND } from "./team.ts";
import type { ImpasseSettings, Turn } from "./turns.ts";

/**
 * Human breakpoints (documentation/human.md, "Breakpoints"): the same stop as a turn limit, struck
 * earlier by an event that is decided by the journal and never by a model: an impasse on a problem, a
 * problem settled, or two informal validators that disagree. They are on in every consortium run.
 *
 * A breakpoint fires once for what it saw. The turn that it ends records it (`turn.ended.breakpoint`),
 * and the next turn reads that back: a problem at an impasse is not an impasse again until it has done
 * new work (as many finished attempts as the impasse needs) or the team has answered about its claim;
 * a settled problem, and a disagreement, are reported once.
 */

/** The node kind a judge records when its votes disagree (plan change PC9): `data.disagreement` is true. */
export const JUDGMENT_KIND = "judgment";

/** The kinds of breakpoint. */
export type BreakpointKind = "impasse" | "settled" | "disagreement";

interface Seen {
  /** The seq of the `turn.ended` that reported an impasse of the problem, for each problem. */
  impasse: Map<string, number>;
  settled: Set<string>;
  disagreements: Set<string>;
}

function readSeen(events: readonly HarnessEvent[]): Seen {
  const seen: Seen = { impasse: new Map(), settled: new Set(), disagreements: new Set() };
  for (const event of events) {
    if (event.type !== "turn.ended" || event.data.breakpoint === undefined) continue;
    const { kind, problemId, nodeId } = event.data.breakpoint;
    if (kind === "impasse" && problemId !== undefined) seen.impasse.set(problemId, event.seq);
    if (kind === "settled" && problemId !== undefined) seen.settled.add(problemId);
    if (kind === "disagreement" && nodeId !== undefined) seen.disagreements.add(nodeId);
  }
  return seen;
}

/** The finished attempts of a problem's tasks that say something about its proof: accepted or failed. */
function judged(p: Projection, problemId: string, afterSeq: number): { valid: number; invalid: number } {
  let valid = 0;
  let invalid = 0;
  for (const task of p.tasks({ problemId })) {
    for (const attempt of p.attemptsOfTask(task.task_id)) {
      if ((attempt.finished_seq ?? -1) <= afterSeq) continue;
      if (attempt.outcome === "valid") valid += 1;
      else if (attempt.outcome === "invalid") invalid += 1;
    }
  }
  return { valid, invalid };
}

/**
 * The mean of a problem's success posterior, Beta(1 + accepted, 1 + failed) over its finished attempts
 * after `afterSeq`: the chance, as far as the problem's own record goes, that the next attempt is accepted.
 */
export function posteriorMean(p: Projection, problemId: string, afterSeq = -1): { mean: number; attempts: number } {
  const { valid, invalid } = judged(p, problemId, afterSeq);
  return { mean: (1 + valid) / (2 + valid + invalid), attempts: valid + invalid };
}

/** What the journal shows of a problem at an impasse, or undefined: every task still open is blocked, or its posterior is low. */
export function impasseOf(p: Projection, problem: ProblemRow, settings: ImpasseSettings, afterSeq = -1): string | undefined {
  const open = p.tasks({ problemId: problem.problem_id }).filter((task) => !["done", "failed", "cancelled"].includes(task.status));
  if (open.length > 0 && open.every((task) => task.status === "blocked")) {
    return `every open task of ${problem.target} is blocked (${[...new Set(open.flatMap((task) => task.blocked_by ?? []))].join(", ")})`;
  }
  const { mean, attempts } = posteriorMean(p, problem.problem_id, afterSeq);
  // "After 8 attempts, a posterior below 0.1": Beta(1, 1 + 8) has mean 1/10, so the boundary is included and the default fires at the 8th.
  if (attempts >= settings.minAttempts && mean <= settings.posteriorBelow) {
    return `${problem.target} has ${attempts} finished attempts and its success posterior is ${mean.toFixed(3)}, at or below ${settings.posteriorBelow}`;
  }
  return undefined;
}

export class Breakpoints {
  private readonly journal: Journal;
  private readonly turn: Turn;
  private readonly settings: ImpasseSettings;
  private readonly seen: Seen;
  /** The seq of the last turn that ended before this one began: a claim settled before it was reported in that turn's account. */
  private readonly lastEnded: number;

  constructor(o: { journal: Journal; turn: Turn; settings: ImpasseSettings; events: readonly HarnessEvent[] }) {
    this.journal = o.journal;
    this.turn = o.turn;
    this.settings = o.settings;
    this.seen = readSeen(o.events);
    this.lastEnded = o.events.findLast((event) => event.type === "turn.ended")?.seq ?? -1;
  }

  /** After an attempt of a problem ended: its impasse, and any disagreement the lines recorded. */
  afterAttempt(problemId: string): void {
    this.impasse(problemId);
    this.disagreement();
  }

  /** After a problem ended: a problem settled, or one that ended at an impasse; and any disagreement. */
  afterProblem(problemId: string): void {
    const p = this.journal.projection;
    const problem = p.problem(problemId);
    if (problem === undefined) return;
    // A claim the end of an earlier turn certified (a candidate held at the limit is certified before the run exits) was in
    // that turn's account as settled: closing the problem now is not news, and does not end this turn.
    const claim = p.claim(problem.claim_id);
    const certifiedBefore = claim !== undefined && claim.updated_seq >= 0 && claim.updated_seq < this.lastEnded;
    if ((problem.outcome === "proved" || problem.outcome === "refuted") && !this.seen.settled.has(problemId) && !certifiedBefore) {
      this.turn.strike({
        reason: "settled",
        detail: `${problem.target} is ${problem.outcome}`,
        breakpoint: { kind: "settled", problemId },
      });
    } else if (problem.outcome === "unsolved" && this.armed(problem)) {
      this.turn.strike({
        reason: "impasse",
        detail: `${problem.target} ended unsolved${problem.reason !== null ? `: ${problem.reason}` : ""}`,
        breakpoint: { kind: "impasse", problemId },
      });
    }
    this.disagreement();
  }

  private impasse(problemId: string): void {
    const p = this.journal.projection;
    const problem = p.problem(problemId);
    if (problem === undefined || problem.finished_seq !== null || !this.armed(problem)) return;
    const reason = impasseOf(p, problem, this.settings, this.seen.impasse.get(problemId) ?? -1);
    if (reason !== undefined) this.turn.strike({ reason: "impasse", detail: reason, breakpoint: { kind: "impasse", problemId } });
  }

  /** A problem that was reported at an impasse is armed again by new work or by an answer about its claim. */
  private armed(problem: ProblemRow): boolean {
    const p = this.journal.projection;
    const at = this.seen.impasse.get(problem.problem_id);
    if (at === undefined) return true;
    const { attempts } = posteriorMean(p, problem.problem_id, at);
    if (attempts >= this.settings.minAttempts) return true;
    return [HINT_KIND, STEER_KIND].some((kind) => p.nodes(kind, problem.claim_id).some((node) => node.created_seq > at));
  }

  private disagreement(): void {
    const p = this.journal.projection;
    for (const node of p.nodes(JUDGMENT_KIND)) {
      const data = node.data;
      if (typeof data !== "object" || data === null || Array.isArray(data) || data.disagreement !== true) continue;
      if (this.seen.disagreements.has(node.node_id)) continue;
      const subject = typeof data.subject === "string" ? `: ${data.subject}` : "";
      this.turn.strike({
        reason: "disagreement",
        detail: `two informal validators disagree about ${node.claim_id ?? node.node_id}${subject}`,
        breakpoint: { kind: "disagreement", nodeId: node.node_id },
      });
      return;
    }
  }
}
