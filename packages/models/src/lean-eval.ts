import type { LeanCheckResult, LeanChecker } from "@seshat/core";
import type { BatteryObject } from "./objects.ts";
import { leanArguments, leanDefinition, type RecognizedStatement } from "./statement.ts";

/** The name of the proposition the evaluator defines from the statement. */
export const STATEMENT_NAME = "m11_stmt";

export interface LeanEvalInput {
  /** The claim's header: the imports, `open`s and definitions its statement needs. */
  header: string;
  statement: RecognizedStatement;
  objects: readonly BatteryObject[];
}

export interface LeanEvalOptions {
  /** Lean's time limit for each file, in seconds. Default 60. */
  timeoutSec?: number;
  /** Objects in a file. Default 16. A file that times out is split in two. */
  batch?: number;
  /** Files in a call to the checker. Default 8. */
  parallel?: number;
  signal?: AbortSignal;
}

export interface LeanEvaluation {
  /** One entry for each object: the statement holds on it (`true`) or not (`false`), or `decide` settled neither (`null`). */
  verdicts: Array<boolean | null>;
  /** For a null verdict, why. */
  notes: Array<string | undefined>;
  /** Files sent to the checker. */
  checks: number;
  /** Set when the statement could not be tried at all: the definition does not elaborate, or `decide` settles nothing on the first objects. */
  unusable?: string;
}

type Outcome = { kind: "pass" } | { kind: "fail" | "unknown"; message: string };

class Unusable extends Error {}

