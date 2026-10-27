import { sha256Hex } from "./canonical-json.ts";
import {
  type LeanCertifier,
  type CertificationResult,
  type LeanChecker,
  type LeanCheckResult,
  type LeanMessage,
  type LeanSorry,
  parseAxiomsMessage,
  STANDARD_AXIOMS,
} from "./lean.ts";
import { blankComments, firstCharacterLiteral, NAME_PART, NAME_PART_CHARACTER, NAME_START, NAME_START_CHARACTER, readDeclarationHead, splitCommands, TOKEN_START } from "./lean-source.ts";
import { assemble, editedOutsideRegions, extractSubmission, type Sketch, SketchError, type Submission } from "./sketch.ts";

export interface ValidationPolicy {
  allowedAxioms: readonly string[];
  /** Names of auxiliary declarations must match, so they cannot shadow a name in the statement. */
  auxNamePattern: RegExp;
  auxAttributes: readonly string[];
  timeoutSec: number;
  /**
   * Lets `sorry` and `admit` through, so that a sketch with holes reaches Lean and the goals of its
   * holes come back. A file with a hole is never valid.
   */
  holes: boolean;
}

export const DEFAULT_POLICY: ValidationPolicy = {
  allowedAxioms: STANDARD_AXIOMS,
  auxNamePattern: /^aux_[\p{L}\p{N}_'!?₀-₉]*$/u,
  auxAttributes: ["simp", "reducible", "irreducible", "local simp"],
  timeoutSec: 300,
  holes: false,
};

/** The policy of a prover's checks while it works: the default one, with holes allowed. */
export const SKETCH_POLICY: ValidationPolicy = { ...DEFAULT_POLICY, holes: true };

/** The tokens `SKETCH_POLICY` lets through. */
export const HOLE_TOKENS: readonly string[] = ["sorry", "admit"];

/**
 * Tokens refused in both editable regions, outside comments. The Lean checks below are what decide;
 * this list keeps the usual shortcuts and any code that runs during elaboration out of the REPL.
 */
const FORBIDDEN_TOKENS = [
  // Ways to skip or weaken the proof.
  "sorry", "admit", "axiom", "native_decide", "ofReduceBool", "ofReduceNat", "trustCompiler",
  "implemented_by", "extern", "unsafe", "debug", "skipKernelTC",
  // Commands and attributes that run code or change the syntax.
  "#eval", "#exit", "#print", "run_cmd", "run_elab", "run_meta", "run_tac", "by_elab", "eval%",
  "elab", "elab_rules", "macro", "macro_rules", "syntax", "declare_syntax_cat", "notation", "infix",
  "infixl", "infixr", "prefix", "postfix", "initialize", "builtin_initialize", "import", "tactic",
  "command_elab", "term_elab", "delab", "app_unexpander", "simproc", "dsimproc", "simproc_decl",
  "register_option", "register_simp_attr",
  // The meta level: a proof of a mathematical statement never needs these names.
  "Lean", "Meta", "Elab", "MetaM", "TacticM", "CoreM", "TermElabM", "CommandElabM", "IO",
  "unsafeIO", "unsafeBaseIO", "unsafeEIO", "Environment", "setEnv", "modifyEnv", "addDecl",
  "addDeclCore", "addDeclWithoutChecking", "addAndCompile",
];

const AUX_KEYWORDS = new Set(["theorem", "lemma", "def", "abbrev"]);

/**
 * A regular expression for a token, as Lean's lexer reads text. After a syntax error Lean goes on
 * (from the position of the error; when the failed command made no progress it first skips one token
 * that an empty token table reads, or one character) and runs a command that starts there, so a
 * forbidden word is a danger when the lexer reads it as a token of its own, and no danger when it is
 * part of a longer name:
 * - A token that starts like a name (`sorry`, `run_cmd`, `IO`) is found unless it continues a name
 *   that the lexer starts at a token start (`TOKEN_START`): `xsorry`, `x1sorry`, `x!sorry`,
 *   `Nat.sorry_lemma` and `h.elab` are names after white space, `(` or `,`, and `sorry_free` too.
 *   What stands before a name does not make the token part of it: `!sorry`, `λsorry`, `(e).sorry`
 *   and `a..sorry` hold `sorry`, and so do `1sorry`, `1e5sorry` and `0xbeefsorry`, since a number is a
 *   lexeme of its own (anything that begins with a digit is refused, whichever way Lean reads it).
 *   A run of letters glued to a symbol is not trusted as a name: `#checkrun_cmd`, `[MODrun_cmd` and
 *   `⟫_run_cmd` hold `run_cmd`, and `[hprefix]` is refused for `prefix` although it is a name.
 * - A token that starts with a character no name has, such as `#eval`, is found wherever it stands,
 *   since Lean reads `x#eval` as `x` and `#eval`; and the longest token wins in the lexer, so what
 *   follows it does not matter (`#eval!` is a command too).
 * - A token that ends with such a character (`eval%`) needs no boundary after it.
 * A name of more than 256 characters, or of more than 16 parts, is not taken for one. After a `'` that
 * may start a character literal the first reading does not hold (`holdsToken`).
 */
function tokenPattern(token: string): TokenPatterns {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const characters = [...token];
  const startsLikeName = NAME_START_CHARACTER.test(characters[0] ?? "");
  const endsLikeName = NAME_PART_CHARACTER.test(characters.at(-1) ?? "");
  const name = `[${NAME_START}][${NAME_PART}]{0,255}`;
  // A name that ends right before the token and that the lexer starts at a token start, after any
  // symbols (`!`, `?`, `.`) that Lean reads as tokens of their own.
  const before = startsLikeName ? `(?<!${TOKEN_START}[!?.]*${name}(?:\\.${name}){0,15}\\.?)` : "";
  const after = startsLikeName && endsLikeName ? `(?![${NAME_PART}])` : "";
  return { bounded: new RegExp(`${before}${escaped}${after}`, "u"), loose: new RegExp(`${escaped}${after}`, "gu") };
}

/**
 * The two readings of a token's pattern: `bounded` takes a name to begin where the text seems to start
 * a token, and `loose` takes none to, for the text after a `'` that may start a character literal.
 */
interface TokenPatterns {
  bounded: RegExp;
  loose: RegExp;
}

/**
 * Whether a text holds a token. Up to the first `'` that may start a character literal (`literal`, an
 * offset or -1) a run of letters is a name where the lexer starts one (`TOKEN_START`). From there on the
 * lexer may have lost its place: the literal takes the next two characters, and a boundary among them is
 * no boundary (`' xsorry`: Lean reads `' x`, then `sorry`), so a token is a token wherever it stands.
 */
function holdsToken(text: string, patterns: TokenPatterns, literal: number): boolean {
  if (literal < 0) return patterns.bounded.test(text);
  const first = patterns.bounded.exec(text);
  if (first !== null && first.index < literal) return true;
  patterns.loose.lastIndex = literal;
  return patterns.loose.test(text);
}

const FORBIDDEN_PATTERNS = FORBIDDEN_TOKENS.map((t) => [t, tokenPattern(t)] as const);
const HOLE_PATTERNS = HOLE_TOKENS.map(tokenPattern);

/** Whether a region holds `sorry` or `admit` outside comments. */
export function hasHoles(submission: Submission): boolean {
  return [submission.aux, submission.proof].some((region) => {
    const text = scanRegion(region).masked.replace(/_root_\./g, " ");
    const literal = firstCharacterLiteral(text);
    return HOLE_PATTERNS.some((patterns) => holdsToken(text, patterns, literal));
  });
}

export interface RegionScan {
  /** The region with its comments blanked (newlines kept). */
  masked: string;
  problems: string[];
}

/**
 * Blanks the comments of an editable region. String literals and «» names are refused there: a
 * light scanner cannot follow interpolated strings or quoted names exactly, and a scanner that
 * disagrees with Lean about where a comment starts would let tokens hide from the checks. For that
 * reason the region is read strictly (`blankComments`, `strict`), and a comment opens only where
 * Lean is sure to read one: in `<--`, `\/-` and `//-` Lean reads a token and then a minus or a
 * slash, in `/-/-/` a comment that is complete, after `' ` a character literal that takes the `--`,
 * and `/--` and `/-!` are doc comment tokens read on other terms. What follows is code, which is
 * screened as such. From the first `--`, `/-` or `'` that is not sure on, nothing is blanked.
 */
export function scanRegion(text: string): RegionScan {
  const { masked, unclosed } = blankComments(text, { strict: true });
  const found: Array<[number, string]> = [];
  const quote = masked.indexOf('"');
  if (quote >= 0) found.push([quote, "string literals are not allowed in the editable regions"]);
  const name = masked.search(/[«»]/);
  if (name >= 0) found.push([name, "«» names are not allowed in the editable regions"]);
  const problems = found.sort((x, y) => x[0] - y[0]).map(([, problem]) => problem);
  if (unclosed || leavesCommentOpen(masked)) problems.push("a block comment is not closed");
  return { masked, problems };
}

/**
 * Whether Lean, reading a comment from each `/-` that the scan left in the text, would find one that the
 * text does not close. Such a comment would reach into what follows the region: the next region, the
 * check commands. It is read as Lean's `whitespace` reads it (the character after `/-` belongs to the
 * opener; a doc comment, `/--` or `/-!`, has white space and then a raw body), from the first opener on
 * and again from the first one after the end of each comment.
 */
function leavesCommentOpen(masked: string): boolean {
  for (let at = masked.indexOf("/-"); at >= 0; at = masked.indexOf("/-", at)) {
    const end = commentEnd(masked, at);
    if (end < 0) return true;
    at = end;
  }
  return false;
}

/** The offset after the comment that opens at `at` (a `/-`), or -1 when the text ends first. */
function commentEnd(text: string, at: number): number {
  const third = text[at + 2];
  if (third !== "-" && third !== "!") return finishComment(text, at + 2 + (third === undefined ? 0 : String.fromCodePoint(text.codePointAt(at + 2) as number).length));
  // A doc comment: white space follows its token, line comments and block comments in it, and then the raw body.
  let from = at + 3;
  for (;;) {
    const c = text[from];
    if (c === " " || c === "\n") from++;
    else if (c === "-" && text[from + 1] === "-") while (from < text.length && text[from] !== "\n") from++;
    else if (c === "/" && text[from + 1] === "-" && text[from + 2] !== "-" && text[from + 2] !== "!") {
      from = commentEnd(text, from);
      if (from < 0) return -1;
    } else return finishComment(text, from);
  }
}

/** The offset after the `-/` that closes a comment of one level that is open at `from`, or -1. Nested `/-` open levels. */
function finishComment(text: string, from: number): number {
  let level = 1;
  for (let i = from; i < text.length; ) {
    if (text[i] === "-" && text[i + 1] === "/") {
      i += 2;
      if (--level === 0) return i;
    } else if (text[i] === "/" && text[i + 1] === "-") {
      i += 2;
      level++;
    } else i++;
  }
  return -1;
}

/**
 * The forbidden tokens that a piece of Lean text holds, in the order of the list, `sorry` and
 * `admit` included. The text has its comments blanked already, and for a text that a model wrote
 * that is the strict reading: `scanRegion(text).masked`, or `maskCommentsAndStrings` with the option
 * `strict`. `structuralCheck` applies this to the editable regions; code that writes text from a model
 * into a Lean file of its own applies it to that text, and refuses a `--` or `/-` that the mask leaves
 * in it. After a `'` that may start a character literal no run of letters is taken for a name
 * (`holdsToken`).
 */
export function forbiddenTokensIn(masked: string): string[] {
  // `_root_.Lean.Meta` must not slip past the token boundary.
  const text = masked.replace(/_root_\./g, " ");
  const literal = firstCharacterLiteral(text);
  return FORBIDDEN_PATTERNS.filter(([, patterns]) => holdsToken(text, patterns, literal)).map(([token]) => token);
}

/** Checks the two regions without Lean. Returns the reasons the submission is refused. */
export function structuralCheck(submission: Submission, policy: ValidationPolicy = DEFAULT_POLICY): string[] {
  const reasons: string[] = [];
  const scans = { aux: scanRegion(submission.aux), proof: scanRegion(submission.proof) };
  for (const [region, scan] of Object.entries(scans)) {
    for (const problem of scan.problems) reasons.push(`${region}: ${problem}`);
    for (const token of forbiddenTokensIn(scan.masked)) {
      if (policy.holes && HOLE_TOKENS.includes(token)) continue;
      reasons.push(`${region}: '${token}' is not allowed`);
    }
  }
  if (scans.proof.masked.trim() === "") reasons.push("proof: the proof is empty");

  for (const command of splitCommands(submission.aux)) {
    if (command.kind !== "code") continue;
    let text = scanRegion(command.text).masked;
    for (;;) {
      const scoped = /^\s*(?:open\s[^\n]*?\sin|set_option\s+\S+\s+\S+\s+in)\s+/.exec(text);
      if (!scoped) break;
      text = text.slice(scoped[0].length);
    }
    const head = readDeclarationHead(text);
    if (!head || !AUX_KEYWORDS.has(head.keyword)) {
      const first = text.trim().split(/\s+/)[0] ?? "";
      reasons.push(`aux: only theorem, lemma, def and abbrev are allowed here, found '${first}'`);
      continue;
    }
    if (!policy.auxNamePattern.test(head.name)) {
      reasons.push(`aux: name '${head.name}' must start with 'aux_'`);
    }
    for (const attr of attributesOf(text)) {
      if (!policy.auxAttributes.includes(attr)) reasons.push(`aux: attribute '${attr}' is not allowed`);
    }
  }
  return reasons;
}

function attributesOf(masked: string): string[] {
  const attrs: string[] = [];
  const re = /@\[([^\]]*)\]/g;
  for (;;) {
    const m = re.exec(masked);
    if (m === null) break;
    for (const part of (m[1] as string).split(",")) attrs.push(part.trim().split(/\s+/).join(" "));
  }
  return attrs;
}

