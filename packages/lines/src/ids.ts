/**
 * The ablation lines of the plan (§6), in the order they are built and measured (§7). The
 * orchestrator calls the hooks of the enabled lines in this order.
 */
export const LINE_ORDER = ["M1", "M10", "M2", "M11", "M12", "M4", "M6", "fleet", "M3", "M7", "M8", "M13", "M14", "M5", "M9"] as const;

export type LineId = (typeof LINE_ORDER)[number];

/** What each line adds (plan §6), for messages and the documentation. */
export const LINE_TITLES: Readonly<Record<LineId, string>> = {
  M1: "canonical identity and shared negative memory",
  M10: "classical battery per subgoal before any model, domain router, ATP and SMT",
  M2: "variant graph and logical propagation",
  M11: "small models and fingerprints: certified refutations, candidate equivalences",
  M12: "saturation kernel: given-clause loop, subsumption, proved-modulo labels",
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
};

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
 * that line and every line before it in `LINE_ORDER`. `M2` is M0 + M1 + M10 + M2.
 */
export function ablationLines(name: AblationName): LineId[] {
  return name === "M0" ? [] : LINE_ORDER.slice(0, LINE_ORDER.indexOf(name) + 1);
}
