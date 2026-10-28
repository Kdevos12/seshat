import { coldStartPriors, DEFAULT_COLD_START_WEIGHT, fadedWeight, MAX_COLD_START_WEIGHT, withPrior } from "@seshat/decide";
import { type Attempt, attemptDepth, STRATEGIES } from "@seshat/memory";
import { isInterrupted, LINE_TITLES } from "@seshat/lines";
import type { Briefing, JsonObject, Line, SessionContext, SessionDecision } from "@seshat/lines";
import { type AllocationData, allocations } from "./allocation.ts";
import { UNIFORM } from "./beta.ts";
import { thompson } from "./choose.ts";
import {
  dagSection, dagTries, latestStepStates, MAX_DAG_TRIES, proposeStepDag, type RecordedDag, recordStepDag, STEP_DAG_FAILURE_KIND, STEP_STATUS_KIND, stepDagOf, stepStates,
} from "./dag.ts";
import { attemptWeights, DEFAULT_GAMMA } from "./discount.ts";
import { type EscalationOptions, shouldEscalate } from "./escalation.ts";
import { type AttemptWeight, modelPosteriors, posteriorOf, strategyPosteriors } from "./posterior.ts";
import { hash32, type RandomSource, seeded } from "./random.ts";
import { sampleSettings, samplesSettings, type SettingsConfig, settingsConfigOf } from "./settings.ts";
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
  /** The models to choose among, `PROVIDER/ID`, by Thompson sampling on their results. Empty: the run's model only. Their order says nothing about strength: `ranking` does. */
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
  /** The discount of an earlier run's evidence: its attempts count gamma to the power of the runs on the problem since (PE3). */
  gamma: DEFAULT_GAMMA,
  /** The share of sessions whose strategy is drawn uniformly among the allowed labels, ignoring the posteriors (the exploration floor, PE3). */
  epsilon: 0.1,
  /** Models weakest first, `PROVIDER/ID`, for the comparisons of the soft failure memory. Null: the run's model, then `escalateTo` (the order of `models` is not a ranking). */
  ranking: null,
  /** The temperature of a session: a number, a list of numbers to learn over, or `{"min": 0.2, "max": 1}` to draw from. Null: the run's own. */
  temperature: null,
  /** Thinking levels to learn over, such as `["low","high"]`. Null: the run's own. */
  thinking: null,
  /** Diversity directives: `true` for the built-in ones, or an object from label to text. Null: none. */
  directives: null,
  /** Session modes to learn over: `["standard","nl_first"]`. Null: every session is a standard one. */
  modes: null,
  /** The most steps in the DAG of an informal-first session. */
  dagSteps: 8,
  /** Seed the strategy choice with a prior from `decide` (site fleet.cold_start): a Choice over the families, as pseudo-counts of weight `coldStartWeight`. Off: the flat prior. */
  coldStart: false,
  /** The total weight of that prior in pseudo-attempts (0 to 4): the journal's own attempts outweigh it after a few. */
  coldStartWeight: DEFAULT_COLD_START_WEIGHT,
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
  gamma: number;
  epsilon: number;
  ranking: string[] | null;
  settings: SettingsConfig;
  dagSteps: number;
  coldStart: boolean;
  coldStartWeight: number;
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
  const ranking = options.ranking ?? null;
  if (ranking !== null && (!Array.isArray(ranking) || ranking.some((m) => typeof m !== "string" || !m.includes("/")))) {
    throw new Error("the option ranking must be a list of PROVIDER/ID strings, weakest first, or null");
  }
  const gamma = num("gamma");
  if (!(gamma >= 0 && gamma <= 1)) throw new Error("the option gamma must be between 0 and 1");
  const epsilon = num("epsilon");
  if (!(epsilon >= 0 && epsilon <= 1)) throw new Error("the option epsilon must be between 0 and 1");
  const coldStartWeight = num("coldStartWeight");
  if (!(coldStartWeight >= 0 && coldStartWeight <= MAX_COLD_START_WEIGHT)) throw new Error(`the option coldStartWeight must be between 0 and ${MAX_COLD_START_WEIGHT}`);
  return {
    strategies: bool("strategies"),
    stick: bool("stick"),
    models: models as string[],
    seed,
    widen: bool("widen"),
    width: { widenBelow: num("widenBelow"), minAttempts: num("minAttempts"), maxWidth: num("maxWidth"), maxWidthProblem: num("maxWidthProblem") },
    escalation: { escalateTo, after: num("escalateAfter"), below: num("escalateBelow"), max: num("maxEscalations") },
    partial: num("partialCredit"),
    gamma,
    epsilon,
    ranking: ranking as string[] | null,
    settings: settingsConfigOf(options),
    dagSteps: Math.max(1, Math.floor(num("dagSteps"))),
    coldStart: bool("coldStart"),
    coldStartWeight,
  };
}

