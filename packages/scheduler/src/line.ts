import { hash32, seeded } from "@seshat/core";
import {
  Atms, checkEdge, GraphState, linkFor, lemmaValue, memorySource, parseSignature, realize,
} from "@seshat/graph";
import { LeanMeta } from "@seshat/lean-meta";
import {
  type Briefing, completeJson, isInterrupted, JsonAnswerError, type JsonObject, type Line, LINE_TITLES, type ProblemContext, type ScheduledTask, type TaskEnd, type TaskInfo,
} from "@seshat/lines";
import { GivenClause, type Clause } from "./kernel.ts";
import { linkProof, readSketch, type SketchReading } from "./holes.ts";
import { leafPrice, priceBook, taskWeight } from "./pricing.ts";
import { ProofNumbers, type PnClaim, type PnGroup } from "./proofnumbers.ts";
import {
  asRecord, SESSION_KIND, type SessionRecord, SKETCH_KIND, type SketchRecord, SUBSUMPTION_KIND, type SubsumptionRecord,
} from "./records.ts";
import { backwardSubsume, forwardSubsume, isLinkLemma, type SubsumeOptions } from "./subsume.ts";

/** The options of line M12, with their defaults (`--line-option M12.innerSessions=4`). */
export const M12_OPTIONS = {
  /** Work on the named holes of a sketch as subgoals of their own. */
  subgoals: true,
  /** Sessions of the inner prover on one hole before its task fails (PC4 item 1). */
  innerSessions: 8,
  /** The most tasks the scheduler makes for one problem (PC4 item 1: max-inner-tasks). */
  maxInnerTasks: 8,
  /** The most tasks worked between two outer sessions. */
  stepTasks: 2,
  /** Tasks a hole may have in all: the first, and retries after one failed. */
  rounds: 2,
  /** The given-clause ratio: of `age + weight` picks, `age` take the oldest ready task and `weight` the lightest. */
  ageRatio: 1,
  weightRatio: 4,
  /** Close claims that are instances of known facts, and claims a new fact covers, through lean.meta and Lean-checked edges. */
  subsumption: true,
  /** The most facts compared with a claim in one lean.meta call. */
  subsumeFacts: 40,
  /** Move a problem up the escalation ladder when its budget is spent without Lean progress. */
  ladder: true,
  /** The fractions of the problem's budget spent without progress that move it up: the first rung, the second... */
  fractions: [0.3, 0.6] as number[],
  /** Seeds the scheduler's draws. Null: the run's seed. */
  seed: null,
} satisfies JsonObject;

interface Settings {
  subgoals: boolean;
  innerSessions: number;
  maxInnerTasks: number;
  stepTasks: number;
  rounds: number;
  age: number;
  weight: number;
  subsumption: boolean;
  subsumeFacts: number;
  seed: string | number | null;
}

