import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import {
  BlobStore,
  budgetClassOf,
  CONSOLIDATION_ACTOR,
  environmentOf,
  type HarnessEvent,
  type Json,
  Journal,
  loadMemoryChain,
  type MemoryChain,
  newId,
  type ProvenanceContext,
  readEvents,
} from "@seshat/core";
import { applyFlag, applyMerge, type FlagPlan, type MergePlan, planFlags, planMerges } from "@seshat/lessons";
import { MemoryStore, renderStateCard, type StateCardData, stateCardData } from "@seshat/memory";
import { Ledger } from "./budget.ts";
import { estimateCallUsd, injectedPart, listEvents, PAGE_SYSTEM, PAGE_MAX_TOKENS, pageCall, pagePrompt, parsePage, type PageSentence, storedPage, SITE_CONSOLIDATION_PAGE } from "./consolidation-page.ts";
import type { PriceBook } from "./prices.ts";
import { RunSetupError, resolveModel } from "./run.ts";

/**
 * The consolidation pass between runs (plan change CA24, documentation/consolidation.md). It looks backward over a finished or paused run
 * and records, in a new run started on it by the memory chain, what a later run should know. The earlier run is opened for reading only.
 */

export const CARD_KIND = "consolidation_card";
export const PAGE_KIND = "consolidation_page";
export const PASS_KIND = "consolidation_pass";
export const LESSON_NOTE_KIND = "consolidation_lesson";

/** A problem of the chain: its claim is what the pass works on. */
export interface ChainProblem {
  problemId: string;
  claimId: string;
  target: string;
}

/** The problems the events register, one for each claim (the latest problem that names it). */
export function chainProblems(events: Iterable<HarnessEvent>): ChainProblem[] {
  const byClaim = new Map<string, ChainProblem>();
  for (const e of events) if (e.type === "problem.registered") byClaim.set(e.data.claimId, { problemId: e.data.problemId, claimId: e.data.claimId, target: e.data.target });
  return [...byClaim.values()];
}

export interface CardEntry {
  problem: ChainProblem;
  data: StateCardData;
  text: string;
}

export interface ModelFreePart {
  /** The open problems with at least one attempt. */
  cards: CardEntry[];
  /** The problems left out: settled by Lean (`proved`, `refuted`), or with no attempt. */
  left: Array<{ problem: ChainProblem; why: string }>;
  merges: MergePlan[];
  flags: FlagPlan[];
}

/**
 * What the pass computes without a model, and reads only: the state card of each problem that is not settled and has an attempt (over every
 * run of the chain), the duplicate lessons to merge and the lessons whose support the journal does not back. Nothing is written.
 */
export function modelFreePart(memory: MemoryStore, problems: readonly ChainProblem[]): ModelFreePart {
  const cards: CardEntry[] = [];
  const left: ModelFreePart["left"] = [];
  for (const problem of problems) {
    const claim = memory.claim(problem.claimId);
    if (claim === undefined) left.push({ problem, why: "its claim is not in the chain" });
    else if (claim.status === "proved" || claim.status === "refuted") left.push({ problem, why: `settled: ${claim.status}` });
    else if (memory.attempts(problem.claimId).length === 0) left.push({ problem, why: "no attempt" });
    else {
      const data = stateCardData(memory, problem.claimId, { acrossRuns: true }) as StateCardData;
      cards.push({ problem, data, text: renderStateCard(data) });
    }
  }
  return { cards, left, merges: planMerges(memory), flags: planFlags(memory) };
}

