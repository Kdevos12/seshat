import { type Briefing, type JsonObject, LINE_TITLES, type Line, type LineTool, type ProblemContext, type SessionContext, type SessionDecision } from "@seshat/lines";
import type { Claim, MemoryStore } from "@seshat/memory";
import { type Registry, RegistryLeanChecker } from "@seshat/registry";
import { type Battery, graphBattery, groupBattery, integerBattery, magmaBattery } from "./battery.ts";
import { lookupSequence, type OeisClient } from "./clients.ts";
import {
  addPlannedEdges,
  type Compared,
  countVerdicts,
  type EvaluatorKind,
  evaluateMagmaStatement,
  fingerprintsOf,
  planRelations,
  recordBattery,
  recordFingerprint,
  relate,
  verdictString,
} from "./fingerprint.ts";
import { type IdentificationData, recordIdentification } from "./identify.ts";
import { evaluateWithLean } from "./lean-eval.ts";
import type { BatteryObject, IntegerObject, MagmaObject } from "./objects.ts";
import { type CounterModelData, describeCounterModel, recordCounterModel, submitRefutation } from "./refutation.ts";
import { runProgram } from "./sandbox.ts";
import { type RecognizedStatement, recognizeStatement } from "./statement.ts";

const ACTOR = "line:M11";

/**
 * The options of line M11 and their defaults. A run changes them with `--line-option M11.<name>=<value>`.
 */
export const M11_DEFAULTS = {
  /** Magmas are listed up to this many elements (0 to 3; 1, 10 and 3 330 magmas of size 1, 2, 3). */
  exhaustive: 3,
  /** The size of the sampled magmas (4 to 6) and how many are drawn (0 for none), with their seed. */
  sampleSize: 4,
  samples: 120,
  seed: 1,
  /** A statement about a natural number is tried on 0 to this number. */
  maxNumber: 100,
  /** Lean's time limit for each file of the evaluator. */
  leanTimeoutSec: 60,
  /** Submit the negation of a statement that fails on a counter-model through `validate`. */
  refute: true,
  /** The most counter-models to submit, one after the other, until a negation passes. */
  counterModels: 3,
  /** Stop the problem's provers once a proof of the negation has passed Lean's check. */
  stopWhenRefuted: true,
  /** The most claims related to the problem's whose fingerprints are compared with its own, and how many edges away they are searched. */
  neighbors: 8,
  neighborDepth: 2,
  /** Look the numbers where a statement holds, or fails, up as a sequence, from at most this many terms. */
  identify: true,
  identifyTerms: 40,
  /** The numbers the `small_models` tool tries a statement about a number on. */
  toolMaxNumber: 30,
} satisfies JsonObject;

export type M11Options = { [K in keyof typeof M11_DEFAULTS]: (typeof M11_DEFAULTS)[K] extends boolean ? boolean : number };

/** The line's options as the run gave them, checked: a hook that reads a bad value fails with the name of the option. */
export function readOptions(raw: Readonly<JsonObject>): M11Options {
  const integer = (key: keyof M11Options, min: number, max: number): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`option M11.${key} is an integer from ${min} to ${max}, not ${JSON.stringify(value)}`);
    }
    return value;
  };
  const flag = (key: keyof M11Options): boolean => {
    const value = raw[key];
    if (typeof value !== "boolean") throw new TypeError(`option M11.${key} is true or false, not ${JSON.stringify(value)}`);
    return value;
  };
  return {
    exhaustive: integer("exhaustive", 0, 3),
    sampleSize: integer("sampleSize", 4, 6),
    samples: integer("samples", 0, 5000),
    seed: integer("seed", 0, 2 ** 31 - 1),
    maxNumber: integer("maxNumber", 1, 1000),
    leanTimeoutSec: integer("leanTimeoutSec", 1, 600),
    refute: flag("refute"),
    counterModels: integer("counterModels", 1, 10),
    stopWhenRefuted: flag("stopWhenRefuted"),
    neighbors: integer("neighbors", 0, 50),
    neighborDepth: integer("neighborDepth", 1, 4),
    identify: flag("identify"),
    identifyTerms: integer("identifyTerms", 4, 200),
    toolMaxNumber: integer("toolMaxNumber", 1, 200),
  };
}

