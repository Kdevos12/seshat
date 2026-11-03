/**
 * What a saved result says about itself (documentation/ablate.md, "What a saved file says"): whether the model was the faux provider, and
 * what has not been run. The label is written into `ablation.json`, `probe.json` and every rendering, so that a table copied out of the
 * terminal or a directory cannot be taken for a measurement it is not.
 */
export interface RunLabel {
  /** The model was pi-ai's faux provider: every number is the simulation's. */
  simulatedModel: boolean;
  /** What a real run has still to check, one sentence each. */
  notRun: string[];
}

/** What every table is silent about otherwise. */
export const STANDING_NOT_RUN: readonly string[] = [
  "The cache ratio and the dollars saved are the provider's accounting as the run recorded it; they are checked against a real provider on the first real run (PD1 item 2) before any conclusion about the packet modes is drawn.",
  "A run on a simulated Lean says nothing of how long a real check takes or what it answers; the journal of such a run looks like a real one.",
];

export function runLabel(model: string, notRun: readonly string[] = []): RunLabel {
  return { simulatedModel: /^faux(\/|$)/.test(model), notRun: [...notRun, ...STANDING_NOT_RUN] };
}

/** The label as markdown lines, to put at the head of a rendering. */
export function labelLines(label: RunLabel): string[] {
  return [
    ...(label.simulatedModel ? ["> SIMULATED: the model is the faux provider. Every number below is the simulation's, not a measurement of a model.", ""] : []),
    "> Not run, or not checked:",
    ...label.notRun.map((line) => `> - ${line}`),
    "",
  ];
}
