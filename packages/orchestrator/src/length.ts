import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The length measures of `harness audit` (plan change LP1, documentation/audit.md, "Length"): how long a Lean proof is, counted one way for
 * Seshat's files and for a person's reference, so that the two numbers can be set side by side. Pure functions over text; no model, no Lean.
 */

/** The text with Lean's comments removed: `--` to the end of the line, and `/- ... -/` (doc comments included), which nest. Strings are not parsed. */
export function stripLeanComments(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "/-") {
      depth++;
      i++;
    } else if (depth > 0 && two === "-/") {
      depth--;
      i++;
    } else if (depth > 0) {
      if (text[i] === "\n") out += "\n";
    } else if (two === "--") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += "\n";
    } else out += text[i];
  }
  return out;
}

/** Lean lines as counted everywhere in the audit: the lines that are neither blank nor only a comment. */
export function leanLines(text: string): number {
  return stripLeanComments(text.replace(/\r\n/g, "\n")).split("\n").filter((l) => l.trim() !== "").length;
}

const DECLARATION = /^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|nonrec|unsafe|partial)\s+)*(theorem|lemma)\s+([^\s:({\[]+)/gm;

/** The `theorem` and `lemma` declarations of a Lean text (comments excluded), by name. */
export function leanTheorems(text: string): string[] {
  return [...stripLeanComments(text).matchAll(DECLARATION)].map((m) => m[2] as string);
}

/** The `aux_` lemmas of a file: the helper lemmas the prover's own region declares (`aux_bound`, `Foo.aux_bound`). */
export function auxLemmas(text: string): number {
  return leanTheorems(text).filter((name) => /(^|\.)aux_/.test(name)).length;
}

/** The Lean code blocks (fenced with `lean`) of a Markdown text, joined. */
export function leanBlocks(markdown: string): string {
  const blocks: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*lean4?\s*$/i.exec(lines[i] as string);
    if (open === null) continue;
    const fence = (open[1] as string)[0] as string;
    const body: string[] = [];
    for (i++; i < lines.length && !new RegExp(`^\\s*${fence}{3,}\\s*$`).test(lines[i] as string); i++) body.push(lines[i] as string);
    blocks.push(body.join("\n"));
  }
  return blocks.join("\n");
}

export interface ReferenceLength {
  /** Non-blank, non-comment Lean lines (`leanLines`). */
  lines: number;
  /** `theorem` and `lemma` declarations. */
  theorems: number;
  from: "lean" | "md";
}

/** A person's reference for a problem, measured: `DIR/ID.lean`, else the Lean code blocks of `DIR/ID.md`. Undefined when there is neither, or no Lean in the `.md`. */
export function referenceLength(dir: string, problemId: string): ReferenceLength | undefined {
  const id = problemId.replace(/[\\/]/g, "_");
  const measure = (text: string, from: "lean" | "md"): ReferenceLength => ({ lines: leanLines(text), theorems: leanTheorems(text).length, from });
  try {
    const lean = join(dir, `${id}.lean`);
    if (existsSync(lean)) return measure(readFileSync(lean, "utf8"), "lean");
    const md = join(dir, `${id}.md`);
    if (existsSync(md)) {
      const code = leanBlocks(readFileSync(md, "utf8"));
      return code.trim() === "" ? undefined : measure(code, "md");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Reference length buckets, in order, with the lines each holds. */
export const LENGTH_BUCKETS = [
  { label: "<30", test: (n: number) => n < 30 },
  { label: "30-99", test: (n: number) => n >= 30 && n < 100 },
  { label: "100-299", test: (n: number) => n >= 100 && n < 300 },
  { label: ">=300", test: (n: number) => n >= 300 },
] as const;
export const NO_REFERENCE = "no reference";

export function bucketOf(referenceLines: number | undefined): string {
  if (referenceLines === undefined) return NO_REFERENCE;
  return LENGTH_BUCKETS.find((b) => b.test(referenceLines))?.label ?? NO_REFERENCE;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface LengthRecord {
  problemId: string;
  /** `certified` (claim `proved` or `refuted`) or `not certified`. */
  status: "certified" | "not certified";
  outcome: string;
  /** The file measured and where it came from; absent when the run's blobs do not hold one. */
  file?: {
    source: "certified_validation" | "last_failed_validation" | "last_validation" | "last_sketch";
    /** What was counted: the prover's two regions (`aux` and `proof`), or the whole text when it has no markers. */
    counted: "regions" | "file";
    lines: number;
    chars: number;
    theorems: number;
  };
  /** Lemmas whose name starts with `aux_` in that file. */
  auxLemmas?: number;
  /** The last `m12_sketch` of the problem, when it has one. */
  holes?: { count: number; dropped: number; healthy: boolean; verdicts: Record<string, number> };
  /** `lean_check` calls: the sessions' own counts or the transcripts', summed; absent when no session recorded them. */
  leanChecks?: number;
  /** Tool runs of `lean.check` made inside the problem's attempts. */
  leanCheckRuns: number;
  /** The tool runs of `lean.check` whose input blob and duration are both in the journal: the size of the code sent and the time taken. */
  checkTimes: Array<{ chars: number; ms: number }>;
  stopReasons: Record<string, number>;
  reference?: ReferenceLength;
}

export interface LengthBucketRow {
  bucket: string;
  total: number;
  certified: number;
  /** Median of the Seshat lines of the certified problems whose file is recorded. */
  medianCertifiedLines?: number;
}

/** Problems bucketed by reference length: certified over total, and the median Seshat length of the certified ones. */
export function lengthBuckets(records: readonly LengthRecord[]): LengthBucketRow[] {
  const labels = [...LENGTH_BUCKETS.map((b) => b.label as string), NO_REFERENCE];
  return labels.map((bucket) => {
    const mine = records.filter((r) => bucketOf(r.reference?.lines) === bucket);
    const certified = mine.filter((r) => r.status === "certified");
    const lines = certified.flatMap((r) => (r.file !== undefined ? [r.file.lines] : []));
    const med = median(lines);
    return { bucket, total: mine.length, certified: certified.length, ...(med !== undefined ? { medianCertifiedLines: med } : {}) };
  });
}
