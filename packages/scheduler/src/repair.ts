import { AUX_BEGIN, AUX_END, maskCommentsAndStrings, PROOF_BEGIN, PROOF_END, prepareSketch, readDeclarationHead, splitCommands, type LeanMessage } from "@seshat/core";
import { parseSignature } from "@seshat/graph";

/** What the repair pass reads of a failed check (plan change CA13). */
export interface RepairInput {
  /** The file Lean checked, with the HARNESS markers (`ValidationReport.checked`). */
  checked: string;
  /** Lean's messages: the errors place the cuts. */
  messages: ReadonlyArray<Pick<LeanMessage, "severity" | "pos" | "text">>;
  /** The target theorem's statement in signature form: its binders become the binders of a lifted lemma. */
  target: string;
}

/** The cut file: the two regions with each failing block cut to `sorry`, and one line for each cut (for the log). */
export type Repair = { aux: string; proof: string; cuts: string[] } | { reason: string };

const KEYWORDS = new Set(["fun", "forall", "exists", "if", "then", "else", "let", "in", "by", "at", "with", "from", "match", "do", "have", "show", "Type", "Prop", "Sort"]);

/** The offset of a (1-based line, 0-based column in code points) position in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let k = 0; k < line - 1 && k < lines.length; k++) offset += (lines[k] as string).length + 1;
  return offset + Array.from(lines[line - 1] ?? "").slice(0, column).join("").length;
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;
const words = (text: string): string[] => [...maskCommentsAndStrings(text).matchAll(/[\p{L}_][\p{L}\p{N}_']*/gu)].map((m) => m[0]);

/** The text up to the first `:=` outside brackets: its offset, or undefined. `from` is where to start looking. */
function assignment(masked: string, from = 0): number | undefined {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i] as string;
    if ("([{⟨⦃⟦".includes(c)) depth++;
    else if (")]}⟩⦄⟧".includes(c)) depth--;
    else if (depth === 0 && c === ":" && masked[i + 1] === "=") return i;
  }
  return undefined;
}

/** The names bound by the theorem's binders (`(n m : ℕ) {x : α} [inst : C]`), for the check that a lifted statement uses nothing else. */
function binderWords(binders: string): Set<string> {
  const names = new Set<string>();
  for (const group of binders.matchAll(/[([{⟨⦃]([^:)\]}⟩⦄]*):/gu)) for (const w of words(group[1] as string)) names.add(w);
  return names;
}

/**
 * The repair pass's cut (plan change CA13, APOLLO's sorrifier): each failing block of a file Lean checked with errors becomes `sorry`, with no model
 * and no Lean. It is all or nothing: one error that cannot be cut gives `{ reason }` and no repair. Handled (documentation/scheduler.md, "The repair pass"):
 *
 * - an `aux_` lemma or theorem of the AUX region whose proof holds an error: its whole proof becomes `:= by sorry`, its statement unchanged;
 * - in the PROOF region, a top-level `have name : T := ...` (by a block or a term, over one or several lines) that holds an error: it is lifted
 *   into a new `aux_name` hole of the theorem's binders and `T`, and the `have` becomes `have name : T := aux_name <binders>`. Only when `T` mentions
 *   nothing the proof bound before it (no earlier name but the theorem's binders and the names a dotted path qualifies).
 *
 * Not handled, so no repair: an error in a statement (of a lemma or of a `have`), in the fixed part of the file, in a declaration that is not an `aux_`
 * lemma or theorem, in the main proof outside a top-level `have`, a `have` with no type (`have : T`, `have h (x : A) : T`), a `have` that is not at the
 * main proof's own indentation, or one whose statement mentions what an earlier step bound.
 */
