import { configClassOf, readDeclarationHead, splitCommands, type ClaimStatus, type Json } from "@seshat/core";
import { describeTried } from "@seshat/classical";
import {
  type DeclarationExport,
  type ExportedDeclaration,
  declarationEntry,
  type Entry,
  importHeader,
  libraryEntry,
  localEntries,
  type Source,
  usableLemmas,
} from "@seshat/library";
import { allLessons, type LessonRecord, selectLessons } from "@seshat/lessons";
import {
  completeJson,
  isInterrupted,
  type FinishedAttempt,
  type FrozenPacket,
  LINE_TITLES,
  type Line,
  type LineTool,
  type PacketRequest,
  type ProblemContext,
  type SessionCheck,
  type SessionContext,
} from "@seshat/lines";
import { type MemoryStore, renderObstructions, renderTried, screenProse } from "@seshat/memory";
import { type Selector, SELECTORS, type DeclarationFlags, retrievePremises, type Premise } from "./premises.ts";
import { selectFacts, type Fact } from "./facts.ts";
import { CitableIds } from "./ids.ts";
import { type Rendering, RENDERINGS, renderPrefix, renderTail, type ShownEdge } from "./render.ts";
import { screenLean } from "./screen.ts";
import { type DependencyNeighbours } from "./seeds.ts";
import { type ProofExample } from "./selectors.ts";
import { estimateTokens } from "./tokens.ts";
import { expandTool, graphQueryTool, type ToolEnv } from "./tools.ts";

/** The draw items of M4: the library hint section (M3's own item, so its effect is one number) and the k-NN's suggestions. */
export const LIBRARY_ITEM = "library:section";
export const KNN_ITEM = "context:knn";

/** The node kind M4 records for each packet it compiles (`data`: `PacketRecord`). */
export const PACKET_KIND = "context_packet";

export interface PacketRecord {
  attemptId: string;
  naive: boolean;
  model: string;
  /** Tokens of the prefix and of the first request's tail, by the documented approximation. */
  prefixTokens: number;
  tailTokens: number;
  budget: number;
  /** The tokens the prefix could use (`tokens` times `prefixShare`), and whether the goal alone was above it. */
  prefixBudget: number;
  overBudget: boolean;
  /** What each section kept. */
  shown: { facts: number; edges: number; premises: number; tried: number; lessons: number; notes: number };
  /** The concept queries and names the extraction gave (empty without it). */
  queries: string[];
  names: string[];
  /** The draw's outcome for the unverified items. */
  included: string[];
  withheld: string[];
}

/** A declaration of the environment's export, with the flags the premise use is read from (`kind`: `def`, `theorem`...; `simp`). An `ExportedDeclaration` of the library's export is one. */
export type ContextDeclaration = ExportedDeclaration & DeclarationFlags;

/** What M4 is built with; each is replaceable and none is a model. */
export interface M4Deps {
  /** The export of the environment's declarations (LC2): the extra packages and Mathlib. Default: none, and the premises come from the file and the library. */
  declarations?: (env: Parameters<DeclarationExport>[0]) => Promise<readonly ContextDeclaration[]>;
  /** The dependency neighbours of a declaration, for the pattern seeds (`lean.meta premises`, TheoremGraph). Default: none. */
  neighbours?: DependencyNeighbours;
}

