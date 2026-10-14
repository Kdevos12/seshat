import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Api, type AssistantMessage, type Model, type Models } from "@earendil-works/pi-ai";
import type { Submission, TokenCost, ValidationReport } from "@seshat/core";
import { messageOf } from "@seshat/registry";
import { contextTokens, type Ledger, messageCost } from "./budget.ts";
import { formatCheck, summarizeCheck } from "./feedback.ts";
import type { SessionHooks } from "./line-runtime.ts";
import type { Workbench } from "./problem.ts";
import { WRAP_UP } from "./prompt.ts";

/**
 * Why a session ended: `model` (the model stopped calling tools), `turns` or `context` (a limit of
 * the session), `budget` (the problem's budget), `solved` (this session found the candidate),
 * `aborted` (another prover found it, or the run was stopped), `error`, or `line:<id>` (an enabled
 * line's `afterCheck` stopped it).
 */
export type SessionStop = "model" | "turns" | "context" | "budget" | "solved" | "aborted" | "error" | `line:${string}`;

export interface SessionLimits {
  /** Model responses in one session. */
  turns: number;
  /** Prompt size, in tokens, past which the session ends, before the context degrades. */
  contextTokens: number;
}

/** Reasons a problem's signal is aborted with. */
export const ABORT_SOLVED = "solved";
export const ABORT_BUDGET = "budget";
export const ABORT_STOPPED = "stopped";

export interface SessionOptions {
  models: Models;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  workbench: Workbench;
  attemptId: string;
  actor: string;
  limits: SessionLimits;
  /** Charged with every model response. */
  ledger: Ledger;
  /** The problem's signal, aborted with `ABORT_SOLVED`, `ABORT_BUDGET` or `ABORT_STOPPED`. */
  signal: AbortSignal;
  /** When a limit ends the session, ask the model for its notes (one more response). */
  wrapUp: boolean;
  /** Tools besides lean_check, for this session's attempt. */
  tools?: AgentTool<never, unknown>[];
  /** The enabled lines' hooks inside the session: the context packet, and the look at each check. */
  lines?: SessionHooks;
}

export interface SessionResult {
  stop: SessionStop;
  turns: number;
  cost: TokenCost;
  /** The model's final message, when it ended the session itself or was asked for its notes. */
  notes: string | undefined;
  /** The regions of the session's last check, and what the check said. */
  submission: Submission | undefined;
  report: ValidationReport | undefined;
  submissions: number;
  messages: AgentMessage[];
  error?: string;
}

/** Lean answers `server_error` this many times in a row: the session ends with an error. */
const MAX_UNREACHABLE = 3;

