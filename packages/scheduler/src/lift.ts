import { maskCommentsAndStrings, type Submission, type ValidationReport } from "@seshat/core";
import { parseSignature } from "@seshat/graph";

/**
 * Lifting the steps of a proof into lemmas (plan change DP1, DP2): a proof that states its steps as `have h_k : T_k := by sorry` becomes a blueprint
 * of holes, one `aux_h_k` lemma per step, with Lean doing the extraction (Mathlib's `extract_goal`, DeepSeek-Prover-V2's rule: each subgoal is a
 * standalone lemma whose hypotheses are the local context, the earlier steps included). The text is never parsed for a context: the lemma's statement is
 * what Lean printed, so a step inside a `cases` branch, or one whose type mentions an `intro`'d variable, needs nothing more than a step in the main proof.
 * Nothing here sets a status: a lifted statement that does not compile fails the file's check, and a hole is `open` until `validate` accepts its proof.
 */

/** A `have name : T := body` of a proof, at any depth. All offsets are into the proof text. */
export interface HaveStep {
  name: string;
  /** Where `have` starts. */
  start: number;
  /** The statement `T`: from after the colon to the `:=`. */
  typeFrom: number;
  typeTo: number;
  /** The body: from after the `:=` to the end of the step (the rest of its line, and the lines under it that are blank or deeper than the `have`). */
  bodyFrom: number;
  bodyTo: number;
}

const HAVE = /(?<![\p{L}\p{N}_'.])have\s+([\p{L}_][\p{L}\p{N}_'.]*)\s*:(?!=)/gu;

/** The offset of the first `:=` outside brackets at or after `from`, or undefined. */
function assignment(masked: string, from: number): number | undefined {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i] as string;
    if ("([{⟨⦃⟦".includes(c)) depth++;
    else if (")]}⟩⦄⟧".includes(c)) depth--;
    else if (depth === 0 && c === ":" && masked[i + 1] === "=") return i;
  }
  return undefined;
}

/**
 * The named steps `have name : T := ...` of a proof, in source order, at any depth (a bullet, a `cases` branch, an `induction` case). A `have` with no
 * name or no type (`have : T`, `have h := t`, `have h (x : A) : T`) is not a step.
 */
export function haveSteps(proof: string): HaveStep[] {
  const masked = maskCommentsAndStrings(proof);
  const lines = proof.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const steps: HaveStep[] = [];
  for (const m of masked.matchAll(HAVE)) {
    const start = m.index;
    const typeFrom = start + m[0].length;
    const assign = assignment(masked, typeFrom);
    if (assign === undefined) continue;
    const lineIndex = starts.findLastIndex((s) => s <= start);
    const column = start - (starts[lineIndex] as number);
    let last = lineIndex;
    // The step continues over the lines under it: blank, or indented deeper than the `have` itself.
    for (let k = lineIndex + 1; k < lines.length; k++) {
      const line = lines[k] as string;
      if (line.trim() === "") continue;
      if (((/^[ \t]*/.exec(line)?.[0] ?? "").length) > column) last = k;
      else break;
    }
    const bodyTo = Math.max(assign + 2, (starts[last] as number) + (lines[last] as string).replace(/\s+$/, "").length);
    steps.push({ name: m[1] as string, start, typeFrom, typeTo: assign, bodyFrom: assign + 2, bodyTo });
  }
  return steps;
}

/** The steps whose whole proof is `sorry` (`by sorry`, or the term `sorry`): the ones to lift. */
export function sorrySteps(proof: string): HaveStep[] {
  const masked = maskCommentsAndStrings(proof);
  return haveSteps(proof).filter((step) => /^(?:by\s+)?sorry$/.test(masked.slice(step.bodyFrom, step.bodyTo).trim()));
}

/** The proof with the bodies of these steps replaced, each by its text (a leading space is added: the text follows the `:=`). */
export function replaceBodies(proof: string, replacements: ReadonlyArray<{ step: HaveStep; body: string }>): string {
  let out = proof;
  for (const { step, body } of [...replacements].sort((a, b) => b.step.bodyFrom - a.step.bodyFrom)) out = `${out.slice(0, step.bodyFrom)} ${body}${out.slice(step.bodyTo)}`;
  return out;
}

/** What `liftHaves` is given: a Lean check of a file with holes, and, when the run has it, the classical battery on a checked file's `sorry` (`closeSorries` of the orchestrator). */
export interface LiftDeps {
  /** Checks regions on the problem's own file, as a prover's `lean_check` does (`ProblemContext.checkSketch`). */
  check: (submission: Submission) => Promise<ValidationReport>;
  /** The battery: the regions with the `sorry` it closed, or undefined when it closed none. Needs the report of the file it is given. */
  battery?: (submission: Submission, report: ValidationReport) => Promise<Submission | undefined>;
}

export interface LiftInput {
  aux: string;
  /** The proof to lift: its steps are `have h_k : T_k := by sorry` (a step that Lean has not closed). */
  proof: string;
  /** The check of `{ aux, proof }`, for the battery. Absent: the battery is not run. */
  report?: ValidationReport;
}

/** What `liftHaves` made: the regions, how many steps the battery closed, the names of the lemmas the others became, and the check of the returned file when one was made. */
export type Lift = { aux: string; proof: string; closed: number; lifted: string[]; report?: ValidationReport } | { reason: string };