function settings(options: Readonly<JsonObject>): Settings {
  const num = (key: keyof typeof M12_OPTIONS, least: number): number => {
    const value = options[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(least, Math.floor(value)) : (M12_OPTIONS[key] as number);
  };
  const flag = (key: keyof typeof M12_OPTIONS): boolean => (typeof options[key] === "boolean" ? (options[key] as boolean) : (M12_OPTIONS[key] as boolean));
  const seed = options.seed;
  return {
    subgoals: flag("subgoals"),
    innerSessions: num("innerSessions", 1),
    maxInnerTasks: num("maxInnerTasks", 0),
    stepTasks: num("stepTasks", 1),
    rounds: num("rounds", 1),
    age: num("ageRatio", 0),
    weight: num("weightRatio", 0),
    subsumption: flag("subsumption"),
    subsumeFacts: num("subsumeFacts", 1),
    seed: typeof seed === "number" || typeof seed === "string" ? seed : null,
  };
}

const ACTOR = "line:M12";
const SITE_INNER = "scheduler.inner";
const accepted = (status: string | undefined): boolean => status === "computed" || status === "proved";

/** What the line keeps for a problem, all of it made again from the journal and the memory by `begin`. */
interface Work {
  state: GraphState;
  header: string;
  /** Derivations submitted (`realize`), comparisons made (`subsume`). */
  tried: Set<string>;
  seen: Set<string>;
  down: { count: number };
  /** Facts already compared against the open holes. */
  swept: Set<string>;
  meta: LeanMeta;
}

function sessionRecords(problem: ProblemContext): SessionRecord[] {
  return problem.memory
    .nodes(SESSION_KIND)
    .map((node) => asRecord<SessionRecord>(node.data))
    .filter((record) => record.problemId === problem.problemId);
}

function sketchRecords(problem: ProblemContext): Array<{ nodeId: string; record: SketchRecord }> {
  return problem.memory
    .nodes(SKETCH_KIND, { claimId: problem.claimId })
    .map((node) => ({ nodeId: node.nodeId, record: asRecord<SketchRecord>(node.data) }))
    .filter(({ record }) => record.problemId === problem.problemId);
}

/** The tasks the scheduler made for the problem, in the order they were made. */
const ownTasks = (problem: ProblemContext): TaskInfo[] => problem.tasks.list({ kinds: ["prove"] }).filter((task) => task.proposedBy === ACTOR);

/** The text without the indentation all its lines share. */
function dedent(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(cut)).join("\n");
}