/**
 * The models of a run, weakest first, as the soft failure memory compares them: the option `ranking`
 * when it is given, else the run's model and then `escalateTo` (the stronger model of an escalation is
 * the strongest by definition). The order of the option `models` says nothing about strength: it is the
 * list to choose among, so it is never read as a ranking.
 */
export function modelOrderOf(runModel: string, options: Readonly<JsonObject>): string[] {
  const config = configOf(options);
  if (config.ranking !== null) return [...new Set(config.ranking)];
  return [...new Set([runModel, ...(config.escalation.escalateTo !== null ? [config.escalation.escalateTo] : [])])];
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
  /** The step DAGs being written, by claim: provers that ask for one at once share the first call. */
  dags: Map<string, Promise<DagResult>>;
}

/** What asking for a claim's step DAG gives: the recorded DAG, or why a session runs without one. */
interface DagResult {
  recorded?: RecordedDag;
  note?: string;
  /** True when the consortium turn ended before the DAG could be asked for: nothing is recorded, and the session does not start. */
  interrupted?: boolean;
}

const RUNS = new WeakMap<object, RunState>();

function runState(registry: object): RunState {
  let state = RUNS.get(registry);
  if (state === undefined) {
    state = { claims: new Set(), problems: new Map(), assigned: new Map(), dags: new Map() };
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

/**
 * The step DAG an informal-first session works from: the claim's recorded one, else one written now
 * (one model call, one more if its shape does not check). A claim whose DAGs failed `MAX_DAG_TRIES`
 * times gets none, so that informal-first sessions run as standard ones rather than pay again.
 * Provers that ask at once share the first call.
 */
async function stepDagFor(session: SessionContext, run: RunState, config: FleetConfig, model: string | undefined): Promise<DagResult> {
  const existing = stepDagOf(session.memory, session.claimId);
  if (existing !== undefined) return { recorded: existing };
  if (dagTries(session.memory, session.claimId) >= MAX_DAG_TRIES) return { note: `no step DAG that checks after ${MAX_DAG_TRIES} tries on this claim` };
  const pending = run.dags.get(session.claimId);
  if (pending !== undefined) return pending;
  const made = (async (): Promise<DagResult> => {
    try {
      const proposal = await proposeStepDag(session.llm, { theorem: session.target.theorem, statement: session.target.statement }, config.dagSteps, model !== undefined ? { model } : {});
      if (proposal.ok) return { recorded: await recordStepDag(session.memory, session.claimId, proposal.dag, session.attemptId) };
      session.memory.recordNode({ kind: STEP_DAG_FAILURE_KIND, claimId: session.claimId, data: { attemptId: session.attemptId, problems: proposal.problems } });
      return { note: `the step DAG did not check: ${proposal.problems.slice(0, 3).join("; ")}` };
    } catch (error) {
      // The turn ended: not a failure of the try. Nothing is recorded, and the next turn asks again (documentation/lines.md, "Interrupted work").
      if (isInterrupted(error)) return { interrupted: true };
      // The problem ended or its budget is spent: the prover stops on its own signal. Any other failure of the call is a failed try.
      if (session.signal.aborted || session.budget.exhausted) return { note: "the problem ended before the step DAG was written" };
      const message = error instanceof Error ? error.message : String(error);
      session.memory.recordNode({ kind: STEP_DAG_FAILURE_KIND, claimId: session.claimId, data: { attemptId: session.attemptId, problems: [message.slice(0, 300)] } });
      return { note: `the step DAG could not be written: ${message.slice(0, 200)}` };
    }
  })().finally(() => run.dags.delete(session.claimId));
  run.dags.set(session.claimId, made);
  return made;
}

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
    version: "fleet-2",
    // The width gate and the strategy each prover sticks to live in the process, and the journal gives them back: see `resumeProblem`.
    resume: "rebuild",
    hooks: {
      /**
       * What the process that ended held, from the journal. The claims the run's sessions worked on
       * are the claims with attempts. The strategy a prover that goes on sticks to is the one the
       * allocation of its last session that was not cut chose (a cut session is as if it had not
       * been). The provers that had ended are no longer ahead of anyone at the gate. What each
       * prover works on now, and the strategy told to a session until its briefing is made, are
       * empty, as they are whenever no session is running; the draws are seeded, so they repeat.
       */
      resumeProblem: async (problem, held) => {
        const run = runState(problem.registry);
        for (const claimId of held.workedClaims) run.claims.add(claimId);
        const state = problemState(run, problem.problemId);
        const ended = new Set(held.endedProvers);
        for (const prover of ended) state.gate.ended(prover);
        const counted = new Set(held.attempts.filter((attempt) => !attempt.interrupted).map((attempt) => attempt.attemptId));
        for (const { data } of allocations(problem.memory, problem.claimId)) {
          if (data.strategy !== undefined && !ended.has(data.prover) && counted.has(data.attemptId)) state.last.set(data.prover, data.strategy);
        }
      },

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
        // Every posterior counts an attempt with its weight: the discount of an earlier run, and the probation of an older epoch.
        const weigh = (attempts: readonly Attempt[]): AttemptWeight =>
          attemptWeights(attempts, { gamma: config.gamma, epochWeight: (epoch) => session.memory.weightOf(epoch) });

        let admission = { admitted: true, waited: false, width: 1 };
        if (config.widen) {
          admission = await problem.gate.admit(session.prover, subgoal, {
            width: () => {
              const now = attemptsNow();
              return widthFor(posteriorOf(now, config.partial, weigh(now)), config.width);
            },
            cap: config.width.maxWidthProblem,
            signal: session.signal,
          });
          // The problem ended while the prover waited: the prover stops on its own signal.
          if (!admission.admitted) return undefined;
        }

        const attempts = attemptsNow();
        const weights = weigh(attempts);
        const single = posteriorOf(attempts, config.partial, weights);
        const key = `${config.seed ?? session.runId}:${session.problemId}:${session.prover}:${session.session}`;
        const random = randomFor(key);

        let strategy: string | undefined;
        let rule: AllocationData["rule"];
        let draws: AllocationData["draws"];
        let exploration = false;
        // Whether the exploration floor was in force for the session: the attempt records false then, and nothing when it was off.
        let floored = false;
        if (config.strategies) {
          // One Ralph loop at a time per (subgoal, strategy): not one that another prover is on.
          const taken = new Set<string>();
          for (const [prover, work] of problem.running) {
            if (prover !== session.prover && work.subgoal === subgoal && work.strategy !== undefined) taken.add(work.strategy);
          }
          const allowed = LABELS.filter((label) => !taken.has(label));
          // The exploration floor: a share epsilon of the sessions picks uniformly among the allowed labels, whatever the
          // posteriors say. Its own stream of the session's key, so that the draws below are the ones a run without it makes.
          const floor = config.epsilon > 0 && allowed.length > 0 ? randomFor(`${key}:exploration`) : undefined;
          floored = floor !== undefined;
          const previous = problem.last.get(session.prover);
          if (floor !== undefined && floor() < config.epsilon) {
            strategy = allowed[Math.min(Math.floor(floor() * allowed.length), allowed.length - 1)];
            rule = "exploration";
            exploration = true;
          } else if (config.stick && previous !== undefined && !taken.has(previous) && progressed(attempts, session.prover)) {
            strategy = previous;
            rule = "continued";
          } else {
            const posteriors = strategyPosteriors(attempts, config.partial, weights);
            // The decision's prior (an option, off by default) is added to what the journal says; a pause passes through, any other failure leaves the flat prior.
            // It fades with the problem's attempts and is gone after a few (COLD_START_FADE_ATTEMPTS): no decision is asked then.
            const priorWeight = fadedWeight(config.coldStartWeight, attempts.length);
            const priors =
              config.coldStart && session.decide !== undefined && priorWeight > 0
                ? await coldStartPriors(session.decide, { statement: session.target.statement, families: allowed, weight: priorWeight, log: session.log })
                : undefined;
            const picked = thompson(random, allowed.map((label) => [label, withPrior(posteriors.get(label)?.choice, priors?.[label]) ?? UNIFORM] as const));
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
          const posteriors = modelPosteriors(everything, config.partial, weigh(everything));
          model = thompson(random, config.models.map((name) => [name, posteriors.get(name)?.choice ?? UNIFORM] as const))?.choice;
        }
        // A routing decision `retry_stronger` about the prover's last session: this one goes to the strongest model configured.
        let routed: AllocationData["routed"];
        const strongest = session.ranking?.order.at(-1);
        if (strongest !== undefined && session.tasks !== undefined) {
          const task = session.tasks.list({ owner: `prover:${session.prover}`, kinds: ["prove"] }).at(0);
          const decision = task === undefined ? undefined : session.tasks.routings(task.taskId).at(-1);
          const mine = session.memory.attempts(session.claimId).filter((a) => a.prover === session.prover).at(-1);
          if (decision?.action === "retry_stronger" && decision.attemptId !== undefined && decision.attemptId === mine?.attemptId && (model ?? session.model) !== strongest) {
            model = strongest;
            routed = "retry_stronger";
          }
        }
        let escalated = false;
        if (config.escalation.escalateTo !== null) {
          const used = allocations(session.memory, session.claimId).filter((a) => a.data.escalated === true).length;
          if (shouldEscalate(single, used, config.escalation)) {
            model = config.escalation.escalateTo;
            escalated = true;
            routed = undefined;
          }
        }

        // The prover takes its place now, before anything is awaited: a prover that decides while this one waits for its
        // DAG must see the strategy as taken (one Ralph loop at a time per (subgoal, strategy)).
        const previousStrategy = problem.last.get(session.prover);
        problem.running.set(session.prover, { subgoal, ...(strategy !== undefined ? { strategy } : {}) });
        if (strategy !== undefined) {
          problem.last.set(session.prover, strategy);
          run.assigned.set(session.attemptId, strategy);
        }

        // The settings sampled for the session (temperature, thinking level, directive, mode), from their own stream.
        let settings: JsonObject | undefined;
        let settingDraws: AllocationData["settingDraws"];
        let dag: string | undefined;
        let dagNote: string | undefined;
        if (samplesSettings(config.settings)) {
          const sampled = sampleSettings(randomFor(`${key}:settings`), config.settings, attempts, config.partial, weights);
          settings = sampled.settings;
          if (Object.keys(sampled.draws).length > 0) settingDraws = sampled.draws;
          if (settings.mode === "nl_first") {
            const made = await stepDagFor(session, run, config, model);
            if (made.interrupted === true) {
              // The turn is over: the session will not start, so the prover gives its place back and nothing is decided or recorded.
              problem.running.delete(session.prover);
              if (previousStrategy === undefined) problem.last.delete(session.prover);
              else problem.last.set(session.prover, previousStrategy);
              run.assigned.delete(session.attemptId);
              problem.gate.wake();
              return undefined;
            }
            if (made.recorded !== undefined) dag = made.recorded.nodeId;
            else {
              // No DAG that checks: the session runs as a standard one, and the record says so: `mode` is the mode that ran
              // (the arm its outcome is counted for), `drawnMode` the one that was drawn.
              settings = { ...settings, mode: "standard", drawnMode: "nl_first" };
              dagNote = made.note;
            }
          }
        }

        // This session starts after the prover's last attempt was journaled, so the provers that wait read a
        // posterior that holds it. They look again now that this prover has taken its place and its strategy.
        problem.gate.wake();
        if (strategy === undefined && model === undefined && settings === undefined) return undefined;
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
            ...(routed !== undefined ? { routed } : {}),
            width: admission.width,
            waited: admission.waited,
            successRate: round(single.success.alpha / (single.success.alpha + single.success.beta)),
            attempts: single.attempts,
            ...(draws !== undefined ? { draws } : {}),
            ...(settings !== undefined ? { settings } : {}),
            ...(settingDraws !== undefined ? { settingDraws } : {}),
            ...(dag !== undefined ? { dag } : {}),
            ...(dagNote !== undefined ? { dagNote } : {}),
          } satisfies AllocationData,
        });
        return {
          ...(strategy !== undefined ? { strategy } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(settings !== undefined && Object.keys(settings).length > 0 ? { settings } : {}),
          ...(floored ? { exploration } : {}),
        };
      },

      briefing: async (session): Promise<Briefing | undefined> => {
        const strategy = runState(session.registry).assigned.get(session.attemptId);
        return strategy === undefined ? undefined : strategySection(strategy);
      },

      briefingSections: async (session): Promise<Briefing[] | undefined> => {
        const sections: Briefing[] = [];
        const config = configOf(session.options);
        const directive = session.settings?.directive;
        const text = typeof directive === "string" ? config.settings.directives?.[directive] : undefined;
        if (text !== undefined) {
          sections.push({ title: "Directive for this session", text: `The harness drew this directive for the session, to vary how sessions work on one statement: ${text}` });
        }
        if (session.settings?.mode === "nl_first") {
          const recorded = stepDagOf(session.memory, session.claimId);
          if (recorded !== undefined) sections.push(dagSection(recorded, latestStepStates(session.memory, session.claimId, recorded.nodeId)));
        }
        return sections.length === 0 ? undefined : sections;
      },

      afterAttempt: async (problem, attempt) => {
        const run = runState(problem.registry);
        const state = problemState(run, problem.problemId);
        state.running.delete(attempt.prover);
        run.assigned.delete(attempt.attemptId);
        // An informal-first session: what Lean said of each step in its last check goes back to that step, and to no other.
        if (attempt.report !== undefined) {
          const allocation = allocations(problem.memory, problem.claimId).find((a) => a.data.attemptId === attempt.attemptId);
          const recorded = allocation?.data.dag === undefined ? undefined : stepDagOf(problem.memory, problem.claimId);
          if (recorded !== undefined && recorded.nodeId === allocation?.data.dag) {
            problem.memory.recordNode({
              kind: STEP_STATUS_KIND,
              claimId: problem.claimId,
              data: { attemptId: attempt.attemptId, dagNodeId: recorded.nodeId, states: stepStates(recorded.dag, attempt.report) },
            });
          }
        }
        // The waiting provers are not woken here: `afterAttempt` runs before the attempt is journaled as finished,
        // so they would read a posterior without it. The prover's next session, or its end, wakes them.
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
