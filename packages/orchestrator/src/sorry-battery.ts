import { availableTactics, type HostTactics, suggestion, type TacticSpec } from "@seshat/classical";
import { type HarnessEvent, type Journal, type LeanCheckResult, type LeanChecker, newId, scanRegion, type Submission, type ValidationReport } from "@seshat/core";

/**
 * The classical battery on the `sorry` a prover session leaves (Ruling 40, documentation/classical.md, "The battery on a session's sorry"):
 * `RunConfig.sorryBattery`. After a `lean_check` whose file has no error and still has `sorry`, the harness, with no model call, tries the
 * tactics of line M10 on each `sorry` in turn and puts what closes into the session's working file. Nothing here touches a claim's status:
 * the files are checked through `lean.check` and never through `validate`, so no validation is recorded and no candidate is made.
 */
export interface SorryBatteryConfig {
  /** The most `sorry` tried after a check, in file order. Default `DEFAULT_MAX_SORRIES`. */
  maxSorries?: number;
  /** The seconds each Lean check of the battery may take. Default: the longest limit of a tactic the host has. */
  timeoutSec?: number;
}

export const DEFAULT_MAX_SORRIES = 8;

/** The actor of the battery's tool runs, as line M10's. */
export const SORRY_BATTERY_ACTOR = "line:M10";

/** The kind of the node that records one attempt. */
export const SORRY_BATTERY_KIND = "sorry_battery";

/** What `RunConfig.sorryBattery` fails to be, for `checkConfig`. */
export function checkSorryBattery(config: SorryBatteryConfig): string[] {
  const problems: string[] = [];
  if (config.maxSorries !== undefined && !(Number.isInteger(config.maxSorries) && config.maxSorries >= 1)) problems.push(`sorryBattery.maxSorries must be a whole number of at least 1, got ${config.maxSorries}`);
  if (config.timeoutSec !== undefined && !(config.timeoutSec >= 1)) problems.push(`sorryBattery.timeoutSec must be at least 1 second, got ${config.timeoutSec}`);
  return problems;
}

/** One `sorry` the battery looked at. */
export interface Occurrence {
  region: "aux" | "proof";
  /** The offset of the word in the region's text. */
  index: number;
  /** The line in the region, from 1. */
  line: number;
}

/** What the session is given back: the text for the answer, and the working file when it changed. */
export interface SorryBatteryOutcome {
  text: string;
  submission?: Submission;
}

/** What one attempt records (the data of the node). */
export interface SorryBatteryRecord {
  attemptId?: string;
  tried: number;
  closed: number;
  tactics: Array<{ region: "aux" | "proof"; line: number; tactic: string }>;
  checks: number;
  ms: number;
}

export interface SorryBatteryDeps {
  checker: LeanChecker;
  /** The prover's file for these regions (`Workbench.render`). */
  render: (submission: Submission) => string;
  /** The tactics the host's Lean has beyond the core ones (line M10's `packages`). */
  host: HostTactics;
  config: SorryBatteryConfig;
  /** Records the attempt as a node of the journal. Absent: nothing is recorded. */
  record?: (data: SorryBatteryRecord) => void;
}

const SORRY = /(?<![\p{L}\p{N}_.'!?])sorry(?![\p{L}\p{N}_'!?])/gu;

/** The `sorry` of the two regions outside comments, in file order (AUX, then PROOF). A region whose scan changes its length is left out. */
export function findSorries(submission: Submission): Occurrence[] {
  const found: Occurrence[] = [];
  for (const region of ["aux", "proof"] as const) {
    const text = submission[region];
    const { masked } = scanRegion(text);
    if (masked.length !== text.length) continue;
    for (const m of masked.matchAll(SORRY)) found.push({ region, index: m.index, line: masked.slice(0, m.index).split("\n").length });
  }
  return found;
}

/** The submission with these `sorry` replaced, each by its text. */
export function replaceSorries(submission: Submission, replacements: ReadonlyArray<{ at: Occurrence; text: string }>): Submission {
  const out: Submission = { aux: submission.aux, proof: submission.proof };
  for (const { at, text } of [...replacements].sort((a, b) => b.at.index - a.at.index)) {
    out[at.region] = `${out[at.region].slice(0, at.index)}${text}${out[at.region].slice(at.index + "sorry".length)}`;
  }
  return out;
}

/** The tactics the battery tries: line M10's list, in its order, for what the host has. */
export function batteryTactics(host: HostTactics): TacticSpec[] {
  return availableTactics(host);
}

/** The combinator that tries every tactic in turn, as one tactic. */
export function combinator(tactics: readonly TacticSpec[]): string {
  return `(first | ${tactics.map((t) => t.script).join(" | ")})`;
}

/** Whether a result is a file with no error and `sorries` holes left. */
function clean(result: LeanCheckResult | undefined, sorries: number): result is LeanCheckResult {
  if (result === undefined) return false;
  if (result.status === "timeout" || result.status === "server_error" || result.status === "repl_error" || result.status === "lean_error") return false;
  return !result.messages.some((m) => m.severity === "error") && result.sorries.length === sorries;
}

/**
 * Runs the battery on the `sorry` of a file that Lean checked with no error. Returns undefined when there is nothing to do (an erroring file,
 * no `sorry`, an aborted session). The file's `sorry` are tried one at a time with the others left alone, each replaced by the combinator; a
 * replacement that checks with no error and one `sorry` fewer is kept, and the tactic that did it is found by a second batch of single tactics.
 * The kept ones are applied together and checked once; if that check fails they are applied one by one in file order, each kept if the file
 * still checks.
 */
