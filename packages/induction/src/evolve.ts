import { hash32, type Json, type RandomSource, seeded } from "@seshat/core";
import { completeJson, isInterrupted, type Llm, withAntiSycophancy } from "@seshat/lines";
import { MAX_PROGRAM_LENGTH } from "@seshat/models";
import { numbers, type ProgramLimits, runValues } from "./sandbox.ts";
import { screenLeanText } from "./screen.ts";

/**
 * Program search for subgoals that carry a computable score (line M16; plan change PC8, after FunSearch). A model
 * writes programs, a scoring program (sandboxed JavaScript, or Sage) scores what they build, a database of
 * programs split in islands feeds the best ones back into the next prompt, and the worse half of the islands is
 * reset now and then. The score only guides the search: a witness it finds is a claim settled by Lean, never by
 * the number. Everything that draws takes the run's seeded source.
 */
export interface SearchSpec {
  /** What is being built, in words: the prompt says it. */
  description: string;
  /** How a program looks, such as `(n) => an array of n distinct integers`. */
  signature: string;
  /** The inputs the programs are run on; the signature of a program is its score on each. */
  inputs: Json[];
  /** JavaScript: a function expression of `{input, output}` returning a number (higher is better) or null for an invalid output. */
  score?: string;
  /** Sage instead of `score`: an expression in `i` (the input) and `x` (the output) whose value is a number or None. Run through `compute.sage`. */
  scoreSage?: string;
  /** The score at which the search stops: a witness is good enough. */
  target?: number;
  /** The programs the database starts from: JavaScript function expressions. At least one. */
  seeds: string[];
  /** The input the witness is built on (its output is the witness). Default: the last of `inputs`. */
  witnessInput?: Json;
  /** The claim the witness settles; default: the problem's claim. */
  claimId?: string;
  /** A signature-form statement with `{witness}` for the witness as a Lean term, to be made a claim of its own; absent: the claim above is the one settled. */
  statement?: string;
  /** The tactic proof (without `by`) with `{witness}` in it, submitted through `validate`. Default `decide`. */
  proof?: string;
  /**
   * The moves of a local search on the witness between model rounds (plan change CX5): `bits`, `intList`, `permutation`,
   * `graph` (with an optional value or vertex range), or `{move}`, a JavaScript function expression from an object to a
   * neighbor, run in the sandbox. Absent: no local search, and the search is what it was before the option.
   */
  neighborhood?: NeighborhoodSpec;
}

export interface SearchOptions {
  /** Islands of the database. Default 3. */
  islands: number;
  /** Rounds of the search: each draws from the database, asks the model, evaluates. Default 8. */
  rounds: number;
  /** Programs asked for per round. Default 2. */
  samples: number;
  /** Programs shown in a prompt (sorted by score). Default 2. */
  shown: number;
  /** The temperature of the choice among clusters; lower is greedier. Default 0.5. */
  temperature: number;
  /** How strongly a short program is preferred in a cluster: 0 for not at all. Default 1. */
  lengthBias: number;
  /** Rounds between two resets of the worse half of the islands; 0 for never. Default 4. */
  resetEvery: number;
  /** The most programs a cluster keeps. Default 4. */
  clusterSize: number;
  /**
   * Novelty (plan change LH5, after ShinkaEvolve): a candidate whose text is closer than this normalized edit distance (0 to 1) to a program already scored is
   * rejected before it runs. Absent or 0: off.
   */
  novelty?: number;
  /** Parents balanced (plan change LH5): half of the programs a prompt shows come from the best cluster, half from the other clusters. Absent: the softmax draw. */
  parentSplit?: boolean;
  /**
   * The strategy (plan change CX2). `islands`, the default (also when absent): the database above feeds the best programs back into each prompt.
   * `iid`: the baseline of "Simple Baselines are Competitive with Code Evolution": one island, no resets, and every model call gets the same programs
   * (the seeds, drawn once), for the same `rounds` and `samples`, so the same number of calls; the best program found is kept all the same.
   */
  strategy?: "islands" | "iid";
  limits: Partial<ProgramLimits>;
}

/** The text of a program with its white space collapsed, so that layout is no novelty. */
const squashed = (code: string): string => code.replace(/\s+/g, " ").trim();

/**
 * The edit distance (insertions, deletions, substitutions) between two program texts over the longer one's length, from 0 (the same text, white space apart)
 * to 1. Texts are cut at 2000 characters, which bounds the cost.
 */
export function normalizedEditDistance(a: string, b: string): number {
  const x = squashed(a).slice(0, 2000);
  const y = squashed(b).slice(0, 2000);
  if (x === y) return 0;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row.push(Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1)));
    previous = row;
  }
  return (previous[y.length] as number) / longest;
}