/** The objects a statement is tried on: magmas for a statement of magmas, the numbers from 0 for a statement about a number. */
export function batteryFor(statement: RecognizedStatement, options: M11Options, maxNumber: number = options.maxNumber): Battery {
  return statement.kind === "magma"
    ? magmaBattery({ exhaustive: options.exhaustive, sampleSize: options.sampleSize, samples: options.samples, seed: options.seed })
    : integerBattery(maxNumber, { min: 0 });
}

// --- Trying a statement ------------------------------------------------------------------------

interface Tried {
  verdicts: Array<boolean | null>;
  /** For the law evaluator, the values of the conclusion's variables that break it. */
  witnesses: Array<number[] | undefined>;
  evaluator: EvaluatorKind;
  /** Set when the statement could not be tried at all. */
  unusable?: string;
}

interface Environment {
  registry: Registry;
  signal: AbortSignal;
  leanTimeoutSec: number;
  attemptId?: string;
}

/**
 * The verdicts of a statement on a battery: statements of magmas by the law evaluator in
 * TypeScript, statements about a number by `decide` in Lean through the registry's `lean.check`.
 */
async function tryStatement(env: Environment, statement: RecognizedStatement, battery: Battery, header: string): Promise<Tried> {
  if (statement.kind === "magma") {
    const { verdicts, witnesses } = evaluateMagmaStatement(statement, battery.objects as readonly MagmaObject[]);
    return { verdicts, witnesses, evaluator: "law" };
  }
  const checker = new RegistryLeanChecker(env.registry, { actor: ACTOR, ...(env.attemptId !== undefined ? { attemptId: env.attemptId } : {}) });
  const evaluation = await evaluateWithLean(checker, { header, statement, objects: battery.objects }, { timeoutSec: env.leanTimeoutSec, signal: env.signal });
  return {
    verdicts: evaluation.verdicts,
    witnesses: evaluation.verdicts.map(() => undefined),
    evaluator: "lean",
    ...(evaluation.unusable !== undefined ? { unusable: evaluation.unusable } : {}),
  };
}

function recordTried(memory: MemoryStore, claimId: string, battery: Battery, tried: Tried): string {
  const batteryNode = recordBattery(memory, battery);
  const fingerprint = recordFingerprint(memory, { claimId, battery, batteryNode: batteryNode.nodeId, verdicts: tried.verdicts, evaluator: tried.evaluator });
  return fingerprint.nodeId;
}

/** The verdicts a claim already has on this battery, if a fingerprint of it was recorded. */
function storedVerdicts(memory: MemoryStore, claimId: string, battery: Battery): string | undefined {
  return fingerprintsOf(memory, claimId).find((f) => f.data.digest === battery.digest && f.data.battery === battery.id)?.data.verdicts;
}

// --- The claims around a claim -----------------------------------------------------------------

/** The edges that relate two statements about the same objects. */
const RELATED = ["implies", "equiv", "special_case_of", "strengthens", "instance_of", "derived_from"] as const;

/**
 * The claims within `depth` edges of a claim, nearest first, at most `limit` of them: the variants,
 * weakenings and consequences that other lines record. The memory has no listing of its claims, so
 * they are found by following edges, in both directions.
 */
