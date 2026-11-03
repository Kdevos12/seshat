import type { RandomSource } from "@seshat/core";
import type { CandidateOrderer, OrderCandidate } from "@seshat/decide";
import { Posteriors } from "./posterior.ts";
import { DOMAIN_TACTICS, type Domain, primaryDomain, routeStatement } from "./router.ts";

/**
 * `prove.search` (plan change PC6 item 3): goal-level best-first search through `lean.goals`.
 * The nodes are proof states; a node is expanded by trying candidate tactics on its first goal, and a
 * child that Lean accepts and that changes the goals is a new node. The score of a node is the sum of
 * the log rank-scores along its path divided by depth^alpha (BFS-Prover's length normalisation),
 * with alpha drawn once per run from {0, 0.5, 1}. The budget is in nodes (tactics tried).
 *
 * Candidates come from two places. The model's own tactics (`proposals`, in its ranking) keep that
 * ranking, which was free. Candidates that come without a model call (the battery's tactics for the
 * goal's domain, library lemmas tried by `apply`) are put in order by an injectable `CandidateOrderer`
 * (plan change J3 item 3): the posterior order by default, `decide` when the caller wires it.
 */
export interface GoalClient {
  start(statement: string, header: string, signal?: AbortSignal): Promise<{ state: number; goals: string[] }>;
  /** Runs a tactic on the first goal of a state. An error is an answer, not an exception. */
  tactic(state: number, tactic: string, signal?: AbortSignal): Promise<{ state: number; goals: string[] } | { error: string }>;
}

export const ALPHAS = [0, 0.5, 1] as const;

export interface SearchInput {
  statement: string;
  header: string;
  /** Tactics a model proposed, best first; tried at every node, in that order. */
  proposals?: readonly string[];
  /** Library lemmas to try with `apply` (and `exact`), unranked. */
  lemmas?: readonly string[];
  /** The most tactics to try. */
  nodes: number;
  /** Fixed alpha; absent: drawn from {0, 0.5, 1}. */
  alpha?: number;
  /** Candidates per expansion that come without a model call. Default 8. */
  fanout?: number;
}

export interface SearchOptions {
  client: GoalClient;
  orderer: CandidateOrderer;
  random: RandomSource;
  signal?: AbortSignal;
  /** Tactics the host has, for the battery candidates. */
  tactics: readonly string[];
}

export interface TraceStep {
  depth: number;
  tactic: string;
  /** `closed`: no goal is left; `progress`: new goals; `error` or `no progress`: discarded. */
  outcome: "closed" | "progress" | "error" | "no progress";
  source: "model" | "battery" | "library";
}

export interface SearchResult {
  solved: boolean;
  /** The tactics, one per line of the proof, each acting on the first goal. */
  script: string[];
  tried: number;
  alpha: number;
  trace: TraceStep[];
}

interface Node {
  state: number;
  goals: string[];
  depth: number;
  logScore: number;
  script: string[];
}

const score = (n: Node, alpha: number): number => n.logScore / Math.max(n.depth, 1) ** alpha;

/** Orders candidates by the posteriors of the goal's domain, the router's prior when there are none. */
export function posteriorOrderer(posteriors: Posteriors = new Posteriors(), domainOf: (state: string) => string = (s) => primaryDomain(routeGoalText(s))): CandidateOrderer {
  return {
    async order(state, candidates) {
      const domain = domainOf(state);
      const list = DOMAIN_TACTICS[domain as Domain] ?? [];
      const rank = (c: OrderCandidate): number => {
        const b = posteriors.beta(domain, c.text);
        const mean = b.alpha / (b.alpha + b.beta);
        const prior = list.indexOf(c.text);
        return mean + (prior >= 0 ? 0 : -0.001);
      };
      const sorted = candidates.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.c);
      return { candidates: sorted, by: "kept" };
    },
  };
}

/** The router's reading of a goal as Lean prints it (`n : ℕ\n⊢ n + 0 = n`): hypotheses become binders. */
export function routeGoalText(goal: string) {
  const lines = goal.split("\n");
  const turnstile = lines.findIndex((l) => l.startsWith("⊢"));
  const target = turnstile < 0 ? goal : lines.slice(turnstile).join(" ").replace(/^⊢\s*/u, "");
  const binders = (turnstile < 0 ? [] : lines.slice(0, turnstile)).filter((l) => /^[^\s].*:/u.test(l)).map((l) => `(${l.trim()})`);
  return routeStatement(`${binders.join(" ")} : ${target}`);
}

/** Runs the search. */
export async function searchGoal(input: SearchInput, options: SearchOptions): Promise<SearchResult> {
  const alpha = input.alpha ?? (ALPHAS[Math.min(Math.floor(options.random() * ALPHAS.length), ALPHAS.length - 1)] as number);
  const stopped = (): boolean => options.signal?.aborted === true;
  const trace: TraceStep[] = [];
  const root = await options.client.start(input.statement, input.header, options.signal);
  const frontier: Node[] = [{ state: root.state, goals: root.goals, depth: 0, logScore: 0, script: [] }];
  let tried = 0;
  const fanout = input.fanout ?? 8;
  if (root.goals.length === 0) return { solved: true, script: [], tried, alpha, trace };

  while (frontier.length > 0 && tried < input.nodes && options.signal?.aborted !== true) {
    frontier.sort((a, b) => score(b, alpha) - score(a, alpha) || a.depth - b.depth);
    const node = frontier.shift() as Node;
    const goal = node.goals[0] as string;
    const free = [
      ...(input.lemmas ?? []).flatMap((l) => [`exact ${l}`, `apply ${l}`]).map((text, i): OrderCandidate => ({ id: `library:${i}`, text, source: "library" })),
      ...options.tactics.map((text): OrderCandidate => ({ id: `battery:${text}`, text, source: "battery" })),
    ];
    const ordered = (await options.orderer.order(goal, free)).candidates.slice(0, fanout);
    // The model's tactics keep their own rank; the others are ranked by the orderer. All share one rank scale.
    const candidates: Array<{ tactic: string; source: TraceStep["source"] }> = [
      ...(input.proposals ?? []).map((tactic) => ({ tactic, source: "model" as const })),
      ...ordered.map((c) => ({ tactic: c.text, source: (c.source === "library" ? "library" : "battery") as TraceStep["source"] })),
    ];
    const seen = new Set<string>();
    let rank = 0;
    for (const { tactic, source } of candidates) {
      if (seen.has(tactic)) continue;
      seen.add(tactic);
      if (tried >= input.nodes || stopped()) break;
      tried++;
      rank++;
      const result = await options.client.tactic(node.state, tactic, options.signal);
      if ("error" in result) {
        trace.push({ depth: node.depth + 1, tactic, outcome: "error", source });
        continue;
      }
      if (result.goals.length === 0) {
        trace.push({ depth: node.depth + 1, tactic, outcome: "closed", source });
        return { solved: true, script: [...node.script, tactic], tried, alpha, trace };
      }
      if (result.goals.join("\n") === node.goals.join("\n")) {
        trace.push({ depth: node.depth + 1, tactic, outcome: "no progress", source });
        continue;
      }
      trace.push({ depth: node.depth + 1, tactic, outcome: "progress", source });
      frontier.push({ state: result.state, goals: result.goals, depth: node.depth + 1, logScore: node.logScore + Math.log(1 / (rank + 1)), script: [...node.script, tactic] });
    }
  }
  return { solved: false, script: [], tried, alpha, trace };
}
