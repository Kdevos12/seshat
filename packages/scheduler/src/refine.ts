import { quotedSketch } from "@seshat/memory";
import { BLUEPRINT_FORMAT, MAX_HOLE_DEPTH } from "./holes.ts";

/**
 * The planner of a refinement round (plan change CA12, PA11): one model call in a fresh context that rewrites a blueprint from what happened to
 * it. The prompt is a constant of the scheduler with a version, like the other prompts; the version is in the prompt's first line, so a
 * recorded call says which text it was made with.
 */
export const PLANNER_VERSION = "planner-1";

/** The site of the planner's model call (`model_call.finished` of `line:M12`, charged to the problem's ledger). */
export const SITE_PLANNER = "scheduler.planner";

/**
 * What a round costs the gate, as a part of a session's price: a task of one call is priced like a task of one session bounded to one model
 * response, which the gate scales by the response over the usual twelve of a session (`BudgetGate.taskUsd`).
 */
export const PLANNER_CALL_SHARE = 1 / 12;

/** One line of the prompt: a hole of the blueprint and what happened to it. */
export interface PlannerHole {
  name: string;
  /** The first characters of the id of its statement (M1); absent for a hole of a blueprint that was never registered. */
  statementId?: string;
  /** `computed` (Lean accepted a proof), `open`, or another status of the claim; `not registered` for a hole of a blueprint that was refused. */
  status: string;
  /** The verdict of the hole's last session (`proved`, `statement_wrong`, `too_hard`), when it had one. */
  verdict?: string;
  /** Its depth in the refinements. */
  depth: number;
  /** The first line of the last error or argument of its sessions. */
  detail?: string;
}

/** Everything the planner is told, and nothing else. */
export interface PlannerInput {
  /** This round's number, from 1, and the most rounds a problem may have. */
  round: number;
  max: number;
  /** The target theorem's statement in signature form. */
  target: string;
  /** The blueprint being revised, as the regions it was submitted in. */
  aux: string;
  proof: string;
  holes: readonly PlannerHole[];
  /** A blueprint Lean checked that is not healthy (case a): what the reading said, and Lean's first errors. */
  refused?: { problem?: string; errors: readonly string[] };
  /** A person's sketch of the proof (`harness solve --sketch`): shown as unverified data, after the blueprint's holes. Absent: the prompt is what it always was. */
  sketch?: { by: string; text: string };
  /** An informal proof that the verifier accepted (`RunConfig.informalFirst`): shown as a hint, with its title saying that Lean has not checked it. Absent: the prompt is what it always was. */
  informal?: { title: string; text: string };
}

/** The most Lean errors the prompt shows, and the most characters of each. */
export const PLANNER_ERRORS = 5;
export const PLANNER_ERROR_CHARS = 300;

const firstLine = (text: string, n: number): string => {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

const clipText = (text: string, n: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const holeLine = (hole: PlannerHole): string =>
  `- ${hole.name}${hole.statementId !== undefined ? ` [${hole.statementId}]` : ""}: ${hole.status}${hole.verdict !== undefined ? `, verdict ${hole.verdict}` : ""}, depth ${hole.depth}${hole.detail !== undefined && hole.detail !== "" ? `, last: ${firstLine(hole.detail, 160)}` : ""}`;

const INSTRUCTIONS = [
  "Write a revised blueprint, in the same two regions (AUX and PROOF):",
  "- Keep what is proved: a hole that is `computed` stays, with its statement as it is, so that its proof is kept.",
  "- Split a hole that is too hard into smaller holes, each a step toward it.",
  "- Repair a hole that is wrong (state what is true), or drop it and rewire the holes that used it.",
  "- Rewire `-- uses:` lines so that every hole reaches the main proof.",
  `- A new hole that replaces an old one says so with \`-- refines: aux_old\` on the line above it (next to its \`-- uses:\` line, if it has one). A hole has the depth of the hole it refines plus one, and a hole deeper than ${MAX_HOLE_DEPTH} is refused.`,
  "The result must be a file Lean accepts with only its holes open.",
].join("\n");

/** The prompt of a round: the target, the blueprint, one line per hole, why a refused blueprint is refused, the format and the task. */
export function plannerPrompt(input: PlannerInput): string {
  return [
    `Planner prompt ${PLANNER_VERSION}. You plan the proof of one theorem in Lean 4 (round ${input.round} of at most ${input.max}). A blueprint is a proof of the theorem from named holes; the holes are worked on as separate lemmas. You have no earlier conversation: everything you need is below.`,
    `The theorem to prove:\ntheorem target ${input.target.trim()}`,
    `The current blueprint.\nAUX region:\n${input.aux.trim() === "" ? "(empty)" : input.aux.trim()}\n\nPROOF region:\n${input.proof.trim()}`,
    input.holes.length > 0 ? `The holes, one line each (name, statement id, status, verdict, depth, the first line of the last error or argument):\n${input.holes.map(holeLine).join("\n")}` : "",
    input.refused !== undefined
      ? [
          `This blueprint was not accepted${input.refused.problem !== undefined ? `: ${input.refused.problem}` : ""}.`,
          input.refused.errors.length > 0 ? `Lean's first errors:\n${input.refused.errors.slice(0, PLANNER_ERRORS).map((e) => `- ${clipText(e, PLANNER_ERROR_CHARS)}`).join("\n")}` : "",
        ].filter((t) => t !== "").join("\n")
      : "",
    input.sketch !== undefined
      ? `A sketch from ${input.sketch.by}, who gave it for this theorem. It is informal and unchecked: it may be wrong or incomplete. Use it as a hint for the shape of the blueprint; Lean decides what is true.\n${quotedSketch(input.sketch.text)}`
      : "",
    input.informal !== undefined ? `${input.informal.title}. Use it as a hint for the shape of the blueprint; Lean decides what is true.\n${input.informal.text}` : "",
    `The format of a blueprint:\n${BLUEPRINT_FORMAT}`,
    INSTRUCTIONS,
    'Answer with JSON: {"aux": the AUX region, "proof": the PROOF region (the tactic proof without the leading "by")}.',
  ].filter((t) => t !== "").join("\n\n");
}
