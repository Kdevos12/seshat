import { type Attempt, attemptDepth, STRATEGIES } from "@seshat/memory";
import { LINE_TITLES } from "@seshat/lines";
import type { Briefing, JsonObject, Line, SessionContext, SessionDecision } from "@seshat/lines";
import { type AllocationData, allocations } from "./allocation.ts";
import { UNIFORM } from "./beta.ts";
import { thompson } from "./choose.ts";
import { type EscalationOptions, shouldEscalate } from "./escalation.ts";
import { modelPosteriors, posteriorOf, strategyPosteriors } from "./posterior.ts";
import { hash32, type RandomSource, seeded } from "./random.ts";
import { Gate, widthFor, type WidthOptions } from "./width.ts";

/**
 * The options of the fleet policy, with their defaults (`--line-option fleet.maxWidth=2`). A list
 * is written as JSON: `--line-option 'fleet.models=["PROVIDER/ID","PROVIDER/ID"]'`.
 */
export const FLEET_OPTIONS = {
  /** Tell each session which strategy to work on, drawn by Thompson sampling. */
  strategies: true,
  /** A prover keeps its strategy from one session to the next while Lean gets further with it. */
  stick: true,
  /** The models to choose among, `PROVIDER/ID`, by Thompson sampling on their results. Empty: the run's model only. */
  models: [] as string[],
  /** The stronger model for hard decisions, `PROVIDER/ID`. Null: no escalation. */
  escalateTo: null,
  /** Seeds the draws. Null: the run's id, so that each run draws differently. A number repeats the draws. */
  seed: null,
  /** Keep the number of provers working at once on a subgoal to its width. Off: all provers run at once. */
  widen: true,
  /** A single-agent success rate under which a subgoal is widened. */
  widenBelow: 0.3,
  /** Attempts that must have counted before the rate is evidence. */
  minAttempts: 2,
  /** The most provers on one subgoal. */
  maxWidth: 4,
  /** The most provers in all on one problem. */
  maxWidthProblem: 8,
  /** A decision is hard after this many attempts on the claim... */
  escalateAfter: 3,
  /** ...with a success rate under this. */
  escalateBelow: 0.25,
  /** The most escalated sessions on one claim. */
  maxEscalations: 2,
  /** What the deepest failure is worth to a choice, against 1 for a proof. */
  partialCredit: 0.5,
} satisfies JsonObject;

/** What the fleet reads of its options, checked. */
interface FleetConfig {
  strategies: boolean;
  stick: boolean;
  models: string[];
  seed: number | string | null;
  widen: boolean;
  width: WidthOptions;
  escalation: EscalationOptions;
  partial: number;
}

function configOf(options: Readonly<JsonObject>): FleetConfig {
  const bool = (key: keyof typeof FLEET_OPTIONS): boolean => {
    const value = options[key];
    return typeof value === "boolean" ? value : (FLEET_OPTIONS[key] as boolean);
  };
  const num = (key: keyof typeof FLEET_OPTIONS): number => {
    const value = options[key];
    return typeof value === "number" && Number.isFinite(value) ? value : (FLEET_OPTIONS[key] as number);
  };
  const models = options.models ?? [];
  if (!Array.isArray(models) || models.some((m) => typeof m !== "string" || !m.includes("/"))) {
    throw new Error("the option models must be a list of PROVIDER/ID strings");
  }
  const escalateTo = options.escalateTo ?? null;
  if (escalateTo !== null && (typeof escalateTo !== "string" || !escalateTo.includes("/"))) throw new Error("the option escalateTo must be a PROVIDER/ID string or null");
  const seed = options.seed ?? null;
  if (seed !== null && typeof seed !== "number" && typeof seed !== "string") throw new Error("the option seed must be a number, a string or null");
  return {
    strategies: bool("strategies"),
    stick: bool("stick"),
    models: models as string[],
    seed,
    widen: bool("widen"),
    width: { widenBelow: num("widenBelow"), minAttempts: num("minAttempts"), maxWidth: num("maxWidth"), maxWidthProblem: num("maxWidthProblem") },
    escalation: { escalateTo, after: num("escalateAfter"), below: num("escalateBelow"), max: num("maxEscalations") },
    partial: num("partialCredit"),
  };
}