const errorsOf = (report: ValidationReport): ValidationReport["messages"] => report.messages.filter((m) => m.severity === "error");
const firstLine = (text: string): string => (text.split("\n").find((l) => l.trim() !== "") ?? text).replace(/\s+/g, " ").trim().slice(0, 200);

/** The signature of a statement Lean printed (`theorem extracted_1 (n : ℕ) : T := by sorry`), whitespace collapsed; undefined when the text is no such statement. */
function signatureOf(text: string): string | undefined {
  const head = /^\s*(?:theorem|lemma)\s+\S+\s+/.exec(text);
  const tail = /\s*:=\s*by\s+sorry\s*$/.exec(text);
  if (head === null || tail === null || tail.index < head[0].length) return undefined;
  const signature = text.slice(head[0].length, tail.index).replace(/\s+/g, " ").trim();
  try {
    parseSignature(signature);
  } catch {
    return undefined;
  }
  return signature;
}

const wordsOf = (text: string): Set<string> => new Set([...maskCommentsAndStrings(text).matchAll(/[\p{L}_][\p{L}\p{N}_']*/gu)].map((m) => m[0]));

/**
 * Lifts every `have h : T := by sorry` of a proof into an `aux_h` lemma (plan change DP1, DP2), in at most four steps:
 *
 * 1. the battery, when given with the file's report, closes in place the steps that a tactic closes (`closeSorries`);
 * 2. one Lean check of the proof with `extract_goal` at each remaining `sorry`, whose printed statements are the lemmas' (each is renamed `aux_<step>`
 *    and put in the AUX region, with the theorem's binders, the earlier steps and whatever the step is under as its hypotheses, as Lean has them);
 * 3. each step becomes `have h : T := by apply aux_h <;> assumption`, and the file is checked;
 * 4. if that file has an error and every lemma's explicit binders have names, each step becomes `have h : T := aux_h <explicit binders>` and the file is checked
 *    again; the file with the fewer errors is the result.
 *
 * The result's file has no `-- uses:` (each hole carries its context in its statement). `{ reason }` when Lean refused the probe (no `extract_goal`, an error
 * elsewhere in the file) or printed something that is no statement; the caller then keeps what it had. An extracted statement that does not elaborate is not
 * caught here: it is an error in the returned file's report, which the caller's reading of it (a blueprint that is not healthy) sends on to refinement.
 */
export async function liftHaves(deps: LiftDeps, input: LiftInput): Promise<Lift> {
  let sub: Submission = { aux: input.aux, proof: input.proof };
  const before = sorrySteps(sub.proof).length;
  if (deps.battery !== undefined && input.report !== undefined) sub = (await deps.battery(sub, input.report)) ?? sub;
  const steps = sorrySteps(sub.proof);
  const closed = before - steps.length;
  if (steps.length === 0) return { ...sub, closed, lifted: [] };

  const probe = await deps.check({ aux: sub.aux, proof: replaceBodies(sub.proof, steps.map((step) => ({ step, body: "by extract_goal; sorry" }))) });
  if (probe.leanStatus === undefined || probe.leanStatus === "timeout" || probe.leanStatus === "server_error") return { reason: `the extraction was not checked (${probe.reasons[0] ?? probe.leanStatus ?? "refused before Lean"})` };
  const error = errorsOf(probe)[0];
  if (error !== undefined) return { reason: `Lean refused the file with extract_goal: ${firstLine(error.text)}` };
  const printed = probe.messages
    .filter((m) => m.severity === "info" && /^\s*(?:theorem|lemma)\s/.test(m.text))
    .sort((a, b) => a.pos.line - b.pos.line || a.pos.column - b.pos.column);
  if (printed.length !== steps.length) return { reason: `extract_goal printed ${printed.length} statement(s) for ${steps.length} step(s)` };

  const used = wordsOf(sub.aux);
  const lemmas: Array<{ name: string; signature: string; step: HaveStep }> = [];
  for (const [k, step] of steps.entries()) {
    const signature = signatureOf((printed[k] as { text: string }).text);
    if (signature === undefined) return { reason: `extract_goal's statement for ${step.name} is not a statement: ${firstLine((printed[k] as { text: string }).text)}` };
    const base = `aux_${step.name.replace(/\./g, "_")}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    lemmas.push({ name, signature, step });
  }
  const aux = [sub.aux.replace(/\s+$/, ""), ...lemmas.map((l) => `lemma ${l.name} ${l.signature} := by\n  sorry`)].filter((t) => t !== "").join("\n\n");
  const lifted = lemmas.map((l) => l.name);
  const rewrite = (body: (l: (typeof lemmas)[number]) => string): Submission => ({ aux, proof: replaceBodies(sub.proof, lemmas.map((l) => ({ step: l.step, body: body(l) }))) });

  const applied = rewrite((l) => `by apply ${l.name} <;> assumption`);
  const report = await deps.check(applied);
  if (errorsOf(report).length === 0) return { ...applied, closed, lifted, report };
  // The fallback: each lemma applied to its explicit binders, which Lean named as the context's own.
  const explicit = rewrite((l) => [l.name, ...parseSignature(l.signature).args].join(" "));
  if (lemmas.some((l) => parseSignature(l.signature).args.some((a) => a.includes("✝")))) return { ...applied, closed, lifted, report };
  const retry = await deps.check(explicit);
  return errorsOf(retry).length < errorsOf(report).length ? { ...explicit, closed, lifted, report: retry } : { ...applied, closed, lifted, report };
}
