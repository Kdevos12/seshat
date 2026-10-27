import { EDGE_KINDS, EDGE_STATUSES, CLAIM_STATUSES } from "@seshat/core";
import type { Briefing, JsonObject, Line, LineTool, ProblemContext } from "@seshat/lines";
import { Atms } from "./atms.ts";
import { realize, revokeUnsupported } from "./realize.ts";
import { graphQuery, parseGraphQuery, renderSubgraph, ShortIds } from "./query.ts";
import { GraphState } from "./state.ts";
import { createTwin, runTwin, type Twin, twinSettled } from "./twin.ts";

/** The node kind in which the line records the twin of a problem's claim (documentation/graph.md). */
export const TWIN_KIND = "twin";

/** The shape of the data of a `twin` node. */
export interface TwinRecord {
  negationId: string;
  edgeId: string;
  /** Whether the `negation_of` edge is `lean_checked`. */
  checked: boolean;
  /** How the refutation side ended: which side settled, or `exhausted`, `stopped`, `error`, or `idle` when it never ran. */
  end: "proof" | "refutation" | "exhausted" | "stopped" | "error" | "idle";
  /** Model calls it made. */
  tries: number;
}

/** The options of the line and their defaults (a run's `--line-option M2.twinTries=3` replaces one). */
export const M2_OPTIONS: JsonObject = {
  /** Create the prove/refute twin of the problem's claim and try to prove its negation alongside the provers. */
  twin: true,
  /** The most model calls on the refutation side, per problem. */
  twinTries: 2,
  /** Submit the composed proofs of the claims the graph derives. */
  propagate: true,
  /** The most composed proofs submitted per problem. */
  composed: 8,
  /** Give the provers the `graph_neighbors` tool. */
  queryTool: true,
};

interface Settings {
  twin: boolean;
  twinTries: number;
  propagate: boolean;
  composed: number;
  queryTool: boolean;
}

function settings(options: Readonly<JsonObject>): Settings {
  const flag = (key: string) => options[key] === true;
  const count = (key: string) => Math.max(0, Math.floor(Number(options[key])));
  return { twin: flag("twin"), twinTries: count("twinTries"), propagate: flag("propagate"), composed: count("composed"), queryTool: flag("queryTool") };
}

/** What the line keeps for one problem, from its `beforeProvers` to its `afterProblem`. */
interface Work {
  state: GraphState;
  atms: Atms;
  shorts: ShortIds;
  /** The header the problem's claim and its variants are read under: the problem's prefix. */
  header: string;
  twin?: Twin;
  /** The refutation side, running alongside the provers. */
  side?: Promise<{ end: TwinRecord["end"]; tries: number }>;
  tried: Set<string>;
  composed: number;
}

/**
 * The line M2 (plan §6): the variant graph and the logical propagation. For each problem it
 *
 * - creates the twin of the claim, its negation as a claim of its own, and checks the `negation_of`
 *   edge that links them with Lean;
 * - propagates over the `lean_checked` edges around the claim: what the rules derive is turned into
 *   a composed proof, and the claim changes status only when `validate` accepts that proof;
 * - runs the refutation side of the twin alongside the provers, a few model calls that try to prove
 *   the negation; when the graph settles the claim as refuted the provers are stopped, and when the
 *   provers settle it first, the refutation side stops;
 * - tells each prover what the graph knows: the open lemmas the claim would follow from, and the
 *   `graph_neighbors` tool to read the neighborhood of a claim. (`graph_query` is the context compiler's, M4.)
 *
 * A problem the graph refutes ends as `refuted` when the certifier certifies the refutation its
 * lines submitted (the run does that once `afterProblem` is over); without a certifier, or when it
 * rejects the refutation or cannot decide, the problem ends as `unsolved`. Each line object keeps
 * its per-problem state, so register one per run (`createM2Line`); `m2Line` is the instance the
 * orchestrator registers.
 */
