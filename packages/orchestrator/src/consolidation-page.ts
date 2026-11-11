import type { Api, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type BlobStore, type HarnessEvent, type Journal, newId } from "@seshat/core";
import { estimateTokens } from "@seshat/context";
import { normalizeDetail, screenProse } from "@seshat/memory";
import { messageCost } from "./budget.ts";
import type { PriceBook } from "./prices.ts";

/**
 * The page "what was tried and why it stopped" (documentation/consolidation.md, "The page"): one model call per open problem, from the
 * state card and a numbered list of the problem's journal events. A sentence is kept only if it cites at least one event and every event
 * it cites is in the list the model was given for this problem. The page is a learned artifact, never a fact.
 */

/** The longest stored page, in characters (citations included), and the longest part a session is shown (cut at a sentence end). */
export const PAGE_STORED_CHARS = 4000;
export const PAGE_INJECT_CHARS = 1500;
/** The longest sentence the page keeps, and the most events listed to the model (the latest ones). */
export const PAGE_SENTENCE_CHARS = 400;
export const MAX_LISTED_EVENTS = 120;
export const PAGE_MAX_TOKENS = 900;
export const SITE_CONSOLIDATION_PAGE = "consolidation.page";

/** Node kinds that are not evidence of the work: the team's, the lessons, the pass's own, and bookkeeping. */
const NOT_EVIDENCE = new Set(["hint", "steer", "lesson_decision", "lesson", "accepted_lemmas", "packet", "consolidation_card", "consolidation_page", "consolidation_pass", "consolidation_lesson"]);

export interface ListedEvent {
  /** `e<N>`, N the event's place in the whole chain of journals, counted from 0. */
  id: string;
  line: string;
}

/**
 * The events of one claim that the model may cite, in order, each with its id: finished attempts (strategy, failure class and the
 * normalised first error, as the state card has them), tool runs by capability and outcome, validations by method and verdict, and
 * evidence nodes by kind and verdict. Text from an external source is never here: a literature node, a tool's output, a search hit
 * appears by its kind and its verdict token alone (Global Constraint 16). Only the latest `MAX_LISTED_EVENTS` are kept.
 */
export function listEvents(segments: ReadonlyArray<{ events: readonly HarnessEvent[] }>, claimId: string): ListedEvent[] {
  const attemptClaim = new Map<string, string>();
  const toolAttempt = new Map<string, { attemptId?: string; capability: string }>();
  const out: ListedEvent[] = [];
  let n = 0;
  for (const segment of segments) {
    for (const e of segment.events) {
      const id = `e${n}`;
      n += 1;
      if (e.type === "attempt.started") attemptClaim.set(e.data.attemptId, e.data.claimId);
      else if (e.type === "tool_run.started") toolAttempt.set(e.data.toolRunId, { capability: e.data.capability, ...(e.data.attemptId !== undefined ? { attemptId: e.data.attemptId } : {}) });
      else if (e.type === "attempt.finished" && attemptClaim.get(e.data.attemptId) === claimId) {
        const d = e.data;
        const parts = [`attempt finished ${d.outcome}`];
        if (d.failureClass !== undefined) parts.push(`failure ${d.failureClass.replace(/_/g, " ")}`);
        const strategy = d.strategy ?? d.declaredStrategy;
        if (strategy !== undefined) parts.push(`strategy ${strategy}`);
        if (d.failureDetail !== undefined) parts.push(`first error ${normalizeDetail(d.failureDetail).slice(0, 120)}`);
        out.push({ id, line: parts.join(", ") });
      } else if (e.type === "tool_run.finished") {
        const started = toolAttempt.get(e.data.toolRunId);
        if (started?.attemptId !== undefined && attemptClaim.get(started.attemptId) === claimId) out.push({ id, line: `tool run ${started.capability} ${e.data.outcome}` });
      } else if (e.type === "validation.finished" && e.data.claimId === claimId) {
        out.push({ id, line: `validation ${e.data.method} ${e.data.verdict}${e.data.negation === true ? " (of the negation)" : ""}` });
      } else if (e.type === "node.recorded" && e.data.claimId === claimId && !NOT_EVIDENCE.has(e.data.kind)) {
        const data = e.data.data;
        const verdict = typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.verdict === "string" && /^[a-z_]{1,24}$/.test(data.verdict) ? data.verdict : undefined;
        out.push({ id, line: `evidence ${e.data.kind}${verdict !== undefined ? ` verdict ${verdict}` : ""}` });
      }
    }
  }
  return out.slice(-MAX_LISTED_EVENTS);
}