/** The options of M4 and their defaults (`--line-option M4.tokens=4000`). */
export const M4_OPTIONS = {
  /** The comparison arm: the same content without selection, order, ids or tools (plan §6). */
  naive: false,
  /** The packet's budget in tokens (documented approximation: 3.5 characters a token). */
  tokens: 6000,
  /** The share of the budget the prefix may take; the tail has the rest. */
  prefixShare: 0.8,
  /** The most candidate premises, and the channel that ranks them: `mepo`, `sine`, `bm25` or `hybrid`. */
  premises: 12,
  selector: "mepo",
  /** Weights of BM25, MePo and SInE for `hybrid`. */
  hybridWeights: [0.4, 0.3, 0.3] as number[],
  /** The least relevance (0 to 1) of a premise and of a fact: nothing under it goes in, even with room left. */
  premiseThreshold: 0.3,
  factThreshold: 0.2,
  /** The weight of the graph walk against symbol similarity when facts are ranked. */
  graphWeight: 0.5,
  maxFacts: 12,
  /** The statuses a fact may have. */
  factStatuses: ["proved", "computed"] as string[],
  /** The neighbourhood depth for the walk, and how far failed sessions widen it (one more after each). */
  baseDepth: 2,
  maxDepth: 5,
  /** The edges of the graph the packet shows: about 100 for a small model, 200 for a frontier model. The models listed in `strongModels` (`PROVIDER/ID`, or `PROVIDER/*`) get the second. */
  graphEdges: 100,
  graphEdgesStrong: 200,
  strongModels: [] as string[],
  /** How edges are written (`list`, `merged`, `table`), whether a claim's gloss and a fact's status badge are shown. */
  rendering: "list",
  gloss: true,
  badges: true,
  /** The most lessons offered (before the draw). */
  maxLessons: 3,
  /** The most lines of the "already tried" section. */
  maxTried: 12,
  /** One `completeJson` call a session turns the goal into concept queries and likely Lean names (PC5 item 1a). */
  extractQueries: true,
  maxQueries: 6,
  /** The pattern-seed channel (PC5 item 1c) and the online k-NN over our own proofs. */
  seeds: false,
  knn: true,
  knnK: 5,
  /** The accessibility filter (PC5 item 1b): a premise the header cannot see is left out. The roots the base environment always has. */
  accessibility: true,
  assumedImports: ["Mathlib"] as string[],
  /** With a number from 1, the tail lists up to that many facts learned since the session started. */
  newSince: 0,
  /** Offer `expand` and `graph_query`. */
  tools: true,
};

type Options = typeof M4_OPTIONS;

function optionsOf(raw: Readonly<Record<string, Json>>): Options {
  return { ...M4_OPTIONS, ...(raw as Partial<Options>) };
}

const selectorOf = (o: Options): Selector => ((SELECTORS as readonly string[]).includes(o.selector) ? (o.selector as Selector) : "mepo");
const renderingOf = (o: Options): Rendering => ((RENDERINGS as readonly string[]).includes(o.rendering) ? (o.rendering as Rendering) : "list");

/** Whether a model is in the list of strong ones: an exact `PROVIDER/ID`, or `PROVIDER/*`. */
export function isStrong(model: string, strong: readonly string[]): boolean {
  return strong.some((m) => (m.endsWith("*") ? model.startsWith(m.slice(0, -1)) : m === model));
}

/** Everything the compiler collected for one session in `beforeSession`, where the draw is made. */
interface Collected {
  queries: string[];
  names: string[];
  facts: Fact[];
  premises: Premise[];
  lessons: LessonRecord[];
  tiers: Partial<Record<Source, Entry[]>>;
  flags: Map<string, DeclarationFlags>;
}

interface Last {
  aux: string;
  proof: string;
  holes: string[] | undefined;
  feedback: string | undefined;
}

interface SessionState {
  collected: Collected;
  ids: CitableIds;
  entries: Map<string, Entry>;
  /** The prefix, compiled at the session's first request. */
  prefix?: string;
  last?: Last;
  /** The facts known when the prefix was compiled, for the `newSince` list. */
  started: boolean;
  /** The standing of each claim the prefix shows, when it froze, and the library lemmas it offers. */
  /** The packet's record, written with the first request once the tail's size is known. */
  record?: PacketRecord;
  frozen?: { claims: Map<string, string>; library: string[]; facts: string[] };
}

const sessionKey = (s: Pick<SessionContext, "attemptId">) => s.attemptId;
/** The node `afterAttempt` records so that the next session of a prover starts from the journal, not from this process (resume "stateless"). */
export const CARRY_KIND = "context_carry";
const CARRY_FEEDBACK_CHARS = 4000;

/** The raw feedback of a check for a model: the errors, the holes' goals and other messages, as Lean wrote them. */
export function rawFeedback(check: Pick<SessionCheck["report"], "verdict" | "messages" | "sorries" | "reasons">): string {
  const lines: string[] = [];
  if (check.verdict === "valid") return "Accepted: Lean checked the whole file with no error and no hole.";
  for (const r of check.reasons) lines.push(`- ${r}`);
  for (const m of check.messages) if (m.severity !== "trace") lines.push(`${m.severity} at line ${m.pos.line}: ${m.text.trim()}`);
  return lines.join("\n");
}

