import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CertificationRequest,
  type CertificationResult,
  CertifyFailedError,
  type LeanCertifier,
  type LeanCertifyOptions,
} from "@seshat/core";
import { serverEnv } from "@seshat/registry";
import { type ProcessResult, runProcess, SpawnError } from "./process.ts";

/** The Lean program of this repository, which replays the compiled files (`lean/SeshatCertify`). */
export const CERTIFY_PROGRAM = fileURLToPath(new URL("../../../lean/SeshatCertify/Main.lean", import.meta.url));

export const DEFAULT_CERTIFY_TIMEOUT_SEC = 600;
const VERSION_TIMEOUT_MS = 60_000;
const MAX_REASONS = 8;
const MAX_REASON_CHARS = 600;

export interface LakeCertifierOptions {
  /** The pinned Lean project, where `lake env` finds the modules the files import (the bench's checkout). */
  projectDir: string;
  /** `lake`, or the program that stands for it. Default `lake`. */
  command?: string;
  /** Arguments before `env lean ...`, for a launcher. */
  args?: readonly string[];
  /** The Lean program that replays the compiled files. Default: `lean/SeshatCertify/Main.lean` of this repository. */
  program?: string;
  /**
   * A command put before every call of `lake`, which runs the code of the files it compiles: a
   * sandbox such as `bwrap`, a container runner. `{work}` stands for the directory the call may
   * write to and `{project}` for the Lean project. Default: none, and the code runs as the
   * harness's user.
   */
  sandbox?: readonly string[];
  /** Variables added to the few the child inherits (`PATH`, `HOME`...), such as `ELAN_HOME`. */
  env?: Record<string, string>;
  /** The Lean version `lake env lean --version` must report, `4.27.0` or `v4.27.0`. */
  lean?: string;
  /** Where each certification makes its work directory. Default: the system's temporary directory. */
  workDir?: string;
  /** The time limit of a certification that gives none, in seconds. Default 600. */
  timeoutSec?: number;
  /** Default `lake-certify`. */
  implementation?: string;
  version?: string;
}

/** What one certification shares between its steps. */
interface Call {
  work: string;
  /** `performance.now()` when the time limit ends. */
  deadline: number;
  limitSec: number;
  signal?: AbortSignal;
}

interface Verdict {
  verdict: "certified" | "rejected";
  reasons: string[];
  axioms: string[];
}

/**
 * The certifier of the harness (documentation/certifier.md): the candidate and the reference are
 * compiled to object files in fresh processes of the pinned Lean project, then a third process
 * runs `lean/SeshatCertify` on the two files, which replays the candidate's declarations through
 * the kernel, compares the target with the reference's as terms and collects its axioms.
 *
 * `rejected` is the candidate's: it does not compile, or the program refuses it. Everything else
 * that stops a verdict (the time limit, an abort, a Lean that is missing or of another version, a
 * program that crashes or answers something else, a reference that does not compile) is a
 * `CertifyFailedError` and says nothing about the candidate.
 */
export class LakeCertifier implements LeanCertifier {
  readonly implementation: string;
  readonly version: string;
  private readonly projectDir: string;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly program: string;
  private readonly sandbox: readonly string[];
  private readonly env: Record<string, string>;
  private readonly lean: string | undefined;
  private readonly workDir: string;
  private readonly timeoutSec: number;
  private leanChecked: Promise<void> | undefined;

  constructor(options: LakeCertifierOptions) {
    this.implementation = options.implementation ?? "lake-certify";
    this.version = options.version ?? "0";
    this.projectDir = options.projectDir;
    this.command = options.command ?? "lake";
    this.args = options.args ?? [];
    this.program = options.program ?? CERTIFY_PROGRAM;
    this.sandbox = options.sandbox ?? [];
    this.env = options.env ?? {};
    this.lean = options.lean?.replace(/^v/, "");
    this.workDir = options.workDir ?? tmpdir();
    this.timeoutSec = options.timeoutSec ?? DEFAULT_CERTIFY_TIMEOUT_SEC;
  }