/** What each strategy asks of a session, in a few words (the labels are M1's). */
export const STRATEGY_HINTS: Readonly<Record<string, string>> = {
  induction: "induction on a variable, or recursion on its structure",
  cases: "case analysis on the form of a variable or of a hypothesis",
  contradiction: "assume the opposite and derive False",
  computation: "compute or decide instances, and read the pattern from them",
  automation: "close goals with simp, omega, linarith, aesop and the like",
  construction: "build the witness or the object explicitly",
  counterexample: "look for a counterexample first, with small cases and computation",
  generalization: "work on a more general statement, then specialize it",
  rewriting: "rewrite with known lemmas until the goal closes",
  algebra: "algebraic manipulation: ring, field_simp, linear_combination",
  bounds: "inequalities and estimates",
  extremal: "an extremal argument: a minimal or maximal element, pigeonhole",
};

/**
 * The section of a session's briefing that tells it which strategy to work on. Its wording asks for
 * no demonstration of the statement: M6's framing check finds nothing in it, on any label.
 */
export function strategySection(strategy: string): Briefing {
  const hint = STRATEGY_HINTS[strategy];
  return {
    title: "Strategy for this session",
    text:
      `The harness chose a strategy for this session from what has been tried on this statement: ${strategy}${hint !== undefined ? ` (${hint})` : ""}. ` +
      "Work it out with care. If it does not lead anywhere, say why in your notes, so that the next session does not start from the same place. " +
      "Declare it as the strategy of your lean_check calls when it fits what you submit.",
  };
}

/** The labels a session can be told to work on: `other` says nothing. */
const LABELS: readonly string[] = STRATEGIES.filter((label) => label !== "other");

interface ProblemState {
  gate: Gate;
  /** What each prover works on now: set when its session is admitted, cleared when it ends. */
  running: Map<string, { subgoal: string; strategy?: string }>;
  /** The strategy of each prover's last session, kept while the prover is alive. */
  last: Map<string, string>;
}

interface RunState {
  /** The claims the run's sessions worked on: the model posteriors are made of their attempts. */
  claims: Set<string>;
  problems: Map<string, ProblemState>;
  /** The strategy told to each session, until its briefing is made. */
  assigned: Map<string, string>;
}

const RUNS = new WeakMap<object, RunState>();

function runState(registry: object): RunState {
  let state = RUNS.get(registry);
  if (state === undefined) {
    state = { claims: new Set(), problems: new Map(), assigned: new Map() };
    RUNS.set(registry, state);
  }
  return state;
}

function problemState(run: RunState, problemId: string): ProblemState {
  let state = run.problems.get(problemId);
  if (state === undefined) {
    state = { gate: new Gate(), running: new Map(), last: new Map() };
    run.problems.set(problemId, state);
  }
  return state;
}

/** Whether a prover's last finished session went further than the ones before it. */
function progressed(attempts: readonly Attempt[], prover: string): boolean {
  const depths = attempts.filter((a) => a.prover === prover).flatMap((a) => attemptDepth(a) ?? []);
  const last = depths.pop();
  return last !== undefined && last > Math.max(0, ...depths);
}

const round = (x: number): number => Math.round(x * 10000) / 10000;

/** What the fleet is given that a test, or a later task, may replace. */
export interface FleetEnv {
  /** The random source of a decision, from a key made of the seed, the problem, the prover and the session. */
  random?: (key: string) => RandomSource;
}

/**
 * The fleet policy (plan §11, documentation/fleet.md): posteriors from the journal, Thompson
 * sampling for what the next session works on and with which model, the width of each subgoal, and
 * the escalation of hard decisions. Provers never talk to each other; what one learns reaches the
 * others through the memory, as the typed summaries of M1.
 */
