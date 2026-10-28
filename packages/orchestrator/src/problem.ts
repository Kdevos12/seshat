import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyProblemFile, type ProblemEntry } from "@seshat/bench";
import {
  AUX_BEGIN,
  AUX_END,
  type BlobStore,
  type CertificationResult,
  type ClaimStatus,
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
import { withEnvironmentImports } from "@seshat/lean-env";
import { RegistryLeanChecker, type Registry } from "@seshat/registry";

/** A bench problem ready to work on: its file in plain-header form, checked against the index, and cut into a sketch. */
export interface LoadedProblem {
  entry: ProblemEntry;
  source: string;
  sketch: Sketch;
}

/**
 * Reads a problem's file, checks it against the index, and cuts it into a sketch. `imports` are the
 * modules the run's Lean environment adds to every file (documentation/lean-env.md): the lines
 * `import <module>` go after the file's own imports, so that the sketch, the reference and every
 * file the provers and the certifier see have them.
 */
export function loadProblem(checkout: string, entry: ProblemEntry, imports: readonly string[] = []): LoadedProblem {
  const plain = toPlainHeader(readFileSync(join(checkout, entry.path), "utf8"));
  verifyProblemFile(checkout, entry, plain);
  const source = withEnvironmentImports(plain, imports);
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
  /** The problem whose workbench's check made it a candidate: the problem that certifies it. */
  problemId?: string;
  validationId: string;
  report: ValidationReport;
}

/** What certifying a candidate came to: the certifier's answer, the validation that records it, and the claim's status after it. */
export interface Certification {
  result: CertificationResult;
  validationId: string;
  status: ClaimStatus;
}

/** The certifier's answer for a candidate, as the journal recorded it (a `kernel_replay` validation). */
export interface RecordedCertification {
  validationId: string;
  /** Where the validation is in the journal: a status change after it is not undone by a resumption. Absent: no such status change is looked for. */
  seq?: number;
  verdict: "valid" | "invalid";
  reasons: string[];
  axioms: string[];
}

/**
 * What to say of a certified proof or refutation whose claim is not left as it says. The claim is
 * `proved` or `refuted` the other way, which is a contradiction (the kernel has certified both a
 * proof and a refutation of one statement), or it was withdrawn. `what` is "the candidate", or
 * "the proof of claim X" or "the refutation of claim X".
 */
export function conflictNote(what: string, status: ClaimStatus): string {
  return `${what} was certified, but its claim is ${status}${status === "proved" || status === "refuted" ? ": a contradiction" : ""}`;
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
  /** The problem the workbench is the claim's reference file of; its checks are recorded as that problem's. */
  problemId?: string;
  reference: Reference;
  /** Default: `SKETCH_POLICY`. */
  policy?: ValidationPolicy;
  certifier?: LeanCertifier;
  /** Keeps every file a prover submits, by its `submissionHash`. */
  blobs?: BlobStore;
  /**
   * The file states the negation of the claim: its valid checks are refutations, recorded with
   * `negation: true`, and leave the claim's status as it is until certification settles it.
   */
  negation?: boolean;
}

/** A claim in one of these can be settled by a certified proof or refutation. */
const SETTLEABLE: readonly ClaimStatus[] = ["open", "computed", "proved_informal"];

const MARKERS = [AUX_BEGIN, AUX_END, PROOF_BEGIN, PROOF_END].map((m) => m.trim());

/**
 * What the provers of one problem share: the sketch, the reference type, and the checks. A check of
 * a file without holes is a validation and goes into the journal; the first valid one makes the
 * claim a candidate (`computed`) and ends the problem's search. The candidate is then certified, if
 * there is a certifier (`certify`). The lines' `validate` checks other claims, and negations, on
 * workbenches of their own.
 */
export class Workbench {
  readonly journal: Journal;
  readonly registry: Registry;
  readonly problem: WorkbenchFile;
  readonly claimId: string;
  readonly problemId: string | undefined;
  readonly reference: Reference;
  readonly policy: ValidationPolicy;
  readonly certifier: LeanCertifier | undefined;
  readonly negation: boolean;
  private readonly blobs: BlobStore | undefined;
  private found: Candidate | undefined;
  /** The certification of `found`, from the call that started it. */
  private certification: { candidate: Candidate; done: Promise<Certification | undefined> } | undefined;
  private readonly listeners: Array<(candidate: Candidate) => void> = [];
  private readonly started: string[] = [];
  private readonly checked = new Map<string, Submission>();

  constructor(options: WorkbenchOptions) {
    this.journal = options.journal;
    this.registry = options.registry;
    this.problem = options.problem;
    this.claimId = options.claimId;
    this.problemId = options.problemId;
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

  async check(
    submission: Submission,
    context: { attemptId?: string; actor: string; signal?: AbortSignal; problemId?: string },
  ): Promise<CheckResult> {
    if (context.attemptId !== undefined) this.checked.set(context.attemptId, submission);
    const submitted = this.render(submission);
    this.blobs?.put(submitted);
    const markers = markerProblems(submission);
    const attempt = context.attemptId !== undefined ? { attemptId: context.attemptId } : {};
    const problemId = context.problemId ?? this.problemId;
    const owner = problemId !== undefined ? { problemId } : {};
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
        ...owner,
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
    this.found = { ...attempt, ...owner, validationId, report };
    for (const listener of this.listeners.splice(0)) listener(this.found);
    return { report, validationId, accepted: true };
  }

  /** Whether there is a candidate that no call of `certify` has looked at (never, without a certifier). */
  get awaitsCertification(): boolean {
    return this.certifier !== undefined && this.found !== undefined && this.certification?.candidate !== this.found;
  }

  /**
   * Certifies the candidate, if there is a certifier and a candidate; otherwise undefined. A candidate
   * is certified once: a later call gets the first call's answer, or its failure.
   *
   * The answer is a `kernel_replay` validation of the claim (with `negation: true` for a
   * refutation). A certified proof makes the claim `proved`, and a certified refutation `refuted`,
   * if the claim is still open, `computed` or informally proved: a claim that another problem
   * with the same statement has settled keeps its status. A rejected candidate changes no status;
   * the validation holds the reasons. A certifier that gives no answer (a timeout, an abort, a
   * certifier that is not there) throws: that says nothing about the candidate, so nothing is
   * recorded and the claim stays a candidate.
   */
  async certify(signal?: AbortSignal): Promise<Certification | undefined> {
    const candidate = this.found;
    if (this.certifier === undefined || candidate === undefined) return undefined;
    if (this.certification?.candidate !== candidate) {
      this.certification = { candidate, done: this.certifyCandidate(this.certifier, candidate, signal) };
    }
    return await this.certification.done;
  }

  private async certifyCandidate(certifier: LeanCertifier, candidate: Candidate, signal?: AbortSignal): Promise<Certification | undefined> {
    const validator = new ProofValidator(new RegistryLeanChecker(this.registry), { policy: this.policy, certifier });
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
        ...(this.negation ? { negation: true } : {}),
        ...(candidate.problemId !== undefined ? { problemId: candidate.problemId } : {}),
      },
      certifier.implementation,
    );
    return { result, validationId, status: this.settle(valid, validationId) };
  }

  /**
   * After a certification's answer is in the journal: a certified proof makes the claim `proved`, a
   * certified refutation `refuted`, if the claim can still be settled; a rejection changes nothing.
   * Returns the claim's status.
   */
  private settle(valid: boolean, validationId: string): ClaimStatus {
    const from = this.claimStatus();
    if (!valid || !SETTLEABLE.includes(from)) return from;
    const to = this.negation ? "refuted" : "proved";
    this.journal.emit(
      "claim.status_changed",
      {
        claimId: this.claimId,
        from,
        to,
        reason: this.negation ? "a refutation of the claim was certified" : "the candidate was certified",
        validationId,
      },
      "orchestrator",
    );
    return to;
  }

  /**
   * Gives a workbench what a run that was interrupted knew: the candidate that its checks had found
   * and, if the journal holds the certifier's answer for it, that answer, so that the candidate is
   * not certified a second time (`certify` returns the recorded answer). The process may have ended
   * between a validation and the claim's new status, the candidate's (`computed`) or the answer's
   * (`proved`, `refuted`); the status is written now, as `check` or `certify` would have written it.
   * A candidate without an answer is certified by the next call of `certify`, which is also what
   * happens to one whose certification the interruption cut, since a cut call recorded nothing.
   */
  adopt(candidate: Candidate, answer?: RecordedCertification): void {
    if (this.found !== undefined) throw new Error(`the workbench of claim ${this.claimId} already has a candidate`);
    this.found = candidate;
    // The process may also have ended between the check's validation and the claim's change of
    // status: the validation says the proof passed, so the change is made now, as `check` would have.
    // Not when the claim's status has changed since the validation: a claim that went back to `open`
    // (a line withdrew a composed proof) stays open, and a resumption does not raise it again.
    if (!this.negation && this.claimStatus() === "open" && !this.changedSince(this.journal.projection.validation(candidate.validationId)?.seq ?? -1)) {
      this.journal.emit(
        "claim.status_changed",
        {
          claimId: this.claimId,
          from: "open",
          to: "computed",
          reason: "a proof passed the fast check; the interruption cut the change of status",
          ...(candidate.attemptId !== undefined ? { attemptId: candidate.attemptId } : {}),
          validationId: candidate.validationId,
        },
        "orchestrator",
      );
    }
    if (answer !== undefined) {
      const valid = answer.verdict === "valid";
      const result: CertificationResult = { verdict: valid ? "certified" : "rejected", reasons: answer.reasons, axioms: answer.axioms, timeMs: 0 };
      const status = answer.seq !== undefined && this.changedSince(answer.seq) ? this.claimStatus() : this.settle(valid, answer.validationId);
      this.certification = { candidate, done: Promise.resolve({ result, validationId: answer.validationId, status }) };
    }
    for (const listener of this.listeners.splice(0)) listener(candidate);
  }

  /** Whether the claim's status changed after the journal's event number `seq`. */
  private changedSince(seq: number): boolean {
    return (this.journal.projection.claim(this.claimId)?.updated_seq ?? 0) > seq;
  }

  private claimStatus(): ClaimStatus {
    const claim = this.journal.projection.claim(this.claimId);
    if (claim === undefined) throw new Error(`unknown claim ${this.claimId}`);
    return claim.status;
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
