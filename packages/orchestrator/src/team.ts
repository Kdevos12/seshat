import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  edgeStatusRank,
  type HarnessEvent,
  isFinalTaskStatus,
  Journal,
  type Json,
  newId,
  type Projection,
  readEvents,
  type TurnLimit,
} from "@seshat/core";
import { classifyStrategy, isStrategy, STRATEGIES } from "@seshat/memory";
import type { TaskLedger } from "@seshat/scheduler";
import { RunSetupError } from "./setup-error.ts";

/**
 * The research team's answers to the account of a turn (documentation/human.md): hints, signatures and
 * steers. Each is journaled with the person's name as the actor (`human:NAME`), and each can be read
 * back from the journal alone. None of them changes a claim's status: a hint is a record a session is
 * told about, a signature raises an edge to `human_signed`, which no rule follows, and a steer changes
 * what the next turn works on or when it ends. Lean stays the judge.
 */

/** The node kind of a hint, and of a steer. */
export const HINT_KIND = "hint";
export const STEER_KIND = "steer";

/** The longest a hint or a note may be, in characters. */
export const MAX_ANSWER_CHARS = 4000;

/** The data of a `hint` node: a person's suggestion about a claim, never a fact. */
export interface HintData {
  provenance: "human";
  by: string;
  text: string;
  /** The last turn that had ended when the hint was written; the hint answers its account. */
  afterTurn: number;
}

/** What a steer asks for. */
export type SteerAction =
  | { action: "focus"; claimId: string }
  | { action: "drop"; claimId: string }
  | { action: "forbid_strategy"; strategy: string; claimId?: string }
  | { action: "turn_limit"; limit: TurnLimit };

/** The data of a `steer` node. */
export type SteerData = SteerAction & { provenance: "human"; by: string; afterTurn: number };

/** The actor a person's answers are journaled under. */
export function humanActor(name: string): string {
  return `human:${name}`;
}

/** A person's name as the journal records it: letters, digits, dots, dashes and underscores. */
export function personName(given?: string): string {
  const name = (given ?? process.env.SESHAT_USER ?? userInfo().username).trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,39}$/u.test(name)) {
    throw new RunSetupError(`the name ${JSON.stringify(name)} cannot be journaled: use letters, digits, dots, dashes and underscores (--as NAME)`);
  }
  return name;
}

/**
 * Opens the journal of a run that no process works on, to write the team's answers. Refuses a
 * directory with no run, a journal a process holds (the run is working: answer between turns), and a
 * journal whose last line a crash cut (resume the run first, which deals with it and says so).
 */