/**
 * Appended after the file: the axioms of the target, then its fully elaborated type. `pp.maxSteps`
 * is raised so that a large statement is never printed with `⋯` in place of a subterm.
 */
export function checkCommands(fullName: string): string {
  return (
    `\n\n#print axioms ${fullName}\n` +
    `set_option pp.all true in\nset_option pp.maxSteps 100000000 in\n#check @${fullName}\n`
  );
}

interface Interpreted {
  errors: LeanMessage[];
  messages: LeanMessage[];
  sorries: LeanSorry[];
  axioms: string[] | undefined;
  ppType: string | undefined;
}

/** Splits Lean's messages between the prover's file (lines 1..fileLines) and the check commands. */
function interpret(result: LeanCheckResult, fileLines: number, fullName: string): Interpreted {
  let axioms: string[] | undefined;
  const types: string[] = [];
  const messages: LeanMessage[] = [];
  for (const message of result.messages) {
    if (message.pos.line <= fileLines) {
      messages.push(message);
      continue;
    }
    if (message.severity === "info") {
      const parsed = message.pos.line === fileLines + 2 ? parseAxiomsMessage(message.text, fullName) : undefined;
      if (parsed !== undefined) {
        axioms = parsed;
        continue;
      }
      if (message.pos.line >= fileLines + 3) {
        types.push(message.text.trim());
        continue;
      }
    }
    messages.push(message);
  }
  return {
    errors: messages.filter((m) => m.severity === "error"),
    messages,
    sorries: result.sorries.filter((s) => s.pos.line <= fileLines),
    axioms,
    ppType: types.length === 1 ? types[0] : undefined,
  };
}

