import { type Json } from "@seshat/core";
import { dependencyMatch, type Hypothesis, proposeHypothesisDag, readTables, recordHypothesisDag, type RefutedHypothesis, REFUTED_HYPOTHESIS_KIND, optionReader } from "@seshat/induction";
import { type Briefing, type FinishedAttempt, isInterrupted, type JsonObject, type Line, type ProblemContext, type ResumedProblem } from "@seshat/lines";
import { classifyFailure, type FailureClass, type MemoryStore } from "@seshat/memory";
import { recognizeStatement } from "@seshat/models";
import { selectRepairs, type Situation, type Suggestion } from "./critics.ts";
import { lakatosRepair, type RepairOption } from "./lakatos.ts";

const ACTOR = "line:M14";

/** The node kinds of the line: a Lakatos repair, and the fidelity of a formalization to the DAG of a repair. */
export const LAKATOS_KIND = "lakatos_repair";
export const REPAIR_FIDELITY_KIND = "repair_fidelity";

export const M14_OPTIONS: JsonObject = {
  /** Lakatos-style repair of the hypotheses the data table refuted (the nodes of line M8). */
  lakatos: true,
  /** The most Lakatos repairs made per problem. */
  maxLakatos: 3,
  /** The least share of the objects where the conjecture held that a monster-barring may keep. */
  minRetained: 0.5,
  /** Typed repairs of failed attempts (the table of critics). */
  critics: true,
  /** The most critics suggested after one failed attempt. */
  maxSuggestions: 2,
  /** The most suggestions made per problem. */
  maxRepairs: 6,
  /** Ask a model for the step DAG of the repair, before anything is formalized (plan change PC11 item 2). */
  refine: false,
};

interface Settings {
  lakatos: boolean;
  maxLakatos: number;
  minRetained: number;
  critics: boolean;
  maxSuggestions: number;
  maxRepairs: number;
  refine: boolean;
}

export function readM14Options(raw: Readonly<JsonObject>): Settings {
  const o = optionReader("M14", raw);
  return {
    lakatos: o.flag("lakatos"),
    maxLakatos: o.integer("maxLakatos", 0, 20),
    minRetained: Math.min(1, Math.max(0, Number(raw.minRetained))),
    critics: o.flag("critics"),
    maxSuggestions: o.integer("maxSuggestions", 1, 4),
    maxRepairs: o.integer("maxRepairs", 0, 100),
    refine: o.flag("refine"),
  };
}

interface Made {
  claimId: string;
  option: RepairOption;
  hypothesis: string;
}

interface Work {
  made: Made[];
  suggestions: Suggestion[];
  given: number;
  dag?: { critic: string; dag: Parameters<typeof dependencyMatch>[0] } | undefined;
}

const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

/** What a failed attempt shows, for the critics. */
export function situationOf(attempt: FinishedAttempt, statement: string): Situation | undefined {
  if (attempt.outcome !== "invalid" && attempt.outcome !== "error") return undefined;
  const failure = attempt.report !== undefined ? classifyFailure(attempt.report, { ...(attempt.submission !== undefined ? { aux: attempt.submission.aux } : {}), statement }) : undefined;
  const failureClass = (failure?.class ?? attempt.failureClass) as FailureClass | undefined;
  if (failureClass === undefined) return undefined;
  const message = attempt.report?.messages.find((m) => m.severity === "error" && /unsolved goals/i.test(m.text)) ?? attempt.report?.messages.find((m) => m.severity === "error");
  return {
    failureClass,
    detail: failure?.detail ?? failureClass,
    ...(attempt.strategy !== undefined ? { strategy: attempt.strategy } : {}),
    ...(message !== undefined ? { goal: clip(message.text, 500) } : {}),
    statement,
    ...(attempt.submission !== undefined ? { proof: attempt.submission.proof } : {}),
  };
}

