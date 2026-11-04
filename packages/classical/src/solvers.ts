import type { Json } from "@seshat/core";
import { type FactoryContext, type ImplementationFactory, type ImplementationInstance, type InvokeContext, UnavailableError } from "@seshat/registry";
import { NotInstalled, runProcess } from "./process.ts";
import { Refused, runIsolated, screenSmtLib, screenTptp } from "./sandbox.ts";

// --- z3 ----------------------------------------------------------------------------------------

export type SmtStatus = "sat" | "unsat" | "unknown" | "timeout" | "error";

export interface SmtInput {
  smtlib: string;
  timeoutSec?: number;
  model?: boolean;
}

export interface SmtOutput {
  status: SmtStatus;
  /** For `unsat`: the names of the assertions in the unsat core. */
  core?: string[];
  /** For `sat` with `model: true`: z3's model, as it printed it. */
  model?: string;
  exitCode: number | null;
  elapsedMs: number;
  /** For `error`: what went wrong, from the program's error line or standard error. */
  detail?: string;
}

/**
 * Reads z3's answer: the first line of standard output must be exactly `sat`, `unsat`, `unknown` or
 * `timeout`; an unsat core follows as `(name name ...)`. The prose of the output is never read for a
 * verdict: anything else is an `error`.
 */
export function readZ3(stdout: string, exitCode: number | null, stderr: string): { status: SmtStatus; core?: string[]; model?: string; detail?: string } {
  const lines = stdout.split("\n").map((l) => l.trimEnd());
  const first = (lines.find((l) => l.trim() !== "") ?? "").trim();
  if (first === "sat" || first === "unsat" || first === "unknown" || first === "timeout") {
    const rest = lines.slice(lines.findIndex((l) => l.trim() === first) + 1);
    if (first === "unsat") {
      const core = /^\(([^()]*)\)$/u.exec((rest.find((l) => l.trim() !== "") ?? "").trim());
      return { status: "unsat", ...(core !== null ? { core: (core[1] as string).split(/\s+/u).filter((n) => n !== "") } : {}) };
    }
    if (first === "sat") {
      const model = rest.join("\n").trim();
      return { status: "sat", ...(model !== "" && !model.startsWith("(error") ? { model } : {}) };
    }
    return { status: first };
  }
  const error = lines.find((l) => l.startsWith("(error")) ?? stderr.split("\n").find((l) => l.trim() !== "") ?? `exit code ${exitCode}`;
  return { status: "error", detail: error.slice(0, 500) };
}

function setting(context: FactoryContext, key: string, fallback: string): string {
  const v = context.settings[key];
  return typeof v === "string" && v !== "" ? v : fallback;
}

