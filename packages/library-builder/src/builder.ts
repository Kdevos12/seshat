import type { GateCheck, GateFile, NewDefinition } from "./gate.ts";
import type { BuildBudget, LibraryJob, LibrarySpec } from "./spec.ts";

export interface BuildOptions {
  budget: BuildBudget;
  timeoutSec: number;
  signal?: AbortSignal;
}

/**
 * What a build recorded about itself, for the journal (plan change LC4, gate rule 5): who ran, with what, on what, and what
 * Seshat's gate found. Nothing in it is a secret: the agent's environment is named by its keys, never its values.
 */
export interface BuildProvenance {
  /** The builder's id: `none` or `coding-agent`. */
  builder: string;
  agent?: string;
  model?: string;
  /** The argv that ran, with the sandbox in front. */
  command?: string[];
  envKeys?: string[];
  budget: BuildBudget;
  timeoutSec: number;
  prompt?: string;
  promptHash?: string;
  /** The commit of the project the agent started from. */
  baseCommit?: string;
  /** The end of what the agent printed. */
  agentOutput?: string;
  agentMs?: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * `accepted`: every rule of the gate holds. `rejected`: the agent's work broke a rule. `failed`: the agent did not run to
 * its end, or the gate could not decide (the certifier was unavailable): nothing is known about the work, and a later try may
 * differ. `skipped`: the `none` builder; the gap is only recorded.
 */
export type BuildStatus = "accepted" | "rejected" | "failed" | "skipped";

export interface LibraryBuildResult {
  buildId: string;
  status: BuildStatus;
  job: LibraryJob;
  domain: string;
  spec: LibrarySpec;
  /** Why, in a line. */
  reason: string;
  gate: GateCheck[];
  /** Set only when accepted. */
  files: GateFile[];
  theorems: string[];
  definitions: NewDefinition[];
  /** A port with code that runs at elaboration: adopted only with a person's approval. */
  needsApproval: boolean;
  diff: string;
  provenance: BuildProvenance;
}

/**
 * The LibraryBuilder of plan change LC4. An implementation turns a spec into new Lean files, or says why not. It never
 * changes the project that a run is in: an accepted build is files and a record, and `adoptBuild` lands them between runs,
 * which gives the next run another environment hash (documentation/library-builder.md).
 */
export interface LibraryBuilder {
  readonly id: string;
  build(spec: LibrarySpec, options: BuildOptions): Promise<LibraryBuildResult>;
}

let counter = 0;
/** A build id that is unique in a process and sorts by time. */
export function newBuildId(now: Date = new Date()): string {
  counter += 1;
  return `lb_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}_${String(counter).padStart(3, "0")}`;
}

/** The default builder: nothing is built, and the gap is only recorded (by the caller). */
export class NoneBuilder implements LibraryBuilder {
  readonly id = "none";

  async build(spec: LibrarySpec, options: BuildOptions): Promise<LibraryBuildResult> {
    const at = new Date().toISOString();
    return {
      buildId: newBuildId(),
      status: "skipped",
      job: spec.job,
      domain: spec.domain,
      spec,
      reason: "no library builder is configured (builder: none), so the gap is only recorded",
      gate: [],
      files: [],
      theorems: [],
      definitions: [],
      needsApproval: false,
      diff: "",
      provenance: { builder: this.id, budget: options.budget, timeoutSec: options.timeoutSec, startedAt: at, finishedAt: at },
    };
  }
}
