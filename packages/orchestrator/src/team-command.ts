import { resolve } from "node:path";
import { openForAnswers, personName, recordHint, recordSteer, signEdge, type SteerAction } from "./team.ts";
import type { TurnLimit } from "./turns.ts";
import { RunSetupError } from "./setup-error.ts";

/**
 * The commands with which the research team answers an account while a consortium run waits
 * (documentation/human.md): `harness hint`, `harness sign` and `harness steer`. Each writes to the
 * journal under the person's name and prints what it wrote. None starts a process or a model call, and
 * none changes a claim's status. Several people may answer before one resumes the run.
 */

export interface AnswerOptions {
  /** The person's name; default `SESHAT_USER`, then the login name. */
  as?: string | undefined;
  out: (line: string) => void;
}

const WHAT_NEXT = (dir: string): string => `Resume with: harness resume ${dir} --checkout DIR (several people may answer before one resumes).`;

/** `harness hint DIR --claim ID "text"`: a hint node, provenance human, shown in the claim's next briefings as a hint and never as a fact. */
export function hintCommand(dir: string, o: AnswerOptions & { claimId: string; text: string }): number {
  const by = personName(o.as);
  const journal = openForAnswers(resolve(dir));
  try {
    const nodeId = recordHint(journal, { by, claimId: o.claimId, text: o.text });
    o.out(`${by}: hint ${nodeId} recorded on claim ${o.claimId}. The next sessions on it are shown it as a hint, not a fact; the claim's status is unchanged.`);
    o.out(WHAT_NEXT(dir));
  } finally {
    journal.close();
  }
  return 0;
}

/** `harness sign DIR EDGE_ID`: the edge's status becomes `human_signed`, which does not propagate. */
export function signCommand(dir: string, o: AnswerOptions & { edgeId: string; note?: string | undefined }): number {
  const by = personName(o.as);
  const journal = openForAnswers(resolve(dir));
  try {
    const change = signEdge(journal, { by, edgeId: o.edgeId, ...(o.note !== undefined ? { note: o.note } : {}) });
    o.out(`${by}: edge ${o.edgeId} signed (${change.from} -> ${change.to}). A signature is not a Lean check: it propagates nothing and changes no claim's status.`);
    o.out(WHAT_NEXT(dir));
  } finally {
    journal.close();
  }
  return 0;
}

export interface SteerArgs extends AnswerOptions {
  focus?: string | undefined;
  drop?: string | undefined;
  forbid?: string | undefined;
  /** With `forbid`: only for this claim. */
  claimId?: string | undefined;
  limit?: TurnLimit | undefined;
}

/** `harness steer DIR`: focus on or drop a claim, forbid a strategy, set the next turn's limit. One or more in a call. */
export function steerCommand(dir: string, o: SteerArgs): number {
  const by = personName(o.as);
  const steers: Array<{ steer: SteerAction; says: string }> = [];
  if (o.focus !== undefined) steers.push({ steer: { action: "focus", claimId: o.focus }, says: `work first on claim ${o.focus}` });
  if (o.drop !== undefined) steers.push({ steer: { action: "drop", claimId: o.drop }, says: `give up claim ${o.drop} (its problem ends, aborted, when the run resumes)` });
  if (o.forbid !== undefined) {
    steers.push({
      steer: { action: "forbid_strategy", strategy: o.forbid, ...(o.claimId !== undefined ? { claimId: o.claimId } : {}) },
      says: `forbid the strategy ${o.forbid}${o.claimId !== undefined ? ` on claim ${o.claimId}` : ""}`,
    });
  } else if (o.claimId !== undefined) {
    throw new RunSetupError("--claim goes with --forbid, to forbid a strategy on one claim only");
  }
  if (o.limit !== undefined && Object.keys(o.limit).length > 0) {
    steers.push({ steer: { action: "turn_limit", limit: o.limit }, says: `limit the next turn to ${JSON.stringify(o.limit)}` });
  }
  if (steers.length === 0) {
    throw new RunSetupError("steer needs something to say: --focus CLAIM, --drop CLAIM, --forbid STRATEGY [--claim CLAIM], or --turn-tokens, --turn-usd or --turn-minutes for the next turn");
  }
  const journal = openForAnswers(resolve(dir));
  try {
    for (const { steer, says } of steers) {
      const nodeId = recordSteer(journal, { by, steer });
      o.out(`${by}: steer ${nodeId} recorded: ${says}.`);
    }
    o.out(WHAT_NEXT(dir));
  } finally {
    journal.close();
  }
  return 0;
}
