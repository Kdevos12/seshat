import type { Json, Provenance } from "@seshat/core";
import type { MemoryNode, MemoryStore } from "@seshat/memory";

/** The node kinds of the lessons. This package owns them and the shape of their `data`. */
export const LESSON_KIND = "lesson";
export const DECISION_KIND = "lesson_decision";

/** What a lesson says: `strategy` (an approach that worked) or `constraint` (a failure that recurs, PC3). */
export type LessonType = "strategy" | "constraint";
/** Where a lesson applies: every problem, the problems of one domain (`msc:11`), or one claim and its equivalents. */
export type LessonScope = "global" | "domain" | "claim";

/**
 * The data of a `lesson` node. A lesson is never rewritten: its text is fixed when it is added, and the
 * only later changes are deltas, the counters, the supporting records of a duplicate that was merged into
 * it, and `active` going false.
 */
export interface LessonData {
  /** One or two sentences, from the journaled outcomes it rests on. */
  text: string;
  type: LessonType;
  scope: LessonScope;
  /** `""` for global, the domain for a domain lesson, the claim's id for a claim lesson. */
  scopeKey: string;
  /** The strategy label it is about; a presence counter counts a failure only on this strategy. */
  strategy?: string;
  /** What makes two lessons duplicates. */
  key: string;
  /** `outcome`: a template over the outcomes. `distilled`: one model call put the recurring failure in a line. */
  origin: "outcome" | "distilled";
  /** For a constraint: the failure class and normalized detail it comes from. */
  group?: string;
  /** The attempts it rests on, the claims they are on and their domains (the most recent ones, capped). */
  support: string[];
  claims: string[];
  domains: string[];
  /** The presence counters: attempts that were shown it and were accepted, and ones on its strategy that failed. */
  useful: number;
  harmful: number;
  /** False once deactivated. A lesson is never deleted. */
  active: boolean;
  /** True for a global lesson staged for the team's approval (`--human`) until a decision says otherwise. */
  pending?: boolean;
  /** The lessons a wider one was made from. */
  widenedFrom?: string[];
  deactivated?: { rule: string; reason: string };
}

/** `rejected`: the team said no. `deactivated`: the rule did. `pending`: waits for the team. */
export type LessonState = "active" | "deactivated" | "pending" | "rejected";

export interface LessonRecord extends LessonData {
  nodeId: string;
  createdSeq: number;
  epoch: number;
  /** The provenance stamp of the node (Global Constraint 16). */
  stamp?: Provenance;
  state: LessonState;
}

/** The data of a `lesson_decision` node: a person's answer to a staged promotion. Never a verdict of Lean. */
export interface DecisionData {
  lessonId: string;
  decision: "approve" | "reject";
  by: string;
  provenance: "human";
  note?: string;
}

export const MAX_SUPPORT = 50;

function object(data: Json): { [key: string]: Json } | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { [key: string]: Json }) : undefined;
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function number(value: Json | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The decisions the team made, by lesson: the last one of each stands. */
export function decisions(memory: MemoryStore): Map<string, DecisionData> {
  const result = new Map<string, DecisionData>();
  for (const node of memory.nodes(DECISION_KIND)) {
    const d = object(node.data);
    if (d === undefined || d.provenance !== "human" || typeof d.lessonId !== "string" || (d.decision !== "approve" && d.decision !== "reject")) continue;
    result.set(d.lessonId, { ...(d as unknown as DecisionData) });
  }
  return result;
}

function toLesson(node: MemoryNode, decided: ReadonlyMap<string, DecisionData>): LessonRecord | undefined {
  const d = object(node.data);
  if (d === undefined || typeof d.text !== "string" || typeof d.key !== "string") return undefined;
  const scope: LessonScope = d.scope === "domain" || d.scope === "claim" ? d.scope : "global";
  const active = d.active !== false;
  const decision = decided.get(node.nodeId)?.decision;
  const state: LessonState = decision === "reject" ? "rejected" : !active ? "deactivated" : d.pending === true && decision !== "approve" ? "pending" : "active";
  return {
    ...(d as unknown as LessonData),
    text: d.text,
    type: d.type === "constraint" ? "constraint" : "strategy",
    scope,
    scopeKey: typeof d.scopeKey === "string" ? d.scopeKey : "",
    key: d.key,
    origin: d.origin === "distilled" ? "distilled" : "outcome",
    support: strings(d.support),
    claims: strings(d.claims),
    domains: strings(d.domains),
    useful: number(d.useful),
    harmful: number(d.harmful),
    active,
    nodeId: node.nodeId,
    createdSeq: node.createdSeq,
    epoch: node.epoch,
    ...(node.provenance !== undefined ? { stamp: node.provenance } : {}),
    state,
  };
}

/** Every lesson the memory holds, in the order they were added, whatever their state. */
export function allLessons(memory: MemoryStore): LessonRecord[] {
  const decided = decisions(memory);
  return memory.nodes(LESSON_KIND).flatMap((node) => {
    const lesson = toLesson(node, decided);
    return lesson === undefined ? [] : [lesson];
  });
}

/** The lessons that wait for the team's approval of their promotion to the global scope. */
export function stagedLessons(memory: MemoryStore): LessonRecord[] {
  return allLessons(memory).filter((l) => l.state === "pending");
}

/** The data of a decision, for the command that records it under the person's name. */
export function decisionData(o: { lessonId: string; decision: "approve" | "reject"; by: string; note?: string }): DecisionData {
  return { lessonId: o.lessonId, decision: o.decision, by: o.by, provenance: "human", ...(o.note !== undefined ? { note: o.note } : {}) };
}
