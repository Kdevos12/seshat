import { type HarnessEvent, type Json, mergePatch } from "@seshat/core";
import type { CegisCounter } from "@seshat/induction";
import { USE_KIND } from "@seshat/library";
import { redundancy, type Redundancy } from "@seshat/memory";
import { M15_HINT_KIND } from "@seshat/scheduler";
import { type CacheStat, cacheReport } from "./cache-report.ts";
import { buildReport, type RunReport, type SiteLine } from "./report.ts";

/**
 * The measures of plan section 6 for one run, read from its journal alone (documentation/ablate.md, "What is measured"):
 * `harness ablate` runs one configuration per row of its table and calls `measureRun` on each journal. A function of events, so
 * that any tool that reads journals can use it, and so that the same journal always gives the same row.
 */
export interface RunMeasures {
  /** Problems that ended, and how (`proved`, `refuted`, `candidate`, `unsolved`...). */
  problems: number;
  outcomes: Record<string, number>;
  /** Problems with a certified proof or refutation. */
  certified: number;
  /** Problems with a Lean-checked proof: certified, or a candidate that passed the fast check. The "solves" that the costs are divided by. */
  solved: number;
  usd: number;
  /** Input and output tokens. */
  tokens: number;
  usdPerSolve?: number;
  tokensPerSolve?: number;
  attempts: number;
  /** The redundant attempts (plan section 6); absent without the M1 line. */
  redundancy?: Redundancy;
  /** Input tokens per model request of the provers' sessions: the size of the context the model was sent, cached or not. */
  meanContextTokens?: number;
  /** Tokens of tool declarations each session sent with every request (the mean over the sessions that recorded it). */
  toolDefinitionTokens?: number;
  memory: MemoryUse;
  modelFree: ModelFree;
  mechanisms: Mechanisms;
  /** The share of proofs whose chain of Lean-checked edges meets a claim that line M8 made (an inductive hypothesis). */
  inductive: Share;
  /** The share of proofs that reuse a library lemma or a schema (PE9, over time). */
  reuse: Share;
  /** Dollars of the sessions on a strategy that had not been tried on the claim's group before, against all session dollars (PE9, over time). */
  novelStrategy: { usd: number; totalUsd: number; share: number };
  sites: SiteLine[];
  cache?: { total: CacheStat; byLine: Record<string, CacheStat>; byRung?: Record<string, CacheStat> };
  /** Proofs that use a declaration of each source: the harness library, each extra package, Mathlib (LC2). */
  proofsBySource: Record<string, number>;
  /** The counterexample set's counter (PD5), when the run's memory was read for it. */
  cegis?: CegisCounter;
  /** Each problem's outcome and dollars, for the split by difficulty and the paired comparison of two configurations. */
  perProblem: Array<{ problemId: string; outcome: string; usd: number }>;
}

export interface Share {
  count: number;
  total: number;
  /** `count / total`; 0 when there is nothing to divide. */
  share: number;
}

/** Proofs that used an element of the memory (plan section 6), by kind of element. */
export interface MemoryUse extends Share {
  /** `lesson`: a session whose proof was shown unverified items by the draw; `library`: a library lemma in the proof; `schema`: a schema shown to the session. */
  byKind: Record<string, number>;
}

/** Subgoals and conjectures settled without a model, and what that cost in CPU. */
export interface ModelFree {
  /** Claims made by the scheduler's sketches (M12), and claims joined by a decomposition to another. */
  subgoals: Share;
  /** Claims made by the conjecture lines (M8, M13, M14, M16). */
  conjectures: Share;
  /** Time of the tool runs of the model-free lines (M10, M11), in milliseconds. */
  cpuMs: number;
}

/** The diversity of the proofs found: distinct labels, distinct sources and the entropy of the pairs. */
export interface Mechanisms {
  proofs: number;
  strategies: number;
  sources: number;
  entropyBits: number;
}

/** The lines that settle a claim with a program and no model call: the battery with ATP and SMT (M10), and the small-model refutations (M11). */
export const MODEL_FREE_LINES: readonly string[] = ["line:M10", "line:M11"];

/** The origins of the claims the conjecture lines make. */
export const CONJECTURE_ORIGINS: readonly string[] = ["line:M8", "line:M13", "line:M14", "line:M16"];

const SETTLED = new Set(["computed", "proved", "refuted"]);

function share(count: number, total: number): Share {
  return { count, total, share: total === 0 ? 0 : count / total };
}

function entropyOf(labels: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / labels.length) * Math.log2(n / labels.length);
  return h;
}

