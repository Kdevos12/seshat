import type { ClaimStatus, Json } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { composeProof, memorySource, type ProofSource } from "./compose.ts";
import type { Explanation } from "./engine.ts";
import type { Fact } from "./rules.ts";
import { DERIVATION_INTENT_KIND, DERIVATION_KIND, type DerivationIntent, type DerivationRecord, type GraphState, type Level } from "./state.ts";

/** The `validate` of a line's context: the one way to submit a Lean proof of a claim or of its negation. */
export type ValidateFn = (request: ValidateRequest) => Promise<ValidateResult>;

export interface RealizeOptions {
  memory: MemoryStore;
  state: GraphState;
  validate: ValidateFn;
  /** The Lean header a claim is read under; the graph's claims must share one to be composed. */
  headerOf: (claimId: string) => string | undefined;
  /** The weakest level a derived fact may have to be submitted. Default `candidate`. */
  minLevel?: Level;
  /** The most composed proofs to submit in one call. Default 8. */
  limit?: number;
  /** Where the proofs come from. Default: the memory's validations and blobs. */
  source?: ProofSource;
  /** Derivations already submitted in this problem, so that a failed one is not sent again. */
  tried?: Set<string>;
  attemptId?: string;
  /** The problem the derivations are submitted for: recorded in each `derivation` node. */
  problemId?: string;
  /**
   * Aborted when the problem ends. Nothing is submitted after that, and a check cut off by it is
   * neither recorded nor counted as tried: it says nothing about the proof.
   */
  signal?: AbortSignal;
  log?: (text: string) => void;
}

export interface Realized {
  fact: Fact;
  level: Level;
  rule: string;
  verdict: "valid" | "invalid" | "skipped";
  /** The claim's status after the check, when a proof was submitted. */
  status?: ClaimStatus;
  validationId?: string;
  reasons: string[];
}

/**
 * Turns the facts the engine derives into checked proofs (plan §3.2, §8): for each derived fact whose
 * claim is still open, writes the composed proof from its derivation tree and submits it through
 * `validate`. The claim changes status only if Lean accepts that proof, and then to whatever
 * `validate` says (`computed`; `proved` after certification). Every submission is recorded as a
 * `derivation` node, with the rule, the edges and the premises that gave it. The state is synced
 * between proofs, so that a claim just settled serves the next derivation.
 */
export async function realize(o: RealizeOptions): Promise<Realized[]> {
  const minLevel = o.minLevel ?? "candidate";
  const limit = o.limit ?? 8;
  const tried = o.tried ?? new Set<string>();
  const source = o.source ?? memorySource(o.memory, o.headerOf);
  const results: Realized[] = [];
  let submitted = 0;
  const stopped = () => o.signal?.aborted === true;
  for (let progressed = true; progressed && submitted < limit && !stopped(); ) {
    progressed = false;
    o.state.sync();
    for (const fact of pending(o, minLevel)) {
      if (submitted >= limit || stopped()) break;
      const why = o.state.explain(fact);
      if (why === undefined) continue;
      const signature = `${fact.goal}:${fact.claim}|${treeSignature(why.tree)}`;
      if (tried.has(signature)) continue;
      tried.add(signature);
      const record: DerivationRecord = {
        goal: fact.goal,
        claimId: fact.claim,
        rule: why.tree.rule as string,
        edges: edgesOf(why.tree),
        premises: (why.tree.premises ?? []).map((p) => ({ goal: p.fact.goal, claimId: p.fact.claim })),
        level: why.level,
        verdict: "skipped",
        ...(o.problemId !== undefined ? { problemId: o.problemId } : {}),
        signature,
      };
      const composition = await composeProof(why.tree, source, o.headerOf);
      if (!composition.ok) {
        o.memory.recordNode({ kind: DERIVATION_KIND, claimId: fact.claim, data: { ...record, reasons: [composition.reason] } });
        results.push({ fact, level: why.level, rule: record.rule, verdict: "skipped", reasons: [composition.reason] });
        o.log?.(`${fact.goal} ${fact.claim} follows by ${record.rule}, but no proof was composed: ${composition.reason}`);
        continue;
      }
      submitted += 1;
      // Said before it is done: a validation of a composed proof must never be left without the derivation node that
      // marks it as composed, however the run ends (documentation/graph.md).
      const { verdict: _none, ...intent } = record;
      o.memory.recordNode({ kind: DERIVATION_INTENT_KIND, claimId: fact.claim, data: intent satisfies DerivationIntent as unknown as Json });
      const result = await o.validate({
        claimId: fact.claim,
        proof: composition.submission.proof,
        aux: composition.submission.aux,
        ...(composition.negation ? { negation: true } : {}),
        ...(o.attemptId !== undefined ? { attemptId: o.attemptId } : {}),
      });
      const verdict = result.verdict;
      if (verdict === "invalid" && stopped()) {
        // The problem ended while Lean was checking: the proof was not refused, it was not judged.
        tried.delete(signature);
        results.push({ fact, level: why.level, rule: record.rule, verdict: "skipped", reasons: ["the problem ended before the check was done"] });
        break;
      }
      o.memory.recordNode({
        kind: DERIVATION_KIND,
        claimId: fact.claim,
        data: { ...record, verdict, ...(result.validationId !== undefined ? { validationId: result.validationId } : {}), ...(verdict === "invalid" ? { reasons: result.reasons.slice(0, 5) } : {}) },
      });
      results.push({
        fact,
        level: why.level,
        rule: record.rule,
        verdict,
        status: result.status,
        ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
        reasons: result.reasons,
      });
      o.log?.(`${fact.goal} ${fact.claim} by ${record.rule} (${why.level}): the composed proof is ${verdict}`);
      if (verdict === "valid") {
        progressed = true;
        break; // the claim changed: sync, and derive again from the new state
      }
    }
  }
  return results;
}

