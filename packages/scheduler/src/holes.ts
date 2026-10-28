import { maskCommentsAndStrings, prepareSketch, readDeclarationHead, splitCommands, type Submission } from "@seshat/core";
import { parseSignature } from "@seshat/graph";

/** A named hole of a sketch: an auxiliary lemma `aux_<name>` whose proof is `sorry`. */
export interface NamedHole {
  /** The lemma's name, such as `aux_bound`. */
  name: string;
  /** Its statement in signature form (the binders, then `:` and the type). */
  statement: string;
  /** The text of the lemma's command in the aux region. */
  text: string;
}

export interface SketchReading {
  holes: NamedHole[];
  /** The aux commands that are not holes, as written (closed lemmas, definitions, `open ... in`). */
  others: string[];
  /** Why the sketch is not one the scheduler can split, or undefined when it is. */
  problem?: string;
}

const SORRY = /(?<![\p{L}\p{N}_'.!?])sorry(?![\p{L}\p{N}_'!?])/u;

function mentions(text: string, names: readonly string[]): string | undefined {
  const masked = maskCommentsAndStrings(text);
  return names.find((name) => new RegExp(`(?<![\\p{L}\\p{N}_'.!?])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'!?])`, "u").test(masked));
}

/**
 * Reads a prover's submission as a sketch: the named holes of its aux region (lemmas named `aux_...`
 * whose whole proof is `sorry`), and whether the rest is something the scheduler can split off.
 * A sketch is split when it has at least one hole; its main proof has no `sorry` of its own (an
 * anonymous hole belongs to no subgoal); no hole's statement, and no other aux command, names a
 * hole (a lemma that rests on a hole cannot be lifted out of the file: the link lemma of the
 * decomposition could not state it); and every hole's statement is in signature form.
 */
export function readSketch(submission: Submission): SketchReading {
  const holes: NamedHole[] = [];
  const others: string[] = [];
  const problems: string[] = [];
  for (const command of splitCommands(submission.aux)) {
    if (command.kind !== "code") continue;
    const text = command.text.trimEnd();
    const head = readDeclarationHead(text);
    if (head === undefined || (head.keyword !== "theorem" && head.keyword !== "lemma") || !head.name.startsWith("aux_")) {
      others.push(text);
      continue;
    }
    try {
      const sketch = prepareSketch(text, head.name);
      if (sketch.originalProof.trim() === "sorry") {
        parseSignature(sketch.statement);
        holes.push({ name: head.name, statement: sketch.statement, text });
        continue;
      }
    } catch (error) {
      problems.push(`${head.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    others.push(text);
  }
  const reading = (problem?: string): SketchReading => ({ holes, others, ...(problem !== undefined ? { problem } : {}) });
  if (problems.length > 0) return reading(problems[0] as string);
  if (holes.length === 0) return reading("no named hole");
  if (SORRY.test(maskCommentsAndStrings(submission.proof))) return reading("the main proof has a sorry of its own");
  const names = holes.map((h) => h.name);
  for (const hole of holes) {
    const used = mentions(hole.statement, names);
    if (used !== undefined) return reading(`the statement of ${hole.name} names ${used}`);
  }
  for (const other of others) {
    const used = mentions(other, names);
    if (used !== undefined) return reading(`an auxiliary declaration rests on the hole ${used}`);
  }
  return reading();
}

/**
 * The proof of the link lemma `(hole 1) -> ... -> (hole n) -> (theorem)` of a sketch, as a
 * `validate` request: the sketch's other aux commands, and a main proof that introduces the holes as
 * hypotheses under the lemmas' own names. The sketch checked with only its named holes open, so
 * with each hole supplied as a hypothesis its main proof closes the theorem. `binders` are the
 * theorem's binders as written (`parseSignature(statement).binders`): `refine fun <binders> => ?_`
 * introduces them under their own names, implicit and instance binders included.
 */
export function linkProof(submission: Submission, reading: SketchReading, binders: string): { aux: string; proof: string } {
  const hyps = reading.holes.map((_, k) => `h_aux_${k + 1}`);
  const prelude = [
    `intro ${hyps.join(" ")}`,
    ...(binders.trim() !== "" ? [`refine fun ${binders.trim()} => ?_`] : []),
    ...reading.holes.map((hole, k) => `have ${hole.name} := ${hyps[k]}`),
  ];
  return { aux: reading.others.join("\n\n"), proof: [...prelude, submission.proof.replace(/\s+$/, "")].join("\n") };
}
