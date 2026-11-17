import { CHILD_KINDS, type ChildKind, type Journal, newId, readEvents } from "@seshat/core";
import type { Ledger } from "./budget.ts";

/**
 * One contract for a delegated piece of work of a run (plan change LH9, documentation/runs.md, "Children"): what it is for, where it sits, the
 * ledger it may spend, the tools it may use, what it writes and how a resume recognizes it as done. The kinds are started from their own code;
 * `runChild` is what they have in common.
 */
export interface ChildSpec {
  kind: ChildKind;
  /** A claim, or an evidence need as text. */
  goal: { claimId?: string; need?: string };
  /** The problem the child works on, and the child that started it, if any. */
  parent: { problemId?: string; childId?: string };
  /** Carved from the parent's ledger: the child may spend at most this, and never more than the parent has left. Absent: no cap of its own. */
  ledger: { capUsd?: number; capTokens?: number };
  /** The ids of the capabilities the child may use. */
  tools: readonly string[];
  /** The node or event kind the child writes. */
  output: string;
  /** How a resume recognizes the child as done: the same key, finished `done` in this run's journal. */
  resumeKey: string;
  /**
   * `skip` (the default): a child whose key is finished `done` is not run again. `run`: the child is recorded but runs again; for a kind whose
   * result is the caller's input and cannot be rebuilt from the journal.
   */
  resume?: "skip" | "run";
}

export interface ChildDeps {
  journal: Journal;
  /** The parent's ledger: the child's is carved from it, so that everything the child spends is charged to the parent. */
  ledger: Ledger;
}

export type ChildStatus = "done" | "failed" | "stopped";

/** What the body gets: its id and the ledger it must charge. */
export interface ChildContext {
  childId: string;
  ledger: Ledger;
}

export type ChildRun<T> =
  | { skipped: true; childId?: undefined }
  | { skipped: false; childId: string; value: T; status: ChildStatus; usd: number; inputTokens: number; outputTokens: number };

export interface ChildOptions<T> {
  /** How the body's result ends the child. Default: `done`. A child that ends `stopped` (cut before its output) is run again by a resume. */
  statusOf?: (value: T) => { status: ChildStatus; reason?: string };
}

/** Whether this run's journal holds a `done` end for the key. */
export function childFinished(journal: Journal, resumeKey: string): boolean {
  return readEvents(journal.log.path).some((e) => e.type === "child.finished" && e.data.resumeKey === resumeKey && e.data.status === "done");
}

/**
 * What every kind of child does the same way, once: skips a child whose `resumeKey` is finished (`resume: "skip"`), carves its ledger from the
 * parent's remainder, journals `child.started`, runs `body` (the kind's own code) with that ledger, and journals `child.finished` with what it
 * spent, which the parent's ledger has been charged as it was spent. A body that throws ends the child `failed` and the error goes on. The
 * body's typed result is returned.
 */
export async function runChild<T>(spec: ChildSpec, deps: ChildDeps, body: (child: ChildContext) => Promise<T>, options: ChildOptions<T> = {}): Promise<ChildRun<T>> {
  if (!(CHILD_KINDS as readonly string[]).includes(spec.kind)) throw new Error(`unknown kind of child: ${String(spec.kind)}`);
  if (spec.resumeKey === "") throw new Error("a child needs a resumeKey");
  if ((spec.resume ?? "skip") === "skip" && childFinished(deps.journal, spec.resumeKey)) return { skipped: true };
  const left = deps.ledger.remainingUsd;
  const capUsd = spec.ledger.capUsd === undefined ? undefined : left === undefined ? spec.ledger.capUsd : Math.min(spec.ledger.capUsd, left);
  const ledger = deps.ledger.child(capUsd, spec.ledger.capTokens);
  const childId = newId("chd");
  deps.journal.emit(
    "child.started",
    {
      childId,
      kind: spec.kind,
      goal: spec.goal,
      ...(spec.parent.problemId !== undefined ? { problemId: spec.parent.problemId } : {}),
      ...(spec.parent.childId !== undefined ? { parentChildId: spec.parent.childId } : {}),
      ...(capUsd !== undefined ? { capUsd } : {}),
      ...(spec.ledger.capTokens !== undefined ? { capTokens: spec.ledger.capTokens } : {}),
      tools: [...spec.tools],
      output: spec.output,
      resumeKey: spec.resumeKey,
    },
    "orchestrator",
  );
  const finish = (status: ChildStatus, reason?: string): void => {
    deps.journal.emit(
      "child.finished",
      { childId, resumeKey: spec.resumeKey, status, usd: ledger.usd, inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens, ...(reason !== undefined ? { reason } : {}) },
      "orchestrator",
    );
  };
  let value: T;
  try {
    value = await body({ childId, ledger });
  } catch (error) {
    finish("failed", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    throw error;
  }
  const ended = options.statusOf?.(value) ?? { status: "done" as const };
  finish(ended.status, ended.reason);
  return { skipped: false, childId, value, status: ended.status, usd: ledger.usd, inputTokens: ledger.inputTokens, outputTokens: ledger.outputTokens };
}
