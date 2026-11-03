import { hash32, type Json, seeded } from "@seshat/core";
import { type Beta, thompson } from "@seshat/fleet";
import { memorySource } from "@seshat/graph";
import { LeanMeta } from "@seshat/lean-meta";
import { allSchemas, SCHEMA_KIND, type SchemaData, SchemaIndex, type SchemaRecord, usableSchemas } from "@seshat/library";
import { type Briefing, isInterrupted, type JsonObject, type Line, LINE_TITLES, type ProblemContext, type SessionContext } from "@seshat/lines";
import { type MemoryStore, shouldDeactivate } from "@seshat/memory";
import { type Archive, type Cell, memberOf, readArchive, type SketchEntry } from "./archive.ts";
import { readSketch } from "./holes.ts";
import { asRecord, SKETCH_KIND, type SketchRecord } from "./records.ts";
import {
  confirm, covers, dataOf, generalize, type Instance, instantiate, reuses, screenFormal, type Skeleton, skeletonFrom, skeletonOf,
} from "./schemas.ts";
import { knownFacts } from "./subsume.ts";

/**
 * Line M15 (plan change PC13, documentation/archive.md): a diversity archive of alternative decompositions, and schemas. ProofEvolve
 * (arXiv 2608.26334) without training. The archive keeps several decompositions of the problem's claim alive in cells instead of
 * one best-first frontier; a `beforeSession` hook chooses by Thompson sampling the cell whose decomposition the next session
 * extends; the closed decompositions are kept as schemas in the library, and shown, instantiated, to the sessions of other
 * problems. The line spends no model call of its own: the model's work is the outer provers' sessions, each of which
 * writes a sketch that the scheduler (M12) turns into a decomposition Lean checks. It is rung 2 of the escalation ladder.
 *
 * Trust: a claim's status changes only through `validate`. The fitness of a decomposition is read from Lean's verdicts (ATMS labels over
 * checked edges). The choice of a cell, a schema and the posteriors are learned from outcomes and so stamped (PE1); a schema shown to a
 * session goes through the randomized inclusion (PE2) and is judged by its effect on that session's success, not by its presence.
 */

/** The options of line M15 and their defaults (`--line-option M15.hints=2`). */
export const M15_OPTIONS = {
  /** Choose by Thompson sampling the cell whose decomposition a session extends; off: the sessions are not steered. */
  cells: true,
  /** Schemas shown to a session, at most; 0 turns the hints off. */
  hints: 1,
  /** `match`: the schemas that fit the problem's statement, instantiated. `random`: a random active schema, the control of the plan. */
  retrieval: "match",
  /** Ask lean.meta to confirm a lexical match before a schema is instantiated (fails closed). Off for a run without lean.meta. */
  confirm: true,
  /** The most schemas confirmed with lean.meta for one session. */
  candidates: 5,
  /** Keep the closed decompositions of a finished problem as schemas. */
  extract: true,
  /** The share of fixed tokens a schema must keep (below it a skeleton says too little to be a shape). */
  minSpecificity: 0.5,
  /** Observations with a schema and as many without it before its effect can retire it, and the P(effect < 0) that retires it. */
  minObservations: 8,
  threshold: 0.9,
  /** Seeds the line's draws. Null: the run's seed. */
  seed: null,
} satisfies JsonObject;

export interface M15Settings {
  cells: boolean;
  hints: number;
  random: boolean;
  confirm: boolean;
  candidates: number;
  extract: boolean;
  minSpecificity: number;
  minObservations: number;
  threshold: number;
  seed: string | number | null;
}

