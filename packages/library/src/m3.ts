import type { Json } from "@seshat/core";
import { type Briefing, LINE_TITLES, type Line, type LineTool, type ProblemContext, type SessionContext } from "@seshat/lines";
import { importHeader } from "./lemmas.ts";
import { DEFAULT_PROMOTION, promoteCandidates, type PromotionOptions, recordCandidates } from "./promote.ts";
import { USE_KIND, type UseData, usableLemmas } from "./records.ts";
import {
  type Caps,
  DEFAULT_CAPS,
  type DeclarationExport,
  declarationEntry,
  type Entry,
  type Hit,
  libraryEntry,
  localEntries,
  type Ranking,
  searchTiers,
  type Source,
  Tier,
} from "./search.ts";
import { cheapTacticTest, type TrivialityTest } from "./triviality.ts";
import { recheckLibrary } from "./recheck.ts";
import { type KnownName, usedNames } from "./usage.ts";

/** What the line is built with: both are replaceable, and none is a model. */
export interface M3Deps {
  /** The non-triviality test. Default: `cheapTacticTest()`. Task 6's battery plugs in here. */
  isTrivial?: TrivialityTest;
  /** The export of the environment's declarations (LC2), for the extra packages and Mathlib. Default: none, and only the library and the file are searched. */
  declarations?: DeclarationExport;
}

/** The options of M3 and their defaults (`--line-option M3.briefingLemmas=3`). */
export const M3_OPTIONS = {
  /** Promote the proved auxiliary lemmas of finished attempts (the library grows). */
  promote: true,
  /** Also promote from attempts that failed. */
  fromFailed: false,
  maxPerAttempt: DEFAULT_PROMOTION.maxPerAttempt,
  maxPerProblem: DEFAULT_PROMOTION.maxPerProblem,
  /** The briefing section; 0 lemmas leaves it out. */
  briefingLemmas: 5,
  /** The `library_search` tool. */
  tool: true,
  /** `bm25` or `hybrid` (BM25 with hashed vectors, kept only if a measure says it beats BM25). */
  ranking: "bm25",
  bm25Weight: 0.7,
  /** Compile the library again when the Mathlib revision changed (PE1), the most lemmas per problem. */
  recheck: true,
  maxRecheck: 50,
};

/** The item the draw covers: the briefing section as a whole. */
export const SECTION_ITEM = "library:section";

type Options = typeof M3_OPTIONS;

function optionsOf(raw: Readonly<Record<string, Json>>): Options {
  return { ...M3_OPTIONS, ...(raw as Partial<Options>) };
}

function promotionOf(o: Options): PromotionOptions {
  return { maxPerAttempt: o.maxPerAttempt, maxPerProblem: o.maxPerProblem, fromFailed: o.fromFailed };
}

function rankingOf(o: Options): Ranking {
  return { mode: o.ranking === "hybrid" ? "hybrid" : "bm25", bm25Weight: o.bm25Weight };
}

/** The query a problem's briefing searches with: its theorem's name and statement. */
export function queryOf(problem: Pick<ProblemContext, "target">): string {
  return `${problem.target.theorem} ${problem.target.statement}`;
}

/** One result as a prover reads it: the source first, then what to paste or import. */
export function renderHit(hit: Hit, header: string, index?: number): string {
  const e = hit.entry;
  const head = `${index === undefined ? "-" : `${index}.`} [${e.label}] ${e.name} ${e.signature.length > 240 ? `${e.signature.slice(0, 239)}…` : e.signature}`;
  const gloss = e.gloss === "" ? "" : `\n   ${e.gloss}`;
  const standing =
    e.claimStatus === undefined ? "" : e.claimStatus === "proved" ? "\n   status: proved (replayed by the certifier)" : "\n   status: accepted by Lean's check, not yet replayed by the certifier";
  const needs = e.module !== undefined && !header.includes(e.module) ? `\n   needs: import ${e.module}` : "";
  const text = e.text === undefined ? "" : `\n   Paste into the auxiliary region, then use it by name:\n${e.text.split("\n").map((l) => `   ${l}`).join("\n")}`;
  return `${head}${gloss}${standing}${needs}${text}`;
}

