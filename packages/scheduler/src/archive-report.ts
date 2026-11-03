import { type HarnessEvent, type Json, mergePatch } from "@seshat/core";
import { SCHEMA_KIND } from "@seshat/library";
import { entropy } from "./archive.ts";
import { type ArchiveSnapshot, type HintData, M15_ARCHIVE_KIND, M15_HINT_KIND, M15_PICK_KIND, NEW_CELL, type PickData } from "./m15.ts";

/** Sessions of one arm of a draw, with how many were accepted and how many reused the schema's shape. */
export interface HintArm {
  hints: number;
  sessions: number;
  accepted: number;
  reused: number;
}

/**
 * What line M15 measured in a run (documentation/archive.md, "Measured"), from its journal alone: the archive of each problem at its end,
 * how the picks of a cell fared, the schemas, and the hints by arm of the retrieval and by the draw. Undefined for a run in which the line
 * recorded nothing.
 */
export interface ArchiveReport {
  /** Problems whose archive held a decomposition Lean checked, the cells they filled, and the mean of the best fitness of each. */
  problems: number;
  cells: number;
  meanBestRho: number;
  /** The decompositions by the family of their main proof (the mechanisms), and their entropy in bits. */
  families: Record<string, number>;
  entropy: number;
  /** The picks that came to an end, for a cell of the archive and for the fresh arm. */
  picks: { cell: { picks: number; improved: number }; fresh: { picks: number; improved: number }; pending: number };
  schemas: { made: number; active: number; superseded: number; inactive: number };
  /** The hints of sessions that started, by retrieval arm, and for each the sessions that were shown the schema and the ones denied it. */
  hints: Array<{ arm: "match" | "random"; shown: HintArm; withheld: HintArm }>;
}

export function archiveReport(events: readonly HarnessEvent[]): ArchiveReport | undefined {
  const nodes = new Map<string, { kind: string; data: Json }>();
  const outcomes = new Map<string, string>();
  const started = new Set<string>();
  for (const event of events) {
    if (event.type === "node.recorded") nodes.set(event.data.nodeId, { kind: event.data.kind, data: event.data.data });
    else if (event.type === "node.updated") {
      const node = nodes.get(event.data.nodeId);
      if (node !== undefined) node.data = mergePatch(node.data, event.data.patch);
    } else if (event.type === "attempt.started") started.add(event.data.attemptId);
    else if (event.type === "attempt.finished") outcomes.set(event.data.attemptId, event.data.outcome);
  }
  const of = <T>(kind: string): T[] => [...nodes.values()].filter((n) => n.kind === kind).map((n) => n.data as unknown as T);
  const snapshots = of<ArchiveSnapshot>(M15_ARCHIVE_KIND);
  const picks = of<PickData>(M15_PICK_KIND);
  const hints = of<HintData>(M15_HINT_KIND).filter((h) => started.has(h.attemptId));
  const schemas = of<{ state: string }>(SCHEMA_KIND);
  if (snapshots.length === 0 && picks.length === 0 && hints.length === 0 && schemas.length === 0) return undefined;

  const families: Record<string, number> = {};
  const labels: string[] = [];
  for (const s of snapshots) {
    for (const [f, n] of Object.entries(s.families)) {
      families[f] = (families[f] ?? 0) + n;
      for (let k = 0; k < n; k += 1) labels.push(f);
    }
  }
  const best = snapshots.map((s) => Math.max(0, ...s.cells.map((c) => c.rho)));
  const arm = (fresh: boolean) => {
    const done = picks.filter((p) => (p.cell === NEW_CELL) === fresh && (p.outcome === "improved" || p.outcome === "not_improved"));
    return { picks: done.length, improved: done.filter((p) => p.outcome === "improved").length };
  };
  const hintArms = (["match", "random"] as const).flatMap((name) => {
    const mine = hints.filter((h) => h.arm === name);
    if (mine.length === 0) return [];
    const tally = (shown: boolean): HintArm => {
      const these = mine.filter((h) => h.shown === shown);
      return {
        hints: these.length,
        sessions: these.filter((h) => outcomes.get(h.attemptId) === "valid" || outcomes.get(h.attemptId) === "invalid").length,
        accepted: these.filter((h) => outcomes.get(h.attemptId) === "valid").length,
        reused: these.filter((h) => h.reused === true).length,
      };
    };
    return [{ arm: name, shown: tally(true), withheld: tally(false) }];
  });
  const count = (state: string) => schemas.filter((s) => s.state === state).length;
  return {
    problems: snapshots.length,
    cells: snapshots.reduce((n, s) => n + s.cells.length, 0),
    meanBestRho: best.length === 0 ? 0 : best.reduce((a, b) => a + b, 0) / best.length,
    families,
    entropy: entropy(labels),
    picks: { cell: arm(false), fresh: arm(true), pending: picks.filter((p) => p.outcome === undefined).length },
    schemas: { made: schemas.length, active: count("active"), superseded: count("superseded"), inactive: count("inactive") },
    hints: hintArms,
  };
}

const ratio = (a: number, b: number): string => (b === 0 ? "none" : `${a}/${b}`);

/** The paragraph of a run report (`report.md`). */
export function renderArchiveReport(r: ArchiveReport): string {
  const families = Object.entries(r.families).sort(([a], [b]) => a.localeCompare(b)).map(([f, n]) => `${f} ${n}`).join(", ");
  const parts = [
    `Archive (line M15): ${r.problems} problem(s) with a decomposition Lean checked, ${r.cells} cell(s) filled, mean best fitness ${r.meanBestRho.toFixed(2)}` +
      (families === "" ? "." : `; mechanisms ${families} (entropy ${r.entropy.toFixed(2)} bits).`),
    `Picks that came to an end improved on the elite: ${ratio(r.picks.cell.improved, r.picks.cell.picks)} in a cell, ${ratio(r.picks.fresh.improved, r.picks.fresh.picks)} on the fresh arm` +
      (r.picks.pending > 0 ? ` (${r.picks.pending} not settled).` : "."),
    `Schemas: ${r.schemas.made} made (${r.schemas.active} active, ${r.schemas.superseded} generalized, ${r.schemas.inactive} retired by their effect).`,
    ...r.hints.map(
      (h) =>
        `Schema hints, ${h.arm} retrieval: accepted proofs ${ratio(h.shown.accepted, h.shown.sessions)} with the hint shown, ${ratio(h.withheld.accepted, h.withheld.sessions)} with it withheld; ` +
        `the sketch had the schema's shape in ${ratio(h.shown.reused, h.shown.hints)} sessions shown it and ${ratio(h.withheld.reused, h.withheld.hints)} denied it.`,
    ),
  ];
  return parts.join(" ");
}
