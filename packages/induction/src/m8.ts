import { hashJson, hash32, type Json } from "@seshat/core";
import { type Briefing, isInterrupted, type JsonObject, type Line, type ProblemContext, type ResumedProblem } from "@seshat/lines";
import { type Battery, type IntegerObject, integerBattery, lookupSequence, magmaBattery, type RecognizedStatement, recognizeStatement, recordIdentification, RegistryOeis, sageThroughRegistry } from "@seshat/models";
import { RegistryLeanChecker } from "@seshat/registry";
import { admitCounterexample, cegisCounter, describeCounterexamples, readCounterexamples, recordDrop, screenBySet, tokensSavedFor } from "./cegis.ts";
import { defaultColumns } from "./columns.ts";
import { type ColumnSpec, type DataTable, buildTable, invariantDependencies, numericColumns, recordTable, readTables } from "./datatable.ts";
import { dalmatian, boundStatement, type LeanLeaf } from "./dalmatian.ts";
import { cheapTactics, formalizeHypothesis, proposeHypothesisDag, recordHypothesisDag, testLemmas, type TrivialityTest } from "./formalize.ts";
import { type Hypothesis, executeHypotheses, proposeHypotheses } from "./hypotheses.ts";
import { interestOf, type Verdicts } from "./interest.ts";
import { optionReader } from "./options.ts";
import { type PoolEntry, poolScore, prunePool, relevanceOf } from "./pool.ts";
import { guessLinearRecurrence, describeRecurrence } from "./recurrence.ts";
import { statementProblem } from "./screen.ts";

const ACTOR = "line:M8";

/** The node kinds the line writes besides the data tables. */
export const POOL_KIND = "conjecture_pool";
export const RECURRENCE_KIND = "recurrence";
/** A hypothesis the table refuted: the material of a Lakatos-style repair (line M14). */
export const REFUTED_HYPOTHESIS_KIND = "refuted_hypothesis";

/** The data of a `refuted_hypothesis` node. `verdicts` has a character for each object of the table, in order: `1` the conclusion holds where the premise does, `0` it fails there, `.` the premise does not hold or there is no verdict. */
export interface RefutedHypothesis {
  hypothesis: string;
  informal: string;
  statement?: string;
  tableId: string;
  counterexamples: string[];
  verdicts: string;
}

/** The options of the line and their defaults (`--line-option M8.rounds=3`). */
export const M8_OPTIONS: JsonObject = {
  /** Proposals in the pool before pruning, 10 to 50 (PC4 item 2). */
  conjectures: 20,
  /** Rounds of model hypotheses; a round starts from the lemmas the earlier ones and the run proved. */
  rounds: 2,
  /** Hypotheses asked for in a round. */
  perRound: 12,
  /** Numbers 0..maxNumber for a statement about a natural number. */
  maxNumber: 60,
  /** Magmas: all up to this many elements (0 to 3), then `samples` of size 4. */
  exhaustive: 2,
  samples: 40,
  /** Objects the premise must hold on for a hypothesis not to be vacuous. */
  minSupport: 3,
  /** Dalmatian bounds, recurrences and identification of the columns, before any model. */
  classical: true,
  /** Look the columns up as sequences (`oeis.search`, when the run has it). */
  identify: true,
  /** Try a hypothesis' statement in Lean on its first cases, and drop it on a failure. */
  testCases: 6,
  /** Drop a statement that cheap automation closes. */
  triviality: true,
  leanTimeoutSec: 30,
  /** Conjectures that go in the briefing. */
  briefTop: 5,
  /** Extra columns: a list of `{name, program}` (JavaScript) or `{name, sage}` (through `compute.sage`). */
  columns: [],
  /** The limit of the whole run of one program in the sandbox, in milliseconds. */
  programMs: 20_000,
};

interface Settings {
  conjectures: number;
  rounds: number;
  perRound: number;
  maxNumber: number;
  exhaustive: number;
  samples: number;
  minSupport: number;
  classical: boolean;
  identify: boolean;
  testCases: number;
  triviality: boolean;
  leanTimeoutSec: number;
  briefTop: number;
  columns: ColumnSpec[];
  programMs: number;
}

