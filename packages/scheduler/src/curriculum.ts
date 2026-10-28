import { hash32, type Json, seeded } from "@seshat/core";
import { checkEdge, createVariant, IMPLICATION_CLOSERS, memorySource, parseSignature } from "@seshat/graph";
import {
  type Briefing, completeJson, isInterrupted, JsonAnswerError, type JsonObject, type Line, LINE_TITLES, type ProblemContext, type TaskEnd, type TaskInfo,
} from "@seshat/lines";
import { asRecord } from "./records.ts";
import { isLinkLemma } from "./subsume.ts";

/**
 * The line M18 (plan change PE7, documentation/curriculum.md): a curriculum of variants, rung 1 of the escalation ladder.
 * AlphaProof's test-time curriculum without its training: when a problem has spent a fraction of its budget without Lean
 * progress and the ladder moves it up (documentation/scheduler.md), the line asks a model for special cases and weakenings
 * of the target (a small value, a prime case, an extra hypothesis), makes each a claim with a `special_case_of` edge to the
 * target (Task 5's `createVariant`) and a `prove` task, and works the tasks itself (`runTask`) with a capped share of the
 * problem's budget. A variant's proof goes through `validate` and is certified like any other; a variant's status never moves
 * the target's. What Lean accepted reaches the next sessions' briefing as facts, with one or two of the proofs as examples.
 */

/** The options of line M18, with their defaults (`--line-option M18.share=0.1`). */
export const M18_OPTIONS = {
  /** The share of the problem's budget the line may spend in all: the variants' statements and the inner sessions on them. */
  share: 0.2,
  /** The most variants made for one problem. */
  maxVariants: 4,
  /** Inner sessions on one variant before its task fails. */
  sessionsPerVariant: 3,
  /** The dollars the line may spend on a problem that has no dollar budget (no share to count). */
  unbudgetedUsd: 1,
  /** Proofs of variants shown in a session's briefing as examples (1 or 2), chosen from the run's seeded source. */
  examples: 2,
  /** Seeds the choice of examples. Null: the run's seed. */
  seed: null,
} satisfies JsonObject;

interface Settings {
  share: number;
  unbudgetedUsd: number;
  maxVariants: number;
  sessions: number;
  examples: number;
  seed: string | number | null;
}

