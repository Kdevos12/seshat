import { forbiddenTokensIn, type Json, maskCommentsAndStrings } from "@seshat/core";
import type { FinishedAttempt, ProblemContext } from "@seshat/lines";
import {
  CANDIDATE_KIND,
  type CandidateData,
  candidates,
  allLemmas,
  LEMMA_KIND,
  type LemmaData,
} from "./records.ts";
import { glossOf, importHeader, libraryName, parseAuxRegion } from "./lemmas.ts";
import type { TrivialityTest } from "./triviality.ts";

/** How the line promotes (the line's options). */
export interface PromotionOptions {
  /** The most auxiliary lemmas of one attempt that are looked at. */
  maxPerAttempt: number;
  /** The most candidates one problem promotes. */
  maxPerProblem: number;
  /** Also look at the auxiliary lemmas of attempts that failed. Default false: only a proof the fast check accepted. */
  fromFailed: boolean;
}

export const DEFAULT_PROMOTION: PromotionOptions = { maxPerAttempt: 5, maxPerProblem: 10, fromFailed: false };

/** The domain of a lemma: the problem's first domain, or `general`. */
export function domainOf(problem: Pick<ProblemContext, "domain">): string {
  return problem.domain[0] ?? "general";
}

function stampOf(problem: ProblemContext): { mathlibRev?: string; promotedAt?: string } {
  try {
    const stamp = problem.memory.stamp();
    return { mathlibRev: stamp.mathlibRev, promotedAt: stamp.createdAt };
  } catch {
    // A store without a provenance context (a unit test) has no revision to record.
    return {};
  }
}

/**
 * After a session: the auxiliary lemmas of its last check become candidates, one `library_candidate`
 * node each, `pending` until `promoteCandidates` decides. A candidate is only a note of what to look at;
 * nothing is promoted here, and a lemma of a session that was cut or that checked nothing is not read.
 * Returns the candidates recorded (the same lemma of the same attempt is recorded once).
 */
export function recordCandidates(problem: ProblemContext, attempt: FinishedAttempt, options: PromotionOptions): number {
  if (attempt.submission === undefined || attempt.submission.aux.trim() === "") return 0;
  if (attempt.outcome !== "valid" && !(options.fromFailed && attempt.outcome === "invalid")) return 0;
  const { lemmas, skipped } = parseAuxRegion(attempt.submission.aux);
  for (const s of skipped) problem.log(`library: ${s.name} is not a candidate: ${s.reason}`);
  const known = new Set(candidates(problem.memory, { problemId: problem.problemId }).filter((c) => c.attemptId === attempt.attemptId).map((c) => c.name));
  const header = importHeader(problem.target.source);
  let recorded = 0;
  for (const lemma of lemmas.slice(0, options.maxPerAttempt)) {
    if (known.has(lemma.name)) continue;
    // A proof the fast check accepted passed the validator's screen; one of a failed attempt may have been refused for a forbidden
    // token, and the triviality probe would send it to Lean as it is (review M5).
    const forbidden = forbiddenTokensIn(maskCommentsAndStrings(`${lemma.statement}\n${lemma.proof}`, { strict: true }));
    if (forbidden.length > 0) {
      problem.log(`library: ${lemma.name} is not a candidate: it holds a forbidden token (${forbidden.join(", ")})`);
      continue;
    }
    const data: CandidateData = {
      status: "pending",
      problemId: problem.problemId,
      claimId: problem.claimId,
      attemptId: attempt.attemptId,
      name: lemma.name,
      statement: lemma.statement,
      proof: lemma.proof,
      ...(lemma.doc !== undefined ? { doc: lemma.doc } : {}),
      header,
    };
    problem.memory.recordNode({ kind: CANDIDATE_KIND, claimId: problem.claimId, data: data as unknown as Json });
    recorded += 1;
  }
  return recorded;
}

/** What `promoteCandidates` did with the pending candidates of a problem. */
export interface PromotionResult {
  promoted: number;
  duplicate: number;
  trivial: number;
  unproved: number;
  /** Left pending: the problem ended, Lean did not answer, or the per-problem cap was reached. */
  left: number;
}

/**
 * The promotion criteria (plan Task 9), applied to the problem's pending candidates in the order they were
 * recorded:
 *
 * 1. **Duplicate.** The statement's id (the run's identity, under the lemma's header) is a library lemma's
 *    already: nothing more is done.
 * 2. **Non-trivial.** The test (`isTrivial`) says whether the battery's cheapest automation closes the
 *    statement; a trivial one is not promoted.
 * 3. **General and proved.** The lemma is stated as a claim of its own under the imports it stands on and
 *    nothing else, and its proof is submitted through `validate`. The reference file of that claim has no
 *    local definition, hypothesis or `open`, so a lemma that depends on the problem's context fails here.
 *    Only a valid proof promotes it; its claim is then `computed`, and the certifier makes it `proved`.
 *
 * Each decision updates the candidate's node, so a call made again after an interruption does not repeat it.
 */
