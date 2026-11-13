import { quotedSketch } from "./screen.ts";

/**
 * The informal proof of a problem (plan changes PA13, NL2, AL1 to AL3, documentation/informal.md): a natural-language proof that a generator wrote and
 * a verifier read, journaled as a node of this kind on the problem's claim. It is a hint: it never changes a claim's status, and no word of it says
 * "proved". Only Lean judges. These are the node's shape and what reads it, shared by the prover's briefing, the planner's prompt and the report.
 */
export const INFORMAL_PROOF_KIND = "informal_proof";

/** The data of an `informal_proof` node. The proof text is a blob, `proofHash`. */
export interface InformalProofData {
  problemId: string;
  /** True when `required` verifier passes in a row said `correct`. */
  accepted: boolean;
  /** The `correct` verdicts in a row at the end of the loop: the passes of an accepted proof. */
  passes: number;
  /** The passes the setting asked for. */
  required: number;
  /** The generate-or-revise calls the loop made. */
  rounds: number;
  /** Every verdict, in order. */
  verdicts: string[];
  /** The models the loop's calls went to, by role. */
  models: { planner: string; verifier: string };
  /** Why the loop ended: `accepted`, `rounds`, `gate`, `failed` or `stopped`. */
  stop: string;
  /** The blob of the proof text (the accepted one, or the last one); absent when none was written. */
  proofHash?: string;
  /** The Mathlib facts the proof says it relies on, at most five. */
  facts: string[];
  /** The names `lean.search` found for them. */
  hits: string[];
}

/** An informal proof as the nodes of a claim hold it, with its text read from the blobs. */
export interface InformalProof extends InformalProofData {
  nodeId?: string;
  /** The proof text; empty when none was written or the blob is gone. */
  text: string;
}

/** The newest `informal_proof` node of a problem, or undefined. `read` gives a blob's text. */
export function informalProofOfNodes(nodes: ReadonlyArray<{ node_id?: string; nodeId?: string; data: unknown }>, read: (hash: string) => string | undefined): InformalProof | undefined {
  for (const node of [...nodes].reverse()) {
    const d = node.data;
    if (typeof d !== "object" || d === null || Array.isArray(d)) continue;
    const r = d as Partial<InformalProofData>;
    if (typeof r.accepted !== "boolean" || typeof r.passes !== "number") continue;
    const text = typeof r.proofHash === "string" ? (read(r.proofHash) ?? "") : "";
    const id = node.node_id ?? node.nodeId;
    return {
      problemId: String(r.problemId ?? ""),
      accepted: r.accepted,
      passes: r.passes,
      required: typeof r.required === "number" ? r.required : r.passes,
      rounds: typeof r.rounds === "number" ? r.rounds : 0,
      verdicts: Array.isArray(r.verdicts) ? r.verdicts.map(String) : [],
      models: { planner: String(r.models?.planner ?? ""), verifier: String(r.models?.verifier ?? "") },
      stop: String(r.stop ?? ""),
      ...(typeof r.proofHash === "string" ? { proofHash: r.proofHash } : {}),
      facts: Array.isArray(r.facts) ? r.facts.map(String) : [],
      hits: Array.isArray(r.hits) ? r.hits.map(String) : [],
      text,
      ...(id !== undefined ? { nodeId: id } : {}),
    };
  }
  return undefined;
}

/**
 * The section that shows an accepted informal proof to a prover or a planner: titled as what it is, the proof quoted line by line as data, the facts
 * it relies on and the names the search found. Undefined for a proof that was not accepted, which is shown to nobody, or an empty one.
 */
export function informalSection(proof: InformalProof | undefined): { title: string; text: string } | undefined {
  if (proof === undefined || !proof.accepted || proof.text.trim() === "") return undefined;
  const passes = proof.passes;
  return {
    title: `An informal proof, checked by ${passes} verifier pass${passes === 1 ? "" : "es"} and not by Lean`,
    text:
      "A model wrote this natural-language proof and another read it; it is a hint, not a proof. It may be wrong, and it says nothing about Lean. " +
      "Use it for ideas and the shape of an argument, and say in your notes if it turned out wrong.\n" +
      quotedSketch(proof.text) +
      (proof.facts.length > 0 ? `\nMathlib facts it relies on, as it names them: ${proof.facts.join("; ")}` : "") +
      (proof.hits.length > 0 ? `\nNames that a search of Mathlib found for them (to check, not to trust): ${proof.hits.join(", ")}` : ""),
  };
}