export interface ConsolidateOptions {
  /** The earlier run's directory: read, never written. */
  from: string;
  /** The new run's directory; a pass that was cut is run again on the same one. */
  out: string;
  /** `PROVIDER/ID`: without it the pass makes no model call. */
  model?: string;
  /** The most the pass may spend on model calls, in dollars, over all its runs on this directory. Required with a model. */
  maxUsd?: number;
  models?: Models;
  prices?: PriceBook;
  thinkingLevel?: ThinkingLevel;
  codeRev?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ConsolidationResult {
  runId: string;
  dir: string;
  /** True when the pass had already ended: nothing was written. */
  alreadyDone: boolean;
  cards: number;
  pages: number;
  calls: number;
  skippedForBudget: number;
  merged: number;
  flagged: number;
  usd: number;
  report: string;
}

/** The default directory of the pass's run: beside the earlier run. */
export function consolidationDirOf(runDir: string): string {
  const full = resolve(runDir);
  return join(dirname(full), `${basename(full)}.consolidation`);
}

function object(data: Json | undefined): Record<string, Json> {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, Json>) : {};
}

/** The pass's own records in the events of its journal, by kind. */
function ownNodes(events: readonly HarnessEvent[], kind: string): Array<{ nodeId: string; claimId?: string; data: Record<string, Json> }> {
  return events.flatMap((e) => (e.type === "node.recorded" && e.data.kind === kind ? [{ nodeId: e.data.nodeId, ...(e.data.claimId !== undefined ? { claimId: e.data.claimId } : {}), data: object(e.data.data) }] : []));
}

export async function consolidate(o: ConsolidateOptions): Promise<ConsolidationResult> {
  const log = o.log ?? (() => {});
  const from = resolve(o.from);
  const out = resolve(o.out);
  if (resolve(from) === out) throw new RunSetupError("the pass writes a new run: --out must not be the earlier run's directory");
  if (o.model !== undefined && (o.maxUsd === undefined || !(o.maxUsd >= 0))) throw new RunSetupError("--model needs --max-usd X: the pass spends nothing without a cap");
  if (o.model !== undefined && o.models === undefined) throw new RunSetupError("no models to call");
  const journalPath = join(out, "journal.jsonl");
  const rerun = existsSync(journalPath) && readEvents(journalPath).length > 0;
  let chain: MemoryChain;
  let runId: string;
  let journal: Journal;
  if (rerun) {
    const first = readEvents(journalPath)[0];
    if (first?.type !== "run.started" || first.data.memoryFrom === undefined || resolve(first.data.memoryFrom.path) !== from) {
      throw new RunSetupError(`${out} holds a run that was not started on ${from}: choose another --out`);
    }
    runId = first.data.runId;
    try {
      journal = Journal.open(out, runId);
    } catch (error) {
      throw new RunSetupError(`the pass in ${out} cannot be opened again: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    chain = journal.chain as MemoryChain;
  } else {
    const earlier = readEarlier(from);
    try {
      chain = loadMemoryChain(from, environmentOf(earlier.config));
    } catch (error) {
      throw new RunSetupError(`the memory of ${from} cannot be used: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    runId = newId("run");
    mkdirSync(out, { recursive: true });
    journal = Journal.open(out, runId, { memory: chain });
    const config = earlier.config as Record<string, Json>;
    // The pass is not a prover run: it records the earlier run's model, prompt, bench and environment, so that a later run's epochs compare with those.
    journal.emit(
      "run.started",
      {
        runId,
        benchId: earlier.benchId,
        problems: 0,
        host: earlier.host,
        config: {
          ...(config.model !== undefined ? { model: config.model } : {}),
          ...(config.prompt !== undefined ? { prompt: config.prompt } : {}),
          ...(config.bench !== undefined ? { bench: config.bench } : {}),
          ...(config.leanEnv !== undefined ? { leanEnv: config.leanEnv } : {}),
          consolidation: { model: o.model ?? null, maxUsd: o.maxUsd ?? null },
        },
        ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}),
        memoryFrom: { ...chain.from, relative: relative(out, chain.from.path) },
      },
      "orchestrator",
    );
  }
  try {
    return await work({ ...o, from, out }, journal, chain, runId, log);
  } finally {
    journal.close();
  }
}

