import { type ClaimStatus, type Json, sha256Hex } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { Edge, MemoryNode, MemoryStore } from "@seshat/memory";
import type { Battery } from "./battery.ts";
import type { EvaluatorKind } from "./fingerprint.ts";
import type { IntegerObject, MagmaObject } from "./objects.ts";
import { leanArguments, needsLift, type RecognizedStatement } from "./statement.ts";

/** An object that a statement fails on: a magma for a statement of magmas, a number for a statement about a number. */
export type CounterModel = MagmaObject | IntegerObject;

/** A proof of the negation of a claim, as `validate` takes it: auxiliary declarations, then the tactics (without `by`). */
export interface NegationProof {
  /** Which form of the proof it is, for the records. */
  form: "have-revert" | "absurd";
  aux: string;
  proof: string;
}

function instanceOf(statement: RecognizedStatement, object: CounterModel): { arguments: string; aux: string; shortArguments: string } {
  if (statement.kind === "nat") {
    if (object.kind !== "integer") throw new TypeError("a statement about a natural number is refuted by a number");
    return { arguments: leanArguments(statement, object.value), aux: "", shortArguments: leanArguments(statement, object.value) };
  }
  if (object.kind !== "magma") throw new TypeError("a statement about magmas is refuted by a magma");
  const name = `aux_m11_${sha256Hex(object.id).slice(0, 12)}`;
  const n = object.size;
  // The table is a definition on `Fin n` either way; a universe-polymorphic claim takes its instance on `ULift (Fin n)`.
  const lift = needsLift(statement);
  return {
    arguments: leanArguments(statement, object, { lift }),
    aux: `def ${name} (a b : Fin ${n}) : Fin ${n} := ([${object.table.join(", ")}] : List (Fin ${n})).getD (a.val * ${n} + b.val) 0`,
    shortArguments: lift ? `(ULift (Fin ${n})) ⟨fun a b => ULift.up (${name} a.down b.down)⟩` : `(Fin ${n}) ⟨${name}⟩`,
  };
}

/**
 * The proofs of `¬ (type_of% @claim)`, the negation the validator asks for, from a counter-model:
 * the claim, instantiated on the object, is a proposition that `decide` settles as false.
 *
 * ```lean
 * intro hall
 * have key := @hall (Fin 2) ⟨fun a b => ([0, 0, 1, 1] : List (Fin 2)).getD (a.val * 2 + b.val) 0⟩
 * revert key
 * decide
 * ```
 *
 * `@hall <object>` is the claim at the object, an implication from its hypotheses to its conclusion
 * (a hypothesis binder is a pi binder like any other), and `decide` shows that this implication is
 * false. The second form (`absurd`) puts the table in a `def aux_...`; it is for the case where the
 * first does not check, since this code has not run against a real Lean.
 *
 * A claim over `Type*` (or `Type _`, `Type u`) has a universe parameter, and inside the proof of its
 * negation that universe is a rigid `u_1`, so `Fin 2 : Type` is not an argument for `hall`. The
 * proofs then use `ULift (Fin 2)`, with the table transported through `down` and `up` (`needsLift`):
 * `@hall (ULift (Fin 2)) ⟨fun a b => ULift.up (...)⟩`. Whether Lean accepts them, and `decide` the
 * `Fintype` and `DecidableEq` instances of `ULift`, is the first item of the list in models.md.
 */
export function negationProofs(statement: RecognizedStatement, object: CounterModel): NegationProof[] {
  const at = instanceOf(statement, object);
  return [
    { form: "have-revert", aux: "", proof: `intro hall\nhave key := @hall ${at.arguments}\nrevert key\ndecide` },
    { form: "absurd", aux: at.aux, proof: `intro hall\nexact absurd (@hall ${at.shortArguments}) (by decide)` },
  ];
}

