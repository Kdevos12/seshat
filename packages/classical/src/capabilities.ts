import { assertHeaderSafe, assertLeanSafe } from "./screen.ts";
import { type Json, type LeanChecker, seeded } from "@seshat/core";
import type { CandidateOrderer } from "@seshat/decide";
import { type FactoryContext, type ImplementationFactory, type ImplementationInstance, type InvokeContext } from "@seshat/registry";
import { runBattery } from "./battery.ts";
import { type HostProbe, probeHost } from "./probe.ts";
import { Posteriors } from "./posterior.ts";
import { primaryDomain, routeStatement } from "./router.ts";
import { type GoalClient, posteriorOrderer, searchGoal } from "./search.ts";
import { tacticsFor } from "./solve.ts";
import { availableTactics, type HostTactics } from "./tactics.ts";

// --- prove.auto --------------------------------------------------------------------------------

export interface ProveAutoInput {
  statement: string;
  header?: string;
  cpuBudgetSec?: number;
  /** Restrict the battery to these tactics. */
  tactics?: string[];
}

export interface ProveAutoOutput {
  solved: boolean;
  /** The tactic that closed the goal, and the proof text to put after `by`. */
  tactic?: string;
  proof?: string;
  domains: string[];
  tries: Array<{ tactic: string; outcome: string; timeMs: number }>;
  cpuMs: number;
  /** Tactics the host does not have (not offered), and those left untried when the budget ran out. */
  skipped: string[];
  [key: string]: Json | undefined;
}

const DEFAULT_HEADER = "import Mathlib";

function packagesOf(context: FactoryContext): string[] {
  const p = context.settings.packages;
  return typeof p === "string" ? p.split(",").map((x) => x.trim()).filter((x) => x !== "") : [];
}

/**
 * `prove.auto` (plan §16 level 1): the battery as one tool a prover calls on a goal it names. It
 * checks through a Lean checker built from the host profile's settings, reads which optional tactics
 * the host has once (the `packages` setting names those the profile promises), and answers with the
 * tactic and the proof text. It submits nothing: the prover puts the proof in its own `lean_check`.
 */
export function proveAutoFactory(makeChecker: (context: FactoryContext) => LeanChecker): ImplementationFactory {
  return (context): ImplementationInstance => {
    const checker = makeChecker(context);
    const known = packagesOf(context);
    const probes = new Map<string, HostProbe>();
    const host = async (header: string, signal: AbortSignal): Promise<HostTactics> => {
      const kept = probes.get(header);
      if (kept !== undefined) return kept;
      const probed = await probeHost(checker, { header, known, signal }).catch((): HostProbe => ({ have: new Set(known), missing: [], unreachable: "Lean did not answer" }));
      if (probed.unreachable === undefined && !signal.aborted) probes.set(header, probed);
      return probed;
    };
    return {
      async invoke(input: Json, invoke: InvokeContext): Promise<Json> {
        const { statement, header = DEFAULT_HEADER, cpuBudgetSec = 30, tactics } = input as unknown as ProveAutoInput;
        assertHeaderSafe(header, "the header");
        assertLeanSafe(statement, "the statement");
        const have = await host(header, invoke.signal);
        const route = routeStatement(statement);
        const domain = primaryDomain(route);
        const result = await runBattery({
          checker,
          goal: { header, statement },
          tactics: tacticsFor(have, { hammerCutoffs: [], ...(tactics !== undefined ? { only: tactics } : {}) }),
          domain,
          posteriors: new Posteriors(),
          order: { mode: "mean" },
          cpuBudgetSec,
          signal: invoke.signal,
        });
        const out: ProveAutoOutput = {
          solved: result.winner !== undefined,
          ...(result.winner !== undefined ? { tactic: result.winner.tactic, proof: result.winner.proof } : {}),
          domains: route.domains,
          tries: result.tries.map((t) => ({ tactic: t.tactic, outcome: t.outcome, timeMs: t.timeMs })),
          cpuMs: result.cpuMs,
          skipped: result.skipped,
        };
        return out as unknown as Json;
      },
    };
  };
}

// --- prove.search ------------------------------------------------------------------------------

export interface ProveSearchInput {
  statement: string;
  header?: string;
  tactics?: string[];
  lemmas?: string[];
  nodes?: number;
  maxDepth?: number;
  timeoutSec?: number;
  alpha?: number;
  seed?: number;
}

/**
 * `prove.search` (plan change PC6 item 3): goal-level best-first search through `lean.goals`'s
 * implementation. `makeGoals` builds the Pantograph instance from the host profile's settings. The
 * orderer of the candidates that come without a model call is a factory option, the posterior order
 * by default (plan change J3 item 3); the line M10 passes `decide` in where it runs the search itself,
 * since a registry factory has no `decide` of a problem.
 */
export function proveSearchFactory(makeGoals: ImplementationFactory, options: { orderer?: CandidateOrderer } = {}): ImplementationFactory {
  return async (context): Promise<ImplementationInstance> => {
    const goals = await makeGoals(context);
    const orderer = options.orderer ?? posteriorOrderer();
    return {
      async invoke(input: Json, invoke: InvokeContext): Promise<Json> {
        const { statement, header = DEFAULT_HEADER, tactics, lemmas, nodes = 60, maxDepth, timeoutSec, alpha, seed = 1 } = input as unknown as ProveSearchInput;
        assertHeaderSafe(header, "the header");
        const scope = `prove.search:${Math.random().toString(36).slice(2)}`;
        const call = async (body: Record<string, Json>): Promise<Record<string, Json>> =>
          (await goals.invoke(body as Json, { ...invoke, scope })) as Record<string, Json>;
        const client: GoalClient = {
          async start(s, h) {
            const out = await call({ op: "start", statement: s, header: h });
            return { state: out.state as number, goals: out.goals as string[] };
          },
          async tactic(state, tactic) {
            const out = await call({ op: "tactic", state, tactic });
            if (typeof out.error === "string") return { error: out.error };
            return { state: out.state as number, goals: out.goals as string[] };
          },
        };
        try {
          const names = (tactics === undefined ? availableTactics({ have: new Set() }).map((t) => t.name) : []).filter((n) => !n.endsWith("?"));
          const result = await searchGoal(
            { statement, header, nodes, ...(maxDepth !== undefined ? { maxDepth } : {}), ...(timeoutSec !== undefined ? { timeoutSec } : {}), ...(lemmas !== undefined ? { lemmas } : {}), ...(tactics !== undefined ? { proposals: tactics } : {}), ...(alpha !== undefined ? { alpha } : {}) },
            { client, orderer, random: seeded(seed), signal: invoke.signal, tactics: names },
          );
          return { ...result, trace: result.trace.slice(-60) } as unknown as Json;
        } finally {
          await goals.release?.(scope, { signal: invoke.signal }).catch(() => {});
        }
      },
      ...(goals.health !== undefined ? { health: goals.health.bind(goals) } : {}),
      ...(goals.close !== undefined ? { close: goals.close.bind(goals) } : {}),
    };
  };
}