export function readM8Options(raw: Readonly<JsonObject>): Settings {
  const o = optionReader("M8", raw);
  const columns = o.list("columns").map((c, i) => {
    const column = c as Partial<ColumnSpec>;
    if (typeof column !== "object" || column === null || typeof column.name !== "string" || (column.program === undefined) === (column.sage === undefined)) {
      throw new TypeError(`option M8.columns[${i}] needs a name and one of program and sage`);
    }
    return column as ColumnSpec;
  });
  return {
    conjectures: o.integer("conjectures", 10, 50),
    rounds: o.integer("rounds", 0, 6),
    perRound: o.integer("perRound", 1, 30),
    maxNumber: o.integer("maxNumber", 5, 300),
    exhaustive: o.integer("exhaustive", 0, 3),
    samples: o.integer("samples", 0, 500),
    minSupport: o.integer("minSupport", 1, 50),
    classical: o.flag("classical"),
    identify: o.flag("identify"),
    testCases: o.integer("testCases", 0, 50),
    triviality: o.flag("triviality"),
    leanTimeoutSec: o.integer("leanTimeoutSec", 1, 600),
    briefTop: o.integer("briefTop", 0, 20),
    columns,
    programMs: o.integer("programMs", 1000, 300_000),
  };
}

/** A conjecture on its way to the pool. */
interface Candidate {
  statement: string;
  informal: string;
  source: string;
  interest: number;
  hypothesisId?: string;
}

/** What the line keeps of a problem; rebuilt from the memory by `run`. */
interface Work {
  table?: DataTable;
  entries: PoolEntry[];
  pruned: number;
  headline: string[];
}

export interface M8Hooks {
  /** The triviality test; default: the cheap tactics through the run's Lean. The classical battery of Task 6 can replace it. */
  triviality?: (problem: ProblemContext) => TrivialityTest | undefined;
}

function objectsFor(statement: RecognizedStatement, s: Settings, seed: number): { family: "integers" | "magmas"; battery: Battery } {
  return statement.kind === "nat"
    ? { family: "integers", battery: integerBattery(s.maxNumber, { min: 0 }) }
    : { family: "magmas", battery: magmaBattery({ exhaustive: s.exhaustive, sampleSize: 4, samples: s.samples, seed: seed & 0x7fffffff }) };
}

function verdicts(table: DataTable, column: string): Verdicts {
  const c = table.columns.findIndex((x) => x.name === column);
  return table.rows.map((row) => (typeof row[c] === "boolean" ? (row[c] as boolean) : null));
}

/**
 * The line M8 (plan, Task 13): the inductive engine. Before the provers it builds a data table of small objects
 * of the target's domain (the natural numbers, the magmas), runs the classical conjecturing on it (Dalmatian
 * bounds, recurrences, identification), asks a model for executable hypotheses, keeps those the objects do not
 * refute and a test lemma in Lean does not refute, and turns the best into a pool of `open` claims with a
 * `derived_from` edge to the target, scored and pruned. The provers see the pool in their briefing. No claim
 * leaves `open` here: a conjecture changes status only when a prover submits a Lean proof through `validate`.
 * A recurrence, a relation or a bound found by a program is an evidence node, not a status (Rulings 13, 22).
 *
 * Models and Lean are used through the run's `Llm` and registry. Resuming runs the pipeline again from the
 * journal and the memory: claims, tables and edges are not written twice, and the model calls are `reuse`d.
 */