export interface Reference {
  fullName: string;
  ppType: string;
}

/** Lean gave no answer for a file: the server failed, the REPL crashed, or the time limit passed. */
export class CheckFailedError extends Error {
  readonly status: LeanCheckResult["status"];

  constructor(status: LeanCheckResult["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export interface ValidationReport {
  verdict: "valid" | "invalid";
  /** `repl`: the fast check, whose `valid` makes a candidate. Certification is reported apart. */
  method: "repl";
  reasons: string[];
  axioms: string[];
  /** Lean messages located in the prover's file (errors, warnings, infos). */
  messages: LeanMessage[];
  sorries: LeanSorry[];
  /** The file that was checked, as the prover should see it. */
  checked: string;
  submissionHash: string;
  /** True when the prover changed text outside the editable regions (those edits are discarded). */
  editsOutsideRegions: boolean;
  /** True when the regions hold `sorry` or `admit`: a sketch, checked for its goals, never valid. */
  holes: boolean;
  leanStatus?: LeanCheckResult["status"];
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/**
 * The trust anchor of the harness, in two levels. `validate` accepts a proof when it stays inside
 * the editable regions, passes the structural checks, Lean accepts the file, the target uses only
 * the allowed axioms (no `sorryAx`) and its fully elaborated type is the original's. That makes a
 * candidate (claim status `computed`). `certify` hands a candidate to a `LeanCertifier`, whose
 * verdict alone can make the claim `proved`.
 */
export class ProofValidator {
  readonly checker: LeanChecker;
  readonly policy: ValidationPolicy;
  readonly certifier: LeanCertifier | undefined;

  constructor(checker: LeanChecker, options: { policy?: ValidationPolicy; certifier?: LeanCertifier } = {}) {
    this.checker = checker;
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.certifier = options.certifier;
  }

  /** Elaborates the original file once to record the target's type. Fails if the file is broken. */
  async reference(sketch: Sketch, originalSource: string, options: { signal?: AbortSignal } = {}): Promise<Reference> {
    const code = originalSource + checkCommands(sketch.fullName);
    const [result] = await this.checker.check([{ id: `ref:${sketch.fullName}`, code }], {
      timeoutSec: this.policy.timeoutSec,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!result) throw new Error("Lean checker returned no result");
    if (result.error !== undefined) throw new CheckFailedError(result.status, `reference check failed: ${result.status}: ${result.error}`);
    const seen = interpret(result, lineCount(originalSource), sketch.fullName);
    if (seen.errors.length > 0) {
      const errors = seen.errors.map((e) => `${e.pos.line}: ${e.text}`).join("; ");
      throw new Error(`the original file does not compile: ${errors}`);
    }
    if (seen.ppType === undefined) throw new Error(`could not read the type of ${sketch.fullName}`);
    return { fullName: sketch.fullName, ppType: seen.ppType };
  }

  async validate(
    sketch: Sketch,
    submitted: string,
    reference: Reference,
    options: { signal?: AbortSignal } = {},
  ): Promise<ValidationReport> {
    const submissionHash = sha256Hex(submitted);
    let submission: Submission;
    let editsOutsideRegions: boolean;
    try {
      submission = extractSubmission(submitted);
      editsOutsideRegions = editedOutsideRegions(sketch, submitted);
    } catch (error) {
      if (!(error instanceof SketchError)) throw error;
      return {
        verdict: "invalid", method: "repl", reasons: [error.message], axioms: [], messages: [], sorries: [],
        checked: submitted, submissionHash, editsOutsideRegions: false, holes: false,
      };
    }
    const checked = assemble(sketch, submission);
    const holes = hasHoles(submission);
    const reasons = structuralCheck(submission, this.policy);
    // A refused submission never reaches Lean: nothing in it runs.
    if (reasons.length > 0) {
      return {
        verdict: "invalid", method: "repl", reasons, axioms: [], messages: [], sorries: [], checked,
        submissionHash, editsOutsideRegions, holes,
      };
    }

    const id = `chk:${submissionHash.slice(0, 16)}`;
    const [result] = await this.checker.check([{ id, code: checked + checkCommands(sketch.fullName) }], {
      timeoutSec: this.policy.timeoutSec,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!result) throw new Error("Lean checker returned no result");
    if (result.error !== undefined) {
      reasons.push(`lean: ${result.status}: ${result.error}`);
      return {
        verdict: "invalid", method: "repl", reasons, axioms: [], messages: [], sorries: [], checked,
        submissionHash, editsOutsideRegions, holes, leanStatus: result.status,
      };
    }
    const seen = interpret(result, lineCount(checked), sketch.fullName);
    // Without holes the policies agree: the structural checks were the same, and so is the verdict.
    if (holes) reasons.push("the file still has holes (sorry or admit)");
    if (seen.errors.length > 0) reasons.push(`lean: ${seen.errors.length} error(s)`);
    if (seen.sorries.length > 0) reasons.push(`lean: ${seen.sorries.length} sorry(s) left`);
    const axioms = seen.axioms ?? [];
    if (seen.axioms === undefined) {
      reasons.push(`lean: could not read the axioms of ${sketch.fullName}`);
    } else {
      const extra = seen.axioms.filter((a) => !this.policy.allowedAxioms.includes(a));
      if (extra.length > 0) reasons.push(`lean: ${sketch.fullName} depends on ${extra.join(", ")}`);
    }
    if (seen.ppType === undefined) reasons.push(`lean: could not read the type of ${sketch.fullName}`);
    else if (seen.ppType !== reference.ppType) reasons.push("lean: the statement no longer elaborates to the original type");

    return {
      verdict: reasons.length === 0 ? "valid" : "invalid",
      method: "repl",
      reasons,
      axioms,
      messages: seen.messages,
      sorries: seen.sorries,
      checked,
      submissionHash,
      editsOutsideRegions,
      holes,
      leanStatus: result.status,
    };
  }

  /** Certifies a candidate. Without a certifier, the claim stays a candidate. */
  async certify(
    sketch: Sketch,
    originalSource: string,
    report: ValidationReport,
    options: { signal?: AbortSignal } = {},
  ): Promise<CertificationResult | undefined> {
    if (this.certifier === undefined) return undefined;
    if (report.verdict !== "valid") throw new Error("only a valid candidate can be certified");
    return this.certifier.certify(
      {
        original: originalSource,
        candidate: report.checked,
        target: sketch.fullName,
        allowedAxioms: this.policy.allowedAxioms,
      },
      options,
    );
  }
}