/** The titles of the briefing sections that M4 replaces with its own sections or that the harness adds to every packet. */
const OWN_SECTIONS = new Set(["Already tried", "Library", "Lessons", "Classical tools, tried before any model (line M10)", "Hints from the team", "What the team asks"]);

/**
 * The briefing sections of the other lines, taken from the opening message (the packet replaces it): `# Title` after the last check, and the
 * state card (`stateCard`, plan change CA7), which the opening message holds before the notes: a packet that dropped it would undo v2's card.
 */
export function otherLines(opening: string | undefined): Array<{ title: string; text: string }> {
  if (opening === undefined) return [];
  const card = /\n# Where the problem stands\n([\s\S]*?)\n\n# Your notes from the previous sessions/.exec(opening)?.[1];
  const own = card === undefined ? [] : [{ title: "Where the problem stands", text: card }];
  const marker = opening.indexOf("# What Lean said about the file as it is");
  if (marker < 0) return own;
  const parts = opening.slice(marker).split("\n\n# ").slice(1);
  return [
    ...own,
    ...parts.flatMap((p) => {
      const nl = p.indexOf("\n");
      const title = (nl < 0 ? p : p.slice(0, nl)).trim();
      return OWN_SECTIONS.has(title) || title === "" ? [] : [{ title, text: nl < 0 ? "" : p.slice(nl + 1) }];
    }),
  ];
}

function holesOf(report: SessionCheck["report"]): string[] {
  return report.sorries.map((s) => s.goal);
}

/** The text of the declaration `name` in a problem's file before its theorem. */
function localText(prefix: string, name: string): string | undefined {
  for (const c of splitCommands(prefix)) {
    if (c.kind !== "code") continue;
    if (readDeclarationHead(c.text)?.name === name) return c.text.trim();
  }
  return undefined;
}

function proofExamples(memory: MemoryStore, exclude: ReadonlySet<string>): ProofExample[] {
  const out: ProofExample[] = [];
  for (const claim of memory.claims({ statuses: ["proved", "computed"] })) {
    if (claim.kind !== "formal" || exclude.has(claim.claimId)) continue;
    const premises = [...new Set(memory.attempts(claim.claimId).filter((a) => a.outcome === "valid").flatMap((a) => a.premises ?? []))];
    if (premises.length > 0) out.push({ statement: claim.statement, premises });
  }
  return out;
}

/**
 * M4: the context compiler (documentation/context.md). Each request of a session gets a deterministic packet compiled from the
 * memory under a token budget, in place of the conversation: a prefix the session freezes (the goal, the useful facts, the
 * candidate premises, what was already tried, the lessons as drawn) and a tail for each request (the sketch's state, the last raw
 * Lean feedback, the budget left). Ids that resolve (`C17`, `L4`) and two prover tools, `expand` and `graph_query`, let the prover
 * load details just in time. Nothing in a packet is a fact except what Lean checked; what a model or another run wrote passes the
 * strict screen first.
 */
