/** What stands where Lean's output was removed from a text. */
export const REMOVED_MARK = "[Lean output removed]";

/**
 * The first words of Lean's error messages and of its tactics' failures. A line that begins with one
 * of these is only a hint: the typed summaries of `@seshat/memory` use the same words, so a line is
 * taken for Lean's output only with something else beside it (a goal, a location, a quoted name).
 */
const OPENER_WORDS =
  "unsolved goals|type mismatch|application type mismatch|failed to synthesize|function expected|unexpected token|" +
  "unknown (?:identifier|constant|namespace|declaration)|invalid field|invalid argument|motive is not type correct|" +
  "linarith failed|nlinarith failed|positivity failed|omega could not|The \\w+ tactic|ring failed|norm_num failed|" +
  "simp made no progress|declaration uses 'sorry'|maximum recursion depth|\\(deterministic\\) timeout|\\(kernel\\)|" +
  "tactic '[^']+' (?:failed|proved)";

const OPENER = new RegExp(`^\\s*(?:${OPENER_WORDS})\\b`, "i");

/** A location in Lean's output: `Foo.lean:12:4:`, `<input>:3:1:`. */
const LOCATION = /(?:^|[\s(])[^\s:()]+\.lean:\d+:\d+|^\s*<[A-Za-z_ ]+>:\d+:\d+/;

/** `error: unsolved goals`, `warning: declaration uses 'sorry'`, with or without a location before. */
const HEADER = new RegExp(`^\\s*(?:[^\\s:]+:\\d+:\\d+:\\s*)?(?:error|warning)(?:\\([\\w.]+\\))?:\\s*(?:${OPENER_WORDS})`, "i");

/** Wordings that are Lean's own, or the harness's own when it reports a check. */
const PHRASES: readonly RegExp[] = [
  /\bbut is expected to have type\b/,
  /^\s*has type\s*$/,
  /Additional diagnostic information may be available/,
  /^\s*The \w+ tactic (?:failed|could not)/,
  /^\s*(?:unknown (?:identifier|constant|namespace|declaration)|invalid field)\s+['`«][^'`»\n]+['`»]/i,
  /^\s*unexpected token\s+['"`]/i,
  // The report of a check, as the harness writes it for the prover.
  /^\s*(?:Errors|Holes, with their goals|Other messages) \(\d+\):\s*$/,
  /^\s*\d+\.\s+(?:AUX|PROOF) line \d+/,
  /^\s*Not accepted: \d+ error\(s\)\./,
  /^\s*Checked the sketch: /,
];

/** A hypothesis of a goal: one or more names, then ` : ` and the type. */
const HYPOTHESIS = /^\s*[\p{L}_][\p{L}\p{N}_'✝.]*(?:\s+[\p{L}_][\p{L}\p{N}_'✝.]*)*\s:\s+\S/u;

type Kind = "blank" | "text" | "strong" | "opener" | "goal" | "hyp" | "case";

function kindOf(line: string): Kind {
  if (line.trim() === "") return "blank";
  if (LOCATION.test(line) || HEADER.test(line) || PHRASES.some((p) => p.test(line))) return "strong";
  if (/^\s*⊢/.test(line)) return "goal";
  if (/^\s*case\s+\S+\s*$/.test(line)) return "case";
  if (HYPOTHESIS.test(line)) return "hyp";
  if (OPENER.test(line)) return "opener";
  return "text";
}

const INDENTED = /^(?:\s{2,}|\t)\S/;

/** Whether a line can belong to a block of Lean output that has a strong line in it. */
function joins(kind: Kind, line: string): boolean {
  return kind !== "blank" && (kind !== "text" || INDENTED.test(line));
}

/** The index range [from, to) of the lines of a fenced block, fences included, with the block's lines. */
function fences(lines: readonly string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  let open: number | undefined;
  lines.forEach((line, k) => {
    if (!/^\s*(?:```|~~~)/.test(line)) return;
    if (open === undefined) {
      open = k;
    } else {
      found.push([open, k + 1]);
      open = undefined;
    }
  });
  return found;
}

/** The index ranges [from, to) of the lines that are Lean's output. */
function runsOf(lines: readonly string[], options: { fences: boolean }): Array<[number, number]> {
  const kinds = lines.map(kindOf);
  const at = (k: number): Kind => kinds[k] ?? "blank";
  const text = (k: number): string => lines[k] ?? "";
  const found: Array<[number, number]> = [];

  const grow = (from: number, to: number): [number, number] => {
    let a = from;
    let b = to;
    while (a > 0 && joins(at(a - 1), text(a - 1))) a -= 1;
    while (b < lines.length && joins(at(b), text(b))) b += 1;
    return [a, b];
  };

  for (let k = 0; k < lines.length; k++) {
    const kind = at(k);
    if (kind === "strong") {
      found.push(grow(k, k + 1));
    } else if (kind === "goal") {
      // A goal is Lean's output when its context is shown (hypotheses, a case), or an error opens it.
      let top = k;
      while (top > 0 && (at(top - 1) === "hyp" || at(top - 1) === "case")) top -= 1;
      const context = k - top;
      const opened = top > 0 && at(top - 1) === "opener";
      if (context > 0 || opened) found.push(grow(opened ? top - 1 : top, k + 1));
    }
  }

  if (options.fences) {
    // A pasted block: a fence that holds a goal, an error opener or any strong line is Lean's output as a whole.
    for (const [from, to] of fences(lines)) {
      const inside = kinds.slice(from + 1, to - 1);
      if (inside.some((kind) => kind === "strong" || kind === "goal" || kind === "opener")) found.push([from, to]);
    }
  }

  // Overlapping runs, and runs with only blank lines between them (the goals of one message), are one.
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const run of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && lines.slice(last[1], run[0]).every((l) => l.trim() === "")) last[1] = Math.max(last[1], run[1]);
    else merged.push([run[0], run[1]]);
  }
  return merged;
}

/** How a text is read for Lean's output. */
export interface ScanOptions {
  /**
   * Also take a fenced code block for Lean's output when it holds a goal, an error opener or a
   * location (for the notes a model writes, which paste what Lean said in a block). Default false.
   */
  fences?: boolean;
}

export interface Scrubbed {
  /** The text with each block of Lean's output replaced by `REMOVED_MARK`. */
  text: string;
  /** How many blocks were removed. */
  blocks: number;
  /** Whether nothing is left of the text but marks and blank space. */
  empty: boolean;
}

/**
 * Removes Lean's raw output from a text (plan §9, "no raw error text in the context"): a goal with
 * its hypotheses, a message with a location or an error header, the words of a type mismatch, a copy
 * of the harness's report of a check. The typed summaries of `@seshat/memory` (`unsolved goals at
 * case succ`) and a goal named in prose (`the goal is ⊢ n = 0`) are not Lean's output and stay.
 */
export function scrubLeanOutput(text: string, options: ScanOptions = {}): Scrubbed {
  const lines = text.split("\n");
  const runs = runsOf(lines, { fences: options.fences === true });
  if (runs.length === 0) return { text, blocks: 0, empty: text.replace(/\s+/g, "") === "" };
  const out: string[] = [];
  let next = 0;
  for (const [from, to] of runs) {
    out.push(...lines.slice(next, from), REMOVED_MARK);
    next = to;
  }
  out.push(...lines.slice(next));
  const scrubbed = out.join("\n");
  return { text: scrubbed, blocks: runs.length, empty: scrubbed.split(REMOVED_MARK).join("").replace(/\s+/g, "") === "" };
}

/** Whether a text holds Lean's raw output, as `scrubLeanOutput` reads it. */
export function hasLeanOutput(text: string, options: ScanOptions = {}): boolean {
  return runsOf(text.split("\n"), { fences: options.fences === true }).length > 0;
}
