import type { Json } from "@seshat/core";
import { completeJson, isInterrupted, type FinishedAttempt, type ProblemContext } from "@seshat/lines";
import { type Attempt, classifyStrategy, isStrategy, type MemoryStore, normalizeDetail, screenProse } from "@seshat/memory";
import { allLessons, LESSON_KIND, type LessonData, type LessonRecord, type LessonScope, MAX_SUPPORT } from "./records.ts";

/** How global promotion works: `human` stages it in a run with `--human` and applies it otherwise. */
export type GlobalPromotion = "human" | "staged" | "direct" | "off";

export interface LearnOptions {
  globalPromotion: GlobalPromotion;
  /** A strategy becomes a global lesson when it worked in this many domains and on this many claims. */
  globalMinDomains: number;
  globalMinClaims: number;
  /** A failure is a constraint when this many attempts show it (PC3). */
  minAttempts: number;
  /** Put a constraint in a line with one model call; without, or when the call fails, a template does. */
  distill: boolean;
  /** The most constraints one problem's end distills. */
  maxDistill: number;
}

const FAILURE_CLASSES_WITHOUT_ADVICE = new Set(["lean_unavailable", "refused", "other"]);
const MAX_TEXT = 240;

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].slice(-MAX_SUPPORT);
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** What a lesson adds: everything but its counters and its state, which the line owns. */
export interface LessonDraft {
  text: string;
  type: LessonData["type"];
  scope: LessonScope;
  scopeKey: string;
  strategy?: string;
  key: string;
  origin: LessonData["origin"];
  group?: string;
  support: readonly string[];
  claims: readonly string[];
  domains: readonly string[];
  pending?: boolean;
  widenedFrom?: readonly string[];
}

/**
 * Adds a lesson, or merges it into the one that has its key: a duplicate adds its supporting records to the
 * older entry and nothing else (the text is never rewritten and the counters do not move). Returns the
 * entry and whether it is new. A claim lesson is recorded on its claim.
 */
export function addLesson(memory: MemoryStore, draft: LessonDraft): { lesson: LessonRecord | undefined; nodeId: string; created: boolean; rejected?: string } {
  const existing = allLessons(memory).find((l) => l.key === draft.key);
  if (existing !== undefined) {
    const support = union(existing.support, draft.support);
    const claims = union(existing.claims, draft.claims);
    const domains = union(existing.domains, draft.domains);
    if (support.length !== existing.support.length || claims.length !== existing.claims.length || domains.length !== existing.domains.length) {
      memory.updateNode(existing.nodeId, { support, claims, domains }, "a duplicate lesson merged into it");
    }
    return { lesson: existing, nodeId: existing.nodeId, created: false };
  }
  // A lesson reaches prompts: its text passes the strict screen, whoever wrote it (review I3).
  const screened = screenProse(draft.text, { max: MAX_TEXT });
  if (!screened.ok) return { lesson: undefined, nodeId: "", created: false, rejected: screened.reason };
  const data: LessonData = {
    text: screened.text,
    type: draft.type,
    scope: draft.scope,
    scopeKey: draft.scopeKey,
    ...(draft.strategy !== undefined ? { strategy: draft.strategy } : {}),
    key: draft.key,
    origin: draft.origin,
    ...(draft.group !== undefined ? { group: draft.group } : {}),
    support: [...draft.support].slice(-MAX_SUPPORT),
    claims: [...draft.claims].slice(-MAX_SUPPORT),
    domains: [...draft.domains].slice(-MAX_SUPPORT),
    useful: 0,
    harmful: 0,
    active: true,
    ...(draft.pending === true ? { pending: true } : {}),
    ...(draft.widenedFrom !== undefined ? { widenedFrom: [...draft.widenedFrom] } : {}),
  };
  const node = memory.recordNode({
    kind: LESSON_KIND,
    ...(draft.scope === "claim" ? { claimId: draft.scopeKey } : {}),
    data: data as unknown as Json,
    learned: true,
  });
  return { lesson: undefined, nodeId: node.nodeId, created: true };
}

/** Whether a promotion to the global scope waits for the team in this run. */
export function stagesGlobal(mode: GlobalPromotion, human: boolean | undefined): boolean {
  return mode === "staged" || (mode === "human" && human === true);
}

/**
 * The strategy label an attempt is credited with: the one `classifyStrategy` reads from its submission (the label M1
 * records, so the counters and the effects agree), else the one a line or the model declared.
 */