function readEarlier(from: string): { benchId: string; host: string; config: Json } {
  const path = join(from, "journal.jsonl");
  if (!existsSync(path)) throw new RunSetupError(`${from} holds no run: it has no journal.jsonl`);
  const first = readEvents(path)[0];
  if (first?.type !== "run.started") throw new RunSetupError(`the journal of ${from} has no run.started`);
  return { benchId: first.data.benchId, host: first.data.host, config: first.data.config };
}

async function work(o: ConsolidateOptions & { from: string; out: string }, journal: Journal, chain: MemoryChain, runId: string, log: (line: string) => void): Promise<ConsolidationResult> {
  const started = readEvents(join(o.out, "journal.jsonl"));
  const config = object((started[0] as Extract<HarnessEvent, { type: "run.started" }>).data.config);
  const context: ProvenanceContext = {
    modelId: o.model ?? (typeof config.model === "string" ? config.model : "none"),
    promptVersion: typeof object(config.prompt).version === "string" ? (object(config.prompt).version as string) : "unknown",
    mathlibRev: typeof object(object(config.bench).source).rev === "string" ? (object(object(config.bench).source).rev as string) : "unknown",
    harnessVersion: o.codeRev ?? "unknown",
    budgetClass: budgetClassOf(o.maxUsd),
  };
  const blobs = new BlobStore(join(o.out, "blobs"), journal.chain?.blobDirs ?? []);
  const store = new MemoryStore({ journal, blobs, provenance: context, actor: CONSOLIDATION_ACTOR });
  const hadFinished = started.some((e) => e.type === "run.finished");
  const events = (): HarnessEvent[] => readEvents(join(o.out, "journal.jsonl"));
  const allEvents = chain.segments.flatMap((s) => s.events);
  const problems = chainProblems(allEvents);
  const part = modelFreePart(store, problems);
  log(`consolidation: ${problems.length} problem(s) in the chain, ${part.cards.length} open with an attempt, ${part.merges.length} group(s) of duplicate lessons, ${part.flags.length} lesson(s) flagged`);

  // The model-free part. Each record is written once: a pass run again skips what its own journal holds.
  const haveCard = new Set(ownNodes(events(), CARD_KIND).map((n) => n.claimId));
  for (const card of part.cards) {
    if (haveCard.has(card.problem.claimId)) continue;
    store.recordNode({
      kind: CARD_KIND,
      claimId: card.problem.claimId,
      data: { passId: runId, problemId: card.problem.problemId, target: card.problem.target, card: card.data as unknown as Json, text: card.text },
      learned: true,
    });
  }
  const merged = new Set(ownNodes(events(), LESSON_NOTE_KIND).filter((n) => n.data.action === "merged").map((n) => n.data.keep));
  for (const plan of part.merges) {
    if (merged.has(plan.keep)) continue;
    store.recordNode({ kind: LESSON_NOTE_KIND, data: { passId: runId, action: "merged", keep: plan.keep, merged: plan.merged, support: plan.support.length, useful: plan.useful, harmful: plan.harmful } });
    applyMerge(store, plan);
  }
  const flagged = new Set(ownNodes(events(), LESSON_NOTE_KIND).filter((n) => n.data.action === "flagged").map((n) => n.data.lessonId));
  for (const plan of part.flags) {
    if (flagged.has(plan.lessonId)) continue;
    store.recordNode({ kind: LESSON_NOTE_KIND, data: { passId: runId, action: "flagged", lessonId: plan.lessonId, reason: plan.reason, missing: plan.missing, retracted: plan.retracted, total: plan.total } });
    applyFlag(store, plan);
  }

  // The pages: at most one model call for each open problem, priced before it is sent, under the cap.
  if (o.model !== undefined) await pages(o, journal, store, blobs, part.cards, allEvents, runId, chain, events, log);
  else for (const card of part.cards) recordPass(store, runId, card.problem, { status: "no_model", reason: "no --model: the model-free part only" }, events());

  const finishedAt = events();
  const spent = finishedAt.filter((e) => e.type === "model_call.finished" && e.data.site === SITE_CONSOLIDATION_PAGE).reduce((n, e) => n + (e.type === "model_call.finished" ? e.data.usd : 0), 0);
  // A pass run again on a directory it already ended appends only what is new: its records and, when it has nothing to do, nothing at all.
  if (!hadFinished) journal.emit("run.finished", { runId, attempted: 0, solved: 0, candidates: 0, usd: spent }, "orchestrator");
  const result = summary(runId, o.out, store, readEvents(join(o.out, "journal.jsonl")), hadFinished && finishedAt.length === started.length);
  return result;
}