function settings(options: Readonly<JsonObject>): Settings {
  const whole = (key: "maxVariants" | "sessionsPerVariant" | "examples", least: number, most: number): number => {
    const value = options[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(most, Math.max(least, Math.floor(value))) : M18_OPTIONS[key];
  };
  const share = options.share;
  const seed = options.seed;
  return {
    share: typeof share === "number" && Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : M18_OPTIONS.share,
    unbudgetedUsd: typeof options.unbudgetedUsd === "number" && Number.isFinite(options.unbudgetedUsd) ? Math.max(0, options.unbudgetedUsd) : M18_OPTIONS.unbudgetedUsd,
    maxVariants: whole("maxVariants", 0, 12),
    sessions: whole("sessionsPerVariant", 1, 20),
    examples: whole("examples", 1, 2),
    seed: typeof seed === "number" || typeof seed === "string" ? seed : null,
  };
}

const ACTOR = "line:M18";
const SITE_VARIANTS = "curriculum.variants";
const SITE_PROVE = "curriculum.prove";
const accepted = (status: string | undefined): boolean => status === "computed" || status === "proved";

/**
 * What the line writes, as nodes of the problem's claim. Each is a record of something a model proposed or tried, and so
 * unverified: it is written `learned`, which stamps it with the run's provenance (Global Constraint 16), and none of it
 * is a fact. The facts are the claims Lean accepted and the edges Lean checked.
 */
export const M18_GENERATION_KIND = "m18_generation";
export const M18_VARIANT_KIND = "m18_variant";
export const M18_SESSION_KIND = "m18_session";

/** The model's one call for the problem's variants, written once it is over (also when it gave none). */
export interface CurriculumGeneration {
  problemId: string;
  usd: number;
  /** Variants the model proposed, and the ones that became claims. */
  proposed: number;
  kept: number;
  /** Why nothing was asked or nothing came, when so. */
  note?: string;
}

/** A variant the line made a claim of. */
export interface CurriculumVariant {
  problemId: string;
  variantId: string;
  edgeId: string;
  /** `small_case`, `prime_case` or `extra_hypothesis`. */
  kind: string;
  statement: string;
}

/** One inner session on a variant. */
export interface CurriculumSession {
  problemId: string;
  taskId: string;
  claimId: string;
  session: number;
  ok: boolean;
  usd: number;
  reasons: string[];
  validationId?: string;
  /** True from the model's answer until Lean's: a cut in between leaves it so, and the resumed session picks it up without asking the model again. */
  pending?: boolean;
}

/** The kinds of variant the line asks for. */
export const M18_VARIANT_KINDS = ["small_case", "prime_case", "extra_hypothesis"] as const;

/** Cheap proofs of the link lemma `target → variant`, tried before any model: the variant specializes the target's binders or adds hypotheses. */
const SPECIAL_CASE_CLOSERS: readonly string[] = [
  ...IMPLICATION_CLOSERS,
  "intro h; exact h _",
  "intro h; intros; first | exact h _ | (apply h <;> assumption) | simpa using h",
  "intro h; intro n; exact h n",
];

const clip = (text: string, n: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The text without the indentation all its lines share. */
function dedent(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(cut)).join("\n");
}

/** A statement a model proposed, read: its kind and its text in signature form, or why it is not used. */
export function readVariants(value: unknown, target: string, limit: number): { kept: Array<{ kind: string; statement: string }>; dropped: string[] } {
  const kept: Array<{ kind: string; statement: string }> = [];
  const dropped: string[] = [];
  const list = typeof value === "object" && value !== null && Array.isArray((value as { variants?: unknown }).variants) ? ((value as { variants: unknown[] }).variants) : [];
  const seen = new Set<string>([squash(target)]);
  for (const item of list) {
    const entry = item as { kind?: unknown; statement?: unknown };
    const statement = typeof entry.statement === "string" ? entry.statement.trim() : "";
    const kind = typeof entry.kind === "string" && (M18_VARIANT_KINDS as readonly string[]).includes(entry.kind) ? entry.kind : "extra_hypothesis";
    if (kept.length >= limit) {
      dropped.push("over the limit");
      continue;
    }
    if (statement === "" || statement.length > 800) {
      dropped.push("empty or too long");
      continue;
    }
    if (/\bsorry\b|\badmit\b/.test(statement)) {
      dropped.push("mentions sorry");
      continue;
    }
    try {
      parseSignature(statement);
    } catch {
      dropped.push(`not in signature form: ${clip(statement, 60)}`);
      continue;
    }
    if (seen.has(squash(statement))) {
      dropped.push("a repeat of the target or of an earlier variant");
      continue;
    }
    seen.add(squash(statement));
    kept.push({ kind, statement });
  }
  return { kept, dropped };
}

function nodesOf<T>(problem: ProblemContext, kind: string): T[] {
  return problem.memory
    .nodes(kind, { claimId: problem.claimId })
    .map((node) => asRecord<T & { problemId: string }>(node.data))
    .filter((record) => record.problemId === problem.problemId);
}

/** What the line has spent on the problem, from its records, and the dearest single call it has made (the request for variants included). */
function spendOf(problem: ProblemContext): { usd: number; dearest: number } {
  const costs = [...nodesOf<CurriculumSession>(problem, M18_SESSION_KIND), ...nodesOf<CurriculumGeneration>(problem, M18_GENERATION_KIND)].map((r) => r.usd);
  return { usd: costs.reduce((a, b) => a + b, 0), dearest: Math.max(0, ...costs) };
}

/**
 * Whether the line may make another model call for the problem: its share of the problem's budget is the cap, counted in the
 * dollars the problem's ledger counts (the calls go through `problem.llm`, so the ladder sees them). Before each call the
 * dearest call so far is reserved: a call starts only while the spend is under the cap and the spend plus that reserve still
 * fits. The first call (the request for variants) has no reserve, and a later call may cost more than the dearest before it, so
 * the cap is held to the extent that calls cost about what the dearest earlier one did; the line passes it by at most what its
 * last call cost beyond that reserve. A problem with no dollar budget is capped at `unbudgetedUsd` instead.
 */
export function roomFor(problem: ProblemContext, s: Pick<Settings, "share" | "unbudgetedUsd">): { ok: boolean; spent: number; cap: number } {
  const limit = problem.budget.limitUsd;
  const cap = limit === undefined ? s.unbudgetedUsd : s.share * limit;
  const { usd, dearest } = spendOf(problem);
  return { ok: usd < cap - 1e-12 && usd + dearest <= cap + 1e-12, spent: usd, cap };
}

/** The line's session records of a task: the ones that ended in the order they were made, and the one a cut left pending, with its node. */
function sessionsOf(problem: ProblemContext, taskId: string): { ended: CurriculumSession[]; pending?: { nodeId: string; record: CurriculumSession } } {
  const all = problem.memory
    .nodes(M18_SESSION_KIND, { claimId: problem.claimId })
    .map((node) => ({ nodeId: node.nodeId, record: asRecord<CurriculumSession>(node.data) }))
    .filter(({ record }) => record.problemId === problem.problemId && record.taskId === taskId);
  const pending = all.find(({ record }) => record.pending === true);
  return { ended: all.filter(({ record }) => record.pending !== true).map(({ record }) => record), ...(pending !== undefined ? { pending } : {}) };
}

function variantRecords(problem: ProblemContext): CurriculumVariant[] {
  return nodesOf<CurriculumVariant>(problem, M18_VARIANT_KIND);
}

const ownTasks = (problem: ProblemContext): TaskInfo[] => problem.tasks.list({ kinds: ["prove"] }).filter((task) => task.proposedBy === ACTOR);

/** A special case of the problem's claim that Lean accepted, with its proof when the memory has it. */
interface Fact {
  claimId: string;
  statement: string;
  checked: boolean;
}

function provedSpecialCases(problem: ProblemContext): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const edge of problem.memory.edges({ to: problem.claimId, kinds: ["special_case_of"] })) {
    if (seen.has(edge.from)) continue;
    const claim = problem.memory.claim(edge.from);
    if (claim === undefined || claim.kind !== "formal" || !accepted(claim.status) || isLinkLemma(claim) || edge.from === problem.claimId) continue;
    seen.add(edge.from);
    out.push({ claimId: edge.from, statement: claim.statement, checked: edge.status === "lean_checked" });
  }
  return out;
}

