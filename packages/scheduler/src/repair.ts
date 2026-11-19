import { AUX_BEGIN, AUX_END, maskCommentsAndStrings, PROOF_BEGIN, PROOF_END, prepareSketch, readDeclarationHead, splitCommands, type LeanMessage, type ValidationReport } from "@seshat/core";
import { assignmentOffset, haveSteps, type HaveStep, liftHaves, type LiftDeps, replaceBodies, sorrySteps } from "./lift.ts";

/** What the repair pass reads of a failed check (plan change CA13). */
export interface RepairInput {
  /** The file Lean checked, with the HARNESS markers (`ValidationReport.checked`). */
  checked: string;
  /** Lean's messages: the errors place the cuts. */
  messages: ReadonlyArray<Pick<LeanMessage, "severity" | "pos" | "text">>;
}

/**
 * The cut file: the two regions with each failing block cut to `sorry` (a failing `have`, lifted into a hole by `liftHaves`), and one line for each cut (for
 * the log). `report` is the Lean check of this file when the lift made one, so that the caller need not check it again.
 */
export type Repair = { aux: string; proof: string; cuts: string[]; report?: ValidationReport } | { reason: string };

/** The offset of a (1-based line, 0-based column in code points) position in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let k = 0; k < line - 1 && k < lines.length; k++) offset += (lines[k] as string).length + 1;
  return offset + Array.from(lines[line - 1] ?? "").slice(0, column).join("").length;
}

/**
 * The repair pass's cut (plan change CA13, APOLLO's sorrifier; DP2): each failing block of a file Lean checked with errors becomes `sorry`. It is all or
 * nothing: one error that cannot be cut gives `{ reason }` and no repair. Handled (documentation/scheduler.md, "The repair pass"):
 *
 * - an `aux_` lemma or theorem of the AUX region whose proof holds an error: its whole proof becomes `:= by sorry`, its statement unchanged (no Lean);
 * - in the PROOF region, a named `have name : T := ...` at any depth (a bullet, a `cases` branch, a statement that mentions an `intro`'d variable) whose
 *   proof holds an error: its proof is cut to `sorry` and `liftHaves` (`lift.ts`) lifts it into an `aux_name` hole, with Lean's `extract_goal` stating the
 *   hole in its context: one Lean check, through `lift.check`, and one more for the lifted file, which is returned as `report`.
 *
 * Not handled, so no repair: an error in a statement (of a lemma or of a `have`), in the fixed part of the file, in a declaration that is not an `aux_`
 * lemma or theorem, in the main proof outside a named `have` with a type (`have : T`, `have h := t`, `have h (x : A) : T` are not steps), or a lift
 * that `liftHaves` refuses.
 */
export async function cutFailures(input: RepairInput, lift: LiftDeps): Promise<Repair> {
  const lines = input.checked.split("\n");
  const at = (marker: string): number => lines.findIndex((l) => l.trim() === marker.trim());
  const [auxBegin, auxEnd, proofBegin, proofEnd] = [at(AUX_BEGIN), at(AUX_END), at(PROOF_BEGIN), at(PROOF_END)];
  if (auxBegin < 0 || auxEnd < auxBegin || proofBegin < auxEnd || proofEnd < proofBegin) return { reason: "the checked file has no regions" };
  const auxText = lines.slice(auxBegin + 1, auxEnd).join("\n");
  const proofText = lines.slice(proofBegin + 1, proofEnd).join("\n");
  const errors = input.messages.filter((m) => m.severity === "error");
  if (errors.length === 0) return { reason: "no Lean error" };

  const failingAux = new Set<number>();
  const failingProof: number[] = [];
  for (const error of errors) {
    const index = error.pos.line - 1;
    if (index > auxBegin && index < auxEnd) failingAux.add(offsetOf(auxText, index - auxBegin, error.pos.column));
    else if (index > proofBegin && index < proofEnd) failingProof.push(offsetOf(proofText, index - proofBegin, error.pos.column));
    else return { reason: "an error in the fixed part of the file" };
  }

  const cuts: string[] = [];
  // The AUX region: a command that holds an error becomes a hole.
  let aux = auxText;
  const commands = splitCommands(auxText);
  const cutCommands = new Map<number, string>();
  for (const offset of failingAux) {
    const k = commands.findIndex((c) => c.start <= offset && offset < c.end);
    const command = commands[k];
    if (command === undefined || command.kind !== "code") return { reason: "an error in the AUX region outside any declaration" };
    const head = readDeclarationHead(command.text);
    if (head === undefined || (head.keyword !== "theorem" && head.keyword !== "lemma") || !head.name.startsWith("aux_")) {
      return { reason: `an error in the AUX region in a declaration that is not an aux_ lemma or theorem` };
    }
    try {
      const sketch = prepareSketch(command.text, head.name);
      // The proof starts at the first `:=`; an error before it is in the statement.
      const assign = assignmentOffset(maskCommentsAndStrings(command.text), head.nameEnd);
      if (assign === undefined || offset - command.start < assign) return { reason: `the error is in the statement of ${head.name}` };
      cutCommands.set(k, `${sketch.header}\n  sorry`);
      if (!cuts.some((c) => c.startsWith(`${head.name}:`))) cuts.push(`${head.name}: the proof cut to sorry`);
    } catch (error) {
      return { reason: `${head.name} cannot be cut: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  for (const [k, text] of [...cutCommands.entries()].sort((a, b) => b[0] - a[0])) {
    const command = commands[k] as (typeof commands)[number];
    const original = auxText.slice(command.start, command.end);
    aux = `${aux.slice(0, command.start)}${text}${/\s*$/.exec(original)?.[0] ?? ""}${aux.slice(command.end)}`;
  }

  // The PROOF region: the named `have`s that hold an error are cut to `sorry` and lifted into holes.
  let proof = proofText;
  let report: ValidationReport | undefined;
  if (failingProof.length > 0) {
    const steps = haveSteps(proofText);
    const failing = new Set<HaveStep>();
    for (const offset of failingProof) {
      // The innermost step that holds the error: the latest `have` that starts before it and ends after it.
      const step = steps.filter((x) => x.start <= offset && offset < x.bodyTo).at(-1);
      if (step === undefined) return { reason: "an error in the main proof outside a have with a name and a type" };
      if (offset < step.bodyFrom) return { reason: `the error is in the statement of the have ${step.name}` };
      failing.add(step);
    }
    // A step inside another that fails is cut with it.
    const cutSteps = [...failing].filter((x) => ![...failing].some((y) => y !== x && y.start <= x.start && x.bodyTo <= y.bodyTo));
    const cutProof = replaceBodies(proofText, cutSteps.map((step) => ({ step, body: "by sorry" })));
    const lifted = await liftHaves(lift, { aux, proof: cutProof });
    if ("reason" in lifted) return { reason: `the failing have cannot be lifted: ${lifted.reason}` };
    const names = sorrySteps(cutProof).map((step) => step.name);
    for (const [k, name] of lifted.lifted.entries()) cuts.push(`${names[k] ?? "a step"}: lifted into the hole ${name}`);
    aux = lifted.aux;
    proof = lifted.proof;
    report = lifted.report;
  }
  if (cuts.length === 0) return { reason: "nothing to cut" };
  return { aux: aux.replace(/\s+$/, ""), proof: proof.replace(/\s+$/, ""), cuts, ...(report !== undefined ? { report } : {}) };
}
