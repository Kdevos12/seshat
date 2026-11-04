import { headerProblems, UnsafeText } from "./screen.ts";
import { type RandomSource } from "@seshat/core";
import { decideOrderer } from "@seshat/decide";
import { type Briefing, type JsonObject, LINE_TITLES, type Line, type ProblemContext } from "@seshat/lines";
import { LeanGoals, LeanMetaError } from "@seshat/lean-meta";
import { type Claim, type MemoryStore, screenProse } from "@seshat/memory";
import { RegistryLeanChecker, type Registry } from "@seshat/registry";
import { type AtpTool, parseAtpTools, type FirstOrderSettings, FIRST_ORDER_RUN, type FirstOrderRunData, registrySolvers, type Solvers, solveFirstOrder } from "./firstorder.ts";
import { type HostProbe, probeHost } from "./probe.ts";
import { BATTERY_RUN, type BatteryRunData, Posteriors } from "./posterior.ts";
import { type Premise, type PremiseSelector, parseCutoffs } from "./premises.ts";
import { type GoalClient, posteriorOrderer, searchGoal } from "./search.ts";
import { type ClaimGoal, DEFAULT_SETTINGS, randomFor, solveGoal, type SolveContext, type SolveSettings, tacticsFor } from "./solve.ts";
import type { LeanChecker } from "@seshat/core";
import { availableTactics, type HostTactics } from "./tactics.ts";

const ACTOR = "line:M10";

/** The options of line M10 and their defaults. A run changes them with `--line-option M10.<name>=<value>`. */
export const M10_DEFAULTS = {
  /** Lean checks at once. */
  parallel: 4,
  /** Lean time for the battery on one goal, in seconds, summed over the parallel tries. */
  cpuBudgetSec: 60,
  /** How many proofs `validate` may refuse before the battery gives a goal up. */
  maxSubmissions: 3,
  /** `thompson` (draws from the posteriors) or `mean`. */
  order: "thompson",
  /** The hammer's premise cutoffs (plan change PC6 item 2), comma separated; empty: only the plain hammer. */
  hammerCutoffs: "16,64,256",
  /** Optional tactics the host profile promises (`hammer`, `canonical`, `polyrith`, `bv_decide`), comma separated; they are not probed. */
  packages: "",
  /** Ask the host's Lean which optional tactics it has. */
  probe: true,
  /** Run the battery on the open subgoals of the problem's claim too (claims joined to it by `decomposes_into`). */
  subgoals: true,
  maxSubgoals: 8,
  /** Run ATP and SMT with reconstruction when the battery fails. */
  firstOrder: true,
  atpTimeoutSec: 20,
  /** The ATPs, in order: `vampire`, `eprover` or both (the default; one the host does not offer is skipped). */
  atpTools: "vampire,eprover",
  /** `parallel`: the ATPs run together and their answers are reconstructed together; `order`: one after the other, the first whose answer Lean accepts wins. */
  atpMode: "parallel",
  /** The premise cutoffs of the first-order tools, comma separated. */
  premiseCutoffs: "16,64,256",
  reconstructBudgetSec: 60,
  /** Run the goal-level search (`prove.search`'s engine) on the target when everything above failed. Off: it is measured against whole-proof sessions first. */
  search: false,
  searchNodes: 60,
  /** Who orders the search's candidates that come without a model call: `posterior` or `decide` (plan change J3 item 3). */
  orderer: "posterior",
} satisfies JsonObject;

export interface M10Options {
  parallel: number;
  cpuBudgetSec: number;
  maxSubmissions: number;
  order: "thompson" | "mean";
  hammerCutoffs: number[];
  packages: string[];
  probe: boolean;
  subgoals: boolean;
  maxSubgoals: number;
  firstOrder: boolean;
  atpTimeoutSec: number;
  atpTools: AtpTool[];
  atpMode: "parallel" | "order";
  premiseCutoffs: number[];
  reconstructBudgetSec: number;
  search: boolean;
  searchNodes: number;
  orderer: "posterior" | "decide";
}

const PACKAGES = ["hammer", "canonical", "polyrith", "bv_decide"];

