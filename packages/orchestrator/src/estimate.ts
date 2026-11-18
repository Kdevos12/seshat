import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type HarnessEvent, readEvents } from "@seshat/core";
import type { PriceBook } from "./prices.ts";

/**
 * What a spend ceiling buys, before anything is spent (plan change UX10, documentation/quickstart.md, "What the ceiling buys"). The
 * sessions are measured, never assumed: the tokens of the sessions of the runs already on this machine (`attempt.finished`), priced at
 * the chosen model's price. With too few of them, the estimate says only how many tokens the ceiling buys, and that it learns from the
 * first run. It reads journals and writes nothing.
 */

/** The tokens of one session that ended. */
export interface SessionSample {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** The sessions measured on this machine, and how many sessions a problem took in each run. */
export interface Measured {
  runs: number;
  sessions: SessionSample[];
  /** Per run with at least one problem and one session: its sessions divided by its problems. */
  sessionsPerProblem: number[];
}

/** Below this many sessions measured, no number of sessions is given: a median of three says nothing. */
export const MIN_MEASURED_SESSIONS = 5;
/** The newest runs read, and the largest journal read: an estimate must not read gigabytes of old runs. */
export const MEASURED_RUNS = 20;
const MAX_JOURNAL_BYTES = 50 * 1024 * 1024;

/** The sessions of one journal and the problems it worked on. */
export function sessionsOf(events: readonly HarnessEvent[]): { sessions: SessionSample[]; problems: number } {
  const sessions: SessionSample[] = [];
  const problems = new Set<string>();
  for (const e of events) {
    if (e.type === "problem.registered") problems.add(e.data.problemId);
    if (e.type !== "attempt.finished") continue;
    // A session that never reached the model (an error before the first answer) says nothing of what a session costs.
    if (e.data.inputTokens + e.data.outputTokens <= 0) continue;
    sessions.push({ inputTokens: e.data.inputTokens, cachedInputTokens: e.data.cachedInputTokens ?? 0, outputTokens: e.data.outputTokens });
  }
  return { sessions, problems: problems.size };
}

/** The sessions of the newest runs under `runsDir` (the directories with a journal); a journal that cannot be read is skipped. */
export function measuredSessions(runsDir: string, maxRuns: number = MEASURED_RUNS): Measured {
  const out: Measured = { runs: 0, sessions: [], sessionsPerProblem: [] };
  if (!existsSync(runsDir)) return out;
  const journals: Array<{ path: string; modified: number }> = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const path = join(runsDir, entry.name, "journal.jsonl");
    try {
      const s = statSync(path);
      if (s.size <= MAX_JOURNAL_BYTES) journals.push({ path, modified: s.mtimeMs });
    } catch {
      // Not a run.
    }
  }
  journals.sort((a, b) => b.modified - a.modified);
  for (const j of journals.slice(0, maxRuns)) {
    let found: ReturnType<typeof sessionsOf>;
    try {
      found = sessionsOf(readEvents(j.path));
    } catch {
      continue;
    }
    if (found.sessions.length === 0) continue;
    out.runs += 1;
    out.sessions.push(...found.sessions);
    if (found.problems > 0) out.sessionsPerProblem.push(found.sessions.length / found.problems);
  }
  return out;
}

/** Dollars per million tokens: the price the estimate uses. */
export interface TokenPrices {
  input: number;
  cachedInput: number;
  output: number;
}

/** The prices a run would charge for this model: the host's table where it has the model, pi-ai's otherwise. */
export function tokenPrices(model: Pick<Model<Api>, "provider" | "id" | "cost">, prices?: PriceBook): TokenPrices {
  const host = prices?.pricingOf(model);
  if (host !== undefined) return { input: host.cacheMiss, cachedInput: host.cacheHit, output: host.output };
  return { input: model.cost.input, cachedInput: model.cost.cacheRead > 0 ? model.cost.cacheRead : model.cost.input, output: model.cost.output };
}

/** What one session costs at these prices. */
export function sessionUsd(s: SessionSample, p: TokenPrices): number {
  const cached = Math.min(s.cachedInputTokens, s.inputTokens);
  return ((s.inputTokens - cached) * p.input + cached * p.cachedInput + s.outputTokens * p.output) / 1e6;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export interface CeilingEstimate {
  maxUsd: number;
  model: string;
  prices: TokenPrices;
  /** Millions of tokens the ceiling buys, all input or all output. */
  millionInput: number;
  millionOutput: number;
  /** Present when enough sessions were measured: the median session's dollars at this model's price, and what the ceiling buys of them. */
  measured?: { runs: number; sessions: number; sessionUsd: number; sessionsBought: number; problemsBought?: number };
}

/** What `maxUsd` buys of `model` at `prices`, from the sessions measured (none: tokens only). */
export function estimateCeiling(maxUsd: number, model: string, prices: TokenPrices, measured?: Measured): CeilingEstimate {
  const per = (price: number) => (price > 0 ? maxUsd / price : Number.POSITIVE_INFINITY);
  const out: CeilingEstimate = { maxUsd, model, prices, millionInput: per(prices.input), millionOutput: per(prices.output) };
  if (measured === undefined || measured.sessions.length < MIN_MEASURED_SESSIONS) return out;
  const usd = median(measured.sessions.map((s) => sessionUsd(s, prices)));
  if (!(usd > 0)) return out;
  const sessionsBought = Math.floor(maxUsd / usd);
  const perProblem = measured.sessionsPerProblem.length > 0 ? median(measured.sessionsPerProblem) : undefined;
  return {
    ...out,
    measured: {
      runs: measured.runs,
      sessions: measured.sessions.length,
      sessionUsd: usd,
      sessionsBought,
      ...(perProblem !== undefined && perProblem > 0 ? { problemsBought: Math.floor(sessionsBought / perProblem) } : {}),
    },
  };
}

const tokens = (million: number): string => (!Number.isFinite(million) ? "unlimited" : million >= 10 ? `${Math.round(million)} million` : million >= 1 ? `${million.toFixed(1)} million` : `${Math.round(million * 1000)} thousand`);

/** The estimate in one sentence, said as an estimate. */
export function estimateLine(e: CeilingEstimate): string {
  const ceiling = `$${e.maxUsd}`;
  const m = e.measured;
  if (m !== undefined) {
    const problems = m.problemsBought !== undefined ? `, or about ${m.problemsBought} problem${m.problemsBought === 1 ? "" : "s"} like the earlier ones` : "";
    return `Estimate: ${ceiling} buys about ${m.sessionsBought} session${m.sessionsBought === 1 ? "" : "s"} of ${e.model}${problems} (the median of ${m.sessions} sessions of ${m.runs} run${m.runs === 1 ? "" : "s"} on this machine, at $${m.sessionUsd.toFixed(4)} each at this model's price). A hard problem can take more.`;
  }
  return `Estimate: ${ceiling} buys about ${tokens(e.millionInput)} input tokens or ${tokens(e.millionOutput)} output tokens of ${e.model}. No session has been measured on this machine yet; after a first run this says how many sessions it buys.`;
}

/** The estimate of a model named `provider/id`, or undefined when the library does not know it. */
export function estimateFor(o: { maxUsd: number; model: string; getModel: (provider: string, id: string) => Model<Api> | undefined; prices?: PriceBook; measured: Measured }): CeilingEstimate | undefined {
  const slash = o.model.indexOf("/");
  const known = slash > 0 ? o.getModel(o.model.slice(0, slash), o.model.slice(slash + 1)) : undefined;
  if (known === undefined) return undefined;
  return estimateCeiling(o.maxUsd, o.model, tokenPrices(known, o.prices), o.measured);
}
