import type { Json } from "@seshat/core";
import type { MemoryStore } from "@seshat/memory";
import type { LibraryBuilder, BuildOptions, LibraryBuildResult } from "./builder.ts";
import { GAP_KIND, recordBuild } from "./record.ts";
import type { LibraryJob, LibrarySpec } from "./spec.ts";

/** Why a gap was recorded (plan change LC4, the triggers of `fill`; `port` is a package the resolver found no tag for). */
export type GapTrigger = "unknown_identifier" | "prover_request" | "unsolved_subgoal" | "no_compatible_tag";

export interface Gap {
  trigger: GapTrigger;
  /** The concept in a normalized form: an identifier, the words of a request, the text of a subgoal, a package name. */
  concept: string;
  job: LibraryJob;
  /** How many distinct attempts (or problems) showed it. */
  count: number;
  evidence: string[];
}

export interface GapThresholds {
  /** Distinct attempts with an `unknown identifier` for one concept. Default 3. */
  unknownIdentifier: number;
  /** Distinct problems with a standard-looking subgoal the battery did not close. Default 2. */
  unsolvedSubgoal: number;
}

export const DEFAULT_THRESHOLDS: GapThresholds = { unknownIdentifier: 3, unsolvedSubgoal: 2 };

const UNKNOWN = /unknown (?:identifier|constant) '([^']{1,120})'/g;

/** The identifiers that Lean messages say are unknown. */
export function unknownIdentifiers(messages: readonly string[]): string[] {
  const found = new Set<string>();
  for (const message of messages) for (const m of message.matchAll(UNKNOWN)) found.add(m[1] as string);
  return [...found];
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 240);

/**
 * Counts what the triggers watch for, over a run. Deterministic, no model: it answers a gap when a concept has
 * been seen often enough, once. The gap is a record; whether anything is built from it is the builder's setting.
 */
export class GapTracker {
  readonly #thresholds: GapThresholds;
  readonly #seen = new Map<string, Set<string>>();
  readonly #raised = new Set<string>();

  constructor(thresholds: Partial<GapThresholds> = {}) {
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  #count(key: string, who: string): number {
    const set = this.#seen.get(key) ?? new Set<string>();
    set.add(who);
    this.#seen.set(key, set);
    return set.size;
  }

  #raise(trigger: GapTrigger, concept: string, job: LibraryJob, count: number, evidence: string[]): Gap | undefined {
    const key = `${trigger}:${concept}`;
    if (this.#raised.has(key)) return undefined;
    this.#raised.add(key);
    return { trigger, concept, job, count, evidence };
  }

  /** The Lean messages of an attempt that failed. A concept reaches the threshold when enough distinct attempts name it as unknown. */
  observeFailure(input: { attemptId: string; messages: readonly string[] }): Gap[] {
    const gaps: Gap[] = [];
    for (const id of unknownIdentifiers(input.messages)) {
      const count = this.#count(`unknown_identifier:${id}`, input.attemptId);
      if (count >= this.#thresholds.unknownIdentifier) {
        const gap = this.#raise("unknown_identifier", id, "fill", count, [`unknown identifier ${id} in ${count} attempts`]);
        if (gap !== undefined) gaps.push(gap);
      }
    }
    return gaps;
  }

  /** A lemma a prover asked for explicitly: a gap at once. */
  observeRequest(input: { attemptId: string; concept: string }): Gap | undefined {
    const concept = normalize(input.concept);
    if (concept === "") return undefined;
    return this.#raise("prover_request", concept, "fill", this.#count(`prover_request:${concept}`, input.attemptId), [`asked for by ${input.attemptId}`]);
  }

  /** A subgoal that looks standard and that the battery did not close. `standard` is the caller's judgement; a closed one is no gap. */
  observeSubgoal(input: { problemId: string; goal: string; closed: boolean; standard: boolean }): Gap | undefined {
    if (input.closed || !input.standard) return undefined;
    const concept = normalize(input.goal);
    const count = this.#count(`unsolved_subgoal:${concept}`, input.problemId);
    if (count < this.#thresholds.unsolvedSubgoal) return undefined;
    return this.#raise("unsolved_subgoal", concept, "fill", count, [`open in ${count} problems`]);
  }

  /** A package the resolver found no tag for at the pinned toolchain: a `port`. */
  observePackage(input: { name: string; reason: string }): Gap | undefined {
    return this.#raise("no_compatible_tag", input.name, "port", 1, [normalize(input.reason)]);
  }
}

/** Writes a gap into the journal as a `library_gap` node (once per trigger and concept). Records nothing else, and builds nothing. */
export function recordGap(memory: MemoryStore, gap: Gap): { nodeId: string; created: boolean } {
  for (const n of memory.nodes(GAP_KIND)) {
    const d = n.data as Record<string, Json>;
    if (d.trigger === gap.trigger && d.concept === gap.concept) return { nodeId: n.nodeId, created: false };
  }
  const node = memory.recordNode({ kind: GAP_KIND, data: { ...gap, status: "open" } as unknown as Json });
  return { nodeId: node.nodeId, created: true };
}

/** The gaps still `open`, in the order recorded. */
export function openGaps(memory: MemoryStore): Array<{ nodeId: string; gap: Gap }> {
  return memory.nodes(GAP_KIND).filter((n) => (n.data as Record<string, Json>).status === "open").map((n) => ({ nodeId: n.nodeId, gap: n.data as unknown as Gap }));
}

export interface ServiceOptions {
  builder: LibraryBuilder;
  memory: MemoryStore;
  /** A person or a spec writer turns a gap into a spec (informal statements, names, test lemmas). Undefined: the gap stays open. */
  specFor: (gap: Gap) => Promise<LibrarySpec | undefined>;
  build: BuildOptions;
  /** True while a run is going. A build is never started during a run. */
  runActive: () => boolean;
  envHash?: string | null;
}

/**
 * Between runs: for each open gap, ask for a spec and build it. With the `none` builder every gap stays recorded and nothing is
 * built. Each build is journaled, accepted or not; a gap whose build was accepted is `built`, one that was rejected stays open
 * with the reason. Returns the results.
 */
export async function processGaps(o: ServiceOptions): Promise<LibraryBuildResult[]> {
  if (o.runActive()) throw new Error("processGaps: a run is going; a build changes the environment, so it starts between runs");
  const results: LibraryBuildResult[] = [];
  if (o.builder.id === "none") return results;
  for (const { nodeId, gap } of openGaps(o.memory)) {
    const spec = await o.specFor(gap);
    if (spec === undefined) continue;
    const result = await o.builder.build(spec, o.build);
    recordBuild(o.memory, result, o.envHash !== undefined ? { envHash: o.envHash } : {});
    o.memory.updateNode(nodeId, { status: result.status === "accepted" ? "built" : "open", lastBuild: result.buildId, lastStatus: result.status }, result.reason);
    results.push(result);
  }
  return results;
}