export function openForAnswers(dir: string): Journal {
  const path = join(dir, "journal.jsonl");
  if (!existsSync(path)) throw new RunSetupError(`${dir} holds no run: it has no journal.jsonl`);
  const events = readEvents(path);
  const first = events.find((event) => event.type === "run.started");
  if (first === undefined) throw new RunSetupError(`the journal of ${dir} has no run.started: there is no run to answer`);
  let journal: Journal;
  try {
    journal = Journal.open(dir, first.data.runId, { deferRepair: true });
  } catch (error) {
    throw new RunSetupError(`the journal of ${dir} cannot be opened for an answer: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (journal.log.recovered !== undefined) {
    journal.close();
    throw new RunSetupError(`the journal of ${dir} ends in a line that a crash cut: resume the run first (harness resume ${dir}), then answer`);
  }
  return journal;
}

function checkText(what: string, text: string): string {
  const clean = text.trim();
  if (clean === "") throw new RunSetupError(`${what} is empty`);
  if (clean.length > MAX_ANSWER_CHARS) throw new RunSetupError(`${what} is ${clean.length} characters long; the limit is ${MAX_ANSWER_CHARS}`);
  return clean;
}

/** The turns that had ended: what an answer written now responds to. */
function afterTurn(journal: Journal): number {
  return journal.projection.turns().ended;
}

/** A hint about a claim: a `hint` node of provenance `human`, shown in the briefing of that claim's next sessions. Returns the node's id. */
export function recordHint(journal: Journal, o: { by: string; claimId: string; text: string }): string {
  const text = checkText("the hint", o.text);
  if (journal.projection.claim(o.claimId) === undefined) throw new RunSetupError(`no claim ${o.claimId} in this run`);
  const nodeId = newId("nod");
  const data: HintData = { provenance: "human", by: o.by, text, afterTurn: afterTurn(journal) };
  journal.emit("node.recorded", { nodeId, kind: HINT_KIND, claimId: o.claimId, data: data as unknown as Json }, humanActor(o.by));
  return nodeId;
}

/**
 * A person vouches for an edge: its status becomes `human_signed`. That status is below `lean_checked`
 * and no rule follows it, so nothing is derived from it and no claim changes. An edge that is `human_signed`
 * or `lean_checked` already is left alone: a signature never lowers a status.
 */
export function signEdge(journal: Journal, o: { by: string; edgeId: string; note?: string }): { from: string; to: string } {
  const edge = journal.projection.edge(o.edgeId);
  if (edge === undefined) throw new RunSetupError(`no edge ${o.edgeId} in this run`);
  if (edgeStatusRank(edge.status) >= edgeStatusRank("human_signed")) {
    throw new RunSetupError(`edge ${o.edgeId} is ${edge.status} already: a signature adds nothing and never lowers a status`);
  }
  const note = o.note === undefined ? "" : `: ${checkText("the note", o.note)}`;
  journal.emit(
    "edge.status_changed",
    { edgeId: o.edgeId, from: edge.status, to: "human_signed", reason: `signed by ${o.by}${note}` },
    humanActor(o.by),
  );
  return { from: edge.status, to: "human_signed" };
}

/** A steer: a `steer` node of provenance `human`, read by the next turn. Returns the node's id. */
export function recordSteer(journal: Journal, o: { by: string; steer: SteerAction }): string {
  const p = journal.projection;
  const steer = o.steer;
  if (steer.action === "focus" || steer.action === "drop") {
    if (p.claim(steer.claimId) === undefined) throw new RunSetupError(`no claim ${steer.claimId} in this run`);
  } else if (steer.action === "forbid_strategy") {
    if (!isStrategy(steer.strategy)) throw new RunSetupError(`${JSON.stringify(steer.strategy)} is not a strategy label; they are ${STRATEGIES.join(", ")}`);
    if (steer.claimId !== undefined && p.claim(steer.claimId) === undefined) throw new RunSetupError(`no claim ${steer.claimId} in this run`);
  } else if (Object.keys(steer.limit).length === 0 || Object.values(steer.limit).some((v) => !(typeof v === "number" && v > 0))) {
    throw new RunSetupError("a turn limit steer needs at least one positive limit (tokens, usd or minutes)");
  }
  const nodeId = newId("nod");
  const data: SteerData = { ...steer, provenance: "human", by: o.by, afterTurn: afterTurn(journal) };
  const claimId = "claimId" in steer ? steer.claimId : undefined;
  journal.emit("node.recorded", { nodeId, kind: STEER_KIND, ...(claimId !== undefined ? { claimId } : {}), data: data as unknown as Json }, humanActor(o.by));
  return nodeId;
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a hint's data back, or undefined when the node is not a well-formed hint. */
export function hintOf(data: Json): HintData | undefined {
  if (!isRecord(data) || data.provenance !== "human" || typeof data.by !== "string" || typeof data.text !== "string") return undefined;
  return { provenance: "human", by: data.by, text: data.text, afterTurn: typeof data.afterTurn === "number" ? data.afterTurn : 0 };
}

/** Reads a steer's data back, or undefined when the node is not a well-formed steer. */
export function steerOf(data: Json): SteerData | undefined {
  if (!isRecord(data) || data.provenance !== "human" || typeof data.by !== "string") return undefined;
  const base = { provenance: "human" as const, by: data.by, afterTurn: typeof data.afterTurn === "number" ? data.afterTurn : 0 };
  switch (data.action) {
    case "focus":
    case "drop":
      return typeof data.claimId === "string" ? { ...base, action: data.action, claimId: data.claimId } : undefined;
    case "forbid_strategy":
      return typeof data.strategy === "string"
        ? { ...base, action: "forbid_strategy", strategy: data.strategy, ...(typeof data.claimId === "string" ? { claimId: data.claimId } : {}) }
        : undefined;
    case "turn_limit": {
      const limit = data.limit;
      if (!isRecord(limit)) return undefined;
      const read: TurnLimit = {
        ...(typeof limit.tokens === "number" ? { tokens: limit.tokens } : {}),
        ...(typeof limit.usd === "number" ? { usd: limit.usd } : {}),
        ...(typeof limit.minutes === "number" ? { minutes: limit.minutes } : {}),
      };
      return { ...base, action: "turn_limit", limit: read };
    }
    default:
      return undefined;
  }
}

/** The newest steer of an action recorded after `sinceSeq`, in a list of events. */
export function latestSteer(events: readonly HarnessEvent[], action: SteerAction["action"], sinceSeq: number): { seq: number; data: SteerData } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined || event.seq <= sinceSeq) break;
    if (event.type !== "node.recorded" || event.data.kind !== STEER_KIND) continue;
    const data = steerOf(event.data.data);
    if (data?.action === action) return { seq: event.seq, data };
  }
  return undefined;
}

/** What the team's steers say now. */
export interface Steering {
  /** Claims to work on first, the newest ask first. */
  focus: string[];
  /** Claims the team gave up. */
  dropped: Set<string>;
  /** Strategies the team forbids: for one claim, or for all of them. */
  forbidden: Array<{ strategy: string; claimId?: string; by: string }>;
}

export function steering(p: Projection): Steering {
  const focus: string[] = [];
  const dropped = new Set<string>();
  const forbidden: Steering["forbidden"] = [];
  for (const node of p.nodes(STEER_KIND)) {
    const steer = steerOf(node.data);
    if (steer === undefined) continue;
    if (steer.action === "focus") {
      focus.unshift(steer.claimId);
    } else if (steer.action === "drop") {
      dropped.add(steer.claimId);
    } else if (steer.action === "forbid_strategy") {
      forbidden.push({ strategy: steer.strategy, ...(steer.claimId !== undefined ? { claimId: steer.claimId } : {}), by: steer.by });
    }
  }
  return { focus: [...new Set(focus)].filter((id) => !dropped.has(id)), dropped, forbidden };
}

/** The claim and the parts of its decomposition, followed down, in the order found. */
export function claimAndParts(p: Projection, claimId: string): string[] {
  const seen = [claimId];
  for (let i = 0; i < seen.length && seen.length < 200; i++) {
    for (const edge of p.edges({ from: seen[i] as string, kinds: ["decomposes_into"] })) {
      for (const id of edge.to) if (p.claim(id) !== undefined && !seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}

const MAX_HINTS_SHOWN = 8;
const MAX_HINT_CHARS = 1500;

/**
 * What the next sessions on a claim are told of the team's answers: its hints, from the claim and from
 * the parts of its decomposition, said to be people's suggestions and neither facts nor proofs; the
 * strategies the team forbids; and a focus. Empty when the team said nothing, so that a run that was
 * never answered prompts exactly as it did.
 */
export function teamBriefing(p: Projection, claimId: string): Array<{ title: string; text: string }> {
  const sections: Array<{ title: string; text: string }> = [];
  const scope = claimAndParts(p, claimId);
  const hints = scope.flatMap((id) =>
    p.nodes(HINT_KIND, id).flatMap((node) => {
      const hint = hintOf(node.data);
      return hint === undefined ? [] : [{ seq: node.created_seq, claimId: id, hint }];
    }),
  );
  hints.sort((a, b) => a.seq - b.seq);
  if (hints.length > 0) {
    const shown = hints.slice(-MAX_HINTS_SHOWN);
    const lines = shown.map(({ claimId: about, hint }) => {
      const text = hint.text.length > MAX_HINT_CHARS ? `${hint.text.slice(0, MAX_HINT_CHARS)} [cut]` : hint.text;
      return `- ${hint.by}${about === claimId ? "" : `, about the part ${about}`}: ${text}`;
    });
    sections.push({
      title: "Hints from the team",
      text:
        "The people who follow this research read the account of the last turn and sent these. They are suggestions, not facts and not proofs: " +
        "check anything you use with Lean, and say in your notes if a hint turned out wrong." +
        `${hints.length > shown.length ? ` (${hints.length - shown.length} older hint(s) are left out.)` : ""}\n${lines.join("\n")}`,
    });
  }
  const steer = steering(p);
  const ruledOut = [...new Set(steer.forbidden.filter((f) => f.claimId === undefined || scope.includes(f.claimId)).map((f) => f.strategy))];
  const lines: string[] = [];
  if (ruledOut.length > 0) {
    lines.push(`The team rules out these strategies for this work: ${ruledOut.join(", ")}. A check whose proof follows one of them is not run.`);
  }
  if (steer.focus.some((id) => scope.includes(id))) lines.push("The team asked that this claim be worked on first.");
  if (lines.length > 0) sections.push({ title: "What the team asks", text: lines.join("\n") });
  return sections;
}

/**
 * The reason a check is not run because the team forbids its strategy, or undefined. The strategy is the
 * label the model declared, if it did, and the label the proof gets from `classifyStrategy`, which reads
 * the text and never what it says of itself.
 */
export function teamVeto(p: Projection, claimId: string): ((proposal: { aux: string; proof: string; strategy?: string }) => string | undefined) | undefined {
  const scope = claimAndParts(p, claimId);
  const forbidden = new Set(steering(p).forbidden.filter((f) => f.claimId === undefined || scope.includes(f.claimId)).map((f) => f.strategy));
  if (forbidden.size === 0) return undefined;
  return (proposal) => {
    const label = proposal.strategy !== undefined && forbidden.has(proposal.strategy) ? proposal.strategy : classifyStrategy({ aux: proposal.aux, proof: proposal.proof });
    return forbidden.has(label)
      ? `the team rules out the strategy "${label}" for this work, and this proof follows it; try another way (the check was not run)`
      : undefined;
  };
}

/** What dropping claims did. */
export interface Dropped {
  /** Problems whose claim the team gave up: they ended, `aborted`. */
  problems: Array<{ problemId: string; claimId: string; attempts: number; usd: number; durationMs: number }>;
  /** Tasks of other claims that were cancelled. */
  tasks: number;
}

/**
 * Carries out the team's `drop` steers when a run is resumed: a problem whose claim was dropped and
 * has no outcome ends `aborted`, with the person's name in the reason, and its tasks are cancelled; the
 * tasks of a dropped claim that is not a problem's are cancelled too. Nothing here touches a claim's
 * status. Idempotent: what has ended or been cancelled is left as it is.
 */
export function applyDrops(journal: Journal, tasks: TaskLedger): Dropped {
  const p = journal.projection;
  const result: Dropped = { problems: [], tasks: 0 };
  const drops = p.nodes(STEER_KIND).flatMap((node) => {
    const steer = steerOf(node.data);
    return steer?.action === "drop" ? [steer] : [];
  });
  for (const drop of drops) {
    const reason = `dropped by ${drop.by} after turn ${drop.afterTurn}`;
    for (const problem of p.problems()) {
      if (problem.claim_id !== drop.claimId || problem.finished_seq !== null) continue;
      const own = p.tasks({ problemId: problem.problem_id });
      const attempts = own.flatMap((task) => p.attemptsOfTask(task.task_id));
      tasks.closeProblem(problem.problem_id, reason);
      const spend = p.problemSpend(problem.problem_id);
      const entry = { problemId: problem.problem_id, claimId: problem.claim_id, attempts: attempts.length, usd: spend.usd, durationMs: attempts.reduce((sum, a) => sum + (a.duration_ms ?? 0), 0) };
      journal.emit("problem.finished", { ...entry, outcome: "aborted", reason }, "orchestrator");
      result.problems.push(entry);
    }
    for (const task of p.tasks({ claimId: drop.claimId })) {
      if (isFinalTaskStatus(task.status)) continue;
      tasks.cancel(task.task_id, reason);
      result.tasks += 1;
    }
  }
  return result;
}
