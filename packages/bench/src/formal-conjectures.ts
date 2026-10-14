import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  importsOf,
  maskCommentsAndStrings,
  namespacesAt,
  prepareSketch,
  readDeclarationHead,
  sha256Hex,
  splitCommands,
  statementIdV0,
  toPlainHeader,
} from "@seshat/core";

export interface FormalProofRef {
  /** `lean4`, `formal_conjectures` or `other_system`, as in the `formal_proof` attribute. */
  kind: string;
  url: string;
}

/** One theorem of a formal-conjectures checkout, with what the bench needs to know about it. */
export interface ProblemEntry {
  /** Stable id: `<path>#<full name>`. */
  id: string;
  /** Path from the checkout root, with `/` separators. */
  path: string;
  fullName: string;
  declaredName: string;
  /** 1-based line of the `theorem` keyword. */
  line: number;
  /** As in `@[category ...]`: `research solved`, `research open`, `test`, `textbook`... */
  category: string;
  ams: number[];
  formalProof?: FormalProofRef;
  /** What `answer(...)` holds in the statement, when there is one. */
  answer?: string;
  /** True when the file already proves it (anything but `sorry`). */
  proofInFile: boolean;
  /** True when the statement itself holds `sorry`, as in `answer(sorry)`: it cannot be proved. */
  sorryInStatement: boolean;
  statement: string;
  statementId: string;
  /** sha256 of the file after `toPlainHeader`: the text the prover and Lean see. */
  fileHash: string;
  imports: string[];
  /**
   * Definitions or axioms of the same file, above the target, that use `sorry` or are not
   * definitions at all (`axiom`, `opaque`). A statement that depends on one cannot be proved.
   */
  unprovedBefore: string[];
}

function leanFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return leanFiles(path);
      return name.endsWith(".lean") ? [path] : [];
    });
}

const SORRY = /(?<![\p{L}\p{N}_'.!?])sorry(?![\p{L}\p{N}_'!?])/u;
const DEFINITION_KEYWORDS = new Set(["def", "abbrev", "instance", "opaque", "axiom", "structure", "class", "inductive"]);

function attributeValue(attributes: string, pattern: RegExp): string | undefined {
  return pattern.exec(attributes)?.[1]?.trim();
}

/**
 * Every theorem or lemma that has a `category` attribute, in file order. Theorems the sketch cannot
 * cut (a proof by pattern matching, for instance) go to `errors`.
 */
export function scanFile(root: string, path: string, errors: string[] = []): ProblemEntry[] {
  const original = readFileSync(path, "utf8");
  const source = toPlainHeader(original);
  const rel = relative(root, path).split(sep).join("/");
  const fileHash = sha256Hex(source);
  const imports = importsOf(source);
  const commands = splitCommands(source);
  const scopes = namespacesAt(commands);
  const entries: ProblemEntry[] = [];
  const unproved: string[] = [];
  for (let k = 0; k < commands.length; k++) {
    const command = commands[k] as (typeof commands)[number];
    if (command.kind !== "code") continue;
    const head = readDeclarationHead(command.text);
    if (head === undefined) continue;
    const masked = maskCommentsAndStrings(command.text);
    if (DEFINITION_KEYWORDS.has(head.keyword)) {
      if (head.keyword === "axiom" || head.keyword === "opaque" || SORRY.test(masked)) {
        unproved.push(head.name || `${head.keyword}@${lineOf(source, command.start + head.keywordOffset)}`);
      }
      continue;
    }
    if (head.keyword !== "theorem" && head.keyword !== "lemma") continue;
    const attributes = command.text.slice(0, head.keywordOffset);
    const category = attributeValue(attributes, /\bcategory\s+([A-Za-z_ ]+?)\s*[,\]]/);
    if (category === undefined) continue;
    const fullName = [...(scopes[k] ?? []), head.name].join(".").replace(/^(?:.*\.)?_root_\./, "");
    let sketch: ReturnType<typeof prepareSketch>;
    try {
      sketch = prepareSketch(source, fullName);
    } catch (error) {
      errors.push(`${rel}: ${(error as Error).message}`);
      continue;
    }
    const ams = (attributeValue(attributes, /\bAMS((?:\s+\d+)+)/) ?? "").split(/\s+/).filter(Boolean).map(Number);
    const proof = /\bformal_proof\s+using\s+(\w+)\s+at\s+"([^"]*)"/.exec(attributes);
    const answer = /\banswer\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(sketch.statement)?.[1]?.trim();
    entries.push({
      id: `${rel}#${sketch.fullName}`,
      path: rel,
      fullName: sketch.fullName,
      declaredName: sketch.declaredName,
      line: lineOf(source, command.start + head.keywordOffset),
      category: category.replace(/\s+/g, " "),
      ams,
      ...(proof ? { formalProof: { kind: proof[1] as string, url: proof[2] as string } } : {}),
      ...(answer !== undefined ? { answer } : {}),
      proofInFile: sketch.originalProof !== "sorry",
      sorryInStatement: SORRY.test(maskCommentsAndStrings(sketch.statement)),
      statement: sketch.statement,
      statementId: statementIdV0(sketch.statement),
      fileHash,
      imports,
      unprovedBefore: [...unproved],
    });
  }
  return entries;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

export interface ScanResult {
  problems: ProblemEntry[];
  /** Files or theorems the scanner could not read, with the reason. */
  errors: string[];
}

/** Scans `<root>/FormalConjectures`, the problem statements of a formal-conjectures checkout. */
export function scanCheckout(root: string): ScanResult {
  const problems: ProblemEntry[] = [];
  const errors: string[] = [];
  for (const path of leanFiles(join(root, "FormalConjectures"))) {
    try {
      problems.push(...scanFile(root, path, errors));
    } catch (error) {
      errors.push(`${relative(root, path)}: ${(error as Error).message}`);
    }
  }
  return { problems, errors };
}
