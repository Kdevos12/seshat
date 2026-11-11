import { maskCommentsAndStrings, prepareSketch, readDeclarationHead, splitCommands, statementIdV0, type Submission } from "@seshat/core";
import { parseSignature } from "@seshat/graph";

/** A named hole of a sketch: an auxiliary lemma `aux_<name>` whose proof is `sorry`. */
export interface NamedHole {
  /** The lemma's name, such as `aux_bound`. */
  name: string;
  /** Its statement in signature form (the binders, then `:` and the type). */
  statement: string;
  /** The text of the lemma's command in the aux region. */
  text: string;
  /** The holes it declares it may use (`-- uses: aux_a, aux_b` directly above it). Empty without such a line. */
  uses: string[];
}

/** What reading a sketch may be asked (all off: M12 as it was). */
export interface ReadOptions {
  /** Read the sketch as a blueprint (CA9): holes may depend on each other, and the dependency graph is checked. */
  blueprint?: boolean;
  /** The target's statement in signature form, to refuse a hole that restates it (blueprints only). */
  target?: string;
}

export interface SketchReading {
  holes: NamedHole[];
  /** The aux commands that are not holes, as written (closed lemmas, definitions, `open ... in`). */
  others: string[];
  /** Why the sketch is not one the scheduler can split, or undefined when it is. */
  problem?: string;
  /** `restates_target` when a blueprint is refused because a hole states the target again. */
  failureClass?: "restates_target";
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
export function readSketch(submission: Submission, options: ReadOptions = {}): SketchReading {
  const holes: NamedHole[] = [];
  const others: string[] = [];
  const problems: string[] = [];
  // The `-- uses:` line directly above the next command (no blank line between them).
  let declared: string[] = [];
  for (const command of splitCommands(submission.aux)) {
    if (command.kind === "comment") {
      const trailing = /\s*$/.exec(command.text)?.[0] ?? "";
      const gap = trailing.split("\n").length - 1 > 1;
      const uses = /^--\s*uses:(.*)$/m.exec(command.text.trimEnd());
      if (uses !== null && !gap) declared = [...declared, ...(uses[1] as string).split(/[\s,]+/).filter((n) => n !== "")];
      else if (gap) declared = [];
      continue;
    }
    if (command.kind !== "code") continue;
    const uses = [...new Set(declared)];
    declared = [];
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
        holes.push({ name: head.name, statement: sketch.statement, text, uses });
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
  if (options.blueprint === true) {
    const refused = checkBlueprint(holes, submission.proof, options.target);
    if (refused !== undefined) return { holes, others, ...refused };
  }
  return reading();
}

/** The names a text uses among `names`, in the order of `names`. */
export function namesUsed(text: string, names: readonly string[]): string[] {
  return names.filter((name) => mentions(text, [name]) !== undefined);
}

/**
 * The acceptance of a blueprint's dependency graph (CA9), after Lean checked the file: every name of a `uses` line is a hole of the
 * blueprint; no hole restates the target (the failure class `restates_target`); the graph has no cycle; and every hole reaches the
 * target (the target is the sink: it uses the holes its main proof names, and a hole uses the holes it declares). Returns why the
 * blueprint is refused, or undefined when it is accepted.
 */
export function checkBlueprint(holes: readonly NamedHole[], mainProof: string, target?: string): { problem: string; failureClass?: "restates_target" } | undefined {
  const names = holes.map((h) => h.name);
  for (const hole of holes) {
    for (const used of hole.uses) {
      if (!names.includes(used)) return { problem: `${hole.name} uses ${used}, which is not a hole of this blueprint` };
    }
  }
  if (target !== undefined) {
    const id = statementIdV0(target);
    const restating = holes.find((hole) => statementIdV0(hole.statement) === id);
    if (restating !== undefined) return { problem: `the hole ${restating.name} states the target again, so it decomposes nothing`, failureClass: "restates_target" };
  }
  const cycle = findCycle(holes);
  if (cycle !== undefined) return { problem: `the dependency graph has a cycle: ${cycle.join(" -> ")}` };
  const reached = new Set<string>(namesUsed(mainProof, names));
  for (const queue = [...reached]; queue.length > 0; ) {
    const current = queue.pop();
    for (const used of holes.find((h) => h.name === current)?.uses ?? []) {
      if (!reached.has(used)) {
        reached.add(used);
        queue.push(used);
      }
    }
  }
  const lost = names.find((name) => !reached.has(name));
  if (lost !== undefined) return { problem: `${lost} does not reach the target: no main proof and no hole uses it` };
  return undefined;
}

/** A cycle of the `uses` graph as a path that closes (`aux_a -> aux_b -> aux_a`), or undefined. */
function findCycle(holes: readonly NamedHole[]): string[] | undefined {
  const uses = new Map(holes.map((h) => [h.name, h.uses] as const));
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (name: string): string[] | undefined => {
    if (state.get(name) === "done") return undefined;
    if (state.get(name) === "open") return [...path.slice(path.indexOf(name)), name];
    state.set(name, "open");
    path.push(name);
    for (const used of uses.get(name) ?? []) {
      const found = visit(used);
      if (found !== undefined) return found;
    }
    path.pop();
    state.set(name, "done");
    return undefined;
  };
  for (const hole of holes) {
    const found = visit(hole.name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The holes a hole depends on, all the way down, with the holes themselves last: a dependency order (what a hole uses comes before it).
 * The graph is acyclic (`checkBlueprint`).
 */
export function dependencyOrder(holes: readonly NamedHole[], from: string): string[] {
  const out: string[] = [];
  const visit = (name: string): void => {
    if (out.includes(name)) return;
    for (const used of holes.find((h) => h.name === name)?.uses ?? []) visit(used);
    out.push(name);
  };
  visit(from);
  return out;
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