export function labelOf(attempt: Pick<FinishedAttempt, "strategy" | "declaredStrategy" | "submission">): string | undefined {
  if (attempt.submission !== undefined) return classifyStrategy({ aux: attempt.submission.aux, proof: attempt.submission.proof });
  return attempt.strategy ?? attempt.declaredStrategy;
}

/**
 * An accepted proof teaches a domain lesson: the strategy worked there (the fast check accepted it; the
 * certifier has not replayed it yet, and the lesson says "accepted"). The same strategy in enough domains
 * and on enough claims widens to a global lesson, which is staged for the team in a run with `--human`.
 */
export function learnStrategy(problem: ProblemContext, attempt: FinishedAttempt, label: string | undefined, o: LearnOptions): { added: number } {
  if (attempt.outcome !== "valid" || label === undefined || !isStrategy(label) || label === "other") return { added: 0 };
  const domain = problem.domain[0] ?? "general";
  let added = 0;
  const first = addLesson(problem.memory, {
    text: `A proof using the ${label} strategy passed the fast check on ${domain} problems; try that strategy early.`,
    type: "strategy",
    scope: "domain",
    scopeKey: domain,
    strategy: label,
    key: `strategy|domain|${domain}|${label}`,
    origin: "outcome",
    support: [attempt.attemptId],
    claims: [problem.claimId],
    domains: [domain],
  });
  if (first.created) added += 1;
  if (o.globalPromotion === "off") return { added };
  const same = allLessons(problem.memory).filter((l) => l.type === "strategy" && l.scope === "domain" && l.strategy === label && l.state === "active");
  const domains = new Set(same.flatMap((l) => l.domains));
  const claims = new Set(same.flatMap((l) => l.claims));
  if (domains.size < o.globalMinDomains || claims.size < o.globalMinClaims) return { added };
  const wider = addLesson(problem.memory, {
    text: `A proof using the ${label} strategy passed the fast check in ${domains.size} domains (${[...domains].slice(0, 4).join(", ")}); try that strategy early.`,
    type: "strategy",
    scope: "global",
    scopeKey: "",
    strategy: label,
    key: `strategy|global||${label}`,
    origin: "outcome",
    support: same.flatMap((l) => l.support),
    claims: [...claims],
    domains: [...domains],
    ...(stagesGlobal(o.globalPromotion, problem.human) ? { pending: true } : {}),
    widenedFrom: same.map((l) => l.nodeId),
  });
  if (wider.created) {
    added += 1;
    problem.log(`lessons: the \`${label}\` strategy widened to a global lesson${stagesGlobal(o.globalPromotion, problem.human) ? ", staged for the team (harness lessons pending)" : ""}`);
  }
  return { added };
}

/** A failure that recurs: its group (class and normalized detail), the attempts that show it and their claims. */
export interface FailureGroup {
  group: string;
  failureClass: string;
  detail: string;
  attempts: string[];
  claims: string[];
  /** A statement or two, for the model to see what the claims are like. */
  statements: string[];
}

/** The groups of failed attempts with the same class and normalized detail, over every claim of the run. */
export function failureGroups(memory: MemoryStore): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const claim of memory.claims()) {
    for (const a of memory.attempts(claim.claimId) as Attempt[]) {
      if (a.outcome !== "invalid" || a.failureClass === undefined || FAILURE_CLASSES_WITHOUT_ADVICE.has(a.failureClass)) continue;
      const detail = normalizeDetail(a.failureDetail ?? "");
      if (detail === "") continue;
      const group = `${a.failureClass}|${detail}`;
      const g = groups.get(group) ?? { group, failureClass: a.failureClass, detail, attempts: [], claims: [], statements: [] };
      groups.set(group, g);
      g.attempts.push(a.attemptId);
      if (!g.claims.includes(claim.claimId)) {
        g.claims.push(claim.claimId);
        if (g.statements.length < 3) g.statements.push(clip(claim.statement, 160));
      }
    }
  }
  return [...groups.values()];
}

function templateText(g: FailureGroup): string {
  return `The check rejected ${g.attempts.length} attempts on ${g.claims.length} claim(s) the same way (${g.failureClass.replace(/_/g, " ")}: ${g.detail}); check for it before you submit.`;
}