export function neighborClaims(memory: MemoryStore, claimId: string, depth: number, limit: number): Claim[] {
  const seen = new Set<string>([claimId]);
  const found: Claim[] = [];
  let frontier = [claimId];
  for (let step = 0; step < depth && frontier.length > 0 && found.length < limit; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      const edges = [...memory.edges({ from: id, kinds: RELATED }), ...memory.edges({ to: id, kinds: RELATED })];
      for (const edge of edges) {
        for (const other of [edge.from, ...edge.to]) {
          if (seen.has(other)) continue;
          seen.add(other);
          const claim = memory.claim(other);
          if (claim === undefined) continue;
          next.push(other);
          found.push(claim);
          if (found.length >= limit) return found;
        }
      }
    }
    frontier = next;
  }
  return found;
}

// --- The hooks ---------------------------------------------------------------------------------

export interface M11Services {
  /** An OEIS client to look sequences up beyond the table shipped with the package. Default: none, the table only. */
  oeis?: OeisClient;
}

async function beforeProvers(problem: ProblemContext, services: M11Services): Promise<void> {
  const options = readOptions(problem.options);
  const recognized = recognizeStatement(problem.target.statement);
  if (!("statement" in recognized)) {
    problem.log(`M11: the statement is left alone: ${recognized.reason}`);
    return;
  }
  const statement = recognized.statement;
  const battery = batteryFor(statement, options);
  const env: Environment = { registry: problem.registry, signal: problem.signal, leanTimeoutSec: options.leanTimeoutSec };
  const header = problem.target.sketch.prefix;

  const tried = await tryStatement(env, statement, battery, header);
  if (tried.unusable !== undefined) {
    problem.log(`M11: the statement could not be tried: ${tried.unusable}`);
    return;
  }
  if (problem.signal.aborted) return;
  recordTried(problem.memory, problem.claimId, battery, tried);
  const counts = countVerdicts(verdictString(tried.verdicts));
  problem.log(`M11: on ${battery.id} (${battery.objects.length} objects) the statement holds on ${counts.holds}, fails on ${counts.fails}, no verdict on ${counts.unknown}`);

  await refute(problem, options, battery, statement, tried);
  if (problem.signal.aborted) return;
  await compareNeighbors(problem, options, env, battery, statement, tried);
  if (problem.signal.aborted) return;
  if (statement.kind === "nat" && options.identify) await identify(problem, options, battery, tried, services);
}

/**
 * A counter-model is recorded, and its negation submitted through `validate`: the fingerprint is a
 * test, and only a Lean proof of the negation counts. The next counter-model is tried when none of
 * the proofs of this one passes, since the evaluator and Lean may read the statement differently.
 */
async function refute(problem: ProblemContext, options: M11Options, battery: Battery, statement: RecognizedStatement, tried: Tried): Promise<void> {
  const failing = tried.verdicts.flatMap((verdict, index) => (verdict === false ? [index] : []));
  for (const index of failing.slice(0, options.refute ? options.counterModels : 1)) {
    const object = battery.objects[index];
    if (object === undefined || (object.kind !== "magma" && object.kind !== "integer")) continue;
    const witness = tried.witnesses[index];
    const { node } = recordCounterModel(problem.memory, {
      claimId: problem.claimId,
      battery,
      index,
      object,
      evaluator: tried.evaluator,
      ...(witness !== undefined ? { witness } : {}),
    });
    problem.log(`M11: the statement fails on ${describeCounterModel(object)}`);
    if (!options.refute) return;
    const attempts = await submitRefutation(problem.validate, { claimId: problem.claimId, statement, object });
    problem.memory.updateNode(node.nodeId, { refutation: attempts }, "the negation was submitted through validate");
    const valid = attempts.find((a) => a.verdict === "valid");
    problem.log(
      valid !== undefined
        ? `M11: a proof of the negation passed the fast check (${valid.form}, validation ${valid.validationId ?? "not recorded"}); the claim is ${valid.status} until the certifier replays it`
        : `M11: Lean did not accept the proofs of the negation (${attempts.map((a) => a.reasons[0] ?? a.verdict).join(" | ")})`,
    );
    if (valid !== undefined || problem.signal.aborted) return;
  }
}