const clip = (text: string, n: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The line M12 (plan §6, documentation/scheduler.md): the saturation kernel and the subgoal scheduler.
 *
 * - **Subgoals.** After each outer session, the named holes of its sketch (lemmas `aux_...` whose whole proof is `sorry`)
 *   become claims, joined to the problem's claim by a `decomposes_into` edge whose link lemma Lean checks, and each
 *   unproved hole becomes a `prove` task with an inner budget (PC4 item 1).
 * - **Scheduling.** Between sessions the orchestrator asks the line (`schedule`) which ready task to work on. A given-clause
 *   loop with an age/weight ratio chooses it (fairness against starvation); the weight of a task is its price, drawn from the
 *   Beta posterior of the inner sessions' results by the run's seeded source, over one plus the value of its lemma (Task 5's
 *   labels), and the leaf that weighted proof numbers on the AND/OR graph call most proving goes first among the lightest.
 * - **Inner provers.** The work on a task is a few model calls, each answered by a proof that goes through `validate`; the
 *   hole's claim changes status only if Lean accepts it. When all the holes of a checked decomposition are accepted, the graph
 *   derives the parent, and the composed proof goes through `validate` like any other (`realize`).
 * - **Simplify early, generate late** (saturation provers' rule). In every step the scheduler first simplifies and only then generates:
 *   it registers the new sketches and closes the holes that known facts cover (forward subsumption), sweeps the open holes against
 *   the facts proved since (backward subsumption), and propagates what is derived, and only after that makes tasks and chooses
 *   among them, so that no inner session is spent on a claim a known fact already closes.
 * - **Subsumption.** A new claim that `lean.meta` finds to be an instance of a known fact, and an open claim that a new fact
 *   covers, get an `instance_of` edge that Lean checks; a claim closes through a checked edge only.
 * - **Briefing.** The lemmas the scheduler proved reach the outer prover's next briefing with their names.
 *
 * The state the line keeps lives in the memory's nodes and the ledger's tasks, and `begin` makes it again, so the line resumes.
 */
export function createM12Line(): Line {
  const works = new Map<string, Work>();
  const keyOf = (problem: ProblemContext) => `${problem.runId}/${problem.problemId}`;

  async function soft(problem: ProblemContext, what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      // An interruption (a turn that ended, a process that is stopping) is never a failure of this step: it goes on to the orchestrator.
      if (isInterrupted(error)) throw error;
      if (problem.signal.aborted) return;
      problem.log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function propagate(problem: ProblemContext, work: Work): Promise<void> {
    work.state.sync();
    await realize({
      memory: problem.memory,
      state: work.state,
      validate: problem.validate,
      headerOf: (id) => (id === problem.claimId ? work.header : problem.memory.claim(id)?.header),
      limit: 8,
      tried: work.tried,
      problemId: problem.problemId,
      signal: problem.signal,
      log: problem.log,
    });
    work.state.sync();
  }

  function subsumeOptions(problem: ProblemContext, work: Work, s: Settings): SubsumeOptions {
    return {
      meta: work.meta, memory: problem.memory, validate: problem.validate, header: work.header, limit: s.subsumeFacts,
      signal: problem.signal, log: problem.log, seen: work.seen, down: work.down,
    };
  }

  function recordSubsumed(problem: ProblemContext, direction: SubsumptionRecord["direction"], found: Array<{ instance: string; general: string; edgeId: string; checked: boolean }>): void {
    for (const f of found) {
      const record: SubsumptionRecord = { problemId: problem.problemId, direction, instance: f.instance, general: f.general, edgeId: f.edgeId, checked: f.checked };
      problem.memory.recordNode({ kind: SUBSUMPTION_KIND, claimId: f.instance, data: { ...record } });
    }
  }

  /** The holes of the recorded sketches that are open and have no task that can still run, get one (PC4 item 1). */
  function ensureTasks(problem: ProblemContext, s: Settings): void {
    if (!s.subgoals) return;
    const tasks = ownTasks(problem);
    for (const { record } of sketchRecords(problem)) {
      if (!record.healthy || !record.registered) continue;
      for (const [k, claimId] of record.holes.entries()) {
        if (problem.memory.claim(claimId)?.status !== "open") continue;
        const mine = tasks.filter((task) => task.claimId === claimId);
        if (mine.some((task) => task.status !== "done" && task.status !== "failed" && task.status !== "cancelled")) continue;
        // PC4 item 1: the cap is per outer session, that is per sketch: the tasks of this sketch's holes, not of every sketch the problem has had.
        if (mine.length >= s.rounds || tasks.filter((task) => task.claimId !== undefined && record.holes.includes(task.claimId)).length >= s.maxInnerTasks) continue;
        const last = mine.at(-1);
        const proposed = problem.tasks.propose({
          kind: "prove",
          claimId,
          acceptance: { type: "claim", claimId, minStatus: "computed" },
          budget: { sessions: s.innerSessions },
          ...(last !== undefined ? { parentTaskId: last.taskId } : {}),
          title: `${record.names[k] ?? "a hole"}: ${clip(problem.memory.claim(claimId)?.statement ?? "", 60)}`,
        });
        if (proposed.accepted) tasks.push(problem.tasks.get(proposed.taskId) as TaskInfo);
        else problem.log(`the task for ${record.names[k] ?? claimId} was refused: ${proposed.reason}`);
      }
    }
  }

  /**
   * What the sessions ended with, made into claims: for each sketch recorded and not yet registered, its holes become claims,
   * the problem's claim gets a `decomposes_into` edge to them that Lean checks (the link lemma is proved from the sketch's own main
   * proof), the holes that are instances of known facts close, and the rest get their tasks. Everything here can be done twice.
   */
  async function registerAll(problem: ProblemContext, work: Work, s: Settings): Promise<void> {
    for (const { nodeId, record } of sketchRecords(problem)) {
      if (record.registered) continue;
      const parent = problem.memory.claim(problem.claimId);
      const header = work.header;
      const stored = problem.memory.blobs.get(record.submission);
      if (!record.healthy || parent === undefined || stored === undefined) {
        problem.memory.updateNode(nodeId, { registered: true }, "the sketch is not split");
        continue;
      }
      const submission = JSON.parse(stored) as { aux: string; proof: string };
      const reading: SketchReading = readSketch(submission);
      const names = reading.holes.map((h) => h.name);
      const holes: string[] = [];
      for (const hole of reading.holes) {
        const ensured = await problem.memory.ensureClaim({
          statement: hole.statement, header, origin: ACTOR, parentId: problem.claimId, kind: "formal",
          gloss: `${hole.name}, a hole of the sketch of attempt ${record.attemptId}`,
        });
        holes.push(ensured.claimId);
      }
      // The decomposition: the problem's claim from its holes, once Lean has checked that the sketch's main proof closes it.
      let edge = problem.memory.edges({ from: problem.claimId, kinds: ["decomposes_into"] }).find((e) => e.to.length === holes.length && holes.every((h) => e.to.includes(h)));
      if (edge === undefined) {
        const link = linkFor("decomposes_into", { id: problem.claimId, statement: parent.statement }, holes.map((id) => ({ id, statement: problem.memory.claim(id)?.statement ?? "" })));
        if (link !== undefined) edge = problem.memory.addEdge({ kind: "decomposes_into", from: problem.claimId, to: holes, link, note: `the sketch of ${record.attemptId}` });
      }
      if (edge !== undefined && edge.status !== "lean_checked") {
        const proof = linkProof(submission, reading, parseSignature(parent.statement).binders);
        const check = await checkEdge(
          { memory: problem.memory, validate: problem.validate, header, closers: [], propose: async () => [{ proof: proof.proof, aux: proof.aux }], log: problem.log },
          edge.edgeId,
        );
        problem.log(`sketch of ${record.attemptId}: the decomposition into ${names.join(", ")} is ${check.checked ? "checked" : `not checked (${check.reason})`}`);
      }
      // The known facts the new holes are instances of close them without a model.
      if (s.subsumption) {
        for (const claimId of holes) {
          if (problem.memory.claim(claimId)?.status !== "open") continue;
          const found = await forwardSubsume(subsumeOptions(problem, work, s), claimId);
          recordSubsumed(problem, "forward", found);
        }
      }
      await propagate(problem, work);
      problem.memory.updateNode(nodeId, { registered: true, names, holes, ...(edge !== undefined ? { edgeId: edge.edgeId } : {}) }, "the sketch is registered");
      ensureTasks(problem, s);
    }
  }

  /** A new fact covers open holes: they close through checked `instance_of` edges. */
  async function sweep(problem: ProblemContext, work: Work, s: Settings): Promise<void> {
    if (!s.subsumption) return;
    const open = sketchRecords(problem).flatMap(({ record }) => record.holes).filter((id, k, all) => all.indexOf(id) === k && problem.memory.claim(id)?.status === "open");
    if (open.length === 0) return;
    const facts = problem.memory.claims({ statuses: ["computed", "proved"], header: work.header, kind: "formal" }).filter((claim) => !isLinkLemma(claim));
    for (const fact of facts) {
      if (work.swept.has(fact.claimId)) continue;
      work.swept.add(fact.claimId);
      const found = await backwardSubsume(subsumeOptions(problem, work, s), fact.claimId, open);
      recordSubsumed(problem, "backward", found);
      if (found.some((f) => f.checked)) await propagate(problem, work);
    }
  }

  async function begin(problem: ProblemContext): Promise<void> {
    const s = settings(problem.options);
    const seen = new Set<string>();
    for (const node of problem.memory.nodes(SUBSUMPTION_KIND)) {
      const r = asRecord<SubsumptionRecord>(node.data);
      if (r.problemId === problem.problemId) seen.add(`${r.instance}|${r.general}`);
    }
    const work: Work = {
      state: new GraphState(problem.memory, [problem.claimId, ...sketchRecords(problem).flatMap(({ record }) => record.holes)]),
      header: problem.target.sketch.prefix,
      tried: new Set(),
      seen,
      down: { count: 0 },
      swept: new Set(),
      meta: new LeanMeta(problem.registry, { actor: ACTOR }),
    };
    works.set(keyOf(problem), work);
    // What a cut left undone: the tasks of the sketches already recorded.
    ensureTasks(problem, s);
  }

  /** The price, the value and the proof numbers behind a choice, and the choice. */
  function choose(problem: ProblemContext, work: Work, s: Settings, ready: readonly TaskInfo[]): { task: TaskInfo; rule: "age" | "weight"; weight: number } | undefined {
    const own = ownTasks(problem);
    const picks = own.filter((task) => task.status !== "pending" && task.status !== "ready" && task.status !== "blocked").length;
    const random = seeded(hash32(`${s.seed ?? problem.seed ?? problem.runId}:m12:${problem.problemId}:${picks}`));
    const book = priceBook(sessionRecords(problem));
    work.state.sync();
    const labels = new Atms(work.state).refresh();
    const age = new Map(own.map((task, k) => [task.taskId, k] as const));
    const prices = new Map<string, number>();
    for (const task of ready) prices.set(task.taskId, leafPrice(book, random, task.budget.sessions ?? s.innerSessions));
    // Proof numbers over the decompositions: the leaf that advances the problem most for its price goes first.
    const claims = new Map<string, PnClaim>();
    const groups: PnGroup[] = [];
    for (const { record } of sketchRecords(problem)) {
      if (!record.healthy || !record.registered) continue;
      groups.push({ parent: problem.claimId, parts: record.holes });
      for (const id of record.holes) {
        const claim = problem.memory.claim(id);
        const task = ready.find((t) => t.claimId === id);
        claims.set(id, { id, ...(accepted(claim?.status) ? { settled: true } : claim?.status === "refuted" ? { dead: true } : task !== undefined ? { prove: prices.get(task.taskId) as number } : {}) });
      }
    }
    claims.set(problem.claimId, { id: problem.claimId });
    const first = new ProofNumbers([...claims.values()], groups).mostProving(problem.claimId);
    const clauses = ready.map((task): Clause & { task: TaskInfo } => {
      const value = task.claimId === undefined ? 0 : (() => {
        const v = lemmaValue(labels, task.claimId, { targets: [problem.claimId] });
        return v.weight + 2 * v.bottleneckFor.length;
      })();
      const weight = task.claimId !== undefined && task.claimId === first ? 0 : taskWeight(prices.get(task.taskId) as number, value);
      return { id: task.taskId, age: age.get(task.taskId) ?? Number.MAX_SAFE_INTEGER, weight, task };
    });
    const loop = new GivenClause<Clause & { task: TaskInfo }>({ age: s.age, weight: s.weight }, picks);
    for (const clause of clauses) loop.add(clause);
    const pick = loop.select(random);
    return pick === undefined ? undefined : { task: pick.clause.task, rule: pick.rule, weight: pick.clause.weight };
  }

  async function inner(problem: ProblemContext, work: Work, s: Settings, task: TaskInfo, owner: string): Promise<TaskEnd> {
    const claimId = task.claimId;
    if (claimId === undefined) return { ended: "failed", reason: "the task has no claim" };
    const limit = task.budget.sessions ?? s.innerSessions;
    for (;;) {
      const status = problem.memory.claim(claimId)?.status;
      if (accepted(status)) return { ended: "done", reason: `the claim is ${status ?? "settled"}` };
      const mine = sessionRecords(problem).filter((r) => r.taskId === task.taskId);
      if (mine.length >= limit) return { ended: "failed", reason: `${owner} used its ${limit} inner session${limit === 1 ? "" : "s"} without a proof that passes` };
      if (problem.signal.aborted) return { ended: "failed", reason: "the problem ended" };
      if (problem.budget.exhausted) return { ended: "failed", reason: "the problem's budget ran out" };
      const claim = problem.memory.claim(claimId);
      const parent = problem.memory.claim(problem.claimId);
      const hole = sketchRecords(problem).flatMap(({ record }) => record.holes.map((id, k) => ({ id, name: record.names[k] ?? "aux_lemma" }))).find((h) => h.id === claimId);
      const name = hole?.name ?? "aux_lemma";
      const session = mine.length + 1;
      const failures = mine.slice(-3).map((r) => `- session ${r.session}: ${r.reasons.join("; ") || "the check failed"}`);
      const prompt = [
        `You are ${owner}, proving one lemma that a larger Lean 4 proof needs. Session ${session} of ${limit} for this lemma.`,
        parent !== undefined ? `The theorem the lemma is a step of: theorem target ${clip(parent.statement, 600)}` : "",
        `The lemma, to be proved: lemma ${name} ${claim?.statement ?? ""}`,
        `It is read under this header (imports, opens, definitions):\n${work.header.slice(-1500)}`,
        failures.length > 0 ? `Earlier sessions did not succeed:\n${failures.join("\n")}` : "",
        'Answer with JSON: {"proof": the tactic proof without the leading "by", "aux": optional helper lemmas written before the lemma, each named aux_<something> and fully proved}. Do not use sorry.',
      ].filter((line) => line !== "").join("\n\n");
      let usd = 0;
      let record: SessionRecord;
      try {
        const answer = await completeJson<{ proof?: unknown; aux?: unknown }>(problem.llm, {
          prompt, site: SITE_INNER, reuse: true,
          schema: { type: "object", properties: { proof: { type: "string" }, aux: { type: "string" } }, required: ["proof"] },
        });
        usd = answer.cost.usd;
        const proof = typeof answer.value.proof === "string" ? answer.value.proof : "";
        const aux = typeof answer.value.aux === "string" ? answer.value.aux : "";
        const result = await problem.validate({ claimId, proof, ...(aux.trim() !== "" ? { aux } : {}) });
        record = {
          problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: result.verdict === "valid", usd,
          reasons: result.verdict === "valid" ? [] : result.reasons.slice(0, 3).map((r) => clip(r, 160)),
          ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
        };
      } catch (error) {
        // A process that ended is not a failure of the session, and nor is the end of the problem; an answer that is no proof is.
        if (isInterrupted(error)) throw error;
        if (problem.signal.aborted || problem.budget.exhausted) return { ended: "failed", reason: problem.signal.aborted ? "the problem ended" : "the problem's budget ran out" };
        if (!(error instanceof JsonAnswerError) && !/the model call failed/.test(error instanceof Error ? error.message : "")) throw error;
        record = { problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: false, usd, reasons: [clip(error instanceof Error ? error.message : String(error), 160)] };
      }
      problem.memory.recordNode({ kind: SESSION_KIND, claimId, data: { ...record } });
      problem.log(`${owner} on ${name}, session ${session}: ${record.ok ? "accepted" : "not accepted"}`);
      if (record.ok) {
        await soft(problem, "propagation", () => propagate(problem, work));
        return { ended: "done", reason: `${owner}'s proof of ${name} passed the fast check in session ${session}` };
      }
    }
  }

  return {
    id: "M12",
    title: LINE_TITLES.M12,
    requires: [],
    options: M12_OPTIONS,
    version: "m12-1",
    // The work (a graph, the comparisons made, the counts) is made again from the memory's nodes and the ledger: see `begin`.
    resume: "rebuild",
    hooks: {
      beforeProvers: (problem) => begin(problem),
      resumeProblem: (problem) => begin(problem),

      afterAttempt: async (problem, attempt) => {
        const work = works.get(keyOf(problem));
        const s = settings(problem.options);
        if (work === undefined || !s.subgoals || attempt.submission === undefined) return undefined;
        // Only the record, which is cheap and has no Lean in it: the claims and the edge are made between sessions (`registerAll`).
        if (sketchRecords(problem).some(({ record }) => record.attemptId === attempt.attemptId)) return undefined;
        const reading = readSketch(attempt.submission);
        if (reading.holes.length === 0) return undefined;
        const report = attempt.report;
        const healthy = reading.problem === undefined && report !== undefined && report.holes && !report.messages.some((m) => m.severity === "error") && !report.editsOutsideRegions;
        const record: SketchRecord = {
          problemId: problem.problemId,
          attemptId: attempt.attemptId,
          submission: problem.memory.blobs.put(JSON.stringify({ aux: attempt.submission.aux, proof: attempt.submission.proof })),
          names: reading.holes.map((h) => h.name),
          healthy,
          ...(reading.problem !== undefined ? { problem: reading.problem } : {}),
          registered: false,
          holes: [],
        };
        problem.memory.recordNode({ kind: SKETCH_KIND, claimId: problem.claimId, data: { ...record } });
        return undefined;
      },

      schedule: async (problem): Promise<ScheduledTask | undefined> => {
        const work = works.get(keyOf(problem));
        const s = settings(problem.options);
        if (work === undefined || !s.subgoals) return undefined;
        await soft(problem, "the sketches", () => registerAll(problem, work, s));
        await soft(problem, "subsumption", () => sweep(problem, work, s));
        await soft(problem, "propagation", () => propagate(problem, work));
        ensureTasks(problem, s);
        // Read again: the tasks just made are ready too.
        const candidates = problem.tasks.ready().filter((task) => task.proposedBy === ACTOR && task.kind === "prove");
        // A task whose claim a subsumption or a composition closed needs no work.
        const closed = candidates.find((task) => task.claimId !== undefined && accepted(problem.memory.claim(task.claimId)?.status));
        if (closed !== undefined) {
          return { taskId: closed.taskId, reason: "its claim is closed already", run: async () => ({ ended: "done", reason: `the claim is ${problem.memory.claim(closed.claimId as string)?.status ?? "closed"}, with no session of its own` }) };
        }
        const chosen = choose(problem, work, s, candidates);
        if (chosen === undefined) return undefined;
        const { task, rule, weight } = chosen;
        return {
          taskId: task.taskId,
          reason: `chosen by the ${rule} order of the given-clause loop (weight ${weight.toFixed(3)})`,
          run: (owner) => inner(problem, work, s, problem.tasks.get(task.taskId) ?? task, owner),
        };
      },

      briefing: async (session): Promise<Briefing | undefined> => {
        const work = works.get(keyOf(session));
        if (work === undefined) return undefined;
        const source = memorySource(session.memory, () => work.header);
        const lines: string[] = [];
        const open: string[] = [];
        const stuck: string[] = [];
        const tasks = ownTasks(session);
        const seen = new Set<string>();
        for (const { record } of sketchRecords(session)) {
          for (const [k, id] of record.holes.entries()) {
            if (seen.has(id)) continue;
            seen.add(id);
            const name = record.names[k] ?? "aux_lemma";
            const claim = session.memory.claim(id);
            if (claim === undefined) continue;
            if (accepted(claim.status)) {
              const proof = source.proofOf(id, "proved");
              if (proof === undefined) continue;
              lines.push(`lemma ${name} ${claim.statement.trim()} := by\n${dedent(proof.proof).split("\n").map((l) => `  ${l}`).join("\n")}${proof.aux.trim() !== "" ? `\n(with the helper lemmas:\n${proof.aux.trim()}\n)` : ""}`);
            } else if (claim.status === "open") {
              const working = tasks.some((task) => task.claimId === id && task.status !== "done" && task.status !== "failed" && task.status !== "cancelled");
              (working ? open : stuck).push(name);
            }
          }
        }
        if (lines.length === 0 && open.length === 0 && stuck.length === 0) return undefined;
        const text = [
          lines.length > 0 ? `The scheduler proved these lemmas of your sketch; Lean accepted each. Put them in the auxiliary region under these names:\n\n${lines.join("\n\n")}` : "",
          open.length > 0 ? `Still open, and worked on between your sessions: ${open.join(", ")}.` : "",
          stuck.length > 0 ? `Not proved: ${stuck.join(", ")}. The scheduler's sessions on ${stuck.length === 1 ? "it" : "them"} did not succeed; they are yours to prove or to restate.` : "",
        ].filter((t) => t !== "").join("\n\n");
        return { title: "Lemmas of your sketch", text };
      },

      afterProblem: async (problem) => {
        works.delete(keyOf(problem));
      },
    },
  };
}

/** The instance the orchestrator registers (`packages/orchestrator/src/lines.ts`). */
export const m12Line: Line = createM12Line();
