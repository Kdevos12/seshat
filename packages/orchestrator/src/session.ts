import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type CacheRetention, createAssistantMessageEventStream, StringEnum, Type, type Api, type AssistantMessage, type Model, type Models } from "@earendil-works/pi-ai";
import type { Submission, TokenCost, ValidationReport } from "@seshat/core";
import { estimateTokens } from "@seshat/context";
import { messageOf } from "@seshat/registry";
import { contextTokens, type Ledger, messageCost } from "./budget.ts";
import { formatCheck, summarizeCheck } from "./feedback.ts";
import type { SessionHooks } from "./line-runtime.ts";
import type { PriceBook } from "./prices.ts";
import { keepReasoning } from "./history.ts";
import { composePacket, type FrozenState } from "./packet.ts";
import { REQUEST_RETRY, type RequestRetry, retryingStream, type RetryPolicy } from "./retry.ts";
import type { Workbench } from "./problem.ts";
import { WRAP_UP } from "./prompt.ts";
import { isTurnEnded, type Turn } from "./turns.ts";

/**
 * Why a session ended: `model` (the model stopped calling tools), `turns` or `context` (a limit of
 * the session), `budget` (the problem's budget), `solved` (this session found the candidate),
 * `aborted` (another prover found it, or the run was stopped), `error`, `turn` (the consortium turn
 * ended: the session stops after the response in flight, with no request for notes), or `line:<id>`
 * (an enabled line's `afterCheck` stopped it).
 */
export type SessionStop = "model" | "turns" | "context" | "budget" | "solved" | "aborted" | "error" | "turn" | `line:${string}`;

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

/**
 * How a session's requests are built from a line's context packet (plan change PD2, documentation/lines.md):
 * `prefix_tail` (the default) sends the prefix frozen at the first request and a tail compiled again for each request;
 * `append_only` sends the compiled packet on the first request and, after it, the session's own messages as they come,
 * without compiling the packet again; `recompiled` is the measurement arm of PE5, a prefix and tail compiled again
 * for each request, the prefix included, so that nothing of it is frozen.
 */
export type PacketMode = "prefix_tail" | "append_only" | "recompiled";

export const PACKET_MODES: readonly PacketMode[] = ["prefix_tail", "append_only", "recompiled"];

