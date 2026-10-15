/**
 * The process that runs a predicate program (see sandbox.ts). It reads one line of JSON,
 * `{source, args, callMs}`, and writes one line per argument: `1` or `0` for the program's verdict,
 * `n` when it returned something that is not a boolean, `t` when a call went over its time, and
 * `e` followed by the message when it threw. The program runs in a `node:vm` context of its own,
 * with no globals besides the language's, no code generation from strings, and data that reaches
 * it as JSON text only, so that it holds no object of this process.
 */
import { createInterface } from "node:readline";
import vm from "node:vm";

interface Request {
  source: string;
  args: string[];
  callMs: number;
}

function messageOf(error: unknown): string {
  const text = String((error as { message?: unknown } | null)?.message ?? error);
  return text.replace(/\s+/g, " ").slice(0, 200);
}

createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line) as Request;
  const context = vm.createContext(Object.create(null) as object, { codeGeneration: { strings: false, wasm: false } });
  try {
    new vm.Script(`var __program = (${request.source}\n);\nvar __call = function (text) { var r = __program(JSON.parse(text)); return r === true ? 1 : r === false ? 0 : 2; };`).runInContext(context, {
      timeout: request.callMs,
    });
  } catch (error) {
    process.stdout.write(`x${messageOf(error)}\n`, () => process.exit(0));
    return;
  }
  const call = new vm.Script("__call(__text)");
  // Each answer is written as soon as it is known, so that the parent keeps them if this process is killed.
  for (const arg of request.args) {
    (context as { __text?: string }).__text = arg;
    let answer: string;
    try {
      const result = call.runInContext(context, { timeout: request.callMs }) as number;
      answer = result === 1 ? "1" : result === 0 ? "0" : "n";
    } catch (error) {
      answer = (error as { code?: string } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? "t" : `e${messageOf(error)}`;
    }
    process.stdout.write(`${answer}\n`);
  }
  process.stdout.write("", () => process.exit(0));
});