export function createFleet(env: FleetEnv = {}): Line {
  const randomFor = env.random ?? ((key: string) => seeded(hash32(key)));

  return {
    id: "fleet",
    title: LINE_TITLES.fleet,
    // The classified strategy labels of M1 are what the posteriors are made of.
    requires: ["M1"],
    options: FLEET_OPTIONS,
    // Recorded in run.started: change it with a rule of the policy, a default or the wording of the assignment.
    version: "fleet-1",
    hooks: {
      beforeSession: async (session: SessionContext): Promise<SessionDecision | undefined> => {
        const config = configOf(session.options);
        const run = runState(session.registry);
        const problem = problemState(run, session.problemId);
        run.claims.add(session.claimId);
        const subgoal = session.subgoal ?? session.claimId;
        const attemptsNow = (): Attempt[] => {
          const all = session.memory.attempts(session.claimId, { includeEquivalents: true });
          return session.subgoal === undefined ? all : all.filter((a) => a.subgoal === session.subgoal);
        };

        let admission = { admitted: true, waited: false, width: 1 };
        if (config.widen) {
          admission = await problem.gate.admit(session.prover, subgoal, {
            width: () => widthFor(posteriorOf(attemptsNow(), config.partial), config.width),
            cap: config.width.maxWidthProblem,
            signal: session.signal,
          });
          // The problem ended while the prover waited: the prover stops on its own signal.
          if (!admission.admitted) return undefined;
        }

        const attempts = attemptsNow();
        const single = posteriorOf(attempts, config.partial);
        const random = randomFor(`${config.seed ?? session.runId}:${session.problemId}:${session.prover}:${session.session}`);

        let strategy: string | undefined;
        let rule: AllocationData["rule"];
        let draws: AllocationData["draws"];
        if (config.strategies) {
          // One Ralph loop at a time per (subgoal, strategy): not one that another prover is on.
          const taken = new Set<string>();
          for (const [prover, work] of problem.running) {
            if (prover !== session.prover && work.subgoal === subgoal && work.strategy !== undefined) taken.add(work.strategy);
          }
          const previous = problem.last.get(session.prover);
          if (config.stick && previous !== undefined && !taken.has(previous) && progressed(attempts, session.prover)) {
            strategy = previous;
            rule = "continued";
          } else {
            const posteriors = strategyPosteriors(attempts, config.partial);
            const picked = thompson(
              random,
              LABELS.filter((label) => !taken.has(label)).map((label) => [label, posteriors.get(label)?.choice ?? UNIFORM] as const),
            );
            if (picked !== undefined) {
              strategy = picked.choice;
              rule = "thompson";
              draws = Object.fromEntries(picked.draws.map(([label, draw]) => [label, round(draw)]));
            }
          }
        }

        let model: string | undefined;
        if (config.models.length > 0) {
          const everything = [...run.claims].flatMap((claimId) => session.memory.attempts(claimId, { includeEquivalents: true }));
          const posteriors = modelPosteriors(everything, config.partial);
          model = thompson(random, config.models.map((name) => [name, posteriors.get(name)?.choice ?? UNIFORM] as const))?.choice;
        }
        let escalated = false;
        if (config.escalation.escalateTo !== null) {
          const used = allocations(session.memory, session.claimId).filter((a) => a.data.escalated === true).length;
          if (shouldEscalate(single, used, config.escalation)) {
            model = config.escalation.escalateTo;
            escalated = true;
          }
        }

        problem.running.set(session.prover, { subgoal, ...(strategy !== undefined ? { strategy } : {}) });
        if (strategy !== undefined) {
          problem.last.set(session.prover, strategy);
          run.assigned.set(session.attemptId, strategy);
        }
        if (strategy === undefined && model === undefined) return undefined;
        session.memory.recordNode({
          kind: "allocation",
          claimId: session.claimId,
          data: {
            attemptId: session.attemptId,
            prover: session.prover,
            session: session.session,
            ...(strategy !== undefined ? { strategy } : {}),
            ...(rule !== undefined ? { rule } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(escalated ? { escalated } : {}),
            width: admission.width,
            waited: admission.waited,
            successRate: round(single.success.alpha / (single.success.alpha + single.success.beta)),
            attempts: single.attempts,
            ...(draws !== undefined ? { draws } : {}),
          } satisfies AllocationData,
        });
        return { ...(strategy !== undefined ? { strategy } : {}), ...(model !== undefined ? { model } : {}) };
      },

      briefing: async (session): Promise<Briefing | undefined> => {
        const strategy = runState(session.registry).assigned.get(session.attemptId);
        return strategy === undefined ? undefined : strategySection(strategy);
      },

      afterAttempt: async (problem, attempt) => {
        const run = runState(problem.registry);
        const state = problemState(run, problem.problemId);
        state.running.delete(attempt.prover);
        run.assigned.delete(attempt.attemptId);
        // The posterior moved: provers waiting for a place look again.
        state.gate.wake();
        return undefined;
      },

      afterProver: async (problem, end) => {
        const state = problemState(runState(problem.registry), problem.problemId);
        state.running.delete(end.prover);
        state.last.delete(end.prover);
        state.gate.ended(end.prover);
      },

      afterProblem: async (problem) => {
        runState(problem.registry).problems.delete(problem.problemId);
      },
    },
  };
}

/** The fleet policy with the default random source. */
export const fleet: Line = createFleet();
