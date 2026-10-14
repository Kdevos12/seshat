import { type BlobStore, CheckFailedError, type Journal, prepareSketch, ProofValidator, SKETCH_POLICY } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { messageOf, RegistryLeanChecker, type Registry } from "@seshat/registry";
import { Workbench } from "./problem.ts";

export interface ClaimBenchesOptions {
  journal: Journal;
  registry: Registry;
  memory: MemoryStore;
  blobs: BlobStore;
}

/** Who submits, and the problem it happens in. */
export interface ValidateContext {
  /** `line:<id>`: the actor of the Lean checks. */
  actor: string;
  signal: AbortSignal;
  /** The problem's claim and its workbench: a proof of that claim goes there, as a prover's would. */
  problem?: { claimId: string; workbench: Workbench };
}

/**
 * The lines' `validate`. A proof of a problem's claim goes to the problem's workbench, so it can
 * settle the problem like a prover's proof. Any other claim, and any negation, gets a workbench
 * of its own, built on first use from the claim's reference file (`MemoryStore.referenceFor`) and
 * kept for the run. A valid proof makes the claim a candidate; a valid refutation is recorded with
 * `negation: true` and changes no status, since only certification settles a claim.
 */
export class ClaimBenches {
  private readonly o: ClaimBenchesOptions;
  private readonly benches = new Map<string, Workbench | { failed: string }>();

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
      { actor: context.actor, signal: context.signal, ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}) },
    );
    return {
      verdict: result.report.verdict,
      ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
      status: status(),
      reasons: result.report.reasons,
      report: result.report,
    };
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
      });
      this.benches.set(key, bench);
      return bench;
    } catch (error) {
      if (!(error instanceof CheckFailedError) && !signal.aborted) this.benches.set(key, { failed: messageOf(error) });
      throw error;
    }
  }
}