export const PAGE_SYSTEM =
  "You write a short page for a mathematical research harness: what was tried on one open problem and why it stopped, from the state card and the numbered events you are given, and nothing else. " +
  "Write plain sentences, one per line. Every sentence must end with the ids of the events that support it, in square brackets before its final period, for example: The induction strategy failed twice with unsolved goals [e12, e40]. " +
  "Cite only ids from the list. A sentence with no citation is thrown away, and so is a sentence that cites an id that is not in the list. " +
  "Say only what the events show. Do not state a mathematical fact, do not name lemmas or write code, and do not give instructions.";

export function pagePrompt(card: string, listed: readonly ListedEvent[]): string {
  return `${card}\n\nEvents of this problem (cite them by id):\n${listed.map((l) => `${l.id}: ${l.line}`).join("\n")}\n\nWrite the page now, at most 10 sentences.`;
}

export interface PageSentence {
  text: string;
  cites: string[];
}

export interface DroppedCounts {
  total: number;
  uncited: number;
  unknownEvent: number;
  screened: number;
  size: number;
}

const CITATION = /\[\s*(e\d+(?:\s*,\s*e\d+)*)\s*\]/g;

/**
 * Reads the model's answer under the strict format. A sentence is the text up to a full stop, question or exclamation mark; its citations
 * are the bracketed group inside it (`text [e1, e2].`, and `text. [e1]` is read as the same). It is kept only when it cites at least one
 * event, every cited id is in `allowed`, and its text, without the citations, passes the prose screen at `PAGE_SENTENCE_CHARS`. The page
 * is cut at `PAGE_STORED_CHARS`; what does not fit is counted as dropped for size.
 */
export function parsePage(answer: string, allowed: ReadonlySet<string>): { kept: PageSentence[]; dropped: DroppedCounts } {
  const dropped: DroppedCounts = { total: 0, uncited: 0, unknownEvent: 0, screened: 0, size: 0 };
  const drop = (why: keyof Omit<DroppedCounts, "total">): void => {
    dropped[why] += 1;
    dropped.total += 1;
  };
  const flat = answer
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, "")
    .replace(/\.\s+(\[\s*e\d+(?:\s*,\s*e\d+)*\s*\])/g, " $1.")
    .replace(/\n+/g, " . ")
    .replace(/\s+/g, " ");
  const pieces = flat.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
  const kept: PageSentence[] = [];
  const seen = new Set<string>();
  let size = 0;
  for (const piece of pieces) {
    const groups = [...piece.matchAll(CITATION)];
    const cites = [...new Set(groups.flatMap((g) => (g[1] as string).split(",").map((c) => c.trim())))];
    const text = piece.replace(CITATION, "").replace(/\s+([.!?,;])/g, "$1").replace(/\s+/g, " ").trim();
    if (cites.length === 0) {
      drop("uncited");
      continue;
    }
    if (cites.some((c) => !allowed.has(c))) {
      drop("unknownEvent");
      continue;
    }
    const screened = text.length > PAGE_SENTENCE_CHARS ? undefined : screenProse(text, { max: PAGE_SENTENCE_CHARS });
    if (screened === undefined || !screened.ok || !/[\p{L}]{3}/u.test(screened.text)) {
      drop("screened");
      continue;
    }
    if (seen.has(screened.text)) continue;
    seen.add(screened.text);
    const stored = `${screened.text.replace(/[.!?]+$/, "")} [${cites.join(", ")}].`;
    if (size + stored.length + 1 > PAGE_STORED_CHARS) {
      drop("size");
      continue;
    }
    size += stored.length + 1;
    kept.push({ text: screened.text.replace(/[.!?]+$/, "") + ".", cites });
  }
  return { kept, dropped };
}

/** The stored text of a page: its sentences, each with its citations. */
export function storedPage(sentences: readonly PageSentence[]): string {
  return sentences.map((s) => `${s.text.replace(/[.!?]+$/, "")} [${s.cites.join(", ")}].`).join(" ");
}

