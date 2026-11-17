import { type HarnessEvent, Projection } from "@seshat/core";
import { type Frontier, frontier, type FrontierKind, type FrontierOptions, frontierMarkdown, FRONTIER_KINDS, MemoryStore } from "@seshat/memory";

/**
 * The verified frontier in a report (`RunConfig.frontier`, documentation/frontier.md): read from the projection of the journal's events, with
 * no model call. It is on only when the run's configuration, as `run.started` recorded it, has `frontier.show`.
 */
export interface FrontierConfig {
  show?: boolean;
  weights?: Partial<Record<FrontierKind, number>>;
}

/** What `RunConfig.frontier` allows: `show` a boolean, `weights` an object of non-negative numbers by kind. Problems in words; empty: fine. */
export function frontierConfigProblems(config: unknown): string[] {
  if (config === undefined) return [];
  if (typeof config !== "object" || config === null || Array.isArray(config)) return ["frontier must be an object: { show?: boolean, weights?: { KIND: number } }"];
  const c = config as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(c)) if (key !== "show" && key !== "weights") problems.push(`frontier.${key} is not a setting (show, weights)`);
  if (c.show !== undefined && typeof c.show !== "boolean") problems.push("frontier.show must be true or false");
  if (c.weights !== undefined) {
    if (typeof c.weights !== "object" || c.weights === null || Array.isArray(c.weights)) problems.push("frontier.weights must be an object of numbers by kind");
    else {
      for (const [kind, w] of Object.entries(c.weights)) {
        if (!(FRONTIER_KINDS as readonly string[]).includes(kind)) problems.push(`frontier.weights.${kind}: the kinds are ${FRONTIER_KINDS.join(", ")}`);
        else if (typeof w !== "number" || !Number.isFinite(w) || w < 0) problems.push(`frontier.weights.${kind} must be a number of 0 or more`);
      }
    }
  }
  return problems;
}

/** The frontier options of a recorded run configuration when the frontier is shown; undefined when it is off. */
export function frontierOptionsOf(config: unknown): FrontierOptions | undefined {
  const f = (config as { frontier?: FrontierConfig } | null | undefined)?.frontier;
  if (f === undefined || f === null || typeof f !== "object" || f.show !== true) return undefined;
  return f.weights !== undefined ? { weights: f.weights } : {};
}

/** The frontier options of a run's events (its `run.started` configuration), when it shows the frontier. */
export function frontierOptionsOfEvents(events: readonly HarnessEvent[]): FrontierOptions | undefined {
  const started = events.find((e) => e.type === "run.started");
  return started?.type === "run.started" ? frontierOptionsOf(started.data.config) : undefined;
}

export interface ProblemFrontier {
  problemId: string;
  claimId: string;
  frontier: Frontier;
}

/** The frontier of each problem of a projection that has one entry at least; none when the frontier is off. */
export function frontiersOf(p: Projection, options: FrontierOptions | undefined): ProblemFrontier[] {
  if (options === undefined) return [];
  const store = MemoryStore.readOnly(p);
  return p.problems().flatMap((row) => {
    const f = frontier(store, row.claim_id, options);
    return f.entries.length === 0 ? [] : [{ problemId: row.problem_id, claimId: row.claim_id, frontier: f }];
  });
}

/** The section "Established so far" of a report, for one problem or several; empty when there is nothing. */
export function renderFrontiers(list: readonly ProblemFrontier[], level = 2): string[] {
  if (list.length === 0) return [];
  const hashes = "#".repeat(level);
  const out: string[] = [`${hashes} Established so far`];
  for (const item of list) out.push("", `${"#".repeat(level + 1)} ${item.problemId}`, "", ...frontierMarkdown(item.frontier, { heading: null }).trimEnd().split("\n"));
  return out;
}

/** The frontiers of a run's events, when its recorded configuration shows them: a projection built from the events, then closed. */
export function frontiersOfEvents(events: readonly HarnessEvent[]): ProblemFrontier[] {
  const options = frontierOptionsOfEvents(events);
  if (options === undefined) return [];
  const p = Projection.inMemory();
  try {
    for (const event of events) p.apply(event);
    return frontiersOf(p, options);
  } finally {
    p.close();
  }
}