export function cutFailures(input: RepairInput): Repair {
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
      const assign = assignment(maskCommentsAndStrings(command.text), head.nameEnd);
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

  // The PROOF region: top-level `have`s that hold an error are lifted.
  let proof = proofText;
  if (failingProof.length > 0) {
    const proofLines = proofText.split("\n");
    const starts: number[] = [];
    let offset = 0;
    for (const line of proofLines) {
      starts.push(offset);
      offset += line.length + 1;
    }
    const body = proofLines.filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
    if (body.length === 0) return { reason: "the main proof is empty" };
    const base = Math.min(...body.map(indentOf));
    // The steps of the main proof: a line at the base indentation and the lines under it.
    const steps: Array<{ from: number; to: number }> = [];
    for (const [k, line] of proofLines.entries()) {
      if (line.trim() !== "" && !line.trim().startsWith("--") && indentOf(line) === base) steps.push({ from: k, to: k });
      else if (steps.length > 0) (steps.at(-1) as { to: number }).to = k;
    }
    const signature = (() => {
      try {
        return parseSignature(input.target);
      } catch {
        return undefined;
      }
    })();
    if (signature === undefined) return { reason: "the target is not in signature form" };
    const bound = binderWords(signature.binders);
    const usedNames = new Set(words(auxText));
    const lifted = new Map<number, { have: string; name: string; type: string; text: string }>();
    for (const offsetInProof of failingProof) {
      const lineIndex = starts.findLastIndex((s) => s <= offsetInProof);
      const stepIndex = steps.findIndex((s) => s.from <= lineIndex && lineIndex <= s.to);
      const step = steps[stepIndex];
      if (step === undefined) return { reason: "an error in the main proof outside any have" };
      if (lifted.has(stepIndex)) continue;
      const text = proofLines.slice(step.from, step.to + 1).join("\n").replace(/\s+$/, "");
      const masked = maskCommentsAndStrings(text);
      const head = /^\s*have\s+([\p{L}_][\p{L}\p{N}_'.]*)\s*:(?!=)/u.exec(masked);
      if (head === null) return { reason: "an error in the main proof outside a top-level have with a name and a type" };
      const assign = assignment(masked, head[0].length);
      if (assign === undefined) return { reason: `the have ${head[1]} has no := at its top level` };
      const stepOffset = starts[step.from] as number;
      if (offsetInProof - stepOffset < assign) return { reason: `the error is in the statement of the have ${head[1]}` };
      const type = text.slice(head[0].length, assign).replace(/\s+/g, " ").trim();
      if (type === "") return { reason: `the have ${head[1]} has no statement` };
      const before = new Set(words(proofLines.slice(0, step.from).join("\n")));
      const foreign = words(type).find((w) => !KEYWORDS.has(w) && !bound.has(w) && before.has(w));
      if (foreign !== undefined) return { reason: `the statement of the have ${head[1]} mentions ${foreign}, which the main proof bound before it` };
      lifted.set(stepIndex, { have: head[1] as string, name: "", type, text });
    }
    const added: string[] = [];
    const replaced = proofLines.slice();
    for (const [stepIndex, item] of [...lifted.entries()].sort((a, b) => b[0] - a[0])) {
      const step = steps[stepIndex] as { from: number; to: number };
      let name = `aux_${item.have.replace(/\./g, "_")}`;
      for (let n = 2; usedNames.has(name); n++) name = `aux_${item.have.replace(/\./g, "_")}_${n}`;
      usedNames.add(name);
      const call = [name, ...signature.args].join(" ");
      replaced.splice(step.from, step.to - step.from + 1, `${" ".repeat(base)}have ${item.have} : ${item.type} := ${call}`);
      added.unshift(`lemma ${name} ${signature.binders === "" ? "" : `${signature.binders} `}: ${item.type} := by\n  sorry`);
      cuts.push(`${item.have}: lifted into the hole ${name}`);
    }
    proof = replaced.join("\n");
    aux = [aux.replace(/\s+$/, ""), ...added].filter((t) => t !== "").join("\n\n");
  }
  if (cuts.length === 0) return { reason: "nothing to cut" };
  return { aux: aux.replace(/\s+$/, ""), proof: proof.replace(/\s+$/, ""), cuts };
}