/**
 * Fingerprints the claims around the problem's on the same battery, and records the candidate
 * `equiv` and `implies` edges among all of them (the problem's claim included) as `computed`.
 */
async function compareNeighbors(
  problem: ProblemContext,
  options: M11Options,
  env: Environment,
  battery: Battery,
  statement: RecognizedStatement,
  tried: Tried,
): Promise<void> {
  if (options.neighbors === 0) return;
  const compared: Compared[] = [{ claimId: problem.claimId, statement, verdicts: verdictString(tried.verdicts) }];
  for (const claim of neighborClaims(problem.memory, problem.claimId, options.neighborDepth, options.neighbors)) {
    if (claim.kind !== "formal") continue;
    const recognized = recognizeStatement(claim.statement);
    if (!("statement" in recognized) || recognized.statement.kind !== statement.kind) continue;
    let verdicts = storedVerdicts(problem.memory, claim.claimId, battery);
    if (verdicts === undefined) {
      const other = await tryStatement(env, recognized.statement, battery, claim.header ?? problem.target.sketch.prefix);
      if (other.unusable !== undefined) {
        problem.log(`M11: claim ${claim.claimId} could not be tried: ${other.unusable}`);
        continue;
      }
      recordTried(problem.memory, claim.claimId, battery, other);
      verdicts = verdictString(other.verdicts);
    }
    compared.push({ claimId: claim.claimId, statement: recognized.statement, verdicts });
    if (problem.signal.aborted) return;
  }
  const shape = { id: battery.id, size: battery.objects.length };
  const added = addPlannedEdges(problem.memory, compared.flatMap((first, i) => planRelations(first, compared.slice(i + 1), shape)));
  if (compared.length > 1) problem.log(`M11: ${compared.length - 1} related claims compared, ${added.length} candidate edges recorded`);
}

/** Looks up the numbers where a statement holds, and those where it fails, as sequences. */
async function identify(problem: ProblemContext, options: M11Options, battery: Battery, tried: Tried, services: M11Services): Promise<void> {
  const objects = battery.objects as readonly IntegerObject[];
  const first = objects[0];
  const last = objects[objects.length - 1];
  if (first === undefined || last === undefined) return;
  for (const [what, wanted] of [["holds", true], ["fails", false]] as const) {
    const values = objects.flatMap((object, i) => (tried.verdicts[i] === wanted ? [object.value] : []));
    // Every number, or too few to say anything: nothing to look up.
    if (values.length < 4 || values.length === objects.length) continue;
    // The first numbers in a row (1, 2, 3, ...) say only that the statement holds, or fails, from there on.
    const terms = values.slice(0, options.identifyTerms);
    if (terms.every((v, i) => i === 0 || v === (terms[i - 1] as number) + 1)) continue;
    const identification = await lookupSequence(terms, services.oeis !== undefined ? { oeis: services.oeis } : {}, { signal: problem.signal });
    if (identification.matches.length === 0) continue;
    recordIdentification(problem.memory, { claimId: problem.claimId, subject: `the numbers from ${first.value} to ${last.value} where the statement ${what}`, identification });
    const best = identification.matches[0];
    problem.log(`M11: the numbers where the statement ${what} match ${best?.id ?? "no sequence"} (${identification.strength})`);
  }
}

// --- What the provers are told ------------------------------------------------------------------

const EVALUATOR_WORDS: Readonly<Record<EvaluatorKind, string>> = { law: "by evaluating its laws", lean: "by `decide` in Lean", program: "by a program" };

/**
 * What the line found about a claim, in words, for a session's opening message: read back from the
 * records, so that it says what the memory holds. Undefined when the claim has no fingerprint.
 */