  async certify(request: CertificationRequest, options: LeanCertifyOptions = {}): Promise<CertificationResult> {
    const started = performance.now();
    const limitSec = options.timeoutSec ?? this.timeoutSec;
    if (options.signal?.aborted === true) throw new CertifyFailedError("aborted", "the certification was aborted");
    await this.ensureLean();
    const work = await mkdtemp(join(this.workDir, "seshat-certify-"));
    const call: Call = {
      work,
      deadline: started + limitSec * 1000,
      limitSec,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const done = (verdict: Verdict["verdict"], reasons: string[], axioms: string[]): CertificationResult => ({
      verdict,
      reasons: reasons.slice(0, MAX_REASONS).map(clip),
      axioms: [...axioms].sort(),
      timeMs: Math.round(performance.now() - started),
    });
    try {
      // The candidate first: its code has run, and has stopped, before the reference is made.
      const candidate = await this.compile("candidate", request.candidate, call);
      if ("errors" in candidate) return done("rejected", candidate.errors.map((e) => `does not compile: ${e}`), []);
      const reference = await this.compile("reference", request.original, call);
      if ("errors" in reference) {
        throw new CertifyFailedError("failed", `the reference does not compile: ${reference.errors.join("; ")}`);
      }
      const requestFile = join(work, "request.json");
      await writeFile(
        requestFile,
        JSON.stringify({ reference: reference.olean, candidate: candidate.olean, target: request.target, allowedAxioms: request.allowedAxioms }),
        "utf8",
      );
      const replay = await this.lake(["env", "lean", "--run", this.program, requestFile], call);
      if (replay.code !== 0) {
        throw new CertifyFailedError("failed", `the replay program ended with ${how(replay)}${tail(replay.stderr)}`);
      }
      const verdict = parseVerdict(replay.stdout);
      // The policy is checked here as well, so that it does not rest on the program alone.
      const allowed = new Set(request.allowedAxioms);
      const outside = verdict.axioms.filter((a) => !allowed.has(a));
      if (verdict.verdict === "certified") {
        if (verdict.reasons.length > 0) throw new CertifyFailedError("failed", "the replay program certified with reasons against");
        if (outside.length > 0) {
          return done("rejected", [`${request.target} depends on axioms that are not allowed: ${outside.join(", ")}`], verdict.axioms);
        }
      } else if (verdict.reasons.length === 0) {
        throw new CertifyFailedError("failed", "the replay program rejected without a reason");
      }
      return done(verdict.verdict, verdict.reasons, verdict.axioms);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Whether `lake env lean` runs and reports the pinned version. */
  async health(): Promise<boolean> {
    try {
      await this.ensureLean();
      return true;
    } catch {
      return false;
    }
  }

  /** Compiles a file to an object file: its path, or the errors Lean reported. */
  private async compile(kind: "candidate" | "reference", text: string, call: Call): Promise<{ olean: string } | { errors: string[] }> {
    const dir = join(call.work, kind);
    await mkdir(dir);
    const source = join(dir, `${kind}.lean`);
    const olean = join(dir, `${kind}.olean`);
    await writeFile(source, text, "utf8");
    const result = await this.lake(["env", "lean", "-o", olean, source], call);
    if (result.code === 0) {
      if (!(await exists(olean))) throw new CertifyFailedError("failed", `lean compiled the ${kind} and wrote no object file`);
      return { olean };
    }
    // Lean ends with 1 when the file has errors; anything else (a signal, an out of memory) is not the file's doing.
    if (result.code === 1) return { errors: errorsOf(`${result.stdout}\n${result.stderr}`, `${dir}/`) };
    throw new CertifyFailedError("failed", `lean ended with ${how(result)} while compiling the ${kind}${tail(result.stderr)}`);
  }

  /** One call of `lake`, within what is left of the time limit. */
  private async lake(args: readonly string[], call: Call): Promise<ProcessResult> {
    const remainingMs = call.deadline - performance.now();
    if (remainingMs <= 0) throw new CertifyFailedError("timeout", `the certification took longer than its limit of ${call.limitSec} s`);
    const result = await this.spawn(args, call.work, remainingMs, call.signal);
    if (result.stopped === "timeout") {
      throw new CertifyFailedError("timeout", `the certification took longer than its limit of ${call.limitSec} s`);
    }
    return result;
  }

  private async spawn(args: readonly string[], work: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    const sandbox = this.sandbox.map((part) => part.replaceAll("{work}", work).replaceAll("{project}", this.projectDir));
    const [command, ...rest] = [...sandbox, this.command, ...this.args, ...args];
    let result: ProcessResult;
    try {
      result = await runProcess(command as string, rest, {
        cwd: this.projectDir,
        env: serverEnv(this.env),
        timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof SpawnError) throw new CertifyFailedError("unavailable", `cannot start ${command}: ${error.message}`);
      throw error;
    }
    if (result.stopped === "aborted") throw new CertifyFailedError("aborted", "the certification was aborted");
    return result;
  }

  /** Checks once that `lake env lean` runs, and that it is the Lean the bench is pinned to. */
  private ensureLean(): Promise<void> {
    if (this.leanChecked === undefined) {
      const check = this.checkLean();
      this.leanChecked = check;
      // A failure is not kept: the next call looks again.
      check.catch(() => {
        if (this.leanChecked === check) this.leanChecked = undefined;
      });
    }
    return this.leanChecked;
  }

  private async checkLean(): Promise<void> {
    const result = await this.spawn(["env", "lean", "--version"], this.workDir, VERSION_TIMEOUT_MS);
    if (result.stopped === "timeout" || result.code !== 0) {
      throw new CertifyFailedError("unavailable", `lake env lean --version ended with ${how(result)}${tail(result.stderr)}`);
    }
    if (this.lean !== undefined && !result.stdout.includes(`version ${this.lean}`)) {
      throw new CertifyFailedError("unavailable", `lean reports ${result.stdout.trim().slice(0, 200)}; the pinned version is ${this.lean}`);
    }
  }
}

function how(result: ProcessResult): string {
  return result.signal !== null ? `the signal ${result.signal}` : `code ${result.code}`;
}

function tail(stderr: string): string {
  const text = stderr.trim();
  return text === "" ? "" : `: ${clip(text.slice(-400))}`;
}

function clip(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}...` : text;
}

/** The error messages of a compile, their first lines, with the work directory taken out of the file names. */
function errorsOf(output: string, prefix: string): string[] {
  const lines = output.replaceAll(prefix, "").split("\n").filter((l) => l.trim() !== "");
  const errors = lines.filter((l) => /^\S.*?:\d+:\d+: error/.test(l));
  const shown = (errors.length > 0 ? errors : lines).slice(0, 5).map(clip);
  return errors.length > 5 ? [...shown, `and ${errors.length - 5} more errors`] : shown;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function parseVerdict(stdout: string): Verdict {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (line === undefined) throw new CertifyFailedError("failed", "the replay program printed no verdict");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CertifyFailedError("failed", `the replay program printed ${clip(line)}, which is not JSON`);
  }
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const verdict = record?.verdict;
  const reasons = record?.reasons;
  const axioms = record?.axioms;
  if ((verdict !== "certified" && verdict !== "rejected") || !isStrings(reasons) || !isStrings(axioms)) {
    throw new CertifyFailedError("failed", `the replay program printed ${clip(line)}, which is not a verdict`);
  }
  return { verdict, reasons, axioms };
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