export interface SessionOptions {
  models: Models;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  /** Sent with each of the session's requests (a line sampled it: documentation/fleet.md); absent: the provider's own. */
  temperature?: number;
  systemPrompt: string;
  prompt: string;
  workbench: Workbench;
  attemptId: string;
  actor: string;
  limits: SessionLimits;
  /** Charged with every model response. */
  ledger: Ledger;
  /**
   * Told of every model response's cost as it is charged, so that the journal keeps what a session that never finishes spent.
   * A response that a transient error cut, and whose request was sent again, comes with `retry` (documentation/m0-loop.md, "Transient errors").
   */
  onCharge?: (cost: TokenCost, retry?: RequestRetry) => void;
  /** The problem's signal, aborted with `ABORT_SOLVED`, `ABORT_BUDGET` or `ABORT_STOPPED`. */
  signal: AbortSignal;
  /** When a limit ends the session, ask the model for its notes (one more response). */
  wrapUp: boolean;
  /** The consortium turn, when the run has them: once it is over the session sends no more requests (documentation/human.md). */
  turn?: Turn;
  /**
   * The team's veto of a check: the reason a proof is not run, or undefined. It comes before the lines'
   * guards, and the call is no check.
   */
  veto?: (proposal: { aux: string; proof: string; strategy?: string }) => string | undefined;
  /**
   * What the team said (its hints and what it asks), as sections. They are in the opening prompt; when a line's
   * `contextPacket` replaces the messages after the system prompt they would be lost, so they are added to the
   * packet's tail (never to its frozen prefix) in every request (documentation/human.md, "The team's answers").
   */
  teamSections?: ReadonlyArray<{ title: string; text: string }>;
  /** Tools besides lean_check, for this session's attempt. */
  tools?: AgentTool<never, unknown>[];
  /** The enabled lines' hooks inside the session: the context packet, and the look at each check. */
  lines?: SessionHooks;
  /**
   * Labels that `lean_check` takes as its optional `strategy` argument: what the model says it is
   * trying. Set only when an enabled line classifies strategies; absent, the tool is M0's.
   */
  strategies?: readonly string[];
  /**
   * The prompt cache retention asked of the provider with every request (pi-ai's `cacheRetention`:
   * `none`, `short` or `long`). Absent: the provider's own default. The option is on pi-ai's
   * request options for every provider, and one that does not use it ignores it.
   */
  cacheRetention?: CacheRetention;
  /** The host's prices: the session's charges are computed from them when they cover the model (documentation/m0-loop.md, "Prices"). */
  prices?: PriceBook;
  /**
   * Rewrites the messages of each request after the context packet is compiled (a mode that keeps or trims the
   * history). Whatever it returns, the harness puts back the reasoning of the assistant messages that belong to a
   * tool-call loop and that the rewrite dropped (`keepReasoning`).
   */
  rewriteHistory?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  /** How the requests are built from a line's context packet; absent: `prefix_tail`. */
  packetMode?: PacketMode;
  /** The seconds a Lean check of this session may take (`RunConfig.checkTimeoutSec`); absent: the workbench's policy (300). */
  checkTimeoutSec?: number;
  /** How a request whose response a transient error cut is sent again; absent: `REQUEST_RETRY` (documentation/m0-loop.md, "Transient errors"). */
  retry?: RetryPolicy;
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
  /** The strategy the model declared in its last `lean_check` that gave one. */
  declaredStrategy?: string;
  messages: AgentMessage[];
  /** Requests sent again after a transient error cut their response; absent: none. */
  retries?: number;
  /** The size of the tool declarations each request carried, in tokens (an upper bound: `estimateTokens` of their names, descriptions and parameters). */
  toolTokens?: number;
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
  let limit: "turns" | "context" | "budget" | "turn" | undefined;
  let wrappingUp = false;
  let last: AssistantMessage | undefined;
  let lineStop: `line:${string}` | undefined;
  /**
   * A line's hook failed. A line that wanted a model call after the consortium turn ended has not failed:
   * the session stops with `turn` instead of with an error.
   */
  const lineFailed = (error: unknown): "turn" | "failed" => {
    if (o.turn?.ended !== undefined && isTurnEnded(error)) {
      limit = "turn";
      return "turn";
    }
    failure = messageOf(error);
    return "failed";
  };
  let requests = 0;
  let retries = 0;
  let declared: string | undefined;
  // The prefix of the context packet, frozen at the session's first request that answers one.
  let frozen: FrozenState | undefined;
  // In `append_only`: the message the first compiled packet made, and how many of the history's messages it stands for.
  let opening: { message: AgentMessage; replaces: number } | undefined;
  const mode = o.packetMode ?? "prefix_tail";

