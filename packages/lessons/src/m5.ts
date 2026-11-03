import type { Json } from "@seshat/core";
import { type Briefing, LINE_TITLES, type Line, type SessionContext } from "@seshat/lines";
import { type GlobalPromotion, labelOf, learnConstraints, learnStrategy, type LearnOptions } from "./learn.ts";
import { allLessons } from "./records.ts";
import { countOutcome, deactivateWorn, type DeactivationMode, selectLessons, type SelectOptions } from "./select.ts";

/** The options of M5 and their defaults (`--line-option M5.maxLessons=2`). */
export const M5_OPTIONS = {
  /** The most lessons a session is shown. */
  maxLessons: 3,
  /** `effect` (Task 23's randomized inclusion and its posteriors) or `presence` (harmful outweighs useful). */
  deactivation: "effect",
  /** The observations on each side (effect), or in all (presence), before a lesson can leave. */
  minObservations: 8,
  /** Deactivate by effect when P(effect < 0) is above this. */
  threshold: 0.9,
  /** Learn strategy lessons from accepted proofs. */
  fromSuccess: true,
  /** Learn constraints from failures that recur (PC3). */
  fromFailures: true,
  /** A failure is a constraint when this many attempts show it. */
  minAttempts: 3,
  /** Put a constraint in a line with one model call (the site `lessons.distill`); a template is the fallback. */
  distill: true,
  maxDistill: 2,
  /** `staged` (alias `human`): a promotion to the global scope waits for the team's approval. `direct`: applied at once, except in a consortium run. `off`: no global lesson. */
  globalPromotion: "staged",
  globalMinDomains: 2,
  globalMinClaims: 3,
  /** The lessons replace the prose notes the model writes for the next session (documentation/m0-loop.md, "Notes"). */
  replaceNotes: true,
};

type Options = typeof M5_OPTIONS;

function optionsOf(raw: Readonly<Record<string, Json>>): Options {
  return { ...M5_OPTIONS, ...(raw as Partial<Options>) };
}

function learnOf(o: Options): LearnOptions {
  return {
    globalPromotion: (["human", "staged", "direct", "off"].includes(o.globalPromotion) ? o.globalPromotion : "staged") as GlobalPromotion,
    globalMinDomains: o.globalMinDomains,
    globalMinClaims: o.globalMinClaims,
    minAttempts: o.minAttempts,
    distill: o.distill,
    maxDistill: o.maxDistill,
  };
}

function selectOf(o: Options): SelectOptions {
  return { deactivation: (o.deactivation === "presence" ? "presence" : "effect") as DeactivationMode, minObservations: o.minObservations, threshold: o.threshold, maxLessons: o.maxLessons };
}

/** The scope tag a lesson is shown with. */
function tag(scope: string, key: string): string {
  return scope === "global" ? "all problems" : scope === "domain" ? key : "this problem";
}

/**
 * M5: lessons with counters (documentation/lessons.md). Lessons are added from the run's own outcomes, merged when
 * they repeat, never rewritten, and deactivated by their causal effect. They reach a session as one briefing section,
 * and only the ones its draw included (Task 23): unverified advice, never a fact and never the goal.
 */
export const M5: Line = {
  id: "M5",
  title: LINE_TITLES.M5,
  // M1 classifies each failure and each strategy, which is what the constraints and the counters are made of.
  requires: ["M1"],
  options: M5_OPTIONS,
  version: "m5-1",
  // Everything M5 knows it reads from the memory: lessons, decisions and counters are nodes.
  resume: "stateless",
  hooks: {
    beforeSession: async (session: SessionContext) => {
      const o = optionsOf(session.options);
      deactivateWorn(session, selectOf(o));
      const chosen = selectLessons(session, o);
      if (chosen.length > 0) session.draw(chosen.map((l) => l.nodeId));
      return undefined;
    },
    briefing: async (session): Promise<Briefing | undefined> => {
      const shown = new Set(session.drawn.included);
      const lessons = allLessons(session.memory).filter((l) => shown.has(l.nodeId) && l.state === "active");
      if (lessons.length === 0) return undefined;
      return {
        title: "Lessons",
        text:
          "Advice from the outcomes of earlier attempts in this harness. It is not proved and may be wrong for this problem: Lean's verdicts and the goal decide.\n" +
          lessons.map((l) => `- (${tag(l.scope, l.scopeKey)}) ${l.text}`).join("\n"),
      };
    },
    afterAttempt: async (problem, attempt) => {
      const o = optionsOf(problem.options);
      const label = labelOf(attempt);
      countOutcome(problem, attempt, label);
      if (o.fromSuccess) learnStrategy(problem, attempt, label, learnOf(o));
      // The lessons take the notes' place: the model's prose is kept in the journal and not passed on.
      return o.replaceNotes ? { notes: "" } : undefined;
    },
    afterProblem: async (problem) => {
      const o = optionsOf(problem.options);
      if (!o.fromFailures) return;
      const r = await learnConstraints(problem, learnOf(o));
      if (r.added > 0) problem.log(`lessons: ${r.added} constraint(s) added from recurring failures${r.distilled > 0 ? ` (${r.distilled} put in a line by a model)` : ""}`);
    },
  },
};