function recordPass(store: MemoryStore, runId: string, problem: ChainProblem, data: Record<string, Json>, events: readonly HarnessEvent[]): void {
  // A `no_model` record is not repeated by a pass run again without a model.
  if (data.status === "no_model" && ownNodes(events, PASS_KIND).some((n) => n.claimId === problem.claimId && n.data.status === "no_model")) return;
  store.recordNode({ kind: PASS_KIND, claimId: problem.claimId, data: { passId: runId, problemId: problem.problemId, target: problem.target, ...data } });
}

async function pages(
  o: ConsolidateOptions & { from: string; out: string },
  journal: Journal,
  store: MemoryStore,
  blobs: BlobStore,
  cards: readonly CardEntry[],
  allEvents: readonly HarnessEvent[],
  runId: string,
  chain: MemoryChain,
  events: () => HarnessEvent[],
  log: (line: string) => void,
): Promise<void> {
  const name = o.model as string;
  const models = o.models as Models;
  const model = await resolveModel(models, name);
  const ledger = new Ledger(o.maxUsd);
  // What earlier runs of the pass on this directory spent counts against the cap: nothing is paid twice.
  const before = events();
  const spentBefore = before.filter((e) => e.type === "model_call.finished" && e.data.site === SITE_CONSOLIDATION_PAGE).reduce((n, e) => n + (e.type === "model_call.finished" ? e.data.usd : 0), 0);
  ledger.seed({ usd: spentBefore, inputTokens: 0, outputTokens: 0, requests: 0 });
  const done = new Set(ownNodes(before, PASS_KIND).filter((n) => n.data.status === "page" || n.data.status === "no_page").map((n) => n.claimId));
  for (const card of cards) {
    const { problem } = card;
    if (done.has(problem.claimId)) continue;
    if (o.signal?.aborted) break;
    const listed = listEvents(chain.segments, problem.claimId);
    const prompt = pagePrompt(card.text, listed);
    const estimate = estimateCallUsd(model, o.prices, { system: PAGE_SYSTEM, prompt }, PAGE_MAX_TOKENS);
    const requestHash = blobs.putJson({ model: name, system: PAGE_SYSTEM, prompt, maxTokens: PAGE_MAX_TOKENS });
    const held = events().some((e) => e.type === "model_call.finished" && e.data.requestHash === requestHash && e.data.outcome === "ok");
    if (!held && ledger.wouldExhaust(estimate)) {
      recordPass(store, runId, problem, { status: "skipped_budget", reason: `the call is priced at $${estimate.toFixed(4)} and would pass the cap of $${o.maxUsd}`, estimateUsd: estimate }, events());
      log(`consolidation: ${problem.target}: skipped for budget (estimate $${estimate.toFixed(4)})`);
      continue;
    }
    let result;
    try {
      result = await pageCall({ journal, blobs, models, model, name, thinkingLevel: o.thinkingLevel ?? "off", prices: o.prices, signal: o.signal, held: events(), system: PAGE_SYSTEM, prompt });
    } catch (error) {
      recordPass(store, runId, problem, { status: "failed", reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }, events());
      log(`consolidation: ${problem.target}: the model call failed`);
      continue;
    }
    ledger.charge({ usd: result.usd, inputTokens: 0, outputTokens: 0 });
    const { kept, dropped } = parsePage(result.text, new Set(listed.map((l) => l.id)));
    if (kept.length === 0) {
      recordPass(store, runId, problem, { status: "no_page", reason: "no sentence cited the events it was given", kept: 0, dropped: dropped as unknown as Json, usd: result.usd, modelCallId: result.modelCallId }, events());
      log(`consolidation: ${problem.target}: no sentence kept (${dropped.total} dropped)`);
      continue;
    }
    const older = store.nodes(PAGE_KIND, { claimId: problem.claimId }).at(-1);
    const page = store.recordNode({
      kind: PAGE_KIND,
      claimId: problem.claimId,
      data: {
        passId: runId,
        problemId: problem.problemId,
        target: problem.target,
        text: storedPage(kept),
        sentences: kept as unknown as Json,
        dropped: dropped as unknown as Json,
        modelCallId: result.modelCallId,
        usd: result.usd,
        active: true,
        ...(older !== undefined ? { supersedes: older.nodeId } : {}),
      },
      learned: true,
    });
    recordPass(store, runId, problem, { status: "page", pageId: page.nodeId, kept: kept.length, dropped: dropped as unknown as Json, usd: result.usd, modelCallId: result.modelCallId }, events());
    log(`consolidation: ${problem.target}: page of ${kept.length} sentence(s), ${dropped.total} dropped`);
  }
}