export function describeFindings(memory: MemoryStore, claimId: string): string | undefined {
  const latest = fingerprintsOf(memory, claimId).at(-1);
  if (latest === undefined) return undefined;
  const f = latest.data;
  const total = f.counts.holds + f.counts.fails + f.counts.unknown;
  const lines = [
    `Before any prover started, the statement was tried on ${total} small objects (battery ${f.battery}, ${EVALUATOR_WORDS[f.evaluator]}): it holds on ${f.counts.holds}, fails on ${f.counts.fails}${f.counts.unknown > 0 ? `, no verdict on ${f.counts.unknown}` : ""}.`,
  ];
  const counterModel = memory.nodes("counter_model", { claimId })[0];
  if (counterModel !== undefined) {
    const data = counterModel.data as CounterModelData;
    const attempts = data.refutation ?? [];
    const valid = attempts.find((a) => a.verdict === "valid");
    const status = memory.claim(claimId)?.status;
    lines.push(`A counter-model: ${data.description}.`);
    if (valid !== undefined) {
      lines.push(
        `A Lean proof of the negation built from it passed the fast check (validation ${valid.validationId ?? "not recorded"}), so the statement is false as it is written; the claim is ${status === "refuted" ? "refuted" : "still open until the certifier replays the negation"}. Do not spend the session proving it. If the statement is not what its source means, say so in your notes.`,
      );
    } else if (attempts.length > 0) {
      lines.push(`Lean did not accept the proofs of the negation built from it (${attempts[attempts.length - 1]?.reasons[0] ?? "no reason given"}). The evaluator and Lean may read the statement differently: look at it before relying on the counter-model.`);
    } else {
      lines.push("No proof of the negation was submitted.");
    }
  } else if (f.counts.fails === 0) {
    lines.push("No counter-model among them: this is evidence for the statement, and no proof of it.");
  }
  const related = [...memory.edges({ from: claimId, kinds: ["equiv", "implies"] }), ...memory.edges({ to: claimId, kinds: ["equiv", "implies"] })]
    .filter((edge) => edge.status === "computed" && edge.note?.startsWith("candidate") === true)
    .slice(0, 5);
  for (const edge of related) {
    const other = edge.from === claimId ? edge.to[0] : edge.from;
    const statement = other === undefined ? undefined : memory.claim(other)?.statement;
    if (other === undefined || statement === undefined) continue;
    const verb = edge.kind === "equiv" ? "is equivalent to" : edge.from === claimId ? "implies" : "is implied by";
    lines.push(`Candidate, from the fingerprints: this claim ${verb} claim ${other}, \`${statement}\`.${edge.link !== undefined ? ` The lemma \`${edge.link.name}\` would prove it.` : ""}`);
  }
  for (const node of memory.nodes("identification", { claimId })) {
    const data = node.data as IdentificationData;
    const best = data.matches[0];
    if (best === undefined) continue;
    const subject = `${data.subject.charAt(0).toUpperCase()}${data.subject.slice(1)}`;
    lines.push(
      `${subject} begin ${data.query.slice(0, 8).join(", ")}${data.query.length > 8 ? " and so on" : ""}. They match ${best.id}, "${best.name}"${best.next.length > 0 ? `, which goes on ${best.next.join(", ")}` : ""}. This is a ${data.strength} match, a lookup and no proof: it suggests a form to conjecture and then prove.`,
    );
  }
  lines.push("These are tests on finite objects. Only a Lean proof settles a claim.");
  return lines.join("\n");
}

// --- The tool ----------------------------------------------------------------------------------

const SHAPES =
  "A statement is in signature form: `(M : Type) [Mul M] : ∀ x y z : M, x * (y * z) = (x * y) * z` or " +
  "`(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x` (laws of magmas, up to eight variables), " +
  "or `(n : ℕ) (h : n % 2 = 1) : n < 5` (one natural number).";

const BATTERIES = ["magmas", "groups", "graphs", "integers"] as const;
type ProgramBattery = (typeof BATTERIES)[number];

/** The objects a program is tried on: the magmas, the small groups, the graphs on up to 6 vertices, or the numbers from 0. */
function programBattery(family: ProgramBattery, options: M11Options): Battery {
  switch (family) {
    case "magmas":
      return magmaBattery({ exhaustive: options.exhaustive, sampleSize: options.sampleSize, samples: options.samples, seed: options.seed });
    case "groups":
      return groupBattery(12);
    case "graphs":
      return graphBattery(6);
    case "integers":
      return integerBattery(options.maxNumber, { min: 0 });
  }
}

/** An object in words, for a counter-model or a counter-example. */
export function describeObject(object: BatteryObject): string {
  if (object.kind === "graph") {
    return `the graph on ${object.n} vertices with ${object.edges.length === 0 ? "no edge" : `the edges ${object.edges.map(([u, v]) => `${u}-${v}`).join(", ")}`} (graph6 ${object.graph6})`;
  }
  const described = describeCounterModel(object);
  return object.kind === "magma" && object.name !== undefined ? `${object.name}, ${described}` : described;
}

/** The first objects where the verdict is `false`, in words. */
function failures(battery: Battery, verdicts: ReadonlyArray<boolean | null>, label: string, count = 3): string[] {
  return verdicts
    .flatMap((verdict, index) => (verdict === false ? [index] : []))
    .slice(0, count)
    .flatMap((index) => {
      const object = battery.objects[index];
      return object === undefined ? [] : [`${label}: ${describeObject(object)}.`];
    });
}

async function statementReport(session: SessionContext, text: string, signal: AbortSignal): Promise<string> {
  const recognized = recognizeStatement(text);
  if (!("statement" in recognized)) return `Not tried: ${recognized.reason}. ${SHAPES}`;
  const statement = recognized.statement;
  const options = readOptions(session.options);
  const battery = batteryFor(statement, options, options.toolMaxNumber);
  const env: Environment = { registry: session.registry, signal, leanTimeoutSec: Math.min(options.leanTimeoutSec, 30), attemptId: session.attemptId };
  const tried = await tryStatement(env, statement, battery, session.target.sketch.prefix);
  if (tried.unusable !== undefined) return `Not tried: ${tried.unusable}`;
  const fingerprint = verdictString(tried.verdicts);
  const counts = countVerdicts(fingerprint);
  const lines = [`On ${battery.id} (${battery.objects.length} objects, ${EVALUATOR_WORDS[tried.evaluator]}) the statement holds on ${counts.holds} and fails on ${counts.fails}${counts.unknown > 0 ? `, with no verdict on ${counts.unknown}` : ""}.`];
  lines.push(...failures(battery, tried.verdicts, "Counter-model"));
  const own = storedVerdicts(session.memory, session.claimId, battery);
  if (own !== undefined) {
    lines.push(
      {
        equivalent: "On this battery it has the same verdicts as the statement you are proving: they look equivalent.",
        implies: "The statement you are proving implies it on this battery: it looks weaker.",
        implied_by: "It implies the statement you are proving on this battery: it looks stronger, and would be enough if it were true.",
        unrelated: "Neither it nor the statement you are proving implies the other on this battery.",
        uninformative: "The battery does not tell how it compares with the statement you are proving: one of them holds on every object or fails on every object.",
      }[relate(own, fingerprint)],
    );
  }
  lines.push("This is a test on finite objects, and no proof.");
  return lines.join("\n");
}

async function programReport(session: SessionContext, program: string, family: unknown, signal: AbortSignal): Promise<string> {
  const chosen = family ?? "integers";
  if (typeof chosen !== "string" || !(BATTERIES as readonly string[]).includes(chosen)) throw new Error(`battery is one of ${BATTERIES.join(", ")}, not ${JSON.stringify(chosen)}`);
  const battery = programBattery(chosen as ProgramBattery, readOptions(session.options));
  const run = await runProgram(program, battery.objects, { totalMs: 10_000 }, signal);
  const counts = countVerdicts(verdictString(run.verdicts));
  const lines = [`On ${battery.id} (${battery.objects.length} objects, by your program) it returns true on ${counts.holds} and false on ${counts.fails}${counts.unknown > 0 ? `, and gives no verdict on ${counts.unknown}` : ""}.`];
  lines.push(...failures(battery, run.verdicts, "Counter-example"));
  const note = run.stopped ?? run.notes.find((n) => n !== undefined);
  if (counts.unknown > 0 && note !== undefined) lines.push(`${run.stopped !== undefined ? "The run stopped" : "No verdict on some objects"}: ${note}.`);
  lines.push("This is a test on finite objects, and no proof.");
  return lines.join("\n");
}

function smallModelsTool(session: SessionContext): LineTool {
  return {
    name: "small_models",
    description:
      "Tries a statement, or a program, on small models: every magma with up to 3 elements and a sample of 4, the small groups, the graphs on up to 6 vertices, or the natural numbers from 0 up. " +
      "Says where it holds and fails, shows the smallest counter-models, and compares a statement with the one you are proving. " +
      "Use it to test a lemma or a variant before trying to prove it; the answer is a test and no proof. " +
      `Give a \`statement\`. ${SHAPES} ` +
      "Or give a \`program\` and a \`battery\`: a JavaScript function that takes an object and returns true when the property holds on it, " +
      "such as `(n) => n % 3 !== 2`, `(m) => m.table[0] === 0` (a magma is {size, table}, with table[a * size + b] the product of a and b), " +
      "or `(g) => g.edges.length >= g.n - 1` (a graph is {n, edges}, an edge being [u, v]).",
    parameters: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The statement in signature form: the binders, then `:` and the proposition." },
        program: { type: "string", description: "A JavaScript function expression that returns true or false for an object of the battery." },
        battery: { type: "string", enum: [...BATTERIES], description: "For a program: the objects to try it on. Default integers. A statement uses the objects its shape asks for." },
      },
    },
    run: async (args, signal) => {
      const statement = typeof args.statement === "string" && args.statement.trim() !== "" ? args.statement : undefined;
      const program = typeof args.program === "string" && args.program.trim() !== "" ? args.program : undefined;
      if ((statement === undefined) === (program === undefined)) throw new Error(`give a statement or a program, one of the two. ${SHAPES}`);
      return statement !== undefined ? statementReport(session, statement, signal) : programReport(session, program as string, args.battery, signal);
    },
  };
}

