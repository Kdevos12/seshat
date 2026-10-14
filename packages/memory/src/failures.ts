import { prepareSketch, readDeclarationHead, splitCommands, statementIdV0, type ValidationReport } from "@seshat/core";

/**
 * How a check failed, computed from Lean's messages and the report's reasons (plan §3.3). The
 * first four are about the check, not the proof: the rest say what Lean found wrong.
 *
 * - `refused`: the submission never reached Lean (a forbidden token, a marker line).
 * - `lean_unavailable`: Lean could not be reached; nothing was checked.
 * - `timeout`: Lean's time limit, or its heartbeat or recursion limit.
 * - `syntax`: Lean could not parse the proof.
 * - `unknown_identifier`: an identifier, constant or field that does not exist.
 * - `type_mismatch`: a typing error: a type mismatch, a missing instance, a function expected.
 * - `tactic_failed`: a tactic could not do its job (`linarith failed`, `simp made no progress`).
 * - `unsolved_goals`: the proof ends with goals left.
 * - `holes`: no error, but a `sorry` is left.
 * - `axioms`: the theorem depends on an axiom outside the allowed ones.
 * - `statement_changed`: the statement no longer elaborates to the original type.
 * - `restates_target`: an auxiliary lemma states the target again.
 * - `other`: anything else.
 */
