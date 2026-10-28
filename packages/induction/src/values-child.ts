/**
 * The process that runs a program for `runValues` (see sandbox.ts). It reads one line of JSON,
 * `{source, args, callMs, maxBytes, seed}`, and writes one line per argument: `v` and the JSON text of the
 * program's value, `n` when it returned nothing JSON can hold, `b` when the value is longer than the limit,
 * `t` when the call went over its time and `e` and the message when it threw. The program is one function
 * expression, run in a `node:vm` context of its own with no global but the language's, no code generation
 * from strings, a `Math.random` that is a seeded generator, and data that reaches it as JSON text only.
 */
import { createInterface } from "node:readline";
import vm from "node:vm";

interface Request {
  source: string;
  args: string[];
  callMs: number;
  maxBytes: number;
  seed: number;
}

/** What a thrown value says, in one line. It never throws, whatever the value is. */
function messageOf(error: unknown): string {
  try {
    const text = String((error as { message?: unknown } | null)?.message ?? error);
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "(the thrown value cannot be read)";
  }
}

function answerForThrown(error: unknown): string {
  try {
    if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return "t";
  } catch {
    // A `code` that throws is not the time limit.
  }
  return `e${messageOf(error)}`;
}

createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line) as Request;
  const context = vm.createContext(Object.create(null) as object, { codeGeneration: { strings: false, wasm: false } });
  try {
    // A seeded Math.random (mulberry32), so that a program that draws gives the same values on every run.
    new vm.Script(
      `(function () { var s = ${request.seed >>> 0}; Math.random = function () { s = (s + 0x6d2b79f5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`,
    ).runInContext(context, { timeout: request.callMs });
    new vm.Script(`var __program = (${request.source}\n);\nvar __call = function (text) { var r = __program(JSON.parse(text)); var j = JSON.stringify(r); return j === undefined ? undefined : j; };`).runInContext(context, {
      timeout: request.callMs,
    });
  } catch (error) {
    process.stdout.write(`x${messageOf(error)}\n`, () => process.exit(0));
    return;
  }
  const call = new vm.Script("__call(__text)");
  for (const arg of request.args) {
    (context as { __text?: string }).__text = arg;
    let answer: string;
    try {
      const result = call.runInContext(context, { timeout: request.callMs }) as string | undefined;
      answer = result === undefined ? "n" : result.length > request.maxBytes ? "b" : `v${result}`;
    } catch (error) {
      answer = answerForThrown(error);
    }
    process.stdout.write(`${answer}\n`);
  }
  process.stdout.write("", () => process.exit(0));
});