/** One session of a prover: a fresh pi agent with `lean_check` and the run's other tools. */
export async function runSession(o: SessionOptions): Promise<SessionResult> {
  const cost: TokenCost = { usd: 0, inputTokens: 0, outputTokens: 0 };
  let turns = 0;
  let submissions = 0;
  let submission: Submission | undefined;
  let report: ValidationReport | undefined;
  let accepted = false;
  let failure: string | undefined;
  let unreachable = 0;
  let limit: "turns" | "context" | "budget" | undefined;
  let wrappingUp = false;
  let last: AssistantMessage | undefined;
  let lineStop: `line:${string}` | undefined;
  let requests = 0;

  const leanCheck: AgentTool<ReturnType<typeof checkParameters>, { summary: string }> = {
    name: "lean_check",
    label: "Lean check",
    description:
      "Puts the two regions in the file and checks the whole file with Lean. Returns Lean's errors, the goal at each " +
      "sorry and other messages, located by region and line. A file without sorry that Lean accepts, with the standard " +
      "axioms and the original statement, is accepted: the theorem is proved.",
    parameters: checkParameters(),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      submissions += 1;
      submission = { aux: params.aux, proof: params.proof };
      try {
        const result = await o.workbench.check(submission, { attemptId: o.attemptId, actor: o.actor, ...(signal ? { signal } : {}) });
        report = result.report;
        accepted ||= result.accepted;
        const lost = report.leanStatus === "server_error" && report.messages.length === 0 && !(signal?.aborted ?? false);
        unreachable = lost ? unreachable + 1 : 0;
        if (unreachable >= MAX_UNREACHABLE) failure = `Lean could not be reached ${unreachable} times in a row`;
        if (o.lines?.afterCheck !== undefined) {
          // A line that fails here ends the session with an error, not the check.
          try {
            const stop = await o.lines.afterCheck({
              index: submissions,
              submission,
              report,
              ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
              accepted: result.accepted,
            });
            if (stop !== undefined) lineStop = `line:${stop.line}`;
          } catch (error) {
            failure = messageOf(error);
          }
        }
        return {
          content: [{ type: "text", text: formatCheck(report) }],
          details: { summary: summarizeCheck(report) },
          ...(result.accepted || failure !== undefined || lineStop !== undefined ? { terminate: true } : {}),
        };
      } catch (error) {
        failure = `the harness failed during a check: ${messageOf(error)}`;
        return {
          content: [{ type: "text", text: "The harness failed while checking this file. The session ends here." }],
          details: { summary: "harness failure" },
          isError: true,
          terminate: true,
        };
      }
    },
  };

  const packet = o.lines?.packet;
  const agent = new Agent({
    initialState: { systemPrompt: o.systemPrompt, model: o.model, thinkingLevel: o.thinkingLevel, tools: [leanCheck, ...(o.tools ?? [])] },
    streamFn: o.models.streamSimple.bind(o.models),
    toolExecution: "sequential",
    sessionId: o.attemptId,
    // The context packet of a line (M4) replaces every message after the system messages, which
    // hold the system prompt and the tools. pi wants this hook never to throw: a failure ends the
    // session with an error, and the request is aborted.
    ...(packet !== undefined
      ? {
          transformContext: async (messages: AgentMessage[]) => {
            requests += 1;
            try {
              const text = await packet(requests, messages);
              if (text === undefined) return messages;
              return [...messages.filter((m) => m.role === "system"), { role: "user", content: text, timestamp: Date.now() }];
            } catch (error) {
              failure = messageOf(error);
              agent.abort();
              return messages;
            }
          },
        }
      : {}),
    beforeToolCall: async () =>
      wrappingUp ? { block: true, reason: "The session is over: write your notes as text, without calling a tool." } : undefined,
    finishTurn: () => {
      if (wrappingUp || accepted || failure !== undefined || lineStop !== undefined || o.signal.aborted) return { action: "end" };
      if (o.ledger.exhausted) limit = "budget";
      else if (turns >= o.limits.turns) limit = "turns";
      else if (last !== undefined && contextTokens(last) >= o.limits.contextTokens) limit = "context";
      return limit === undefined ? undefined : { action: "end" };
    },
  });
  agent.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    last = event.message;
    turns += 1;
    const charge = messageCost(o.model, event.message);
    cost.usd += charge.usd;
    cost.inputTokens += charge.inputTokens;
    cost.outputTokens += charge.outputTokens;
    o.ledger.charge(charge);
  });
  const abort = () => agent.abort();
  o.signal.addEventListener("abort", abort, { once: true });
  try {
    if (!o.signal.aborted) await agent.prompt(o.prompt);
    const stop = stopOf();
    let notes = stop === "model" ? textOf(last) : undefined;
    if (o.wrapUp && (stop === "turns" || stop === "context") && !o.signal.aborted) {
      wrappingUp = true;
      await agent.prompt(WRAP_UP);
      if (last?.stopReason !== "error" && last?.stopReason !== "aborted") notes = textOf(last);
    }
    return {
      stop,
      turns,
      cost,
      notes,
      submission,
      report,
      submissions,
      messages: agent.state.messages,
      ...(stop === "error" ? { error: failure ?? last?.errorMessage ?? "the model request failed" } : {}),
    };
  } finally {
    o.signal.removeEventListener("abort", abort);
  }

  function stopOf(): SessionStop {
    if (accepted) return "solved";
    if (failure !== undefined) return "error";
    if (lineStop !== undefined) return lineStop;
    if (o.signal.aborted) return o.signal.reason === ABORT_BUDGET ? "budget" : "aborted";
    if (limit !== undefined) return limit;
    if (last === undefined || last.stopReason === "error") return "error";
    if (last.stopReason === "aborted") return "aborted";
    return "model";
  }
}

function checkParameters() {
  return Type.Object({
    aux: Type.String({
      description: "The whole AUX region: auxiliary lemmas and definitions named aux_..., or an empty string.",
    }),
    proof: Type.String({
      description: "The whole PROOF region: the tactics that prove the theorem, without `by`. Use sorry for the parts not proved yet.",
    }),
  });
}

/** The text of a response, without its thinking. */
function textOf(message: AssistantMessage | undefined): string | undefined {
  if (message === undefined) return undefined;
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}
