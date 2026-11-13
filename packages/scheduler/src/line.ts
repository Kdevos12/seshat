import { HOLE_FALSE_VERDICT, HOLE_WAITING_REASON, HOLE_VERDICT_KIND, type HoleVerdict, hash32, leanTextProblems, seeded, sha256Hex, statementIdV0, SUSPECT_FALSE_KIND } from "@seshat/core";
import {
  Atms, checkEdge, DERIVATION_KIND, type DerivationRecord, GraphState, linkFor, lemmaValue, memorySource, parseSignature, realize,
} from "@seshat/graph";
import { LeanMeta } from "@seshat/lean-meta";
import {
  type Briefing, completeJson, type HoleSessionResult, isInterrupted, JsonAnswerError, type JsonObject, type Line, LINE_TITLES, type ProblemContext, type ScheduledTask, type TaskEnd, type TaskInfo,
} from "@seshat/lines";
import { GivenClause, type Clause } from "./kernel.ts";
import { boundHistory, cutHeader, readWork, stubsRegion, stubOf, type Dependency } from "./hole-work.ts";
import { type BaseDepths, BLUEPRINT_FORMAT, blueprintNotice, dropHeaderImports, linkProof, readSketch, type ReadOptions, type SketchReading } from "./holes.ts";
import { leafPrice, priceBook, taskWeight } from "./pricing.ts";
import { ProofNumbers, type PnClaim, type PnGroup } from "./proofnumbers.ts";
import { PLANNER_CALL_SHARE, PLANNER_ERRORS, PLANNER_ERROR_CHARS, plannerPrompt, type PlannerHole, SITE_PLANNER } from "./refine.ts";
import {
  asRecord, PREFLIGHT_KIND, type PreflightRecord, REFINE_STOP_KIND, type RefineStopRecord, SESSION_KIND, type SessionRecord, SKETCH_KIND, type SketchRecord, SUBSUMPTION_KIND, type SubsumptionRecord,
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
  /** Read a sketch as a blueprint: its holes may depend on each other (`-- uses:`), each hole is worked in a session with tools on a small file, and ends with a verdict (CA9 to CA11). */
  blueprints: false,
  /** Model responses in a hole's session (blueprints only). */
  holeTurns: 12,
  /** Sessions of a hole's task before it fails (blueprints only; a session is a whole tool loop, so fewer than `innerSessions`). */
  holeSessions: 2,
  /** Refinement rounds (CA12, blueprints only): a planner call rewrites a blueprint Lean refused, or whose holes have all had their sessions with one not proved. */
  refine: false,
  /** The most refinement rounds for one problem (refine only). */
  maxRefinements: 8,
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
  blueprints: boolean;
  holeTurns: number;
  holeSessions: number;
  refine: boolean;
  maxRefinements: number;
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
    blueprints: flag("blueprints"),
    holeTurns: num("holeTurns", 1),
    holeSessions: num("holeSessions", 1),
    refine: flag("refine"),
    maxRefinements: num("maxRefinements", 0),
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
  /** The blueprints (their records) whose refinement round the budget gate skipped, so that the gate is not asked again for the same state (CA12). */
  refineSkipped: Set<string>;
}

/** What reading a sketch is asked: a blueprint, when the option is on (CA9). */
const readOptions = (s: Settings, target: string | undefined): ReadOptions => (s.blueprints ? { blueprint: true, ...(target !== undefined ? { target } : {}) } : {});

/** Lean's first errors of a check, clipped: what a planner is told about a blueprint that was refused. */
const errorsOf = (report: { messages: ReadonlyArray<{ severity: string; text: string }> }): string[] =>
  report.messages.filter((m) => m.severity === "error").slice(0, PLANNER_ERRORS).map((m) => clip(m.text, PLANNER_ERROR_CHARS));

/**
 * The record of a sketch that was read and checked: a prover's (`afterAttempt`) or a planner's (refinement round). Healthy means it checked with
 * only its named holes open, and the reading found it splittable.
 */
