import { assemble, AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END, type Sketch, type Submission } from "@seshat/core";
import type { Place, Region } from "./protocol.ts";

/**
 * The sketch file with the prover's regions in it, and where the regions are. Lines of the regions
 * are counted from 1 as `lean_check` counts them ("PROOF line 3"); a line of the fixed part is
 * named by its place in the file. Columns are the file's.
 */
export interface Layout {
  /** The whole file, with the marker lines, as `lean_check` checks it. */
  text: string;
  lines: readonly string[];
  /** The file's line (from 1) of each region's two marker lines. */
  begin: Readonly<Record<Region, number>>;
  end: Readonly<Record<Region, number>>;
}

export class LayoutError extends Error {}

/**
 * The characters that the language server's `splitlines()` counts as a line break and Lean does not:
 * a carriage return that no line feed follows, vertical tab, form feed, the file, group and record
 * separators, NEL, and the Unicode line and paragraph separators. A CRLF is one line break for both.
 */
const FOREIGN_BREAK = /\r(?!\n)|[\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/;

const BREAK_NAMES: Record<string, string> = {
  "\u000b": "vertical tab",
  "\u000c": "form feed",
  "\u001c": "file separator",
  "\u001d": "group separator",
  "\u001e": "record separator",
  "\u0085": "next line",
  "\u2028": "line separator",
  "\u2029": "paragraph separator",
};

/** The first such character in `text`, in words, or undefined. */
export function foreignBreak(text: string): string | undefined {
  const found = FOREIGN_BREAK.exec(text)?.[0];
  if (found === undefined) return undefined;
  if (found === "\r") return "a carriage return that no line feed follows";
  return `U+${(found.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")} (${BREAK_NAMES[found] ?? "line break"})`;
}

/**
 * The file as the language server reads it. A CRLF is written as a line feed, so that the lines of
 * the harness are the server's; any other line break of the server's is refused (a prover's regions
 * are refused with it, in `screenRegions`; this is the problem's own text).
 */
export function layoutOf(sketch: Sketch, regions: Submission): Layout {
  const text = assemble(sketch, regions, true).replace(/\r\n/g, "\n");
  const stray = foreignBreak(text);
  if (stray !== undefined) {
    throw new LayoutError(`the problem's file holds ${stray}, which the language server counts as a line break and Lean does not, so its lines cannot be told apart`);
  }
  const lines = text.split("\n");
  const find = (marker: string): number => {
    const hits = lines.flatMap((line, k) => (line.trim() === marker.trim() ? [k + 1] : []));
    if (hits.length !== 1) throw new LayoutError(`the sketch has ${hits.length} lines '${marker.trim()}', not one`);
    return hits[0] as number;
  };
  const begin = { aux: find(AUX_BEGIN), proof: find(PROOF_BEGIN) };
  const end = { aux: find(AUX_END), proof: find(PROOF_END) };
  if (!(begin.aux < end.aux && end.aux < begin.proof && begin.proof < end.proof)) {
    throw new LayoutError("the markers of the sketch are out of order");
  }
  return { text, lines, begin, end };
}

/** How many lines a region has in the file. */
export function regionLines(layout: Layout, region: Region): number {
  return layout.end[region] - layout.begin[region] - 1;
}

/** The file's line of a region's line, or why there is none. */
export function fileLine(layout: Layout, region: Region, line: number): number {
  const count = regionLines(layout, region);
  const name = region.toUpperCase();
  if (count === 0) throw new LayoutError(`${name} is empty, so it has no line ${line}`);
  if (line < 1 || line > count) throw new LayoutError(`${name} has ${count} line${count === 1 ? "" : "s"}; there is no line ${line}`);
  return layout.begin[region] + line;
}

/** Where a line of the file is, in the prover's terms. */
export function placeOf(layout: Layout, line: number): Place {
  for (const region of ["aux", "proof"] as const) {
    if (line > layout.begin[region] && line < layout.end[region]) return { region, line: line - layout.begin[region] };
  }
  return { region: "fixed", line };
}

/** The file's line, as it stands there. */
export function lineText(layout: Layout, line: number): string {
  return layout.lines[line - 1] ?? "";
}

/** The column (from 1) of the first character of a line that is not a blank; 1 for a blank line. */
export function firstColumn(text: string): number {
  const index = [...text].findIndex((c) => !/\s/.test(c));
  return index < 0 ? 1 : index + 1;
}

/** Length in characters, as the server counts columns. */
export function characters(text: string): number {
  return [...text].length;
}

/** Refuses a column past the end of its line (one past is the end itself). */
export function checkColumn(text: string, column: number): void {
  const length = characters(text);
  if (column > length + 1) throw new LayoutError(`column ${column} is past the end of the line, which has ${length} characters`);
}

/**
 * The file's lines as the server counts them: Python's `splitlines()` of a text that has line feeds
 * only (see `layoutOf`), which leaves out the empty line that a final line feed ends.
 */
export function serverLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A tactic's lines as the server counts them: its trailing line feeds go, and an empty tactic is one empty line. */
export function tacticLines(tactic: string): string[] {
  const text = tactic.replace(/\n+$/, "");
  return text === "" ? [""] : text.split("\n");
}

/**
 * The lines of the document that `lean_multi_attempt` has the server elaborate for a tactic. This is
 * `build_attempt_text` of lean-lsp-mcp 0.31.0 (lean_lsp_mcp/attempt_utils.py): from `line` (the file's,
 * from 1), as many lines of the file are replaced as the tactic has; each becomes the first
 * `column - 1` characters of `line` (code points, as Python counts) followed by one line of the tactic.
 * The document is what `layout.text` and the server's own `splitlines()` give, so a tactic that
 * the harness screens is screened as the server will read it.
 */
export function attemptLines(layout: Layout, line: number, column: number, tactic: string): string[] {
  const lines = serverLines(layout.text);
  const prefix = [...(lines[line - 1] ?? "")].slice(0, Math.max(0, column - 1)).join("");
  const parts = tacticLines(tactic);
  const end = Math.min(line - 1 + parts.length, lines.length);
  return [...lines.slice(0, line - 1), ...parts.map((part) => prefix + part), ...lines.slice(end)];
}

/** The place in words, as `lean_check` writes it: `PROOF line 3`, or `line 12 of the fixed part`. */
export function describePlace(place: Place, column?: number): string {
  const where = place.region === "fixed" ? `line ${place.line} of the fixed part` : `${place.region.toUpperCase()} line ${place.line}`;
  return column === undefined ? where : `${where}, column ${column}`;
}

/** Whether a line is one of the four marker lines. */
export function isMarker(line: string): boolean {
  const trimmed = line.trim();
  return [AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END].some((marker) => marker.trim() === trimmed);
}
