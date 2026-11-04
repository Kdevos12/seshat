import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyStatement } from "@seshat/orchestrator";
import { newId } from "@seshat/core";
import type { KeyScope } from "./jobs.ts";
import { readResumeInfo, readRun, runDirectory } from "./reader.ts";

/**
 * What the interface may ask the process manager to start: `harness solve|run|resume|hint|steer|sign`, each with a fixed list of
 * fields. A field is checked here and handed to the command as one argument of an argument list, in the `--flag=value` form, so that
 * no value is read by a shell and none can be taken for a flag. Nothing here decides anything about research.
 */

/** A request the interface refuses, with the reason. */
export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type JobKind = "solve" | "run" | "resume" | "hint" | "steer" | "sign";
export const JOB_KINDS: readonly JobKind[] = ["solve", "run", "resume", "hint", "steer", "sign"];

/** A command ready to start. */
export interface Planned {
  kind: JobKind;
  /** The arguments after `harness`. */
  argv: string[];
  /** The run directory the command works on (the run's id is its name). */
  dir: string | undefined;
  runId: string | undefined;
  /** Whether the person may start it detached, so that it outlives the server. */
  mayDetach: boolean;
  /** Which stored keys the command may have: the chosen model's provider only; none for a command that calls no model. */
  keys: KeyScope;
  /** Writes the files the command reads, once nothing can refuse the command any more. */
  prepare?: () => void;
  /** Removes them if the command could not start. */
  cleanup?: () => void;
}

export interface PlanContext {
  runsDir: string;
}

type Body = Record<string, unknown>;

