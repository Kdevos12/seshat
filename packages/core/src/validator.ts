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
import { readDeclarationHead, splitCommands } from "./lean-source.ts";
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

const IDENTIFIER_CHARACTER = /^[\p{L}\p{N}_'!?]$/u;

/**
 * A regular expression for a token, as Lean's lexer reads it:
 * - A token that starts like an identifier is found as a whole word, not glued to what precedes it
 *   (`xsorry`, `Nat.sorry`, `x1sorry`, which are other names) and not to what follows it
 *   (`sorry_free`). A number before it is a lexeme of its own, so `1sorry` holds `sorry`.
 * - A token that starts with a character no identifier has, such as `#eval`, is read wherever it
 *   stands, since Lean reads `x#eval` as `x` and `#eval`; and the longest token wins, so what follows
 *   it does not matter (`#eval!` is a command too).
 * - A token that ends with such a character (`eval%`) needs no boundary after it.
 */
function tokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const characters = [...token];
  const startsLikeIdentifier = IDENTIFIER_CHARACTER.test(characters[0] ?? "");
  const endsLikeIdentifier = IDENTIFIER_CHARACTER.test(characters.at(-1) ?? "");
  // The second lookbehind lets digits count as part of a name only when a name's character precedes them: `x1sorry`, not `1sorry` or `h.1sorry`.
  const before = startsLikeIdentifier ? "(?<![\\p{L}_'.!?])(?<![\\p{L}_'!?]\\p{N}+)" : "";
  const after = startsLikeIdentifier && endsLikeIdentifier ? "(?![\\p{L}\\p{N}_'!?])" : "";
  return new RegExp(`${before}${escaped}${after}`, "u");
}
const FORBIDDEN_PATTERNS = FORBIDDEN_TOKENS.map((t) => [t, tokenPattern(t)] as const);
const HOLE_PATTERNS = HOLE_TOKENS.map(tokenPattern);

/** Whether a region holds `sorry` or `admit` outside comments. */
export function hasHoles(submission: Submission): boolean {
  return [submission.aux, submission.proof].some((region) => {
    const text = scanRegion(region).masked.replace(/_root_\./g, " ");
    return HOLE_PATTERNS.some((pattern) => pattern.test(text));
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
 * disagrees with Lean about where a comment starts would let tokens hide from the checks.
 */
export function scanRegion(text: string): RegionScan {
  const out = text.split("");
  const problems = new Set<string>();
  const blank = (at: number) => {
    if (out[at] !== "\n") out[at] = " ";
  };
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (depth > 0) {
      if (c === "/" && next === "-") {
        depth++;
        blank(i);
        blank(++i);
      } else if (c === "-" && next === "/") {
        depth--;
        blank(i);
        blank(++i);
      } else {
        blank(i);
      }
      continue;
    }
    if (c === "/" && next === "-") {
      depth = 1;
      blank(i);
      blank(++i);
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      i--;
      continue;
    }
    if (c === '"') problems.add("string literals are not allowed in the editable regions");
    if (c === "«" || c === "»") problems.add("«» names are not allowed in the editable regions");
  }
  if (depth > 0) problems.add("a block comment is not closed");
  return { masked: out.join(""), problems: [...problems] };
}

/**
 * The forbidden tokens that a piece of Lean text holds, in the order of the list, `sorry` and
 * `admit` included. The text has its comments blanked already (`scanRegion(text).masked`, or
 * `maskCommentsAndStrings`). `structuralCheck` applies this to the editable regions; code that writes
 * text from a model into a Lean file of its own applies it to that text.
 */
export function forbiddenTokensIn(masked: string): string[] {
  // `_root_.Lean.Meta` must not slip past the token boundary.
  const text = masked.replace(/_root_\./g, " ");
  return FORBIDDEN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([token]) => token);
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
