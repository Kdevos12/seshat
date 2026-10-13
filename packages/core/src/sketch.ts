import { type Command, maskCommentsAndStrings, namespacesAt, readDeclarationHead, splitCommands } from "./lean-source.ts";

export const AUX_BEGIN = "-- HARNESS:AUX:BEGIN (auxiliary lemmas go between this line and HARNESS:AUX:END)";
export const AUX_END = "-- HARNESS:AUX:END";
export const PROOF_BEGIN = "-- HARNESS:PROOF:BEGIN";
export const PROOF_END = "-- HARNESS:PROOF:END";

/**
 * A problem file cut around its target theorem. Only two regions are the prover's: auxiliary
 * declarations right before the target, and the target's tactic proof. Everything else is fixed,
 * so the statement and its context cannot change.
 */
export interface Sketch {
  /** Fully qualified name of the target, for `#print axioms`. */
  fullName: string;
  /** Name as written in the source. */
  declaredName: string;
  prefix: string;
  /** Docstring, attributes and `theorem name : statement := by`. */
  header: string;
  /** The original proof as tactics (normally `sorry`; a term `t` becomes `exact t`), unindented. */
  originalProof: string;
  suffix: string;
  /** Indentation of the tactic block. */
  indent: string;
}

export class SketchError extends Error {}

function qualify(name: string, namespace: readonly string[]): string {
  return name.startsWith("_root_.") ? name.slice("_root_.".length) : [...namespace, name].join(".");
}

/**
 * Cuts `source` around the theorem `target`, given by its full name (`Erdos125.erdos_125`) or, when
 * that is unambiguous, by the name written in the file.
 */
export function prepareSketch(source: string, target: string): Sketch {
  const commands = splitCommands(source);
  const scopes = namespacesAt(commands);
  const found: Array<{ index: number; fullName: string; declaredName: string }> = [];
  for (let k = 0; k < commands.length; k++) {
    const command = commands[k] as Command;
    if (command.kind !== "code") continue;
    const head = readDeclarationHead(command.text);
    if (!head || (head.keyword !== "theorem" && head.keyword !== "lemma")) continue;
    const fullName = qualify(head.name, scopes[k] ?? []);
    if (fullName === target || head.name === target) found.push({ index: k, fullName, declaredName: head.name });
  }
  const exact = found.filter((f) => f.fullName === target);
  const matches = exact.length > 0 ? exact : found;
  if (matches.length === 0) throw new SketchError(`theorem ${target} not found`);
  if (matches.length > 1) throw new SketchError(`theorem ${target} is declared twice; use its full name`);
  const { index, fullName, declaredName } = matches[0] as (typeof found)[number];
  const command = commands[index] as Command;
  let start = command.start;
  const previous = commands[index - 1];
  if (previous?.kind === "docstring") start = previous.start;

  const proofStart = findProofStart(command.text);
  if (proofStart === undefined) throw new SketchError(`theorem ${target}: no proof found after ':='`);
  const headerEnd = command.start + proofStart.end;
  const body = source.slice(headerEnd, command.end);
  const trailing = /\s*$/.exec(body)?.[0] ?? "";
  const proofText = body.slice(0, body.length - trailing.length);
  const indentMatch = /\n([ \t]+)\S/.exec(proofText);
  const indent = indentMatch?.[1] ?? "  ";
  const proof = dedent(proofText.replace(/^[ \t]*\n/, "")).trim();

  return {
    fullName,
    declaredName,
    prefix: source.slice(0, start),
    // A term-mode proof becomes a tactic block, so the prover always writes tactics.
    header: source.slice(start, headerEnd) + (proofStart.tactic ? "" : " by"),
    originalProof: proofStart.tactic || proof === "sorry" ? proof : `exact ${proof}`,
    suffix: trailing + source.slice(command.end),
    indent,
  };
}