function str(body: Body, key: string, o: { max?: number; required?: boolean; pattern?: RegExp; what?: string } = {}): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (o.required === true) throw new RequestError(`${o.what ?? key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new RequestError(`${o.what ?? key} must be text`);
  if (v.length > (o.max ?? 500)) throw new RequestError(`${o.what ?? key} is too long`);
  if (v.includes("\0")) throw new RequestError(`${o.what ?? key} has a null character`);
  if (o.pattern !== undefined && !o.pattern.test(v)) throw new RequestError(`${o.what ?? key} is not in a form the interface accepts`);
  return v;
}

function num(body: Body, key: string, o: { min?: number; max?: number; integer?: boolean; required?: boolean; what?: string } = {}): number | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (o.required === true) throw new RequestError(`${o.what ?? key} is required`);
    return undefined;
  }
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new RequestError(`${o.what ?? key} must be a number`);
  if (o.integer === true && !Number.isInteger(n)) throw new RequestError(`${o.what ?? key} must be a whole number`);
  if (o.min !== undefined ? n < o.min : n <= 0) throw new RequestError(`${o.what ?? key} must be above ${o.min ?? 0}`);
  if (n > (o.max ?? 1e9)) throw new RequestError(`${o.what ?? key} is too large`);
  return n;
}

const NAME = /^[\p{L}\p{N}_. -]{1,60}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,200}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
const ID = /^[A-Za-z0-9_][A-Za-z0-9_.:#/-]{0,200}$/;
const STRATEGY = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,80}$/;
const LINE = /^[A-Za-z0-9_]{1,16}$/;

/** The key scope of a model named `PROVIDER/ID`: that provider's key alone. With no model named the command picks the cheapest, so it may need any. */
function scopeOf(model: string | undefined): KeyScope {
  if (model === undefined) return { mode: "all" };
  const slash = model.indexOf("/");
  return slash > 0 ? { mode: "provider", provider: model.slice(0, slash) } : { mode: "all" };
}

function runModel(dir: string): string | undefined {
  try {
    return readRun(dir).model ?? undefined;
  } catch {
    return undefined;
  }
}

function flag(name: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`--${name}=${value}`];
}

function existingRun(ctx: PlanContext, body: Body): { dir: string; runId: string } {
  const id = str(body, "runId", { required: true, max: 128, what: "the run" }) as string;
  const dir = runDirectory(ctx.runsDir, id);
  if (dir === undefined) throw new RequestError("no such run", 404);
  return { dir, runId: id };
}

function turnLimit(body: Body): string[] {
  return [
    ...flag("turn-usd", num(body, "turnUsd", { max: 10_000, what: "the dollar limit of the turn" })),
    ...flag("turn-tokens", num(body, "turnTokens", { max: 1e9, integer: true, what: "the token limit of the turn" })),
    ...flag("turn-minutes", num(body, "turnMinutes", { max: 100_000, what: "the time limit of the turn" })),
  ];
}

/** A fresh run id: sortable by time, unique. */
export function freshRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `ui-${stamp}-${newId("r").slice(-6).replace(/[^A-Za-z0-9]/g, "x")}`;
}

/** Checks a request and turns it into the arguments of a command. Throws `RequestError`. */
export function plan(kind: string, body: Body, ctx: PlanContext): Planned {
  switch (kind) {
    case "solve": {
      const statement = str(body, "statement", { required: true, max: 20_000, what: "the statement" }) as string;
      if (statement.trim() === "") throw new RequestError("the statement is empty");
      const given = str(body, "mode", { max: 8 });
      if (given !== undefined && given !== "auto" && given !== "lean" && given !== "prose") throw new RequestError("the reading of the statement is lean, prose or auto");
      const mode = given === undefined || given === "auto" ? classifyStatement(statement) : given;
      const maxUsd = num(body, "maxUsd", { required: true, max: 1000, what: "the spend ceiling" }) as number;
      const runId = freshRunId();
      const dir = join(ctx.runsDir, runId);
      // The statement goes to a file the command reads, so that text which happens to be a path is never read as one. Every field is
      // checked before the file exists; it is written when the command is about to start, and kept, under runs/_inputs, as the record of what was asked.
      const inputs = join(ctx.runsDir, "_inputs");
      const file = join(inputs, `${runId}.${mode === "lean" ? "lean" : "txt"}`);
      const model = str(body, "model", { pattern: MODEL, what: "the model" });
      const argv = [
        "solve",
        file,
        `--out=${dir}`,
        `--max-usd=${maxUsd}`,
        ...flag("model", model),
        ...flag("turn-usd", num(body, "turnUsd", { max: 1000, what: "the dollar limit of the first turn" })),
        ...flag("host", str(body, "host", { pattern: HOST, what: "the host" })),
        ...flag("as", str(body, "as", { pattern: NAME, what: "your name" })),
        "--ask-stdin",
      ];
      return {
        kind: "solve",
        argv,
        dir,
        runId,
        mayDetach: false,
        keys: scopeOf(model),
        prepare: () => {
          mkdirSync(inputs, { recursive: true, mode: 0o700 });
          writeFileSync(file, statement, { mode: 0o600, flag: "wx" });
        },
        cleanup: () => rmSync(file, { force: true }),
      };
    }
    case "run": {
      const checkout = str(body, "checkout", { required: true, max: 1000, what: "the checkout" }) as string;
      const model = str(body, "model", { required: true, pattern: MODEL, what: "the model" }) as string;
      const sample = num(body, "sample", { integer: true, max: 1000, what: "the sample size" });
      const problems = Array.isArray(body.problems) ? body.problems : undefined;
      if ((sample === undefined) === (problems === undefined)) throw new RequestError("give either a sample size or a list of problems");
      const problemFlags = (problems ?? []).map((p) => {
        if (typeof p !== "string" || !ID.test(p)) throw new RequestError("a problem id is not in a form the interface accepts");
        return `--problem=${p}`;
      });
      if (problemFlags.length > 200) throw new RequestError("too many problems");
      const lines = Array.isArray(body.lines) ? body.lines : [];
      const lineFlags = lines.map((l) => {
        if (typeof l !== "string" || !LINE.test(l)) throw new RequestError("a line id is not in a form the interface accepts");
        return `--lines=${l}`;
      });
      // A run has a spend ceiling the person set: the interface does not start one that would spend by the harness's default.
      const runBudget = num(body, "runBudgetUsd", { required: true, max: 100_000, what: "the spend ceiling of the run" }) as number;
      const runId = freshRunId();
      const dir = join(ctx.runsDir, runId);
      return {
        kind: "run",
        argv: [
          "run",
          `--checkout=${checkout}`,
          `--model=${model}`,
          ...flag("sample", sample),
          ...problemFlags,
          ...flag("bench", str(body, "bench", { max: 1000, what: "the bench file" })),
          ...flag("host", str(body, "host", { pattern: HOST, what: "the host" })),
          ...flag("budget-usd", num(body, "budgetUsd", { max: 100_000, what: "the budget of a problem" })),
          `--run-budget-usd=${runBudget}`,
          ...lineFlags,
          ...turnLimit(body),
          ...(body.human === true ? ["--human"] : []),
          `--out=${dir}`,
        ],
        dir,
        runId,
        mayDetach: true,
        keys: scopeOf(model),
      };
    }
    case "resume": {
      const { dir, runId } = existingRun(ctx, body);
      const info = readResumeInfo(dir);
      if (info === null) throw new RequestError("this run has no resume.json (it records the checkout, the bench and the host the run began with), so the interface cannot resume it; use the command RESULT.md gives", 409);
      return {
        kind: "resume",
        argv: ["resume", dir, `--checkout=${info.checkout}`, ...flag("bench", info.bench), ...flag("host", info.host), ...turnLimit(body)],
        dir,
        runId,
        mayDetach: true,
        // The run's own model, as its journal says; a run whose model cannot be read gets every stored key.
        keys: scopeOf(runModel(dir)),
      };
    }
    case "hint": {
      const { dir, runId } = existingRun(ctx, body);
      const text = str(body, "text", { required: true, max: 4000, what: "the hint" }) as string;
      return {
        kind: "hint",
        argv: ["hint", dir, `--claim=${str(body, "claimId", { required: true, pattern: ID, what: "the claim" })}`, ...flag("as", str(body, "as", { pattern: NAME, what: "your name" })), "--", text],
        dir,
        runId,
        mayDetach: false,
        keys: { mode: "none" },
      };
    }
    case "sign": {
      const { dir, runId } = existingRun(ctx, body);
      const edgeId = str(body, "edgeId", { required: true, pattern: ID, what: "the edge" }) as string;
      return {
        kind: "sign",
        argv: ["sign", dir, ...flag("note", str(body, "note", { max: 1000, what: "the note" })), ...flag("as", str(body, "as", { pattern: NAME, what: "your name" })), "--", edgeId],
        dir,
        runId,
        mayDetach: false,
        keys: { mode: "none" },
      };
    }
    case "steer": {
      const { dir, runId } = existingRun(ctx, body);
      const claimId = str(body, "claimId", { pattern: ID, what: "the claim" });
      const argv = [
        "steer",
        dir,
        ...flag("focus", str(body, "focus", { pattern: ID, what: "the claim to focus on" })),
        ...flag("drop", str(body, "drop", { pattern: ID, what: "the claim to drop" })),
        ...flag("forbid", str(body, "forbid", { pattern: STRATEGY, what: "the strategy to forbid" })),
        ...flag("claim", claimId),
        ...turnLimit(body),
        ...flag("as", str(body, "as", { pattern: NAME, what: "your name" })),
      ];
      if (argv.length === 2) throw new RequestError("steer needs something to say: a claim to focus on or drop, a strategy to forbid, or a limit for the next turn");
      return { kind: "steer", argv, dir, runId, mayDetach: false, keys: { mode: "none" } };
    }
    default:
      throw new RequestError(`unknown command ${JSON.stringify(kind).slice(0, 40)}`);
  }
}