export async function promoteCandidates(problem: ProblemContext, isTrivial: TrivialityTest, options: PromotionOptions): Promise<PromotionResult> {
  const result: PromotionResult = { promoted: 0, duplicate: 0, trivial: 0, unproved: 0, left: 0 };
  const pending = candidates(problem.memory, { status: "pending", problemId: problem.problemId });
  const memory = problem.memory;
  const settle = (nodeId: string, status: CandidateData["status"], reason: string | undefined, libraryNameOf?: string): void => {
    memory.updateNode(nodeId, { status, ...(reason !== undefined ? { reason } : {}), ...(libraryNameOf !== undefined ? { libraryName: libraryNameOf } : {}) }, `the library decided: ${status}`);
  };
  let promotedHere = allLemmas(memory).filter((l) => l.source.problemId === problem.problemId).length;
  for (const [i, c] of pending.entries()) {
    if (problem.signal.aborted) {
      result.left += pending.length - i;
      break;
    }
    if (promotedHere >= options.maxPerProblem) {
      result.left += pending.length - i;
      break;
    }
    const statementId = await memory.identity.id(c.statement, { header: c.header });
    const same = memory.claimByStatement(statementId);
    const existing = same === undefined ? undefined : allLemmas(memory).find((l) => l.claimId === same.claimId);
    if (existing !== undefined && existing.stale === true) {
      // The old proof no longer compiles under the current revision: a new proof of the same statement replaces it in the same entry.
      const validation = await problem.validate({ claimId: existing.claimId, proof: c.proof });
      if (validation.verdict !== "valid") {
        settle(c.nodeId, "unproved", `a new proof of ${existing.name}, whose proof is stale, was not accepted: ${validation.reasons[0] ?? "invalid"}`);
        result.unproved += 1;
        continue;
      }
      const rev = stampOf(problem).mathlibRev;
      memory.updateNode(existing.nodeId, { proof: c.proof, stale: false, ...(rev !== undefined ? { checkedRev: rev, mathlibRev: rev } : {}), source: { problemId: problem.problemId, claimId: problem.claimId, attemptId: c.attemptId, name: c.name } }, "a new proof replaced the stale one");
      settle(c.nodeId, "promoted", `replaced the stale proof of ${existing.name}`, existing.name);
      result.promoted += 1;
      continue;
    }
    if (existing !== undefined) {
      settle(c.nodeId, "duplicate", `the library has this statement as ${existing.name}`, existing.name);
      result.duplicate += 1;
      continue;
    }
    let verdict;
    try {
      verdict = await isTrivial({ statement: c.statement, header: c.header }, problem);
    } catch (error) {
      if (problem.signal.aborted) {
        result.left += pending.length - i;
        break;
      }
      problem.log(`library: ${c.name} stays pending, the triviality test failed: ${error instanceof Error ? error.message : String(error)}`);
      result.left += 1;
      continue;
    }
    if (verdict.trivial) {
      settle(c.nodeId, "trivial", `closed by ${verdict.by ?? "the cheap automation"}`);
      result.trivial += 1;
      continue;
    }
    const domain = domainOf(problem);
    const safeDoc = glossOf(c.doc);
    const gloss = safeDoc ?? `Auxiliary lemma ${c.name.replace(/^aux_/, "")} from ${problem.target.theorem}`;
    let ensured: Awaited<ReturnType<typeof memory.ensureClaim>>;
    try {
      ensured = await memory.ensureClaim({
        statement: c.statement,
        header: c.header,
        origin: "line:M3",
        gloss,
        domain: problem.domain.length > 0 ? [...problem.domain] : [],
      });
    } catch (error) {
      // A statement that uses a definition not yet reviewed (plan change LC5) cannot be a claim, so it cannot be a library lemma.
      settle(c.nodeId, "unproved", `the lemma cannot be a claim: ${error instanceof Error ? error.message : String(error)}`);
      result.unproved += 1;
      continue;
    }
    const validation = await problem.validate({ claimId: ensured.claimId, proof: c.proof });
    if (validation.verdict !== "valid") {
      settle(c.nodeId, "unproved", `the lemma alone was not accepted: ${validation.reasons[0] ?? "invalid"}`);
      result.unproved += 1;
      continue;
    }
    const name = libraryName(c.name, ensured.statementId);
    const env = problem.registry.leanEnv;
    const data: LemmaData = {
      name,
      statementId: ensured.statementId,
      claimId: ensured.claimId,
      statement: c.statement,
      proof: c.proof,
      ...(safeDoc !== undefined ? { doc: safeDoc } : {}),
      header: c.header,
      domain,
      gloss,
      source: { problemId: problem.problemId, claimId: problem.claimId, attemptId: c.attemptId, name: c.name },
      ...(env !== undefined ? { leanEnv: { name: env.name, hash: env.hash } } : {}),
      ...stampOf(problem),
    };
    memory.recordNode({ kind: LEMMA_KIND, claimId: ensured.claimId, data: data as unknown as Json });
    settle(c.nodeId, "promoted", undefined, name);
    promotedHere += 1;
    result.promoted += 1;
    problem.log(`library: ${c.name} promoted as ${name}`);
  }
  return result;
}
