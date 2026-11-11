import { leanTextProblems, sha256Hex } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { GraphObject } from "./objects.ts";
import type { GraphStatement } from "./graph-statement.ts";
import type { NegationProof, RefutationAttempt } from "./refutation.ts";

/**
 * The Lean side of a graph witness (plan change CA19): a graph on `Fin n` from its edge list, put in
 * the proof of the negation of a claim about graphs, and in a certificate file that uses the
 * templates of `lean/SeshatLib/Finite`. Nothing here has run against a real Lean
 * (documentation/finite-lean.md says what to verify). The text it writes holds numbers, brackets and
 * names it makes itself, and uses `decide` and nothing that adds an axiom.
 */

type Edge = readonly [number, number];

/** The edge list as a Lean term of type `List (Nat × Nat)`. */
export function leanEdgeList(edges: readonly Edge[]): string {
  return `([${edges.map(([u, v]) => `(${u}, ${v})`).join(", ")}] : List (Nat × Nat))`;
}

/** The names of the graph's definitions, from its graph6 string: `aux_` is what the validator asks of an auxiliary declaration. */
export function graphNames(graph: GraphObject): { graph: string; adjacency: string } {
  const key = sha256Hex(graph.graph6).slice(0, 12);
  return { graph: `aux_g_${key}`, adjacency: `aux_gd_${key}` };
}

/**
 * The auxiliary declarations of a graph on `Fin n`, as `def`s that the validator admits in the
 * auxiliary region (`abbrev`, no `instance`): the graph, and its adjacency as a decidable relation.
 * The graph is the one of `SeshatLib.Finite.ofEdges`, written out, so that the check needs no import
 * that the claim's own file does not have.
 */
export function graphAux(graph: GraphObject): string {
  const { graph: g, adjacency } = graphNames(graph);
  const list = leanEdgeList(graph.edges);
  const adj = (a: string, b: string) => `${a} ≠ ${b} ∧ ((${a}.val, ${b}.val) ∈ ${list} ∨ (${b}.val, ${a}.val) ∈ ${list})`;
  return [
    `abbrev ${g} : SimpleGraph (Fin ${graph.n}) where`,
    `  Adj a b := ${adj("a", "b")}`,
    "  symm := fun _ _ h => ⟨h.1.symm, h.2.symm⟩",
    "  loopless := fun _ h => h.1 rfl",
    "",
    `abbrev ${adjacency} : DecidableRel ${g}.Adj := fun a b => inferInstanceAs (Decidable (${adj("a", "b")}))`,
  ].join("\n");
}

/** The arguments of `@hall` for a graph: the type, the instances, the graph, the instances after it. `explicit` passes the adjacency instance by name. */
function graphArguments(statement: GraphStatement, graph: GraphObject, explicit: boolean): string {
  const { graph: g, adjacency } = graphNames(graph);
  const lift = !(statement.sort === "Type" || statement.sort === "Type 0");
  const vertices = lift ? `(ULift (Fin ${graph.n}))` : `(Fin ${graph.n})`;
  const term = lift ? `(SimpleGraph.comap ULift.down ${g})` : g;
  return statement.parameters
    .map((p) => {
      if (p.role === "type") return vertices;
      if (p.role === "graph") return term;
      if (p.adjacency && explicit) return lift ? `(fun a b => ${adjacency} a.down b.down)` : adjacency;
      return "_";
    })
    .join(" ");
}

/**
 * The proofs of `¬ (type_of% @claim)` from a graph, in the two forms of M11's refutation of a magma
 * (`negationProofs`): the claim at the graph, an implication from its hypotheses to its conclusion,
 * which `decide` shows false. The first form leaves every instance to type class resolution; the
 * second passes the adjacency instance by name. A claim over `Type*` takes the graph on `ULift (Fin n)`.
 */
