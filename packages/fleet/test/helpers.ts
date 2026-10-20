import type { Attempt } from "@seshat/memory";

let counter = 0;

/** A finished attempt, as the memory store reads it back. */
export function attempt(fields: Partial<Attempt> = {}): Attempt {
  counter += 1;
  return {
    attemptId: `att_${counter}`,
    claimId: "clm_1",
    prover: "p1",
    iteration: counter,
    model: "faux/prover",
    role: "prove",
    startedSeq: counter * 2,
    finishedSeq: counter * 2 + 1,
    ...fields,
  };
}

/** A failed attempt that got as far as this failure class, with this strategy. */
export function failedAt(failureClass: string, strategy?: string, fields: Partial<Attempt> = {}): Attempt {
  return attempt({ outcome: "invalid", failureClass, ...(strategy !== undefined ? { strategy } : {}), ...fields });
}

/** An attempt whose proof the fast check accepted. */
export function proved(strategy?: string, fields: Partial<Attempt> = {}): Attempt {
  return attempt({ outcome: "valid", ...(strategy !== undefined ? { strategy } : {}), ...fields });
}
