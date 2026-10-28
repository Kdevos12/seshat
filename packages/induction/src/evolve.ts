import { type Json, type RandomSource } from "@seshat/core";
import { completeJson, type Llm, withAntiSycophancy } from "@seshat/lines";
import { MAX_PROGRAM_LENGTH } from "@seshat/models";
import { type ProgramLimits, runValues } from "./sandbox.ts";
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
  limits: Partial<ProgramLimits>;
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
  readonly #options: Pick<SearchOptions, "temperature" | "lengthBias" | "clusterSize">;

  constructor(islands: number, options: Pick<SearchOptions, "temperature" | "lengthBias" | "clusterSize">) {
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
    for (let k = 0; k < count; k++) {
      const cluster = this.#choose(clusters, weights, random);
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
export function buildPrompt(spec: SearchSpec, shown: readonly Scored[], round: number): string {
  const versions = shown.map((p, i) => `// version ${i}: score ${p.score}\n${p.code}`).join("\n\n");
  return (
    `Task: ${spec.description}\n` +
    `A program is a JavaScript function expression: ${spec.signature}. A scoring program rates what it returns; higher is better${spec.target !== undefined ? `, and ${spec.target} is the score to reach` : ""}.\n\n` +
    `Programs so far, from the worse to the better:\n\n${versions}\n\n` +
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
      const out = await sage(`import json\npairs = json.loads(${JSON.stringify(pairs)})\njson.dumps([(lambda i, x: (${spec.scoreSage}))(i, x) for i, x in pairs])`, signal !== undefined ? { signal } : {});
      scores = JSON.parse(out.trim().replace(/^'([\s\S]*)'$/, "$1")) as Json[];
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
  hooks: { events?: Partial<SearchEvents>; shouldStop?: () => boolean; signal?: AbortSignal; model?: string } = {},
): Promise<SearchResult> {
  const db = new ProgramDatabase(options.islands, options);
  let evaluated = 0;
  let globalBest = -Infinity;
  const reached = (): boolean => spec.target !== undefined && (db.best()?.score ?? -Infinity) >= spec.target;
  const consider = async (code: string, round: number, island: number): Promise<void> => {
    const evaluation = await scorer(code, hooks.signal);
    evaluated++;
    const isBest = evaluation.ok && evaluation.score > globalBest;
    if (evaluation.ok) {
      globalBest = Math.max(globalBest, evaluation.score);
      db.add({ code, signature: evaluation.signature, score: evaluation.score, round, island });
    }
    hooks.events?.program?.({ round, island, code, evaluation, isBest });
  };
  for (const seed of spec.seeds) for (let i = 0; i < options.islands; i++) await consider(seed, 0, i);
  if (db.best() === undefined) return { best: undefined, rounds: 0, evaluated, reached: false, stoppedBy: "rounds" };
  for (let round = 1; round <= options.rounds; round++) {
    if (reached()) return { best: db.best(), rounds: round - 1, evaluated, reached: true, stoppedBy: "target" };
    if (options.resetEvery > 0 && round > 1 && (round - 1) % options.resetEvery === 0) hooks.events?.reset?.({ round, islands: db.reset(random) });
    const drawn = db.sample(options.shown, random);
    if (drawn === undefined) break;
    for (let k = 0; k < options.samples; k++) {
      if (hooks.shouldStop?.() === true) return { best: db.best(), rounds: round - 1, evaluated, reached: reached(), stoppedBy: "budget" };
      const answer = await completeJson<{ program: string }>(llm, {
        system: withAntiSycophancy("You write short JavaScript programs for a search. Your answer is read by a program."),
        prompt: `${buildPrompt(spec, drawn.programs, round)}${options.samples > 1 ? ` (draft ${k + 1} of ${options.samples})` : ""}`,
        schema: PROGRAM_SCHEMA as never,
        site: "search.program",
        reuse: true,
        ...(hooks.model !== undefined ? { model: hooks.model } : {}),
      });
      await consider(answer.value.program, round, drawn.island);
    }
  }
  return { best: db.best(), rounds: options.rounds, evaluated, reached: reached(), stoppedBy: reached() ? "target" : "rounds" };
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
