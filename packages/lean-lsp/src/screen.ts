import { SKETCH_POLICY, structuralCheck, type Submission } from "@seshat/core";
import { attemptLines, foreignBreak, isMarker, type Layout, tacticLines } from "./layout.ts";
import type { Region } from "./protocol.ts";

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

/** Where a `multi_attempt` is made: the region and its line, and the line's place in the file. */
export interface AttemptSite {
  region: Region;
  /** The line in the region, from 1. */
  line: number;
  /** The line in the file, from 1. */
  fileLine: number;
}

/**
 * The screen of what `multi_attempt` has the server elaborate, which is not the tactic alone. The
 * server replaces, from the line asked, as many lines of the file as the tactic has with the first
 * `column - 1` characters of the line and the tactic (see `attemptLines`). So a name cut in two by the
 * column is whole in the document, and the text a comment hid may not be hidden any more. Each
 * tactic is put into the document, the document's regions are read back, and they go through the
 * screen of regions. A tactic that has more lines than the region has from the line asked would
 * replace the marker that ends the region and the lines after it, which are not the prover's: refused.
 */
export function screenAttempts(layout: Layout, site: AttemptSite, column: number, tactics: readonly string[]): string[] {
  const reasons: string[] = [];
  const name = site.region.toUpperCase();
  // The region's lines from the line asked to its last one.
  const room = layout.end[site.region] - site.fileLine;
  tactics.forEach((tactic, k) => {
    const label = `tactic ${k + 1}`;
    const count = tacticLines(tactic).length;
    if (count > room) {
      reasons.push(
        `${label} has ${count} lines, and the server replaces as many lines of the file as a tactic has, from the line asked; ${name} has ${room} from there, so it would replace the end of the region and what follows it`,
      );
      return;
    }
    const document = attemptLines(layout, site.fileLine, column, tactic);
    const regions = {
      aux: document.slice(layout.begin.aux, layout.end.aux - 1).join("\n"),
      proof: document.slice(layout.begin.proof, layout.end.proof - 1).join("\n"),
    };
    const joined = document
      .slice(site.fileLine - 1, site.fileLine - 1 + count)
      .map((line) => line.trim())
      .join(" ⏎ ");
    const shown = joined.length > 120 ? `${joined.slice(0, 117)}...` : joined;
    const how =
      column > 1
        ? `is joined to the first ${column - 1} character${column === 2 ? "" : "s"} of ${name} line ${site.line}, so that the server elaborates \`${shown}\``
        : `takes the place of ${name} line ${site.line}, so that the server elaborates the lines around it with \`${shown}\``;
    for (const reason of screenRegions(regions)) reasons.push(`${label} ${how}: ${reason}`);
  });
  return reasons;
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
