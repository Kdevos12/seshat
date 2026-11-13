import { readFileSync } from "node:fs";
import { type Journal, type Json, newId, type Projection } from "@seshat/core";
import { MAX_SKETCH_CHARS, quotedSketch, screenSketch, sketchOfNodes } from "@seshat/memory";
import { RunSetupError } from "./setup-error.ts";
import { type HintData, HINT_KIND, humanActor } from "./team.ts";

/**
 * A person's sketch of a proof, informal or a hint (`harness solve --sketch FILE`, documentation/human.md, "A person's sketch"): journaled once, when the
 * problem is registered, as a `hint` node of the problem's claim written by `human:NAME` with `sketch: true`. Nothing in it is a fact or a proof and it
 * changes no status. It reaches the outer prover's first briefing and the planner's prompt of a refinement round, screened (`screenSketch`) and as data.
 */
export { MAX_SKETCH_CHARS };

/** The actor of a sketch when the run knows no person's name. */
export const ANONYMOUS_PERSON = "person";

/** What is wrong with a sketch's text, or undefined: it has to hold something, and be at most `MAX_SKETCH_CHARS` characters. */
export function sketchProblem(text: string): string | undefined {
  if (text.trim() === "") return "the sketch is empty";
  if (text.length > MAX_SKETCH_CHARS) return `the sketch is ${text.length} characters long; the limit is ${MAX_SKETCH_CHARS}`;
  return undefined;
}

/** Reads `--sketch FILE`: a `RunSetupError`, before anything is spent, when the file is missing, empty or too long. */
export function readSketchFile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new RunSetupError(`--sketch ${path}: the file cannot be read (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  const problem = sketchProblem(text);
  if (problem !== undefined) throw new RunSetupError(`--sketch ${path}: ${problem}`);
  return text;
}

/**
 * Journals the sketch as a `hint` node of `claimId`, once: a claim that has a sketch from this person with this text keeps it (a run that takes up a claim
 * again). Returns the node's id. The actor is `human:NAME`, `human:person` when there is no name.
 */
export function recordSketch(journal: Journal, o: { by?: string; claimId: string; text: string }): string {
  const problem = sketchProblem(o.text);
  if (problem !== undefined) throw new RunSetupError(problem);
  if (journal.projection.claim(o.claimId) === undefined) throw new RunSetupError(`no claim ${o.claimId} in this run`);
  const by = o.by ?? ANONYMOUS_PERSON;
  const held = journal.projection.nodes(HINT_KIND, o.claimId).find((node) => {
    const data = node.data as { sketch?: unknown; by?: unknown; text?: unknown };
    return data.sketch === true && data.by === by && data.text === o.text.trim();
  });
  if (held !== undefined) return held.node_id;
  const nodeId = newId("nod");
  const data: HintData = { provenance: "human", by, text: o.text.trim(), afterTurn: journal.projection.turns().ended, sketch: true };
  journal.emit("node.recorded", { nodeId, kind: HINT_KIND, claimId: o.claimId, data: data as unknown as Json }, humanActor(by));
  return nodeId;
}

/**
 * The section of the outer prover's first briefing: "A sketch from NAME", the screened text quoted line by line, with what the prover may and may not
 * do with it. Empty when the claim has no sketch, so that a run without one prompts exactly as it did.
 */
export function sketchBriefing(p: Projection, claimId: string): Array<{ title: string; text: string }> {
  const sketch = sketchOfNodes(p.nodes(HINT_KIND, claimId));
  if (sketch === undefined || screenSketch(sketch.text) === "") return [];
  return [
    {
      title: `A sketch from ${sketch.by}`,
      text:
        `${sketch.by} wrote this sketch of a proof, or a hint, for this theorem. It is informal and unchecked: it may be wrong, incomplete or about another statement. ` +
        "Use it for ideas and the shape of an argument; nothing in it is a fact, and only Lean's check says that a proof is right. Say in your notes if it turned out wrong.\n" +
        quotedSketch(sketch.text),
    },
  ];
}