function sketchRecordOf(
  problem: ProblemContext, s: Settings, attemptId: string, submission: { aux: string; proof: string }, reading: SketchReading,
  report: { holes: boolean; editsOutsideRegions: boolean; messages: ReadonlyArray<{ severity: string; text: string }> } | undefined,
  extra: Partial<SketchRecord> = {},
): SketchRecord {
  const healthy = reading.problem === undefined && report !== undefined && report.holes && !report.messages.some((m) => m.severity === "error") && !report.editsOutsideRegions;
  const errors = s.refine && report !== undefined ? errorsOf(report) : [];
  return {
    problemId: problem.problemId,
    attemptId,
    submission: problem.memory.blobs.put(JSON.stringify({ aux: submission.aux, proof: submission.proof })),
    names: reading.holes.map((h) => h.name),
    healthy,
    ...(reading.problem !== undefined ? { problem: reading.problem } : {}),
    ...(reading.failureClass !== undefined ? { failureClass: reading.failureClass } : {}),
    ...(reading.dropped !== undefined && reading.dropped.length > 0 ? { dropped: reading.dropped } : {}),
    ...(report !== undefined ? { editsOutsideRegions: report.editsOutsideRegions, leanHoles: report.holes } : {}),
    ...(s.blueprints ? { blueprint: true, uses: reading.holes.map((h) => h.uses) } : {}),
    ...(s.refine ? { depth: reading.holes.map((h) => h.depth ?? 0) } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...extra,
    registered: false,
    holes: [],
  };
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

/** What a hole session needs of its hole: the name, and the holes it declares it uses, as stubs. Only for a blueprint's holes. */
interface HoleInfo {
  name: string;
  claimId: string;
  deps: Array<Dependency & { claimId: string }>;
}

function holeInfo(problem: ProblemContext, claimId: string, latestFirst = false): HoleInfo | undefined {
  // With refinement rounds a claim may be a hole of several blueprints: the latest one says what it uses.
  for (const { record } of latestFirst ? sketchRecords(problem).reverse() : sketchRecords(problem)) {
    if (record.blueprint !== true || !record.healthy || !record.registered) continue;
    const k = record.holes.indexOf(claimId);
    if (k < 0) continue;
    const deps = (record.uses?.[k] ?? []).flatMap((name) => {
      const id = record.holes[record.names.indexOf(name)];
      const dep = id === undefined ? undefined : problem.memory.claim(id);
      return id === undefined || dep === undefined ? [] : [{ name, statement: dep.statement, claimId: id }];
    });
    return { name: record.names[k] ?? "aux_lemma", claimId, deps };
  }
  return undefined;
}

/** The session of a hole whose work was done (no error, every `sorry` in a stub), the latest. */
const workOf = (problem: ProblemContext, claimId: string): SessionRecord | undefined => sessionRecords(problem).filter((r) => r.claimId === claimId && r.workDone === true).at(-1);

/** The verdicts of a hole of this problem, read from the memory's `hole_verdict` nodes. */
function verdictsOf(problem: ProblemContext, claimId: string): Array<{ verdict: HoleVerdict; negationValidated: boolean; argument?: string; sessionId?: string }> {
  return problem.memory
    .nodes(HOLE_VERDICT_KIND, { claimId })
    .map((node) => node.data as { problemId?: string; verdict: HoleVerdict; negationValidated?: boolean; argument?: string; sessionId?: string })
    .filter((data) => data.problemId === problem.problemId)
    .map((data) => ({ verdict: data.verdict, negationValidated: data.negationValidated === true, ...(data.argument !== undefined ? { argument: data.argument } : {}), ...(data.sessionId !== undefined ? { sessionId: data.sessionId } : {}) }));
}

/** Lean accepted a proof of the hole's negation: the one thing that makes a hole false for the scheduler. */
const falseOf = (problem: ProblemContext, claimId: string): boolean => verdictsOf(problem, claimId).some((v) => v.verdict === HOLE_FALSE_VERDICT && v.negationValidated);

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
        // A blueprint's hole whose work is done waits for its dependencies (the graph derives it when they are accepted), and one whose negation Lean accepted is false.
        if (record.blueprint === true && (workOf(problem, claimId) !== undefined || falseOf(problem, claimId))) continue;
        const mine = tasks.filter((task) => task.claimId === claimId);
        if (mine.some((task) => task.status !== "done" && task.status !== "failed" && task.status !== "cancelled")) continue;
        // PC4 item 1: the cap is per outer session, that is per sketch: the tasks of this sketch's holes, not of every sketch the problem has had.
        if (mine.length >= s.rounds || tasks.filter((task) => task.claimId !== undefined && record.holes.includes(task.claimId)).length >= s.maxInnerTasks) continue;
        const last = mine.at(-1);
        const proposed = problem.tasks.propose({
          kind: "prove",
          claimId,
          acceptance: { type: "claim", claimId, minStatus: "computed" },
          budget: record.blueprint === true ? { sessions: s.holeSessions, turns: s.holeTurns } : { sessions: s.innerSessions },
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
      const reading: SketchReading = readSketch(submission, readOptions(s, parent.statement));
      const names = reading.holes.map((h) => h.name);
      const unsafe = reading.holes.map((h) => ({ name: h.name, reasons: leanTextProblems(h.statement) })).find((h) => h.reasons.length > 0);
      if (unsafe !== undefined) {
        problem.memory.updateNode(nodeId, { registered: true }, `the hole ${unsafe.name} is refused by the strict screen: ${unsafe.reasons.join("; ")}`);
        problem.log(`sketch of ${record.attemptId}: the hole ${unsafe.name} is refused by the strict screen (${unsafe.reasons.join("; ")})`);
        continue;
      }
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
      // A blueprint: each hole that declares dependencies gets a `decomposes_into` edge to them. Its link lemma, `(dependencies) -> (the hole)`,
      // is checked when the hole's work is done (`workDone`), and only then does the edge propagate: the hole is derived from its
      // dependencies' accepted proofs, in dependency order, whenever they are accepted.
      if (record.blueprint === true) dependencyEdges(problem, reading, holes);
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

  /** The `decomposes_into` edges of a blueprint's dependencies: from a hole to the holes it declares, unchecked until its work is done. */
  function dependencyEdges(problem: ProblemContext, reading: SketchReading, holes: readonly string[]): void {
    for (const [k, hole] of reading.holes.entries()) {
      const deps = hole.uses.flatMap((name) => holes[reading.holes.findIndex((h) => h.name === name)] ?? []);
      if (deps.length === 0 || deps.length !== hole.uses.length) continue;
      const from = holes[k] as string;
      if (problem.memory.edges({ from, kinds: ["decomposes_into"] }).some((e) => e.to.length === deps.length && deps.every((d) => e.to.includes(d)))) continue;
      const link = linkFor("decomposes_into", { id: from, statement: problem.memory.claim(from)?.statement ?? hole.statement }, deps.map((id) => ({ id, statement: problem.memory.claim(id)?.statement ?? "" })));
      if (link !== undefined) problem.memory.addEdge({ kind: "decomposes_into", from, to: deps, link, note: `${hole.name} uses ${hole.uses.join(", ")}` });
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

  /** A task of the problem that has not ended. */
  const live = (task: TaskInfo): boolean => task.status !== "done" && task.status !== "failed" && task.status !== "cancelled";

  /**
   * Whether the holes of a healthy blueprint have all had their sessions and one is not proved (CA12, case b): every hole is accepted, or has a
   * verdict and no task that can still run; at least one of them is false, refuted, or ended without a proof. A hole worked out on its stubs
   * that waits for the lemmas it uses is neither: it ends when they do.
   */
  function holesFailed(problem: ProblemContext, record: SketchRecord): boolean {
    const tasks = ownTasks(problem);
    let failed = false;
    for (const id of record.holes) {
      const claim = problem.memory.claim(id);
      if (claim === undefined || accepted(claim.status)) continue;
      if (claim.status === "refuted") {
        failed = true;
        continue;
      }
      if (tasks.some((task) => task.claimId === id && live(task))) return false;
      const last = verdictsOf(problem, id).at(-1);
      if (last === undefined) return false;
      if (last.verdict !== "proved") failed = true;
    }
    return failed;
  }

  /** The blueprint a refinement round revises, and why (CA12): case b, the healthy one whose holes have all had their sessions; or case a, the last one Lean checked when no blueprint is healthy. */
  function refineBase(problem: ProblemContext): { nodeId: string; record: SketchRecord; case: "a" | "b" } | undefined {
    const records = sketchRecords(problem).filter(({ record }) => record.blueprint === true);
    const refined = new Set(records.flatMap(({ record }) => (record.refinedFrom !== undefined ? [record.refinedFrom] : [])));
    const healthy = records.filter(({ record }) => record.healthy);
    if (healthy.length > 0) {
      const current = healthy.at(-1) as (typeof records)[number];
      if (!current.record.registered || refined.has(current.nodeId) || !holesFailed(problem, current.record)) return undefined;
      return { ...current, case: "b" };
    }
    // The last one Lean checked, or a planner's answer that was no blueprint (it has no check, and revises what the round before revised).
    const checked = records.filter(({ record }) => record.editsOutsideRegions !== undefined || record.planner === true).at(-1);
    return checked === undefined || refined.has(checked.nodeId) ? undefined : { ...checked, case: "a" };
  }

  /** What the planner is told about each hole of the blueprint it revises. */
  function plannerHoles(problem: ProblemContext, record: SketchRecord): PlannerHole[] {
    return record.names.map((name, k): PlannerHole => {
      const id = record.holes[k];
      const claim = id === undefined ? undefined : problem.memory.claim(id);
      const verdict = id === undefined ? undefined : verdictsOf(problem, id).at(-1);
      const session = id === undefined ? undefined : sessionRecords(problem).filter((r) => r.claimId === id).at(-1);
      const detail = verdict?.argument ?? session?.reasons[0];
      return {
        name,
        status: claim?.status ?? "not registered",
        depth: record.depth?.[k] ?? 0,
        ...(claim !== undefined ? { statementId: claim.statementId.replace(/^sid_/, "").slice(0, 12) } : {}),
        ...(verdict !== undefined ? { verdict: verdict.verdict } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
    });
  }

  /** The depths of the blueprint a round revises: by the name of each hole, and by its statement (a hole kept as it is keeps its depth). */
  function baseDepths(problem: ProblemContext, record: SketchRecord, submission: { aux: string; proof: string }): BaseDepths {
    const byName = new Map(record.names.map((name, k) => [name, record.depth?.[k] ?? 0] as const));
    const byStatement = new Map<string, number>();
    for (const hole of readSketch(submission).holes) {
      const depth = byName.get(hole.name);
      if (depth !== undefined) byStatement.set(statementIdV0(hole.statement), depth);
    }
    return { byName, byStatement };
  }

  /**
   * A refinement round (CA12, PA11): one model call in a fresh context that rewrites the blueprint from what happened to it, read and checked
   * like any blueprint and recorded as an `m12_sketch` with `planner: true`. Returns true when a record was written (the caller registers it).
   * A round the budget gate skips is not made (the gate journals its answer); a round whose model call fails is no round, and stops the
   * rounds of the problem for the rest of the run (`m12_refine_stop`). Everything it needs is read from the memory's nodes, so a resumed run
   * counts the rounds made and does not make one again; a round cut while its call was in flight is asked again.
   */
  async function refine(problem: ProblemContext, work: Work, s: Settings): Promise<boolean> {
    if (!s.blueprints || !s.refine || !s.subgoals || problem.checkSketch === undefined) return false;
    if (problem.signal.aborted || problem.budget.exhausted) return false;
    if (problem.memory.nodes(REFINE_STOP_KIND, { claimId: problem.claimId }).some((n) => asRecord<RefineStopRecord>(n.data).problemId === problem.problemId)) return false;
    const rounds = sketchRecords(problem).filter(({ record }) => record.planner === true).length;
    if (rounds >= s.maxRefinements) return false;
    const target = problem.memory.claim(problem.claimId);
    if (target === undefined || accepted(target.status)) return false;
    const base = refineBase(problem);
    const stored = base === undefined ? undefined : problem.memory.blobs.get(base.record.submission);
    if (base === undefined || stored === undefined || work.refineSkipped.has(base.nodeId)) return false;
    const submission = JSON.parse(stored) as { aux: string; proof: string };
    const round = rounds + 1;
    const prompt = plannerPrompt({
      round, max: s.maxRefinements, target: target.statement, aux: submission.aux, proof: submission.proof, holes: plannerHoles(problem, base.record),
      ...(base.case === "a" ? { refused: { ...(base.record.problem !== undefined ? { problem: base.record.problem } : {}), errors: base.record.errors ?? [] } } : {}),
    });
    // The gate prices the round as a task of one call: a share of what an inner session has cost on this problem (its first guess before any).
    if (problem.budget.ask !== undefined) {
      const answer = await problem.budget.ask({ site: "task", estimateUsd: priceBook(sessionRecords(problem)).sessionUsd * PLANNER_CALL_SHARE });
      if (answer.action === "skip") {
        work.refineSkipped.add(base.nodeId);
        problem.log(`refinement round ${round}: skipped by the budget gate (${answer.reason})`);
        return false;
      }
    }
    let written: { aux: string; proof: string } | undefined;
    let flaw: string | undefined;
    try {
      const answer = await completeJson<{ aux?: unknown; proof?: unknown }>(problem.llm, {
        prompt, site: SITE_PLANNER, reuse: true,
        schema: { type: "object", properties: { aux: { type: "string" }, proof: { type: "string" } }, required: ["aux", "proof"] },
      });
      if (typeof answer.value.proof === "string" && typeof answer.value.aux === "string") written = { aux: answer.value.aux, proof: answer.value.proof };
      else flaw = "the planner's answer has no AUX and PROOF regions";
    } catch (error) {
      if (isInterrupted(error)) throw error;
      if (problem.signal.aborted || problem.budget.exhausted) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof JsonAnswerError) flaw = `the planner's answer was not a blueprint: ${clip(message, 160)}`;
      else if (/the model call failed/.test(message)) {
        const stop: RefineStopRecord = { problemId: problem.problemId, round, reason: clip(message, 200) };
        problem.memory.recordNode({ kind: REFINE_STOP_KIND, claimId: problem.claimId, data: { ...stop } });
        problem.log(`refinement round ${round}: the planner's model call failed (${stop.reason}); no more rounds for this problem`);
        return false;
      } else throw error;
    }
    const attemptId = `planner_${round}`;
    const extra: Partial<SketchRecord> = { planner: true, refinedFrom: base.nodeId, round };
    if (written === undefined) {
      problem.memory.recordNode({ kind: SKETCH_KIND, claimId: problem.claimId, data: { ...sketchRecordOf(problem, s, attemptId, submission, { holes: [], others: [], problem: flaw ?? "no blueprint" }, undefined, extra) } });
      return true;
    }
    const cut = dropHeaderImports(written.aux, work.header);
    const answered = { aux: cut.aux, proof: written.proof };
    const reading = readSketch(answered, { ...readOptions(s, target.statement), depths: baseDepths(problem, base.record, submission) });
    const report = reading.holes.length === 0 ? undefined : await problem.checkSketch(answered);
    const record = sketchRecordOf(problem, s, attemptId, answered, reading, report, extra);
    problem.memory.recordNode({ kind: SKETCH_KIND, claimId: problem.claimId, data: { ...record } });
    problem.log(`refinement round ${round} (case ${base.case}): ${record.healthy ? `a blueprint with ${record.names.join(", ")}` : `not a blueprint (${record.problem ?? (record.errors ?? ["Lean's check"])[0] ?? "no named hole"})`}`);
    return true;
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
      refineSkipped: new Set(),
    };
    works.set(keyOf(problem), work);
    // What a cut left undone: the verdicts of sessions whose record was written, and the tasks of the sketches already recorded.
    repairVerdicts(problem);
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

  const WAITING = HOLE_WAITING_REASON;

  /** Writes a session's verdict node, once: a session that has its node is left alone. */
  function recordVerdict(problem: ProblemContext, task: TaskInfo, claimId: string, sessionId: string, verdict: HoleVerdict, extra: { negationValidated?: boolean; argument?: string } = {}): void {
    if (verdictsOf(problem, claimId).some((v) => v.sessionId === sessionId)) return;
    problem.memory.recordNode({
      kind: HOLE_VERDICT_KIND,
      claimId,
      data: { problemId: problem.problemId, taskId: task.taskId, claimId, sessionId, verdict, ...(extra.negationValidated === true ? { negationValidated: true } : {}), ...(extra.argument !== undefined ? { argument: clip(extra.argument, 400) } : {}) },
    });
  }

  function recordSuspect(problem: ProblemContext, claimId: string, source: string, sessionId: string, argument: string): void {
    problem.memory.recordNode({ kind: SUSPECT_FALSE_KIND, claimId, data: { problemId: problem.problemId, source, sessionId, argument: clip(argument, 400), checked: false } });
  }

  /**
   * The verdict node of every hole session whose record was written and whose verdict node was not (a cut between the two), and the `suspect_false`
   * node of a `statement_wrong` that has no Lean-checked negation. The session record carries what they say. Idempotent.
   */
  function repairVerdicts(problem: ProblemContext): void {
    for (const node of problem.memory.nodes(SESSION_KIND)) {
      const record = asRecord<SessionRecord>(node.data);
      if (record.problemId !== problem.problemId || record.verdict === undefined) continue;
      const sessionId = `${record.taskId}:${record.session}`;
      const task = { taskId: record.taskId } as TaskInfo;
      recordVerdict(problem, task, record.claimId, sessionId, record.verdict as HoleVerdict, { ...(record.negationValidated === true ? { negationValidated: true } : {}), ...(record.argument !== undefined ? { argument: record.argument } : {}) });
      if (record.verdict === HOLE_FALSE_VERDICT && record.negationValidated !== true && !problem.memory.nodes(SUSPECT_FALSE_KIND, { claimId: record.claimId }).some((n) => (n.data as { sessionId?: string }).sessionId === sessionId)) {
        recordSuspect(problem, record.claimId, "session", sessionId, record.argument ?? "the prover says the lemma is false");
      }
    }
  }

  /**
   * The pre-flight of a hole (CA11), once, before its first paid session. Returns a task end when it settled the hole's fate: the battery
   * proved it, or proved its negation through `validate`.
   */
  async function preflight(problem: ProblemContext, work: Work, task: TaskInfo, info: HoleInfo): Promise<TaskEnd | undefined> {
    if (problem.holePreflight === undefined) return undefined;
    if (problem.memory.nodes(PREFLIGHT_KIND, { claimId: info.claimId }).some((n) => asRecord<PreflightRecord>(n.data).problemId === problem.problemId)) return undefined;
    let found;
    try {
      found = await problem.holePreflight({ claimId: info.claimId });
    } catch (error) {
      if (isInterrupted(error)) throw error;
      if (problem.signal.aborted) return { ended: "failed", reason: "the problem ended" };
      found = { proved: false, refuted: false, notes: [`the pre-flight failed: ${clip(error instanceof Error ? error.message : String(error), 160)}`] } as Awaited<ReturnType<NonNullable<ProblemContext["holePreflight"]>>>;
    }
    if (problem.signal.aborted) return { ended: "failed", reason: "the problem ended" };
    const record: PreflightRecord = { problemId: problem.problemId, claimId: info.claimId, proved: found.proved, refuted: found.refuted, ...(found.plausible !== undefined ? { plausible: found.plausible } : {}), notes: found.notes.map((n) => clip(n, 200)) };
    problem.log(`pre-flight of ${info.name}: ${found.notes.join("; ")}`);
    const sessionId = `${task.taskId}:preflight`;
    // The verdict comes before the record that says the pre-flight ran, so that a cut between them runs it again (a verdict is written once).
    if (found.proved) recordVerdict(problem, task, info.claimId, sessionId, "proved");
    else if (found.refuted) recordVerdict(problem, task, info.claimId, sessionId, HOLE_FALSE_VERDICT, { negationValidated: true });
    // A tool's counterexample is a suspicion: evidence, never a status, and it does not stop the work.
    else if (found.plausible === "counterexample") recordSuspect(problem, info.claimId, "plausible", sessionId, found.notes.find((n) => n.startsWith("plausible")) ?? "plausible found a counterexample");
    problem.memory.recordNode({ kind: PREFLIGHT_KIND, claimId: info.claimId, data: { ...record } });
    if (found.proved) {
      await soft(problem, "propagation", () => propagate(problem, work));
      return { ended: "done", reason: `the battery proved ${info.name} before any session` };
    }
    if (found.refuted) return { ended: "failed", reason: `the hole ${info.name} is false: the battery's proof of its negation passed Lean's fast check` };
    return undefined;
  }

  /** The hole's link lemma, `(dependencies) -> (the hole)`, proved by the hole's own proof with the dependencies as hypotheses, checked by Lean. */
  async function linkWork(problem: ProblemContext, work: Work, info: HoleInfo, helpers: string, proof: string): Promise<{ checked: boolean; reason: string }> {
    const edge = problem.memory.edges({ from: info.claimId, kinds: ["decomposes_into"] }).find((e) => e.to.length === info.deps.length && info.deps.every((d) => e.to.includes(d.claimId)));
    if (edge === undefined) return { checked: false, reason: "the hole has no dependency edge" };
    const ordered = edge.to.flatMap((id) => info.deps.find((d) => d.claimId === id) ?? []);
    const reading: SketchReading = { holes: ordered.map((d) => ({ name: d.name, statement: d.statement, text: stubOf(d), uses: [] })), others: helpers.trim() === "" ? [] : [helpers] };
    const binders = parseSignature(problem.memory.claim(info.claimId)?.statement ?? "").binders;
    const link = linkProof({ aux: helpers, proof }, reading, binders);
    const check = await checkEdge(
      { memory: problem.memory, validate: problem.validate, header: work.header, closers: [], propose: async () => [{ proof: link.proof, aux: link.aux }], log: problem.log },
      edge.edgeId,
    );
    return { checked: check.checked, reason: check.reason };
  }

  function holePrompt(problem: ProblemContext, work: Work, info: HoleInfo, claimStatement: string, session: number, limit: number, turns: number, failures: readonly string[]): string {
    const header = cutHeader(problem.memory.claim(info.claimId)?.header ?? work.header);
    const stubs = stubsRegion(info.deps);
    return [
      `Session ${session} of ${limit}: prove the lemma ${info.name} in Lean 4, in at most ${turns} model responses.`,
      `The file you work on is small. Its header (imports, opens, definitions):\n${header}`,
      info.deps.length > 0
        ? `These lemmas are given, with the proof \`sorry\`; use them by name, only inside the proof of ${info.name} itself (a helper lemma you add must not use them), and keep them exactly as they are in the aux region of every check:\n${stubs}`
        : "No lemma is given: prove it from the header.",
      `The lemma to prove:\nlemma ${info.name} ${claimStatement.trim()} := by\n  <your proof>`,
      `Start with lean_check(aux, proof)${info.deps.length > 0 ? ", whose aux begins with the given lemmas" : ""}; then change it with lean_edit. The work is done when Lean reports no error${info.deps.length > 0 ? " and the only sorry are in the given lemmas" : " and no sorry is left"}.`,
      failures.length > 0 ? `Earlier sessions on this lemma did not succeed:\n${boundHistory(failures).join("\n")}` : "",
    ].filter((line) => line !== "").join("\n\n");
  }

  /** A hole's work with tools (CA10, CA11): pre-flight, then sessions on the small file, each ending with a verdict. */
  async function innerHole(problem: ProblemContext, work: Work, s: Settings, task: TaskInfo, owner: string, info: HoleInfo): Promise<TaskEnd> {
    const claimId = info.claimId;
    const limit = task.budget.sessions ?? s.holeSessions;
    const turns = task.budget.turns ?? s.holeTurns;
    for (;;) {
      const status = problem.memory.claim(claimId)?.status;
      if (accepted(status)) {
        // Accepted with no verdict on record: a cut fell between the check that accepted it (the battery's, in the pre-flight) and the verdict.
        if (verdictsOf(problem, claimId).length === 0) recordVerdict(problem, task, claimId, `${task.taskId}:preflight`, "proved");
        return { ended: "done", reason: `the claim is ${status ?? "settled"}` };
      }
      if (workOf(problem, claimId) !== undefined) return { ended: "failed", reason: WAITING };
      if (falseOf(problem, claimId)) return { ended: "failed", reason: `the hole ${info.name} is false: Lean accepted a proof of its negation` };
      const mine = sessionRecords(problem).filter((r) => r.taskId === task.taskId);
      if (mine.length >= limit) return { ended: "failed", reason: `${owner} used its ${limit} hole session${limit === 1 ? "" : "s"} without a proof` };
      if (problem.signal.aborted) return { ended: "failed", reason: "the problem ended" };
      if (problem.budget.exhausted) return { ended: "failed", reason: "the problem's budget ran out" };
      const early = await preflight(problem, work, task, info);
      if (early !== undefined) return early;
      if (accepted(problem.memory.claim(claimId)?.status)) continue;

      const claim = problem.memory.claim(claimId);
      const session = mine.length + 1;
      const sessionId = `${task.taskId}:${session}`;
      const failures = mine.map((r) => clip(`- session ${r.session}: ${r.reasons.join("; ") || "no proof"}`, 300));
      const prompt = holePrompt(problem, work, info, claim?.statement ?? "", session, limit, turns, failures);
      let result: HoleSessionResult;
      try {
        result = await (problem.holeSession as NonNullable<ProblemContext["holeSession"]>)({
          claimId, prompt, turns, key: sessionId,
          done: (submission, report) => readWork(submission, report, info.deps).done,
        });
      } catch (error) {
        if (isInterrupted(error)) throw error;
        if (problem.signal.aborted || problem.budget.exhausted) return { ended: "failed", reason: problem.signal.aborted ? "the problem ended" : "the problem's budget ran out" };
        const failed: SessionRecord = { problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: false, usd: 0, reasons: [clip(error instanceof Error ? error.message : String(error), 160)], stop: "error" };
        problem.memory.recordNode({ kind: SESSION_KIND, claimId, data: { ...failed } });
        continue;
      }
      if ((result.stop === "aborted" || result.stop === "budget") && (problem.signal.aborted || problem.budget.exhausted)) return { ended: "failed", reason: problem.signal.aborted ? "the problem ended" : "the problem's budget ran out" };

      // A session that ended in an error (a model or Lean outage) with nothing to show is an error, not a verdict: no `hole_verdict` node, and the session is tried again.
      if (result.stop === "error" && !result.accepted && !result.finished && result.verdict === undefined) {
        const failed: SessionRecord = { problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: false, usd: result.usd, reasons: ["the session ended in an error (the model or Lean could not be reached)"], stop: "error", turns: result.turns };
        problem.memory.recordNode({ kind: SESSION_KIND, claimId, data: { ...failed } });
        problem.log(`${owner} on ${info.name}, hole session ${session}: error`);
        continue;
      }

      // What the session came to. The work is done only by the rule on the file (`readWork`), and a claim is a candidate only if `validate` says so.
      const reasons: string[] = [];
      let verdict: HoleVerdict = "too_hard";
      let workRecord: Pick<SessionRecord, "workDone" | "work" | "workHash"> = {};
      let negationValidated = false;
      let suspicion: string | undefined;
      const reading = result.submission !== undefined && result.report !== undefined ? readWork(result.submission, result.report, info.deps) : undefined;
      if (result.accepted || accepted(problem.memory.claim(claimId)?.status)) {
        verdict = "proved";
      } else if (result.finished && reading?.done === true && result.submission !== undefined) {
        const text = JSON.stringify({ aux: reading.helpers, proof: result.submission.proof });
        if (info.deps.length === 0) {
          // No stub, no link lemma: only `validate` accepts such a hole. A file that is done but not accepted was refused by it (a forbidden tactic, an axiom).
          reasons.push(`validate did not accept the proof, so the work was not accepted: ${(result.report?.reasons ?? []).slice(0, 2).map((r) => clip(r, 120)).join("; ") || "no reason given"}`);
        } else {
          const linked = await linkWork(problem, work, info, reading.helpers, result.submission.proof);
          if (linked.checked) {
            verdict = "proved";
            workRecord = { workDone: true, work: problem.memory.blobs.put(text), workHash: sha256Hex(text) };
          } else reasons.push(`the link lemma of ${info.name} did not check: ${linked.reason}`);
        }
      } else if (result.verdict?.verdict === HOLE_FALSE_VERDICT) {
        verdict = HOLE_FALSE_VERDICT;
        if (result.verdict.negation !== undefined) {
          const negation = await problem.validate({ claimId, negation: true, proof: result.verdict.negation.proof, ...(result.verdict.negation.aux !== undefined ? { aux: result.verdict.negation.aux } : {}) });
          negationValidated = negation.verdict === "valid";
          if (!negationValidated) reasons.push(`the proof of the negation was refused: ${negation.reasons.slice(0, 2).map((r) => clip(r, 120)).join("; ")}`);
        }
        if (!negationValidated) suspicion = result.verdict.argument ?? "the prover says the lemma is false";
        reasons.push(negationValidated ? "the lemma is false: Lean accepted its negation" : "the prover says the lemma is false (unverified)");
      } else {
        if (result.verdict?.verdict === "proved") reasons.push("the prover said proved, but its last check does not show it");
        else if (reading !== undefined && !reading.done && reading.reason !== undefined) reasons.push(reading.reason);
        reasons.push(result.verdict === undefined ? `the session ended (${result.stop}) with no verdict` : `the prover said ${result.verdict.verdict}`);
      }
      const record: SessionRecord = {
        problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: verdict === "proved" && workRecord.workDone !== true, usd: result.usd,
        reasons: reasons.slice(0, 3).map((r) => clip(r, 160)), stop: result.stop, turns: result.turns, verdict, ...workRecord,
        ...(negationValidated ? { negationValidated: true } : {}), ...(result.verdict?.argument !== undefined ? { argument: clip(result.verdict.argument, 400) } : {}),
      };
      problem.memory.recordNode({ kind: SESSION_KIND, claimId, data: { ...record } });
      repairVerdicts(problem);
      problem.log(`${owner} on ${info.name}, hole session ${session}: ${verdict}`);
      if (negationValidated) return { ended: "failed", reason: `the hole ${info.name} is false: Lean accepted a proof of its negation` };
      if (verdict === "proved") {
        await soft(problem, "propagation", () => propagate(problem, work));
        if (accepted(problem.memory.claim(claimId)?.status)) return { ended: "done", reason: `${owner}'s proof of ${info.name} passed the fast check in session ${session}` };
        return { ended: "failed", reason: WAITING };
      }
    }
  }

  async function inner(problem: ProblemContext, work: Work, s: Settings, task: TaskInfo, owner: string): Promise<TaskEnd> {
    const claimId = task.claimId;
    if (claimId === undefined) return { ended: "failed", reason: "the task has no claim" };
    const info = s.blueprints && problem.holeSession !== undefined ? holeInfo(problem, claimId, s.refine) : undefined;
    if (info !== undefined) return await innerHole(problem, work, s, task, owner, info);
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
        const target = problem.memory.claim(problem.claimId)?.statement;
        const reading = readSketch(attempt.submission, readOptions(s, target));
        if (reading.holes.length === 0) return undefined;
        const record = sketchRecordOf(problem, s, attempt.attemptId, attempt.submission, reading, attempt.report);
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
        // A refinement round, when one is due (CA12): its blueprint is registered and its holes get tasks like any other.
        if (s.blueprints && s.refine) {
          await soft(problem, "the refinement round", async () => {
            // A round whose blueprint is not healthy leaves the problem as case a: the next round may try again, up to the cap.
            for (;;) {
              if (!(await refine(problem, work, s))) return;
              await registerAll(problem, work, s);
              await sweep(problem, work, s);
              await propagate(problem, work);
              ensureTasks(problem, s);
              if (sketchRecords(problem).at(-1)?.record.healthy === true) return;
            }
          });
        }
        // Read again: the tasks just made are ready too.
        const candidates = problem.tasks.ready().filter((task) => task.proposedBy === ACTOR && task.kind === "prove");
        // A task whose claim a subsumption or a composition closed needs no work.
        const closed = candidates.find((task) => task.claimId !== undefined && accepted(problem.memory.claim(task.claimId)?.status));
        if (closed !== undefined) {
          const id = closed.claimId as string;
          if (s.blueprints && holeInfo(problem, id) !== undefined && verdictsOf(problem, id).length === 0) recordVerdict(problem, closed, id, `${closed.taskId}:preflight`, "proved");
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

      // How to write a blueprint, for the outer prover, only with the option `blueprints` (PA16): the format nothing else told it.
      briefingSections: async (session): Promise<readonly Briefing[] | undefined> => {
        const s = settings(session.options);
        if (!s.blueprints || !s.subgoals || !works.has(keyOf(session))) return undefined;
        return [{ title: "How to write a blueprint", text: BLUEPRINT_FORMAT }];
      },

      // What M12 will do with the sketch just checked, read by the function that makes the record (PA16). Without `blueprints`: nothing.
      afterCheck: async (session, check) => {
        const s = settings(session.options);
        if (!s.blueprints || !s.subgoals || !works.has(keyOf(session)) || !check.report.holes) return undefined;
        const reading = readSketch(check.submission, readOptions(s, session.memory.claim(session.claimId)?.statement));
        return { notice: blueprintNotice(reading, { refusedBeforeLean: check.report.leanStatus === undefined, errors: check.report.messages.filter((m) => m.severity === "error").length, editsOutsideRegions: check.report.editsOutsideRegions }) };
      },

      // An `import` in the aux region that the header already has is dropped before the screen, which refuses it (PA16).
      rewriteCheck: async (session, proposal) => {
        const s = settings(session.options);
        if (!s.blueprints || !s.subgoals || !works.has(keyOf(session))) return undefined;
        const cut = dropHeaderImports(proposal.aux, session.target.sketch.prefix);
        if (cut.dropped.length === 0) return undefined;
        return { aux: cut.aux, note: `Dropped from the AUX region before checking: \`import ${cut.dropped.join(" ")}\` (the file's header already imports it).` };
      },

      briefing: async (session): Promise<Briefing | undefined> => {
        const work = works.get(keyOf(session));
        if (work === undefined) return undefined;
        const source = memorySource(session.memory, () => work.header);
        const lines: string[] = [];
        const open: string[] = [];
        const stuck: string[] = [];
        const refutedHoles: string[] = [];
        const suspected: string[] = [];
        const waiting: string[] = [];
        const falseDeps: string[] = [];
        const refusedDerivations: string[] = [];
        const nameOf = new Map<string, string>();
        for (const { record } of sketchRecords(session)) for (const [k, id] of record.holes.entries()) nameOf.set(id, record.names[k] ?? "aux_lemma");
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
              // A hole found false (Lean accepted its negation) is a fact; a hole a prover only says is false is a suspicion, and the next session is told so (CA11).
              if (falseOf(session, id)) {
                refutedHoles.push(name);
                continue;
              }
              const suspect = session.memory.nodes(SUSPECT_FALSE_KIND, { claimId: id }).map((n) => n.data as { problemId?: string; argument?: string }).filter((d) => d.problemId === session.problemId).at(-1);
              if (suspect !== undefined) suspected.push(`${name}${suspect.argument !== undefined ? ` (${clip(suspect.argument, 160)})` : ""}`);
              if (workOf(session, id) !== undefined) {
                // Its work is done on stubs. A dependency found false, or a derivation `validate` refused, is not a wait.
                const falseOnes = session.memory.edges({ from: id, kinds: ["decomposes_into"] }).flatMap((e) => e.to).filter((dep) => falseOf(session, dep)).map((dep) => nameOf.get(dep) ?? dep);
                const refused = session.memory.nodes(DERIVATION_KIND, { claimId: id }).map((n) => n.data as unknown as Partial<DerivationRecord> & { reasons?: string[] }).filter((d) => d.problemId === session.problemId && d.verdict === "invalid").at(-1);
                if (falseOnes.length > 0) falseDeps.push(`${name} (uses ${[...new Set(falseOnes)].join(", ")})`);
                else if (refused !== undefined) refusedDerivations.push(`${name}${refused.reasons !== undefined && refused.reasons.length > 0 ? ` (${refused.reasons.slice(0, 2).map((r) => clip(r, 120)).join("; ")})` : ""}`);
                else waiting.push(name);
                continue;
              }
              const working = tasks.some((task) => task.claimId === id && task.status !== "done" && task.status !== "failed" && task.status !== "cancelled");
              (working ? open : stuck).push(name);
            }
          }
        }
        if (lines.length === 0 && open.length === 0 && stuck.length === 0 && refutedHoles.length === 0 && suspected.length === 0 && waiting.length === 0 && falseDeps.length === 0 && refusedDerivations.length === 0) return undefined;
        const text = [
          lines.length > 0 ? `The scheduler proved these lemmas of your sketch; Lean accepted each. Put them in the auxiliary region under these names:\n\n${lines.join("\n\n")}` : "",
          open.length > 0 ? `Still open, and worked on between your sessions: ${open.join(", ")}.` : "",
          refutedHoles.length > 0 ? `False, and Lean accepted a proof of the negation of: ${refutedHoles.join(", ")}. Restate ${refutedHoles.length === 1 ? "it" : "them"}.` : "",
          waiting.length > 0 ? `Worked out on its stubs, waiting for the lemmas it uses to be proved: ${waiting.join(", ")}.` : "",
          falseDeps.length > 0 ? `Worked out on its stubs, but it can never be derived as stated: a lemma it uses is false (Lean accepted a proof of its negation): ${falseDeps.join("; ")}. Restate the lemma it uses.` : "",
          refusedDerivations.length > 0 ? `Worked out on its stubs and its dependencies are proved, but validate refused the proof composed from them: ${refusedDerivations.join("; ")}.` : "",
          suspected.length > 0 ? `Suspected false, UNVERIFIED (a session said so, and no Lean-checked proof of the negation exists; it may be wrong, do not drop the lemma on this alone): ${suspected.join("; ")}.` : "",
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