export async function closeSorries(d: SorryBatteryDeps, submission: Submission, report: ValidationReport, signal?: AbortSignal): Promise<SorryBatteryOutcome | undefined> {
  if (report.leanStatus === undefined || !report.holes || report.sorries.length === 0 || signal?.aborted === true) return undefined;
  if (report.messages.some((m) => m.severity === "error")) return undefined;
  const maxSorries = d.config.maxSorries ?? DEFAULT_MAX_SORRIES;
  const occurrences = findSorries(submission).slice(0, maxSorries);
  if (occurrences.length === 0) return undefined;
  const tactics = batteryTactics(d.host);
  const timeoutSec = d.config.timeoutSec ?? Math.max(10, ...tactics.map((t) => t.timeoutSec));
  const started = performance.now();
  let checks = 0;
  const run = async (files: Array<{ id: string; submission: Submission }>): Promise<LeanCheckResult[]> => {
    if (files.length === 0) return [];
    checks += files.length;
    return await d.checker.check(
      files.map((f) => ({ id: f.id, code: d.render(f.submission) })),
      { timeoutSec, ...(signal !== undefined ? { signal } : {}) },
    );
  };
  const base = report.sorries.length;
  const all = combinator(tactics);

  // Step 1: each `sorry` alone, replaced by the combinator.
  const first = await run(occurrences.map((at, i) => ({ id: `sorry-battery:${i}`, submission: replaceSorries(submission, [{ at, text: all }]) })));
  const closedAlone = occurrences.flatMap((at, i) => (clean(first[i], base - 1) ? [{ at, i }] : []));

  // Step 2: which tactic did it, one file for each (closed `sorry`, tactic).
  const singles = closedAlone.flatMap(({ at, i }) => tactics.map((t) => ({ id: `sorry-battery:${i}:${t.name}`, at, tactic: t, submission: replaceSorries(submission, [{ at, text: t.script }]) })));
  const second = await run(singles);
  const named = closedAlone.map(({ at, i }) => {
    for (const [k, s] of singles.entries()) {
      if (s.at !== at || !clean(second[k], base - 1)) continue;
      const hint = s.tactic.suggests === true ? suggestion(second[k] as LeanCheckResult) : undefined;
      // A suggestion that spans lines does not fit where `sorry` stood: the tactic itself stays.
      return { at, tactic: s.tactic.name, text: hint !== undefined && !hint.includes("\n") ? hint : s.tactic.script };
    }
    // The combinator closed it and no single tactic did alone: it stays as it is.
    void i;
    return { at, tactic: "first", text: all };
  });

  // Step 3: all together, else one by one.
  let kept = named;
  if (named.length > 1) {
    const together = await run([{ id: "sorry-battery:all", submission: replaceSorries(submission, named) }]);
    if (!clean(together[0], base - named.length)) {
      kept = [];
      for (const candidate of named) {
        const trial = [...kept, candidate];
        const result = await run([{ id: `sorry-battery:step:${trial.length}`, submission: replaceSorries(submission, trial) }]);
        if (clean(result[0], base - trial.length)) kept = trial;
      }
    }
  }

  const ms = Math.round(performance.now() - started);
  const tried = occurrences.length;
  const closed = kept.length;
  const closedTactics = kept.map((k) => ({ region: k.at.region, line: k.at.line, tactic: k.tactic }));
  d.record?.({ tried, closed, tactics: closedTactics, checks, ms });
  if (closed === 0) return { text: `The harness tried the classical battery on ${tried} \`sorry\` and closed none.` };
  const next = replaceSorries(submission, kept);
  const lines = kept.map((k) => `${k.at.region === "aux" ? "AUX" : "PROOF"} line ${k.at.line}: ${k.tactic}`);
  return {
    text: [
      `The harness closed ${closed} of ${tried} \`sorry\` with the classical battery (no model call): ${lines.join("; ")}. The file now reads as below; continue from it.`,
      "",
      "AUX region:",
      fence(next.aux),
      "PROOF region:",
      fence(next.proof),
    ].join("\n"),
    submission: next,
  };
}

function fence(text: string): string {
  return `\`\`\`lean\n${text}\n\`\`\``;
}

/** Writes an attempt's record as a node of the journal, as the pre-flight records its evidence. */
export function recordSorryBattery(journal: Journal, claimId: string, attemptId: string | undefined, actor: string): (data: SorryBatteryRecord) => void {
  return (data) => {
    journal.emit("node.recorded", { nodeId: newId("nod"), kind: SORRY_BATTERY_KIND, claimId, data: { ...(attemptId !== undefined ? { attemptId } : {}), ...data } as never }, actor);
  };
}

/** The run's tally: the `sorry` the battery tried and closed, over every attempt of the journal; undefined when the setting was off and nothing was recorded. */
export interface SorryBatteryTally {
  attempts: number;
  tried: number;
  closed: number;
}

export function sorryBatteryTally(events: readonly HarnessEvent[]): SorryBatteryTally | undefined {
  const started = events.find((e) => e.type === "run.started");
  const on = started?.type === "run.started" && typeof (started.data.config as { sorryBattery?: unknown } | null)?.sorryBattery === "object";
  const tally: SorryBatteryTally = { attempts: 0, tried: 0, closed: 0 };
  for (const e of events) {
    if (e.type !== "node.recorded" || e.data.kind !== SORRY_BATTERY_KIND) continue;
    const data = e.data.data as { tried?: unknown; closed?: unknown } | null;
    tally.attempts += 1;
    if (typeof data?.tried === "number") tally.tried += data.tried;
    if (typeof data?.closed === "number") tally.closed += data.closed;
  }
  return on || tally.attempts > 0 ? tally : undefined;
}

export function renderSorryBatteryTally(t: SorryBatteryTally): string {
  return `sorry closed by the harness: ${t.closed} of ${t.tried} (${t.attempts} battery run(s), no model call; a closed sorry changes the session's file and no claim's status).`;
}