/** The line's options as the run gave them, checked: a hook that reads a bad value fails with the name of the option. */
export function readOptions(raw: Readonly<JsonObject>): M10Options {
  const integer = (key: string, min: number, max: number): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`option M10.${key} is an integer from ${min} to ${max}, not ${JSON.stringify(value)}`);
    }
    return value;
  };
  const flag = (key: string): boolean => {
    const value = raw[key];
    if (typeof value !== "boolean") throw new TypeError(`option M10.${key} is true or false, not ${JSON.stringify(value)}`);
    return value;
  };
  const choice = <T extends string>(key: string, allowed: readonly T[]): T => {
    const value = raw[key];
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new RangeError(`option M10.${key} is one of ${allowed.join(", ")}, not ${JSON.stringify(value)}`);
    return value as T;
  };
  const list = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") throw new TypeError(`option M10.${key} is a text, not ${JSON.stringify(value)}`);
    return value;
  };
  const packages = list("packages").split(",").map((p) => p.trim()).filter((p) => p !== "");
  for (const p of packages) if (!PACKAGES.includes(p)) throw new RangeError(`option M10.packages names ${JSON.stringify(p)}; the optional tactics are ${PACKAGES.join(", ")}`);
  return {
    parallel: integer("parallel", 1, 16),
    cpuBudgetSec: integer("cpuBudgetSec", 1, 3600),
    maxSubmissions: integer("maxSubmissions", 0, 10),
    order: choice("order", ["thompson", "mean"]),
    hammerCutoffs: list("hammerCutoffs").trim() === "" ? [] : parseCutoffs(list("hammerCutoffs")),
    packages,
    probe: flag("probe"),
    subgoals: flag("subgoals"),
    maxSubgoals: integer("maxSubgoals", 0, 100),
    firstOrder: flag("firstOrder"),
    atpTimeoutSec: integer("atpTimeoutSec", 1, 300),
    atpTools: parseAtpTools(list("atpTools")),
    atpMode: choice("atpMode", ["parallel", "order"]),
    premiseCutoffs: parseCutoffs(list("premiseCutoffs")),
    reconstructBudgetSec: integer("reconstructBudgetSec", 1, 3600),
    search: flag("search"),
    searchNodes: integer("searchNodes", 1, 500),
    orderer: choice("orderer", ["posterior", "decide"]),
  };
}

export interface M10Services {
  /** The Lean checker for a problem. Default: the registry's `lean.check`, so that every try is a tool run of the line. */
  checker?: (problem: ProblemContext) => LeanChecker;
  /** ATP and SMT. Default: the registry's `smt.z3`, `atp.vampire` and `atp.eprover`, whichever the host offers. */
  solvers?: (problem: ProblemContext) => Solvers;
  /** The declarations premises are taken from (Task 9's library, the `lean.meta` export of Task 21). Default: none. */
  premises?: (problem: ProblemContext) => readonly Premise[];
  /** Task 11's MePo or SInE. Default: symbol overlap mixed with BM25. */
  selector?: PremiseSelector;
}

/** The probe of each registry, by header: an answer is kept, an unreachable Lean is asked again at the next goal. */
const hostCache = new WeakMap<Registry, Map<string, HostProbe | HostTactics>>();

/** What the host's Lean has: the profile's `packages`, and the probe once per registry. */
async function hostTactics(problem: ProblemContext, checker: LeanChecker, options: M10Options): Promise<HostTactics> {
  if (!options.probe) return { have: new Set(options.packages) };
  const header = problem.target.sketch.prefix;
  let byHeader = hostCache.get(problem.registry);
  if (byHeader === undefined) {
    byHeader = new Map();
    hostCache.set(problem.registry, byHeader);
  }
  let probed = byHeader.get(header);
  if (probed === undefined) {
    probed = await probeHost(checker, { header, known: options.packages, signal: problem.signal }).catch((error: unknown): HostProbe => ({ have: new Set(options.packages), missing: [], unreachable: error instanceof Error ? error.message : String(error) }));
    if (!("unreachable" in probed && probed.unreachable !== undefined) && !problem.signal.aborted) byHeader.set(header, probed);
  }
  if ("unreachable" in probed && probed.unreachable !== undefined) problem.log(`M10: the host's Lean could not be asked which tactics it has (${probed.unreachable}); only the core tactics are offered`);
  else if ("missing" in probed && probed.missing.length > 0) problem.log(`M10: the host's Lean lacks ${probed.missing.join(", ")}`);
  return probed;
}

