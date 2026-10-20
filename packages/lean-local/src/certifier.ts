import { constants, readFileSync } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CertificationRequest,
  type CertificationResult,
  CertifyFailedError,
  type LeanCertifier,
  type LeanCertifyOptions,
} from "@seshat/core";
import { messageOf } from "@seshat/registry";
import { type ProcessResult, runProcess, SpawnError } from "./process.ts";

/** The Lean program of this repository, which replays the compiled files (`lean/SeshatCertify`). */
export const CERTIFY_PROGRAM = fileURLToPath(new URL("../../../lean/SeshatCertify/Main.lean", import.meta.url));

/**
 * Why `lean.certify` is unavailable when it has neither a sandbox command nor the explicit choice to
 * run without one. The compile runs the candidate's code, so the certifier fails closed.
 */
export const SANDBOX_REQUIRED =
  "lean.certify refuses to run the candidate's code without a sandbox: give it a sandbox command, or set unsandboxed: true to run that code as the harness's user, at your own risk (documentation/certifier.md#where-untrusted-code-runs)";

/** Undefined when the options give a sandbox command or say `unsandboxed`; otherwise `SANDBOX_REQUIRED`. */
export function sandboxRequired(options: { sandbox?: readonly string[] | undefined; unsandboxed?: boolean | undefined }): string | undefined {
  return (options.sandbox?.length ?? 0) > 0 || options.unsandboxed === true ? undefined : SANDBOX_REQUIRED;
}