/**
 * Line M18 (plan change PE7, documentation/curriculum.md), rung 1 of the escalation ladder. It requires M12, which
 * owns the ladder and the schedule step in which `runTask` is called.
 *
 * - **On escalation** (`beforeProvers`, which the orchestrator calls when the problem reaches the rung and again on a
 *   resume): one model call, charged to the line's share of the budget, proposes special cases and weakenings of the
 *   target. Each statement that reads as a signature becomes a claim with a `special_case_of` edge to the target
 *   (`createVariant`) and a `prove` task in the ledger. The call is replayable (`reuse`) and every step looks at what
 *   the memory holds first, so a second call does nothing twice.
 * - **Work** (`runTask`): the inner sessions on a variant are model calls that each go through `validate`; a variant is
 *   a claim of its own, and its proof, accepted by the fast check, is certified at the end of the problem like any
 *   other. Nothing here sets the target's status: `special_case_of` carries a proof of the general statement to the
 *   special one and a refutation of the special one to the general one, and the line submits no refutation.
 * - **Cap**: every call counts against `share` of the problem's budget (default 20%); when the share is spent the open
 *   variants' tasks fail with that reason.
 * - **Briefing**: the special cases Lean accepted reach the sessions that follow, as facts with their edges' status and
 *   one or two of their proofs as examples, chosen from the run's seeded source.
 */
