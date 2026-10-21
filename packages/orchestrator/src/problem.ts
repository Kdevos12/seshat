import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyProblemFile, type ProblemEntry } from "@seshat/bench";
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
} from "@seshat/core";
import { RegistryLeanChecker, type Registry } from "@seshat/registry";

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
  /** The attempt that found it; absent for a proof a line submitted outside a session. */
  attemptId?: string;
  validationId: string;
  report: ValidationReport;
}

/** What a workbench checks against: a Lean file (a problem's, or a claim's reference file) and its sketch. */
export interface WorkbenchFile {
  source: string;
  sketch: Sketch;
}

export interface WorkbenchOptions {
  journal: Journal;
  registry: Registry;
  problem: WorkbenchFile;
  claimId: string;
  reference: Reference;
  /** Default: `SKETCH_POLICY`. */
  policy?: ValidationPolicy;
  certifier?: LeanCertifier;
  /** Keeps every file a prover submits, by its `submissionHash`. */
  blobs?: BlobStore;
  /**
   * The file states the negation of the claim: its valid checks are refutations, recorded with
   * `negation: true`, and leave the claim's status as it is (only certification settles one).
   */
  negation?: boolean;
}

const MARKERS = [AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END].map((m) => m.trim());

/**
 * What the provers of one problem share: the sketch, the reference type, and the checks. A check of
 * a file without holes is a validation and goes into the journal; the first valid one makes the
 * claim a candidate (`computed`) and ends the problem's search. The lines' `validate` checks other
 * claims, and negations, on workbenches of their own.
 */
export class Workbench {
  readonly journal: Journal;
  readonly registry: Registry;
  readonly problem: WorkbenchFile;
  readonly claimId: string;
  readonly reference: Reference;
  readonly policy: ValidationPolicy;
  readonly certifier: LeanCertifier | undefined;
  readonly negation: boolean;
  private readonly blobs: BlobStore | undefined;
  private found: Candidate | undefined;
  private readonly listeners: Array<(candidate: Candidate) => void> = [];
  private readonly started: string[] = [];
  private readonly checked = new Map<string, Submission>();

  constructor(options: WorkbenchOptions) {
    this.journal = options.journal;
    this.registry = options.registry;
    this.problem = options.problem;
    this.claimId = options.claimId;
    this.reference = options.reference;
    this.policy = options.policy ?? SKETCH_POLICY;
    this.certifier = options.certifier;
    this.blobs = options.blobs;
    this.negation = options.negation ?? false;
  }

  get sketch(): Sketch {
    return this.problem.sketch;
  }

  get candidate(): Candidate | undefined {
    return this.found;
  }

  /**
   * The attempts this problem's provers started, in order. With lines, two problems with one
   * statement share a claim, which then holds the attempts of both: these are this problem's own.
   */
  get attemptIds(): readonly string[] {
    return this.started;
  }

  /** Records an attempt that a prover of this problem started. */
  noteAttempt(attemptId: string): void {
    this.started.push(attemptId);
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

  /** The regions of the attempt's last check, whatever its verdict; undefined before its first. */
  lastSubmission(attemptId: string): Submission | undefined {
    return this.checked.get(attemptId);
  }

  async check(submission: Submission, context: { attemptId?: string; actor: string; signal?: AbortSignal }): Promise<CheckResult> {
    if (context.attemptId !== undefined) this.checked.set(context.attemptId, submission);
    const submitted = this.render(submission);
    this.blobs?.put(submitted);
    const markers = markerProblems(submission);
    const attempt = context.attemptId !== undefined ? { attemptId: context.attemptId } : {};
    const checker = new RegistryLeanChecker(this.registry, { ...attempt, actor: context.actor });
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
        ...attempt,
        method: "repl",
        verdict: report.verdict,
        reasons: report.reasons,
        axioms: report.axioms,
        submissionHash: report.submissionHash,
        ...(this.negation ? { negation: true } : {}),
      },
      "validator",
    );
    if (report.verdict !== "valid") return { report, validationId, accepted: false };
    if (!this.negation && this.journal.projection.claim(this.claimId)?.status === "open") {
      this.journal.emit(
        "claim.status_changed",
        {
          claimId: this.claimId,
          from: "open",
          to: "computed",
          reason: "a proof passed the fast check",
          ...attempt,
          validationId,
        },
        "orchestrator",
      );
    }
    if (this.found !== undefined) return { report, validationId, accepted: false };
    this.found = { ...attempt, validationId, report };
    for (const listener of this.listeners.splice(0)) listener(this.found);
    return { report, validationId, accepted: true };
  }

  /**
   * Certifies the candidate, when there is a certifier: a certified proof makes the claim `proved`,
   * a rejected one sends it back to `open`. Returns undefined without a certifier or a candidate,
   * and for a refutation, whose certification is not wired yet. A claim that another problem
   * with the same statement has settled meanwhile keeps its status: the validation is recorded,
   * and only a claim that is still `computed` (or `open`, for a proof) changes.
   */
  async certify(signal?: AbortSignal): Promise<CertificationResult | undefined> {
    const candidate = this.found;
    if (this.certifier === undefined || candidate === undefined || this.negation) return undefined;
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
        ...(candidate.attemptId !== undefined ? { attemptId: candidate.attemptId } : {}),
        method: "kernel_replay",
        verdict: valid ? "valid" : "invalid",
        reasons: result.reasons,
        axioms: result.axioms,
        submissionHash: candidate.report.submissionHash,
      },
      this.certifier.implementation,
    );
    const status = this.journal.projection.claim(this.claimId)?.status;
    if (valid && (status === "computed" || status === "open")) {
      this.journal.emit(
        "claim.status_changed",
        { claimId: this.claimId, from: status, to: "proved", reason: "the candidate was certified", validationId },
        "orchestrator",
      );
    } else if (!valid && status === "computed") {
      this.journal.emit(
        "claim.status_changed",
        {
          claimId: this.claimId, from: "computed", to: "open",
          reason: `certification rejected the candidate: ${result.reasons.join("; ")}`, validationId,
        },
        "orchestrator",
      );
    }
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
