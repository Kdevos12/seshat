/**
 * What the harness needs from a Lean checker. Implementations (Kimina Lean Server, a local `lake`,
 * Pantograph...) live outside the core and are chosen through the capability registry.
 */

export type LeanCheckStatus = "valid" | "sorry" | "lean_error" | "repl_error" | "timeout" | "server_error";

export interface LeanPosition {
  line: number;
  column: number;
}

export interface LeanMessage {
  severity: "trace" | "info" | "warning" | "error";
  pos: LeanPosition;
  endPos?: LeanPosition;
  text: string;
}

export interface LeanSorry {
  pos: LeanPosition;
  endPos?: LeanPosition;
  goal: string;
}

export interface LeanSnippet {
  id: string;
  code: string;
}

export interface LeanCheckResult {
  id: string;
  status: LeanCheckStatus;
  messages: LeanMessage[];
  sorries: LeanSorry[];
  timeMs: number;
  /** Set when no Lean answer came back (server or REPL failure, timeout). */
  error?: string;
}

export interface LeanCheckOptions {
  timeoutSec?: number;
  signal?: AbortSignal;
}

export interface LeanChecker {
  /** Implementation id and version, recorded in every ToolRun. */
  readonly implementation: string;
  readonly version: string;
  check(snippets: readonly LeanSnippet[], options?: LeanCheckOptions): Promise<LeanCheckResult[]>;
}

/** Axioms a proof may use. `sorryAx` is never allowed, nor `Lean.ofReduceBool` (native code). */
export const STANDARD_AXIOMS: readonly string[] = ["propext", "Classical.choice", "Quot.sound"];

/**
 * Parses the output of `#print axioms c`:
 * `'c' depends on axioms: [propext, Classical.choice, Quot.sound]` or
 * `'c' does not depend on any axioms`. Returns undefined when the message is something else.
 */
export function parseAxiomsMessage(text: string, constant: string): string[] | undefined {
  const quoted = `'${constant}'`;
  const trimmed = text.trim();
  if (!trimmed.startsWith(quoted) && !trimmed.startsWith(constant)) return undefined;
  if (/does not depend on any axioms/.test(trimmed)) return [];
  const m = /depends on axioms:\s*\[([^\]]*)\]/s.exec(trimmed);
  if (!m) return undefined;
  return (m[1] as string)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export interface CertificationRequest {
  /** The original problem file. The reference statement is elaborated from it. */
  original: string;
  /** The assembled candidate file, without the harness's check commands. */
  candidate: string;
  /** Fully qualified name of the target theorem. */
  target: string;
  allowedAxioms: readonly string[];
}

export interface CertificationResult {
  verdict: "certified" | "rejected";
  reasons: string[];
  axioms: string[];
  timeMs: number;
}

/**
 * The second level of trust. A REPL check reads messages that code running during elaboration
 * could forge, so a proof it accepts is only a candidate. A certifier compiles the candidate in a
 * fresh process, replays every declaration of the compiled module through the kernel, collects the
 * target's axioms itself and compares the target's type with the reference's as terms (the design
 * of lean4checker and SafeVerify). Only a certified proof makes a claim `proved`.
 */
export interface LeanCertifier {
  readonly implementation: string;
  readonly version: string;
  certify(request: CertificationRequest, options?: { signal?: AbortSignal }): Promise<CertificationResult>;
}
