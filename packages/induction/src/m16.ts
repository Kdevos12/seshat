import { hash32, hashJson, seeded, type Json } from "@seshat/core";
import { type Briefing, isInterrupted, type JsonObject, type Line, type ProblemContext, type ResumedProblem, type TaskEnd, type TaskInfo } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { sageThroughRegistry } from "@seshat/models";
import { fillTemplate, makeScorer, runSearch, type Scored, type SearchOptions, type SearchSpec } from "./evolve.ts";
import { optionReader } from "./options.ts";
import { runValues } from "./sandbox.ts";

const ACTOR = "line:M16";

/** The node kinds of the line: the task's scoring program, the programs scored, and the end of a search. */
export const SEARCH_SPEC_KIND = "search_spec";
export const SEARCH_PROGRAM_KIND = "search_program";
export const SEARCH_RESULT_KIND = "search_result";

export const M16_OPTIONS: JsonObject = {
  /** Islands, rounds, programs per round, programs shown in a prompt (the defaults are small, for our budget). */
  islands: 3,
  rounds: 8,
  samples: 2,
  shown: 2,
  /** The choice among clusters (lower: greedier) and the preference for short programs (0: none). */
  temperature: 0.5,
  lengthBias: 1,
  /** Rounds between two resets of the worse half of the islands (0: never). */
  resetEvery: 4,
  clusterSize: 4,
  /** The most programs recorded as nodes per search. */
  recordPrograms: 40,
  /** Limits of one run of a program in the sandbox. */
  callMs: 500,
  totalMs: 20_000,
  memoryMb: 128,
  /** Submit the witness through `validate` when the target score is reached (or the task has no target). */
  submit: true,
};

interface Settings extends SearchOptions {
  recordPrograms: number;
  submit: boolean;
}

export function readM16Options(raw: Readonly<JsonObject>): Settings {
  const o = optionReader("M16", raw);
  return {
    islands: o.integer("islands", 1, 20),
    rounds: o.integer("rounds", 0, 200),
    samples: o.integer("samples", 1, 10),
    shown: o.integer("shown", 1, 6),
    temperature: Math.max(0.01, Number(raw.temperature)),
    lengthBias: Math.max(0, Number(raw.lengthBias)),
    resetEvery: o.integer("resetEvery", 0, 100),
    clusterSize: o.integer("clusterSize", 1, 20),
    recordPrograms: o.integer("recordPrograms", 0, 500),
    limits: { callMs: o.integer("callMs", 10, 60_000), totalMs: o.integer("totalMs", 1000, 300_000), memoryMb: o.integer("memoryMb", 32, 1024) },
    submit: o.flag("submit"),
  };
}

/** Declares the scoring program of a claim: the task that carries it is of kind `search`. Returns the node's id; once per spec. */
export function declareSearch(memory: MemoryStore, claimId: string, spec: SearchSpec): string {
  const key = hashJson(spec as unknown as Json).slice(0, 16);
  const existing = memory.nodes(SEARCH_SPEC_KIND, { claimId }).find((n) => (n.data as { key?: string }).key === key);
  if (existing !== undefined) return existing.nodeId;
  return memory.recordNode({ kind: SEARCH_SPEC_KIND, claimId, data: { key, spec } as unknown as Json }).nodeId;
}

function isSpec(value: unknown): value is SearchSpec {
  const s = value as Partial<SearchSpec> | null;
  return typeof s === "object" && s !== null && typeof s.description === "string" && typeof s.signature === "string" && Array.isArray(s.inputs) && s.inputs.length > 0 && Array.isArray(s.seeds) && s.seeds.length > 0 && (typeof s.score === "string" || typeof s.scoreSage === "string");
}

interface Done {
  claimId: string;
  best?: { code: string; score: number };
  reached: boolean;
  witness?: Json;
  verdict?: string;
  note: string;
}

/**
 * The line M16: program search (FunSearch, plan change PC8). It works the tasks of kind `search` that carry a scoring
 * program, and the problem's claim when it does: a `search_spec` node (see `declareSearch`) holds the description,
 * the inputs, the scoring program (sandboxed JavaScript, or Sage through `compute.sage`) and the program the search
 * starts from. A database of programs in islands (clusters by score signature, a bias to short programs, resets of
 * the worse half) feeds the model's prompt; every program runs in the sandbox with time and memory limits. The
 * witness the best program builds is written as a Lean term from integers and booleans only, put in the task's proof
 * template, and submitted through `validate`: a score settles nothing. The line is on rung 2 of the ladder.
 */
