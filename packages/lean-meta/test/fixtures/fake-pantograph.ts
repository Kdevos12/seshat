/**
 * A stand-in for Pantograph's REPL v0.3.13 in tests, run as a child process with the modules as
 * arguments: it prints a line, then `ready.`, then answers each `<command> <json>` line with one
 * line of JSON, as the REPL does. The module `Missing` makes it fail to start.
 *
 * `frontend.distil` gives one target per `theorem` whose proof is `by sorry`: one goal, the
 * theorem's binders as hypotheses. Tactics: `simp` and `rfl` close the goal, `constructor` splits
 * `A ∧ B` into the cases `left` and `right`, a tactic with `notDefinedAnywhere` fails with Lean's
 * message, `(` does not parse, `slow` never answers, `crash` ends the process.
 */
import { createInterface } from "node:readline";

interface Goal {
  name: string;
  userName?: string;
  target: { pp: string };
  vars: Array<{ name: string; userName: string; isInaccessible: boolean; type: { pp: string } }>;
}
type Answer = Record<string, unknown> | undefined;

const modules = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (modules.includes("Missing")) {
  process.stderr.write("unknown module prefix 'Missing'\n");
  process.exit(1);
}
process.stdout.write(`importing ${modules.join(" ")}\nready.\n`);

const states = new Map<number, Goal[]>();
let next = 0;
let timeout = 0;

const add = (goals: Goal[]): number => {
  states.set(next, goals);
  return next++;
};
const goal = (target: string, vars: Array<[string, string]>, userName?: string): Goal => ({
  name: `_uniq.${Math.floor(Math.random() * 1e6)}`,
  ...(userName !== undefined ? { userName } : {}),
  target: { pp: target },
  vars: vars.map(([n, t]) => ({ name: `_uniq.${n}`, userName: n, isInaccessible: false, type: { pp: t } })),
});
const error = (kind: string, desc: string): Answer => ({ error: kind, desc });
const leanError = (text: string) => ({ fileName: "<Pantograph>", pos: { line: 1, column: 0 }, endPos: null, severity: "error", caption: "", data: text });

/** The binders and the type of `theorem name <binders> : <type> := by sorry`. */
function goalOfTheorem(head: string): Goal {
  let depth = 0;
  let colon = -1;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ":" && depth === 0) {
      colon = i;
      break;
    }
  }
  const vars: Array<[string, string]> = [];
  for (const m of head.slice(0, colon).matchAll(/\(([^:()]+):([^()]+)\)/g)) {
    for (const name of (m[1] ?? "").trim().split(/\s+/)) vars.push([name, (m[2] ?? "").trim()]);
  }
  return goal(head.slice(colon + 1).trim(), vars);
}

function distil(file: string): Answer {
  if (/^\s*import\s/m.test(file)) return error("frontend", "invalid 'import' command, it must be used in the beginning of the file");
  if (file.includes("notDefinedAnywhere")) return error("frontend", "<anonymous>:3:30: unknown identifier 'notDefinedAnywhere'");
  const targets = [];
  for (const chunk of file.split(/^theorem\s+\S+/m).slice(1)) {
    const m = /^([\s\S]*?):=\s*by\s+sorry/.exec(chunk);
    if (m === null) continue;
    const goals = [goalOfTheorem(m[1] ?? "")];
    targets.push({ stateId: add(goals), goals });
  }
  return { targets };
}

function tactic(args: { stateId: number; goalId?: number; tactic: string }): Answer {
  const goals = states.get(args.stateId);
  if (goals === undefined) return error("index", `Invalid state index ${args.stateId}`);
  if (args.tactic === "slow") return undefined;
  if (args.tactic === "crash") process.exit(3);
  const done = { hasSorry: false, hasUnsafe: false };
  if (args.tactic === "(") return { messages: [], parseError: "<Pantograph>:1:1: unexpected end of input", ...done };
  if (args.tactic.includes("notDefinedAnywhere")) return { messages: [leanError("unknown identifier 'notDefinedAnywhere'")], ...done };
  const at = args.goalId ?? 0;
  const target = goals[at];
  if (target === undefined) return error("index", `Invalid goal index ${at}`);
  let replaced: Goal[];
  if (args.tactic === "simp" || args.tactic === "rfl") replaced = [];
  else if (args.tactic === "constructor" && target.target.pp.includes(" ∧ ")) {
    const [left, right] = target.target.pp.split(" ∧ ");
    replaced = [goal(left ?? "", []), goal(right ?? "", [])].map((g, i) => ({ ...g, vars: target.vars, userName: i === 0 ? "left" : "right" }));
  } else return { messages: [leanError(`the fake does not know ${args.tactic}`)], ...done };
  const rest = [...goals.slice(0, at), ...replaced, ...goals.slice(at + 1)];
  return { nextStateId: add(rest), goals: rest, messages: [], ...done };
}

function answer(command: string, args: Record<string, unknown>): Answer {
  switch (command) {
    case "frontend.distil":
      return distil(String(args.file));
    case "goal.tactic":
      return tactic(args as { stateId: number; goalId?: number; tactic: string });
    case "goal.print": {
      const goals = states.get(args.stateId as number);
      if (goals === undefined) return error("index", `Invalid state index ${String(args.stateId)}`);
      return { goals: args.goals === true ? goals : [], extraMVars: [], rootHasSorry: false, rootHasUnsafe: false, rootHasMVar: true };
    }
    case "goal.delete":
      for (const id of args.stateIds as number[]) states.delete(id);
      return {};
    case "stat":
      return { nGoals: states.size };
    case "options.set":
      timeout = typeof args.timeout === "number" ? args.timeout : timeout;
      return {};
    case "options.print":
      return { timeout };
    default:
      return error("command", `Unknown command ${command}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const space = line.indexOf(" ");
  const command = space < 0 ? line : line.slice(0, space);
  const reply = answer(command, space < 0 ? {} : (JSON.parse(line.slice(space + 1)) as Record<string, unknown>));
  if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