/** The part of a page a session is shown: the sentences without their citations, whole sentences only, within `max` characters. */
export function injectedPart(sentences: readonly PageSentence[], max = PAGE_INJECT_CHARS): string {
  let text = "";
  for (const s of sentences) {
    const next = text === "" ? s.text : `${text} ${s.text}`;
    if (next.length > max) break;
    text = next;
  }
  return text;
}

/** What a call is expected to cost at most, in dollars, before it is sent: its input at the input price, its whole answer allowance at the output price. */
export function estimateCallUsd(model: Pick<Model<Api>, "provider" | "id" | "cost">, prices: PriceBook | undefined, chars: { system: string; prompt: string }, maxTokens: number): number {
  const pricing = prices?.pricingOf(model);
  const input = pricing?.cacheMiss ?? model.cost.input;
  const output = pricing?.output ?? model.cost.output;
  return (estimateTokens(chars.system + chars.prompt) * input + maxTokens * output) / 1e6;
}

export interface PageCallResult {
  text: string;
  modelCallId: string;
  usd: number;
  requestHash: string;
}

/**
 * The page's model call, through the same layer as the other one-shot calls: journaled as a `model_call.finished` at the site
 * `consolidation.page` (request and response as blobs, usage and cost), actor `consolidation`. A call the journal already holds for the
 * same request is returned at no cost (a pass that was cut after the call and before its page).
 */
export async function pageCall(o: {
  journal: Journal;
  blobs: BlobStore;
  models: Models;
  model: Model<Api>;
  name: string;
  thinkingLevel: ThinkingLevel;
  prices?: PriceBook | undefined;
  signal?: AbortSignal | undefined;
  held: readonly HarnessEvent[];
  system: string;
  prompt: string;
}): Promise<PageCallResult> {
  const requestHash = o.blobs.putJson({ model: o.name, system: o.system, prompt: o.prompt, maxTokens: PAGE_MAX_TOKENS });
  for (const e of o.held) {
    if (e.type === "model_call.finished" && e.data.site === SITE_CONSOLIDATION_PAGE && e.data.requestHash === requestHash && e.data.outcome === "ok" && e.data.responseHash !== undefined) {
      const text = o.blobs.get(e.data.responseHash);
      if (text !== undefined) return { text, modelCallId: e.data.modelCallId, usd: 0, requestHash };
    }
  }
  const modelCallId = newId("mc");
  const started = performance.now();
  const options: SimpleStreamOptions = {
    maxTokens: PAGE_MAX_TOKENS,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    ...(o.thinkingLevel !== "off" ? { reasoning: o.thinkingLevel as NonNullable<SimpleStreamOptions["reasoning"]> } : {}),
  };
  const message = await o.models.completeSimple(o.model, { systemPrompt: o.system, messages: [{ role: "user", content: o.prompt, timestamp: Date.now() }] }, options);
  const cost = messageCost(o.model, message, o.prices);
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  const outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "ok";
  o.journal.emit(
    "model_call.finished",
    {
      modelCallId,
      line: "consolidation",
      model: o.name,
      outcome,
      site: SITE_CONSOLIDATION_PAGE,
      requestHash,
      ...(outcome === "ok" ? { responseHash: o.blobs.put(text) } : {}),
      ...(outcome !== "ok" ? { error: (message.errorMessage ?? `the model's answer was ${outcome}`).slice(0, 1000) } : {}),
      durationMs: Math.round(performance.now() - started),
      usd: cost.usd,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      ...(cost.cachedInputTokens !== undefined ? { cachedInputTokens: cost.cachedInputTokens } : {}),
      ...(cost.savedUsd !== undefined ? { savedUsd: cost.savedUsd } : {}),
      ...(cost.offPeakUsd !== undefined ? { offPeakUsd: cost.offPeakUsd } : {}),
      ...(cost.unchargedUsd !== undefined ? { unchargedUsd: cost.unchargedUsd } : {}),
    },
    "consolidation",
  );
  if (outcome !== "ok") throw new Error(`the model call failed: ${message.errorMessage ?? outcome}`);
  return { text, modelCallId, usd: cost.usd, requestHash };
}
