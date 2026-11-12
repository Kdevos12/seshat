import type { HarnessEvent } from "@seshat/core";

/**
 * The budget gate in the report (documentation/scheduler.md, "The budget gate"; PB4): what it launched, what it skipped and
 * what those skips would have cost, read from the journal alone. The dollars of a skip are the gate's estimate at the moment
 * (the mean of the sessions already paid, or a first guess), never money that was spent or measured: they are marked as an
 * estimate wherever they are shown, and what the first real run measures is the ablation's (`harness ablate --experiment gate`).
 */
export interface GateSiteStat {
  site: string;
  /** Launches the gate allowed (a wave's probe and widening count as launches). */
  launched: number;
  skipped: number;
  /** Of the launches, the ones the exploration floor let through over the threshold, and their estimated price. */
  explored: number;
  exploredUsd: number;
  /** Of the answers, the ones `decide` gave where the rule had no numbers. */
  decided: number;
  /** The estimated price of the skips. */
  avoidedUsd: number;
}

export interface GateReport {
  answers: number;
  bySite: GateSiteStat[];
  probes: number;
  /** Probes cut by their cap that ran their one extension (`probeExtend`); absent when none did. */
  probeExtensions?: number;
  widened: number;
  /** Problems that stopped at their probe: no Lean progress, and the floor did not widen them. */
  stoppedAtProbe: number;
  /** Problems the memory had certified under the same environment, and that were not launched again. */
  certifiedEarlier: number;
  avoidedUsd: number;
  /** What the questions to `decide` cost (`budget.wave`, `budget.line`), booked in the spend by site too. */
  decisions: { count: number; usd: number };
}

const SITES = ["wave", "session", "task", "judge"] as const;

/** The gate's answers in a journal, or undefined when it answered nothing. */
export function gateReport(events: readonly HarnessEvent[]): GateReport | undefined {
  const stats = new Map<string, GateSiteStat>(SITES.map((site) => [site, { site, launched: 0, skipped: 0, explored: 0, exploredUsd: 0, decided: 0, avoidedUsd: 0 }]));
  let answers = 0;
  let probes = 0;
  let probeExtensions = 0;
  const probed = new Set<string>();
  let widened = 0;
  let stoppedAtProbe = 0;
  let certifiedEarlier = 0;
  const decisions = { count: 0, usd: 0 };
  for (const event of events) {
    if (event.type === "decision.made" && event.data.site.startsWith("budget.")) {
      decisions.count += 1;
      decisions.usd += event.data.costUsd;
      continue;
    }
    if (event.type !== "budget.gated") continue;
    const d = event.data;
    answers += 1;
    // A second probe row of a problem is its one extension (`probeExtend`): counted apart, not as another launch.
    if (d.action === "probe") {
      if (probed.has(d.problemId)) {
        probeExtensions += 1;
        continue;
      }
      probed.add(d.problemId);
    }
    const stat = stats.get(d.site) as GateSiteStat;
    if (d.by === "decide") stat.decided += 1;
    if (d.action === "skip") {
      stat.skipped += 1;
      stat.avoidedUsd += d.estimateUsd;
      if (d.by === "memory") certifiedEarlier += 1;
      else if (d.by === "progress") stoppedAtProbe += 1;
    } else {
      stat.launched += 1;
      if (d.exploration) {
        stat.explored += 1;
        stat.exploredUsd += d.estimateUsd;
      }
      if (d.action === "probe") probes += 1;
      if (d.action === "widen") widened += 1;
    }
  }
  if (answers === 0) return undefined;
  const bySite = [...stats.values()].filter((s) => s.launched + s.skipped > 0);
  return { answers, bySite, probes, ...(probeExtensions > 0 ? { probeExtensions } : {}), widened, stoppedAtProbe, certifiedEarlier, avoidedUsd: bySite.reduce((sum, s) => sum + s.avoidedUsd, 0), decisions };
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** The avoided-spend table and its paragraph, for `renderRunReport`. */
export function renderGateReport(g: GateReport): string[] {
  return [
    `Budget gate: ${g.answers} answer(s). Probe first: ${g.probes} problem(s) probed, ${g.widened} widened after Lean progress (or by the exploration floor), ${g.stoppedAtProbe} stopped at the probe` +
      `${g.probeExtensions !== undefined ? `; ${g.probeExtensions} probe(s) cut by their cap ran one extension` : ""}` +
      `${g.certifiedEarlier > 0 ? `; ${g.certifiedEarlier} not launched because the memory had certified them under the same environment` : ""}. ` +
      `Avoided spend: ${money(g.avoidedUsd)}, the gate's estimate of what the skipped launches would have cost (an estimate from the sessions already paid, not a measurement; the ablation measures cost to first success).` +
      `${g.decisions.count > 0 ? ` ${g.decisions.count} question(s) to decide at budget.wave and budget.line cost ${money(g.decisions.usd)}.` : ""}`,
    "",
    "| Site | Launched | Skipped | Let through by the floor | Decided by decide | Avoided (estimate) |",
    "|---|---|---|---|---|---|",
    ...g.bySite.map((s) => `| ${s.site} | ${s.launched} | ${s.skipped} | ${s.explored} (${money(s.exploredUsd)}) | ${s.decided} | ${money(s.avoidedUsd)} |`),
    "",
  ];
}
