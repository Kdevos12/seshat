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
  /** The holes of the blueprint it replaces (`-- refines: aux_old` directly above it, plan change CA12). Empty without such a line. */
  refines?: string[];
  /** Its depth in the refinements: 0 in a first blueprint, one more than the deepest hole it refines (blueprints with a `depths` option only). */
  depth?: number;
}

/** The deepest a refined hole may be (CA12): a blueprint with a hole deeper than this is refused. */
export const MAX_HOLE_DEPTH = 3;

/** The depths of the holes of the blueprint a refinement revises: by the hole's name, and by the id of its statement (a hole that is kept as it is keeps its depth). */
export interface BaseDepths {
  byName: ReadonlyMap<string, number>;
  byStatement: ReadonlyMap<string, number>;
}

/** What reading a sketch may be asked (all off: M12 as it was). */
export interface ReadOptions {
  /** Read the sketch as a blueprint (CA9): holes may depend on each other, and the dependency graph is checked. */
  blueprint?: boolean;
  /** The target's statement in signature form, to refuse a hole that restates it (blueprints only). */
  target?: string;
  /** The depths of the blueprint being revised: with it, each hole gets a `depth` and one deeper than `MAX_HOLE_DEPTH` is refused (blueprints only). */
  depths?: BaseDepths;
}

export interface SketchReading {
  holes: NamedHole[];
  /** The aux commands that are not holes, as written (closed lemmas, definitions, `open ... in`). */
  others: string[];
  /** Why the sketch is not one the scheduler can split, or undefined when it is. */
  problem?: string;
  /** `restates_target` when a blueprint is refused because a hole states the target again. */
  failureClass?: "restates_target";
  /**
   * The holes of a blueprint that reach the target neither directly nor through `uses`: they are left out of `holes` (no claim, no task, no
   * session), when at least one hole remains. Absent when none was left out.
   */
  dropped?: string[];
}

/**
 * How to write a blueprint (the body of the briefing section of that title), as the prover is told: in M12's briefing with the option `blueprints`, and again in the check answer of a
 * sketch that is not read as one (`blueprintNotice`). One text, so the two never disagree.
 */
export const BLUEPRINT_FORMAT = [
  "- A hole is an `aux_` lemma in the AUX region whose whole proof is `sorry`. Give each a complete statement.",
  "- If the proof of a hole will use another hole, say so with `-- uses: aux_a, aux_b` on the line directly above it (no blank line between).",
  "- The main proof (PROOF region) is complete and uses the holes by name; a main proof that is `sorry`, or has a `sorry`, is not a blueprint.",
  "- Every hole must be used by the main proof or, through `-- uses:`, by a hole that is. A hole nothing uses is left out.",
  "- No `import` or `open` command in AUX (the file's header has them); `open X in` before a lemma is fine.",
  "- A hole's statement may not name another hole; the other `aux_` lemmas must not rest on a hole.",
  "- Write big operators as `∑ i ∈ s, f i` (not `in`).",
  "- A file with Lean errors is not read as a blueprint: fix them first.",
  "An accepted blueprint becomes separate sessions, one per hole; their proofs come back in your next briefing.",
].join("\n");

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
  // The `-- refines:` line directly above it (CA12), read like the `-- uses:` line.
  let refining: string[] = [];
  const names = (line: string): string[] => line.split(/[\s,]+/).filter((n) => n !== "");
  for (const command of splitCommands(submission.aux)) {
    if (command.kind === "comment") {
      const trailing = /\s*$/.exec(command.text)?.[0] ?? "";
      const gap = trailing.split("\n").length - 1 > 1;
      const text = command.text.trimEnd();
      const uses = /^--\s*uses:(.*)$/m.exec(text);
      const refines = /^--\s*refines:(.*)$/m.exec(text);
      if (uses !== null && !gap) declared = [...declared, ...names(uses[1] as string)];
      else if (gap) declared = [];
      if (refines !== null && !gap) refining = [...refining, ...names(refines[1] as string)];
      else if (gap) refining = [];
      continue;
    }
    if (command.kind !== "code") continue;
    const uses = [...new Set(declared)];
    const refines = [...new Set(refining)];
    declared = [];
    refining = [];
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
        holes.push({ name: head.name, statement: sketch.statement, text, uses, refines });
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
  const holeNames = holes.map((h) => h.name);
  for (const hole of holes) {
    const used = mentions(hole.statement, holeNames);
    if (used !== undefined) return reading(`the statement of ${hole.name} names ${used}`);
  }
  for (const other of others) {
    const used = mentions(other, holeNames);
    if (used !== undefined) return reading(`an auxiliary declaration rests on the hole ${used}`);
  }
  if (options.blueprint === true) {
    if (options.depths !== undefined) {
      for (const hole of holes) {
        hole.depth = depthOf(hole, options.depths);
        if (hole.depth > MAX_HOLE_DEPTH) return reading(`${hole.name} refines too deep (depth ${hole.depth}, at most ${MAX_HOLE_DEPTH})`);
      }
    }
    const checked = checkBlueprint(holes, submission.proof, options.target);
    if (checked !== undefined && "problem" in checked) return { holes, others, ...checked };
    if (checked !== undefined) return { holes: holes.filter((h) => !checked.dropped.includes(h.name)), others, dropped: checked.dropped };
  }
  return reading();
}