export function graphNegationProofs(statement: GraphStatement, graph: GraphObject): NegationProof[] {
  const aux = graphAux(graph);
  return [
    { form: "have-revert", aux, proof: `intro hall\nhave key := @hall ${graphArguments(statement, graph, false)}\nrevert key\ndecide` },
    { form: "absurd", aux, proof: `intro hall\nexact absurd (@hall ${graphArguments(statement, graph, true)}) (by decide)` },
  ];
}

/** Why Lean said no, in one word, from what `validate` reports: what the next step to take depends on. */
export type LeanErrorClass = "decide_false" | "instance" | "timeout" | "syntax" | "refused" | "other";

export function leanErrorClass(reasons: readonly string[]): LeanErrorClass {
  const text = reasons.join(" ").toLowerCase();
  if (/failed to synthesize|typeclass|type class|instance/.test(text)) return "instance";
  if (/maximum recursion|heartbeat|timeout|timed out|deterministic/.test(text)) return "timeout";
  if (/decide|evaluates to false|proposition is false|failed to reduce/.test(text)) return "decide_false";
  if (/unexpected token|expected|parse error|unknown (?:identifier|constant)/.test(text)) return "syntax";
  if (/not allowed|refused|forbidden|structural/.test(text)) return "refused";
  return "other";
}

/**
 * Submits the negation of a claim, proved from a graph, through `validate`, trying each form until one
 * is valid. The text is screened first as every text the harness writes into a Lean file is. A graph
 * is a hit for a program; the claim changes only when Lean accepts the proof and the certifier replays it.
 */
export async function submitGraphRefutation(
  validate: (request: ValidateRequest) => Promise<ValidateResult>,
  input: { claimId: string; statement: GraphStatement; graph: GraphObject; attemptId?: string },
): Promise<Array<RefutationAttempt & { errorClass?: LeanErrorClass }>> {
  const attempts: Array<RefutationAttempt & { errorClass?: LeanErrorClass }> = [];
  for (const candidate of graphNegationProofs(input.statement, input.graph)) {
    const problems = leanTextProblems(`${candidate.aux}\n${candidate.proof}`);
    if (problems.length > 0) {
      attempts.push({ form: candidate.form, verdict: "invalid", status: "open", reasons: [`the text was not sent: ${problems.join("; ")}`], errorClass: "refused" });
      continue;
    }
    const result = await validate({
      claimId: input.claimId,
      negation: true,
      proof: candidate.proof,
      aux: candidate.aux,
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    });
    attempts.push({
      form: candidate.form,
      verdict: result.verdict,
      ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
      status: result.status,
      reasons: result.reasons,
      ...(result.verdict === "invalid" ? { errorClass: leanErrorClass(result.reasons) } : {}),
    });
    if (result.verdict === "valid") break;
  }
  return attempts;
}

/**
 * The certificate's Lean file: the witness as `SeshatLib.Finite.ofEdges`, and the facts about it that
 * the harness knows (the degree sequence, whether it is connected) as `example`s that `decide`
 * settles, to be checked against a Lean that has the library. It says nothing about the claim.
 */
export function graphCertificateLean(graph: GraphObject, facts: { degrees: readonly number[]; connected: boolean }): string {
  const list = leanEdgeList(graph.edges);
  const lines = [
    "import SeshatLib.Finite.Witness",
    "",
    "open SeshatLib.Finite",
    "",
    `abbrev witness : SimpleGraph (Fin ${graph.n}) := ofEdges ${graph.n} ${list}`,
    "",
    `example : degreeSeq witness = [${facts.degrees.join(", ")}] := by decide`,
  ];
  if (graph.n >= 1) lines.push(`example : ${facts.connected ? "" : "¬ "}ConnectedSmall witness := by decide`);
  return `${lines.join("\n")}\n`;
}

/** The degrees of the vertices 0..n-1 of a graph. */
export function degreeSequence(graph: { n: number; edges: readonly Edge[] }): number[] {
  const degrees = new Array<number>(graph.n).fill(0);
  for (const [u, v] of graph.edges) {
    degrees[u] = (degrees[u] as number) + 1;
    degrees[v] = (degrees[v] as number) + 1;
  }
  return degrees;
}