export const SEARCH_DEFAULTS: SearchOptions = { islands: 3, rounds: 8, samples: 2, shown: 2, temperature: 0.5, lengthBias: 1, resetEvery: 4, clusterSize: 4, limits: {} };

/** A program that was scored. */
export interface Scored {
  code: string;
  /** The score on each input. */
  signature: number[];
  /** The sum over the inputs. */
  score: number;
  round: number;
  island: number;
}

export interface Cluster {
  signature: string;
  score: number;
  programs: Scored[];
}

/** The database of programs: islands of clusters, each cluster the programs that score the same on every input. */
export class ProgramDatabase {
  readonly islands: Cluster[][];
  readonly #options: Pick<SearchOptions, "temperature" | "lengthBias" | "clusterSize" | "parentSplit">;

  constructor(islands: number, options: Pick<SearchOptions, "temperature" | "lengthBias" | "clusterSize" | "parentSplit">) {
    if (!Number.isInteger(islands) || islands < 1) throw new RangeError("a database has at least one island");
    this.islands = Array.from({ length: islands }, () => []);
    this.#options = options;
  }

  /** Adds a scored program to an island, in the cluster of its signature (the shortest programs stay). Returns false for a duplicate. */
  add(program: Scored): boolean {
    const island = this.islands[program.island] as Cluster[];
    const key = program.signature.join(",");
    let cluster = island.find((c) => c.signature === key);
    if (cluster === undefined) {
      cluster = { signature: key, score: program.score, programs: [] };
      island.push(cluster);
    }
    if (cluster.programs.some((p) => p.code === program.code)) return false;
    cluster.programs.push(program);
    cluster.programs.sort((a, b) => a.code.length - b.code.length);
    cluster.programs.length = Math.min(cluster.programs.length, this.#options.clusterSize);
    return true;
  }

  best(island?: number): Scored | undefined {
    const pool = island === undefined ? this.islands.flat() : (this.islands[island] ?? []);
    let best: Scored | undefined;
    for (const c of pool) for (const p of c.programs) if (best === undefined || p.score > best.score || (p.score === best.score && p.code.length < best.code.length)) best = p;
    return best;
  }

  islandScore(island: number): number {
    return this.best(island)?.score ?? -Infinity;
  }

  /** A weighted choice: the weights are positive and the draw is `random()` in [0, 1). */
  #choose<T>(items: readonly T[], weights: readonly number[], random: RandomSource): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let x = random() * total;
    for (let i = 0; i < items.length; i++) {
      x -= weights[i] as number;
      if (x < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /**
   * Draws `count` programs from one island (chosen uniformly among those that hold any): clusters by a softmax of
   * their scores at the temperature, then a program of the cluster biased to short ones. Sorted by score, lowest first.
   */
  sample(count: number, random: RandomSource): { island: number; programs: Scored[] } | undefined {
    const live = this.islands.map((_, i) => i).filter((i) => (this.islands[i] as Cluster[]).length > 0);
    if (live.length === 0) return undefined;
    const island = live[Math.floor(random() * live.length)] as number;
    const clusters = this.islands[island] as Cluster[];
    const scores = clusters.map((c) => c.score);
    const lo = Math.min(...scores);
    const hi = Math.max(...scores);
    const spread = hi - lo || 1;
    const weights = scores.map((s) => Math.exp((s - hi) / spread / this.#options.temperature));
    const picked: Scored[] = [];
    // With `parentSplit` the parents alternate: the first from the best cluster, the next from the others (uniformly), and so on.
    const best = clusters.reduce((top, c) => (c.score > top.score ? c : top), clusters[0] as Cluster);
    const rest = clusters.filter((c) => c !== best);
    for (let k = 0; k < count; k++) {
      const cluster = this.#options.parentSplit === true ? (k % 2 === 0 || rest.length === 0 ? best : (rest[Math.floor(random() * rest.length)] as Cluster)) : this.#choose(clusters, weights, random);
      const lengths = cluster.programs.map((p) => p.code.length);
      const longest = Math.max(...lengths) || 1;
      const p = this.#choose(cluster.programs, lengths.map((l) => Math.exp(-(this.#options.lengthBias * l) / longest)), random);
      if (!picked.some((q) => q.code === p.code)) picked.push(p);
    }
    picked.sort((a, b) => a.score - b.score || b.code.length - a.code.length);
    return { island, programs: picked };
  }

  /**
   * Resets the worse half of the islands (by their best score): each is emptied and receives a copy of the best
   * program of a surviving island chosen at random. Returns the islands reset.
   */
  reset(random: RandomSource): number[] {
    const order = this.islands.map((_, i) => i).sort((a, b) => this.islandScore(a) - this.islandScore(b) || a - b);
    const losers = order.slice(0, Math.floor(this.islands.length / 2));
    const winners = order.slice(losers.length).filter((i) => this.best(i) !== undefined);
    if (winners.length === 0) return [];
    for (const i of losers) {
      const donor = this.best(winners[Math.floor(random() * winners.length)] as number) as Scored;
      this.islands[i] = [];
      this.add({ ...donor, island: i });
    }
    return losers;
  }
}

/** The prompt of a round: the task, then the programs drawn, as versions in order of score, and the request for the next one. */
export function buildPrompt(spec: SearchSpec, shown: readonly Scored[], round: number, refuted = ""): string {
  const versions = shown.map((p, i) => `// version ${i}: score ${p.score}\n${p.code}`).join("\n\n");
  return (
    `Task: ${spec.description}\n` +
    `A program is a JavaScript function expression: ${spec.signature}. A scoring program rates what it returns; higher is better${spec.target !== undefined ? `, and ${spec.target} is the score to reach` : ""}.\n\n` +
    `Programs so far, from the worse to the better:\n\n${versions}\n\n` +
    (refuted !== "" ? `${refuted}\n\n` : "") +
    `Write version ${shown.length}, a program that scores higher than all of them. You may change or combine the ideas above. (round ${round})`
  );
}

const PROGRAM_SCHEMA = {
  type: "object",
  properties: { program: { type: "string", minLength: 1, maxLength: MAX_PROGRAM_LENGTH, description: "One JavaScript function expression, nothing else." } },
  required: ["program"],
  additionalProperties: false,
} as const;

/** The score of a program, and why not when it has none. */
export type Evaluation = { ok: true; signature: number[]; score: number } | { ok: false; why: string };

export interface Scorer {
  (code: string, signal?: AbortSignal): Promise<Evaluation>;
}

/** Runs candidate programs and the scoring program in the sandbox (or the scoring in Sage), with the limits. */
export function makeScorer(spec: SearchSpec, limits: Partial<ProgramLimits>, sage?: (code: string, options?: { signal?: AbortSignal }) => Promise<string>): Scorer {
  return async (code, signal) => {
    const run = await runValues(code, spec.inputs, limits, signal);
    if (run.stopped !== undefined) return { ok: false, why: run.stopped };
    const bad = run.values.findIndex((v) => v === undefined);
    if (bad >= 0) return { ok: false, why: `no value on input ${bad}: ${run.notes[bad] ?? "unknown"}` };
    let scores: Array<Json | undefined>;
    if (spec.score !== undefined) {
      const rated = await runValues(spec.score, spec.inputs.map((input, i) => ({ input, output: run.values[i] as Json })), limits, signal);
      if (rated.stopped !== undefined) return { ok: false, why: `the scoring program stopped: ${rated.stopped}` };
      scores = rated.values;
    } else if (spec.scoreSage !== undefined) {
      if (sage === undefined) return { ok: false, why: "no SageMath was available for the scoring program" };
      const pairs = JSON.stringify(spec.inputs.map((input, i) => [input, run.values[i]]));
      try {
        const out = await sage(`import json\npairs = json.loads(${JSON.stringify(pairs)})\njson.dumps([(lambda i, x: (${spec.scoreSage}))(i, x) for i, x in pairs])`, signal !== undefined ? { signal } : {});
        const parsed = JSON.parse(out.trim().replace(/^'([\s\S]*)'$/, "$1")) as unknown;
        if (!Array.isArray(parsed)) return { ok: false, why: "the Sage scoring did not give a list" };
        scores = parsed as Json[];
      } catch (error) {
        // A candidate whose output breaks the scoring program is one bad candidate, not the end of the search; only a pause or an abort passes through.
        if (isInterrupted(error) || signal?.aborted === true) throw error;
        return { ok: false, why: `the Sage scoring failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}` };
      }
    } else return { ok: false, why: "the task declares no scoring program" };
    const signature: number[] = [];
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      if (typeof s !== "number" || !Number.isFinite(s)) return { ok: false, why: `the output on input ${i} is not valid (the score is ${JSON.stringify(s) ?? "missing"})` };
      signature.push(s);
    }
    return { ok: true, signature, score: signature.reduce((a, b) => a + b, 0) };
  };
}

export interface SearchEvents {
  /** A program was scored (valid or not). */
  program: (e: { round: number; island: number; code: string; evaluation: Evaluation; isBest: boolean }) => void;
  reset: (e: { round: number; islands: number[] }) => void;
}

export interface SearchResult {
  best: Scored | undefined;
  rounds: number;
  evaluated: number;
  reached: boolean;
  stoppedBy: "target" | "rounds" | "budget";
  /** The witness the local search improved past the best program's (CX5), when there is a local search and it did. */
  local?: LocalBest;
}

/**
 * The search: seeds are scored into island 0 (and copied to the others), then each round draws from the database,
 * asks the model for programs (site `search.program`, `reuse`d: a resumed process replays the answers), scores them
 * and adds the valid ones. `shouldStop` is asked before each model call (the problem's budget).
 */
export async function runSearch(
  llm: Llm,
  spec: SearchSpec,
  options: SearchOptions,
  scorer: Scorer,
  random: RandomSource,
  hooks: {
    events?: Partial<SearchEvents>;
    shouldStop?: () => boolean;
    signal?: AbortSignal;
    model?: string;
    counterexamples?: string;
    screen?: (code: string) => Promise<boolean>;
    /** CX5: the local search run before each model round and after the last (`makeLocalPhase`). Absent: none, and the search is unchanged. */
    local?: LocalPhase;
  } = {},
): Promise<SearchResult> {
  const iid = options.strategy === "iid";
  const islands = iid ? 1 : options.islands;
  const db = new ProgramDatabase(islands, options);
  let evaluated = 0;
  let globalBest = -Infinity;
  const scoredCodes: string[] = [];
  let local: LocalBest | undefined;
  const reached = (): boolean => spec.target !== undefined && Math.max(db.best()?.score ?? -Infinity, local?.score ?? -Infinity) >= spec.target;
  // CX5: a model round runs only once the local search from the best witness so far has stopped improving.
  const improve = async (phase: number): Promise<void> => {
    const best = db.best();
    if (hooks.local === undefined || best === undefined || hooks.signal?.aborted === true) return;
    local = (await hooks.local(best, local, phase, hooks.signal)) ?? local;
  };
  const withLocal = (result: SearchResult): SearchResult => (local !== undefined && local.score > (result.best?.score ?? -Infinity) ? { ...result, local } : result);
  const consider = async (code: string, round: number, island: number): Promise<void> => {
    // PD5: a sampled program meets the known counterexamples before it is scored; one that fails is dropped, not scored.
    if (round > 0 && hooks.screen !== undefined && (await hooks.screen(code))) return;
    // LH5: a candidate too close to a program already scored is rejected before it runs.
    if (round > 0 && options.novelty !== undefined && options.novelty > 0 && scoredCodes.some((seen) => normalizedEditDistance(seen, code) < (options.novelty as number))) {
      hooks.events?.program?.({ round, island, code, evaluation: { ok: false, why: "too close to a program already scored" }, isBest: false });
      return;
    }
    scoredCodes.push(code);
    const evaluation = await scorer(code, hooks.signal);
    evaluated++;
    const isBest = evaluation.ok && evaluation.score > globalBest;
    if (evaluation.ok) {
      globalBest = Math.max(globalBest, evaluation.score);
      db.add({ code, signature: evaluation.signature, score: evaluation.score, round, island });
    }
    hooks.events?.program?.({ round, island, code, evaluation, isBest });
  };
  for (const seed of spec.seeds) for (let i = 0; i < islands; i++) await consider(seed, 0, i);
  if (db.best() === undefined) return { best: undefined, rounds: 0, evaluated, reached: false, stoppedBy: "rounds" };
  // CX2's `iid`: the programs of every prompt are drawn once, from the seeds; only the round and draft numbers (which keep the calls apart for `reuse`) change.
  const fixed = iid ? db.sample(options.shown, random) : undefined;
  for (let round = 1; round <= options.rounds; round++) {
    if (reached()) return withLocal({ best: db.best(), rounds: round - 1, evaluated, reached: true, stoppedBy: "target" });
    if (hooks.local !== undefined) {
      await improve(round);
      if (reached()) return withLocal({ best: db.best(), rounds: round - 1, evaluated, reached: true, stoppedBy: "target" });
    }
    if (!iid && options.resetEvery > 0 && round > 1 && (round - 1) % options.resetEvery === 0) hooks.events?.reset?.({ round, islands: db.reset(random) });
    const drawn = fixed ?? db.sample(options.shown, random);
    if (drawn === undefined) break;
    for (let k = 0; k < options.samples; k++) {
      if (hooks.shouldStop?.() === true) return withLocal({ best: db.best(), rounds: round - 1, evaluated, reached: reached(), stoppedBy: "budget" });
      const answer = await completeJson<{ program: string }>(llm, {
        system: withAntiSycophancy("You write short JavaScript programs for a search. Your answer is read by a program."),
        prompt: `${buildPrompt(spec, drawn.programs, round, hooks.counterexamples ?? "")}${options.samples > 1 ? ` (draft ${k + 1} of ${options.samples})` : ""}`,
        schema: PROGRAM_SCHEMA as never,
        site: "search.program",
        reuse: true,
        ...(hooks.model !== undefined ? { model: hooks.model } : {}),
      });
      await consider(answer.value.program, round, drawn.island);
    }
  }
  if (hooks.local !== undefined && !reached()) await improve(options.rounds + 1);
  return withLocal({ best: db.best(), rounds: options.rounds, evaluated, reached: reached(), stoppedBy: reached() ? "target" : "rounds" });
}

/**
 * A JSON value as a Lean term: integers, booleans and nested lists only (`[1, 2, [3]]`). Anything else is refused,
 * so a witness built by a model's program reaches a Lean file as digits, commas and brackets and as nothing else.
 */
export function leanTerm(value: Json): string | undefined {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isSafeInteger(value) ? (value < 0 ? `(${value})` : String(value)) : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(leanTerm);
    return parts.some((p) => p === undefined) ? undefined : `[${parts.join(", ")}]`;
  }
  return undefined;
}

/** A template with `{witness}` filled in, screened as Lean text. Undefined with the reason when it does not pass. */
export function fillTemplate(template: string, witness: Json): { text: string } | { problem: string } {
  const term = leanTerm(witness);
  if (term === undefined) return { problem: "the witness is not a list of integers and booleans, which is all that can be written in Lean here" };
  const text = template.split("{witness}").join(term);
  const problems = screenLeanText(text);
  return problems.length === 0 ? { text } : { problem: problems.join("; ") };
}

// --- Local search (plan change CX5) ----------------------------------------------------------------

/** A graph as the local search moves it: vertices 0..n-1, each edge `[u, v]` with u < v, sorted. */
export type SearchGraph = { n: number; edges: Array<[number, number]> };

export type NeighborhoodKind = "bits" | "intList" | "permutation" | "graph";

/**
 * The moves of a local search. `bits`: flip one entry of a list of 0/1 (or of booleans). `intList`: move one entry of a list of
 * integers by 1 to 3 up or down, or (one move in four, with both bounds) to any value in `[min, max]`. `permutation`: swap two
 * entries. `graph` (`{n, edges}`): add or remove an edge, add a vertex with one or two edges, or remove one, the vertex count kept
 * in `[min, max]` (default: the start's count). `{move}`: a JavaScript function expression from an object to a neighbor, run in
 * the sandbox with a seeded `Math.random`.
 */
export type NeighborhoodSpec = NeighborhoodKind | { kind: NeighborhoodKind; min?: number; max?: number } | { move: string };

/** The settings of a local search. */
export interface LocalSearchSettings {
  /** `anneal`: the best of each step's moves is taken when it is no worse, or else with probability exp(Δ / T); `tabu`: the best move not among the last `tabuTenure` objects is taken, better or worse. */
  method: "anneal" | "tabu";
  /** Steps of one climb. */
  steps: number;
  /** Moves scored in one step, in one sandbox run. */
  neighbors: number;
  /** A climb ends after this many steps without a better object than its best. */
  plateau: number;
  restarts: number;
  /** Annealing's temperature at the first step, in score units; 0 is a climb that takes sideways moves (CA20's). */
  temperature: number;
  /** The factor of the temperature from one step to the next. */
  cooling: number;
  tabuTenure: number;
}

/** What a local search works on: where a climb starts, the moves, the score (null: not valid), and when to stop. */
export interface LocalSearchProblem<T> {
  start(restart: number): T | Promise<T>;
  moves(current: T, count: number): T[] | Promise<T[]>;
  score(objects: T[]): Promise<Array<number | null>>;
  /** An object good enough to end the search. */
  isHit?(object: T, score: number): boolean;
  /** Asked before each step: true ends the search (a deadline, an abort, the budget). */
  stop?(): boolean;
}

export interface LocalSearchOutcome<T> {
  /** The best object a climb started from or moved to (a hit is apart, in `hit`). */
  best?: { object: T; score: number };
  hit?: { object: T; score: number; restart: number; step: number };
  /** Steps taken in all, restarts begun, objects scored. */
  steps: number;
  restarts: number;
  scored: number;
  /** True when `stop` ended the search. */
  stopped: boolean;
}

/**
 * The local search, one code path for M16's neighborhoods and M11's graph search (CA20): a climb from `start`, each step scoring
 * `neighbors` moves at once and taking one of them by the method's rule, ended by `plateau` steps without a better object, by
 * `steps`, or by a hit; then the next restart. Every draw comes from `random` (the moves' own draws too, through `problem.moves`),
 * so the same source gives the same search; annealing draws only to decide on a worse move at a positive temperature.
 */
export async function runLocalSearch<T>(problem: LocalSearchProblem<T>, settings: LocalSearchSettings, random: RandomSource): Promise<LocalSearchOutcome<T>> {
  const out: LocalSearchOutcome<T> = { steps: 0, restarts: 0, scored: 0, stopped: false };
  const score = async (objects: T[]): Promise<Array<number | null>> => {
    out.scored += objects.length;
    return problem.score(objects);
  };
  const keep = (object: T, s: number): void => {
    if (out.best === undefined || s > out.best.score) out.best = { object, score: s };
  };
  const key = (object: T): string => JSON.stringify(object);
  for (out.restarts = 1; out.restarts <= settings.restarts; out.restarts++) {
    let current: T = await problem.start(out.restarts);
    const first = (await score([current]))[0] ?? null;
    if (first !== null) {
      if (problem.isHit?.(current, first) === true) return { ...out, hit: { object: current, score: first, restart: out.restarts, step: 0 } };
      keep(current, first);
    }
    let currentScore = first ?? -Infinity;
    let climbBest = currentScore;
    let stale = 0;
    const tabu: string[] = settings.method === "tabu" ? [key(current)] : [];
    for (let step = 1; step <= settings.steps && stale < settings.plateau; step++) {
      if (problem.stop?.() === true) return { ...out, stopped: true };
      out.steps++;
      const moves = await problem.moves(current, settings.neighbors);
      const scores = await score(moves);
      let chosen = -1;
      for (let i = 0; i < moves.length; i++) {
        const s = scores[i];
        if (s === null || s === undefined) continue;
        if (problem.isHit?.(moves[i] as T, s) === true) return { ...out, hit: { object: moves[i] as T, score: s, restart: out.restarts, step } };
        // A tabu object is allowed only when it beats the climb's best (the aspiration rule).
        if (settings.method === "tabu" && s <= climbBest && tabu.includes(key(moves[i] as T))) continue;
        if (chosen < 0 || s > (scores[chosen] as number)) chosen = i;
      }
      if (chosen < 0) {
        stale++;
        continue;
      }
      const s = scores[chosen] as number;
      const temperature = settings.temperature * settings.cooling ** (step - 1);
      const accepted = settings.method === "tabu" || s >= currentScore || (temperature > 0 && random() < Math.exp((s - currentScore) / temperature));
      if (!accepted) {
        stale++;
        continue;
      }
      stale = s > climbBest ? 0 : stale + 1;
      climbBest = Math.max(climbBest, s);
      current = moves[chosen] as T;
      currentScore = s;
      keep(current, s);
      if (settings.method === "tabu") {
        tabu.push(key(current));
        if (tabu.length > settings.tabuTenure) tabu.shift();
      }
    }
  }
  out.restarts = settings.restarts;
  return out;
}

function pick(random: RandomSource, count: number): number {
  return Math.min(count - 1, Math.floor(random() * count));
}

const edgeKey = (u: number, v: number): string => `${u},${v}`;

function normalizeGraph(n: number, edges: Iterable<[number, number]>): SearchGraph {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [a, b] of edges) {
    const [u, v] = a < b ? [a, b] : [b, a];
    if (u === v || u < 0 || v >= n || seen.has(edgeKey(u, v))) continue;
    seen.add(edgeKey(u, v));
    out.push([u, v]);
  }
  return { n, edges: out.sort((x, y) => x[0] - y[0] || x[1] - y[1]) };
}

/** A graph one move from another (the `graph` neighborhood, CA20's moves): an edge added or removed, a vertex added (with one or two edges) or removed. */
export function graphNeighbor(graph: SearchGraph, random: RandomSource, minVertices: number, maxVertices: number): SearchGraph {
  for (let attempt = 0; attempt < 20; attempt++) {
    const move = pick(random, 4);
    const { n, edges } = graph;
    if (move === 0 && n >= 2) {
      const u = pick(random, n);
      const v = pick(random, n);
      if (u === v || edges.some(([a, b]) => edgeKey(a, b) === edgeKey(Math.min(u, v), Math.max(u, v)))) continue;
      return normalizeGraph(n, [...edges, [u, v]]);
    }
    if (move === 1 && edges.length > 0) {
      const drop = pick(random, edges.length);
      return { n, edges: edges.filter((_, i) => i !== drop) };
    }
    if (move === 2 && n < maxVertices) {
      const added: Array<[number, number]> = [[pick(random, n), n]];
      if (random() < 0.5) added.push([pick(random, n), n]);
      return normalizeGraph(n + 1, [...edges, ...added]);
    }
    if (move === 3 && n > minVertices) {
      const gone = pick(random, n);
      const rename = (x: number): number => (x > gone ? x - 1 : x);
      return normalizeGraph(n - 1, edges.filter(([a, b]) => a !== gone && b !== gone).map(([a, b]) => [rename(a), rename(b)] as [number, number]));
    }
  }
  return graph;
}

/** The graph a value is, when it is `{n, edges}` with at most `maxVertices` vertices and integer pairs; normalized. */
export function graphOf(value: Json | undefined, maxVertices: number): SearchGraph | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { n, edges } = value as { n?: Json; edges?: Json };
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > maxVertices || !Array.isArray(edges)) return undefined;
  const pairs: Array<[number, number]> = [];
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2 || !Number.isInteger(e[0]) || !Number.isInteger(e[1])) return undefined;
    pairs.push([e[0] as number, e[1] as number]);
  }
  return normalizeGraph(n, pairs);
}