/** z3 as a process: `z3 -in -smt2` with the script on standard input. */
export function z3Factory(): ImplementationFactory {
  return (context): ImplementationInstance => {
    const command = setting(context, "command", "z3");
    const memoryMb = typeof context.settings.memoryMb === "number" ? context.settings.memoryMb : 2048;
    const args = Array.isArray(context.settings.args) ? (context.settings.args as string[]) : ["-in", "-smt2"];
    return {
      async invoke(input: Json, invoke: InvokeContext): Promise<Json> {
        const { smtlib, timeoutSec = 30, model = false } = input as unknown as SmtInput;
        try {
          screenSmtLib(smtlib);
        } catch (error) {
          if (error instanceof Refused) return { status: "error", detail: `refused: ${error.message}`, exitCode: null, elapsedMs: 0 } as unknown as Json;
          throw error;
        }
        const script = model ? `${smtlib.trimEnd()}\n(get-model)\n` : smtlib;
        let result;
        try {
          result = await runIsolated({ command, args: [...args, `-T:${Math.ceil(timeoutSec)}`, `-memory:${memoryMb}`], stdin: script, timeoutMs: (timeoutSec + 5) * 1000, signal: invoke.signal, memoryMb: memoryMb * 2 });
        } catch (error) {
          if (error instanceof NotInstalled) throw new UnavailableError(error.message);
          throw error;
        }
        if (result.aborted) throw new Error("aborted");
        const read = result.timedOut ? ({ status: "timeout" } as const) : readZ3(result.stdout, result.exitCode, result.stderr);
        const out: SmtOutput = { ...read, exitCode: result.exitCode, elapsedMs: result.elapsedMs };
        return out as unknown as Json;
      },
      async health(h): Promise<{ ok: boolean; detail?: string }> {
        try {
          const r = await runProcess({ command, args: ["--version"], timeoutMs: 10000, signal: h.signal });
          return r.exitCode === 0 ? { ok: true, detail: r.stdout.trim().split("\n")[0] ?? "z3" } : { ok: false, detail: `exit code ${r.exitCode}` };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  };
}

// --- Vampire -----------------------------------------------------------------------------------

export type AtpResult = "theorem" | "countermodel" | "unknown" | "timeout" | "error";

export interface AtpInput {
  tptp: string;
  timeoutSec?: number;
}

export interface AtpOutput {
  /** The SZS status Vampire reported (`Theorem`, `CounterSatisfiable`, `Timeout`...), or `none`. */
  szs: string;
  result: AtpResult;
  /** The names of the axioms the proof uses, read from the proof's `file(...)` annotations. */
  used: string[];
  exitCode: number | null;
  elapsedMs: number;
  /** The proof as printed, cut at 20,000 characters. */
  proof?: string;
  detail?: string;
  /** E's version line, when the program answered `--version` (E only). */
  version?: string;
}

const THEOREM = new Set(["Theorem", "Unsatisfiable", "ContradictoryAxioms"]);
const COUNTER = new Set(["CounterSatisfiable", "Satisfiable"]);

/**
 * Reads a TPTP prover's answer from the SZS status line (`% SZS status Theorem for NAME`) and the exit
 * code, never from the prose. A status that a nonzero exit code contradicts is an `error`, since a
 * proof claim from a run that failed is not to be trusted. The axioms used are the names in the
 * `file('path', name)` annotations of the proof.
 */
export function readSzs(stdout: string, exitCode: number | null, stderr: string): Omit<AtpOutput, "elapsedMs" | "exitCode"> {
  const status = /^[%#]\s*SZS status\s+(\w+)/mu.exec(stdout)?.[1];
  const proofBlock = /^[%#]\s*SZS output start \w+[^\n]*\n([\s\S]*?)^[%#]\s*SZS output end/mu.exec(stdout)?.[1];
  const used = proofBlock === undefined ? [] : [...new Set([...proofBlock.matchAll(/file\('[^']*',\s*([A-Za-z0-9_]+)\)/gu)].map((m) => m[1] as string))];
  const proof = proofBlock === undefined ? {} : { proof: proofBlock.slice(0, 20000) };
  if (status === undefined) return { szs: "none", result: "error", used: [], detail: (stderr.split("\n").find((l) => l.trim() !== "") ?? `no SZS status, exit code ${exitCode}`).slice(0, 500) };
  if (THEOREM.has(status)) {
    if (exitCode !== 0) return { szs: status, result: "error", used, detail: `the status is ${status} but the exit code is ${exitCode}` };
    return { szs: status, result: "theorem", used, ...proof };
  }
  if (COUNTER.has(status)) return { szs: status, result: "countermodel", used: [] };
  if (status === "Timeout" || status === "ResourceOut") return { szs: status, result: "timeout", used: [] };
  return { szs: status, result: status === "GaveUp" || status === "Unknown" || status === "Incomplete" ? "unknown" : "error", used: [] };
}

/** Vampire prints its status after `%`, E after `#`; both are read the same way. */
export const readVampire = readSzs;
export const readEprover = readSzs;

/** Vampire as a process: `vampire --input_syntax tptp --proof tptp -t N` with the problem on standard input. */
export function vampireFactory(): ImplementationFactory {
  return (context): ImplementationInstance => {
    const command = setting(context, "command", "vampire");
    const memoryMb = typeof context.settings.memoryMb === "number" ? context.settings.memoryMb : 2048;
    const args = Array.isArray(context.settings.args) ? (context.settings.args as string[]) : ["--input_syntax", "tptp", "--proof", "tptp"];
    return {
      async invoke(input: Json, invoke: InvokeContext): Promise<Json> {
        const { tptp, timeoutSec = 30 } = input as unknown as AtpInput;
        try {
          screenTptp(tptp);
        } catch (error) {
          if (error instanceof Refused) return { szs: "none", result: "error", used: [], detail: `refused: ${error.message}`, exitCode: null, elapsedMs: 0 } as unknown as Json;
          throw error;
        }
        let result;
        try {
          result = await runIsolated({ command, args: [...args, "-t", String(Math.ceil(timeoutSec)), "-m", String(memoryMb)], stdin: tptp, timeoutMs: (timeoutSec + 5) * 1000, signal: invoke.signal, memoryMb: memoryMb * 2 });
        } catch (error) {
          if (error instanceof NotInstalled) throw new UnavailableError(error.message);
          throw error;
        }
        if (result.aborted) throw new Error("aborted");
        const read = result.timedOut ? ({ szs: "Timeout", result: "timeout", used: [] as string[] } as const) : readSzs(result.stdout, result.exitCode, result.stderr);
        const out: AtpOutput = { ...read, exitCode: result.exitCode, elapsedMs: result.elapsedMs };
        return out as unknown as Json;
      },
      async health(h): Promise<{ ok: boolean; detail?: string }> {
        try {
          const r = await runProcess({ command, args: ["--version"], timeoutMs: 10000, signal: h.signal });
          return r.exitCode === 0 ? { ok: true, detail: r.stdout.trim().split("\n")[0] ?? "vampire" } : { ok: false, detail: `exit code ${r.exitCode}` };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  };
}

// --- E -----------------------------------------------------------------------------------------

/**
 * E as a process: `eprover --auto --proof-object --tstp-format --cpu-limit=N --memory-limit=M` with
 * the problem on standard input. The binary is the host's own installation (never bundled; E is
 * GPL-2.0 and only invoked). The answer is read like Vampire's (`readSzs`); the version line of
 * `eprover --version` is read once and recorded in each tool run.
 */
export function eproverFactory(): ImplementationFactory {
  return (context): ImplementationInstance => {
    const command = setting(context, "command", "eprover");
    const memoryMb = typeof context.settings.memoryMb === "number" ? context.settings.memoryMb : 2048;
    const args = Array.isArray(context.settings.args) ? (context.settings.args as string[]) : ["--auto", "--proof-object", "--tstp-format"];
    // A profile that replaces the arguments (a wrapper script) gets them in front of `--version` too.
    const base = Array.isArray(context.settings.args) ? (context.settings.args as string[]) : [];
    let version: Promise<string | undefined> | undefined;
    const readVersion = (signal?: AbortSignal): Promise<string | undefined> => {
      version ??= runProcess({ command, args: [...base, "--version"], timeoutMs: 10000, ...(signal !== undefined ? { signal } : {}) }).then(
        (r) => (r.exitCode === 0 ? (r.stdout.trim().split("\n")[0] || undefined)?.slice(0, 200) : undefined),
        () => undefined,
      );
      return version;
    };
    return {
      async invoke(input: Json, invoke: InvokeContext): Promise<Json> {
        const { tptp, timeoutSec = 30 } = input as unknown as AtpInput;
        try {
          screenTptp(tptp);
        } catch (error) {
          if (error instanceof Refused) return { szs: "none", result: "error", used: [], detail: `refused: ${error.message}`, exitCode: null, elapsedMs: 0 } as unknown as Json;
          throw error;
        }
        let result;
        try {
          result = await runIsolated({ command, args: [...args, `--cpu-limit=${Math.ceil(timeoutSec)}`, `--memory-limit=${memoryMb}`], stdin: tptp, timeoutMs: (timeoutSec + 5) * 1000, signal: invoke.signal, memoryMb: memoryMb * 2 });
        } catch (error) {
          if (error instanceof NotInstalled) throw new UnavailableError(error.message);
          throw error;
        }
        if (result.aborted) throw new Error("aborted");
        const read = result.timedOut ? ({ szs: "Timeout", result: "timeout", used: [] as string[] } as const) : readSzs(result.stdout, result.exitCode, result.stderr);
        const found = await readVersion(invoke.signal);
        const out: AtpOutput = { ...read, exitCode: result.exitCode, elapsedMs: result.elapsedMs, ...(found !== undefined ? { version: found } : {}) };
        return out as unknown as Json;
      },
      async health(h): Promise<{ ok: boolean; detail?: string }> {
        try {
          const r = await runProcess({ command, args: [...base, "--version"], timeoutMs: 10000, signal: h.signal });
          return r.exitCode === 0 ? { ok: true, detail: r.stdout.trim().split("\n")[0] ?? "eprover" } : { ok: false, detail: `exit code ${r.exitCode}` };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  };
}