/** A hole's depth: one more than the deepest hole it refines; a hole that refines none keeps the depth its statement had in the blueprint revised, else 0. */
function depthOf(hole: NamedHole, base: BaseDepths): number {
  const refines = hole.refines ?? [];
  if (refines.length > 0) return Math.max(...refines.map((name) => base.byName.get(name) ?? 0)) + 1;
  return base.byStatement.get(statementIdV0(hole.statement)) ?? 0;
}

const NAMED_KEYWORDS = new Set(["def", "abbrev", "lemma", "theorem", "structure", "inductive", "class", "opaque"]);

/** The name a context command declares, or undefined for a command that declares none (`open Nat`, `variable ...`, `set_option ...`, a notation). */
function declaredName(command: string): string | undefined {
  // `open X in def f ...` declares `f`.
  const text = command.replace(/^\s*open\s+[^\n]*?\s+in\s+/u, "");
  const head = readDeclarationHead(text);
  return head !== undefined && NAMED_KEYWORDS.has(head.keyword) && head.name !== "" ? head.name : undefined;
}

/**
 * The context of a blueprint's holes (task 51): the aux commands that are not holes (`SketchReading.others`: definitions, abbreviations,
 * lemmas with complete proofs) that the given texts need, so that a hole's claim can state them in its header. A command is needed when a
 * text names what it declares, or when a needed command does (transitively); the commands that declare no name (`open`, `variable`,
 * `set_option`) come with them. The result is in file order, and empty when no text names a context command (a hole that stands alone has the
 * problem's header and nothing more). The closure is computed, not "all of them": it is a few regular expressions over a handful of commands.
 */
export function contextFor(others: readonly string[], texts: readonly string[]): string[] {
  const named = others.map((text) => ({ text, name: declaredName(text) }));
  const chosen = new Set<number>();
  const take = (haystack: readonly string[]): boolean => {
    let grew = false;
    named.forEach((entry, k) => {
      if (entry.name === undefined || chosen.has(k)) return;
      if (haystack.some((text) => mentions(text, [entry.name as string]) !== undefined)) {
        chosen.add(k);
        grew = true;
      }
    });
    return grew;
  };
  let grew = take(texts);
  while (grew) grew = take([...chosen].map((k) => (named[k] as { text: string }).text));
  if (chosen.size === 0) return [];
  return named.flatMap((entry, k) => (entry.name === undefined || chosen.has(k) ? [entry.text] : []));
}

/** A header with context commands under it (the problem's own, when there are none). */
export function headerWithContext(header: string, context: readonly string[]): string {
  return context.length === 0 ? header : `${header.replace(/\s+$/, "")}\n\n${context.join("\n\n")}\n`;
}

/** The names a text uses among `names`, in the order of `names`. */
export function namesUsed(text: string, names: readonly string[]): string[] {
  return names.filter((name) => mentions(text, [name]) !== undefined);
}

/**
 * The acceptance of a blueprint's dependency graph (CA9), after Lean checked the file: every name of a `uses` line is a hole of the
 * blueprint; no hole restates the target (the failure class `restates_target`); the graph has no cycle; and every hole reaches the
 * target (the target is the sink: it uses the holes its main proof names, and a hole uses the holes it declares). Returns why the
 * blueprint is refused; or the holes that reach the target neither directly nor through `uses`, to leave out, when at least one hole
 * does reach it (PA16); or undefined when every hole reaches it. A blueprint whose every hole is out of reach is refused.
 */
