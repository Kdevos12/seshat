import type { Json } from "./canonical-json.ts";

/**
 * Where a learned, unverified artifact comes from (plan change PE1, Global Constraint 16): an
 * attempt record that "already tried" reads, a lesson, a posterior's attempts, a schema, a prompt.
 * Lean-checked facts and edges do not carry one: they are model independent.
 */
export interface Provenance {
  /** The prover model as configured, `PROVIDER/ID`. */
  modelId: string;
  /** The version of the prompts the artifact was learned under (`PROMPT_VERSION` for the provers'). */
  promptVersion: string;
  /** The Mathlib revision: the bench's revision, until the Lean environment's hash stands in for it. */
  mathlibRev: string;
  /** The revision of this harness (the code revision of the run). */
  harnessVersion: string;
  /** The run's budget class (`budgetClassOf`). */
  budgetClass: string;
  /** ISO 8601 time the artifact was made. */
  createdAt: string;
}

/** What a run knows of its provenance before an artifact is made: a stamp without its time. */
export type ProvenanceContext = Omit<Provenance, "createdAt">;

const FIELDS = ["modelId", "promptVersion", "mathlibRev", "harnessVersion", "budgetClass", "createdAt"] as const;

/** The stamp of an artifact made now (or at `now`), by the context of the run. `modelId` replaces the context's, for a session that ran another model. */
export function stampProvenance(context: ProvenanceContext, options: { modelId?: string; now?: Date } = {}): Provenance {
  return {
    modelId: options.modelId ?? context.modelId,
    promptVersion: context.promptVersion,
    mathlibRev: context.mathlibRev,
    harnessVersion: context.harnessVersion,
    budgetClass: context.budgetClass,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}

/** What is wrong with a value that should be a `Provenance`: nothing, when the list is empty. */
export function provenanceProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["a provenance is an object"];
  const record = value as Record<string, unknown>;
  const problems = FIELDS.filter((field) => typeof record[field] !== "string" || record[field] === "").map(
    (field) => `provenance.${field} must be a non-empty string`,
  );
  const extra = Object.keys(record).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) problems.push(`provenance has unknown field(s) ${extra.join(", ")}`);
  if (typeof record.createdAt === "string" && Number.isNaN(Date.parse(record.createdAt))) problems.push("provenance.createdAt must be an ISO 8601 time");
  return problems;
}

export function isProvenance(value: unknown): value is Provenance {
  return provenanceProblems(value).length === 0;
}

/** A provenance as JSON, for a node's data or a column. */
export function provenanceJson(p: Provenance): Json {
  return { ...p };
}

/**
 * The family of a model: `PROVIDER/ID` without the snapshot suffix that names a date or a moving
 * alias (`-20250929`, `-2025-09-29`, `@20250929`, `-latest`). A change of version number is a change
 * of family, since a model upgrade is what opens an epoch (PE1, PE3). A heuristic on the text of the
 * id, which a run's configuration cannot refine; an id the rules do not recognize is its own family.
 */
export function modelFamily(modelId: string): string {
  return modelId
    .trim()
    .replace(/[-@:]latest$/i, "")
    .replace(/[-@]\d{4}-\d{2}-\d{2}$/, "")
    .replace(/[-@]\d{8}$/, "");
}

/**
 * The major version of a prompt version: `m0-2` is major `m0-2`, and so is `m0-2.1`, whose minor part
 * (`.1`) marks a rewording that must not open an epoch. A version with no number in it is its own major.
 */
export function promptMajor(version: string): string {
  const match = /^(.*?\d+)(?:\.[0-9A-Za-z.]+)?$/.exec(version.trim());
  return match?.[1] ?? version.trim();
}

/**
 * The budget class of a run, from its dollars per problem: `tiny` under $0.5, `small` under $2,
 * `medium` under $10, `large` under $50, `huge` above. A run without a per-problem limit is `unbounded`.
 */
export function budgetClassOf(problemUsd: number | undefined): string {
  if (problemUsd === undefined || !Number.isFinite(problemUsd)) return "unbounded";
  if (problemUsd < 0.5) return "tiny";
  if (problemUsd < 2) return "small";
  if (problemUsd < 10) return "medium";
  if (problemUsd < 50) return "large";
  return "huge";
}

/** What PE3 groups attempts by: the model's family and the budget class. */
export interface ConfigClass {
  family: string;
  budgetClass: string;
}

export function configClassOf(p: Pick<Provenance, "modelId" | "budgetClass">): ConfigClass {
  return { family: modelFamily(p.modelId), budgetClass: p.budgetClass };
}

/** A config class as one string, to group by: `FAMILY@BUDGET_CLASS`. */
export function configClassKey(p: Pick<Provenance, "modelId" | "budgetClass">): string {
  const c = configClassOf(p);
  return `${c.family}@${c.budgetClass}`;
}

/** What differs between two runs' provenance in the ways that open an epoch (PE1 item 2). */
export interface EpochChange {
  field: "modelFamily" | "promptMajor" | "mathlibRev";
  from: string;
  to: string;
}

/** The epoch triggers: the prover model family, the prompts' major version, the Mathlib revision. Empty: the same epoch goes on. */
export function epochChanges(previous: ProvenanceContext, now: ProvenanceContext): EpochChange[] {
  const changes: EpochChange[] = [];
  const pairs: Array<[EpochChange["field"], string, string]> = [
    ["modelFamily", modelFamily(previous.modelId), modelFamily(now.modelId)],
    ["promptMajor", promptMajor(previous.promptVersion), promptMajor(now.promptVersion)],
    ["mathlibRev", previous.mathlibRev, now.mathlibRev],
  ];
  for (const [field, from, to] of pairs) if (from !== to) changes.push({ field, from, to });
  return changes;
}

/** `EPOCH_FIELDS` of an `epoch_opened` event. */
export const EPOCH_FIELDS: readonly EpochChange["field"][] = ["modelFamily", "promptMajor", "mathlibRev"];
