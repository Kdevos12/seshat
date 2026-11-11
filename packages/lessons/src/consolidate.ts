import type { Json } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import { allLessons, type LessonRecord, MAX_SUPPORT } from "./records.ts";

/**
 * The lesson side of the consolidation pass (documentation/lessons.md, "Consolidation"): duplicates merged, and lessons whose support
 * the journal no longer backs flagged. Both read the memory and return a plan; applying a plan writes deltas (`node.updated`) and
 * nothing else. A lesson is never deleted or rewritten, and a run with no consolidation has neither a `mergedInto` nor a `flagged`.
 */

/** What makes two lessons duplicates here: type, scope and normalised text (case, spacing and final punctuation do not count). */
export function duplicateKey(l: Pick<LessonRecord, "type" | "scope" | "scopeKey" | "text">): string {
  const text = l.text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?;:,]+$/, "").trim();
  return JSON.stringify([l.type, l.scope, l.scopeKey, text]);
}

export interface MergePlan {
  /** The oldest lesson of the group: it stays and takes the others' support and counters. */
  keep: string;
  merged: string[];
  support: string[];
  claims: string[];
  domains: string[];
  useful: number;
  harmful: number;
}

/**
 * The groups of duplicate lessons: same type, scope and normalised text, in the same standing (`active` or waiting for the team; a
 * deactivated or rejected lesson is left as it is). The oldest of a group is kept.
 */
export function planMerges(memory: MemoryStore): MergePlan[] {
  const groups = new Map<string, LessonRecord[]>();
  for (const l of allLessons(memory)) {
    if (l.state !== "active" && l.state !== "pending") continue;
    const key = `${l.state}|${duplicateKey(l)}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const plans: MergePlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((a, b) => a.createdSeq - b.createdSeq) as [LessonRecord, ...LessonRecord[]];
    const union = (pick: (l: LessonRecord) => string[]): string[] => [...new Set(group.flatMap(pick))].slice(-MAX_SUPPORT);
    plans.push({
      keep: keep.nodeId,
      merged: rest.map((l) => l.nodeId),
      support: union((l) => l.support),
      claims: union((l) => l.claims),
      domains: union((l) => l.domains),
      useful: group.reduce((n, l) => n + l.useful, 0),
      harmful: group.reduce((n, l) => n + l.harmful, 0),
    });
  }
  return plans;
}

/**
 * Applies a merge: the kept lesson takes the union of the support, claims and domains (the latest 50) and the sum of the presence
 * counters; each duplicate is deactivated (rule `merged`) and names the lesson it went into. The duplicates' own draws and effects stay
 * under their ids: the kept lesson's effect is not recomputed from them.
 */
export function applyMerge(memory: MemoryStore, plan: MergePlan): void {
  memory.updateNode(plan.keep, { support: plan.support, claims: plan.claims, domains: plan.domains, useful: plan.useful, harmful: plan.harmful } as unknown as Json, `${plan.merged.length} duplicate lesson(s) merged into it`);
  for (const id of plan.merged) {
    memory.updateNode(id, { active: false, mergedInto: plan.keep, deactivated: { rule: "merged", reason: `a duplicate of ${plan.keep}, merged into it` } } as unknown as Json, "merged into a duplicate");
  }
}

export interface FlagPlan {
  lessonId: string;
  reason: string;
  /** Supporting attempts the chain does not hold, and the ones on a retracted claim. */
  missing: number;
  retracted: number;
  total: number;
}

/**
 * The lessons whose support the journal no longer backs. Support is the attempts a lesson lists (`support`); one backs it when the chain
 * holds the attempt and its claim is not `retracted`. A lesson none of whose supporting attempts backs it (including one that lists none)
 * is flagged. Lessons already flagged, deactivated or rejected are not looked at again.
 */
export function planFlags(memory: MemoryStore): FlagPlan[] {
  const attempts = new Map<string, string>();
  for (const claim of memory.claims()) for (const a of memory.attempts(claim.claimId)) attempts.set(a.attemptId, claim.claimId);
  const plans: FlagPlan[] = [];
  for (const l of allLessons(memory)) {
    if ((l.state !== "active" && l.state !== "pending") || (l as { flagged?: unknown }).flagged !== undefined) continue;
    let missing = 0;
    let retracted = 0;
    let backed = 0;
    for (const id of l.support) {
      const claimId = attempts.get(id);
      if (claimId === undefined) missing += 1;
      else if (memory.claim(claimId)?.status === "retracted") retracted += 1;
      else backed += 1;
    }
    if (backed > 0) continue;
    plans.push({
      lessonId: l.nodeId,
      reason: l.support.length === 0 ? "it lists no supporting attempt" : `none of its ${l.support.length} supporting attempt(s) is backed: ${missing} missing from the chain, ${retracted} on a retracted claim`,
      missing,
      retracted,
      total: l.support.length,
    });
  }
  return plans;
}

/** Flags a lesson: it waits for a person (`pending`, the staged state `harness lessons` lists) and shows no session until one approves it. */
export function applyFlag(memory: MemoryStore, plan: FlagPlan): void {
  memory.updateNode(plan.lessonId, { pending: true, flagged: { reason: plan.reason, missing: plan.missing, retracted: plan.retracted, total: plan.total } } as unknown as Json, "support not backed by the journal");
}