interface AttemptInfo {
  claimId: string;
  strategy?: string;
  included: number;
  usd: number;
  turns: number;
  inputTokens: number;
  outcome?: string;
  toolTokens?: number;
  site: string;
}

/** The index of a journal that the measures read: claims, problems, attempts, valid validations, edges and nodes. */
interface Index {
  problems: Map<string, { claimId: string; path: string; outcome?: string; usd: number }>;
  claims: Map<string, { origin: string; parentId?: string; status: string }>;
  attempts: Map<string, AttemptInfo>;
  /** Valid validations, by claim: who made them and for which attempt. */
  valid: Map<string, Array<{ actor: string; attemptId?: string }>>;
  /** Edges Lean checked: from, to. */
  checked: Array<{ from: string; to: string[] }>;
  nodes: Map<string, { kind: string; data: Json; claimId?: string }>;
  toolRuns: Map<string, { actor: string; capability: string }>;
  cpuMs: number;
  decomposed: Set<string>;
}

function indexOf(events: readonly HarnessEvent[]): Index {
  const ix: Index = {
    problems: new Map(),
    claims: new Map(),
    attempts: new Map(),
    valid: new Map(),
    checked: [],
    nodes: new Map(),
    toolRuns: new Map(),
    cpuMs: 0,
    decomposed: new Set(),
  };
  const edges = new Map<string, { from: string; to: string[] }>();
  for (const e of events) {
    switch (e.type) {
      case "problem.registered":
        ix.problems.set(e.data.problemId, { claimId: e.data.claimId, path: e.data.source.path, usd: 0 });
        break;
      case "problem.finished": {
        const p = ix.problems.get(e.data.problemId);
        if (p !== undefined) {
          p.outcome = e.data.outcome;
          p.usd = e.data.usd;
        }
        break;
      }
      case "claim.created":
        ix.claims.set(e.data.claimId, { origin: e.data.origin, ...(e.data.parentId !== undefined ? { parentId: e.data.parentId } : {}), status: e.data.status });
        break;
      case "claim.status_changed": {
        const c = ix.claims.get(e.data.claimId);
        if (c !== undefined) c.status = e.data.to;
        break;
      }
      case "attempt.started":
        ix.attempts.set(e.data.attemptId, {
          claimId: e.data.claimId,
          ...(e.data.strategy !== undefined ? { strategy: e.data.strategy } : {}),
          included: e.data.included?.length ?? 0,
          usd: 0,
          turns: 0,
          inputTokens: 0,
          site: e.data.site ?? "prover.session",
        });
        break;
      case "attempt.finished": {
        const a = ix.attempts.get(e.data.attemptId);
        if (a === undefined) break;
        a.outcome = e.data.outcome;
        a.usd = e.data.usd;
        a.turns = e.data.turns;
        a.inputTokens = e.data.inputTokens;
        if (e.data.toolTokens !== undefined) a.toolTokens = e.data.toolTokens;
        const label = e.data.declaredStrategy ?? e.data.strategy;
        if (label !== undefined) a.strategy = label;
        break;
      }
      case "validation.finished":
        if (e.data.verdict === "valid" && e.data.method === "repl" && e.data.negation !== true) {
          const list = ix.valid.get(e.data.claimId) ?? [];
          list.push({ actor: e.actor, ...(e.data.attemptId !== undefined ? { attemptId: e.data.attemptId } : {}) });
          ix.valid.set(e.data.claimId, list);
        }
        break;
      case "edge.added":
        if (e.data.kind === "decomposes_into") for (const to of e.data.to) ix.decomposed.add(to);
        edges.set(e.data.edgeId, { from: e.data.from, to: e.data.to });
        if (e.data.status === "lean_checked") ix.checked.push({ from: e.data.from, to: e.data.to });
        break;
      case "edge.status_changed": {
        const edge = edges.get(e.data.edgeId);
        if (edge !== undefined && e.data.to === "lean_checked") ix.checked.push(edge);
        break;
      }
      case "node.recorded":
        ix.nodes.set(e.data.nodeId, { kind: e.data.kind, data: e.data.data, ...(e.data.claimId !== undefined ? { claimId: e.data.claimId } : {}) });
        break;
      case "node.updated": {
        const n = ix.nodes.get(e.data.nodeId);
        if (n !== undefined) n.data = mergePatch(n.data, e.data.patch);
        break;
      }
      case "tool_run.started":
        ix.toolRuns.set(e.data.toolRunId, { actor: e.actor, capability: e.data.capability });
        break;
      case "tool_run.finished": {
        const run = ix.toolRuns.get(e.data.toolRunId);
        if (run !== undefined && MODEL_FREE_LINES.includes(run.actor)) ix.cpuMs += e.data.durationMs;
        break;
      }
      default:
        break;
    }
  }
  return ix;
}