export const DEFAULT_CERTIFY_TIMEOUT_SEC = 600;
const VERSION_TIMEOUT_MS = 60_000;
/** Compiling the probe loads the project's modules, which takes longer on a cold disk cache. */
const PROBE_TIMEOUT_MS = 300_000;
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
   * sandbox such as `bwrap`, a container runner. `{work}` stands for the directory of the call,
   * the only place it may write (each call has one of its own, made for it and removed after) and
   * `{project}` for the Lean project.
   */
  sandbox?: readonly string[];
  /**
   * Runs the code of the files without a sandbox, as the harness's user, with that user's files.
   * Without a `sandbox` the certifier is not made unless this is true: the choice is the user's.
   */
  unsandboxed?: boolean;
  /**
   * Variables added to the few the child gets (`PATH`; `HOME` unless `ELAN_HOME` is given; a
   * temporary directory of its own), such as `ELAN_HOME`. Nothing else of the harness's
   * environment reaches it.
   */
  env?: Record<string, string>;
  /** The Lean version `lake env lean --version` must report, `4.27.0` or `v4.27.0`. */
  lean?: string;
  /**
   * A Lean file (its text) that the first use and the health check compile before anything else: the
   * import of the bench's prelude, such as `import FormalConjectures.Util.ProblemImports`. It shows
   * a project that is not built, a checkout that is not the bench's, or `.olean` files of another
   * toolchain, which Lean reports as errors in every file. Default: none, only the version is checked.
   */
  probe?: string;
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
  /** The directory of the certification, which holds a directory for each step. */
  root: string;
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
 * Each call runs in a directory of its own, made for it and empty, which is all a sandbox needs to
 * leave writable ({@link LakeCertifierOptions.sandbox}); the replay gets copies of the program (as
 * read when the certifier was made) and of the two object files, so that nothing a compile wrote
 * is read but the object file it was asked for.
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
  /** The program as it was when the certifier was made, before any candidate's code could have run. */
  private readonly programText: string;
  private readonly sandbox: readonly string[];
  private readonly env: Record<string, string>;
  private readonly lean: string | undefined;
  private readonly probe: string | undefined;
  private readonly workDir: string;
  private readonly timeoutSec: number;
  /** The check of the Lean installation: one at a time, shared by the calls that wait for it, kept once it succeeded. */
  private leanCheck: { promise: Promise<string>; controller: AbortController; waiters: number; ok: boolean } | undefined;

  constructor(options: LakeCertifierOptions) {
    const refusal = sandboxRequired(options);
    if (refusal !== undefined) throw new Error(refusal);
    this.implementation = options.implementation ?? "lake-certify";
    this.version = options.version ?? "0";
    this.projectDir = options.projectDir;
    this.command = options.command ?? "lake";
    this.args = options.args ?? [];
    this.program = options.program ?? CERTIFY_PROGRAM;
    try {
      this.programText = readFileSync(this.program, "utf8");
    } catch (error) {
      throw new Error(`cannot read the replay program ${this.program}: ${messageOf(error)}`);
    }
    this.sandbox = options.sandbox ?? [];
    this.env = options.env ?? {};
    this.lean = options.lean?.replace(/^v/, "");
    this.probe = options.probe !== undefined && options.probe.trim() !== "" ? options.probe : undefined;
    this.workDir = options.workDir ?? tmpdir();
    this.timeoutSec = options.timeoutSec ?? DEFAULT_CERTIFY_TIMEOUT_SEC;
  }

  async certify(request: CertificationRequest, options: LeanCertifyOptions = {}): Promise<CertificationResult> {
    const started = performance.now();
    const limitSec = options.timeoutSec ?? this.timeoutSec;
    if (options.signal?.aborted === true) throw new CertifyFailedError("aborted", "the certification was aborted");
    await this.ensureLean(options.signal);
    const root = await mkdtemp(join(this.workDir, "seshat-certify-"));
    const call: Call = {
      root,
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
      // Lean ends with 1 for the errors of a file and for import errors alike, and a project that is
      // not built, or not the bench's, fails every file. A candidate is rejected for its errors only if
      // the reference compiles in the same project.
      const reference = await this.compile("reference", request.original, call);
      if ("errors" in reference) {
        throw new CertifyFailedError(
          "failed",
          "errors" in candidate
            ? `neither the candidate nor the reference compiles, so the Lean environment is probably broken (the reference: ${reference.errors.join("; ")})`
            : `the reference does not compile: ${reference.errors.join("; ")}`,
        );
      }
      if ("errors" in candidate) return done("rejected", candidate.errors.map((e) => `does not compile: ${e}`), []);
      const replay = await this.replay(candidate.olean, reference.olean, request, call);
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
      await rm(root, { recursive: true, force: true });
    }
  }

  /**
   * Whether `lake env lean` runs, reports the pinned version, and compiles the probe: the same check
   * the first certification makes, with what was wrong when it fails.
   */
  async health(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    try {
      return { ok: true, detail: await this.ensureLean(signal) };
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
  }

  /** Compiles a file to an object file, in a directory made for the compile: its path, or the errors Lean reported. */
  private async compile(kind: "candidate" | "reference", text: string, call: Call): Promise<{ olean: string } | { errors: string[] }> {
    const dir = await mkdtemp(join(call.root, `${kind}-`));
    const source = join(dir, `${kind}.lean`);
    const olean = join(dir, `${kind}.olean`);
    await writeFile(source, text, "utf8");
    const result = await this.lake(["env", "lean", "-o", olean, source], dir, call);
    if (result.code === 0) {
      // The compile has ended, and may have written anything in its directory: only a file counts, not a link or a pipe.
      if (!(await isFile(olean))) throw new CertifyFailedError("failed", `lean compiled the ${kind} and wrote no object file (a regular file)`);
      return { olean };
    }
    // Lean ends with 1 when the file has errors; anything else (a signal, an out of memory) is not the file's doing.
    if (result.code === 1) return { errors: errorsOf(`${result.stdout}\n${result.stderr}`, `${dir}/`) };
    throw new CertifyFailedError("failed", `lean ended with ${how(result)} while compiling the ${kind}${tail(result.stderr)}`);
  }

  /**
   * Runs the replay program in a directory made after the compiles have ended, which holds
   * everything it reads: the program, as read when the certifier was made, the two object files, copied,
   * and the request. Nothing in it was written by a process that ran the candidate's code.
   */
  private async replay(candidate: string, reference: string, request: CertificationRequest, call: Call): Promise<ProcessResult> {
    const dir = await mkdtemp(join(call.root, "replay-"));
    const programFile = join(dir, "Main.lean");
    const referenceFile = join(dir, "reference.olean");
    const candidateFile = join(dir, "candidate.olean");
    const requestFile = join(dir, "request.json");
    await writeFile(programFile, this.programText, { encoding: "utf8", flag: "wx" });
    await copyFile(reference, referenceFile, constants.COPYFILE_EXCL);
    await copyFile(candidate, candidateFile, constants.COPYFILE_EXCL);
    await writeFile(
      requestFile,
      JSON.stringify({ reference: referenceFile, candidate: candidateFile, target: request.target, allowedAxioms: request.allowedAxioms }),
      { encoding: "utf8", flag: "wx" },
    );
    return await this.lake(["env", "lean", "--run", programFile, requestFile], dir, call);
  }

  /** One call of `lake` in the directory `work`, within what is left of the time limit. */
  private async lake(args: readonly string[], work: string, call: Call): Promise<ProcessResult> {
    const remainingMs = call.deadline - performance.now();
    if (remainingMs <= 0) throw new CertifyFailedError("timeout", `the certification took longer than its limit of ${call.limitSec} s`);
    const result = await this.spawn(args, work, remainingMs, call.signal);
    if (result.stopped === "timeout") {
      throw new CertifyFailedError("timeout", `the certification took longer than its limit of ${call.limitSec} s`);
    }
    return result;
  }

  /**
   * Starts `lake` (behind the sandbox command, if there is one) in the Lean project, with the
   * directory `work` as `{work}` and as the temporary directory, and the minimal environment.
   */
  private async spawn(args: readonly string[], work: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    const sandbox = this.sandbox.map((part) => part.replaceAll("{work}", work).replaceAll("{project}", this.projectDir));
    const [command, ...rest] = [...sandbox, this.command, ...this.args, ...args];
    let result: ProcessResult;
    try {
      result = await runProcess(command as string, rest, {
        cwd: this.projectDir,
        env: childEnv(this.env, work),
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

  /**
   * Checks once that `lake env lean` runs, that it is the Lean the bench is pinned to, and that the
   * probe compiles; gives what it found. The check is shared by the calls that wait for it. A call
   * whose signal aborts leaves at once, and when none is left the check's process is killed and the
   * next call starts a new one. A failure is not kept: the next call looks again.
   */
  private ensureLean(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) return Promise.reject(new CertifyFailedError("aborted", "the certification was aborted"));
    let check = this.leanCheck;
    if (check === undefined) {
      const controller = new AbortController();
      const made = { controller, waiters: 0, ok: false, promise: this.checkLean(controller.signal) };
      check = made;
      this.leanCheck = made;
      made.promise.then(
        () => {
          made.ok = true;
        },
        () => {
          if (this.leanCheck === made) this.leanCheck = undefined;
        },
      );
    }
    const shared = check;
    if (shared.ok) return shared.promise;
    shared.waiters += 1;
    return new Promise<string>((resolve, reject) => {
      let waiting = true;
      const leave = () => {
        if (!waiting) return;
        waiting = false;
        signal?.removeEventListener("abort", onAbort);
        shared.waiters -= 1;
      };
      const onAbort = () => {
        leave();
        if (shared.waiters === 0 && !shared.ok) {
          shared.controller.abort();
          if (this.leanCheck === shared) this.leanCheck = undefined;
        }
        reject(new CertifyFailedError("aborted", "the certification was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (found) => {
          leave();
          resolve(found);
        },
        (error: unknown) => {
          leave();
          reject(error);
        },
      );
    });
  }

  /** The first line `lean --version` printed, a note on the probe when there is one, and on the sandbox. */
  private async checkLean(signal: AbortSignal): Promise<string> {
    const dir = await mkdtemp(join(this.workDir, "seshat-check-"));
    try {
      const result = await this.spawn(["env", "lean", "--version"], dir, VERSION_TIMEOUT_MS, signal);
      if (result.stopped === "timeout" || result.code !== 0) {
        throw new CertifyFailedError("unavailable", `lake env lean --version ended with ${how(result)}${tail(result.stderr)}`);
      }
      if (this.lean !== undefined && !result.stdout.includes(`version ${this.lean}`)) {
        throw new CertifyFailedError("unavailable", `lean reports ${result.stdout.trim().slice(0, 200)}; the pinned version is ${this.lean}`);
      }
      const found = clip(result.stdout.trim().split("\n")[0] ?? "");
      if (this.probe !== undefined) await this.compileProbe(this.probe, dir, signal);
      return [found, ...(this.probe !== undefined ? ["the probe file compiles"] : []), this.sandboxNote()].join("; ");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private sandboxNote(): string {
    return this.sandbox.length > 0
      ? `sandbox command: ${basename(this.sandbox[0] as string)}`
      : "no sandbox: the candidate's code runs as the harness's user";
  }

  /** Compiles the probe: Lean's errors are the project's, so the certifier is unavailable. */
  private async compileProbe(probe: string, dir: string, signal: AbortSignal): Promise<void> {
    const source = join(dir, "probe.lean");
    await writeFile(source, probe.endsWith("\n") ? probe : `${probe}\n`, "utf8");
    const shown = clip(probe.trim().split("\n").join(" ; "));
    const result = await this.spawn(["env", "lean", "-o", join(dir, "probe.olean"), source], dir, PROBE_TIMEOUT_MS, signal);
    if (result.stopped === "timeout") {
      throw new CertifyFailedError("unavailable", `lean did not compile the probe file (${shown}) in ${PROBE_TIMEOUT_MS / 1000} s`);
    }
    if (result.code === 0) return;
    const why = result.code === 1 ? errorsOf(`${result.stdout}\n${result.stderr}`, `${dir}/`).join("; ") : `ended with ${how(result)}${tail(result.stderr)}`;
    throw new CertifyFailedError("unavailable", `lean cannot compile the probe file (${shown}), so the project is not usable: ${why}`);
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

/** Whether the path is a regular file itself: a link to one, or a pipe, is not. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The environment of every process of a certification: `PATH` (and the system variables Windows
 * needs), `HOME` (or `USERPROFILE`) unless the settings give an `ELAN_HOME`, since elan looks for the
 * toolchains in `$HOME/.elan` then, a temporary directory of the call's own, and the settings'
 * `env`. No credential, socket or other variable of the harness's environment reaches the child.
 */
function childEnv(own: Record<string, string>, work: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const pass = (names: readonly string[]) => {
    for (const name of names) {
      const value = parent[name];
      if (value !== undefined) env[name] = value;
    }
  };
  pass(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]);
  if (own.ELAN_HOME === undefined) pass(["HOME", "USERPROFILE"]);
  for (const name of process.platform === "win32" ? ["TMPDIR", "TEMP", "TMP"] : ["TMPDIR"]) env[name] = work;
  return { ...env, ...own };
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