export function createM8(hooks: M8Hooks = {}): Line {
  const works = new Map<string, Work>();
  const keyOf = (p: ProblemContext): string => `${p.runId}/${p.problemId}`;

  async function run(problem: ProblemContext, _held?: ResumedProblem): Promise<void> {
    const s = readM8Options(problem.options);
    const memory = problem.memory.withActor(ACTOR);
    const work: Work = { entries: [], pruned: 0, headline: [] };
    works.set(keyOf(problem), work);
    const target = memory.claim(problem.claimId);
    if (target === undefined) return;
    const recognized = recognizeStatement(target.statement);
    if (!("statement" in recognized)) {
      problem.log(`M8: the target is not a statement about numbers or magmas (${recognized.reason}); no table`);
      return;
    }
    const seed = hash32(`${problem.seed ?? problem.runId}/${problem.problemId}/M8`);
    const { family, battery } = objectsFor(recognized.statement, s, seed);
    const header = target.header ?? "";
    const limits = { totalMs: s.programMs, seed };
    const sage = s.columns.some((c) => c.sage !== undefined) ? sageThroughRegistry(problem.registry, { scope: `${problem.runId}/${problem.problemId}`, actor: ACTOR }) : undefined;
    try {
      const table = await buildTable({
        family,
        objects: battery.objects.map((o) => (o.kind === "integer" ? o.value : o)) as unknown as Json[],
        objectIds: battery.objects.map((o) => o.id),
        columns: [...defaultColumns(family), ...s.columns],
        ...(sage !== undefined ? { sage, sageObject: "Integer(i)" } : {}),
        limits,
        signal: problem.signal,
      });
      work.table = table;
      recordTable(memory, problem.claimId, table, ACTOR);
      for (const note of table.notes) problem.log(`M8: ${note}`);

      const candidates: Candidate[] = [];
      if (s.classical) await classical(problem, s, table, family, candidates, work);
      // A resumed problem keeps the pool it already made: the model rounds are not paid again (their prompts carry what was
      // proved by then, so `reuse` would miss) and the pool does not grow with each resume.
      if (rebuildPool(problem, work)) return;
      if (s.rounds > 0) {
        // The classical candidates are free and already in `candidates`: a model round that fails (the budget, Lean) does not lose them.
        try {
          await models(problem, s, table, target.statement, header, candidates, hooks);
        } catch (error) {
          if (isInterrupted(error) || problem.signal.aborted) throw error;
          problem.log(`M8: the model rounds stopped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await pool(problem, s, header, candidates, work);
    } catch (error) {
      // An interruption is the run pausing, not a failure; the resumed process runs this again.
      if (isInterrupted(error) || problem.signal.aborted) throw error;
      problem.log(`M8: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Rebuilds the work from the newest pool node of the problem; false when there is none. */
  function rebuildPool(problem: ProblemContext, work: Work): boolean {
    const memory = problem.memory.withActor(ACTOR);
    const nodes = memory.nodes(POOL_KIND, { claimId: problem.claimId });
    const last = nodes[nodes.length - 1];
    if (last === undefined) return false;
    const data = last.data as unknown as { entries?: Array<{ claimId: string; relevance: number; interest: number }>; kept?: string[]; pruned?: unknown[] };
    const byId = new Map((data.entries ?? []).map((e) => [e.claimId, e]));
    const entries: PoolEntry[] = [];
    for (const id of data.kept ?? []) {
      const claim = memory.claim(id);
      const saved = byId.get(id);
      if (claim === undefined || saved === undefined) continue;
      entries.push(entryOf(memory, id, claim.statement, saved.relevance, saved.interest));
    }
    work.entries = entries;
    work.pruned = data.pruned?.length ?? 0;
    problem.log(`M8: resumed with the pool of ${data.entries?.length ?? 0} conjectures made before; ${entries.length} kept, no new model call`);
    return true;
  }

  async function classical(problem: ProblemContext, s: Settings, table: DataTable, family: string, out: Candidate[], work: Work): Promise<void> {
    const memory = problem.memory.withActor(ACTOR);
    const numeric = numericColumns(table);
    // Dalmatian bounds on the columns that have a Lean form: the statement is a conjecture, the table only suggests it.
    if (family === "integers") {
      const leaves: Record<string, LeanLeaf> = {};
      for (const c of table.columns) if (c.lean !== undefined && numeric.some((n) => n.name === c.name)) leaves[c.name] = { term: c.lean, type: "ℕ" };
      for (const target of Object.keys(leaves).filter((n) => n !== "n" && n !== "sigma").slice(0, 2)) {
        for (const direction of ["upper", "lower"] as const) {
          const result = dalmatian(numeric, { target, direction, maxSize: 4, maxExpressions: 5000 });
          for (const bound of result.conjectures.slice(0, 3)) {
            const statement = boundStatement(bound, "(n : ℕ)", leaves);
            if (statement === undefined || bound.exact) continue;
            out.push({ statement, informal: bound.text, source: "dalmatian", interest: Math.min(1, 0.4 + bound.tight.length / Math.max(1, bound.objects)) });
          }
        }
      }
    }
    // A recurrence guessed from a column read in order of the objects (the numbers): evidence, with the statement left to a prover.
    if (family === "integers") {
      for (const c of numeric) {
        const terms = c.values.map((v) => (v === null ? null : v));
        if (terms.some((t) => t === null || !Number.isInteger(t) || (t as number) < 0) || c.name === "n") continue;
        const rec = guessLinearRecurrence(terms as number[], { maxOrder: 6 });
        if (rec === undefined) continue;
        const description = describeRecurrence(rec);
        if (!memory.nodes(RECURRENCE_KIND, { claimId: problem.claimId }).some((n) => (n.data as { column?: string }).column === c.name)) {
          memory.recordNode({ kind: RECURRENCE_KIND, claimId: problem.claimId, data: { column: c.name, recurrence: description, terms: terms.length } });
        }
        work.headline.push(`the column ${c.name} satisfies ${description} on the ${terms.length} numbers tried (unproved)`);
      }
      if (s.identify) {
        const oeis = new RegistryOeis(problem.registry, { actor: ACTOR });
        for (const c of numeric.filter((x) => x.name === "divisors" || x.name === "digitsum")) {
          try {
            const terms = c.values.slice(1, 41);
            if (terms.some((v) => v === null)) continue;
            const subject = `the column ${c.name} of the numbers 1 to ${terms.length}`;
            if (memory.nodes("identification", { claimId: problem.claimId }).some((n) => (n.data as { subject?: string }).subject === subject)) continue;
            const identification = await lookupSequence(terms as number[], { oeis }, { signal: problem.signal });
            recordIdentification(memory, { claimId: problem.claimId, subject, identification });
          } catch (error) {
            if (isInterrupted(error) || problem.signal.aborted) throw error;
            problem.log(`M8: identification of ${c.name} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    for (const dep of invariantDependencies(table).slice(0, 12)) work.headline.push(`${dep.kind}: ${dep.from} -> ${dep.to} on ${dep.rows} objects`);
  }

  async function models(problem: ProblemContext, s: Settings, table: DataTable, targetStatement: string, header: string, out: Candidate[], hooks: M8Hooks): Promise<void> {
    const memory = problem.memory.withActor(ACTOR);
    const checker = new RegistryLeanChecker(problem.registry, { actor: ACTOR });
    const triviality = s.triviality ? (hooks.triviality?.(problem) ?? cheapTactics(checker, { timeoutSec: s.leanTimeoutSec })) : undefined;
    const known: string[] = out.map((c) => c.informal);
    const seen: Verdicts[] = [];
    for (let round = 1; round <= s.rounds; round++) {
      // What the run proved so far feeds the next round.
      for (const c of memory.claims({ statuses: ["proved", "computed"], kind: "formal" })) if (c.parentId === problem.claimId || c.origin === ACTOR) known.push(c.statement);
      // PD5: the counterexamples checkers found so far go into the prompt, and every candidate meets them before it costs anything.
      const set = readCounterexamples(memory, problem.claimId);
      const proposed = await proposeHypotheses(problem.llm, { target: targetStatement, table, count: s.perRound, known: [...new Set(known)].slice(0, 20), round, ...(set.length > 0 ? { counterexamples: describeCounterexamples(set) } : {}) });
      for (const r of proposed.refused) problem.log(`M8: ${r}`);
      const screened = await screenBySet(proposed.hypotheses, set, { totalMs: s.programMs }, problem.signal);
      for (const d of screened.dropped) {
        // Would the table alone have stopped it? Only a candidate it lets through is a saving in the model-priced steps that follow.
        const [alone] = await executeHypotheses(table, [d.hypothesis], { totalMs: s.programMs }, problem.signal);
        const saved = alone !== undefined && alone.counterexamples.length === 0 ? tokensSavedFor(d.hypothesis, targetStatement) : 0;
        recordDrop(memory, problem.claimId, { line: ACTOR, candidate: `${round}/${d.hypothesis.id}`, by: d.by, tokensSaved: saved });
        problem.log(`M8: ${d.hypothesis.id} fails the known counterexample ${d.by.id} (${d.by.source}): dropped before any check`);
      }
      const executed = await executeHypotheses(table, screened.kept, { totalMs: s.programMs }, problem.signal);
      const properties = table.columns.map((c) => verdicts(table, c.name)).filter((v) => v.some((x) => x !== null));
      for (const e of executed) {
        const h: Hypothesis = e.hypothesis;
        if (e.counterexamples.length > 0) {
          problem.log(`M8: ${h.id} is refuted by ${e.counterexamples.length} object(s) of the table, e.g. ${table.objectIds[e.counterexamples[0] as number]}`);
          for (const i of e.counterexamples.slice(0, 3)) admitCounterexample(memory, problem.claimId, { object: table.objects[i] as Json, id: table.objectIds[i] as string, source: "table_run", refutes: h.id });
          if (!memory.nodes(REFUTED_HYPOTHESIS_KIND, { claimId: problem.claimId }).some((n) => (n.data as unknown as RefutedHypothesis).hypothesis === h.id && (n.data as unknown as RefutedHypothesis).tableId === table.id)) {
            const verdicts = e.conclusion.map((c, i) => (c === null || (e.premise !== undefined && e.premise[i] !== true) ? "." : c ? "1" : "0")).join("");
            const data: RefutedHypothesis = { hypothesis: h.id, informal: h.informal, ...(h.statement !== undefined ? { statement: h.statement } : {}), tableId: table.id, counterexamples: e.counterexamples.slice(0, 20).map((i) => table.objectIds[i] as string), verdicts };
            memory.recordNode({ kind: REFUTED_HYPOTHESIS_KIND, claimId: problem.claimId, data: data as unknown as Json });
          }
          continue;
        }
        const interest = interestOf({ ...(e.premise !== undefined ? { premise: e.premise } : {}), conclusion: e.conclusion }, seen.map((v) => ({ conclusion: v })), properties, { minSupport: s.minSupport });
        if (interest.vacuous) continue;
        seen.push(e.conclusion);
        let statement = h.statement;
        if (statement === undefined) {
          // An informal hypothesis goes through the step DAG before it is stated (plan change PC11 item 2).
          const dag = await proposeHypothesisDag(problem.llm, h, targetStatement, { round });
          if (dag.dag === undefined) {
            problem.log(`M8: no step DAG for ${h.id}: ${dag.problems.join("; ")}`);
            continue;
          }
          await recordHypothesisDag(memory, problem.claimId, h.id, dag.dag);
          const f = await formalizeHypothesis(problem.llm, h, targetStatement, header, { dag: dag.dag });
          if (f.statement === undefined) {
            problem.log(`M8: ${h.id} was not formalized: ${f.problem ?? "no statement"}`);
            continue;
          }
          statement = f.statement;
        }
        if (statementProblem(statement) !== undefined) continue;
        if (s.testCases > 0 && table.family === "integers") {
          const t = await testLemmas(checker, header, statement, s.testCases, { timeoutSec: s.leanTimeoutSec, signal: problem.signal });
          if (t.result === "failed") {
            problem.log(`M8: the test lemma refutes ${h.id} at case ${t.failedAt}`);
            if (t.failedAt !== undefined) admitCounterexample(memory, problem.claimId, { object: t.failedAt, id: String(t.failedAt), source: "lean_decide", refutes: h.id });
            continue;
          }
        }
        if (triviality !== undefined && (await triviality(statement, header, problem.signal)).trivial) {
          problem.log(`M8: ${h.id} is trivial (closed by cheap automation)`);
          continue;
        }
        out.push({ statement, informal: h.informal, source: `model:${h.level}`, interest: interest.score, hypothesisId: h.id });
        known.push(h.informal);
      }
    }
  }

  async function pool(problem: ProblemContext, s: Settings, header: string, candidates: Candidate[], work: Work): Promise<void> {
    const memory = problem.memory.withActor(ACTOR);
    const unique = new Map<string, Candidate>();
    for (const c of candidates) if (!unique.has(c.statement)) unique.set(c.statement, c);
    const picked = [...unique.values()].sort((a, b) => b.interest - a.interest).slice(0, s.conjectures);
    const target = memory.claim(problem.claimId)?.statement ?? "";
    const entries: PoolEntry[] = [];
    // The open conjectures this line already made for the target count against `conjectures`, whatever the process that made them.
    const earlier = memory.claims({ statuses: ["open"], kind: "formal" }).filter((c) => c.origin === ACTOR && c.parentId === problem.claimId);
    const known = new Set(earlier.map((c) => c.statement));
    let total = earlier.length;
    for (const c of picked) {
      // Every candidate is screened here, whatever made it: a column's Lean term and a Dalmatian bound included.
      const problemText = statementProblem(c.statement);
      if (problemText !== undefined) {
        problem.log(`M8: a ${c.source} conjecture was not kept: ${problemText}`);
        continue;
      }
      if (!known.has(c.statement)) {
        if (total >= s.conjectures) continue;
        total++;
      }
      let claimId: string;
      try {
        claimId = (await memory.ensureClaim({ statement: c.statement, ...(header !== "" ? { header } : {}), origin: ACTOR, kind: "formal", parentId: problem.claimId, gloss: c.informal })).claimId;
      } catch (error) {
        if (isInterrupted(error) || problem.signal.aborted) throw error;
        problem.log(`M8: ${c.source} conjecture refused: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (claimId === problem.claimId) continue;
      if (memory.edges({ from: claimId, kinds: ["derived_from"] }).every((e) => e.to[0] !== problem.claimId)) {
        memory.addEdge({ kind: "derived_from", from: claimId, to: problem.claimId, note: `${c.source}: ${c.informal.slice(0, 200)}` });
      }
      const relevance = await relevanceOf({ ...(problem.decide !== undefined ? { decide: problem.decide } : {}), llm: problem.llm, log: problem.log }, target, c.statement);
      entries.push(entryOf(memory, claimId, c.statement, relevance.value, c.interest));
    }
    const pruned = prunePool(entries, { keep: s.briefTop });
    work.entries = pruned.kept;
    work.pruned = pruned.pruned.length;
    const key = hashJson({ claim: problem.claimId, statements: entries.map((e) => e.statement).sort() } as unknown as Json).slice(0, 16);
    if (!memory.nodes(POOL_KIND, { claimId: problem.claimId }).some((n) => (n.data as { key?: string }).key === key)) {
      memory.recordNode({
        kind: POOL_KIND,
        claimId: problem.claimId,
        data: { key, entries: entries.map((e) => ({ claimId: e.claimId, relevance: e.relevance, interest: e.interest })), kept: pruned.kept.map((e) => e.claimId), pruned: pruned.pruned.map((p) => ({ claimId: p.entry.claimId, reason: p.reason })) } as unknown as Json,
      });
    }
    const counter = cegisCounter(memory, problem.claimId);
    problem.log(`M8: ${entries.length} conjectures in the pool, ${pruned.kept.length} kept${counter.dropped > 0 ? `; the counterexample set dropped ${counter.dropped} candidate(s), about ${counter.tokensSaved} tokens saved` : ""}`);
  }

  return {
    id: "M8",
    title: "inductive engine",
    requires: [],
    options: M8_OPTIONS,
    version: "m8-1",
    // The tables, claims, edges and pool nodes are in the memory and are not written twice; the model calls are `reuse`d.
    resume: "rebuild",
    hooks: {
      beforeProvers: (problem) => run(problem),
      resumeProblem: (problem, held) => run(problem, held),
      // The state of a problem that is over is not kept for the life of the process.
      afterProblem: async (problem) => {
        works.delete(keyOf(problem));
      },
      briefing: async (session): Promise<Briefing | undefined> => {
        const work = works.get(keyOf(session));
        if (work === undefined) return undefined;
        // The proof rate and the proofs' length are read now: the pool is re-scored with what the attempts did since.
        const entries = work.entries.map((e) => entryOf(session.memory, e.claimId, e.statement, e.relevance, e.interest)).sort((a, b) => poolScore(b) - poolScore(a));
        const lines: string[] = [];
        if (entries.length > 0) {
          lines.push("Conjectures found by testing small cases (each is an open claim: none is proved, and any may be false). If one helps, state it as an `aux_` lemma and prove it, or use it as a plan:");
          for (const e of entries) {
            const status = session.memory.claim(e.claimId)?.status;
            lines.push(`- ${e.statement}${status !== undefined && status !== "open" ? ` [${status}]` : ""}`);
          }
        }
        for (const h of work.headline.slice(0, 5)) lines.push(`Observed on the table: ${h}.`);
        return lines.length === 0 ? undefined : { title: "What small cases suggest", text: lines.join("\n") };
      },
    },
  };
}

function entryOf(memory: ProblemContext["memory"], claimId: string, statement: string, relevance: number, interest: number): PoolEntry {
  const attempts = memory.attempts(claimId);
  const proved = attempts.filter((a) => a.outcome === "valid").length;
  const shortest = memory.storedProofs(claimId).filter((p) => p.verdict === "valid" && p.text !== undefined).map((p) => (p.text as string).length).sort((a, b) => a - b)[0];
  return { claimId, statement, relevance, interest, attempts: attempts.length, proved, ...(shortest !== undefined ? { proofChars: shortest } : {}) };
}

/** The instance the orchestrator registers; one object per run keeps the per-problem state (`createM8`). */
export const M8 = createM8();