/** The most vertices of a graph the `graph` neighborhood moves. */
const NEIGHBORHOOD_MAX_VERTICES = 64;

/**
 * The moves of a neighborhood from an object, or why the object is not one it moves. The program of `{move}` runs in the sandbox
 * with `limits`, its `Math.random` seeded from `random`.
 */
export function neighborhoodMoves(
  spec: NeighborhoodSpec,
  start: Json,
  random: RandomSource,
  limits: Partial<ProgramLimits>,
  signal?: AbortSignal,
): { moves: (current: Json, count: number) => Promise<Json[]> } | { problem: string } {
  if (typeof spec === "object" && "move" in spec) {
    if (typeof spec.move !== "string" || spec.move.trim() === "") return { problem: "the move program is empty" };
    return {
      moves: async (current, count) => {
        const run = await runValues(spec.move, Array.from({ length: count }, () => current), { ...limits, seed: Math.floor(random() * 2 ** 31) }, signal);
        return run.values.filter((v): v is Json => v !== undefined);
      },
    };
  }
  const kind = typeof spec === "string" ? spec : spec.kind;
  const min = typeof spec === "object" && Number.isInteger(spec.min) ? (spec.min as number) : undefined;
  const max = typeof spec === "object" && Number.isInteger(spec.max) ? (spec.max as number) : undefined;
  const batch = (move: (x: Json) => Json) => async (current: Json, count: number) => Array.from({ length: count }, () => move(current));
  switch (kind) {
    case "bits": {
      if (!Array.isArray(start) || start.length === 0 || !start.every((b) => b === 0 || b === 1 || typeof b === "boolean")) return { problem: "the witness is not a non-empty list of 0/1 or booleans" };
      return {
        moves: batch((x) => {
          const bits = [...(x as Json[])];
          const i = pick(random, bits.length);
          const b = bits[i];
          bits[i] = typeof b === "boolean" ? !b : b === 1 ? 0 : 1;
          return bits;
        }),
      };
    }
    case "intList": {
      if (!Array.isArray(start) || start.length === 0 || !start.every((v) => Number.isSafeInteger(v))) return { problem: "the witness is not a non-empty list of integers" };
      if (min !== undefined && max !== undefined && min > max) return { problem: `the range [${min}, ${max}] is empty` };
      const clamp = (v: number): number => Math.min(max ?? v, Math.max(min ?? v, v));
      return {
        moves: batch((x) => {
          const list = [...(x as number[])];
          const i = pick(random, list.length);
          const old = list[i] as number;
          for (let attempt = 0; attempt < 20; attempt++) {
            const jump = min !== undefined && max !== undefined && random() < 0.25;
            const next = jump ? min + pick(random, max - min + 1) : clamp(old + (random() < 0.5 ? -1 : 1) * (1 + pick(random, 3)));
            if (next !== old) {
              list[i] = next;
              break;
            }
          }
          return list;
        }),
      };
    }
    case "permutation": {
      if (!Array.isArray(start) || start.length < 2) return { problem: "the witness is not a list of at least two entries" };
      return {
        moves: batch((x) => {
          const list = [...(x as Json[])];
          const i = pick(random, list.length);
          const j = (i + 1 + pick(random, list.length - 1)) % list.length;
          [list[i], list[j]] = [list[j] as Json, list[i] as Json];
          return list;
        }),
      };
    }
    case "graph": {
      const graph = graphOf(start, NEIGHBORHOOD_MAX_VERTICES);
      if (graph === undefined) return { problem: `the witness is not a graph {n, edges} with 1 to ${NEIGHBORHOOD_MAX_VERTICES} vertices` };
      const lo = Math.max(1, min ?? graph.n);
      const hi = Math.min(NEIGHBORHOOD_MAX_VERTICES, max ?? graph.n);
      if (graph.n < lo || graph.n > hi) return { problem: `the witness has ${graph.n} vertices, outside [${lo}, ${hi}]` };
      return { moves: batch((x) => graphNeighbor(graphOf(x, NEIGHBORHOOD_MAX_VERTICES) ?? graph, random, lo, hi) as unknown as Json) };
    }
    default:
      return { problem: `no neighborhood ${JSON.stringify(kind)}: one of bits, intList, permutation, graph, or {move}` };
  }
}