export function createM4(deps: M4Deps = {}): Line {
  const sessions = new Map<string, SessionState>();
  /** What the prover's previous session left, read from the journal: the same in a process that was cut and resumed as in one that was not. */
  function carryOf(session: Pick<SessionContext, "memory" | "claimId" | "prover">): Last | undefined {
    const nodes = session.memory.nodes(CARRY_KIND, { claimId: session.claimId }).filter((n) => (n.data as { prover?: unknown }).prover === session.prover);
    const data = nodes[nodes.length - 1]?.data as { aux?: unknown; proof?: unknown; holes?: unknown; feedback?: unknown } | undefined;
    if (data === undefined || typeof data.aux !== "string" || typeof data.proof !== "string") return undefined;
    return {
      aux: data.aux,
      proof: data.proof,
      holes: Array.isArray(data.holes) ? data.holes.filter((h): h is string => typeof h === "string") : undefined,
      feedback: typeof data.feedback === "string" ? data.feedback : undefined,
    };
  }
  const exported = new Map<string, Promise<{ entries: Entry[]; extra: Entry[]; mathlib: Entry[]; flags: Map<string, DeclarationFlags> }>>();

  async function declared(problem: ProblemContext): Promise<{ entries: Entry[]; extra: Entry[]; mathlib: Entry[]; flags: Map<string, DeclarationFlags> }> {
    const none = { entries: [] as Entry[], extra: [] as Entry[], mathlib: [] as Entry[], flags: new Map<string, DeclarationFlags>() };
    if (deps.declarations === undefined) return none;
    const env = problem.registry.leanEnv;
    const key = env?.hash ?? "none";
    let pending = exported.get(key);
    if (pending === undefined) {
      pending = Promise.resolve(deps.declarations(env)).then((all) => {
        const flags = new Map<string, DeclarationFlags>();
        const entries = all.map((d) => {
          const e = declarationEntry(d);
          flags.set(e.id, { ...(d.kind !== undefined ? { kind: d.kind } : {}), ...(d.simp !== undefined ? { simp: d.simp } : {}) });
          return e;
        });
        return { entries, extra: entries.filter((e) => e.source === "extra"), mathlib: entries.filter((e) => e.source === "mathlib"), flags };
      });
      exported.set(key, pending);
      pending.catch(() => exported.delete(key));
    }
    try {
      return await pending;
    } catch (error) {
      problem.log(`context: the declarations of the environment could not be exported: ${error instanceof Error ? error.message : String(error)}`);
      return none;
    }
  }

  /** The concept queries and likely Lean names for the goal (and, from the second session, the sketch). One model call; a failure leaves the statement alone. */
  async function extract(session: SessionContext, o: Options, sketch: Last | undefined): Promise<{ queries: string[]; names: string[] }> {
    try {
      const sketchText = sketch === undefined ? "" : `\n\nThe current sketch:\n${sketch.aux}\n${sketch.proof}`.slice(0, 2000);
      const answer = await completeJson<{ concepts: string[]; names: string[] }>(session.llm, {
        site: "context.queries",
        prompt:
          `Determine whether the following Lean 4 statement holds. To look for helpful lemmas, list the mathematical concepts it involves, as short search phrases, and the names of Mathlib declarations that are likely to be useful.\n\n` +
          `theorem ${session.target.theorem} ${session.target.statement}${sketchText}`,
        schema: {
          type: "object",
          required: ["concepts", "names"],
          properties: {
            concepts: { type: "array", items: { type: "string" }, description: `At most ${o.maxQueries} short phrases naming concepts, such as "divisibility of a sum".` },
            names: { type: "array", items: { type: "string" }, description: "Likely declaration names, such as Nat.dvd_add." },
          },
          additionalProperties: false,
        },
      });
      const clean = (list: unknown, ok: (s: string) => boolean) =>
        (Array.isArray(list) ? list : []).filter((x): x is string => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length > 0 && x.length <= 80 && ok(x));
      return {
        queries: [...new Set(clean(answer.value.concepts, (s) => screenLean(s, 80) !== undefined))].slice(0, o.maxQueries),
        names: [...new Set(clean(answer.value.names, (s) => /^[A-Za-z_][\w.']*$/.test(s)))].slice(0, o.maxQueries * 2),
      };
    } catch (error) {
      if (isInterrupted(error)) throw error;
      session.log(`context: the queries could not be extracted (${error instanceof Error ? error.message : String(error)}); the statement alone is used`);
      return { queries: [], names: [] };
    }
  }

  async function collect(session: SessionContext, o: Options): Promise<Collected> {
    const sketch = carryOf(session);
    const { queries, names } = o.extractQueries && !o.naive ? await extract(session, o, sketch) : { queries: [], names: [] };
    const library = usableLemmas(session.memory);
    const dec = await declared(session);
    const prefix = session.target.sketch.prefix;
    const tiers: Partial<Record<Source, Entry[]>> = {
      local: localEntries(prefix),
      library: library.map(libraryEntry),
      extra: dec.extra,
      mathlib: dec.mathlib,
    };
    const failed = session.memory.attempts(session.claimId, { includeEquivalents: true }).filter((a) => a.outcome === "invalid").length;
    const factOptions = {
      statuses: o.factStatuses.filter((s): s is ClaimStatus => ["proved", "computed", "refuted"].includes(s)),
      depth: Math.min(o.maxDepth, o.baseDepth + failed),
      threshold: o.factThreshold,
      graphWeight: o.graphWeight,
      limit: o.maxFacts,
      exclude: new Set(library.map((l) => l.claimId)),
    };
    const query = [session.target.statement, ...queries].join(" ");
    const facts = o.naive
      ? session.memory.claims({ statuses: factOptions.statuses as ClaimStatus[] }).filter((c) => c.kind === "formal" && c.claimId !== session.claimId && !factOptions.exclude.has(c.claimId)).map((c): Fact => ({ claimId: c.claimId, status: c.status, statement: c.statement, ...(c.gloss !== undefined ? { gloss: c.gloss } : {}), score: 1, graph: 0, similarity: 0 }))
      : selectFacts(session.memory, session.claimId, query, factOptions);
    const header = importHeader(session.target.source);
    const caps = { local: 3, library: 5, extra: 3, mathlib: 5 };
    const premises = o.naive
      ? [...(tiers.local ?? []), ...(tiers.library ?? [])].map((entry): Premise => ({ entry, score: 1, via: ["all"], use: "apply" }))
      : await retrievePremises(
          tiers,
          { statement: `${session.target.theorem} ${session.target.statement}`, queries, names },
          {
            selector: selectorOf(o),
            count: o.premises,
            caps,
            threshold: o.premiseThreshold,
            weights: [o.hybridWeights[0] ?? 0.4, o.hybridWeights[1] ?? 0.3, o.hybridWeights[2] ?? 0.3],
            ...(o.accessibility ? { access: { header, assumed: o.assumedImports } } : {}),
            ...(o.seeds ? { seeds: { ...(deps.neighbours !== undefined ? { neighbours: deps.neighbours } : {}) } } : {}),
            ...(o.knn ? { knn: { examples: proofExamples(session.memory, new Set([session.claimId])), k: o.knnK } } : {}),
          },
          dec.flags,
        );
    const lessons = o.naive
      ? allLessons(session.memory).filter((l) => l.state === "active")
      : selectLessons(session, { maxLessons: o.maxLessons });
    return { queries, names, facts, premises, lessons, tiers, flags: dec.flags };
  }

  function stateOf(session: SessionContext): SessionState {
    const key = sessionKey(session);
    let state = sessions.get(key);
    if (state === undefined) {
      state = {
        collected: { queries: [], names: [], facts: [], premises: [], lessons: [], tiers: {}, flags: new Map() },
        ids: new CitableIds((id) => session.memory.edge(id) !== undefined),
        entries: new Map(),
        started: false,
      };
      sessions.set(key, state);
    }
    return state;
  }

  function edgesAmong(memory: MemoryStore, claimIds: readonly string[]): ShownEdge[] {
    const set = new Set(claimIds);
    const out = new Map<string, ShownEdge>();
    for (const id of claimIds) for (const edge of memory.edges({ from: id })) if (set.has(edge.from) && edge.to.every((t) => set.has(t))) out.set(edge.edgeId, { kind: edge.kind, status: edge.status, from: edge.from, to: edge.to });
    return [...out.values()];
  }

  function triedLines(session: SessionContext, o: Options): string[] {
    const view = session.ranking === undefined ? undefined : { current: configClassOf({ modelId: session.model, budgetClass: session.ranking.budgetClass }), ranking: session.ranking };
    const lines = [
      ...renderTried(session.memory.alreadyTried(session.claimId, view), { maxLines: o.maxTried }),
      ...renderObstructions(session.memory.obstructions(session.claimId, { includeEquivalents: true }), { maxLines: o.maxTried }),
      ...(describeTried(session.memory, session.claimId)?.split("\n") ?? []),
    ];
    return lines.flatMap((l) => screenLean(l, 400) ?? []);
  }

  /** One fact for the `newSince` list: its standing and its statement, screened; the same text at the freeze and later. */
  const factText = (status: string, statement: string): string[] => {
    const s = screenLean(statement, 200);
    return s === undefined ? [] : [`[${status === "proved" ? "proved" : status === "computed" ? "computed, not replayed" : status}] ${s}`];
  };

  function factTexts(session: SessionContext, o: Options, state: SessionState): string[] {
    const library = new Set(usableLemmas(session.memory).map((l) => l.claimId));
    const failed = session.memory.attempts(session.claimId, { includeEquivalents: true }).filter((a) => a.outcome === "invalid").length;
    const query = [session.target.statement, ...state.collected.queries].join(" ");
    const facts = selectFacts(session.memory, session.claimId, query, {
      statuses: ["proved", "computed"],
      depth: Math.min(o.maxDepth, o.baseDepth + failed),
      threshold: o.factThreshold,
      graphWeight: o.graphWeight,
      limit: o.maxFacts * 4,
      exclude: library,
    });
    return facts.flatMap((f) => factText(f.status, f.statement));
  }

  function compile(session: SessionContext, o: Options, state: SessionState, opening: string | undefined): string {
    const c = state.collected;
    const included = new Set(session.drawn.included);
    const lessons = c.lessons.filter((l) => included.has(l.nodeId));
    const premises = c.premises.filter((p) => (p.entry.source !== "library" || included.has(LIBRARY_ITEM)) && (p.via.some((v) => v !== "knn") || included.has(KNN_ITEM)));
    for (const p of premises) state.entries.set(p.entry.id, p.entry);
    const graphEdges = isStrong(session.model, o.strongModels) ? o.graphEdgesStrong : o.graphEdges;
    const claimIds = [session.claimId, ...c.facts.map((f) => f.claimId)];
    const goalClaim = session.memory.claim(session.claimId);
    const budget = Math.floor(o.tokens * o.prefixShare);
    const rendered = renderPrefix({
      theorem: session.target.theorem,
      statement: session.target.statement,
      goalId: session.claimId,
      ...(goalClaim?.gloss !== undefined ? { goalGloss: goalClaim.gloss } : {}),
      facts: c.facts,
      edges: edgesAmong(session.memory, claimIds),
      premises,
      header: importHeader(session.target.source),
      tried: triedLines(session, o),
      lessons: lessons.map((l) => ({ nodeId: l.nodeId, scope: l.scope === "global" ? "all problems" : l.scope === "domain" ? (screenProse(l.scopeKey, { max: 60 }).ok ? l.scopeKey : "a domain") : "this problem", text: l.text })),
      notes: otherLines(opening),
      ids: state.ids,
      budget,
      options: { gloss: o.gloss, badges: o.badges, rendering: renderingOf(o), graphEdges },
    });
    state.prefix = rendered.text;
    state.frozen = {
      claims: new Map(rendered.claimIds.map((id) => [id, session.memory.claim(id)?.status ?? "open"] as [string, string])),
      library: rendered.libraryNames.filter((k) => premises.some((p) => p.entry.id === k && p.entry.source === "library")),
      facts: c.facts.filter((f) => rendered.claimIds.includes(f.claimId)).flatMap((f) => factText(f.status, f.statement)),
    };
    const record: PacketRecord = {
      attemptId: session.attemptId,
      naive: false,
      model: session.model,
      prefixTokens: rendered.shown.tokens,
      tailTokens: 0,
      budget: o.tokens,
      prefixBudget: budget,
      overBudget: rendered.overBudget,
      shown: { facts: rendered.shown.facts, edges: rendered.shown.edges, premises: rendered.shown.premises, tried: rendered.shown.tried, lessons: rendered.shown.lessons, notes: rendered.shown.notes },
      queries: c.queries,
      names: c.names,
      included: [...session.drawn.included],
      withheld: [...session.drawn.withheld],
    };
    state.record = record;
    if (rendered.overBudget) session.log(`context: the goal alone is above the packet budget (${rendered.shown.tokens} of ${record.prefixBudget} tokens); nothing else was shown`);
    return rendered.text;
  }

  /** What the prefix says that the projection has since withdrawn: a claim whose status fell, a library lemma that is no longer usable. */
  function withdrawnOf(session: SessionContext, state: SessionState): string[] {
    const frozen = state.frozen;
    if (frozen === undefined) return [];
    const out: string[] = [];
    for (const [id, then] of frozen.claims) {
      const now = session.memory.claim(id)?.status ?? "retracted";
      if (now === then || (then === "computed" && now === "proved")) continue;
      out.push(`${state.ids.name("C", id)}: shown as ${then}, now ${now}`);
    }
    if (frozen.library.length > 0) {
      const usable = new Set(usableLemmas(session.memory).map((l) => l.name));
      for (const name of frozen.library) if (!usable.has(name)) out.push(`${state.ids.name("L", name)}: a library lemma that is no longer usable`);
    }
    return out;
  }

  function tailOf(session: SessionContext, request: PacketRequest, o: Options, state: SessionState): string {
    const last = state.last ?? carryOf(session);
    const fromTranscript = request.transcript.findLast((e) => e.role === "tool" && e.tool === "lean_check");
    const entry = request.transcript[request.transcript.length - 1];
    // The tools' answers to the model's last turn (after its last assistant message), without lean_check's, which is the feedback.
    const lastTurn = request.transcript.slice(request.transcript.findLastIndex((e) => e.role === "assistant") + 1);
    const toolResults = lastTurn.filter((e) => e.role === "tool" && e.tool !== "lean_check").map((e) => ({ tool: e.tool ?? "tool", text: e.text, ...(e.isError === true ? { isError: true } : {}) }));
    const instruction = request.request > 1 && entry?.role === "user" ? entry.text.trim().slice(0, 600) : undefined;
    const limit = session.budget.limitUsd;
    const budgetLeft = limit === undefined ? undefined : `Budget left: ${Math.max(0, limit - session.budget.usd).toFixed(2)} of ${limit.toFixed(2)} USD.`;
    const withdrawn = withdrawnOf(session, state);
    return renderTail({
      session: session.session,
      sessions: session.sessions,
      request: request.request,
      aux: last?.aux ?? session.regions.aux,
      proof: last?.proof ?? session.regions.proof,
      ...(last?.holes !== undefined ? { holes: last.holes } : {}),
      ...(fromTranscript !== undefined ? { feedback: fromTranscript.text } : last?.feedback !== undefined ? { feedback: last.feedback } : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      ...(budgetLeft !== undefined ? { budgetLeft } : {}),
      ...(withdrawn.length > 0 ? { withdrawn } : {}),
      budget: Math.max(300, o.tokens - Math.floor(o.tokens * o.prefixShare)),
    });
  }

  /** The naive packet: the same content, every item, in the order the memory holds it, no ids, no threshold, no tools. */
  function naive(session: SessionContext, request: PacketRequest, o: Options, state: SessionState): string {
    const c = state.collected;
    const included = new Set(session.drawn.included);
    const lines: string[] = [`Theorem ${session.target.theorem} ${session.target.statement}`];
    const facts = c.facts.flatMap((f) => screenLean(f.statement, 300) ?? []);
    if (facts.length > 0) lines.push("", "Facts:", ...facts);
    const lemmas = c.premises.filter((p) => p.entry.source !== "library" || included.has(LIBRARY_ITEM)).flatMap((p) => screenLean(`${p.entry.name} ${p.entry.signature}`, 240) ?? []);
    if (lemmas.length > 0) lines.push("", "Lemmas:", ...lemmas);
    const tried = triedLines(session, o);
    if (tried.length > 0) lines.push("", "Tried:", ...tried);
    const advice = c.lessons.filter((l) => included.has(l.nodeId)).flatMap((l) => {
      const r = screenProse(l.text, { max: 240 });
      return r.ok ? [r.text] : [];
    });
    if (advice.length > 0) lines.push("", "Lessons:", ...advice);
    lines.push("", tailOf(session, request, o, state));
    return lines.join("\n");
  }

  const tools = (session: SessionContext, o: Options): LineTool[] => {
    const state = stateOf(session);
    const prefix = session.target.sketch.prefix;
    const env: ToolEnv = {
      memory: session.memory,
      goalId: session.claimId,
      ids: state.ids,
      entries: state.entries,
      searchable: () => Object.values(state.collected.tiers).flat(),
      lessons: () => allLessons(session.memory),
      localText: (name) => localText(prefix, name),
      header: importHeader(session.target.source),
      rendering: renderingOf(o),
      graphEdges: isStrong(session.model, o.strongModels) ? o.graphEdgesStrong : o.graphEdges,
    };
    return [expandTool(env), graphQueryTool(env)];
  };

  return {
    id: "M4",
    title: LINE_TITLES.M4,
    requires: [],
    options: M4_OPTIONS,
    version: "m4-1",
    // What M4 reads it reads from the memory (claims, edges, lessons, attempts, and the `context_carry` node each attempt leaves): a session is compiled from the journal alone, so a resumed process makes the packet an uncut one would.
    resume: "stateless",
    hooks: {
      beforeSession: async (session) => {
        const o = optionsOf(session.options);
        const collected = await collect(session, o);
        const state = stateOf(session);
        state.collected = collected;
        // Each unverified item the compiler selects goes through the draw (PE2): a lesson, the library hint section, the k-NN's suggestions. A claim is never drawn.
        const items: string[] = collected.lessons.map((l) => l.nodeId);
        if (collected.premises.some((p) => p.entry.source === "library")) items.push(LIBRARY_ITEM);
        if (collected.premises.some((p) => p.via.every((v) => v === "knn"))) items.push(KNN_ITEM);
        if (items.length > 0) session.draw(items);
        return undefined;
      },
      tools: async (session): Promise<LineTool[]> => {
        const o = optionsOf(session.options);
        return o.tools && !o.naive ? tools(session, o) : [];
      },
      afterCheck: async (session, check) => {
        const state = stateOf(session);
        state.last = { aux: check.submission.aux, proof: check.submission.proof, holes: holesOf(check.report), feedback: rawFeedback(check.report) };
        return undefined;
      },
      contextPacket: async (session, request) => {
        const o = optionsOf(session.options);
        const state = stateOf(session);
        if (o.naive) {
          const text = naive(session, request, o, state);
          if (!state.started) {
            state.started = true;
            session.memory.recordNode({ kind: PACKET_KIND, claimId: session.claimId, data: { attemptId: session.attemptId, naive: true, model: session.model, prefixTokens: 0, tailTokens: estimateTokens(text), budget: o.tokens, prefixBudget: 0, overBudget: false, shown: { facts: 0, edges: 0, premises: 0, tried: 0, lessons: 0, notes: 0 }, queries: [], names: [], included: [...session.drawn.included], withheld: [...session.drawn.withheld] } satisfies PacketRecord as unknown as Json });
          }
          return text;
        }
        const prefix = request.prefix ?? state.prefix ?? compile(session, o, state, request.transcript[0]?.text);
        const tail = tailOf(session, request, o, state);
        if (state.record !== undefined) {
          session.memory.recordNode({ kind: PACKET_KIND, claimId: session.claimId, data: { ...state.record, tailTokens: estimateTokens(tail) } as unknown as Json });
          delete state.record;
        }
        const packet: FrozenPacket = {
          prefix,
          tail,
          ...(o.newSince > 0 ? { facts: request.request === 1 || state.frozen === undefined ? (state.frozen?.facts ?? []) : [...state.frozen.facts, ...factTexts(session, o, state)], newSince: o.newSince } : {}),
        };
        return packet;
      },
      afterAttempt: async (problem, attempt: FinishedAttempt) => {
        sessions.delete(attempt.attemptId);
        if (attempt.submission !== undefined && attempt.report !== undefined) {
          const holes = holesOf(attempt.report);
          problem.memory.recordNode({
            kind: CARRY_KIND,
            claimId: problem.claimId,
            data: { prover: attempt.prover, session: attempt.session, aux: attempt.submission.aux, proof: attempt.submission.proof, holes, feedback: rawFeedback(attempt.report).slice(0, CARRY_FEEDBACK_CHARS) },
          });
        }
        return undefined;
      },
    },
  };
}

/** M4 with its defaults: no export of the environment's declarations and no dependency source. */
export const M4: Line = createM4();

/** The packet's size in tokens, by the documented approximation (for reports and tests). */
export { estimateTokens };
