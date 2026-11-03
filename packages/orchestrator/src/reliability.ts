import { type HarnessEvent, type Json, mergePatch } from "@seshat/core";

/**
 * The reliability of the typed decisions (plan change J4, documentation/ablate.md, "Reliability of decisions"): a decision
 * is labeled by what Lean came to, and the table says, per site and backend, how often the answer the model gave with a probability
 * was the one that led to a proved subgoal. No threshold on a probability is allowed until this curve exists for the site
 * (documentation/decide.md, "Calibration"); the harness builds the curve here, from the journal.
 */
export interface ReliabilityBin {
  /** The bin's lower and upper edge of the probability of the answer. */
  from: number;
  to: number;
  n: number;
  meanConfidence: number;
  /** The share of the bin's decisions whose outcome was a success. */
  accuracy: number;
}

export interface SiteReliability {
  site: string;
  backend: string;
  /** Decisions, and the ones Lean gave an outcome to. */
  decisions: number;
  labeled: number;
  /** Labeled decisions whose answer led to a success. */
  successes: number;
  /** Expected calibration error: the weighted gap between confidence and accuracy over the bins. Absent without a labeled decision. */
  ece?: number;
  bins: ReliabilityBin[];
  /** Over the labeled choices that name the candidate that succeeded: the mean rank of that candidate in the decision's order (1 is first), and how many there were. */
  rank?: { mean: number; of: number };
}

/** A decision with the outcome Lean gave it. */
export interface LabeledDecision {
  decisionId: string;
  key: string;
  site: string;
  backend: string;
  /** The probability of the answer the decision gave. */
  confidence: number;
  answer: string;
  /** The labels in the order of their probability, the answer first when it ties. */
  ranking: string[];
  /** True when the answer led to a proved subgoal; undefined when the journal gives no outcome. */
  success?: boolean;
  /** The rank (1 is first) of the candidate that succeeded, when the site is a choice and one did. */
  successRank?: number;
}

const SETTLED = new Set(["computed", "proved", "refuted"]);

interface NodeRow {
  kind: string;
  claimId?: string;
  data: { [key: string]: Json | undefined };
}

const object = (data: Json): { [key: string]: Json | undefined } => (typeof data === "object" && data !== null && !Array.isArray(data) ? data : {});

/** The decisions of a journal, each with the outcome the rest of the journal gives it. */
export function labelDecisions(events: readonly HarnessEvent[]): LabeledDecision[] {
  const status = new Map<string, string>();
  const nodes = new Map<string, NodeRow>();
  const attempts = new Map<string, { claimId: string; strategy?: string; outcome?: string }>();
  for (const e of events) {
    if (e.type === "claim.created") status.set(e.data.claimId, e.data.status);
    else if (e.type === "claim.status_changed") status.set(e.data.claimId, e.data.to);
    else if (e.type === "node.recorded") nodes.set(e.data.nodeId, { kind: e.data.kind, ...(e.data.claimId !== undefined ? { claimId: e.data.claimId } : {}), data: object(e.data.data) });
    else if (e.type === "node.updated") {
      const n = nodes.get(e.data.nodeId);
      if (n !== undefined) n.data = object(mergePatch(n.data as Json, e.data.patch));
    } else if (e.type === "attempt.started") attempts.set(e.data.attemptId, { claimId: e.data.claimId, ...(e.data.strategy !== undefined ? { strategy: e.data.strategy } : {}) });
    else if (e.type === "attempt.finished") {
      const a = attempts.get(e.data.attemptId);
      if (a !== undefined) {
        a.outcome = e.data.outcome;
        const label = e.data.declaredStrategy ?? e.data.strategy;
        if (label !== undefined) a.strategy = label;
      }
    }
  }
  /** The tactics that closed a goal of the claim (the battery's or the search's), and the first strategy of a valid attempt on it. */
  const solvedTactics = (claimId: string | undefined): string[] =>
    claimId === undefined
      ? []
      : [...nodes.values()].flatMap((n) => {
          if (n.claimId !== claimId || (n.kind !== "battery_run" && n.kind !== "first_order_run" && n.kind !== "search_run")) return [];
          const solved = n.data.solved;
          if (typeof solved === "object" && solved !== null && !Array.isArray(solved) && typeof solved.tactic === "string") return [solved.tactic];
          return Array.isArray(n.data.script) && n.data.solved === true ? (n.data.script as Json[]).filter((x): x is string => typeof x === "string") : [];
        });
  const strategiesOf = (claimId: string | undefined): string[] =>
    claimId === undefined ? [] : [...attempts.values()].flatMap((a) => (a.claimId === claimId && a.outcome === "valid" && a.strategy !== undefined ? [a.strategy] : []));

  const out: LabeledDecision[] = [];
  for (const e of events) {
    if (e.type !== "decision.made") continue;
    const d = e.data;
    const answer = String(d.answer);
    const confidence = d.probabilities[answer] ?? Math.max(0, ...Object.values(d.probabilities));
    const ranking = [...d.labels].sort((a, b) => (d.probabilities[b] ?? 0) - (d.probabilities[a] ?? 0) || (a === answer ? -1 : b === answer ? 1 : 0));
    const base: LabeledDecision = { decisionId: d.decisionId, key: d.key, site: d.site, backend: d.backend, confidence, answer, ranking };
    let winners: string[] = [];
    let success: boolean | undefined;
    if (d.site === "prove.search.order") {
      winners = solvedTactics(d.claimId);
      success = d.claimId === undefined ? undefined : winners.includes(answer);
    } else if (d.site === "fleet.cold_start") {
      winners = strategiesOf(d.claimId);
      success = d.claimId === undefined ? undefined : winners.includes(answer);
    } else {
      success = d.claimId === undefined ? undefined : SETTLED.has(status.get(d.claimId) ?? "");
    }
    const ranks = winners.map((w) => ranking.indexOf(w)).filter((r) => r >= 0);
    out.push({ ...base, ...(success !== undefined ? { success } : {}), ...(ranks.length > 0 ? { successRank: Math.min(...ranks) + 1 } : {}) });
  }
  return out;
}

