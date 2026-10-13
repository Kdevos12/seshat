import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyProblemFile, type ProblemEntry } from "@math-harness/bench";
import {
  AUX_BEGIN,
  AUX_END,
  type BlobStore,
  type CertificationResult,
  type Journal,
  type LeanCertifier,
  newId,
  PROOF_BEGIN,
  PROOF_END,
  ProofValidator,
  prepareSketch,
  type Reference,
  renderSketch,
  sha256Hex,
  SKETCH_POLICY,
  type Sketch,
  type Submission,
  toPlainHeader,
  type ValidationPolicy,
  type ValidationReport,
} from "@math-harness/core";
import { RegistryLeanChecker, type Registry } from "@math-harness/registry";

/** A bench problem ready to work on: its file in plain-header form, checked against the index, and cut into a sketch. */
export interface LoadedProblem {
  entry: ProblemEntry;
  source: string;
  sketch: Sketch;
}

export function loadProblem(checkout: string, entry: ProblemEntry): LoadedProblem {
  const source = toPlainHeader(readFileSync(join(checkout, entry.path), "utf8"));
  verifyProblemFile(checkout, entry, source);
  return { entry, source, sketch: prepareSketch(source, entry.fullName) };
}

/** A check made for a prover. */
export interface CheckResult {
  report: ValidationReport;
  /** Set when the check was a validation recorded in the journal (a submission without holes). */
  validationId?: string;
  /** True when this check made the claim a candidate. */
  accepted: boolean;
}

export interface Candidate {
  attemptId: string;
  validationId: string;
  report: ValidationReport;
}

export interface WorkbenchOptions {
  journal: Journal;
  registry: Registry;
  problem: LoadedProblem;
  claimId: string;
  reference: Reference;
  /** Default: `SKETCH_POLICY`. */
  policy?: ValidationPolicy;
  certifier?: LeanCertifier;
  /** Keeps every file a prover submits, by its `submissionHash`. */
  blobs?: BlobStore;
}

const MARKERS = [AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END].map((m) => m.trim());

/**
 * What the provers of one problem share: the sketch, the reference type, and the checks. A check of
 * a file without holes is a validation and goes into the journal; the first valid one makes the
 * claim a candidate (`computed`) and ends the problem's search.
 */
export class Workbench {
  readonly journal: Journal;
  readonly registry: Registry;
  readonly problem: LoadedProblem;
  readonly claimId: string;
  readonly reference: Reference;
  readonly policy: ValidationPolicy;
  readonly certifier: LeanCertifier | undefined;
  private readonly blobs: BlobStore | undefined;
  private found: Candidate | undefined;
  private readonly listeners: Array<(candidate: Candidate) => void> = [];

  constructor(options: WorkbenchOptions) {
    this.journal = options.journal;
    this.registry = options.registry;
    this.problem = options.problem;
    this.claimId = options.claimId;
    this.reference = options.reference;
    this.policy = options.policy ?? SKETCH_POLICY;
    this.certifier = options.certifier;
    this.blobs = options.blobs;
  }

  get sketch(): Sketch {
    return this.problem.sketch;
  }

  get candidate(): Candidate | undefined {
    return this.found;
  }

  /** Called once, with the first candidate. */
  onCandidate(listener: (candidate: Candidate) => void): void {
    if (this.found !== undefined) listener(this.found);
    else this.listeners.push(listener);
  }

  /** The prover's file with these regions. */
  render(submission: Submission): string {
    return renderSketch(this.sketch, submission.aux, submission.proof);
  }

  async check(submission: Submission, context: { attemptId: string; actor: string; signal?: AbortSignal }): Promise<CheckResult> {
    const submitted = this.render(submission);
    this.blobs?.put(submitted);
    const markers = markerProblems(submission);
    const checker = new RegistryLeanChecker(this.registry, { attemptId: context.attemptId, actor: context.actor });
    const report =
      markers.length > 0
        ? refused(submitted, markers)
        : await new ProofValidator(checker, { policy: this.policy }).validate(
            this.sketch,
            submitted,
            this.reference,
            context.signal ? { signal: context.signal } : {},
          );
    // A check that Lean could not answer, or that was stopped, says nothing about the proof.
    const conclusive = report.leanStatus !== "server_error" && !(context.signal?.aborted ?? false);
    if (report.holes || !conclusive) return { report, accepted: false };

    const validationId = newId("val");
    this.journal.emit(
      "validation.finished",
      {
        validationId,
        claimId: this.claimId,
        attemptId: context.attemptId,
        method: "repl",
        verdict: report.verdict,
        reasons: report.reasons,
        axioms: report.axioms,
        submissionHash: report.submissionHash,
      },
      "validator",
    );
    if (report.verdict !== "valid") return { report, validationId, accepted: false };
    if (this.journal.projection.claim(this.claimId)?.status === "open") {
      this.journal.emit(
        "claim.status_changed",
        {
          claimId: this.claimId,
          from: "open",
          to: "computed",
          reason: "a proof passed the fast check",
          attemptId: context.attemptId,
          validationId,
        },
        "orchestrator",
      );
    }
    if (this.found !== undefined) return { report, validationId, accepted: false };
    this.found = { attemptId: context.attemptId, validationId, report };
    for (const listener of this.listeners.splice(0)) listener(this.found);
    return { report, validationId, accepted: true };
  }

  /**
   * Certifies the candidate, when there is a certifier: a certified proof makes the claim `proved`,
   * a rejected one sends it back to `open`. Returns undefined without a certifier or a candidate.
   */
  async certify(signal?: AbortSignal): Promise<CertificationResult | undefined> {
    const candidate = this.found;
    if (this.certifier === undefined || candidate === undefined) return undefined;
    const validator = new ProofValidator(new RegistryLeanChecker(this.registry), { policy: this.policy, certifier: this.certifier });
    const result = await validator.certify(this.sketch, this.problem.source, candidate.report, signal ? { signal } : {});
    if (result === undefined) return undefined;
    const validationId = newId("val");
    const valid = result.verdict === "certified";
    this.journal.emit(
      "validation.finished",
      {
        validationId,
        claimId: this.claimId,
        attemptId: candidate.attemptId,
        method: "kernel_replay",
        verdict: valid ? "valid" : "invalid",
        reasons: result.reasons,
        axioms: result.axioms,
        submissionHash: candidate.report.submissionHash,
      },
      this.certifier.implementation,
    );
    this.journal.emit(
      "claim.status_changed",
      valid
        ? { claimId: this.claimId, from: "computed", to: "proved", reason: "the candidate was certified", validationId }
        : { claimId: this.claimId, from: "computed", to: "open", reason: `certification rejected the candidate: ${result.reasons.join("; ")}`, validationId },
      "orchestrator",
    );
    return result;
  }
}

function markerProblems(submission: Submission): string[] {
  const problems: string[] = [];
  for (const [region, text] of Object.entries(submission)) {
    for (const line of text.split("\n")) {
      if (MARKERS.includes(line.trim())) problems.push(`${region}: remove the line '${line.trim()}': pass the regions without their marker lines`);
    }
  }
  return problems;
}

function refused(submitted: string, reasons: string[]): ValidationReport {
  return {
    verdict: "invalid",
    method: "repl",
    reasons,
    axioms: [],
    messages: [],
    sorries: [],
    checked: submitted,
    submissionHash: sha256Hex(submitted),
    editsOutsideRegions: false,
    holes: false,
  };
}
