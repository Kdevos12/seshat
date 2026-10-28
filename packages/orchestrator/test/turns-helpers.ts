import { join } from "node:path";
import { BlobStore, type HarnessEvent } from "@seshat/core";
import type { ConsortiumConfig, TurnLimit } from "../src/index.ts";
import { ofType } from "./m0-helpers.ts";

/** A consortium configuration with this limit and the default impasse. */
export function consortium(limit: TurnLimit = {}, extra: Partial<ConsortiumConfig> = {}): ConsortiumConfig {
  return { limit, impasse: { posteriorBelow: 0.1, minAttempts: 8 }, narrative: false, ...extra };
}

/** The last `turn.ended` of a journal. */
export function ended(events: readonly HarnessEvent[]): ReturnType<typeof ofType<"turn.ended">>[number] {
  const turn = ofType(events, "turn.ended").at(-1);
  if (turn === undefined) throw new Error("the journal has no turn.ended");
  return turn;
}

export function blobsOf(dir: string): BlobStore {
  return new BlobStore(join(dir, "blobs"));
}

/** A bench file with two solved problems, as the demo bench has. */
export const TWO_PROBLEMS = `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- Doubling is adding. -/
@[category research solved, AMS 5]
theorem two_mul' (n : ℕ) : 2 * n = n + n := by
  sorry

end Demo
`;

export const TWO_PROBLEM_IDS = ["FormalConjectures/Demo.lean#Demo.add_zero'", "FormalConjectures/Demo.lean#Demo.two_mul'"];