  const leanCheck: AgentTool<ReturnType<typeof checkParameters>, { summary: string }> = {
    name: "lean_check",
    label: "Lean check",
    description:
      "Puts the two regions in the file and checks the whole file with Lean. Returns Lean's errors, the goal at each " +
      "sorry and other messages, located by region and line. A file without sorry that Lean accepts, with the standard " +
      "axioms and the original statement, is accepted: the theorem is proved.",
    parameters: checkParameters(o.strategies ?? []),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const strategy = "strategy" in params && typeof params.strategy === "string" ? params.strategy : undefined;
      const refused = o.veto?.({ aux: params.aux, proof: params.proof, ...(strategy !== undefined ? { strategy } : {}) });
      if (refused !== undefined) {
        return { content: [{ type: "text", text: `Not checked (the team): ${refused}` }], details: { summary: "rejected by the team" }, isError: true };
      }
      if (o.lines?.beforeCheck !== undefined) {
        try {
          const veto = await o.lines.beforeCheck({ aux: params.aux, proof: params.proof, ...(strategy !== undefined ? { strategy } : {}) });
          // A rejected call is no check: Lean is not run, nothing is counted or recorded.
          if (veto !== undefined) {
            return {
              content: [{ type: "text", text: `Not checked (line ${veto.line}): ${veto.reason}` }],
              details: { summary: `rejected by line ${veto.line}` },
              isError: true,
            };
          }
        } catch (error) {
          // A line that fails here ends the session with an error, not the check.
          if (lineFailed(error) === "turn") {
            return { content: [{ type: "text", text: "Not checked: the turn is over. The session ends here." }], details: { summary: "turn over" }, isError: true, terminate: true };
          }
          return {
            content: [{ type: "text", text: "The harness failed while guarding this check. The session ends here." }],
            details: { summary: "harness failure" },
            isError: true,
            terminate: true,
          };
        }
      }
      submissions += 1;
      submission = { aux: params.aux, proof: params.proof };
      if (strategy !== undefined) declared = strategy;
      try {
        const result = await o.workbench.check(submission, { attemptId: o.attemptId, actor: o.actor, ...(signal ? { signal } : {}), ...(o.checkTimeoutSec !== undefined ? { timeoutSec: o.checkTimeoutSec } : {}) });
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
              ...(strategy !== undefined ? { strategy } : {}),
              report,
              ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
              accepted: result.accepted,
            });
            if (stop !== undefined) lineStop = `line:${stop.line}`;
          } catch (error) {
            lineFailed(error);
          }
        }
        return {
          content: [{ type: "text", text: formatCheck(report) }],
          details: { summary: summarizeCheck(report) },
          ...(result.accepted || failure !== undefined || lineStop !== undefined || limit === "turn" ? { terminate: true } : {}),
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
  const cacheRetention = o.cacheRetention;
  const temperature = o.temperature;
  const rebuild = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    requests += 1;
    // `append_only`: after the first compiled packet the history is the session's own, never rewritten, so that each
    // request starts with every byte of the one before it (documentation/lines.md, "Packet modes").
    if (opening !== undefined) return [...messages.filter((m) => m.role === "system"), opening.message, ...messages.slice(opening.replaces)];
    try {
      const answer = packet === undefined ? undefined : await packet(requests, messages, frozen?.prefix);
      if (answer === undefined) return messages;
      const system = messages.filter((m) => m.role === "system");
      const team = (o.teamSections ?? []).map((section) => `\n\n# ${section.title}\n${section.text}`).join("");
      let built: AgentMessage;
      if (typeof answer === "string") built = { role: "user", content: `${answer}${team}`, timestamp: Date.now() };
      else {
        const composed = composePacket(answer, mode === "recompiled" ? undefined : frozen);
        if (mode !== "recompiled") frozen = composed.state;
        const { prefix } = composed.texts;
        const tail = `${composed.texts.tail}${composed.texts.tail === "" ? team.replace(/^\n\n/, "") : team}`;
        // Providers refuse an empty text block: an empty prefix or tail is left out.
        const content = [prefix, tail].filter((text) => text !== "").map((text) => ({ type: "text" as const, text }));
        built = { role: "user", content: content.length > 0 ? content : "", timestamp: Date.now() };
      }
      if (mode === "append_only") {
        // The packet stands for the opening prompt, the history's first user message; what follows it is kept as it comes.
        const first = messages.findIndex((m) => m.role === "user");
        opening = { message: built, replaces: first < 0 ? messages.length : first + 1 };
        return [...system, built, ...messages.slice(opening.replaces)];
      }
      return [...system, built];
    } catch (error) {
      lineFailed(error);
      agent.abort();
      return messages;
    }
  };
  const agent = new Agent({
    initialState: { systemPrompt: o.systemPrompt, model: o.model, thinkingLevel: o.thinkingLevel, tools: [leanCheck, ...(o.tools ?? [])] },
    // The one place where a request is sent: the consortium turn is read here, immediately before the send, so that no
    // request goes out after the limit however the provers and lines interleave (documentation/human.md, "Turns"). A refused
    // request draws and records nothing; the sampled settings (the temperature) and the cache policy go with a request that is sent.
    // A response that a transient error cut (the stream cut, a reset connection, a 5xx, a 429) is asked again with the
    // same context, so that the provider's cache still answers, after a wait; never once the turn is over, the problem
    // stopped or the budget spent, and the turn gate is read again immediately before each send. The cut response is
    // charged as its request is sent again (documentation/m0-loop.md, "Transient errors").
    streamFn: (model, context, options) => {
      const over = o.turn?.ended;
      if (over !== undefined) return refusedStream(model, `the turn is over (${over.detail}): the request was not sent`);
      const sent = cacheRetention === undefined && temperature === undefined
        ? options
        : { ...options, ...(cacheRetention !== undefined ? { cacheRetention } : {}), ...(temperature !== undefined ? { temperature } : {}) };
      return retryingStream({
        send: () => o.models.streamSimple(model, context, sent),
        policy: o.retry ?? REQUEST_RETRY,
        signal: options?.signal,
        // Asked before the wait, during it and after it: a stop, the turn's end or a spent budget ends the wait at once,
        // and the cut response is then the session's answer, charged as any answer.
        mayResend: (cut) => !o.signal.aborted && o.turn?.ended === undefined && !o.ledger.wouldExhaust(messageCost(o.model, cut, o.prices).usd),
        resend: (cut, retry) => {
          retries += 1;
          addCharge(messageCost(o.model, cut, o.prices), retry);
        },
      });
    },
    toolExecution: "sequential",
    sessionId: o.attemptId,
    // The context packet of a line (M4) replaces every message after the system messages, which
    // hold the system prompt and the tools: one message when the line answers a string, else the
    // prefix frozen at the first request and that request's tail, in one user message of two
    // texts, so that every request of the session starts with the same bytes. pi wants this hook
    // never to throw: a failure ends the session with an error, and the request is aborted.
    ...(packet !== undefined || o.rewriteHistory !== undefined
      ? {
          // Whatever rebuilds the history, the reasoning of the model's tool-call messages goes back with them
          // (documentation/lines.md, "The reasoning of a tool-call loop").
          transformContext: async (original: AgentMessage[]) => {
            const compiled = await rebuild(original);
            try {
              return keepReasoning(original, o.rewriteHistory === undefined ? compiled : await o.rewriteHistory(compiled));
            } catch (error) {
              lineFailed(error);
              agent.abort();
              return original;
            }
          },
        }
      : {}),
    beforeToolCall: async () =>
      wrappingUp ? { block: true, reason: "The session is over: write your notes as text, without calling a tool." } : undefined,
    finishTurn: () => {
      if (wrappingUp || accepted || failure !== undefined || lineStop !== undefined || o.signal.aborted) return { action: "end" };
      if (o.ledger.exhausted) limit = "budget";
      else if (o.turn?.ended !== undefined) limit = "turn";
      else if (turns >= o.limits.turns) limit = "turns";
      else if (last !== undefined && contextTokens(last) >= o.limits.contextTokens) limit = "context";
      return limit === undefined ? undefined : { action: "end" };
    },
  });
  agent.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    last = event.message;
    // A request the turn gate refused was never sent: no response, no charge, no zero-cost attempt record.
    if (refusedMessages.has(event.message)) return;
    turns += 1;
    addCharge(messageCost(o.model, event.message, o.prices));
  });
  /** Charges a response, an answer or a cut one, to the session, the ledger and the journal. */
  function addCharge(charge: TokenCost, retry?: RequestRetry): void {
    cost.usd += charge.usd;
    cost.inputTokens += charge.inputTokens;
    cost.outputTokens += charge.outputTokens;
    if (charge.cachedInputTokens !== undefined) cost.cachedInputTokens = (cost.cachedInputTokens ?? 0) + charge.cachedInputTokens;
    if (charge.savedUsd !== undefined) cost.savedUsd = (cost.savedUsd ?? 0) + charge.savedUsd;
    if (charge.offPeakUsd !== undefined) cost.offPeakUsd = (cost.offPeakUsd ?? 0) + charge.offPeakUsd;
    if (charge.unchargedUsd !== undefined) cost.unchargedUsd = (cost.unchargedUsd ?? 0) + charge.unchargedUsd;
    o.ledger.charge(charge);
    if (retry === undefined) o.onCharge?.(charge);
    else o.onCharge?.(charge, retry);
  }
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
      ...(declared !== undefined ? { declaredStrategy: declared } : {}),
      ...(retries > 0 ? { retries } : {}),
      messages: agent.state.messages,
      toolTokens: estimateTokens(JSON.stringify([leanCheck, ...(o.tools ?? [])].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))),
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

/** The arguments of `lean_check`: the two regions, and with labels from a line, the optional `strategy`. */
function checkParameters(strategies: readonly string[]) {
  const regions = {
    aux: Type.String({
      description: "The whole AUX region: auxiliary lemmas and definitions named aux_..., or an empty string.",
    }),
    proof: Type.String({
      description: "The whole PROOF region: the tactics that prove the theorem, without `by`. Use sorry for the parts not proved yet.",
    }),
  };
  return strategies.length === 0
    ? Type.Object(regions)
    : Type.Object({
        ...regions,
        strategy: Type.Optional(
          StringEnum(strategies, {
            description: "Optional: the technique this proof rests on. It is recorded with the attempt, beside the label computed from the proof text.",
          }),
        ),
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

/** The answer to a request that was not sent: an aborted response with no content, which the session reads as the turn's end. */
const refusedMessages = new WeakSet<object>();

function refusedStream(model: Model<Api>, reason: string): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted",
    errorMessage: reason,
    timestamp: Date.now(),
  };
  refusedMessages.add(message);
  stream.push({ type: "error", reason: "aborted", error: message });
  stream.end(message);
  return stream;
}