export function checkBlueprint(holes: readonly NamedHole[], mainProof: string, target?: string): { problem: string; failureClass?: "restates_target" } | { dropped: string[] } | undefined {
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
  const lost = names.filter((name) => !reached.has(name));
  if (lost.length === names.length) return { problem: `${lost[0]} does not reach the target: no main proof and no hole uses it` };
  return lost.length > 0 ? { dropped: lost } : undefined;
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

/** What a check of a file with holes tells M12's blueprint reading about the check itself. */
export interface CheckFacts {
  /** The check ran no Lean: the file was refused before (its reasons are in the answer). */
  refusedBeforeLean: boolean;
  /** Lean errors. */
  errors: number;
  editsOutsideRegions: boolean;
}

/**
 * What M12 will do with a sketch the prover just checked, in words for the prover (PA16): read as a blueprint, with the holes that become
 * sessions and those left out, or not yet one, with the problem and its fix. It is made from the same reading M12 records (`readSketch`
 * with M12's options), so the answer and the record never disagree.
 */
export function blueprintNotice(reading: SketchReading, facts: CheckFacts): string {
  const left = reading.dropped !== undefined && reading.dropped.length > 0
    ? reading.dropped.map((name) => `${name} is used by nothing and is left out; add \`-- uses: ${name}\` above the hole that needs it (or name it in the main proof) to keep it.`)
    : [];
  const not = (why: string, fix: string): string => ["Not a blueprint yet: " + why + ".", fix, ...left].join("\n");
  if (reading.problem === undefined && reading.holes.length > 0) {
    if (facts.refusedBeforeLean) return not("the file was refused before Lean ran", "Fix what the refusal says above; a blueprint is read from a file Lean checked");
    if (facts.errors > 0) return not(`Lean reports ${facts.errors} error(s)`, "Fix the errors: only a file whose open parts are its holes is split");
    if (facts.editsOutsideRegions) return not("the file was edited outside the two regions", "Change only the AUX and PROOF regions");
    return [`Read as a blueprint: ${reading.holes.map((h) => h.name).join(", ")} will be worked as separate sessions.`, ...left].join("\n");
  }
  const problem = reading.problem ?? "no named hole";
  if (problem === "no named hole") return not("it has no named hole", `How to write a blueprint:\n${BLUEPRINT_FORMAT}`);
  if (/main proof has a sorry/.test(problem)) return not(problem, "Write the main proof from the holes: complete, naming the holes it uses");
  if (/does not reach the target/.test(problem)) return not(problem, "Add `-- uses: X` directly above the hole whose proof will use X, or name the hole in the main proof");
  if (/cycle/.test(problem)) return not(problem, "Remove one `-- uses:` line of the cycle");
  if (/which is not a hole/.test(problem)) return not(problem, "A `-- uses:` line names holes of this file only (aux_ lemmas proved by `sorry`)");
  if (/refines too deep/.test(problem)) return not(problem, "Split the hole at a smaller depth: a hole may refine a hole of a blueprint at most three times over");
  if (/states the target again/.test(problem)) return not(problem, "State a smaller step, not the target");
  if (/^the statement of .* names |rests on the hole/.test(problem)) return not(problem, "A hole's statement and the other aux lemmas may not name a hole; declare the dependency of a hole with `-- uses:` instead");
  return not(problem, "Fix that, then check again");
}

/**
 * The AUX lines `import M` (one or several modules) whose modules the header already imports, dropped before the screen; the screen refuses
 * `import` in AUX. Returns the aux text without them and the modules dropped (empty when none), with every other line as it was.
 */
export function dropHeaderImports(aux: string, header: string): { aux: string; dropped: string[] } {
  const have = new Set([...header.matchAll(/^import[ \t]+(.+)$/gm)].flatMap((m) => (m[1] as string).trim().split(/\s+/)));
  const dropped: string[] = [];
  const lines = aux.split("\n").filter((line) => {
    const m = /^import[ \t]+(\S+(?:[ \t]+\S+)*)[ \t]*$/.exec(line);
    if (m === null) return true;
    const modules = (m[1] as string).split(/\s+/);
    if (!modules.every((module) => have.has(module))) return true;
    dropped.push(...modules);
    return false;
  });
  return dropped.length === 0 ? { aux, dropped } : { aux: lines.join("\n").replace(/^\n+/, ""), dropped };
}
