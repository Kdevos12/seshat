import { SKETCH_POLICY, structuralCheck, type Submission } from "@seshat/core";
import { foreignBreak, isMarker } from "./layout.ts";

/** A refusal before anything is sent to the server: the reasons, one per line. */
export class RefusedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Refused before Lean ran; nothing was asked:\n${reasons.map((r) => `- ${r}`).join("\n")}`);
    this.reasons = reasons;
  }
}

/**
 * The checks that `lean_check` makes before Lean runs, on the regions a prover wants a file built
 * from: no marker line inside a region, and the structural check of the sketch policy (no shortcut
 * to a proof, no code that runs while Lean elaborates, only `aux_` declarations in AUX). The
 * language server elaborates what it is given, so what `lean_check` refuses is refused here too.
 * One more check is the server's own: it splits lines at characters that Lean does not, so that
 * text which this screen reads as a comment is code in the documents the server builds.
 */
export function screenRegions(regions: Submission): string[] {
  const reasons: string[] = [];
  for (const [region, text] of Object.entries(regions)) {
    for (const line of text.split("\n")) {
      if (isMarker(line)) reasons.push(`${region}: remove the line '${line.trim()}': pass the regions without their marker lines`);
    }
    const stray = foreignBreak(text);
    if (stray !== undefined) {
      reasons.push(`${region}: remove ${stray}: the language server counts it as a line break and Lean does not, so lines and positions would no longer agree`);
    }
  }
  return [...reasons, ...structuralCheck(regions, SKETCH_POLICY)];
}

/**
 * The same checks on tactics to try in place of a line of the proof: each is screened as a proof
 * of its own, so a tactic that `lean_check` would refuse is not elaborated either.
 */
export function screenTactics(tactics: readonly string[]): string[] {
  return tactics.flatMap((tactic, k) =>
    screenRegions({ aux: "", proof: tactic }).map((reason) => `tactic ${k + 1}: ${reason.replace(/^proof: /, "")}`),
  );
}

const MAX_QUERY = 500;

/** A search query as it is sent to a site: one line, no control characters, not empty, not long. */
export function screenQuery(query: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) throw new Error("the query has control characters");
  const text = query.replace(/\s+/g, " ").trim();
  if (text === "") throw new Error("the query is empty");
  if ([...text].length > MAX_QUERY) throw new Error(`the query is longer than ${MAX_QUERY} characters`);
  return text;
}
