import type { TaskLedger } from "@seshat/scheduler";
import type { ProverStop } from "./prover.ts";

/** One prover's task on a problem. */
export interface ProverTask {
  /** `p1`, `p2`...: the prover's name, as in its attempts. */
  name: string;
  taskId: string;
  problemId: string;
}

export interface ProverTasksOptions {
  problemId: string;
  claimId: string;
  /** The theorem's name, for the tasks' titles. */
  theorem: string;
  provers: number;
  /** Sessions per prover. */
  sessions: number;
  /** What the problem may spend: every prover's task may use all of it, since the provers share one budget. */
  problemUsd: number;
}

/**
 * The tasks of a problem that M0 does: one `prove` task per prover, each owned by its prover, each
 * done when the problem's claim is a candidate (`computed`) or better. They are `ready` when this
 * returns; the orchestrator starts each as its prover starts (documentation/ledger.md, "What M0
 * records"). A problem that an interrupted run had begun already has its tasks: they are returned
 * as they stand, and only the ones that were not made yet are made.
 */
export function createProverTasks(tasks: TaskLedger, o: ProverTasksOptions): ProverTask[] {
  const owned = new Map(
    tasks
      .list({ problemId: o.problemId, kinds: ["prove"] })
      .flatMap((task) => (task.proposed_by === null && task.owner !== null ? [[task.owner, task.task_id] as const] : [])),
  );
  const made = Array.from({ length: o.provers }, (_, i): ProverTask => {
    const name = `p${i + 1}`;
    const existing = owned.get(`prover:${name}`);
    if (existing !== undefined) return { name, taskId: existing, problemId: o.problemId };
    const taskId = tasks.create({
      kind: "prove",
      problemId: o.problemId,
      claimId: o.claimId,
      owner: `prover:${name}`,
      acceptance: { type: "claim", claimId: o.claimId, minStatus: "computed" },
      budget: { usd: o.problemUsd, sessions: o.sessions },
      title: `prover ${name} on ${o.theorem}`,
    });
    return { name, taskId, problemId: o.problemId };
  });
  tasks.promote(o.problemId);
  return made;
}

/** How a prover ended, for the end of its task. */
export type ProverTaskEnd =
  | {
      /** `ProverResult.stop`. */
      stop: ProverStop;
      /** Sessions the prover could use. */
      sessions: number;
      /** What ran out, when the budget did: "the problem's budget" or "the run's budget". */
      budget: string;
    }
  /** The harness failed in the prover: the message. */
  | { crash: string };

const POINTLESS = "another prover's proof passed first; this task is pointless";

/**
 * How a prover's task ends, from the prover's end and whether the task's criterion holds. `done`
 * when the prover's own proof passed (and the criterion holds); `cancelled` when the claim reached
 * the criterion without the prover, or the prover was stopped or told to stop; `failed` when it
 * could not be done: its sessions, its budget or its health ran out, or the harness failed.
 */
export function proverTaskEnding(task: Pick<ProverTask, "name">, end: ProverTaskEnd, holds: boolean): { to: "done" | "failed" | "cancelled"; reason: string } {
  const who = `prover ${task.name}`;
  if ("crash" in end) return { to: "failed", reason: `the harness failed in ${who}: ${end.crash}` };
  switch (end.stop) {
    case "solved":
      return holds
        ? { to: "done", reason: `${who}'s proof passed the fast check` }
        : { to: "failed", reason: `${who}'s proof passed the fast check, but the claim is not a candidate: the criterion does not hold` };
    case "sessions":
      return holds
        ? { to: "cancelled", reason: POINTLESS }
        : { to: "failed", reason: `${who} used its ${end.sessions} session${end.sessions === 1 ? "" : "s"} without a proof that passes` };
    case "budget":
      return holds ? { to: "cancelled", reason: POINTLESS } : { to: "failed", reason: `${end.budget} ran out` };
    case "errors":
      return holds
        ? { to: "cancelled", reason: POINTLESS }
        : { to: "failed", reason: `${who}'s sessions kept failing (the model or Lean could not be reached)` };
    case "aborted":
      return { to: "cancelled", reason: holds ? POINTLESS : "the run was stopped" };
    case "line":
      return { to: "cancelled", reason: holds ? POINTLESS : `a line stopped ${who}` };
  }
}

/**
 * Ends a prover's task (`proverTaskEnding`), then moves to `ready` the tasks that waited for it.
 * The journal refuses `done` while the criterion does not hold; this never asks for it then.
 */
export function endProverTask(tasks: TaskLedger, task: ProverTask, end: ProverTaskEnd): void {
  const ending = proverTaskEnding(task, end, tasks.holds(task.taskId));
  if (ending.to === "done") tasks.complete(task.taskId, ending.reason);
  else if (ending.to === "failed") tasks.fail(task.taskId, ending.reason);
  else tasks.cancel(task.taskId, ending.reason);
  tasks.promote(task.problemId);
}