/** The local search of M16 as options set it (`readM16Options`): the method, its bounds, and the time of one phase. */
export interface LocalOptions {
  method: "anneal" | "tabu";
  steps: number;
  neighbors: number;
  plateauSteps: number;
  temperature: number;
  tabuTenure: number;
  /** The wall time of one phase, in milliseconds. */
  ms: number;
}

/** The witness the local search improved: the object, its score on the witness input, and its total as the program's it came from (that program's other inputs unchanged). */
export interface LocalBest {
  object: Json;
  witnessScore: number;
  score: number;
  phase: number;
}

/** What one phase did, for the journal: its seed and step count are what a resumed process replays. */
export interface LocalPhaseRecord {
  phase: number;
  seed: number;
  method: "anneal" | "tabu";
  steps: number;
  scored: number;
  startScore: number | null;
  bestScore: number | null;
  improved: boolean;
  reached: boolean;
  note?: string;
}

/** A phase of local search: from the best program (or the local best so far, when better), returns the local best after it. */
export type LocalPhase = (best: Scored, held: LocalBest | undefined, phase: number, signal?: AbortSignal) => Promise<LocalBest | undefined>;

/**
 * The local search between model rounds (CX5): the witness (the best program's output on the witness input, or the local best when
 * that scores more) is moved by the spec's neighborhood, each object scored by the spec's scoring program on the witness input in
 * the sandbox, until `plateauSteps` steps without a better object, `steps`, `ms`, or the target. Phase `p`'s source is seeded
 * with `hash32(seed/p)`; `replay(p)`, the step count a journaled phase took, bounds it instead of the time, so a resumed process
 * goes through the same steps. Needs the JavaScript `score` and the witness input among `inputs`; otherwise the phase says why and
 * does nothing.
 */