/** The newest page of a claim in a memory, whether or not it has been switched off, as the reader sees it. */
export function newestPage(store: MemoryStore, claimId: string): { nodeId: string; sentences: PageSentence[]; active: boolean; text: string } | undefined {
  const node = store.nodes(PAGE_KIND, { claimId }).at(-1);
  if (node === undefined) return undefined;
  const d = object(node.data);
  const sentences = Array.isArray(d.sentences)
    ? d.sentences.flatMap((s): PageSentence[] => {
        const x = object(s);
        return typeof x.text === "string" && Array.isArray(x.cites) ? [{ text: x.text, cites: x.cites.filter((c): c is string => typeof c === "string") }] : [];
      })
    : [];
  return { nodeId: node.nodeId, sentences, active: d.active !== false, text: typeof d.text === "string" ? d.text : "" };
}

export { injectedPart };

function summary(runId: string, dir: string, store: MemoryStore, events: readonly HarnessEvent[], alreadyDone: boolean): ConsolidationResult {
  const report = renderConsolidationReport(events, runId);
  writeFileSync(join(dir, "consolidation.md"), report);
  const passes = ownNodes(events, PASS_KIND);
  const calls = events.filter((e) => e.type === "model_call.finished" && e.data.site === SITE_CONSOLIDATION_PAGE);
  void store;
  return {
    runId,
    dir,
    alreadyDone,
    cards: ownNodes(events, CARD_KIND).length,
    pages: ownNodes(events, PAGE_KIND).length,
    calls: calls.length,
    skippedForBudget: [...new Set(passes.map((p) => p.claimId))].filter((c) => passes.filter((p) => p.claimId === c).at(-1)?.data.status === "skipped_budget").length,
    merged: ownNodes(events, LESSON_NOTE_KIND).filter((n) => n.data.action === "merged").reduce((n, x) => n + (Array.isArray(x.data.merged) ? x.data.merged.length : 0), 0),
    flagged: ownNodes(events, LESSON_NOTE_KIND).filter((n) => n.data.action === "flagged").length,
    usd: calls.reduce((n, e) => n + (e.type === "model_call.finished" ? e.data.usd : 0), 0),
    report: join(dir, "consolidation.md"),
  };
}

