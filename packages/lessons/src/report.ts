import { type HarnessEvent, type Json, mergePatch } from "@seshat/core";
import { DECISION_KIND, type DecisionData, LESSON_KIND, type LessonData, type LessonState } from "./records.ts";

/** One lesson as the report shows it: its standing by presence and by effect, side by side (PE2). */
export interface LessonLine {
  nodeId: string;
  text: string;
  scope: string;
  scopeKey: string;
  type: string;
  state: LessonState;
  origin: string;
  /** The presence counters. */
  useful: number;
  harmful: number;
  /** The attempts whose draw included it and the ones whose draw withheld it, with the accepted ones of each. */
  with: { attempts: number; accepted: number };
  without: { attempts: number; accepted: number };
  /** Why it was deactivated, when it was. */
  deactivated?: string;
}

export interface LessonReport {
  total: number;
  byState: Record<LessonState, number>;
  lessons: LessonLine[];
}

/**
 * The lessons of a run, from its journal: counts by state, and for each lesson the presence counters next to what
 * the randomized inclusion measured (accepted attempts with it and without it). Undefined when the run recorded none.
 */
export function lessonReport(events: readonly HarnessEvent[]): LessonReport | undefined {
  const nodes = new Map<string, { kind: string; data: Json }>();
  const drawn = new Map<string, { included: string[]; withheld: string[]; outcome?: string }>();
  for (const event of events) {
    if (event.type === "node.recorded") nodes.set(event.data.nodeId, { kind: event.data.kind, data: event.data.data });
    else if (event.type === "node.updated") {
      const node = nodes.get(event.data.nodeId);
      if (node !== undefined) node.data = mergePatch(node.data, event.data.patch);
    } else if (event.type === "attempt.started") {
      drawn.set(event.data.attemptId, { included: event.data.included ?? [], withheld: event.data.withheld ?? [] });
    } else if (event.type === "attempt.finished") {
      const a = drawn.get(event.data.attemptId);
      if (a !== undefined) a.outcome = event.data.outcome;
    }
  }
  const decided = new Map<string, DecisionData>();
  for (const n of nodes.values()) {
    const d = n.data as unknown as DecisionData;
    if (n.kind === DECISION_KIND && d.provenance === "human") decided.set(d.lessonId, d);
  }
  const lessons: LessonLine[] = [];
  for (const [nodeId, n] of nodes) {
    if (n.kind !== LESSON_KIND) continue;
    const d = n.data as unknown as LessonData;
    const decision = decided.get(nodeId)?.decision;
    const state: LessonState = decision === "reject" ? "rejected" : d.active === false ? "deactivated" : d.pending === true && decision !== "approve" ? "pending" : "active";
    const line: LessonLine = {
      nodeId, text: d.text, scope: d.scope, scopeKey: d.scopeKey, type: d.type, state, origin: d.origin,
      useful: d.useful ?? 0, harmful: d.harmful ?? 0,
      with: { attempts: 0, accepted: 0 }, without: { attempts: 0, accepted: 0 },
      ...(d.deactivated !== undefined ? { deactivated: `${d.deactivated.rule}: ${d.deactivated.reason}` } : {}),
    };
    for (const a of drawn.values()) {
      if (a.outcome !== "valid" && a.outcome !== "invalid") continue;
      const arm = a.included.includes(nodeId) ? line.with : a.withheld.includes(nodeId) ? line.without : undefined;
      if (arm === undefined) continue;
      arm.attempts += 1;
      if (a.outcome === "valid") arm.accepted += 1;
    }
    lessons.push(line);
  }
  if (lessons.length === 0) return undefined;
  const byState: Record<LessonState, number> = { active: 0, deactivated: 0, pending: 0, rejected: 0 };
  for (const l of lessons) byState[l.state] += 1;
  return { total: lessons.length, byState, lessons };
}

const rate = (arm: { attempts: number; accepted: number }): string => (arm.attempts === 0 ? "none" : `${arm.accepted}/${arm.attempts}`);

/** The paragraph of a run report (`report.md`). */
export function renderLessonReport(report: LessonReport): string {
  const s = report.byState;
  const states = [`${s.active} active`, `${s.deactivated} deactivated`, `${s.pending} waiting for the team`, `${s.rejected} rejected`].filter((x) => !x.startsWith("0 ")).join(", ");
  const w = { attempts: 0, accepted: 0 };
  const wo = { attempts: 0, accepted: 0 };
  for (const l of report.lessons) {
    w.attempts += l.with.attempts; w.accepted += l.with.accepted;
    wo.attempts += l.without.attempts; wo.accepted += l.without.accepted;
  }
  const useful = report.lessons.reduce((n, l) => n + l.useful, 0);
  const harmful = report.lessons.reduce((n, l) => n + l.harmful, 0);
  return (
    `Lessons: ${report.total} (${states}). Presence counters: ${useful} useful, ${harmful} harmful. ` +
    `Accepted proofs among attempts that were drawn a lesson: ${rate(w)} with it, ${rate(wo)} without it.`
  );
}