export function createM18Line(): Line {
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

  /** The variants the model proposes for the problem, as claims and edges; done once, and safe to do twice. */
  async function generate(problem: ProblemContext, s: Settings): Promise<void> {
    if (nodesOf<CurriculumGeneration>(problem, M18_GENERATION_KIND).length > 0) return;
    const note = (record: Omit<CurriculumGeneration, "problemId">): void => {
      problem.memory.recordNode({ kind: M18_GENERATION_KIND, claimId: problem.claimId, data: { problemId: problem.problemId, ...record } as unknown as Json, learned: true });
    };
    if (s.maxVariants === 0) return note({ usd: 0, proposed: 0, kept: 0, note: "maxVariants is 0" });
    const room = roomFor(problem, s);
    if (!room.ok) return note({ usd: 0, proposed: 0, kept: 0, note: `the share of the budget is ${room.cap}` });
    const header = problem.target.sketch.prefix;
    const prompt = [
      "You are preparing easier variants of a Lean 4 (Mathlib) theorem that has resisted proof, to be solved first: what they teach may help with the theorem.",
      `The theorem: theorem ${problem.target.theorem} ${problem.target.statement}`,
      `It is read under this header (imports, opens, definitions):\n${header.slice(-1500)}`,
      `Propose at most ${s.maxVariants} variants, easiest first. Each is a statement the theorem implies, so that a proof of the theorem would prove it, of one of these kinds:`,
      "- small_case: a specific small value in place of a variable (n = 2, n = 3).",
      "- prime_case: the variable restricted to a prime, or to a special family (powers of two, even numbers).",
      "- extra_hypothesis: an added hypothesis that makes the statement weaker and easier (a bound, an inequality, a smaller range).",
      "Write each statement in signature form: the binders, then `:` and the type, with the theorem's own names and without `theorem`, a name or `:=`. A statement with no binders starts with `:`. Do not use sorry.",
      'Answer with JSON: {"variants": [{"kind": "small_case" | "prime_case" | "extra_hypothesis", "statement": "..."}]}.',
    ].join("\n\n");
    const before = problem.budget.usd;
    let usd = 0;
    let value: unknown;
    let failure: string | undefined;
    try {
      const answer = await completeJson(problem.llm, {
        prompt, site: SITE_VARIANTS, reuse: true,
        schema: {
          type: "object",
          properties: { variants: { type: "array", items: { type: "object", properties: { kind: { type: "string" }, statement: { type: "string" } }, required: ["statement"] } } },
          required: ["variants"],
        },
      });
      usd = answer.cost.usd;
      value = answer.value;
    } catch (error) {
      if (isInterrupted(error)) throw error;
      if (problem.signal.aborted || problem.budget.exhausted) return;
      if (!(error instanceof JsonAnswerError) && !/the model call failed/.test(error instanceof Error ? error.message : "")) throw error;
      // Both calls of a failed answer were charged; their cost is not on the error, so the problem's spend since stands for it.
      usd = Math.max(0, problem.budget.usd - before);
      failure = clip(error instanceof Error ? error.message : String(error), 160);
    }
    const { kept, dropped } = readVariants(value, problem.target.statement, s.maxVariants);
    let made = 0;
    for (const { kind, statement } of kept) {
      if (problem.signal.aborted) return;
      try {
        const variant = await createVariant(problem.memory, {
          from: problem.claimId, relation: "special_case", statement, header,
          gloss: `${kind.replace("_", " ")} of the target, from the curriculum`, note: `${kind.replace("_", " ")} (curriculum)`,
        });
        if (!variantRecords(problem).some((r) => r.variantId === variant.claimId)) {
          const record: CurriculumVariant = { problemId: problem.problemId, variantId: variant.claimId, edgeId: variant.edge.edgeId, kind, statement };
          problem.memory.recordNode({ kind: M18_VARIANT_KIND, claimId: problem.claimId, data: { ...record }, learned: true });
        }
        made += 1;
      } catch (error) {
        if (isInterrupted(error)) throw error;
        dropped.push(clip(error instanceof Error ? error.message : String(error), 80));
      }
    }
    problem.log(`curriculum: ${made} variant${made === 1 ? "" : "s"} of the target${dropped.length > 0 ? ` (${dropped.length} dropped: ${dropped.slice(0, 3).join("; ")})` : ""}`);
    note({ usd, proposed: kept.length + dropped.length, kept: made, ...(failure !== undefined ? { note: failure } : {}) });
  }

  /** The variants that are open and have no task, get one each (no retries: a variant is a stepping stone). */
  function ensureTasks(problem: ProblemContext, s: Settings): void {
    const tasks = ownTasks(problem);
    for (const record of variantRecords(problem)) {
      if (problem.memory.claim(record.variantId)?.status !== "open") continue;
      if (tasks.some((task) => task.claimId === record.variantId)) continue;
      const proposed = problem.tasks.propose({
        kind: "prove",
        claimId: record.variantId,
        acceptance: { type: "claim", claimId: record.variantId, minStatus: "computed" },
        budget: { sessions: s.sessions },
        title: `${record.kind.replace("_", " ")}: ${clip(record.statement, 60)}`,
      });
      if (proposed.accepted) tasks.push(problem.tasks.get(proposed.taskId) as TaskInfo);
      else problem.log(`the task for a variant was refused: ${proposed.reason}`);
    }
  }

  async function begin(problem: ProblemContext): Promise<void> {
    const s = settings(problem.options);
    if (problem.signal.aborted) return;
    // A problem already settled (a resumed run whose candidate was found) needs no curriculum.
    const status = problem.memory.claim(problem.claimId)?.status;
    if (status === "computed" || status === "proved" || status === "refuted") return;
    await generate(problem, s);
    ensureTasks(problem, s);
  }

  async function work(problem: ProblemContext, s: Settings, task: TaskInfo, owner: string): Promise<TaskEnd> {
    const claimId = task.claimId;
    if (claimId === undefined) return { ended: "failed", reason: "the task has no claim" };
    const limit = task.budget.sessions ?? s.sessions;
    for (;;) {
      const status = problem.memory.claim(claimId)?.status;
      if (accepted(status)) {
        // Also what a cut left undone: the claim passed and the edge was not yet checked.
        const left = sessionsOf(problem, task.taskId).pending;
        if (left !== undefined) problem.memory.updateNode(left.nodeId, { ok: true, pending: false, reasons: [] }, "the check had ended");
        await soft(problem, "the check of the special_case_of edge", () => checkLink(problem, claimId));
        return { ended: "done", reason: `the claim is ${status ?? "settled"}` };
      }
      const { ended: mine, pending } = sessionsOf(problem, task.taskId);
      if (mine.length >= limit) return { ended: "failed", reason: `${owner} used its ${limit} session${limit === 1 ? "" : "s"} on the variant without a proof that passes` };
      if (problem.signal.aborted) return { ended: "failed", reason: "the problem ended" };
      if (problem.budget.exhausted) return { ended: "failed", reason: "the problem's budget ran out" };
      const room = roomFor(problem, s);
      if (!room.ok) return { ended: "failed", reason: `the curriculum's share of the budget is spent (${room.spent.toFixed(4)} of ${room.cap.toFixed(4)} dollars)` };
      const claim = problem.memory.claim(claimId);
      const session = mine.length + 1;
      const failures = mine.slice(-3).map((r) => `- session ${r.session}: ${r.reasons.join("; ") || "the check failed"}`);
      const prompt = [
        `You are ${owner}, proving an easier variant of a Lean 4 theorem, as a stepping stone to the theorem. Session ${session} of ${limit} for this variant.`,
        `The theorem the variant comes from: theorem target ${clip(problem.target.statement, 600)}`,
        `The variant, to be proved: theorem variant ${claim?.statement ?? ""}`,
        `It is read under this header (imports, opens, definitions):\n${problem.target.sketch.prefix.slice(-1500)}`,
        failures.length > 0 ? `Earlier sessions did not succeed:\n${failures.join("\n")}` : "",
        'Answer with JSON: {"proof": the tactic proof without the leading "by", "aux": optional helper lemmas written before the theorem, each named aux_<something> and fully proved}. Do not use sorry.',
      ].filter((line) => line !== "").join("\n\n");
      const before = problem.budget.usd;
      let record: CurriculumSession;
      let nodeId: string | undefined = pending?.nodeId;
      try {
        const answer = await completeJson<{ proof?: unknown; aux?: unknown }>(problem.llm, {
          prompt, site: SITE_PROVE, reuse: true,
          schema: { type: "object", properties: { proof: { type: "string" }, aux: { type: "string" } }, required: ["proof"] },
        });
        // The call's cost is recorded before Lean is asked, so that a cut during the check does not lose it from the share's count.
        // (A session a cut left pending asks the same question and gets the same answer, free; it keeps the cost of the first call.)
        record = { problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: false, usd: pending?.record.usd ?? answer.cost.usd, reasons: ["the check did not finish"], pending: true };
        nodeId ??= problem.memory.recordNode({ kind: M18_SESSION_KIND, claimId: problem.claimId, data: { ...record }, learned: true }).nodeId;
        const proof = typeof answer.value.proof === "string" ? answer.value.proof : "";
        const aux = typeof answer.value.aux === "string" ? answer.value.aux : "";
        const result = await problem.validate({ claimId, proof, ...(aux.trim() !== "" ? { aux } : {}) });
        record = {
          ...record, ok: result.verdict === "valid",
          reasons: result.verdict === "valid" ? [] : result.reasons.slice(0, 3).map((r) => clip(r, 160)),
          ...(result.validationId !== undefined ? { validationId: result.validationId } : {}),
        };
      } catch (error) {
        if (isInterrupted(error)) throw error;
        if (problem.signal.aborted || problem.budget.exhausted) return { ended: "failed", reason: problem.signal.aborted ? "the problem ended" : "the problem's budget ran out" };
        if (!(error instanceof JsonAnswerError) && !/the model call failed/.test(error instanceof Error ? error.message : "")) throw error;
        record = {
          problemId: problem.problemId, taskId: task.taskId, claimId, session, ok: false, usd: Math.max(0, problem.budget.usd - before),
          reasons: [clip(error instanceof Error ? error.message : String(error), 160)],
        };
      }
      delete record.pending;
      if (nodeId !== undefined) problem.memory.updateNode(nodeId, { ok: record.ok, reasons: record.reasons, pending: false, ...(record.validationId !== undefined ? { validationId: record.validationId } : {}) }, "the check ended");
      else problem.memory.recordNode({ kind: M18_SESSION_KIND, claimId: problem.claimId, data: { ...record }, learned: true });
      problem.log(`${owner} on a variant, session ${session}: ${record.ok ? "accepted" : "not accepted"}`);
      if (record.ok) {
        await soft(problem, "the check of the special_case_of edge", () => checkLink(problem, claimId));
        return { ended: "done", reason: `${owner}'s proof of the variant passed the fast check in session ${session}` };
      }
    }
  }

  /** Lean checks that the target implies the variant, so that the edge is a fact and not a proposal. Cheap tactics only; no model. */
  async function checkLink(problem: ProblemContext, variantId: string): Promise<void> {
    const edge = problem.memory.edges({ from: variantId, to: problem.claimId, kinds: ["special_case_of"] })[0];
    if (edge === undefined) return;
    const check = await checkEdge({ memory: problem.memory, validate: problem.validate, header: problem.target.sketch.prefix, closers: SPECIAL_CASE_CLOSERS, log: problem.log }, edge.edgeId);
    if (!check.checked) problem.log(`the edge from the variant to the target stays proposed: ${check.reason}`);
  }

  return {
    id: "M18",
    title: LINE_TITLES.M18,
    requires: ["M12"],
    options: M18_OPTIONS,
    version: "m18-1",
    // The ladder starts this line when the problem has spent a fraction of its budget without Lean progress.
    rung: 1,
    // Everything it keeps is in the memory's nodes, the claims and the ledger; `beforeProvers` reads them and does what a cut left undone.
    resume: "rebuild",
    hooks: {
      beforeProvers: (problem) => begin(problem),
      resumeProblem: (problem) => begin(problem),

      runTask: async (problem, task, owner): Promise<TaskEnd> => work(problem, settings(problem.options), task, owner),

      briefing: async (session): Promise<Briefing | undefined> => {
        const s = settings(session.options);
        const facts = provedSpecialCases(session);
        if (facts.length === 0) return undefined;
        const source = memorySource(session.memory);
        const withProof = facts.flatMap((fact) => {
          const proof = source.proofOf(fact.claimId, "proved");
          return proof === undefined ? [] : [{ fact, proof }];
        });
        // The examples are drawn from the run's seeded source: one stream for the problem's session, so a resumed run draws them again.
        const random = seeded(hash32(`${s.seed ?? session.seed ?? session.runId}:m18:${session.problemId}:${session.prover}:${session.session}`));
        const pool = [...withProof];
        const picked: typeof pool = [];
        while (picked.length < s.examples && pool.length > 0) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0] as (typeof pool)[number]);
        const listed = facts.slice(0, 8).map((fact) => `- ${clip(fact.statement, 200)} (${fact.checked ? "Lean checked that the target implies it" : "offered as a special case of the target; the implication is not checked"})`);
        const examples = picked.map(({ fact, proof }, k) =>
          `theorem variant_${k + 1} ${fact.statement.trim()} := by\n${dedent(proof.proof).split("\n").map((l) => `  ${l}`).join("\n")}${proof.aux.trim() !== "" ? `\n(with the helper lemmas:\n${proof.aux.trim()}\n)` : ""}`,
        );
        const text = [
          `While the target resisted, statements near it were tried first with a small share of the budget. Lean accepted a proof of each of these; only those marked checked are known to follow from the target, and none of them proves it:\n${listed.join("\n")}`,
          examples.length > 0 ? `${examples.length === 1 ? "A proof" : "Proofs"} of ${examples.length === 1 ? "one" : "some"}, as ${examples.length === 1 ? "an example" : "examples"} of what worked on the easier cases:\n\n${examples.join("\n\n")}` : "",
        ].filter((t) => t !== "").join("\n\n");
        return { title: "Special cases already proved", text };
      },
    },
  };
}

/** The instance the orchestrator registers (`packages/orchestrator/src/lines.ts`). */
export const m18Line: Line = createM18Line();
