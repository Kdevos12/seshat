/**
 * The ablation lines of the plan (§6), in the order they are built and measured (§7). The
 * orchestrator calls the hooks of the enabled lines in this order.
 */
export const LINE_ORDER = ["M1", "M10", "M2", "M11", "M12", "M18", "M4", "M6", "fleet", "M3", "M7", "M8", "M13", "M14", "M5", "M9", "M17"] as const;

export type LineId = (typeof LINE_ORDER)[number];

/** What each line adds (plan §6), for messages and the documentation. */
export const LINE_TITLES: Readonly<Record<LineId, string>> = {
  M1: "canonical identity and shared negative memory",
  M10: "classical battery per subgoal before any model, domain router, ATP and SMT",
  M2: "variant graph and logical propagation",
  M11: "small models and fingerprints: certified refutations, candidate equivalences",
  M12: "saturation kernel: given-clause loop, subsumption, proved-modulo labels",
  M18: "curriculum of variants: special cases and weakenings of a hard problem, solved first with a capped share of its budget (rung 1)",
  M4: "context compiler",
  M6: "guards against hallucination, and drift detectors",
  fleet: "fleet policy: Thompson sampling on verdicts",
  M3: "growing lemma library",
  M7: "abductive engine, with direct reranking by a model",
  M8: "inductive engine",
  M13: "theory exploration and classical conjecturing",
  M14: "typed repairs and Lakatos-style repair",
  M5: "lessons with counters",
  M9: "reranking from our own labels, without training",
  M17: "extended Lean environment: the run's Lean has more packages than the bench's",
};

/**
 * The lines the project suspended: they stay in `LINE_ORDER` and in the plan's notes, but are not
 * built, a run refuses them, and the cumulative configs leave them out. M7 and M9, the abductive
 * engine and its reranking, were suspended on 2026-10-20: semantic jumps found by deriving an
 * expression through the variant graph do the same structural work, more accurately in practice.
 */
export const SUSPENDED_LINES: ReadonlySet<LineId> = new Set<LineId>(["M7", "M9"]);

export function isLineId(value: unknown): value is LineId {
  return typeof value === "string" && (LINE_ORDER as readonly string[]).includes(value);
}

/** A cumulative ablation config: `M0`, the baseline, or the config that ends with a line. */
export type AblationName = "M0" | LineId;

export function isAblationName(value: unknown): value is AblationName {
  return value === "M0" || isLineId(value);
}

/**
 * The lines a cumulative config enables (plan §6, in §7's order): none for `M0`, and for a line,
 * that line and every line before it in `LINE_ORDER` but the suspended ones. `M2` is M0 + M1 + M10
 * + M2. A suspended line is kept in its own config, so that a run of it stops and says why.
 */
export function ablationLines(name: AblationName): LineId[] {
  if (name === "M0") return [];
  return LINE_ORDER.slice(0, LINE_ORDER.indexOf(name) + 1).filter((id) => id === name || !SUSPENDED_LINES.has(id));
}