export function makeLocalPhase(
  spec: SearchSpec,
  options: LocalOptions,
  limits: Partial<ProgramLimits>,
  seed: number,
  hooks: { replay?: (phase: number) => number | undefined; record?: (r: LocalPhaseRecord) => void } = {},
): LocalPhase {
  const witnessInput = spec.witnessInput ?? (spec.inputs[spec.inputs.length - 1] as Json);
  const w = spec.inputs.findIndex((input) => JSON.stringify(input) === JSON.stringify(witnessInput));
  return async (best, held, phase, signal) => {
    const phaseSeed = hash32(`${seed}/${phase}`);
    const record = (r: Omit<LocalPhaseRecord, "phase" | "seed" | "method">): void => hooks.record?.({ phase, seed: phaseSeed, method: options.method, ...r });
    const nothing = (note: string): undefined => {
      record({ steps: 0, scored: 0, startScore: null, bestScore: null, improved: false, reached: false, note });
      return undefined;
    };
    if (spec.neighborhood === undefined) return undefined;
    if (spec.score === undefined) return nothing("the local search needs the JavaScript scoring program");
    if (w < 0) return nothing("the witness input is not among the inputs");
    const fromHeld = held !== undefined && held.score >= best.score;
    let start: Json;
    let base: number;
    if (fromHeld) {
      start = held.object;
      base = held.score - held.witnessScore;
    } else {
      const built = await runValues(best.code, [witnessInput], limits, signal);
      if (built.values[0] === undefined) return nothing(`the best program gave no witness: ${built.notes[0] ?? "unknown"}`);
      start = built.values[0];
      base = best.score - (best.signature[w] as number);
    }
    const random = seeded(phaseSeed);
    const neighborhood = neighborhoodMoves(spec.neighborhood, start, random, limits, signal);
    if ("problem" in neighborhood) return nothing(neighborhood.problem);
    const scoreFn = spec.score;
    const replayed = hooks.replay?.(phase);
    const deadline = Date.now() + options.ms;
    const outcome = await runLocalSearch<Json>(
      {
        start: () => start,
        moves: neighborhood.moves,
        score: async (objects) => numbers(await runValues(scoreFn, objects.map((output) => ({ input: witnessInput, output })), limits, signal)),
        isHit: (_object, s) => spec.target !== undefined && base + s >= spec.target,
        stop: () => signal?.aborted === true || (replayed === undefined && Date.now() > deadline),
      },
      { method: options.method, steps: replayed ?? options.steps, neighbors: options.neighbors, plateau: options.plateauSteps, restarts: 1, temperature: options.temperature, cooling: 0.95, tabuTenure: options.tabuTenure },
      random,
    );
    const startScore = fromHeld ? (held as LocalBest).witnessScore : (best.signature[w] as number);
    const found = outcome.hit ?? outcome.best;
    const improved = found !== undefined && found.score > startScore;
    const reached = outcome.hit !== undefined;
    record({ steps: outcome.steps, scored: outcome.scored, startScore, bestScore: found?.score ?? null, improved, reached, ...(outcome.stopped ? { note: "stopped by the time or an abort" } : {}) });
    if (!improved) return held;
    return { object: (found as { object: Json }).object, witnessScore: (found as { score: number }).score, score: base + (found as { score: number }).score, phase };
  };
}