function argumentsOf(statement: RecognizedStatement, object: BatteryObject): string {
  if (statement.kind === "nat") {
    if (object.kind !== "integer" || !Number.isSafeInteger(object.value) || object.value < 0) throw new TypeError(`a statement about a natural number is tried on non-negative integers, not on ${object.id}`);
    return leanArguments(statement, object.value);
  }
  if (object.kind !== "magma") throw new TypeError(`a statement about magmas is tried on magmas, not on ${object.id}`);
  return leanArguments(statement, object);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const shorten = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * Tries a statement on objects with Lean: the statement becomes a proposition `m11_stmt` about its
 * structure, and for each object the file asks `example : @m11_stmt <object> := by decide`. A file
 * that Lean accepts says the statement holds on the object; for an object whose example fails, a
 * second file asks for the negation, and Lean accepting it says the statement fails. When `decide`
 * settles neither (a time limit, a statement it cannot decide), the object has no verdict. One
 * `example` is on one line, so that the line of an error says which object it is about.
 *
 * The verdicts are test results, and no more: `decide` ran on a statement this code wrote from the
 * claim's. A counter-model becomes a refutation only through `validate` (refutation.ts).
 */
export async function evaluateWithLean(checker: LeanChecker, input: LeanEvalInput, options: LeanEvalOptions = {}): Promise<LeanEvaluation> {
  const { statement, objects } = input;
  const timeoutSec = options.timeoutSec ?? 60;
  const batch = Math.max(1, Math.floor(options.batch ?? 16));
  const parallel = Math.max(1, Math.floor(options.parallel ?? 8));
  const verdicts: Array<boolean | null> = objects.map(() => null);
  const notes: Array<string | undefined> = objects.map(() => undefined);
  const evaluation = (): LeanEvaluation => ({ verdicts, notes, checks, ...(unusable !== undefined ? { unusable } : {}) });
  let checks = 0;
  let unusable: string | undefined;
  if (objects.length === 0) return evaluation();

  const args = objects.map((object) => argumentsOf(statement, object));
  const header = input.header.replace(/\s+$/, "");
  const preamble = `${header === "" ? "" : `${header}\n\n`}${leanDefinition(statement, STATEMENT_NAME)}\n`;
  const preambleLines = preamble.split("\n").length - 1;
  let counter = 0;

  const fileOf = (indices: readonly number[], negated: boolean) => ({
    id: `m11-${++counter}`,
    code: `${preamble}${indices.map((i) => `example : ${negated ? "¬ " : ""}@${STATEMENT_NAME} ${args[i]} := by decide`).join("\n")}\n`,
  });

  /** What each example of a file came to; "timeout" when the whole file did. */
  const read = (indices: readonly number[], result: LeanCheckResult | undefined): Outcome[] | "timeout" => {
    if (result === undefined) return indices.map(() => ({ kind: "unknown", message: "the checker returned no result for the file" }));
    if (result.status === "timeout") return "timeout";
    if (result.status === "server_error" || result.status === "repl_error") {
      return indices.map(() => ({ kind: "unknown", message: shorten(result.error ?? `Lean did not answer (${result.status})`) }));
    }
    const outcomes: Outcome[] = indices.map(() => ({ kind: "pass" }));
    for (const message of result.messages) {
      if (message.severity !== "error") continue;
      const k = message.pos.line - preambleLines - 1;
      if (k < 0 || k >= indices.length) throw new Unusable(shorten(message.text));
      if (outcomes[k]?.kind === "pass") outcomes[k] = { kind: "fail", message: shorten(message.text) };
    }
    if (result.status === "lean_error" && outcomes.every((o) => o.kind === "pass")) {
      return indices.map(() => ({ kind: "unknown", message: "Lean reported an error with no message" }));
    }
    return outcomes;
  };

  const run = async (groups: number[][], negated: boolean): Promise<Map<number, Outcome>> => {
    const done = new Map<number, Outcome>();
    let queue = groups.filter((g) => g.length > 0);
    while (queue.length > 0) {
      if (options.signal?.aborted === true) {
        for (const group of queue) for (const i of group) done.set(i, { kind: "unknown", message: "stopped before Lean was asked" });
        break;
      }
      const round = queue.slice(0, parallel);
      queue = queue.slice(parallel);
      const files = round.map((group) => fileOf(group, negated));
      const results = await checker.check(files, { timeoutSec, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
      checks += files.length;
      round.forEach((group, k) => {
        const outcomes = read(group, results.find((r) => r.id === files[k]?.id));
        if (outcomes === "timeout") {
          if (group.length > 1) queue.push(group.slice(0, group.length >> 1), group.slice(group.length >> 1));
          else done.set(group[0] as number, { kind: "unknown", message: `Lean went over ${timeoutSec} s` });
        } else {
          group.forEach((i, j) => done.set(i, outcomes[j] as Outcome));
        }
      });
    }
    return done;
  };

  /** Settles the objects: the statement first, then, for those that fail, its negation. Returns how many got a verdict. */
  const settle = async (indices: number[]): Promise<number> => {
    const holds = await run(chunk(indices, batch), false);
    let settled = 0;
    const open: number[] = [];
    for (const i of indices) {
      if (holds.get(i)?.kind === "pass") {
        verdicts[i] = true;
        settled++;
      } else {
        open.push(i);
      }
    }
    const fails = await run(chunk(open, batch), true);
    for (const i of open) {
      if (fails.get(i)?.kind === "pass") {
        verdicts[i] = false;
        settled++;
      } else {
        const why = fails.get(i);
        notes[i] = `decide settles neither the statement nor its negation${why !== undefined && why.kind !== "pass" ? `: ${why.message}` : ""}`;
      }
    }
    return settled;
  };

  const all = objects.map((_, i) => i);
  try {
    // The first file is a probe: when the definition does not elaborate, or decide settles nothing, the rest would say the same.
    const first = all.slice(0, batch);
    if ((await settle(first)) === 0) {
      unusable = `decide settles none of the first ${first.length} objects: ${notes[first[0] as number] ?? "no answer"}`;
      for (let i = 0; i < notes.length; i++) notes[i] ??= unusable;
      return evaluation();
    }
    await settle(all.slice(batch));
  } catch (error) {
    if (!(error instanceof Unusable)) throw error;
    unusable = `the definition of the statement does not elaborate: ${error.message}`;
    for (let i = 0; i < notes.length; i++) if (verdicts[i] === null) notes[i] = unusable;
  }
  return evaluation();
}