export const FAILURE_CLASSES = [
  "refused",
  "lean_unavailable",
  "timeout",
  "syntax",
  "unknown_identifier",
  "type_mismatch",
  "tactic_failed",
  "unsolved_goals",
  "holes",
  "axioms",
  "statement_changed",
  "restates_target",
  "other",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** What the check says nothing of by itself: the submitted auxiliary lemmas and the target. */
export interface FailureContext {
  /** The AUX region of the check. */
  aux?: string;
  /** The target's statement in signature form: the binders, then `:` and the type. */
  statement?: string;
}

export interface Failure {
  class: FailureClass;
  /** A short typed summary, such as `unsolved goals at case succ`. */
  detail: string;
}

/** The classes of Lean's errors, most basic first: when a file has several, the first of these is the cause. */
const ERROR_ORDER: readonly FailureClass[] = ["timeout", "syntax", "unknown_identifier", "type_mismatch", "tactic_failed", "unsolved_goals"];

type Matcher = readonly [FailureClass, RegExp, (m: RegExpExecArray, text: string) => string];

/** Lean's error messages by their first words. Every detail is made of words of this table and names, never of the proof. */
const MATCHERS: readonly Matcher[] = [
  ["timeout", /maximum number of heartbeats|\(deterministic\) timeout|\(kernel\) deterministic timeout/i, () => "heartbeat limit"],
  ["timeout", /maximum recursion depth/i, () => "recursion depth limit"],
  ["syntax", /^(?:unexpected\b|expected\b|unterminated\b|invalid (?:escape|character|syntax)\b|unknown tactic\b)/i, () => "syntax error"],
  ["unknown_identifier", /^unknown (identifier|constant|namespace|declaration)\s+['`]([^'`\s]+)['`]/i, (m) => `unknown ${(m[1] as string).toLowerCase()} ${clip(m[2] as string, 60)}`],
  ["unknown_identifier", /^invalid field\s+['`]([^'`\s]+)['`]/i, (m) => `invalid field ${clip(m[1] as string, 60)}`],
  ["type_mismatch", /^application type mismatch/i, () => "application type mismatch"],
  ["type_mismatch", /^type mismatch/i, () => "type mismatch"],
  ["type_mismatch", /^failed to synthesize/i, () => "failed to synthesize an instance"],
  ["type_mismatch", /^function expected/i, () => "function expected"],
  ["type_mismatch", /^(?:typeclass instance problem is stuck|motive is not type correct|type expected)/i, (m) => (m[0] as string).toLowerCase()],
  ["unsolved_goals", /^unsolved goals/i, (_m, text) => unsolvedGoals(text)],
  ["tactic_failed", /^no goals/i, () => "no goals left"],
  ["tactic_failed", /^tactic '([^']+)' (?:proved that|failed)/i, (m) => `${m[1]} failed`],
  ["tactic_failed", /^The (\S+) tactic failed/i, (m) => `${m[1]} failed`],
  ["tactic_failed", /^failed to reduce/i, () => "decide failed to reduce"],
  ["tactic_failed", /^([A-Za-z_][\w']*)\s+made no progress/i, (m) => `${m[1]} made no progress`],
  ["tactic_failed", /^([A-Za-z_][\w']*):?\s+(?:failed|could not|did not|has failed)/i, (m) => `${m[1]} failed`],
];

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

/** `unsolved goals`, with the names of the goals' cases when Lean gives them: `unsolved goals at case succ`. */
function unsolvedGoals(text: string): string {
  const cases = [...new Set([...text.matchAll(/^case (\S+)/gm)].map((m) => m[1] as string))];
  if (cases.length === 0) return "unsolved goals";
  const shown = cases.slice(0, 3).map((name) => clip(name, 30));
  return `unsolved goals at ${cases.length === 1 ? "case" : "cases"} ${shown.join(", ")}${cases.length > 3 ? ", ..." : ""}`;
}

function classifyError(text: string): Failure {
  const first = text.trim();
  for (const [cls, pattern, detail] of MATCHERS) {
    const m = pattern.exec(first);
    if (m !== null) return { class: cls, detail: detail(m, first) };
  }
  return { class: "other", detail: "unclassified Lean error" };
}

/** The name of an auxiliary lemma whose statement, normalized, is the target's. */
function restatingLemma(aux: string, statement: string): string | undefined {
  const target = statementIdV0(statement);
  for (const command of splitCommands(aux)) {
    if (command.kind !== "code") continue;
    const head = readDeclarationHead(command.text);
    if (head === undefined || head.name === "" || (head.keyword !== "theorem" && head.keyword !== "lemma")) continue;
    try {
      if (statementIdV0(prepareSketch(command.text, head.name).statement) === target) return head.name;
    } catch {
      // A lemma that cannot be cut into a statement and a proof cannot be compared.
    }
  }
  return undefined;
}

/**
 * Classifies a failed check, or returns undefined for a valid one. The class comes from Lean's
 * messages and the report's reasons; `detail` is a short summary made of the class's words and
 * names (`unsolved goals at case succ`, `unknown identifier Nat.foo`), never a piece of the proof.
 * When Lean reports several errors, the most basic one is the cause: a syntax error before an
 * unknown identifier before a type error before a failed tactic before unsolved goals.
 */
export function classifyFailure(report: ValidationReport, context: FailureContext = {}): Failure | undefined {
  if (report.verdict === "valid") return undefined;
  if (report.leanStatus === undefined) return { class: "refused", detail: `refused before Lean: ${clip(report.reasons[0] ?? "no reason given", 100)}` };
  if (report.leanStatus === "server_error" && report.messages.length === 0) return { class: "lean_unavailable", detail: "Lean could not be reached" };
  if (report.leanStatus === "timeout" && report.messages.length === 0) return { class: "timeout", detail: "Lean time limit" };
  if (context.aux !== undefined && context.statement !== undefined) {
    const lemma = restatingLemma(context.aux, context.statement);
    if (lemma !== undefined) return { class: "restates_target", detail: `auxiliary lemma ${clip(lemma, 60)} restates the target` };
  }
  const errors = report.messages.filter((m) => m.severity === "error").map((m) => classifyError(m.text));
  if (errors.length > 0) {
    const rank = (failure: Failure) => {
      const k = ERROR_ORDER.indexOf(failure.class);
      return k < 0 ? ERROR_ORDER.length : k;
    };
    return errors.reduce((best, next) => (rank(next) < rank(best) ? next : best));
  }
  if (report.holes || report.sorries.length > 0) {
    const n = Math.max(report.sorries.length, 1);
    return { class: "holes", detail: n === 1 ? "1 sorry left" : `${n} sorries left` };
  }
  const axioms = report.reasons.map((r) => / depends on (.+)$/.exec(r)?.[1]).find((a) => a !== undefined);
  if (axioms !== undefined) return { class: "axioms", detail: `depends on ${clip(axioms, 80)}` };
  if (report.reasons.some((r) => /original type/.test(r))) return { class: "statement_changed", detail: "statement changed" };
  return { class: "other", detail: clip(report.reasons[0] ?? "no reason given", 100) };
}
