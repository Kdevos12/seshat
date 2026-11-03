import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runProcess, type ProcessResult, type ProcessSpec } from "./process.ts";

/**
 * What stands between a model's script and the host. `smt.z3` and `atp.vampire` take free text that
 * a model may write, and both programs can read and write files from the text alone (z3's
 * `set-option :regular-output-channel`, `:trace_file_name`, `(echo ...)`; TPTP's `include('...')`).
 * The harness's own translations use a small fixed set of commands, so the screen refuses the rest
 * before a process starts; the process then runs in an empty directory of its own, without the
 * harness's `HOME` and with a memory limit.
 */
export class Refused extends Error {}

/** The commands the translator writes, and the few a model needs besides (a model or a value). */
const SMT_COMMANDS = new Set(["set-logic", "set-option", "declare-sort", "declare-const", "declare-fun", "define-fun", "define-sort", "assert", "check-sat", "get-unsat-core", "get-model", "get-value", "push", "pop", "set-info"]);
/** The only options a script may set. */
const SMT_OPTIONS = new Set([":produce-unsat-cores", ":produce-models", ":produce-proofs", ":print-success"]);

/** Throws `Refused` when an SMT-LIB script does anything but declare, assert and ask. */
export function screenSmtLib(script: string): void {
  let depth = 0;
  let i = 0;
  let expectCommand = false;
  let expectOption = false;
  const n = script.length;
  while (i < n) {
    const c = script[i] as string;
    if (c === ";") {
      while (i < n && script[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= n) throw new Refused("an unterminated string");
        if (script[i] === '"') {
          if (script[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i++;
      expectCommand = expectOption = false;
      continue;
    }
    if (c === "|") {
      const end = script.indexOf("|", i + 1);
      if (end < 0) throw new Refused("an unterminated quoted symbol");
      i = end + 1;
      expectCommand = expectOption = false;
      continue;
    }
    if (c === "(") {
      if (depth === 0) expectCommand = true;
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth < 0) throw new Refused("an unbalanced parenthesis");
      i++;
      continue;
    }
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !/[\s()";|]/u.test(script[j] as string)) j++;
    const token = script.slice(i, j);
    i = j;
    if (depth === 0) throw new Refused(`text outside a command: ${token.slice(0, 40)}`);
    if (expectCommand) {
      if (!SMT_COMMANDS.has(token)) throw new Refused(`the command ${token.slice(0, 40)} (the commands allowed are ${[...SMT_COMMANDS].join(", ")})`);
      expectOption = token === "set-option";
      expectCommand = false;
    } else if (expectOption) {
      if (!SMT_OPTIONS.has(token)) throw new Refused(`the option ${token.slice(0, 40)}`);
      expectOption = false;
    }
  }
  if (depth !== 0) throw new Refused("an unbalanced parenthesis");
}

/** Throws `Refused` when a TPTP problem includes another file. */
export function screenTptp(text: string): void {
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/^%.*$/gmu, " ");
  if (/\binclude\s*\(/u.test(code)) throw new Refused("an include directive");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

export interface IsolatedSpec extends Omit<ProcessSpec, "cwd" | "env"> {
  /** The address space the process may use, in MiB. Default 4096. */
  memoryMb?: number;
}

/**
 * Runs a program in a new empty directory (removed afterwards) with a minimal environment: `PATH`,
 * and a `HOME` that is that directory. Where `prlimit` exists the address space is limited too.
 */
export async function runIsolated(spec: IsolatedSpec): Promise<ProcessResult> {
  const dir = mkdtempSync(join(tmpdir(), "seshat-solver-"));
  try {
    const memoryMb = spec.memoryMb ?? 4096;
    const prlimit = onPath("prlimit");
    const present = spec.command.includes("/") ? isExecutable(spec.command) : onPath(spec.command) !== undefined;
    // A program that is not installed must fail to start, so that the capability is unavailable.
    const limited = prlimit !== undefined && present;
    const command = limited ? prlimit : spec.command;
    const args = limited ? [`--as=${memoryMb * 1024 * 1024}`, `--cpu=${Math.ceil(spec.timeoutMs / 1000) + 5}`, "--", spec.command, ...spec.args] : spec.args;
    return await runProcess({ ...spec, command, args, cwd: dir, env: { HOME: dir, TMPDIR: dir }, minimalEnv: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