export function createM16(): Line {

  async function search(problem: ProblemContext, s: Settings, claimId: string, specNode: { key: string; spec: SearchSpec }): Promise<Done> {
    const memory = problem.memory.withActor(ACTOR);
    const prior = memory.nodes(SEARCH_RESULT_KIND, { claimId }).find((n) => (n.data as { key?: string }).key === specNode.key);
    if (prior !== undefined) return (prior.data as unknown as { done: Done }).done;
    const spec = specNode.spec;
    const random = seeded(hash32(`${problem.seed ?? problem.runId}/${problem.problemId}/M16/${specNode.key}`));
    const sage = typeof spec.scoreSage === "string" ? sageThroughRegistry(problem.registry, { scope: `${problem.runId}/${problem.problemId}`, actor: ACTOR }) : undefined;
    const scorer = makeScorer(spec, { ...s.limits, seed: hash32(specNode.key) }, sage);
    const recorded = new Set(memory.nodes(SEARCH_PROGRAM_KIND, { claimId }).map((n) => (n.data as { code?: string }).code));
    let written = recorded.size;
    const result = await runSearch(problem.llm, spec, s, scorer, random, {
      signal: problem.signal,
      shouldStop: () => problem.budget.exhausted,
      events: {
        program: (e) => {
          if (!e.evaluation.ok || recorded.has(e.code) || written >= s.recordPrograms) return;
          recorded.add(e.code);
          written++;
          memory.recordNode({ kind: SEARCH_PROGRAM_KIND, claimId, data: { key: specNode.key, code: e.code, score: e.evaluation.score, signature: e.evaluation.signature, round: e.round, island: e.island } as unknown as Json });
        },
        reset: (e) => problem.log(`M16: round ${e.round}: islands ${e.islands.join(", ")} reset`),
      },
    });
    const out: Done = { claimId, reached: result.reached, note: `${result.evaluated} programs scored in ${result.rounds} rounds; stopped by ${result.stoppedBy}` };
    const best: Scored | undefined = result.best;
    if (best !== undefined) {
      out.best = { code: best.code, score: best.score };
      const input = spec.witnessInput ?? (spec.inputs[spec.inputs.length - 1] as Json);
      const built = await runValues(best.code, [input], s.limits, problem.signal);
      const witness = built.values[0];
      if (witness !== undefined) out.witness = witness;
      if (s.submit && witness !== undefined && (spec.target === undefined || result.reached)) out.verdict = await submit(problem, memory, claimId, spec, witness, out);
    }
    memory.recordNode({ kind: SEARCH_RESULT_KIND, claimId, data: { key: specNode.key, done: out } as unknown as Json });
    problem.log(`M16: ${out.note}${out.best !== undefined ? `; best score ${out.best.score}` : "; no valid program"}${out.verdict !== undefined ? `; Lean: ${out.verdict}` : ""}`);
    return out;
  }

  /** The witness becomes a claim (or the claim itself is the one settled), and Lean checks the proof. The score is not consulted again. */
  async function submit(problem: ProblemContext, memory: MemoryStore, claimId: string, spec: SearchSpec, witness: Json, out: Done): Promise<string> {
    const proof = fillTemplate(spec.proof ?? "decide", witness);
    if ("problem" in proof) return `not submitted: ${proof.problem}`;
    let target = spec.claimId ?? claimId;
    if (spec.statement !== undefined) {
      const statement = fillTemplate(spec.statement, witness);
      if ("problem" in statement) return `not submitted: ${statement.problem}`;
      const header = memory.claim(claimId)?.header;
      try {
        target = (await memory.ensureClaim({ statement: statement.text, ...(header !== undefined ? { header } : {}), origin: ACTOR, kind: "formal", parentId: problem.claimId, gloss: "the witness of a program search" })).claimId;
      } catch (error) {
        return `not submitted: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (target !== problem.claimId && !memory.edges({ from: target, kinds: ["derived_from"] }).some((e) => e.to[0] === problem.claimId)) {
        memory.addEdge({ kind: "derived_from", from: target, to: problem.claimId, note: `witness of a program search, score ${out.best?.score}` });
      }
    }
    out.claimId = target;
    const result = await problem.validate({ claimId: target, proof: proof.text });
    return `${result.verdict}${result.reasons.length > 0 ? ` (${result.reasons[0]})` : ""}`;
  }

  /** The claims that carry a search: the problem's own, and the claim of each search task a line made. */
  function searchClaims(problem: ProblemContext): string[] {
    const claims = new Set<string>([problem.claimId]);
    for (const t of problem.tasks.list({ kinds: ["search"] })) if (t.claimId !== undefined && t.status !== "failed" && t.status !== "cancelled") claims.add(t.claimId);
    return [...claims].filter((id) => problem.memory.nodes(SEARCH_SPEC_KIND, { claimId: id }).length > 0);
  }

  /** The ledger's `search` task of each claim that carries a scoring program: proposed once, whichever process asks (a resumed run finds it). */
  async function propose(problem: ProblemContext, _held?: ResumedProblem): Promise<void> {
    for (const claimId of searchClaims(problem)) {
      if (problem.tasks.list({ kinds: ["search"], claimId }).some((t) => t.proposedBy === "line:M16")) continue;
      const proposed = problem.tasks.propose({ kind: "search", claimId, acceptance: { type: "claim", claimId, minStatus: "computed" }, title: "program search for a witness" });
      if (!proposed.accepted) problem.log(`M16: the search task was refused: ${proposed.reason}`);
    }
  }

  /** Works one search task: every specification of its claim, in order. An interruption passes through and leaves the task running. */
  async function work(problem: ProblemContext, task: TaskInfo): Promise<TaskEnd> {
    const s = readM16Options(problem.options);
    const memory = problem.memory.withActor(ACTOR);
    const claimId = task.claimId ?? problem.claimId;
    const results: Done[] = [];
    let ran = 0;
    let failure: string | undefined;
    for (const node of memory.nodes(SEARCH_SPEC_KIND, { claimId })) {
      const data = node.data as { key?: string; spec?: unknown };
      if (typeof data.key !== "string" || !isSpec(data.spec)) {
        problem.log(`M16: a search_spec node of ${claimId} is not a search specification`);
        continue;
      }
      try {
        results.push(await search(problem, s, claimId, { key: data.key, spec: data.spec }));
        ran++;
      } catch (error) {
        if (isInterrupted(error) || problem.signal.aborted) throw error;
        failure = error instanceof Error ? error.message : String(error);
        problem.log(`M16: the search failed: ${failure}`);
      }
    }
    if (failure !== undefined) return { ended: "failed", reason: `the search failed: ${failure}` };
    if (ran === 0) return { ended: "failed", reason: "the claim carries no search specification" };
    const last = results.at(-1);
    return { ended: "done", reason: last?.best !== undefined ? `best score ${last.best.score}${last.reached ? ", target reached" : ""}${last.verdict !== undefined ? `; Lean: ${last.verdict}` : ""}` : "no valid program" };
  }

  /** What the searches of this problem found, read from the memory (so a resumed process has it too). */
  function found(problem: ProblemContext): Done[] {
    const out: Done[] = [];
    for (const claimId of searchClaims(problem)) for (const n of problem.memory.nodes(SEARCH_RESULT_KIND, { claimId })) out.push((n.data as unknown as { done: Done }).done);
    return out;
  }

  return {
    id: "M16",
    title: "program search for scored subgoals",
    requires: [],
    options: M16_OPTIONS,
    version: "m16-1",
    // Rung 2 of the ladder (PE4): rung 1 is the curriculum of variants.
    rung: 2,
    // The search is a function of the spec and the seed, and the model's answers are `reuse`d: a resumed process runs it again at no cost.
    resume: "rebuild",
    hooks: {
      beforeProvers: (problem) => propose(problem),
      resumeProblem: (problem, held) => propose(problem, held),
      runTask: (problem, task) => work(problem, task),
      briefing: async (session): Promise<Briefing | undefined> => {
        const results = found(session);
        const lines = results.flatMap((r) =>
          r.best === undefined
            ? []
            : [`A program search built a candidate of score ${r.best.score}${r.reached ? " (the target was reached)" : ""}${r.witness !== undefined ? `: ${JSON.stringify(r.witness).slice(0, 300)}` : ""}. ${r.verdict !== undefined ? `Lean said: ${r.verdict}.` : "It was not checked by Lean."} A score proves nothing.`],
        );
        return lines.length === 0 ? undefined : { title: "What a program search found", text: lines.join("\n") };
      },
    },
  };
}

export const M16 = createM16();

