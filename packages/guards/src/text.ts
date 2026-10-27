import {
  collapseWhitespace,
  maskCommentsAndStrings,
  prepareSketch,
  readDeclarationHead,
  splitCommands,
  stripLeanComments,
  type Submission,
} from "@seshat/core";

/** A comment of a Lean source, with the line it starts on (from 0). */
export interface LeanComment {
  text: string;
  line: number;
  kind: "line" | "block";
}

/**
 * The comments of a Lean source, line comments and block comments (docstrings included), without
 * their delimiters. Strings are skipped. A block comment is one comment, however many lines it spans.
 */
export function leanComments(source: string): LeanComment[] {
  const found: LeanComment[] = [];
  let line = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "\n") {
      line += 1;
      i += 1;
    } else if (c === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\n") line += 1;
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
    } else if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      found.push({ text: source.slice(i + 2, stop).trim(), line, kind: "line" });
      i = stop;
    } else if (c === "/" && next === "-") {
      const start = i + 2;
      const first = line;
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "-") {
          depth += 1;
          i += 2;
        } else if (source[i] === "-" && source[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          if (source[i] === "\n") line += 1;
          i += 1;
        }
      }
      found.push({ text: source.slice(start, Math.max(start, i - 2)).replace(/^-/, "").trim(), line: first, kind: "block" });
    } else {
      i += 1;
    }
  }
  return found;
}

/**
 * The passages of prose in a Lean source: each block comment, and each run of line comments on
 * consecutive lines, as one text. A reference and the claim it supports are in the same passage.
 */
export function leanPassages(source: string): string[] {
  const passages: string[] = [];
  let last: LeanComment | undefined;
  for (const comment of leanComments(source)) {
    const previous = passages.pop();
    if (previous !== undefined && comment.kind === "line" && last?.kind === "line" && comment.line === last.line + 1) {
      passages.push(`${previous}\n${comment.text}`);
    } else {
      if (previous !== undefined) passages.push(previous);
      passages.push(comment.text);
    }
    last = comment;
  }
  return passages;
}

/** What a check reads of a submission: the code of both regions, without comments, spacing collapsed. */
export function normalizeSubmission(submission: Submission): string {
  return `${collapseWhitespace(stripLeanComments(submission.aux))}\u0000${collapseWhitespace(stripLeanComments(submission.proof))}`;
}

/** The size of a submission's code in characters, comments and spacing out. */
export function codeSize(submission: Submission): number {
  return collapseWhitespace(stripLeanComments(submission.aux)).length + collapseWhitespace(stripLeanComments(submission.proof)).length;
}

/** The keywords that begin a declaration, as opposed to a command or a tactic. */
export const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set(["theorem", "lemma", "def", "abbrev", "instance", "example", "structure", "inductive", "class", "axiom", "opaque"]);

/** A declaration of the AUX region. */
export interface AuxDeclaration {
  name: string;
  keyword: string;
  /** The statement in signature form, for a theorem or lemma that can be cut into a statement and a proof. */
  statement?: string;
  /** The declaration's text, with the comments inside it. */
  text: string;
  /** Whether `sorry` or `admit` appears in its code (comments and strings aside). */
  sorry: boolean;
  /** The comments that go with it: those just above it, and those inside it. */
  comments: string[];
}

/** The declarations of an AUX region, in order, with the comments attached to each. */
export function auxDeclarations(aux: string): AuxDeclaration[] {
  const commands = splitCommands(aux);
  const found: AuxDeclaration[] = [];
  let above: string[] = [];
  for (const command of commands) {
    if (command.kind !== "code") {
      above.push(...leanComments(command.text).map((c) => c.text));
      continue;
    }
    const head = readDeclarationHead(command.text);
    if (head !== undefined && head.name !== "" && DECLARATION_KEYWORDS.has(head.keyword)) {
      let statement: string | undefined;
      if (head.keyword === "theorem" || head.keyword === "lemma") {
        try {
          statement = prepareSketch(command.text, head.name).statement;
        } catch {
          // A lemma that cannot be cut into a statement and a proof has no statement to compare.
        }
      }
      found.push({
        name: head.name,
        keyword: head.keyword,
        ...(statement !== undefined ? { statement } : {}),
        text: command.text,
        sorry: hasHole(command.text),
        comments: [...above, ...leanComments(command.text).map((c) => c.text)],
      });
    }
    above = [];
  }
  return found;
}

/** Whether a Lean text has `sorry` or `admit` in its code. */
export function hasHole(source: string): boolean {
  return /\b(?:sorry|admit)\b/.test(maskCommentsAndStrings(source));
}

/** A text clipped to `chars` characters, with an ellipsis. */
export function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, Math.max(chars - 1, 0))}…`;
}