/**
 * Withdraws the claims that hold only through a composed proof whose premises are gone: a claim that
 * is `computed` or `proved` because a derivation said so (and has no proof of its own) goes back to
 * `open`, or to `retracted` (`MemoryStore.retractClaim`), once the graph no longer derives it.
 *
 * It judges only the claims the state follows (`state.claims()`): the memory holds the derivations
 * of every problem of the run, and a claim that another problem composed, outside this state's
 * graph, is not held by this state's engine, which says nothing about it. Returns the claims
 * withdrawn. Sync the state first.
 */
export function revokeUnsupported(memory: MemoryStore, state: GraphState, log?: (text: string) => void): string[] {
  const withdrawn: string[] = [];
  for (const claimId of state.claims()) {
    const claim = memory.claim(claimId);
    if (claim === undefined || (claim.status !== "computed" && claim.status !== "proved")) continue;
    const [composed] = memory
      .nodes(DERIVATION_KIND, { claimId })
      .map((node) => node.data as unknown as DerivationRecord)
      .filter((data) => data.verdict === "valid" && data.goal === "proved");
    if (composed === undefined || state.candidate.holds({ goal: "proved", claim: claimId })) continue;
    memory.retractClaim(claimId, { reason: `its composed proof (${composed.rule}) rests on a fact that no longer holds` });
    withdrawn.push(claimId);
    log?.(`claim ${claimId} withdrawn: what its composed proof used no longer holds`);
  }
  return withdrawn;
}

/** The derived facts to submit now, shortest derivation first. */
function pending(o: RealizeOptions, minLevel: Level): Fact[] {
  const realized = new Set<string>();
  for (const node of o.memory.nodes(DERIVATION_KIND)) {
    const data = node.data as unknown as DerivationRecord;
    if (data.verdict === "valid" && data.goal === "refuted") realized.add(data.claimId);
  }
  const found: Array<{ fact: Fact; depth: number }> = [];
  for (const fact of o.state.candidate.derivedFacts()) {
    const claim = o.memory.claim(fact.claim);
    if (claim === undefined || claim.kind !== "formal" || claim.status !== "open") continue;
    if (fact.goal === "refuted" && realized.has(fact.claim)) continue;
    const why = o.state.explain(fact);
    if (why === undefined || (minLevel === "certified" && why.level !== "certified")) continue;
    found.push({ fact, depth: depthOf(why.tree) });
  }
  return found.sort((a, b) => a.depth - b.depth || (a.fact.goal + a.fact.claim < b.fact.goal + b.fact.claim ? -1 : 1)).map((f) => f.fact);
}

function depthOf(tree: Explanation): number {
  return tree.base ? 0 : 1 + Math.max(0, ...(tree.premises ?? []).map(depthOf));
}

function edgesOf(tree: Explanation): string[] {
  const edges = new Set<string>();
  const walk = (node: Explanation) => {
    if (node.edge !== undefined) edges.add(node.edge);
    for (const premise of node.premises ?? []) walk(premise);
  };
  walk(tree);
  return [...edges];
}

function treeSignature(tree: Explanation): string {
  return tree.base ? tree.fact.goal + tree.fact.claim : `${tree.rule}(${(tree.premises ?? []).map(treeSignature).join(",")})@${tree.edge}`;
}

/**
 * Completes the `derivation` nodes of a problem that a run ended before it wrote: for each
 * `derivation_intent` of the problem with no `derivation` node of the same signature, the first
 * validation of the claim (of its negation, for a refutation) that no attempt made and that came
 * after the intent is the composed proof's, and the node is written from it. An intent with no such
 * validation was cut before Lean answered, and is left: the derivation is submitted again. Returns
 * the nodes written.
 */
export function completeDerivations(memory: MemoryStore, problemId: string): DerivationRecord[] {
  const done = new Set<string>();
  for (const node of memory.nodes(DERIVATION_KIND)) {
    const data = node.data as unknown as DerivationRecord;
    if (data.problemId === problemId && data.signature !== undefined) done.add(data.signature);
  }
  const written: DerivationRecord[] = [];
  for (const node of memory.nodes(DERIVATION_INTENT_KIND)) {
    const intent = node.data as unknown as DerivationIntent;
    if (intent.problemId !== problemId || intent.signature === undefined || done.has(intent.signature)) continue;
    const answered = memory
      .validations(intent.claimId)
      .find((v) => v.method === "repl" && v.attemptId === undefined && v.negation === (intent.goal === "refuted") && v.seq > node.createdSeq);
    if (answered === undefined) continue;
    const record: DerivationRecord = {
      ...intent,
      verdict: answered.verdict,
      validationId: answered.validationId,
      ...(answered.verdict === "invalid" ? { reasons: answered.reasons.slice(0, 5) } : {}),
    };
    memory.recordNode({ kind: DERIVATION_KIND, claimId: intent.claimId, data: record as unknown as Json });
    done.add(intent.signature);
    written.push(record);
  }
  return written;
}