export function createM3(deps: M3Deps = {}): Line {
  const isTrivial = deps.isTrivial ?? cheapTacticTest();
  /** The environment's declarations, indexed once per environment hash. */
  const exported = new Map<string, Promise<Partial<Record<Source, Tier>>>>();

  async function declarationTiers(problem: ProblemContext): Promise<Partial<Record<Source, Tier>>> {
    if (deps.declarations === undefined) return {};
    const env = problem.registry.leanEnv;
    const key = env?.hash ?? "none";
    let pending = exported.get(key);
    if (pending === undefined) {
      pending = deps.declarations(env).then((all) => {
        const entries = all.map(declarationEntry);
        return { extra: new Tier(entries.filter((e) => e.source === "extra")), mathlib: new Tier(entries.filter((e) => e.source === "mathlib")) };
      });
      exported.set(key, pending);
      // A failed export is tried again at the next call, not remembered.
      pending.catch(() => exported.delete(key));
    }
    try {
      return await pending;
    } catch (error) {
      problem.log(`library: the declarations of the environment could not be exported: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  async function tiers(problem: ProblemContext): Promise<Partial<Record<Source, Tier>>> {
    return {
      local: new Tier(localEntries(problem.target.sketch.prefix)),
      library: new Tier(usableLemmas(problem.memory).map(libraryEntry)),
      ...(await declarationTiers(problem)),
    };
  }

  async function search(problem: ProblemContext, query: string, o: Options, caps: Partial<Caps> = {}): Promise<Hit[]> {
    return searchTiers(await tiers(problem), query, { ...DEFAULT_CAPS, ...caps }, rankingOf(o));
  }

  async function section(problem: ProblemContext, o: Options): Promise<{ text: string; hits: number } | undefined> {
    if (o.briefingLemmas <= 0) return undefined;
    const hits = (await search(problem, queryOf(problem), o)).slice(0, o.briefingLemmas);
    if (hits.length === 0) return undefined;
    const header = importHeader(problem.target.source);
    return {
      hits: hits.length,
      text:
        "Declarations that may help, searched in this order: this file, the harness library, other packages, Mathlib. " +
        "A [library] lemma was accepted by Lean's check on an earlier problem (its status line says whether the certifier has replayed it): paste its text into your auxiliary region (names starting aux_lib_) and use it. " +
        "The tool library_search looks for more.\n" +
        hits.map((h, i) => renderHit(h, header, i + 1)).join("\n"),
    };
  }

  return {
    id: "M3",
    title: LINE_TITLES.M3,
    requires: [],
    options: M3_OPTIONS,
    version: "m3-1",
    // Everything M3 knows it reads from the memory: the library's lemmas and candidates are nodes, and the index is built from them.
    resume: "stateless",
    hooks: {
      beforeProvers: async (problem) => {
        const o = optionsOf(problem.options);
        if (o.recheck) await recheckLibrary(problem, { maxRecheck: o.maxRecheck });
      },
      beforeSession: async (session: SessionContext) => {
        const o = optionsOf(session.options);
        // The section is unverified advice (which lemmas to look at), so a session may be denied it (PE2); the lemmas themselves are Lean-checked.
        if ((await section(session, o)) !== undefined) session.draw([SECTION_ITEM]);
        return undefined;
      },
      briefing: async (session): Promise<Briefing | undefined> => {
        if (!session.drawn.included.includes(SECTION_ITEM)) return undefined;
        const made = await section(session, optionsOf(session.options));
        return made === undefined ? undefined : { title: "Library", text: made.text };
      },
      tools: async (session): Promise<LineTool[]> => {
        const o = optionsOf(session.options);
        if (!o.tool) return [];
        return [
          {
            name: "library_search",
            description:
              "Search for a lemma by words from its name or statement, before looking in Mathlib. Results come in this order: declarations of this file, the harness library (proved on earlier problems; each comes with a ready lemma to paste into your auxiliary region), other packages, Mathlib. Each result says where it comes from.",
            parameters: {
              type: "object",
              required: ["query"],
              properties: {
                query: { type: "string", description: "Words from the name or the statement you look for, such as `sum of two even numbers` or `Nat.dvd_add`." },
                limit: { type: "integer", description: "The most results (default 8)." },
              },
              additionalProperties: false,
            },
            run: async (args) => {
              const query = typeof args.query === "string" ? args.query : "";
              if (query.trim() === "") throw new Error("library_search needs a query: words from the name or the statement you look for");
              const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 8;
              const hits = (await search(session, query, o)).slice(0, limit);
              if (hits.length === 0) return `Nothing in the library, this file or the indexed packages matches "${query}". Try other words from the statement (names, symbols).`;
              const header = importHeader(session.target.source);
              return hits.map((h, i) => renderHit(h, header, i + 1)).join("\n");
            },
          },
        ];
      },
      afterAttempt: async (problem, attempt) => {
        const o = optionsOf(problem.options);
        if (o.promote) recordCandidates(problem, attempt, promotionOf(o));
        if (attempt.submission === undefined) return undefined;
        // What the submission used, from the library and from the other sources: the report's share of proofs that use the library.
        const known: KnownName[] = usableLemmas(problem.memory).map((l) => ({ name: l.name, label: "library" }));
        for (const tier of Object.values(await declarationTiers(problem))) {
          for (const e of tier.entries as readonly Entry[]) known.push({ name: e.name, label: e.label });
        }
        // A pasted library lemma names itself in its own declaration: that is not a use (review M1).
        const text = `${attempt.submission.aux}\n${attempt.submission.proof}`.replace(/\b(?:theorem|lemma)\s+aux_lib_[\p{L}\p{N}_']*/gu, "theorem _");
        const used = usedNames(text, known);
        if (used.length > 0) {
          const data: UseData = { attemptId: attempt.attemptId, claimId: problem.claimId, outcome: attempt.outcome, used: used.map((u) => ({ name: u.name, source: u.label })) };
          problem.memory.recordNode({ kind: USE_KIND, claimId: problem.claimId, data: data as unknown as Json });
        }
        return undefined;
      },
      afterProblem: async (problem) => {
        const o = optionsOf(problem.options);
        if (!o.promote) return;
        const r = await promoteCandidates(problem, isTrivial, promotionOf(o));
        if (r.promoted + r.duplicate + r.trivial + r.unproved > 0) {
          problem.log(`library: ${r.promoted} promoted, ${r.duplicate} duplicate, ${r.trivial} trivial, ${r.unproved} not proved alone, ${r.left} left`);
        }
      },
    },
  };
}

/** M3 with its defaults: the cheap-tactic triviality test and no export of the environment's declarations. */
export const M3: Line = createM3();