const nodesOf = (ix: Index, kind: string): Array<{ data: Record<string, Json | undefined>; claimId?: string }> =>
  [...ix.nodes.values()]
    .filter((n) => n.kind === kind)
    .map((n) => ({ data: (typeof n.data === "object" && n.data !== null && !Array.isArray(n.data) ? n.data : {}) as Record<string, Json | undefined>, ...(n.claimId !== undefined ? { claimId: n.claimId } : {}) }));

/** The claims connected to `start` by edges Lean checked, in either direction. */
function connected(ix: Index, start: string): Set<string> {
  const adjacent = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adjacent.get(a) ?? new Set<string>();
    set.add(b);
    adjacent.set(a, set);
  };
  for (const edge of ix.checked) for (const to of edge.to) (link(edge.from, to), link(to, edge.from));
  const seen = new Set([start]);
  const queue = [start];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const next of adjacent.get(at) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** The root problem's file of a claim: the claim itself if a problem has it, else the parents'. */
function groupOf(ix: Index, claimId: string): string | undefined {
  const byClaim = new Map([...ix.problems.values()].map((p) => [p.claimId, p.path]));
  const seen = new Set<string>();
  for (let at: string | undefined = claimId; at !== undefined && !seen.has(at); at = ix.claims.get(at)?.parentId) {
    seen.add(at);
    const path = byClaim.get(at);
    if (path !== undefined) return path;
  }
  return undefined;
}

/** What `measureRun` takes besides the journal. */
export interface MeasureOptions {
  /** The events of the earlier journals the run was started on (`--memory-from`), oldest first: a strategy tried there is not new. */
  earlier?: readonly HarnessEvent[];
  /** The counter of the counterexample set (`cegisCounter` of the run's memory), which the journal alone cannot give. */
  cegis?: CegisCounter;
  /** The report of the run, when the caller built it already. */
  report?: RunReport;
}

