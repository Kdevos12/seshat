import { join } from "node:path";
import type { LeanChecker } from "@seshat/core";
import { type LeanMetaInput, type LeanMetaOutput, SimulatedLeanMeta, simulatedId } from "@seshat/lean-meta";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { REPO_ROOT, type RunOptions } from "../src/index.ts";
import { AUX, SKETCH_PROOF } from "./m12-helpers.ts";

export { AUX, SKETCH_PROOF };

/** A second sketch of the same theorem: it keeps the first sketch's `aux_left` and replaces `aux_right` with a hole of its own. */
export const AUX2 = `lemma aux_left (n : ℕ) : 0 + n = n := by
  sorry

lemma aux_extra (n : ℕ) : n = n + 0 := by
  sorry`;

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "lean.meta": { use: ["kimina"] } } };

/** The demo registry with `lean.meta` served by the table of a `SimulatedLeanMeta`. */
export function metaRegistry(meta: SimulatedLeanMeta): (lean: LeanChecker) => RunOptions["registry"] {
  return (lean) => (journal, blobs) =>
    new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), "kimina-meta": meta.factory() }, journal, blobs });
}

/** A `lean.meta` that confirms every schema (the goal is an instance of any conclusion put to it) and finds no fact covered, or refuses. */
export class ConfirmingMeta extends SimulatedLeanMeta {
  /** What the schema comparison answers: `yes`, `no` (not an instance), or `refuse` (Lean rejects the statement). */
  mode: "yes" | "no" | "refuse" = "yes";

  override answer(input: LeanMetaInput): LeanMetaOutput {
    this.calls.push(input);
    if (input.op === "hash") return { id: simulatedId(input.statement) };
    if (input.op !== "instances") throw new Error(`no answer for ${input.op}`);
    if (input.facts.some((f) => f.name === "schema")) {
      if (this.mode === "refuse") throw new Error("elaboration failed: unknown binder type");
      return { instanceOf: this.mode === "yes" ? ["schema"] : [], covers: [] };
    }
    return { instanceOf: [], covers: [] };
  }
}

/** The file of the two-problem runs: two statements of one shape, of which the first closes and the second may be offered its schema. */
export const TWO_FILE = `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- Adding zero on the right of a variable. -/
@[category research solved, AMS 11]
theorem add_zero2' (k : ℕ) : k + 0 = k := by
  sorry

end Demo
`;

/** The first sketch with the binder of `add_zero2'`. */
export const AUXK = `lemma aux_left (k : ℕ) : 0 + k = k := by
  sorry

lemma aux_right (k : ℕ) : k + 0 = 0 + k := by
  sorry`;

/** The comparisons of a schema's conclusion with a goal that `lean.meta` was asked, by goal. */
export function confirmations(meta: SimulatedLeanMeta): string[] {
  return meta.calls.flatMap((c) => (c.op === "instances" && c.facts.some((f) => f.name === "schema") ? [c.statement] : []));
}