export function createM2Line(): Line {
  const works = new Map<string, Work>();
  const keyOf = (problem: ProblemContext) => `${problem.runId}/${problem.problemId}`;

  /** Optional mechanisms must not take a problem down: a failure is logged, an abort ends them quietly. */
  async function soft(problem: ProblemContext, what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (problem.signal.aborted) return;
      problem.log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function propagate(problem: ProblemContext, work: Work, s: Settings): Promise<void> {
    if (!s.propagate || work.composed >= s.composed) return;
    work.state.sync();
    const done = await realize({
      memory: problem.memory,
      state: work.state,
      validate: problem.validate,
      headerOf: (id) => (id === problem.claimId ? work.header : problem.memory.claim(id)?.header),
      limit: s.composed - work.composed,
      tried: work.tried,
      signal: problem.signal,
      log: problem.log,
    });
    work.composed += done.filter((r) => r.verdict !== "skipped").length;
    work.state.sync();
    revokeUnsupported(problem.memory, work.state, problem.log);
  }

  /** Why the graph says the claim is refuted, or undefined while it does not. */
  function refutation(problem: ProblemContext, work: Work): string | undefined {
    work.state.sync();
    const explained = work.state.explain({ goal: "refuted", claim: problem.claimId });
    return explained === undefined ? undefined : `the graph refutes the claim (${explained.level}, by ${explained.tree.rule ?? "a refutation"})`;
  }

  const describe = (problem: ProblemContext, work: Work, id: string): string => {
    const statement = (problem.memory.claim(id)?.statement ?? "").replace(/\s+/g, " ").trim();
    return `${work.shorts.shorten(id)} (${statement.length > 100 ? `${statement.slice(0, 99)}…` : statement})`;
  };

  return {
    id: "M2",
    title: "variant graph and logical propagation",
    requires: [],
    options: M2_OPTIONS,
    version: "m2-1",
    // The per-problem work (the graph's ATMS, the twin and the refutation side that runs alongside the provers) lives in the process.
    resume: { refuse: "the variant graph's work on a problem (its truth-maintenance state, the twin and the refutation side running alongside the provers) is kept in the process, and the journal cannot give it back" },
    hooks: {
      beforeProvers: async (problem) => {
        const s = settings(problem.options);
        const state = new GraphState(problem.memory, [problem.claimId]);
        const work: Work = {
          state,
          atms: new Atms(state),
          shorts: new ShortIds(),
          header: problem.target.sketch.prefix,
          tried: new Set(),
          composed: 0,
        };
        works.set(keyOf(problem), work);
        const check = { memory: problem.memory, validate: problem.validate, header: work.header, log: problem.log };

        if (s.twin) {
          await soft(problem, "the twin", async () => {
            work.twin = await createTwin(check, problem.claimId);
            problem.log(`twin: the negation is claim ${work.shorts.shorten(work.twin.negationId)}, its edge is ${work.twin.checked ? "lean_checked" : "not checked"}`);
          });
        }
        await soft(problem, "propagation", () => propagate(problem, work, s));
        if (problem.memory.claim(problem.claimId)?.status !== "open") return;

        const twin = work.twin;
        if (twin?.checked === true && s.twinTries > 0 && twinSettled(state, twin) === undefined) {
          // Not awaited: it runs alongside the provers, and `afterProblem` joins it.
          work.side = runTwin({
            llm: problem.llm,
            memory: problem.memory,
            validate: problem.validate,
            signal: problem.signal,
            state,
            twin,
            attempts: s.twinTries,
          }).then(
            (result) => {
              problem.log(`twin: the refutation side ended: ${result.end} after ${result.attempts} model calls`);
              return { end: result.end, tries: result.attempts };
            },
            (error: unknown) => {
              problem.log(`twin: the refutation side failed: ${error instanceof Error ? error.message : String(error)}`);
              return { end: "error" as const, tries: 0 };
            },
          );
        }
      },

      beforeSession: async (session) => {
        const work = works.get(keyOf(session));
        const why = work === undefined ? undefined : refutation(session, work);
        return why === undefined ? undefined : { stop: why };
      },

      afterCheck: async (session) => {
        const work = works.get(keyOf(session));
        const why = work === undefined ? undefined : refutation(session, work);
        return why === undefined ? undefined : { stop: why };
      },

      briefing: async (session): Promise<Briefing | undefined> => {
        const work = works.get(keyOf(session));
        if (work === undefined) return undefined;
        const lines: string[] = [];
        const label = work.atms.refresh().label(session.claimId, "proved");
        const plans = label.environments.filter((env) => env.prove.length > 0 && env.refute.length === 0 && !env.prove.includes(session.claimId));
        if (plans.length > 0) {
          lines.push("The claim follows from lemmas that are still open in the graph:");
          for (const env of plans.slice(0, 3)) {
            lines.push(`- once ${env.prove.map((id) => describe(session, work, id)).join(" and ")} ${env.prove.length === 1 ? "is" : "are"} proved`);
          }
        }
        if (work.twin !== undefined && work.twin.checked) {
          lines.push(
            `The truth of the claim is not known. Its negation is the claim ${describe(session, work, work.twin.negationId)}, which another attempt tries to prove; if it does, your session is stopped.`,
          );
        }
        return lines.length === 0 ? undefined : { title: "What the graph knows", text: lines.join("\n") };
      },

      tools: async (session): Promise<LineTool[]> => {
        const work = works.get(keyOf(session));
        if (work === undefined || !settings(session.options).queryTool) return [];
        return [
          {
            name: "graph_neighbors",
            description:
              "Reads the research graph around a claim: the claims reached along edges of given kinds and statuses, up to a depth, with short ids. " +
              "Without arguments it shows the neighborhood (two edges) of the theorem you are proving. Pass a short id from an earlier answer as `from` to go on from there.",
            parameters: {
              type: "object",
              properties: {
                from: { type: "string", description: "A claim, by short id. Default: the theorem you are proving." },
                kinds: { type: "array", items: { type: "string", enum: [...EDGE_KINDS] }, description: "Follow only edges of these kinds." },
                edgeStatuses: { type: "array", items: { type: "string", enum: [...EDGE_STATUSES] }, description: "Follow only edges with these statuses." },
                claimStatuses: { type: "array", items: { type: "string", enum: [...CLAIM_STATUSES] }, description: "Go only through claims with these statuses." },
                direction: { type: "string", enum: ["out", "in", "both"], description: "Which way to follow an edge. Default both." },
                depth: { type: "integer", description: "The longest path, in edges. Default 2." },
              },
              additionalProperties: false,
            },
            run: async (args) => {
              const found = graphQuery(session.memory, parseGraphQuery(args, session.claimId), work.shorts);
              return renderSubgraph(found);
            },
          },
        ];
      },

      afterAttempt: async (problem) => {
        // What an attempt changed (a claim of the graph proved by another line, or the refutation side) may derive more.
        const work = works.get(keyOf(problem));
        if (work !== undefined) await soft(problem, "propagation", () => propagate(problem, work, settings(problem.options)));
        return undefined;
      },

      afterProblem: async (problem) => {
        const key = keyOf(problem);
        const work = works.get(key);
        if (work === undefined) return;
        works.delete(key);
        const s = settings(problem.options);
        const side = work.side === undefined ? undefined : await work.side;
        await soft(problem, "propagation", () => propagate(problem, work, s));
        const twin = work.twin;
        if (twin === undefined) return;
        // What the graph says now wins over how the refutation side ended.
        const end: TwinRecord["end"] = twinSettled(work.state, twin) ?? side?.end ?? "idle";
        const record: TwinRecord = { negationId: twin.negationId, edgeId: twin.edgeId, checked: twin.checked, end, tries: side?.tries ?? 0 };
        problem.memory.recordNode({ kind: TWIN_KIND, claimId: problem.claimId, data: { ...record } });
      },
    },
  };
}

/** The instance the orchestrator registers (`packages/orchestrator/src/lines.ts`). */
export const m2Line: Line = createM2Line();