/** The measures of plan section 6 for a run, from its events. */
export function measureRun(events: readonly HarnessEvent[], options: MeasureOptions = {}): RunMeasures {
  const report = options.report ?? buildReport(events);
  const ix = indexOf(events);
  const outcomes = report.outcomes;
  const certified = (outcomes.proved ?? 0) + (outcomes.refuted ?? 0);
  const solved = certified + (outcomes.candidate ?? 0);
  const tokens = report.inputTokens + report.outputTokens;
  const sessions = [...ix.attempts.values()].filter((a) => a.site === "prover.session" && a.turns > 0);
  const turns = sessions.reduce((n, a) => n + a.turns, 0);
  const declared = [...ix.attempts.values()].flatMap((a) => (a.toolTokens !== undefined ? [a.toolTokens] : []));
  const redundant = redundancy(events);
  const cache = cacheReport(events);

  // The proofs: the problems with a Lean-checked proof, and the attempt and the validator behind each.
  const proofs = [...ix.problems.values()].filter((p) => p.outcome === "proved" || p.outcome === "refuted" || p.outcome === "candidate");
  const hints = nodesOf(ix, M15_HINT_KIND);
  const uses = nodesOf(ix, USE_KIND);
  const byKind: Record<string, number> = {};
  let withMemory = 0;
  let throughInductive = 0;
  let reusing = 0;
  const labels: string[] = [];
  const strategies = new Set<string>();
  const sources = new Set<string>();
  const bySource: Record<string, number> = {};
  for (const p of proofs) {
    const validations = ix.valid.get(p.claimId) ?? [];
    const mine = [...ix.attempts.entries()].filter(([, a]) => a.claimId === p.claimId && a.outcome === "valid");
    const kinds = new Set<string>();
    for (const [attemptId, a] of mine) {
      if (a.included > 0) kinds.add("lesson");
      if (uses.some((u) => u.data.attemptId === attemptId && u.data.outcome === "valid" && Array.isArray(u.data.used) && (u.data.used as Array<{ source?: string }>).some((x) => x.source === "library"))) kinds.add("library");
      if (hints.some((h) => h.data.attemptId === attemptId && h.data.shown === true)) kinds.add("schema");
    }
    for (const k of kinds) byKind[k] = (byKind[k] ?? 0) + 1;
    if (kinds.size > 0) withMemory += 1;
    if (kinds.has("library") || hints.some((h) => h.data.reused === true && mine.some(([id]) => id === h.data.attemptId))) reusing += 1;
    const chain = connected(ix, p.claimId);
    if ([...chain].some((id) => id !== p.claimId && ix.claims.get(id)?.origin === "line:M8" && SETTLED.has(ix.claims.get(id)?.status ?? ""))) throughInductive += 1;
    const strategy = mine.map(([, a]) => a.strategy).find((s) => s !== undefined);
    const actor = validations[0]?.actor ?? (mine.length > 0 ? "prover" : "unknown");
    const source = actor.startsWith("prover:") ? "prover" : actor;
    sources.add(source);
    if (strategy !== undefined) strategies.add(strategy);
    labels.push(`${source}/${strategy ?? "-"}`);
  }
  for (const u of uses) {
    if (u.data.outcome !== "valid" || !Array.isArray(u.data.used)) continue;
    for (const label of new Set((u.data.used as Array<{ source?: string }>).flatMap((x) => (typeof x.source === "string" ? [x.source] : [])))) bySource[label] = (bySource[label] ?? 0) + 1;
  }

  // Subgoals and conjectures settled by a program: a claim with a valid Lean check made by a model-free line.
  const settledByProgram = (claimId: string) => (ix.valid.get(claimId) ?? []).some((v) => MODEL_FREE_LINES.includes(v.actor));
  const subgoalIds = [...ix.claims.entries()].filter(([id, c]) => c.origin === "line:M12" || ix.decomposed.has(id)).map(([id]) => id);
  const conjectureIds = [...ix.claims.entries()].filter(([, c]) => CONJECTURE_ORIGINS.includes(c.origin)).map(([id]) => id);

  // The strategies that were new to the claim's group (the bench file), in the order the attempts were made, after the earlier journals'.
  const tried = new Map<string, Set<string>>();
  const note = (group: string | undefined, strategy: string | undefined) => {
    if (group === undefined || strategy === undefined) return false;
    const set = tried.get(group) ?? new Set<string>();
    tried.set(group, set);
    const fresh = !set.has(strategy);
    set.add(strategy);
    return fresh;
  };
  if (options.earlier !== undefined && options.earlier.length > 0) {
    const before = indexOf(options.earlier);
    for (const a of before.attempts.values()) note(groupOf(before, a.claimId), a.strategy);
  }
  let novelUsd = 0;
  let sessionUsd = 0;
  for (const e of events) {
    if (e.type !== "attempt.finished") continue;
    const a = ix.attempts.get(e.data.attemptId);
    if (a === undefined || a.site !== "prover.session") continue;
    sessionUsd += a.usd;
    if (note(groupOf(ix, a.claimId), a.strategy)) novelUsd += a.usd;
  }

  return {
    problems: report.problems.length,
    outcomes,
    certified,
    solved,
    usd: report.usd,
    tokens,
    ...(solved > 0 ? { usdPerSolve: report.usd / solved, tokensPerSolve: tokens / solved } : {}),
    attempts: report.attempts.total,
    ...(redundant !== undefined ? { redundancy: redundant } : {}),
    ...(turns > 0 ? { meanContextTokens: sessions.reduce((n, a) => n + a.inputTokens, 0) / turns } : {}),
    ...(declared.length > 0 ? { toolDefinitionTokens: declared.reduce((a, b) => a + b, 0) / declared.length } : {}),
    memory: { ...share(withMemory, proofs.length), byKind },
    modelFree: {
      subgoals: share(subgoalIds.filter(settledByProgram).length, subgoalIds.length),
      conjectures: share(conjectureIds.filter(settledByProgram).length, conjectureIds.length),
      cpuMs: ix.cpuMs,
    },
    mechanisms: { proofs: proofs.length, strategies: strategies.size, sources: sources.size, entropyBits: entropyOf(labels) },
    inductive: share(throughInductive, proofs.length),
    reuse: share(reusing, proofs.length),
    novelStrategy: { usd: novelUsd, totalUsd: sessionUsd, share: sessionUsd > 0 ? novelUsd / sessionUsd : 0 },
    sites: report.sites,
    ...(cache !== undefined ? { cache: { total: cache.total, byLine: cache.byLine, ...(cache.byRung !== undefined ? { byRung: cache.byRung } : {}) } } : {}),
    proofsBySource: report.library?.bySource ?? bySource,
    ...(options.cegis !== undefined ? { cegis: options.cegis } : {}),
    perProblem: report.problems.map((p) => ({ problemId: p.problemId, outcome: p.outcome, usd: p.usd })),
  };
}