/** The open subgoals of a claim: the formal claims its `decomposes_into` edges join it to. */
export function subgoalsOf(memory: MemoryStore, claimId: string, limit: number): Claim[] {
  const found: Claim[] = [];
  for (const edge of memory.edges({ from: claimId, kinds: ["decomposes_into"] })) {
    for (const id of edge.to) {
      const claim = memory.claim(id);
      if (claim !== undefined && claim.kind === "formal" && claim.status === "open" && !found.some((c) => c.claimId === id)) found.push(claim);
    }
  }
  return found.slice(0, limit);
}

const ran = (memory: MemoryStore, kind: string, claim: Claim): boolean => memory.nodes(kind, { claimId: claim.claimId }).some((n) => (n.data as { statement?: string }).statement === claim.statement);

function settings(options: M10Options): SolveSettings {
  return { ...DEFAULT_SETTINGS, parallel: options.parallel, cpuBudgetSec: options.cpuBudgetSec, maxSubmissions: options.maxSubmissions, order: options.order, hammerCutoffs: options.hammerCutoffs };
}

/** Runs a stage; a goal whose text the screen refuses is skipped with a log line, as no stage of it may reach Lean. */
async function refusing<T>(problem: ProblemContext, label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnsafeText) {
      problem.log(`M10: ${label} is skipped: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

async function beforeProvers(problem: ProblemContext, services: M10Services): Promise<void> {
  const options = readOptions(problem.options);
  const checker = services.checker?.(problem) ?? new RegistryLeanChecker(problem.registry, { actor: ACTOR });
  const host = await hostTactics(problem, checker, options);
  if (problem.signal.aborted) return;
  const target = problem.memory.claim(problem.claimId);
  if (target === undefined) return;
  const goals: Claim[] = [target, ...(options.subgoals ? subgoalsOf(problem.memory, problem.claimId, options.maxSubgoals) : [])];
  const tactics = tacticsFor(host, { hammerCutoffs: options.hammerCutoffs }).map((t) => t.name);
  problem.log(`M10: ${goals.length} goal(s); tactics: ${tactics.join(", ")}`);

  for (const claim of goals) {
    if (problem.signal.aborted) return;
    const header = claim.header ?? problem.target.sketch.prefix;
    // The target is the bench's; a subgoal's text may come from a model, so its header is screened too.
    if (claim.claimId !== problem.claimId && claim.header !== undefined) {
      const refused = headerProblems(claim.header);
      if (refused.length > 0) {
        problem.log(`M10: the header of subgoal ${claim.claimId} is refused: ${refused.join("; ")}`);
        continue;
      }
    }
    const goal: ClaimGoal = { claimId: claim.claimId, header, statement: claim.claimId === problem.claimId ? problem.target.statement : claim.statement };
    const label = claim.claimId === problem.claimId ? "the target" : `subgoal ${claim.claimId}`;
    if (!ran(problem.memory, BATTERY_RUN, claim)) {
      const ctx: SolveContext = {
        checker,
        memory: problem.memory,
        validate: problem.validate,
        host,
        settings: settings(options),
        random: randomFor(problem.seed, claim.claimId),
        signal: problem.signal,
        log: problem.log,
      };
      const out = await refusing(problem, label, () => solveGoal(ctx, goal));
      if (out === undefined) continue;
      problem.log(
        out.settled
          ? `M10: ${out.winner?.tactic} closed ${label} (domain ${out.domains[0]}, ${Math.round(out.cpuMs)} ms of Lean); the proof passed the fast check`
          : `M10: the battery did not close ${label} (domain ${out.domains[0]}, ${out.tries.length} tries, ${Math.round(out.cpuMs)} ms of Lean)`,
      );
      if (out.settled) {
        if (claim.claimId === problem.claimId) return;
        continue;
      }
    }
    if (problem.signal.aborted) return;
    if (options.firstOrder && !ran(problem.memory, FIRST_ORDER_RUN, claim)) {
      const fo: FirstOrderSettings = { cutoffs: options.premiseCutoffs, timeoutSec: options.atpTimeoutSec, reconstructBudgetSec: options.reconstructBudgetSec, parallel: options.parallel, maxSubmissions: options.maxSubmissions, atpTools: options.atpTools, atpMode: options.atpMode };
      const out = await refusing(problem, label, () => solveFirstOrder(
        {
          solvers: services.solvers?.(problem) ?? registrySolvers(problem.registry, { actor: ACTOR }),
          checker,
          memory: problem.memory,
          validate: problem.validate,
          host,
          settings: fo,
          ...(services.premises !== undefined ? { index: services.premises(problem) } : {}),
          ...(services.selector !== undefined ? { selector: services.selector } : {}),
          random: randomFor(problem.seed, claim.claimId),
          signal: problem.signal,
          log: problem.log,
        },
        goal,
      ));
      if (out === undefined) continue;
      problem.log(
        out.settled
          ? `M10: ATP/SMT premises reconstructed in Lean closed ${label}; the proof passed the fast check`
          : out.outside !== undefined
            ? `M10: ${label} is outside the ATP/SMT fragment: ${out.outside}`
            : `M10: ATP/SMT ${out.evidence.length > 0 ? `answered ${out.evidence.length} time(s), not reconstructed` : "found nothing"} on ${label}`,
      );
      if (out.settled && claim.claimId === problem.claimId) return;
    }
  }
  if (options.search && !problem.signal.aborted && problem.memory.claim(problem.claimId)?.status === "open") await runSearch(problem, options, target);
}

/** The goal-level search on the problem's claim, its non-LLM candidates ordered by `decide` or by the posteriors. */
async function runSearch(problem: ProblemContext, options: M10Options, claim: Claim): Promise<void> {
  if (problem.memory.nodes("search_run", { claimId: claim.claimId }).length > 0) return;
  const posteriors = Posteriors.from(problem.memory);
  const orderer = options.orderer === "decide" && problem.decide !== undefined ? decideOrderer(problem.decide, { log: problem.log }) : posteriorOrderer(posteriors);
  const goals = new LeanGoals(problem.registry, { scope: `m10:${problem.problemId}`, actor: ACTOR });
  const client: GoalClient = {
    async start(statement, header, signal) {
      return goals.start(statement, { header, ...(signal !== undefined ? { signal } : {}) });
    },
    async tactic(state, tactic, signal) {
      const r = await goals.tactic(state, tactic, signal !== undefined ? { signal } : {});
      return "error" in r ? { error: r.error } : { state: r.state, goals: r.goals };
    },
  };
  const random: RandomSource = randomFor(problem.seed, `${claim.claimId}:search`);
  try {
    const names = availableTactics({ have: new Set(options.packages) }).map((t) => t.name).filter((n) => !n.endsWith("?"));
    const result = await searchGoal({ statement: problem.target.statement, header: problem.target.sketch.prefix, nodes: options.searchNodes }, { client, orderer, random, signal: problem.signal, tactics: names });
    const submission = result.solved && result.script.length > 0 ? await problem.validate({ claimId: claim.claimId, proof: result.script.join("\n") }) : undefined;
    // An abort leaves no record, so that a resumed run searches again.
    if (problem.signal.aborted && !result.solved) return;
    problem.memory.recordNode({
      kind: "search_run",
      claimId: claim.claimId,
      data: {
        statement: claim.statement,
        solved: result.solved,
        tried: result.tried,
        alpha: result.alpha,
        orderer: options.orderer === "decide" && problem.decide !== undefined ? "decide" : "posterior",
        script: result.script,
        ...(submission !== undefined ? { submission: { verdict: submission.verdict, status: submission.status, ...(submission.validationId !== undefined ? { validationId: submission.validationId } : {}) } } : {}),
      },
    });
    problem.log(`M10: goal-level search tried ${result.tried} tactics (alpha ${result.alpha}) and ${result.solved ? (submission?.verdict === "valid" ? "found a proof that passed the fast check" : "found a script that validate refused") : "found no proof"}`);
  } catch (error) {
    if (error instanceof UnsafeText) {
      problem.log(`M10: the goal-level search is skipped: ${error.message}`);
      return;
    }
    if (error instanceof LeanMetaError) {
      problem.log(`M10: the goal-level search needs lean.goals: ${error.message}`);
      return;
    }
    throw error;
  } finally {
    await goals.release().catch(() => {});
  }
}

// --- What the provers are told ----------------------------------------------------------------

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))} s`;

/** What the classical tools did about a claim, in words, for a session's opening message; undefined when they did nothing. */
export function describeTried(memory: MemoryStore, claimId: string): string | undefined {
  const lines: string[] = [];
  const runs = memory.nodes(BATTERY_RUN, { claimId }).map((n) => n.data as unknown as BatteryRunData);
  if (runs.length > 0) {
    const byTactic = new Map<string, { outcome: string; ms: number }>();
    let domain = "general";
    for (const run of runs) {
      domain = run.domains[0] ?? domain;
      for (const t of run.tries) {
        if (t.outcome === "aborted" || t.outcome === "error") continue;
        const known = byTactic.get(t.tactic);
        byTactic.set(t.tactic, { outcome: t.outcome, ms: (known?.ms ?? 0) + t.timeMs });
      }
    }
    const failed = [...byTactic].filter(([, v]) => v.outcome !== "success");
    const total = failed.reduce((n, [, v]) => n + v.ms, 0);
    lines.push(`A syntactic router (a guess, not a proof) filed the goal under "${domain}".`);
    if (failed.length > 0) lines.push(`Lean tactics already tried on the whole goal, without a model: ${failed.map(([t, v]) => (v.outcome === "timeout" ? `${t} (timed out)` : t)).join(", ")}; they failed in ${seconds(total)} of Lean time. Do not repeat them on the goal as stated.`);
    const solved = runs.find((r) => r.solved !== undefined);
    if (solved?.solved !== undefined) lines.push(`${solved.solved.tactic} closed the goal in Lean${solved.submission?.verdict === "valid" ? ` and the proof passed the fast check (validation ${solved.submission.validationId ?? "not recorded"})` : ", but validate did not accept the proof it submitted"}.`);
  }
  for (const node of memory.nodes(FIRST_ORDER_RUN, { claimId })) {
    const d = node.data as unknown as FirstOrderRunData;
    if (d.outside !== undefined) {
      // The translator's message quotes text of a model-written subgoal: prose that passes the strict screen, or a fixed sentence.
      const reason = screenProse(d.outside, { max: 160 });
      lines.push(reason.ok ? `ATP and SMT were not tried: the goal is outside their fragment (${reason.text}).` : "ATP and SMT were not tried: the goal is outside their fragment.");
    }
    else if (d.evidence.length > 0) {
      lines.push(
        `${[...new Set(d.evidence.map((e) => e.tool === "smt.z3" ? "z3" : e.tool === "atp.eprover" ? "E" : "Vampire"))].join(" and ")} proved the goal in the encoded theory${d.union.length > 0 ? `, using ${d.union.join(", ")}` : ""}; ${d.solved !== undefined ? `Lean accepted ${d.solved.tactic}` : "Lean did not accept any reconstruction with grind, aesop or hammer, so this is evidence and no proof"}.`,
      );
    } else if (d.tools !== undefined ? d.tools.some((t) => !d.missing.includes(t)) : d.missing.length < 2) lines.push("ATP and SMT found nothing.");
  }
  for (const node of memory.nodes("search_run", { claimId })) {
    const d = node.data as { solved: boolean; tried: number };
    lines.push(`A goal-level search tried ${d.tried} tactics and ${d.solved ? "found a script" : "found no proof"}.`);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

/** Line M10 with the services it uses; `M10` is the one a run gets. */
export function createM10(services: M10Services = {}): Line {
  return {
    id: "M10",
    title: LINE_TITLES.M10,
    requires: [],
    version: "m10-1",
    // Everything the line knows it reads from the memory: a run resumed skips the goals it has a record of.
    resume: "stateless",
    options: M10_DEFAULTS,
    hooks: {
      beforeProvers: (problem) => beforeProvers(problem, services),
      briefing: async (session): Promise<Briefing | undefined> => {
        const text = describeTried(session.memory, session.claimId);
        return text === undefined ? undefined : { title: "Classical tools, tried before any model (line M10)", text };
      },
    },
  };
}

export const M10: Line = createM10();