// --- The line ----------------------------------------------------------------------------------

/**
 * Line M11: small models and fingerprints (plan §7 step 6). Before the provers start it tries the
 * problem's statement on batteries of small objects, records the fingerprint, turns a counter-model
 * into a refutation that Lean must check through `validate`, proposes `computed` edges between
 * claims whose fingerprints are included in each other, and looks the numbers where a statement
 * holds up as a sequence. A statement of another shape than the line reads is left alone.
 * documentation/models.md describes it.
 */
export function createM11(services: M11Services = {}): Line {
  return {
    id: "M11",
    title: LINE_TITLES.M11,
    requires: [],
    version: "1",
    options: M11_DEFAULTS,
    hooks: {
      beforeProvers: (problem) => beforeProvers(problem, services),
      briefing: async (session): Promise<Briefing | undefined> => {
        const text = describeFindings(session.memory, session.claimId);
        return text === undefined ? undefined : { title: "Small models (line M11)", text };
      },
      // A proof of the negation that passed the fast check: the claim is false as stated, and the provers would only spend the budget.
      beforeSession: async (session): Promise<SessionDecision | undefined> => {
        if (!readOptions(session.options).stopWhenRefuted) return undefined;
        const refutation = session.memory.validations(session.claimId).find((v) => v.negation && v.verdict === "valid");
        return refutation === undefined ? undefined : { stop: `a Lean proof of the negation passed the fast check (validation ${refutation.validationId}); the claim is false as stated` };
      },
      tools: async (session) => [smallModelsTool(session)],
    },
  };
}

/** The line, without an OEIS client: the table of known sequences only. */
export const M11: Line = createM11();
