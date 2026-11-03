import type { HarnessEvent } from "@seshat/core";

/**
 * The cost-to-first-success curves of the Nexus chunking protocol (plan change PE4, documentation/ablate.md, "Cost to first
 * success"). The protocol tells how many provers to run in parallel (`--provers`) from the attempts of one prover alone, without
 * running again: the attempts of a prover on a problem, 100 of them, are grouped into K chunks of 100/K attempts, each chunk the
 * work of one of K provers that run side by side. A chunk succeeds when one of its attempts does. The K provers advance together,
 * one attempt of each at a time, and the run stops at the first round in which some attempt succeeds; its cost is the sum of
 * every attempt made until then, in all the chunks. The fractions of the escalation ladder are tuned from these curves on real
 * runs; none has been run here.
 */
export interface AttemptCost {
  usd: number;
  success: boolean;
}

/** The standard values of K. */
export const CHUNK_KS: readonly number[] = [1, 3, 6, 10];

export interface ChunkRun {
  k: number;
  /** The attempts of each chunk (the first chunks take the remainder when K does not divide the attempts). */
  sizes: number[];
  /** Whether each chunk has an attempt that succeeded. */
  chunkSucceeds: boolean[];
  solved: boolean;
  /** The cost of every attempt made until the first success (all of them when there is none). */
  usd: number;
  attempts: number;
  /** The rounds the K provers made together until the first success; absent when none succeeded. */
  rounds?: number;
}

/** The protocol on the attempts of one prover on one problem, in the order they were made. */
export function chunkRun(attempts: readonly AttemptCost[], k: number): ChunkRun {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`K must be a whole number of at least 1, got ${k}`);
  const n = attempts.length;
  const base = Math.floor(n / k);
  const extra = n % k;
  const chunks: AttemptCost[][] = [];
  let at = 0;
  for (let c = 0; c < k; c += 1) {
    const size = base + (c < extra ? 1 : 0);
    chunks.push(attempts.slice(at, at + size));
    at += size;
  }
  const longest = Math.max(0, ...chunks.map((c) => c.length));
  let usd = 0;
  let made = 0;
  let rounds: number | undefined;
  for (let r = 0; r < longest && rounds === undefined; r += 1) {
    for (const chunk of chunks) {
      const attempt = chunk[r];
      if (attempt === undefined) continue;
      usd += attempt.usd;
      made += 1;
      if (attempt.success) rounds = r + 1;
    }
  }
  return {
    k,
    sizes: chunks.map((c) => c.length),
    chunkSucceeds: chunks.map((c) => c.some((a) => a.success)),
    solved: rounds !== undefined,
    usd,
    attempts: made,
    ...(rounds !== undefined ? { rounds } : {}),
  };
}

export interface ChunkCurve {
  k: number;
  problems: number;
  solved: number;
  /** Mean cost to the first success over the problems solved. */
  meanUsdToSuccess?: number;
  /** Total cost over the solved problems' successes and the others' every attempt, divided by the problems solved. */
  usdPerSolve?: number;
  /** The points of the curve: the share of the problems solved at a cost of at most `usd`, for each distinct cost, in order. */
  points: Array<{ usd: number; share: number }>;
  /** The quantiles of the cost to the first success, as a share of the budget given: what the ladder's fractions are read from. */
  budgetShare?: { median: number; p80: number };
}

/** The curves for each K over several problems' attempts. `budgetUsd` is the problem budget the quantiles are shares of. */
export function chunkCurves(problems: ReadonlyArray<readonly AttemptCost[]>, options: { ks?: readonly number[]; budgetUsd?: number } = {}): ChunkCurve[] {
  return (options.ks ?? CHUNK_KS).map((k) => {
    const runs = problems.map((attempts) => chunkRun(attempts, k));
    const solvedRuns = runs.filter((r) => r.solved).sort((a, b) => a.usd - b.usd);
    const quantile = (q: number): number => (solvedRuns[Math.min(solvedRuns.length - 1, Math.floor(q * solvedRuns.length))] as ChunkRun).usd;
    const budget = options.budgetUsd;
    return {
      k,
      problems: runs.length,
      solved: solvedRuns.length,
      ...(solvedRuns.length > 0
        ? {
            meanUsdToSuccess: solvedRuns.reduce((s, r) => s + r.usd, 0) / solvedRuns.length,
            usdPerSolve: runs.reduce((s, r) => s + r.usd, 0) / solvedRuns.length,
          }
        : {}),
      points: solvedRuns.map((r, i) => ({ usd: r.usd, share: (i + 1) / runs.length })),
      ...(budget !== undefined && budget > 0 && solvedRuns.length > 0 ? { budgetShare: { median: quantile(0.5) / budget, p80: quantile(0.8) / budget } } : {}),
    };
  });
}

/**
 * The attempts of each prover on each problem, from a journal, in the order they were made: the input of the protocol. The problem of
 * an attempt is the one whose claim it works on, or whose claim its claim descends from.
 */
export function attemptsByProver(events: readonly HarnessEvent[]): Array<{ problemId: string; prover: string; attempts: AttemptCost[] }> {
  const claimProblem = new Map<string, string>();
  const parent = new Map<string, string>();
  const started = new Map<string, { claimId: string; prover: string }>();
  const groups = new Map<string, { problemId: string; prover: string; attempts: AttemptCost[] }>();
  const problemOf = (claimId: string): string | undefined => {
    const seen = new Set<string>();
    for (let at: string | undefined = claimId; at !== undefined && !seen.has(at); at = parent.get(at)) {
      seen.add(at);
      const found = claimProblem.get(at);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const e of events) {
    if (e.type === "problem.registered") claimProblem.set(e.data.claimId, e.data.problemId);
    else if (e.type === "claim.created" && e.data.parentId !== undefined) parent.set(e.data.claimId, e.data.parentId);
    else if (e.type === "attempt.started") started.set(e.data.attemptId, { claimId: e.data.claimId, prover: e.data.prover });
    else if (e.type === "attempt.finished") {
      const s = started.get(e.data.attemptId);
      const problemId = s === undefined ? undefined : problemOf(s.claimId);
      if (s === undefined || problemId === undefined) continue;
      const key = `${problemId}\u0000${s.prover}`;
      const group = groups.get(key) ?? { problemId, prover: s.prover, attempts: [] };
      group.attempts.push({ usd: e.data.usd, success: e.data.outcome === "valid" });
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}
