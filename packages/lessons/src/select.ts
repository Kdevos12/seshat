import type { Json } from "@seshat/core";
import { type DeactivationRule, shouldDeactivate } from "@seshat/memory";
import type { FinishedAttempt, ProblemContext } from "@seshat/lines";
import { allLessons, type LessonRecord } from "./records.ts";

/** How a lesson leaves: by its causal effect (PE2, the default) or by its presence counters (the ACE rule). */
export type DeactivationMode = "effect" | "presence";

export interface SelectOptions {
  deactivation: DeactivationMode;
  /** At least this many observations on each side (effect), or in all (presence), before a lesson can be deactivated. */
  minObservations: number;
  /** Deactivate when P(effect < 0) is above this. */
  threshold: number;
  /** The most lessons a session is shown: 2 or 3 gain, more lose (SkillsBench). */
  maxLessons: number;
}

/** Whether a lesson applies to the problem: global, its domain, or its claim and the claims equivalent to it. */
export function inScope(lesson: LessonRecord, problem: Pick<ProblemContext, "domain" | "claimId" | "memory">): boolean {
  if (lesson.scope === "global") return true;
  if (lesson.scope === "domain") return problem.domain.includes(lesson.scopeKey);
  return problem.memory.equivalents(problem.claimId).includes(lesson.scopeKey);
}

/**
 * Deactivates the lessons whose standing says so, before a session is drawn. By effect, the rule is Task 23's:
 * P(effect < 0) above the threshold after the minimum of observations with the lesson and as many without it, in
 * the lesson's strategy label (a claim lesson: in its claim group). By presence, harmful outweighs useful after the
 * minimum of observations. The change is a delta on the node, with the reason, and the lesson stays in the journal.
 */
export function deactivateWorn(problem: ProblemContext, o: SelectOptions): LessonRecord[] {
  const out: LessonRecord[] = [];
  for (const lesson of allLessons(problem.memory)) {
    if (lesson.state !== "active") continue;
    let reason: string | undefined;
    if (o.deactivation === "effect") {
      const rule: DeactivationRule = { minObservations: o.minObservations, threshold: o.threshold };
      const effect = problem.memory.itemEffect(lesson.nodeId, effectScope(lesson, problem));
      if (shouldDeactivate(effect, rule)) {
        reason = `P(effect < 0) = ${effect.pNegative.toFixed(2)} with ${effect.with.attempts} attempt(s) that had it (${effect.with.successes.toFixed(1)} accepted) and ${effect.without.attempts} that did not (${effect.without.successes.toFixed(1)} accepted)`;
      }
    } else if (lesson.harmful > lesson.useful && lesson.useful + lesson.harmful >= o.minObservations) {
      reason = `harmful ${lesson.harmful} outweighs useful ${lesson.useful}`;
    }
    if (reason === undefined) continue;
    problem.memory.updateNode(lesson.nodeId, { active: false, deactivated: { rule: o.deactivation, reason } } as unknown as Json, `deactivated by ${o.deactivation}`);
    problem.log(`lessons: deactivated "${lesson.text.slice(0, 60)}": ${reason}`);
    out.push(lesson);
  }
  return out;
}

/** The scope the effect of a lesson is measured in: its strategy label, and for a claim lesson its claim group. */
function effectScope(lesson: LessonRecord, problem: Pick<ProblemContext, "memory">): { claimIds?: readonly string[]; strategy?: string } {
  return {
    ...(lesson.scope === "claim" ? { claimIds: problem.memory.equivalents(lesson.scopeKey) } : {}),
    ...(lesson.strategy !== undefined ? { strategy: lesson.strategy } : {}),
  };
}

/**
 * How promising a lesson is to offer, by its measured effect and not by how often it was present (review I4). The score is the
 * difference between the success rates with the lesson and without it (the two posteriors of `itemEffect`, whose outcomes already
 * weigh their epoch's probation), plus an exploration bonus that shrinks with the weight of the observations of the arm that had it.
 * A new lesson, or one whose evidence is old and in probation, has a large bonus and is offered again, so that it gathers the
 * observations the deactivation rule needs; a lesson that is shown a great deal and does nothing falls behind.
 */
export function lessonScore(lesson: LessonRecord, problem: Pick<ProblemContext, "memory">): number {
  const effect = problem.memory.itemEffect(lesson.nodeId, effectScope(lesson, problem));
  const seen = effect.with.successes + effect.with.failures;
  return effect.difference + 1 / Math.sqrt(seen + 1);
}

/** The lessons a session may be offered: active, in scope, the most promising first (`lessonScore`), at most `maxLessons`. */
export function selectLessons(problem: Pick<ProblemContext, "domain" | "claimId" | "memory">, o: Pick<SelectOptions, "maxLessons">): LessonRecord[] {
  return allLessons(problem.memory)
    .filter((l) => l.state === "active" && inScope(l, problem))
    .map((l) => ({ l, score: lessonScore(l, problem) }))
    .sort((a, b) => b.score - a.score || b.l.createdSeq - a.l.createdSeq)
    .map((x) => x.l)
    .slice(0, Math.max(0, Math.floor(o.maxLessons)));
}

/**
 * The presence counters (deliverable 2): a lesson shown to a session whose attempt was accepted gains a point;
 * one shown to a failed attempt on the lesson's strategy loses one. They are deltas on the lesson's node.
 */
export function countOutcome(problem: ProblemContext, attempt: FinishedAttempt, label: string | undefined): void {
  if (attempt.outcome !== "valid" && attempt.outcome !== "invalid") return;
  const row = problem.memory.attempts(problem.claimId).find((a) => a.attemptId === attempt.attemptId);
  const shown = new Set(row?.included ?? []);
  if (shown.size === 0) return;
  for (const lesson of allLessons(problem.memory)) {
    if (!shown.has(lesson.nodeId)) continue;
    if (attempt.outcome === "valid") {
      problem.memory.updateNode(lesson.nodeId, { useful: lesson.useful + 1 }, `shown in accepted attempt ${attempt.attemptId}`);
    } else if (lesson.strategy === undefined || lesson.strategy === label) {
      problem.memory.updateNode(lesson.nodeId, { harmful: lesson.harmful + 1 }, `shown in failed attempt ${attempt.attemptId}`);
    }
  }
}
