import type { AblationResult, ArmResult } from "./ablation.ts";
import type { CacheStat } from "./cache-report.ts";
import type { Share } from "./measures.ts";
import { labelLines, type RunLabel } from "./run-label.ts";
import { agreement } from "./reliability.ts";

const money = (usd: number | undefined, digits = 3): string => (usd === undefined ? "none" : `$${usd.toFixed(digits)}`);
const pct = (x: number | undefined): string => (x === undefined ? "n/a" : `${(x * 100).toFixed(0)}%`);
const num = (x: number | undefined, digits = 0): string => (x === undefined ? "none" : x.toFixed(digits));
const frac = (s: Share): string => (s.total === 0 ? "0/0" : `${s.count}/${s.total}`);

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

const kinds = (byKind: Record<string, number>): string => {
  const entries = Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "" : ` (${entries.map(([k, n]) => `${k} ${n}`).join(", ")})`;
};

/** The comparison table of an ablation as markdown: the plan's measurements, one row per configuration (documentation/ablate.md). */
export function renderAblation(result: AblationResult): string {
  const arms = result.arms;
  const out: string[] = [
    "# Ablation",
    "",
    ...labelLines(result.label),
    `Bench ${result.benchId}; model ${result.model}; ${result.problems.length} problem(s)${result.buildProblems !== undefined ? ` measured on a memory built on ${result.buildProblems.length} others` : ""}; ` +
      `${result.provers} prover(s) of at most ${result.sessions} session(s) and ${money(result.budget.problemUsd, 2)} per problem in every configuration. `,
    "",
    ...table(
      ["Configuration", "Solved", "Certified", "Per solve ($)", "Tokens per solve", "Redundant", "Mean context", "Tool defs", "Memory", "Subgoals w/o model", "Conjectures w/o model", "CPU ms"],
      arms.map((a) => {
        const m = a.measures;
        return [
          `${a.arm.name}${a.stopped !== undefined ? ` (stopped: ${a.stopped})` : ""}`,
          `${m.solved}/${m.problems}`,
          String(m.certified),
          money(m.usdPerSolve),
          num(m.tokensPerSolve),
          m.redundancy === undefined ? "n/a" : pct(m.redundancy.share),
          num(m.meanContextTokens),
          num(m.toolDefinitionTokens),
          `${pct(m.memory.share)}${kinds(m.memory.byKind)}`,
          frac(m.modelFree.subgoals),
          frac(m.modelFree.conjectures),
          num(m.modelFree.cpuMs),
        ];
      }),
    ),
    "",
    "Solved: problems with a Lean-checked proof, certified or a candidate; the dollars and tokens per solve divide by it. A configuration that is set against another is read below.",
    "",
    "## Does it beat the one before it",
    "",
    ...arms.flatMap((a) =>
      a.comparison === undefined
        ? []
        : [`- ${a.arm.name} against ${a.comparison.against}: ${a.comparison.verdict}: ${a.comparison.reason}. Paired over ${a.comparison.common} problems: solved only by ${a.arm.name} ${a.comparison.onlyThis.length}, only by ${a.comparison.against} ${a.comparison.onlyThat.length}.`],
    ),
    "",
    "## Diversity, reuse and novelty",
    "",
    ...table(
      ["Configuration", "Strategies", "Sources", "Entropy (bits)", "Through an inductive hypothesis", "Reuse a lemma or schema", "Budget on new strategies"],
      arms.map((a) => {
        const m = a.measures;
        return [a.arm.name, String(m.mechanisms.strategies), String(m.mechanisms.sources), num(m.mechanisms.entropyBits, 2), frac(m.inductive), frac(m.reuse), pct(m.novelStrategy.share)];
      }),
    ),
    "",
    ...difficulty(result),
    ...spendBySite(arms),
    ...cache(arms),
    ...gate(arms),
    ...decisions(arms),
    ...agreements(arms),
    ...extras(arms),
  ];
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function difficulty(result: AblationResult): string[] {
  const arms = result.arms;
  if (result.difficultyBasis === undefined) {
    return ["## Difficulty", "", "Not split: the table has no arm that no comparison depends on (M0) and no pilot run (`--pilot RUN_DIR`). Splitting by the outcome of an arm under comparison would make that arm solve every easy problem and no hard one by construction.", ""];
  }
  return [
    "## Difficulty",
    "",
    `Easy: the problems ${result.difficultyBasis} solved; hard: the others. The basis is outside the comparison, so a split cannot favour an arm by selection${result.difficultyBasis === "M0" ? "; M0 has no row here because its split is by construction" : ""}. One run per arm and few problems: read the counts, not the dollars per solve, of a tier with a handful of problems.`,
    "",
    ...table(
      ["Configuration", "Easy solved", "Easy $ per solve", "Hard solved", "Hard $ per solve"],
      arms.flatMap((a) => (a.difficulty === undefined ? [] : [[a.arm.name, `${a.difficulty.easy.solved}/${a.difficulty.easy.problems}`, money(a.difficulty.easy.usdPerSolve), `${a.difficulty.hard.solved}/${a.difficulty.hard.problems}`, money(a.difficulty.hard.usdPerSolve)]])),
    ),
    "",
  ];
}

function spendBySite(arms: readonly ArmResult[]): string[] {
  const sites = [...new Set(arms.flatMap((a) => a.measures.sites.map((s) => s.site)))].sort();
  if (sites.length === 0) return [];
  return [
    "## Spend by site",
    "",
    "Dollars, and the share of the configuration's total, per place where a model is called.",
    "",
    ...table(["Configuration", ...sites], arms.map((a) => [a.arm.name, ...sites.map((site) => { const s = a.measures.sites.find((x) => x.site === site); return s === undefined ? "-" : `${money(s.usd)} (${pct(s.share)})`; })])),
    "",
  ];
}

function cache(arms: readonly ArmResult[]): string[] {
  const rows: string[][] = [];
  const row = (arm: string, scope: string, s: CacheStat) => rows.push([arm, scope, String(s.calls), pct(s.ratio), money(s.savedUsd)]);
  for (const a of arms) {
    const c = a.measures.cache;
    if (c === undefined) continue;
    row(a.arm.name, "all", c.total);
    for (const [line, s] of Object.entries(c.byLine)) row(a.arm.name, `line ${line}`, s);
    for (const [rung, s] of Object.entries(c.byRung ?? {})) row(a.arm.name, `rung ${rung}`, s);
  }
  if (rows.length === 0) return [];
  return [
    "## Prompt cache",
    "",
    "The share of input read from the provider's cache and the dollars it saved, per line and per rung. Checked on the first real run before any conclusion about the packet modes is used.",
    "",
    ...table(["Configuration", "Scope", "Responses", "Cache ratio", "Saved"], rows),
    "",
  ];
}

function gate(arms: readonly ArmResult[]): string[] {
  const rows = arms.flatMap((a) => {
    const g = a.measures.gate;
    if (g === undefined) return [];
    const launched = g.bySite.reduce((n, s) => n + s.launched, 0);
    const skipped = g.bySite.reduce((n, s) => n + s.skipped, 0);
    return [[a.arm.name, String(g.answers), String(g.probes), String(g.widened), String(g.stoppedAtProbe), String(launched), String(skipped), `${money(g.avoidedUsd)} (estimate)`, `${g.decisions.count} (${money(g.decisions.usd)})`]];
  });
  if (rows.length === 0) return [];
  return [
    "## Budget gate",
    "",
    "What the gate answered in each configuration that had one, from the journal. The avoided dollars are the gate's estimate of what the skipped launches would have cost, not a measurement: the table's cost per solve above is the measure.",
    "",
    ...table(["Configuration", "Answers", "Probes", "Widened", "Stopped at probe", "Launched", "Skipped", "Avoided", "Questions to decide"], rows),
    "",
  ];
}

function decisions(arms: readonly ArmResult[]): string[] {
  const rows = arms.flatMap((a) =>
    a.reliability.map((r) => [
      a.arm.name,
      r.site,
      r.backend,
      `${r.labeled}/${r.decisions}`,
      r.labeled === 0 ? "n/a" : pct(r.successes / r.labeled),
      r.ece === undefined ? "n/a" : r.ece.toFixed(3),
      r.rank === undefined ? "n/a" : `${r.rank.mean.toFixed(2)} (${r.rank.of})`,
      r.bins.map((b) => `${b.from.toFixed(1)}-${b.to.toFixed(1)}: ${b.n} at ${pct(b.accuracy)}`).join("; ") || "none",
    ]),
  );
  if (rows.length === 0) return [];
  return [
    "## Reliability of decisions",
    "",
    "A decision is labeled by its Lean outcome (the answer led to a proved subgoal). ECE is the weighted gap between the probability of the answer and how often it was right; no threshold on a probability is allowed until a site has a curve. Rank: the mean place, in the decision's order, of the candidate that succeeded.",
    "",
    ...table(["Configuration", "Site", "Backend", "Labeled", "Right", "ECE", "Rank", "Bins (probability: decisions at accuracy)"], rows),
    "",
  ];
}

function extras(arms: readonly ArmResult[]): string[] {
  const out: string[] = [];
  const sourced = arms.filter((a) => Object.keys(a.measures.proofsBySource).length > 0);
  if (sourced.length > 0) {
    out.push("## Proofs by source of declaration", "", ...table(["Configuration", "Proofs using a declaration of"], sourced.map((a) => [a.arm.name, Object.entries(a.measures.proofsBySource).sort(([x], [y]) => x.localeCompare(y)).map(([k, n]) => `${k} ${n}`).join(", ")])), "");
  }
  const lessons = arms.filter((a) => a.measures.lessons !== undefined);
  if (lessons.length > 0) {
    out.push("## Lesson set", "", ...table(["Configuration", "Lessons", "Active", "Deactivated", "Solved"], lessons.map((a) => { const l = a.measures.lessons as NonNullable<typeof a.measures.lessons>; return [a.arm.name, String(l.total), String(l.active), String(l.deactivated), `${a.measures.solved}/${a.measures.problems}`]; })), "");
  }
  const cegis = arms.filter((a) => a.measures.cegis !== undefined);
  if (cegis.length > 0) {
    out.push(
      "## Counterexample set",
      "",
      "Candidates dropped by the set before anything was spent on them, and the tokens that saves against a baseline without the set (an estimate, not calibrated against a model).",
      "",
      ...table(["Configuration", "Dropped", "Tokens saved", "By line", "By source"], cegis.map((a) => { const c = a.measures.cegis as NonNullable<typeof a.measures.cegis>; return [a.arm.name, String(c.dropped), String(c.tokensSaved), Object.entries(c.byLine).map(([k, n]) => `${k} ${n}`).join(", "), Object.entries(c.bySource).map(([k, n]) => `${k} ${n}`).join(", ")]; })),
      "",
    );
  }
  const built = arms.filter((a) => a.build !== undefined);
  if (built.length > 0) {
    out.push(
      "## Memory built on one part and measured on another",
      "",
      "The columns above charge an arm only for its measure run. The build run is paid for too: the last column is the arm's whole bill, and a memory line that wins on the measure part but not on the total has not paid for itself.",
      "",
      ...table(["Configuration", "Build part solved", "Measure part solved", "Build $", "Measure $", "Total $ per solve (build and measure)"], built.map((a) => { const b = (a.build as NonNullable<typeof a.build>).measures; return [a.arm.name, `${b.solved}/${b.problems}`, `${a.measures.solved}/${a.measures.problems}`, money(b.usd), money(a.measures.usd), money(a.measures.solved + b.solved === 0 ? undefined : (a.measures.usd + b.usd) / (a.measures.solved + b.solved))]; })),
      "",
    );
  }
  return out;
}

/** Plan change J5, line D1: where an arm asks another backend, the share of questions it answered as the arm it is set against did. */
function agreements(arms: readonly ArmResult[]): string[] {
  const rows: string[][] = [];
  arms.forEach((a, i) => {
    if (a.arm.decide === undefined) return;
    const other = a.arm.versus !== undefined ? arms.find((x) => x.arm.name === a.arm.versus) : arms[i - 1];
    if (other === undefined) return;
    for (const r of agreement(a.decisions, other.decisions)) rows.push([a.arm.name, other.arm.name, r.site, String(r.both), pct(r.share)]);
  });
  if (rows.length === 0) return [];
  return [
    "## Agreement between backends",
    "",
    "Of the questions both configurations answered (same site, same state, same question), the share answered alike. Not run against a real Jev: with a faux Jev this shows the plumbing, not the backend.",
    "",
    ...table(["Configuration", "Against", "Site", "Questions both answered", "Agree"], rows),
    "",
  ];
}

/** The cost-to-first-success curves for K provers in parallel (plan change PE4), as a markdown table, with the K the journal cannot give. */
export function renderChunks(title: string, analysis: import("./chunks.ts").ChunkAnalysis, label?: RunLabel): string {
  const rows = analysis.curves.map((c) => [
    String(c.k),
    `${c.solved}/${c.problems}`,
    money(c.meanUsdToSuccess),
    money(c.usdPerSolve),
    c.budgetShare === undefined ? "n/a" : `${pct(c.budgetShare.median)} / ${pct(c.budgetShare.p80)}`,
  ]);
  return `${[
    `# Cost to first success: ${title}`,
    "",
    ...(label !== undefined ? labelLines(label) : []),
    "K provers run side by side on the attempts of one prover; a round is paid for in full. The shares are of the problem's budget; the ladder's fractions are read from them on real runs.",
    "",
    ...table(["K", "Solved", "Mean $ to first success", "$ per solve", "Budget share (median / p80)"], rows),
    "",
    ...(analysis.refused.length > 0
      ? [`Not given: ${analysis.refused.map((r) => `K = ${r.k}`).join(", ")}. ${analysis.refused[0]?.reason}. The curves for K above 1 need a measurement run with a fixed number of attempts that does not stop at the first success; a journal of the normal loop gives K = 1 only.`, ""]
      : []),
  ].join("\n")}\n`;
}