async function distilled(problem: ProblemContext, g: FailureGroup): Promise<string | undefined> {
  const prompt = [
    "Lean rejected the same way, on several attempts, proofs of different statements. Write one short constraint (one sentence, at most 200 characters) that tells a prover what to check before it submits, so that it avoids this failure.",
    `Failure class: ${g.failureClass}`,
    `Typed detail: ${g.detail}`,
    `Attempts: ${g.attempts.length}, on ${g.claims.length} claim(s). Some of the statements:\n${g.statements.map((s) => `- ${s}`).join("\n")}`,
    "Say only what these failures show. Do not state a mathematical fact, and do not name a lemma.",
    'Answer with JSON: {"constraint": "..."}.',
  ].join("\n\n");
  try {
    const answer = await completeJson<{ constraint?: unknown }>(problem.llm, {
      prompt,
      site: "lessons.distill",
      reuse: true,
      schema: { type: "object", properties: { constraint: { type: "string" } }, required: ["constraint"] },
    });
    const screened = screenProse(typeof answer.value.constraint === "string" ? answer.value.constraint : "", { max: 200 });
    if (!screened.ok) {
      problem.log(`lessons: the model's line for a recurring failure was refused (${screened.reason}); a template does`);
      return undefined;
    }
    return screened.text;
  } catch (error) {
    if (isInterrupted(error)) throw error;
    problem.log(`lessons: the model could not put a recurring failure in a line, a template does: ${error instanceof Error ? clip(error.message, 120) : String(error)}`);
    return undefined;
  }
}

/**
 * Failures that recur become constraints (PC3): the same class and normalized detail on at least `minAttempts`
 * attempts. Across at least two claims it is a global lesson (staged in a run with `--human`); on one claim it is a
 * lesson of that claim, until another claim shows it too. One model call puts it in a line when `distill` is on; the
 * template is the fallback, and either way the lesson cites the attempts it rests on.
 */
export async function learnConstraints(problem: ProblemContext, o: LearnOptions): Promise<{ added: number; distilled: number }> {
  let added = 0;
  let used = 0;
  const known = new Set(allLessons(problem.memory).map((l) => l.key));
  for (const g of failureGroups(problem.memory)) {
    if (g.attempts.length < o.minAttempts) continue;
    const cross = g.claims.length >= 2;
    if (cross && o.globalPromotion === "off") continue;
    const scope: LessonScope = cross ? "global" : "claim";
    const scopeKey = cross ? "" : (g.claims[0] as string);
    const key = `constraint|${scope}|${scopeKey}|${g.group}`;
    if (known.has(key)) {
      addLesson(problem.memory, { text: "", type: "constraint", scope, scopeKey, key, origin: "outcome", support: g.attempts, claims: g.claims, domains: [] });
      continue;
    }
    if (problem.signal.aborted) break;
    // The template quotes Lean's own detail: if it does not pass the screen there is nothing safe to say, and no model is asked.
    const template = screenProse(templateText(g), { max: MAX_TEXT });
    if (!template.ok) {
      problem.log(`lessons: a recurring failure (${g.failureClass}) is not made a lesson: its detail is refused (${template.reason})`);
      continue;
    }
    let text: string | undefined;
    if (o.distill && used < o.maxDistill && !problem.budget.exhausted) {
      used += 1;
      text = await distilled(problem, g);
    }
    const r = addLesson(problem.memory, {
      text: text ?? template.text,
      type: "constraint",
      scope,
      scopeKey,
      key,
      origin: text !== undefined ? "distilled" : "outcome",
      group: g.group,
      support: g.attempts,
      claims: g.claims,
      domains: [problem.domain[0] ?? "general"],
      ...(cross && stagesGlobal(o.globalPromotion, problem.human) ? { pending: true } : {}),
    });
    if (!r.created) continue;
    added += 1;
    known.add(key);
    if (cross) {
      // The claim-scope lessons of the same failure are covered by the wider one: they stay in the journal and stop being shown.
      const widened: string[] = [];
      for (const l of allLessons(problem.memory)) {
        if (l.type === "constraint" && l.scope === "claim" && l.group === g.group && l.active) {
          problem.memory.updateNode(l.nodeId, { active: false, deactivated: { rule: "widened", reason: "the same failure recurs on other claims: a global constraint covers it" } }, "widened");
          widened.push(l.nodeId);
        }
      }
      if (widened.length > 0) problem.memory.updateNode(r.nodeId, { widenedFrom: widened }, "widened from claim lessons");
    }
  }
  return { added, distilled: used };
}