/** The object in words, for a note and a briefing. */
export function describeCounterModel(object: CounterModel): string {
  if (object.kind === "integer") return `the number ${object.value}`;
  const rows = Array.from({ length: object.size }, (_, a) => `[${object.table.slice(a * object.size, (a + 1) * object.size).join(",")}]`);
  return `the magma of size ${object.size} with the table [${rows.join(",")}] (row a, column b: a * b)`;
}

/** What one submission of a negation proof came to. */
export type RefutationAttempt = {
  form: NegationProof["form"];
  verdict: "valid" | "invalid";
  validationId?: string;
  /** The claim's status after the check: `validate` of a negation records a valid validation and leaves the status alone. */
  status: ClaimStatus;
  reasons: string[];
};

/**
 * Submits the negation of a claim, proved from a counter-model, through `validate`, trying each form
 * of the proof until one is valid. The fingerprint never refutes anything: a refutation is a Lean
 * proof of the negation, and the claim becomes `refuted` only once the certifier replays it.
 */
export async function submitRefutation(
  validate: (request: ValidateRequest) => Promise<ValidateResult>,
  input: { claimId: string; statement: RecognizedStatement; object: CounterModel; attemptId?: string },
): Promise<RefutationAttempt[]> {
  const attempts: RefutationAttempt[] = [];
  for (const candidate of negationProofs(input.statement, input.object)) {
    const result = await validate({
      claimId: input.claimId,
      negation: true,
      proof: candidate.proof,
      ...(candidate.aux !== "" ? { aux: candidate.aux } : {}),
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    });
    attempts.push({
      form: candidate.form,
      verdict: result.verdict,
      ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
      status: result.status,
      reasons: result.reasons,
    });
    if (result.verdict === "valid") break;
  }
  return attempts;
}

/** The data of a node of kind `counter_model`: the object a claim fails on, and what became of its refutation. */
export interface CounterModelData {
  battery: string;
  digest: string;
  /** The object's place in the battery. */
  index: number;
  object: Json;
  description: string;
  evaluator: EvaluatorKind;
  /** For a statement of magmas by the law evaluator: the values of the conclusion's variables that break it. */
  witness?: number[];
  /** The submissions of the negation proof, in order. */
  refutation?: RefutationAttempt[];
  [key: string]: Json | undefined;
}

/**
 * Records a counter-model of a claim, with a `refuted_by` edge from the claim. The edge is
 * `computed`: the object was found by a tool, and nothing is proved until the negation checks.
 */
export function recordCounterModel(
  memory: MemoryStore,
  input: { claimId: string; battery: Battery; index: number; object: CounterModel; evaluator: EvaluatorKind; witness?: number[] },
): { node: MemoryNode; edge: Edge } {
  const description = describeCounterModel(input.object);
  const data: CounterModelData = {
    battery: input.battery.id,
    digest: input.battery.digest,
    index: input.index,
    object: input.object.kind === "magma" ? { kind: "magma", size: input.object.size, table: [...input.object.table] } : { kind: "integer", value: input.object.value },
    description,
    evaluator: input.evaluator,
    ...(input.witness !== undefined ? { witness: input.witness } : {}),
  };
  // The same counter-model of the same claim is recorded once, with its edge: a call the process ended in the middle of is finished by the next.
  const known = memory.nodes("counter_model", { claimId: input.claimId }).find((n) => (n.data as CounterModelData).digest === data.digest && (n.data as CounterModelData).index === data.index);
  const node = known ?? memory.recordNode({ kind: "counter_model", claimId: input.claimId, data: data as Json });
  const edge =
    memory.edges({ from: input.claimId, kinds: ["refuted_by"] }).find((e) => e.to.includes(node.nodeId)) ??
    memory.addEdge({
      kind: "refuted_by",
      from: input.claimId,
      to: node.nodeId,
      status: "computed",
      note: `the statement fails on ${description}; a refutation needs a Lean proof of the negation`,
    });
  return { node, edge };
}