export function m15Settings(options: Readonly<JsonObject>): M15Settings {
  const num = (key: "hints" | "candidates" | "minObservations", least: number): number => {
    const v = options[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(least, Math.floor(v)) : M15_OPTIONS[key];
  };
  const flag = (key: "cells" | "confirm" | "extract"): boolean => (typeof options[key] === "boolean" ? (options[key] as boolean) : M15_OPTIONS[key]);
  const seed = options.seed;
  const share = options.minSpecificity;
  const threshold = options.threshold;
  return {
    cells: flag("cells"),
    hints: num("hints", 0),
    random: options.retrieval === "random",
    confirm: flag("confirm"),
    candidates: num("candidates", 1),
    extract: flag("extract"),
    minSpecificity: typeof share === "number" && share >= 0 && share <= 1 ? share : M15_OPTIONS.minSpecificity,
    minObservations: num("minObservations", 1),
    threshold: typeof threshold === "number" && threshold > 0 && threshold < 1 ? threshold : M15_OPTIONS.threshold,
    seed: typeof seed === "number" || typeof seed === "string" ? seed : null,
  };
}

// -- what the line records ------------------------------------------------------------------------------------------

/**
 * The nodes the line writes. A pick and a hint are what the line learned to do and what came of it, so they are `learned` and carry the
 * run's provenance stamp; the snapshot of the archive is a reading of Lean's verdicts and is not stamped. A schema is a `library_schema` node.
 */
export const M15_PICK_KIND = "m15_pick";
export const M15_HINT_KIND = "m15_hint";
export const M15_ARCHIVE_KIND = "m15_archive";

/** The arm of a pick that asks for no cell: a decomposition unlike the archive's. */
export const NEW_CELL = "new";

export type PickOutcome = "improved" | "not_improved" | "void";

/** One session's choice of a cell. */
export interface PickData {
  problemId: string;
  attemptId: string;
  prover: string;
  session: number;
  /** The cell's key, or `new`. */
  cell: string;
  /** The elite the session was told to extend. */
  elite?: string;
  /** The fitness of the cell's elite when it was picked (for `new`, the best of the archive), and the cells there were. */
  rhoBefore: number;
  cellsBefore: string[];
  /** Set when the session's sketch is known. */
  outcome?: PickOutcome;
  rhoAfter?: number;
  note?: string;
}

/** A schema offered to a session. */
export interface HintData {
  problemId: string;
  attemptId: string;
  /** The schema's node. */
  schemaId: string;
  name: string;
  arm: "match" | "random";
  /** The draw included it: the session was shown it. A withheld hint is the control of the effect. */
  shown: boolean;
  /** The schema written for the goal, with the parts Lean's instance check found covered; absent for a random schema. */
  instance?: { parts: Array<{ name: string; statement: string; covered?: string }>; mainProof: string };
  /** Whether the session's sketch has the schema's shape, once the sketch is known. */
  reused?: boolean;
  matched?: number;
}

/** What the archive held when a problem ended. */
export interface ArchiveSnapshot {
  problemId: string;
  members: number;
  cells: Array<{ key: string; family: string; depth: string; region: string; rho: number; closed: number; leaves: number; members: number; edgeId: string }>;
  families: string[];
}

const nodesOf = <T>(memory: MemoryStore, kind: string, problemId: string, claimId: string): Array<{ nodeId: string; epoch: number; data: T }> =>
  memory
    .nodes(kind, { claimId })
    .map((n) => ({ nodeId: n.nodeId, epoch: n.epoch, data: asRecord<T & { problemId: string }>(n.data) }))
    .filter((n) => n.data.problemId === problemId);

function sketchRecordsOf(memory: MemoryStore, problemId: string, claimId: string): SketchRecord[] {
  return memory
    .nodes(SKETCH_KIND, { claimId })
    .map((n) => asRecord<SketchRecord>(n.data))
    .filter((r) => r.problemId === problemId);
}

const sketchRecords = (problem: ProblemContext): SketchRecord[] => sketchRecordsOf(problem.memory, problem.problemId, problem.claimId);

/** The sketches of a problem that became a checked decomposition, with their main proofs. */
function sketchEntriesOf(memory: MemoryStore, problemId: string, claimId: string): SketchEntry[] {
  return sketchRecordsOf(memory, problemId, claimId).flatMap((r): SketchEntry[] => {
    if (!r.healthy || !r.registered || r.edgeId === undefined) return [];
    const blob = memory.blobs.get(r.submission);
    if (blob === undefined) return [];
    try {
      return [{ attemptId: r.attemptId, edgeId: r.edgeId, names: r.names, mainProof: (JSON.parse(blob) as { proof: string }).proof }];
    } catch {
      return [];
    }
  });
}

const archiveOf = (problem: ProblemContext): Archive => readArchive(problem.memory, problem.claimId, sketchEntriesOf(problem.memory, problem.problemId, problem.claimId));

/** A hole's name as a prompt may show it: an `aux_` identifier, nothing a model could use to carry text. */
export const isHoleName = (name: string): boolean => /^aux_[\p{L}\p{N}_']+$/u.test(name) && name.length <= 64;

const clip = (text: string, n: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function dedent(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(cut)).join("\n");
}

const indent = (text: string, by = "  "): string => text.split("\n").map((l) => (l.trim() === "" ? l : by + l)).join("\n");

// -- the posteriors of the cells ------------------------------------------------------------------------------------

/**
 * The posterior of each arm (a cell's key, or `new`) over the picks that came to an end: improved is a success, not improved a failure,
 * void says nothing. Each outcome counts with the probation weight of its epoch, so a pick from before a new epoch regains weight only
 * through new picks (PE1). Cells are the same kind of thing in every problem, so the counts pool across the memory's problems.
 */
export function cellPosteriors(memory: MemoryStore): Map<string, Beta> {
  const tally = new Map<string, { s: number; f: number }>();
  for (const node of memory.nodes(M15_PICK_KIND)) {
    const pick = asRecord<PickData>(node.data);
    if (pick.outcome !== "improved" && pick.outcome !== "not_improved") continue;
    const t = tally.get(pick.cell) ?? { s: 0, f: 0 };
    tally.set(pick.cell, t);
    const w = memory.weightOf(node.epoch);
    if (pick.outcome === "improved") t.s += w;
    else t.f += w;
  }
  return new Map([...tally].map(([key, t]) => [key, { alpha: 1 + t.s, beta: 1 + t.f }]));
}

const randomOf = (session: ProblemContext, s: M15Settings, what: string): (() => number) =>
  seeded(hash32(`${s.seed ?? session.seed ?? session.runId}:m15:${what}:${session.problemId}:${(session as SessionContext).prover}:${(session as SessionContext).session}`));

// -- the effect of a schema -----------------------------------------------------------------------------------------

/** Retires the schemas whose measured effect says they hurt (PE2): P(effect < 0) above the threshold after enough observations on each side. */
export function retireWorn(problem: ProblemContext, s: M15Settings): void {
  for (const schema of usableSchemas(problem.memory)) {
    const effect = problem.memory.itemEffect(schema.nodeId);
    if (!shouldDeactivate(effect, { minObservations: s.minObservations, threshold: s.threshold })) continue;
    const reason = `P(effect < 0) = ${effect.pNegative.toFixed(2)} with ${effect.with.attempts} attempt(s) that were shown it (${effect.with.successes.toFixed(1)} accepted) and ${effect.without.attempts} that were not (${effect.without.successes.toFixed(1)} accepted)`;
    problem.memory.updateNode(schema.nodeId, { state: "inactive", deactivated: { reason } } as unknown as Json, "retired by its effect");
    problem.log(`archive: schema ${schema.data.name} retired: ${reason}`);
  }
}

// -- settling what sessions came to ---------------------------------------------------------------------------------

/**
 * Settles the picks and hints of sessions that have ended: whether the cell's extension improved on its elite, and whether the session
 * reused the schema it was offered. A session's sketch is known once the scheduler has registered it, which is between sessions, so a
 * session that has ended with a sketch not yet registered waits (until `final`, when it counts as no decomposition). Safe to call twice.
 */
export function settle(problem: ProblemContext, final: boolean): void {
  const memory = problem.memory;
  const picks = nodesOf<PickData>(memory, M15_PICK_KIND, problem.problemId, problem.claimId).filter((n) => n.data.outcome === undefined);
  const hints = nodesOf<HintData>(memory, M15_HINT_KIND, problem.problemId, problem.claimId).filter((n) => n.data.reused === undefined);
  if (picks.length === 0 && hints.length === 0) return;
  const attempts = new Map(memory.attempts(problem.claimId).map((a) => [a.attemptId, a]));
  const sketches = sketchRecords(problem);
  let archive: Archive | undefined;
  const read = (): Archive => (archive ??= archiveOf(problem));
  const holesOf = (record: SketchRecord): string[] => record.holes.map((id) => memory.claim(id)?.statement ?? "");
  for (const { nodeId, data } of picks) {
    const attempt = attempts.get(data.attemptId);
    if (attempt === undefined || attempt.outcome === undefined) {
      if (final) memory.updateNode(nodeId, { outcome: "void", note: "the session did not end" } as unknown as Json, "the problem ended");
      continue;
    }
    let outcome: PickOutcome;
    let rhoAfter: number | undefined;
    let note: string | undefined;
    if (attempt.outcome === "valid") {
      outcome = "improved";
      rhoAfter = 1;
      note = "the session's proof passed";
    } else if (attempt.outcome !== "invalid" && attempt.outcome !== "no_submission") {
      outcome = "void";
      note = `the session ended ${attempt.outcome}`;
    } else {
      const record = sketches.find((r) => r.attemptId === data.attemptId);
      if (record === undefined) {
        outcome = "not_improved";
        note = "no sketch";
      } else if (!record.registered && !final) continue;
      else {
        const member = record.edgeId === undefined ? undefined : memberOf(read(), record.edgeId);
        if (member === undefined) {
          outcome = "not_improved";
          note = "the sketch is not a decomposition Lean checked";
        } else {
          rhoAfter = member.rho;
          // The replacement rule: a challenger counts when it is better than the elite the session was told to extend; on the fresh arm, when it fills a cell the archive did not have.
          const better = data.cell === NEW_CELL ? !data.cellsBefore.includes(member.key) : member.rho > data.rhoBefore;
          outcome = better ? "improved" : "not_improved";
          note = better ? undefined : "no better than the elite";
        }
      }
    }
    memory.updateNode(nodeId, { outcome, ...(rhoAfter !== undefined ? { rhoAfter } : {}), ...(note !== undefined ? { note } : {}) } as unknown as Json, "the session's sketch is known");
  }
  for (const { nodeId, data } of hints) {
    const attempt = attempts.get(data.attemptId);
    if (attempt === undefined || attempt.outcome === undefined) {
      if (final) memory.updateNode(nodeId, { reused: false, matched: 0 } as unknown as Json, "the problem ended");
      continue;
    }
    const record = sketches.find((r) => r.attemptId === data.attemptId);
    if (record !== undefined && !record.registered && !final) continue;
    const schema = memory.node(data.schemaId);
    const claim = memory.claim(problem.claimId);
    let result = { reused: false, matched: 0 };
    if (record?.registered === true && schema !== undefined && claim !== undefined) result = reuses(skeletonFrom(asRecord<SchemaData>(schema.data)), claim.statement, holesOf(record));
    memory.updateNode(nodeId, result as unknown as Json, "the session's sketch is known");
  }
}

// -- choosing the cell ----------------------------------------------------------------------------------------------

export function pickCell(session: SessionContext, archive: Archive, s: M15Settings): void {
  const posteriors = cellPosteriors(session.memory);
  const flat: Beta = { alpha: 1, beta: 1 };
  const arms: Array<[string, Beta]> = [...archive.cells.map((c): [string, Beta] => [c.key, posteriors.get(c.key) ?? flat]), [NEW_CELL, posteriors.get(NEW_CELL) ?? flat]];
  const chosen = thompson(randomOf(session, s, "cell"), arms)?.choice ?? NEW_CELL;
  const cell = archive.cells.find((c) => c.key === chosen);
  const data: PickData = {
    problemId: session.problemId, attemptId: session.attemptId, prover: session.prover, session: session.session,
    cell: chosen, ...(cell !== undefined ? { elite: cell.elite.edgeId } : {}),
    rhoBefore: cell?.elite.rho ?? Math.max(0, ...archive.cells.map((c) => c.elite.rho)), cellsBefore: archive.cells.map((c) => c.key),
  };
  session.memory.recordNode({ kind: M15_PICK_KIND, claimId: session.claimId, data: data as unknown as Json, learned: true });
}

// -- schemas for a goal ---------------------------------------------------------------------------------------------

interface Plan {
  schema: SchemaRecord;
  arm: HintData["arm"];
  instance?: NonNullable<HintData["instance"]>;
}

/** A schema made by a decomposition of this problem's own claim (or one equivalent to it) does not count as another problem's. */
function ownSchema(schema: SchemaRecord, session: ProblemContext): boolean {
  const same = new Set(session.memory.equivalents(session.claimId));
  return schema.data.supports.length > 0 && schema.data.supports.every((sup) => same.has(sup.claimId));
}

/**
 * Keeps a closed decomposition as a schema: as one more support of an active schema that covers it, as the generalization of the first
 * schema it can be anti-unified with (which becomes `superseded`), or as a schema of its own. Returns how many schemas were made.
 */
export function keepSchema(problem: ProblemContext, skeleton: Skeleton, rest: Parameters<typeof dataOf>[1], minSpecificity: number): number {
  const memory = problem.memory;
  const active = usableSchemas(memory).filter((x) => x.data.parts.length === skeleton.parts.length && x.data.region === rest.region);
  for (const old of active) {
    if (covers(skeletonFrom(old.data), skeleton)) {
      memory.updateNode(old.nodeId, { supports: [...old.data.supports, ...rest.supports] } as unknown as Json, "another decomposition of this shape closed");
      return 0;
    }
  }
  for (const old of active) {
    const general = generalize(skeletonFrom(old.data), skeleton, minSpecificity);
    if (general === undefined) continue;
    const data = dataOf(general, { ...rest, names: old.data.names, supports: [...old.data.supports, ...rest.supports] });
    memory.recordNode({ kind: SCHEMA_KIND, claimId: rest.supports[0]?.claimId ?? problem.claimId, data: { ...data, generalizes: [old.nodeId] } as unknown as Json, learned: true });
    memory.updateNode(old.nodeId, { state: "superseded" } as unknown as Json, "generalized by a schema that covers it and a new decomposition");
    return 1;
  }
  memory.recordNode({ kind: SCHEMA_KIND, claimId: rest.supports[0]?.claimId ?? problem.claimId, data: dataOf(skeleton, rest) as unknown as Json, learned: true });
  return 1;
}


export function createM15Line(): Line {
  /** The answers of lean.meta that do not change: schema and goal, as the process saw them. */
  const confirmed = new Map<string, { ok: boolean; why?: string }>();

  async function soft<T>(problem: ProblemContext, what: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      if (isInterrupted(error)) throw error;
      if (problem.signal.aborted) return undefined;
      problem.log(`archive: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async function coverParts(session: SessionContext, meta: LeanMeta, parts: Instance["parts"]): Promise<NonNullable<HintData["instance"]>["parts"]> {
    const header = session.target.sketch.prefix;
    const facts = knownFacts(session.memory, header, [session.claimId], 20);
    if (facts.length === 0) return parts.map((p) => ({ ...p }));
    const out: NonNullable<HintData["instance"]>["parts"] = [];
    for (const part of parts) {
      let covered: string | undefined;
      const found = await soft(session, "the comparison of a part with the accepted facts", () =>
        meta.instances(part.statement, facts.map((f) => ({ name: f.claimId, statement: f.statement })), { header, signal: session.signal }),
      );
      if (found !== undefined) covered = found.instanceOf.find((id) => facts.some((f) => f.claimId === id));
      out.push({ ...part, ...(covered !== undefined ? { covered } : {}) });
    }
    return out;
  }

  /** The schemas a session may be offered: by the arm of the run, `match` (fits the goal, confirmed) or `random` (the plan's control). */
  async function plansFor(session: SessionContext, s: M15Settings): Promise<Plan[]> {
    if (s.hints <= 0) return [];
    const schemas = usableSchemas(session.memory).filter((x) => !ownSchema(x, session));
    if (schemas.length === 0) return [];
    if (s.random) {
      const random = randomOf(session, s, "random");
      const pool = [...schemas];
      const out: Plan[] = [];
      while (out.length < s.hints && pool.length > 0) out.push({ schema: pool.splice(Math.floor(random() * pool.length), 1)[0] as SchemaRecord, arm: "random" });
      return out;
    }
    const goal = session.memory.claim(session.claimId)?.statement ?? session.target.statement;
    const header = session.target.sketch.prefix;
    // The index orders the schemas that fit the goal; fitting is the lexical match, which is cheap, so every active schema is tried.
    const rank = new Map(new SchemaIndex(schemas).search(goal).map((id, k) => [id, k]));
    const fits = schemas
      .flatMap((schema) => {
        const instance = instantiate(skeletonFrom(schema.data), schema.data.names, goal);
        return instance === undefined ? [] : [{ schema, instance, rank: rank.get(schema.nodeId) ?? Number.MAX_SAFE_INTEGER }];
      })
      .sort((a, b) => a.rank - b.rank);
    const meta = new LeanMeta(session.registry, { actor: "line:M15", attemptId: session.attemptId });
    const out: Plan[] = [];
    let asked = 0;
    for (const fit of fits) {
      if (out.length >= s.hints || asked >= s.candidates) break;
      if (s.confirm) {
        const key = `${fit.schema.nodeId}|${header}|${goal}`;
        let answer = confirmed.get(key);
        if (answer === undefined) {
          asked += 1;
          const got = await confirm(meta, skeletonFrom(fit.schema.data), goal, header, session.signal);
          answer = got;
          if (got.retry !== true) confirmed.set(key, got);
        }
        if (!answer.ok) {
          session.log(`archive: schema ${fit.schema.data.name} not used: ${answer.why ?? "not confirmed"}`);
          continue;
        }
      }
      const parts = await coverParts(session, meta, fit.instance.parts);
      out.push({ schema: fit.schema, arm: "match", instance: { parts, mainProof: fit.instance.mainProof } });
    }
    return out;
  }

  async function hint(session: SessionContext, s: M15Settings): Promise<void> {
    const plans = await plansFor(session, s);
    if (plans.length === 0) return;
    // The schemas are unverified advice (which decomposition to try), so a session may be denied them (PE2); the effect of each is measured on the sessions that were and were not shown it.
    const drawn = session.draw(plans.map((p) => p.schema.nodeId));
    for (const plan of plans) {
      const data: HintData = {
        problemId: session.problemId, attemptId: session.attemptId, schemaId: plan.schema.nodeId, name: plan.schema.data.name, arm: plan.arm,
        shown: drawn.included.includes(plan.schema.nodeId), ...(plan.instance !== undefined ? { instance: plan.instance } : {}),
      };
      session.memory.recordNode({ kind: M15_HINT_KIND, claimId: session.claimId, data: data as unknown as Json, learned: true });
    }
  }

  // -- the briefing ------------------------------------------------------------------------------------------------

  function describeCell(c: Cell): string {
    const e = c.elite;
    return `${e.parts.length} part${e.parts.length === 1 ? "" : "s"}, main proof by ${e.family}, ${e.closed} of ${e.leaves} leaves closed`;
  }

  function cellSection(session: SessionContext, archive: Archive, pick: PickData): Briefing | undefined {
    if (pick.cell === NEW_CELL) {
      // The fresh arm: say what the archive holds, as kinds, and ask for another one.
      const kinds = archive.cells.map((c) => `- ${describeCell(c)} (${c.region})`);
      if (kinds.length === 0) return undefined;
      return {
        title: "Decompositions tried",
        text: `The decompositions of this theorem that Lean has checked so far, by kind:\n${kinds.join("\n")}\nTry a decomposition of another kind: other parts, or a main proof that goes about it differently. Lean decides what is proved.`,
      };
    }
    const cell = archive.cells.find((c) => c.key === pick.cell);
    const e = cell?.elite;
    if (cell === undefined || e === undefined || e.names === undefined || e.mainProof === undefined) return undefined;
    const source = memorySource(session.memory, () => session.target.sketch.prefix);
    const holes: string[] = [];
    for (const [k, id] of e.parts.entries()) {
      const claim = session.memory.claim(id);
      if (claim === undefined || screenFormal(claim.statement, 600) !== undefined) return undefined;
      const name = e.names[k] ?? `aux_part_${k + 1}`;
      const proof = claim.status === "computed" || claim.status === "proved" ? source.proofOf(id, "proved") : undefined;
      const body = proof !== undefined && screenFormal(proof.proof, 2000) === undefined && proof.aux.trim() === "" ? `closed: Lean accepted\n${indent(dedent(proof.proof))}` : claim.status === "computed" || claim.status === "proved" ? "closed: Lean accepted" : "open: not proved yet";
      holes.push(`lemma ${name} ${claim.statement.trim()}\n${indent(body)}`);
    }
    if (screenFormal(e.mainProof, 2000) !== undefined || !e.names.every(isHoleName)) return undefined;
    return {
      title: "Decomposition to extend",
      text:
        `Several decompositions of this theorem are being kept. The one below (${describeCell(cell)}) is the best of its kind so far. Extend it instead of starting again: keep its closed lemmas under their names, prove or restate the open ones, or change the main proof; ` +
        `a sketch that closes more of its leaves replaces it. This is advice, not a fact about your theorem: Lean decides what is proved.\n\n${holes.join("\n\n")}\n\nMain proof:\n${indent(dedent(e.mainProof))}`,
    };
  }

  function hintSection(session: SessionContext): Briefing | undefined {
    const shown = new Set(session.drawn.included);
    const hints = nodesOf<HintData>(session.memory, M15_HINT_KIND, session.problemId, session.claimId).filter((h) => h.data.attemptId === session.attemptId && h.data.shown && shown.has(h.data.schemaId));
    if (hints.length === 0) return undefined;
    // Stored text is screened again where it is shown: a node may come from an earlier journal or another writer.
    const clean = (text: string, limit: number): boolean => screenFormal(text.replace(/\?\d+/g, "x"), limit) === undefined;
    const texts = hints.flatMap(({ data }) => {
      const schema = session.memory.node(data.schemaId);
      if (schema === undefined) return [];
      const d = asRecord<SchemaData>(schema.data);
      if (!d.names.every(isHoleName) || !clean(d.mainProof, 2000)) return [];
      if (data.instance !== undefined) {
        const i = data.instance;
        if (!clean(i.mainProof, 2000) || !i.parts.every((p) => isHoleName(p.name) && clean(p.statement, 600))) return [];
        const lemmas = i.parts.map((p) => `lemma ${p.name} ${p.statement} := by\n  sorry${p.covered !== undefined ? "\n(an instance of a fact Lean accepted for this problem: prove it from that fact)" : ""}`);
        return [`A decomposition of this shape closed on another problem. Written for your theorem it is this sketch:\n\n${lemmas.join("\n\n")}\n\nMain proof:\n${indent(dedent(i.mainProof))}`];
      }
      if (!clean(d.conclusion, 600) || !d.parts.every((p) => clean(p, 600)) || !/^[0-9A-Za-z:=]+$|^\d+p:\S{1,8}$/.test(d.region) || !/^[a-z_]+$/.test(d.family)) return [];
      return [`A decomposition of this shape (${d.region}, main proof by ${d.family}) closed on another problem. ?1, ?2... stand for the terms that differ:\n\nTheorem ${d.conclusion}\n${d.parts.map((p, k) => `lemma ${d.names[k] ?? `aux_part_${k + 1}`} ${p}`).join("\n")}\n\nMain proof:\n${indent(dedent(d.mainProof))}`];
    });
    if (texts.length === 0) return undefined;
    return {
      title: "Decompositions that closed before",
      text: `Advice from other problems, not proved: it may not fit this theorem. Check any sketch you build from it with lean_check.\n\n${texts.join("\n\n---\n\n")}`,
    };
  }

  // -- the schemas of a finished problem -----------------------------------------------------------------------------

  /**
   * Keeps each decomposition the kernel closed as a schema, or as one more support of a schema that covers it or that it generalizes. It
   * reads the snapshots of the problems that have ended, not the current problem alone: the certifier runs after `afterProblem`, so a
   * decomposition is certified only by the time a later session (or the end of a later problem) looks again. Only a decomposition all
   * of whose leaves are closed at the certified level (`proved`) is kept; a leaf the fast check accepted (`computed`) is not enough.
   */
  function extract(problem: ProblemContext, s: M15Settings): number {
    const memory = problem.memory;
    let made = 0;
    for (const snap of memory.nodes(M15_ARCHIVE_KIND)) {
      const claimId = snap.claimId;
      const snapshot = asRecord<ArchiveSnapshot>(snap.data);
      if (claimId === undefined || memory.claim(claimId) === undefined) continue;
      const archive = readArchive(memory, claimId, sketchEntriesOf(memory, snapshot.problemId, claimId));
      made += extractFrom(problem, snapshot.problemId, claimId, archive, s);
    }
    return made;
  }

  function extractFrom(problem: ProblemContext, problemId: string, claimId: string, archive: Archive, s: M15Settings): number {
    const memory = problem.memory;
    let made = 0;
    for (const m of archive.members) {
      if (!m.certified || m.depth !== 1 || m.names === undefined || m.mainProof === undefined || !m.names.every(isHoleName)) continue;
      if (allSchemas(memory).some((x) => x.data.supports.some((sup) => sup.edgeId === m.edgeId))) continue;
      const record = sketchRecordsOf(memory, problemId, claimId).find((r) => r.edgeId === m.edgeId);
      const stored = record === undefined ? undefined : memory.blobs.get(record.submission);
      if (stored === undefined) continue;
      const reading = readSketch(JSON.parse(stored) as { aux: string; proof: string });
      if (reading.others.length > 0 || reading.holes.length !== m.parts.length) {
        problem.log(`archive: no schema from ${m.edgeId}: the sketch holds more than its holes`);
        continue;
      }
      const claim = memory.claim(m.claimId);
      const parts = m.parts.map((id) => memory.claim(id)?.statement);
      if (claim === undefined || parts.some((p) => p === undefined)) continue;
      const skeleton = skeletonOf({ conclusion: claim.statement, parts: parts as string[], mainProof: m.mainProof }, s.minSpecificity);
      if (typeof skeleton === "string") {
        problem.log(`archive: no schema from ${m.edgeId}: ${skeleton}`);
        continue;
      }
      const support = { problemId, claimId: m.claimId, edgeId: m.edgeId };
      const rest = { names: m.names, family: m.family, region: m.region, gloss: `A decomposition into ${m.parts.length} part${m.parts.length === 1 ? "" : "s"} that closed (${m.family}).` };
      made += keepSchema(problem, skeleton, { ...rest, supports: [support] }, s.minSpecificity);
    }
    return made;
  }

  function snapshot(problem: ProblemContext, archive: Archive): void {
    if (archive.members.length === 0) return;
    const data: ArchiveSnapshot = {
      problemId: problem.problemId,
      members: archive.members.length,
      cells: archive.cells.map((c) => ({ key: c.key, family: c.family, depth: c.depth, region: c.region, rho: c.elite.rho, closed: c.elite.closed, leaves: c.elite.leaves, members: c.members, edgeId: c.elite.edgeId })),
      families: archive.members.map((m) => m.family),
    };
    const existing = nodesOf<ArchiveSnapshot>(problem.memory, M15_ARCHIVE_KIND, problem.problemId, problem.claimId)[0];
    if (existing === undefined) problem.memory.recordNode({ kind: M15_ARCHIVE_KIND, claimId: problem.claimId, data: data as unknown as Json });
    else problem.memory.updateNode(existing.nodeId, data as unknown as Json, "the archive at the end of the problem");
  }

  return {
    id: "M15",
    title: LINE_TITLES.M15,
    requires: ["M12"],
    options: M15_OPTIONS,
    version: "m15-1",
    // The ladder starts the line when the problem has spent its budget without Lean progress and the cheaper rungs did not help (PE4).
    rung: 2,
    // Everything it knows it reads from the memory: sketches, edges, claims, picks, hints and schemas are nodes and journal records.
    resume: "stateless",
    hooks: {
      beforeSession: async (session) => {
        const s = m15Settings(session.options);
        settle(session, false);
        if (s.extract) {
          const made = extract(session, s);
          if (made > 0) session.log(`archive: ${made} schema${made === 1 ? "" : "s"} made from decompositions the kernel closed`);
        }
        retireWorn(session, s);
        if (s.cells) {
          const archive = archiveOf(session);
          if (archive.cells.length > 0) pickCell(session, archive, s);
        }
        await soft(session, "the choice of schemas", () => hint(session, s));
        return undefined;
      },

      briefingSections: async (session): Promise<Briefing[] | undefined> => {
        const sections: Briefing[] = [];
        const pick = nodesOf<PickData>(session.memory, M15_PICK_KIND, session.problemId, session.claimId).find((n) => n.data.attemptId === session.attemptId)?.data;
        if (pick !== undefined) {
          const section = cellSection(session, archiveOf(session), pick);
          if (section !== undefined) sections.push(section);
        }
        const shown = hintSection(session);
        if (shown !== undefined) sections.push(shown);
        return sections.length === 0 ? undefined : sections;
      },

      afterProblem: async (problem) => {
        const s = m15Settings(problem.options);
        settle(problem, true);
        const archive = archiveOf(problem);
        snapshot(problem, archive);
        if (s.extract) {
          const made = extract(problem, s);
          if (made > 0) problem.log(`archive: ${made} schema${made === 1 ? "" : "s"} made from closed decompositions`);
        }
      },
    },
  };
}

/** The instance the orchestrator registers (`packages/orchestrator/src/lines.ts`). */
export const m15Line: Line = createM15Line();
