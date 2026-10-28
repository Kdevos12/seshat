import { type Beta, UNIFORM, betaUpdate } from "./beta.ts";
import { thompson } from "./choose.ts";
import type { RandomSource } from "./random.ts";

/** What the fleet knows of one worker (a prover of the problem) when it chooses an owner. */
export interface Worker {
  /** The owner string of the tasks it works on, such as `prover:p2`. */
  owner: string;
  /** Tasks of lines that it holds and has not ended (`ready`, `blocked`, `running`). */
  load: number;
  /** Tasks of lines that it ended `done`, and `failed`. */
  done: number;
  failed: number;
}

/** The posterior of a worker's success on the tasks lines gave it: flat until it has worked. */
export function workerPosterior(worker: Pick<Worker, "done" | "failed">): Beta {
  let beta: Beta = UNIFORM;
  for (let i = 0; i < worker.done; i++) beta = betaUpdate(beta, 1);
  for (let i = 0; i < worker.failed; i++) beta = betaUpdate(beta, 0);
  return beta;
}

/**
 * The owner of a task (Ruling 29): among the workers with the least load, the one Thompson sampling
 * draws from its posterior of past results on line-given tasks. A worker with no result is drawn from
 * the flat posterior, so it is tried; the first of equal draws wins. Undefined with no worker.
 */
export function chooseOwner(random: RandomSource, workers: readonly Worker[]): { owner: string; reason: string } | undefined {
  if (workers.length === 0) return undefined;
  const least = Math.min(...workers.map((w) => w.load));
  const idle = workers.filter((w) => w.load === least);
  const pick = thompson(
    random,
    idle.map((w) => [w.owner, workerPosterior(w)] as const),
  );
  if (pick === undefined) return undefined;
  const chosen = idle.find((w) => w.owner === pick.choice) as Worker;
  return {
    owner: chosen.owner,
    reason: `the fleet: ${chosen.owner} holds ${chosen.load} task(s), the least of ${workers.length}; ${chosen.done} done and ${chosen.failed} failed before`,
  };
}