/** The reliability table: per site and backend, the bins of confidence and the expected calibration error (ECE). */
export function reliability(decisions: readonly LabeledDecision[], options: { bins?: number } = {}): SiteReliability[] {
  const nBins = options.bins ?? 10;
  const groups = new Map<string, LabeledDecision[]>();
  for (const d of decisions) {
    const key = `${d.site}\u0000${d.backend}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.entries()]
    .map(([key, list]): SiteReliability => {
      const [site = "", backend = ""] = key.split("\u0000");
      const labeled = list.filter((d) => d.success !== undefined);
      const bins: ReliabilityBin[] = [];
      let ece = 0;
      for (let k = 0; k < nBins; k += 1) {
        const from = k / nBins;
        const to = (k + 1) / nBins;
        const inBin = labeled.filter((d) => (k === nBins - 1 ? d.confidence >= from : d.confidence >= from && d.confidence < to));
        if (inBin.length === 0) continue;
        const meanConfidence = inBin.reduce((s, d) => s + d.confidence, 0) / inBin.length;
        const accuracy = inBin.filter((d) => d.success === true).length / inBin.length;
        bins.push({ from, to, n: inBin.length, meanConfidence, accuracy });
        ece += (inBin.length / labeled.length) * Math.abs(accuracy - meanConfidence);
      }
      const ranked = labeled.flatMap((d) => (d.successRank !== undefined ? [d.successRank] : []));
      return {
        site,
        backend,
        decisions: list.length,
        labeled: labeled.length,
        successes: labeled.filter((d) => d.success === true).length,
        ...(labeled.length > 0 ? { ece } : {}),
        bins,
        ...(ranked.length > 0 ? { rank: { mean: ranked.reduce((a, b) => a + b, 0) / ranked.length, of: ranked.length } } : {}),
      };
    })
    .sort((a, b) => a.site.localeCompare(b.site) || a.backend.localeCompare(b.backend));
}

/**
 * The agreement between two backends on the same questions (plan change J5): of the questions both answered, where the questions are
 * the decisions' keys (a hash of the site, the state and the question), the share they answered alike.
 */
export function agreement(a: readonly LabeledDecision[], b: readonly LabeledDecision[]): Array<{ site: string; both: number; agree: number; share: number }> {
  const bySite = new Map<string, { both: number; agree: number }>();
  const other = new Map(b.map((d) => [`${d.site}\u0000${d.key}`, d]));
  for (const d of a) {
    const match = other.get(`${d.site}\u0000${d.key}`);
    if (match === undefined) continue;
    const row = bySite.get(d.site) ?? { both: 0, agree: 0 };
    row.both += 1;
    if (match.answer === d.answer) row.agree += 1;
    bySite.set(d.site, row);
  }
  return [...bySite.entries()].map(([site, r]) => ({ site, ...r, share: r.both === 0 ? 0 : r.agree / r.both })).sort((x, y) => x.site.localeCompare(y.site));
}
