import type { Json } from "@seshat/core";
import { describePlace } from "./layout.ts";
import type { Attempt, Hit, LeanLspOutput, Message } from "./protocol.ts";

const SEARCH_NAMES: Record<string, string> = { loogle: "Loogle", leansearch: "LeanSearch", state_search: "Lean Finder" };

/**
 * An answer of `lean.lsp` as the prover reads it: goals as Lean prints them, messages located by
 * region and line as `lean_check` locates them, one declaration per line for a search.
 */
export function presentOutput(value: Json): string {
  const o = value as unknown as LeanLspOutput;
  const lines = body(o);
  if (o.unavailable !== undefined) lines.push(o.unavailable);
  if (o.note !== undefined) lines.push(o.note);
  return lines.length === 0 ? "(no output)" : lines.join("\n");
}

function position(o: LeanLspOutput): string {
  const place = describePlace({ region: o.region ?? "proof", line: o.line ?? 1 }, o.column);
  const code = o.lineText?.trim() ?? "";
  return code === "" ? place : `${place}, \`${code.length > 100 ? `${code.slice(0, 97)}...` : code}\``;
}

function body(o: LeanLspOutput): string[] {
  switch (o.op) {
    case "goal":
      return goal(o);
    case "term_goal":
      return o.expectedType === undefined ? [`No expected type at ${position(o)}.`] : [`Expected type at ${position(o)}:`, o.expectedType];
    case "diagnostics":
      return diagnostics(o);
    case "multi_attempt":
      return multiAttempt(o);
    case "loogle":
    case "leansearch":
      return o.status === "unavailable" ? [] : hits(`${SEARCH_NAMES[o.op]}`, o.results ?? []);
    case "state_search":
      return stateSearch(o);
    case "hammer_premise":
      return premises(o);
    default:
      return [];
  }
}

function goalBlock(goals: readonly string[]): string[] {
  if (goals.length === 1) return [goals[0] as string];
  return goals.flatMap((goal, k) => [`Goal ${k + 1} of ${goals.length}:`, goal]);
}

function goal(o: LeanLspOutput): string[] {
  const at = position(o);
  if (o.goalsBefore !== undefined || o.goalsAfter !== undefined) {
    const section = (title: string, goals: readonly string[] | undefined) => [
      `${title} ${at}${goals === undefined || goals.length === 0 ? ": no goal." : `: ${goals.length} goal(s)`}`,
      ...(goals === undefined || goals.length === 0 ? [] : goalBlock(goals)),
    ];
    return [...section("Before", o.goalsBefore), "", ...section("After", o.goalsAfter)];
  }
  switch (o.status) {
    case "goals":
      return [`Goal at ${at}${(o.goals ?? []).length === 1 ? ":" : ` (${(o.goals ?? []).length}):`}`, ...goalBlock(o.goals ?? [])];
    case "complete":
      return [`${at}: no goals left. The proof is complete at this point.`];
    case "no_goal_here":
      return [`${at}: no proof state here. The position is outside a tactic block, or on a line without a tactic.`];
    case "still_elaborating":
      return [`${at}: Lean was still elaborating when the time limit came. Ask again, or give a larger timeoutSec.`];
    default:
      return [`${at}: ${o.status}`];
  }
}

function messageLines(messages: readonly Message[], first = 1): string[] {
  return messages.flatMap((m, k) => {
    const place = describePlace({ region: m.region, line: m.line }, m.column > 0 ? m.column : undefined);
    const code = m.code === undefined ? "" : `, \`${m.code}\``;
    return [`${first + k}. ${m.severity}, ${place}${code}:`, ...m.message.split("\n").map((line) => `   ${line}`), ...(m.hint !== undefined ? [`   hint: ${m.hint}`] : [])];
  });
}

function diagnostics(o: LeanLspOutput): string[] {
  const messages = o.messages ?? [];
  const where = o.region === undefined ? "the file" : `${o.region.toUpperCase()}`;
  const head = `Lean's messages on ${where}: ${o.errors ?? 0} error(s), ${o.warnings ?? 0} warning(s)${o.status === "partial" ? " (not final)" : ""}.`;
  return [head, ...messageLines(messages), ...((o.more ?? 0) > 0 ? [`[${o.more} more not shown]`] : [])];
}

function attempt(a: Attempt, k: number): string[] {
  const summary =
    a.result === "closed" ? "closes the goal (no goal left, no error)" : a.result === "open" ? `leaves ${a.goals.length} goal(s)` : "gives an error";
  return [
    `${k + 1}. \`${a.tactic.includes("\n") ? a.tactic.split("\n").join(" ⏎ ") : a.tactic}\`: ${summary}.`,
    ...(a.result === "open" ? goalBlock(a.goals).flatMap((g) => g.split("\n").map((line) => `   ${line}`)) : []),
    ...messageLines(a.messages).map((line) => `   ${line}`),
  ];
}

function multiAttempt(o: LeanLspOutput): string[] {
  const attempts = o.attempts ?? [];
  return [
    `Tried ${attempts.length} tactic(s) at ${position(o)}. Each replaces the line from the column on; the goals are read at its end. Lean's errors elsewhere in the file are listed too.`,
    ...attempts.flatMap(attempt),
  ];
}

function hitLine(h: Hit): string {
  const kind = h.kind !== undefined ? ` (${h.kind})` : "";
  const module = h.module !== undefined ? `  [${h.module}]` : "";
  return `- ${h.name}${kind}${h.type !== undefined ? ` : ${h.type}` : ""}${module}${h.description !== undefined ? `\n  ${h.description}` : ""}`;
}

function hits(source: string, results: readonly Hit[]): string[] {
  return results.length === 0 ? [`${source} found nothing.`] : [`${source} found ${results.length} declaration(s):`, ...results.map(hitLine)];
}

function stateSearch(o: LeanLspOutput): string[] {
  if (o.goal === undefined) return [`${position(o)}: ${o.status === "complete" ? "no goals left." : "no goal to search for."}`];
  const head = `Lean Finder, asked about the goal at ${position(o)}:`;
  const goalLines = o.goal.split("\n").map((line) => `  ${line}`);
  return o.status === "unavailable" ? [head, ...goalLines] : [head, ...goalLines, ...hits("Lean Finder", o.results ?? [])];
}

function premises(o: LeanLspOutput): string[] {
  if (o.status !== "ok") return o.status === "unavailable" ? [] : [`${position(o)}: no open goal.`];
  const names = o.premises ?? [];
  return names.length === 0
    ? [`The premise server found nothing for the goal at ${position(o)}.`]
    : [`Premises for the goal at ${position(o)}, to try with simp only [...], aesop or grind:`, names.join(", ")];
}