const LET_WORDS = new Set(["let", "letI", "have", "haveI"]);
const WORD = /[\p{L}_][\p{L}\p{N}_'!?]*/uy;

/**
 * Where the proof starts: just past the first `:=` at bracket depth 0 that does not belong to a
 * `let`, `letI`, `have` or `haveI` of the statement. With `:= by`, the block must run to the end of
 * the declaration (`tactic`); otherwise the proof is a term.
 */
function findProofStart(text: string): { end: number; tactic: boolean } | undefined {
  const head = readDeclarationHead(text);
  if (head === undefined) return undefined;
  const masked = maskCommentsAndStrings(text);
  let depth = 0;
  let pending = 0;
  for (let i = head.nameEnd; i < masked.length; i++) {
    const c = masked[i] as string;
    if ("([{⟨⦃⟦⁅".includes(c)) depth++;
    else if (")]}⟩⦄⟧⁆".includes(c)) depth--;
    else if (depth !== 0) continue;
    else if (/[\p{L}_]/u.test(c) && !/[\p{L}\p{N}_'.!?]/u.test(masked[i - 1] ?? " ")) {
      WORD.lastIndex = i;
      const word = WORD.exec(masked)?.[0] ?? c;
      if (LET_WORDS.has(word)) pending++;
      i += word.length - 1;
    } else if (c === ":" && masked[i + 1] === "=") {
      if (pending > 0) {
        pending--;
        i++;
        continue;
      }
      const tactic = /^:=\s*by(?![\p{L}\p{N}_'!?])/u.exec(masked.slice(i));
      if (!tactic) return { end: i + 2, tactic: false };
      if (blockReachesEnd(masked, i + tactic[0].length)) return { end: i + tactic[0].length, tactic: true };
      i++;
    }
  }
  return undefined;
}

/**
 * Lean ends a tactic block at the first line indented less than the block's first tactic. The
 * proof's block is the one that runs to the end of the declaration. Columns count code points.
 */
function blockReachesEnd(masked: string, from: number): boolean {
  const offset = masked.slice(from).search(/\S/);
  if (offset < 0) return true;
  const at = from + offset;
  const column = [...masked.slice(masked.lastIndexOf("\n", at - 1) + 1, at)].length;
  return masked
    .slice(at)
    .split("\n")
    .slice(1)
    .every((line) => line.trim() === "" || (/^[ \t]*/.exec(line)?.[0].length ?? 0) >= column);
}

function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(cut)).join("\n");
}

function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : indent + line))
    .join("\n");
}

/** The file the prover edits: the original with the two editable regions marked. */
export function renderSketch(sketch: Sketch, aux = "", proof = sketch.originalProof): string {
  return assemble(sketch, { aux, proof }, true);
}

export interface Submission {
  aux: string;
  proof: string;
}

/**
 * Rebuilds a complete Lean file from the fixed parts and the prover's two regions. With markers,
 * the output has the same lines as the prover's file, so Lean positions match what it sees.
 */
export function assemble(sketch: Sketch, submission: Submission, markers = true): string {
  const aux = submission.aux.trim() === "" ? "" : `${submission.aux.replace(/\s+$/, "")}\n`;
  const proof = indentBlock(dedent(submission.proof.replace(/^\s*\n/, "")).replace(/\s+$/, ""), sketch.indent);
  if (!markers) return `${sketch.prefix}${aux}${aux === "" ? "" : "\n"}${sketch.header}\n${proof}${sketch.suffix}`;
  return (
    `${sketch.prefix}${AUX_BEGIN}\n${aux}${AUX_END}\n${sketch.header}\n` +
    `${sketch.indent}${PROOF_BEGIN}\n${proof}\n${sketch.indent}${PROOF_END}${sketch.suffix}`
  );
}

/** Reads the prover's two regions back from its file. Edits outside them are ignored. */
export function extractSubmission(text: string): Submission {
  const [auxBegin, auxEnd, proofBegin, proofEnd] = markerLines(text);
  const lines = text.split("\n");
  return {
    aux: lines.slice(auxBegin + 1, auxEnd).join("\n"),
    proof: lines.slice(proofBegin + 1, proofEnd).join("\n"),
  };
}

/** True when the file differs from the sketch outside the two regions (those edits are discarded). */
export function editedOutsideRegions(sketch: Sketch, text: string): boolean {
  return outside(text) !== outside(renderSketch(sketch));
}

function outside(text: string): string {
  const [auxBegin, auxEnd, proofBegin, proofEnd] = markerLines(text);
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((_, k) => !((k > auxBegin && k < auxEnd) || (k > proofBegin && k < proofEnd)))
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\s+$/, "");
}

function markerLines(text: string): [number, number, number, number] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const find = (marker: string): number => {
    const hits = lines.flatMap((line, k) => (line.trim() === marker.trim() ? [k] : []));
    if (hits.length !== 1) {
      throw new SketchError(`expected exactly one line '${marker.trim()}', found ${hits.length}; restore the markers`);
    }
    return hits[0] as number;
  };
  const found: [number, number, number, number] = [find(AUX_BEGIN), find(AUX_END), find(PROOF_BEGIN), find(PROOF_END)];
  const [auxBegin, auxEnd, proofBegin, proofEnd] = found;
  if (!(auxBegin < auxEnd && auxEnd < proofBegin && proofBegin < proofEnd)) {
    throw new SketchError("the HARNESS markers are out of order; restore them");
  }
  return found;
}
