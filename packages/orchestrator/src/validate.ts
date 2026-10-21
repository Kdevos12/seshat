import { type BlobStore, CheckFailedError, type Journal, type LeanCertifier, prepareSketch, ProofValidator, SKETCH_POLICY } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { messageOf, RegistryLeanChecker, type Registry } from "@seshat/registry";
import { conflictNote, Workbench } from "./problem.ts";

export interface ClaimBenchesOptions {
  journal: Journal;
  registry: Registry;
  memory: MemoryStore;
  blobs: BlobStore;
  /** Certifies the candidates `certifyPending` finds. Without one they stay candidates. */
  certifier?: LeanCertifier;
  log?: (line: string) => void;
}

/** A problem of the run, as the lines' submissions know it. */
export interface BenchProblem {
  problemId: string;
  /** The problem's claim. */
  claimId: string;
  /** The problem's workbench: a proof of the problem's claim goes there, as a prover's would. */
  workbench: Workbench;
}

/** Who submits, and the problem it happens in. */
export interface ValidateContext {
  /** `line:<id>`: the actor of the Lean checks. */
  actor: string;
  signal: AbortSignal;
  /** The problem the submission is made for. Without one, what it makes a candidate is nobody's, and nothing certifies it. */
  problem?: BenchProblem;
}

/** What `certifyPending` found when it certified a problem's own submissions. */
export interface PendingResult {
  /**
   * What the problem's claim became because a proof or a refutation of it that the problem's lines
   * submitted was certified, if one was: the problem's outcome follows that, and only that.
   */
  settled?: "proved" | "refuted";
  /**
   * Certified proofs and refutations whose claim they did not settle: it was settled the other
   * way (a contradiction), or withdrawn. The claim's status did not move.
   */
  conflicts: Array<{ claimId: string; message: string }>;
}

/**
 * The lines' `validate`. A proof of a problem's claim goes to the problem's workbench, so it can
 * settle the problem like a prover's proof. Any other claim, and any negation, gets a workbench
 * of its own, built on first use from the claim's reference file (`MemoryStore.referenceFor`) and
 * kept for the run. A valid proof makes the claim a candidate; a valid refutation is recorded with
 * `negation: true` and changes no status. Only certification settles a claim, and it comes later:
 * `certifyPending` certifies what a problem's lines submitted, when that problem's lines are done.
 * What a workbench holds is the candidate of the problem whose submission made it, and that
 * problem is the one that certifies it.
 */
export class ClaimBenches {
  private readonly o: ClaimBenchesOptions;
  private readonly benches = new Map<string, Workbench | { failed: string }>();
  /** The problem whose submission made the candidate of a workbench made here: it certifies it. */
  private readonly owners = new Map<Workbench, string>();

  constructor(options: ClaimBenchesOptions) {
    this.o = options;
  }

  async validate(request: ValidateRequest, context: ValidateContext): Promise<ValidateResult> {
    const claim = this.o.memory.claim(request.claimId);
    if (claim === undefined) throw new Error(`validate: unknown claim ${request.claimId}`);
    if (claim.kind === "informal") throw new Error(`validate: claim ${request.claimId} is informal; only Lean proofs are validated`);
    const negation = request.negation === true;
    const status = () => this.o.memory.claim(request.claimId)?.status ?? claim.status;
    let bench: Workbench;
    if (!negation && context.problem?.claimId === request.claimId) {
      bench = context.problem.workbench;
    } else {
      try {
        bench = await this.bench(request.claimId, negation, context.signal);
      } catch (error) {
        const side = negation ? "the negation of claim" : "claim";
        return { verdict: "invalid", status: status(), reasons: [`the reference file of ${side} ${request.claimId} does not check: ${messageOf(error)}`] };
      }
    }
    const result = await bench.check(
      { aux: request.aux ?? "", proof: request.proof },
      {
        actor: context.actor,
        signal: context.signal,
        ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
        ...(context.problem !== undefined ? { problemId: context.problem.problemId } : {}),
      },
    );
    if (result.accepted && context.problem !== undefined && bench !== context.problem.workbench) {
      this.owners.set(bench, context.problem.problemId);
    }
    return {
      verdict: result.report.verdict,
      ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
      status: status(),
      reasons: result.report.reasons,
      report: result.report,
    };
  }

  /**
   * Certifies, one after the other, what a problem's lines submitted and no one has certified: the
   * problem's own workbench (a proof of its claim that a line found late), and the workbenches
   * whose candidate a submission of this problem made, in the order they were made. The candidates
   * of other problems are left to those problems, which certify them when their lines are done.
   * A certified proof makes its claim `proved`, a certified refutation `refuted`; a candidate that
   * the certifier rejects, or cannot answer for, stays a candidate. Each is tried once. Never
   * throws: what happened is logged, and what it came to for the problem is returned.
   */
  async certifyPending(problem: BenchProblem, signal: AbortSignal | undefined): Promise<PendingResult> {
    const log = this.o.log ?? (() => {});
    const result: PendingResult = { conflicts: [] };
    const made = [...this.benches.values()].filter(
      (bench): bench is Workbench => bench instanceof Workbench && this.owners.get(bench) === problem.problemId,
    );
    for (const bench of [problem.workbench, ...made]) {
      if (!bench.awaitsCertification) continue;
      if (signal?.aborted) break;
      const what = `${bench.negation ? "refutation" : "proof"} of claim ${bench.claimId}`;
      try {
        const certified = await bench.certify(signal);
        if (certified === undefined) continue;
        if (certified.result.verdict !== "certified") {
          log(`the certifier rejected the ${what}: ${certified.result.reasons.join("; ")}`);
          continue;
        }
        const settled = bench.negation ? "refuted" : "proved";
        if (certified.status === settled) {
          if (bench.claimId === problem.claimId) result.settled ??= settled;
          log(`the ${what} was certified: the claim is ${settled}`);
        } else {
          const message = conflictNote(`the ${what}`, certified.status);
          result.conflicts.push({ claimId: bench.claimId, message });
          log(message);
        }
      } catch (error) {
        log(`the ${what} could not be certified: ${messageOf(error)}`);
      }
    }
    return result;
  }

  /**
   * The workbench of a claim or of its negation. A reference that Lean did not answer for (it could
   * not be reached, or the check was stopped) is tried again next time; one that does not compile
   * is not.
   */
  private async bench(claimId: string, negation: boolean, signal: AbortSignal): Promise<Workbench> {
    const key = `${claimId}${negation ? " negation" : ""}`;
    const known = this.benches.get(key);
    if (known instanceof Workbench) return known;
    if (known !== undefined) throw new Error(known.failed);
    try {
      const reference = this.o.memory.referenceFor(claimId, { negation });
      const sketch = prepareSketch(reference.source, reference.theorem);
      const checker = new RegistryLeanChecker(this.o.registry, { actor: "orchestrator" });
      const type = await new ProofValidator(checker, { policy: SKETCH_POLICY }).reference(sketch, reference.source, { signal });
      const bench = new Workbench({
        journal: this.o.journal,
        registry: this.o.registry,
        problem: { source: reference.source, sketch },
        claimId,
        reference: type,
        blobs: this.o.blobs,
        negation,
        ...(this.o.certifier !== undefined ? { certifier: this.o.certifier } : {}),
      });
      this.benches.set(key, bench);
      return bench;
    } catch (error) {
      if (!(error instanceof CheckFailedError) && !signal.aborted) this.benches.set(key, { failed: messageOf(error) });
      throw error;
    }
  }
}