/**
 * The line M14: typed repairs and Lakatos-style repair. Before the provers, for each hypothesis that line M8's data table refuted, it looks for the
 * concept that separates the counterexamples from the objects where the hypothesis held (`lakatosRepair`) and
 * makes the repaired conjecture a claim of its own: `open`, derived from the problem's claim, in Lean when every
 * column in the concept has a Lean form, else informal and then through the step DAG first (plan change PC11
 * item 2). After a failed attempt, the table of critics (`REPAIR_TABLE`) reads the failure and suggests a repair
 * for the next session's briefing. Nothing here changes a status: Lean does.
 */
export function createM14(): Line {
  const works = new Map<string, Work>();
  const keyOf = (p: ProblemContext): string => `${p.runId}/${p.problemId}`;
  const workOf = (p: ProblemContext): Work => {
    let work = works.get(keyOf(p));
    if (work === undefined) works.set(keyOf(p), (work = { made: [], suggestions: [], given: 0 }));
    return work;
  };

  async function lakatos(problem: ProblemContext, s: Settings): Promise<void> {
    const memory: MemoryStore = problem.memory.withActor(ACTOR);
    const work = workOf(problem);
    work.made = [];
    const target = memory.claim(problem.claimId);
    if (target === undefined) return;
    const tables = readTables(memory, problem.claimId);
    let made = 0;
    for (const node of memory.nodes(REFUTED_HYPOTHESIS_KIND, { claimId: problem.claimId })) {
      if (made >= s.maxLakatos) break;
      const refuted = node.data as unknown as RefutedHypothesis;
      const table = tables.find((t) => t.table.id === refuted.tableId)?.table;
      if (table === undefined) continue;
      // The premise is written in the hypothesis's own binder, which need not be the target's: the name comes from
      // the hypothesis's statement, and a statement that is not a recognized natural-number one gives an informal repair.
      const own = refuted.statement !== undefined ? recognizeStatement(refuted.statement) : undefined;
      const ownVariable = own !== undefined && "statement" in own && own.statement.kind === "nat" ? own.statement.variable : undefined;
      const found = lakatosRepair({ table, verdicts: refuted.verdicts, informal: refuted.informal, ...(refuted.statement !== undefined && ownVariable !== undefined ? { statement: refuted.statement } : {}), variable: ownVariable ?? "n", minRetained: s.minRetained });
      if (found.options.length === 0) {
        problem.log(`M14: ${refuted.hypothesis} has no repair: ${found.reason}`);
        continue;
      }
      const option = found.options[0] as RepairOption;
      let claimId: string;
      try {
        if (option.statement !== undefined) {
          claimId = (await memory.ensureClaim({ statement: option.statement, ...(target.header !== undefined ? { header: target.header } : {}), origin: ACTOR, kind: "formal", parentId: problem.claimId, gloss: option.informal })).claimId;
        } else {
          // Informal: the argument goes through the step DAG first; the repaired conjecture is its last step.
          const pseudo: Hypothesis = { id: `repair_${refuted.hypothesis}`.slice(0, 24), level: "structure", informal: option.informal, conclusion: "() => true", uses: [] };
          claimId = (await memory.ensureClaim({ statement: option.informal, origin: ACTOR, kind: "informal", parentId: problem.claimId })).claimId;
          const dag = await proposeHypothesisDag(problem.llm, pseudo, target.statement);
          if (dag.dag !== undefined) await recordHypothesisDag(memory, claimId, pseudo.id, dag.dag);
          else problem.log(`M14: no step DAG for the repair of ${refuted.hypothesis}: ${dag.problems.join("; ")}`);
        }
      } catch (error) {
        if (isInterrupted(error) || problem.signal.aborted) throw error;
        problem.log(`M14: a repair was refused: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (claimId !== problem.claimId && !memory.edges({ from: claimId, kinds: ["derived_from"] }).some((e) => e.to[0] === problem.claimId)) {
        memory.addEdge({ kind: "derived_from", from: claimId, to: problem.claimId, note: `${option.kind} of ${refuted.hypothesis}: not (${option.concept.text})` });
      }
      if (!memory.nodes(LAKATOS_KIND, { claimId }).some((n) => (n.data as { hypothesis?: string }).hypothesis === refuted.hypothesis)) {
        memory.recordNode({
          kind: LAKATOS_KIND,
          claimId,
          data: { hypothesis: refuted.hypothesis, kind: option.kind, concept: option.concept.text, atoms: option.concept.atoms, exact: option.exact, retained: option.retained, lost: option.lost, excluded: option.excluded, counterexamples: refuted.counterexamples.slice(0, 5) } as unknown as Json,
        });
      }
      work.made.push({ claimId, option, hypothesis: refuted.hypothesis });
      made++;
      problem.log(`M14: ${option.kind} for ${refuted.hypothesis}: not (${option.concept.text}); keeps ${option.retained}, loses ${option.lost}`);
    }
  }

  async function run(problem: ProblemContext, _held?: ResumedProblem): Promise<void> {
    const s = readM14Options(problem.options);
    if (s.lakatos) {
      try {
        await lakatos(problem, s);
      } catch (error) {
        if (isInterrupted(error) || problem.signal.aborted) throw error;
        problem.log(`M14: failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    id: "M14",
    title: "typed repairs and Lakatos-style repair",
    requires: [],
    options: M14_OPTIONS,
    version: "m14-1",
    // The repairs are a function of the memory (the tables and the refuted hypotheses of M8); claims, edges and nodes are not written twice.
    resume: "rebuild",
    hooks: {
      beforeProvers: (problem) => run(problem),
      resumeProblem: (problem, held) => run(problem, held),

      afterAttempt: async (problem, attempt) => {
        const s = readM14Options(problem.options);
        const work = workOf(problem);
        const memory = problem.memory.withActor(ACTOR);
        // The fidelity of the formalization to the DAG of the repair suggested before: ProofScore's dependency match.
        if (work.dag !== undefined && attempt.submission !== undefined && attempt.submission.aux.trim() !== "") {
          const match = dependencyMatch(work.dag.dag, attempt.submission.aux);
          memory.recordNode({ kind: REPAIR_FIDELITY_KIND, claimId: problem.claimId, data: { critic: work.dag.critic, attemptId: attempt.attemptId, ...match } as unknown as Json });
          work.dag = undefined;
        }
        if (!s.critics || work.given >= s.maxRepairs) return undefined;
        const target = memory.claim(problem.claimId);
        const situation = target === undefined ? undefined : situationOf(attempt, target.statement);
        if (situation === undefined) return undefined;
        const suggestions = selectRepairs(situation, Math.min(s.maxSuggestions, s.maxRepairs - work.given));
        work.suggestions = suggestions;
        work.given += suggestions.length;
        for (const sg of suggestions) problem.log(`M14: after ${situation.detail}: ${sg.title} (${sg.reason})`);
        if (s.refine && suggestions[0] !== undefined) {
          try {
            const first = suggestions[0];
            const pseudo: Hypothesis = { id: first.critic, level: "structure", informal: first.directive, conclusion: "() => true", uses: [] };
            const dag = await proposeHypothesisDag(problem.llm, pseudo, target?.statement ?? "");
            if (dag.dag !== undefined) {
              await recordHypothesisDag(memory, problem.claimId, `${first.critic}_${attempt.attemptId}`.slice(0, 40), dag.dag);
              work.dag = { critic: first.critic, dag: dag.dag };
            }
          } catch (error) {
            if (isInterrupted(error) || problem.signal.aborted) throw error;
            problem.log(`M14: no step DAG for the repair: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return undefined;
      },

      briefing: async (session): Promise<Briefing | undefined> => {
        const work = works.get(keyOf(session));
        if (work === undefined) return undefined;
        const lines: string[] = [];
        for (const m of work.made.slice(0, 3)) {
          lines.push(`Small cases refuted "${m.hypothesis}". Repaired by a ${m.option.kind.replace("_", "-")}: ${m.option.informal}${m.option.exact ? "" : ` (it also leaves out ${m.option.lost} object(s) where it held)`}. This is an open claim${m.option.statement !== undefined ? `: ${m.option.statement}` : ""}.`);
        }
        for (const sg of work.suggestions) lines.push(`Repair suggested by the last failure (${sg.reason}): ${sg.directive}`);
        return lines.length === 0 ? undefined : { title: "Repairs", text: lines.join("\n") };
      },
    },
  };
}

export const M14 = createM14();