/** The Markdown report of a pass, built from its journal: per problem the card, the page with its kept and dropped sentences, the cost; the merged and flagged lessons. */
export function renderConsolidationReport(events: readonly HarnessEvent[], runId: string): string {
  const cards = ownNodes(events, CARD_KIND);
  const passes = ownNodes(events, PASS_KIND);
  const pages = ownNodes(events, PAGE_KIND);
  const notes = ownNodes(events, LESSON_NOTE_KIND);
  const calls = events.flatMap((e) => (e.type === "model_call.finished" && e.data.site === SITE_CONSOLIDATION_PAGE ? [e.data] : []));
  const lines = [`# Consolidation pass ${runId}`, "", "Written from the journal of the pass. Everything below is unverified: Lean is the judge, and nothing here changes a claim's status.", ""];
  lines.push(`${cards.length} open problem(s) with a card; ${pages.length} page(s); ${calls.length} model call(s), $${calls.reduce((n, c) => n + c.usd, 0).toFixed(4)}.`, "");
  for (const card of cards) {
    const d = card.data;
    lines.push(`## ${String(d.target)}`, "", `Problem \`${String(d.problemId)}\`, claim \`${card.claimId ?? ""}\`.`, "", "```", String(d.text), "```", "");
    const pass = passes.filter((p) => p.claimId === card.claimId).at(-1);
    const page = pages.filter((p) => p.claimId === card.claimId).at(-1);
    if (pass === undefined) lines.push("No page step was recorded.", "");
    else if (pass.data.status === "page" && page !== undefined) {
      const dr = object(pass.data.dropped as Json);
      lines.push(`Page (${String(pass.data.kept)} sentence(s) kept, ${String(dr.total ?? 0)} dropped: ${String(dr.uncited ?? 0)} without a citation, ${String(dr.unknownEvent ?? 0)} citing an event that is not in the problem's list, ${String(dr.screened ?? 0)} refused by the prose screen, ${String(dr.size ?? 0)} over the size cap; $${Number(pass.data.usd ?? 0).toFixed(4)}):`, "", `> ${String(page.data.text)}`, "");
    } else lines.push(`No page: ${String(pass.data.status)}${typeof pass.data.reason === "string" ? ` (${pass.data.reason})` : ""}.`, "");
  }
  lines.push("## Lessons", "");
  const merged = notes.filter((n) => n.data.action === "merged");
  const flagged = notes.filter((n) => n.data.action === "flagged");
  if (merged.length === 0 && flagged.length === 0) lines.push("No lesson was merged or flagged.");
  for (const m of merged) lines.push(`- Merged: ${(m.data.merged as string[]).map((x) => `\`${x}\``).join(", ")} into \`${String(m.data.keep)}\` (counters ${String(m.data.useful)} useful, ${String(m.data.harmful)} harmful).`);
  for (const f of flagged) lines.push(`- Flagged: \`${String(f.data.lessonId)}\`, ${String(f.data.reason)}. It waits for a person (harness lessons pending).`);
  return `${lines.join("\n")}\n`;
}


/** The model-free part as a section of a turn's report: read-only, no model call, nothing written. The page needs `harness consolidate`. */
export function renderModelFreeSection(part: ModelFreePart): string {
  const lines = ["The model-free part of the consolidation pass (documentation/consolidation.md), computed from the journal when the turn ended. No model was called and nothing was written; the page \"what was tried and why it stopped\" needs `harness consolidate RUN_DIR --model PROVIDER/ID --max-usd X`.", ""];
  if (part.cards.length === 0) lines.push("No open problem has an attempt yet.", "");
  for (const card of part.cards) lines.push(`### ${card.problem.target}`, "", "```", card.text, "```", "");
  lines.push(`Lessons: ${part.merges.length} group(s) of duplicates would be merged${part.merges.length > 0 ? ` (${part.merges.map((m) => `${m.merged.length + 1} into \`${m.keep}\``).join(", ")})` : ""}; ${part.flags.length} would be flagged as unsupported${part.flags.length > 0 ? ` (${part.flags.map((f) => `\`${f.lessonId}\`: ${f.reason}`).join("; ")})` : ""}.`);
  return lines.join("\n");
}
