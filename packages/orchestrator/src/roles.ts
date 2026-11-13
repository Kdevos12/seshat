import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Json } from "@seshat/core";
import { progressed, type Progress } from "@seshat/scheduler";
import type { PriceBook } from "./prices.ts";
import { RunSetupError } from "./setup-error.ts";

/** The thinking levels the run's providers know (a line may sample from the same scale: `SESSION_THINKING_LEVELS`). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * `RunConfig.roles` (plan changes CA15, CA23, documentation/models-setup.md, "Roles"): a model, and sampling settings, for each place the harness
 * calls a model from. A role that is not named has the run's model and its default settings, as before.
 */
export const ROLES = ["prover", "planner", "hole", "verifier", "consult"] as const;
export type Role = (typeof ROLES)[number];

/** The sampling settings a role may carry. `thinking` is a level the run already knows (the levels above). */
export interface RoleSettings {
  temperature?: number;
  topP?: number;
  thinking?: ThinkingLevel;
}

export interface RoleConfig {
  /** `provider/id`, resolved like the run's model. Absent: the run's. */
  model?: string;
  settings?: RoleSettings;
}

/** With `roles.planner`, the model the planner's next calls go to after two refinement rounds with no Lean progress (documentation/scheduler.md, "Refinement rounds"). */
export interface Escalation {
  /** `provider/id`. */
  model: string;
  /** The most the escalated calls may cost, as a share of the problem's allowance. Default `DEFAULT_ESCALATION_SHARE`. */
  maxShare?: number;
}

export type RolesConfig = Partial<Record<Role, RoleConfig>> & { escalation?: Escalation };

export const DEFAULT_ESCALATION_SHARE = 0.25;
/** The rounds in a row without Lean progress after which the planner escalates. */
export const ESCALATION_AFTER = 2;

/** The role a model-call site belongs to, for the sites that are one role's alone. */
export function roleOfSite(site: string | undefined): Role | undefined {
  switch (site) {
    case "scheduler.planner":
      return "planner";
    case "scheduler.hole":
      return "hole";
    case "consult":
      return "consult";
    case "prover.session":
      return "prover";
    default:
      return undefined;
  }
}

const NAME = /^[^/\s]+\/\S+$/;

/** The problems of a `roles` setting; empty when it is fine. */
export function checkRoles(roles: RolesConfig): string[] {
  const problems: string[] = [];
  const known = new Set<string>([...ROLES, "escalation"]);
  for (const key of Object.keys(roles)) if (!known.has(key)) problems.push(`roles.${key}: unknown role; the roles are ${ROLES.join(", ")} (and escalation, the planner's)`);
  for (const role of ROLES) {
    const config = roles[role];
    if (config === undefined) continue;
    if (typeof config !== "object" || config === null) {
      problems.push(`roles.${role} must be an object`);
      continue;
    }
    if (config.model !== undefined && !(typeof config.model === "string" && NAME.test(config.model))) problems.push(`roles.${role}.model ${JSON.stringify(config.model)}: expected provider/id, as harness models lists them`);
    const settings = config.settings;
    if (settings === undefined) continue;
    for (const key of Object.keys(settings)) if (!["temperature", "topP", "thinking"].includes(key)) problems.push(`roles.${role}.settings.${key}: unknown setting; they are temperature, topP and thinking`);
    const { temperature, topP, thinking } = settings;
    if (temperature !== undefined && !(typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)) problems.push(`roles.${role}.settings.temperature must be a number from 0 to 2`);
    if (topP !== undefined && !(typeof topP === "number" && Number.isFinite(topP) && topP > 0 && topP <= 1)) problems.push(`roles.${role}.settings.topP must be a number above 0 and at most 1`);
    if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) problems.push(`roles.${role}.settings.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const escalation = roles.escalation;
  if (escalation !== undefined) {
    if (typeof escalation !== "object" || escalation === null || !(typeof escalation.model === "string" && NAME.test(escalation.model))) problems.push(`roles.escalation.model ${JSON.stringify((escalation as { model?: unknown } | null)?.model)}: expected provider/id`);
    if (escalation.maxShare !== undefined && !(typeof escalation.maxShare === "number" && escalation.maxShare > 0 && escalation.maxShare <= 1)) problems.push("roles.escalation.maxShare must be a number above 0 and at most 1");
    if (roles.planner === undefined) problems.push("roles.escalation goes with roles.planner: it is the planner's");
  }
  return problems;
}

/** Looks every model a `roles` setting names up, so that a name or a key that is missing stops the run before any spend; the error names the role. */
export async function resolveRoles(roles: RolesConfig, resolve: (name: string) => Promise<Model<Api>>): Promise<void> {
  const problems = checkRoles(roles);
  if (problems.length > 0) throw new RunSetupError(problems.join("; "));
  const named: Array<[string, string]> = [
    ...ROLES.flatMap((role) => (roles[role]?.model !== undefined ? [[`roles.${role}.model`, roles[role]?.model as string] as [string, string]] : [])),
    ...(roles.escalation !== undefined ? [["roles.escalation.model", roles.escalation.model] as [string, string]] : []),
  ];
  for (const [where, name] of named) {
    try {
      await resolve(name);
    } catch (error) {
      throw new RunSetupError(`${where} ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

/** What one call of a role is made with. */
export interface RoleUse {
  role: Role;
  /** `provider/id`. */
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Sent with the request; absent when not configured, or when the model's family ignores it. */
  temperature?: number;
  topP?: number;
  /** The configured settings that were not sent because the model's family ignores them (the host profile's `ignores`). */
  ignored: string[];
  /** The settings as used, for the journal: absent when the role carries no settings (so that a run without them records what it always did). */
  record?: { [key: string]: Json };
}

/** The request options of a use, on top of a call's own. Settings that are absent add nothing. */
export function sampling(use: Pick<RoleUse, "temperature" | "topP">): Pick<SimpleStreamOptions, "temperature" | "samplingParams"> {
  return {
    ...(use.temperature !== undefined ? { temperature: use.temperature } : {}),
    // pi-ai passes `samplingParams` through to OpenAI-compatible adapters; the other adapters ignore it.
    ...(use.topP !== undefined ? { samplingParams: { top_p: use.topP } } : {}),
  };
}

/** The roles of a run, with the run's own model and thinking level as the default of every role that is not named. */
export class RoleBook {
  readonly config: RolesConfig;
  private readonly run: { model: string; thinkingLevel: ThinkingLevel };
  private readonly prices: PriceBook | undefined;

  constructor(config: RolesConfig, run: { model: string; thinkingLevel: ThinkingLevel }, prices?: PriceBook) {
    this.config = config;
    this.run = run;
    this.prices = prices;
  }

  /** Whether the run names this role. */
  has(role: Role): boolean {
    return this.config[role] !== undefined;
  }

  /**
   * The use of `role`, on `model` when given (the escalation's, or the model a line chose for a session), else the role's own model, else the run's;
   * at `thinking` when given (a line sampled it), else the role's, else the run's.
   */
  use(role: Role, model?: string, thinking?: ThinkingLevel): RoleUse {
    const config = this.config[role];
    const name = model ?? config?.model ?? this.run.model;
    const settings = config?.settings;
    const thinkingLevel = thinking ?? settings?.thinking ?? this.run.thinkingLevel;
    const ignored: string[] = [];
    const sent: Pick<RoleUse, "temperature" | "topP"> = {};
    const ignores = (setting: string): boolean => this.prices?.ignores(name, setting, thinkingLevel) === true;
    if (settings?.temperature !== undefined) {
      if (ignores("temperature")) ignored.push("temperature");
      else sent.temperature = settings.temperature;
    }
    if (settings?.topP !== undefined) {
      if (ignores("topP") || ignores("top_p")) ignored.push("topP");
      else sent.topP = settings.topP;
    }
    return {
      role,
      model: name,
      thinkingLevel,
      ...sent,
      ignored,
      ...(settings !== undefined && Object.keys(settings).length > 0
        ? {
            record: {
              ...(settings.thinking !== undefined ? { thinking: settings.thinking } : {}),
              ...(sent.temperature !== undefined ? { temperature: sent.temperature } : {}),
              ...(sent.topP !== undefined ? { topP: sent.topP } : {}),
              ...(ignored.length > 0 ? { ignored } : {}),
            },
          }
        : {}),
    };
  }

  get escalation(): Escalation | undefined {
    return this.config.escalation;
  }
}

/** What the planner's escalation needs to read from the run. */
export interface EscalationInputs {
  /** The refinement rounds the problem has made (the planner's blueprints recorded): a model call that asks again within a round (a JSON retry) is not a new round. */
  rounds: () => number;
  /** Where the problem stands in Lean's eyes (`progressOf`, the measure the ladder and the budget in rounds use). */
  progress: () => Progress;
  /** The problem's allowance in dollars; undefined when it has none, and then nothing escalates (there is no share to keep within). */
  allowanceUsd: () => number | undefined;
  /** What the planner's calls on `model` have cost this problem so far. */
  spentOn: (model: string) => number;
}

/** The planner's choice for one call. */
export interface PlannerChoice {
  use: RoleUse;
  /** Set when the call goes to the escalation model: the planner's own model, and the rounds in a row without Lean progress that led here. */
  escalated?: { from: string; rounds: number };
}

/**
 * The planner's escalation (CA15): each call of the planner is the start of a refinement round, and the progress since the call before is
 * what that round (with the work on its holes) came to. After `ESCALATION_AFTER` rounds in a row with none, the calls go to the escalation
 * model while what its calls have cost this problem is below `maxShare` of the allowance; past it, to the planner's own. A round with progress
 * resets the count. The count is kept by the process: a resumed run counts again from its first call.
 */
export class PlannerEscalation {
  private last: Progress | undefined;
  private seen = -1;
  private rounds = 0;
  private readonly book: RoleBook;
  private readonly inputs: EscalationInputs;

  constructor(book: RoleBook, inputs: EscalationInputs) {
    this.book = book;
    this.inputs = inputs;
  }

  /** The rounds in a row that ended without Lean progress, as of the last call. */
  get streak(): number {
    return this.rounds;
  }

  /** Called at each planner call, before it is sent. */
  choose(): PlannerChoice {
    // A new round has begun when more blueprints are recorded than at the call before; the progress since that call is what the round before came to.
    const made = this.inputs.rounds();
    if (made > this.seen) {
      const now = this.inputs.progress();
      if (this.last !== undefined) this.rounds = progressed(this.last, now) === undefined ? this.rounds + 1 : 0;
      this.last = now;
      this.seen = made;
    }
    const own = this.book.use("planner");
    const escalation = this.book.escalation;
    if (escalation === undefined || this.rounds < ESCALATION_AFTER) return { use: own };
    const allowance = this.inputs.allowanceUsd();
    if (allowance === undefined || !(allowance > 0)) return { use: own };
    const cap = (escalation.maxShare ?? DEFAULT_ESCALATION_SHARE) * allowance;
    if (this.inputs.spentOn(escalation.model) >= cap - 1e-12) return { use: own };
    return { use: this.book.use("planner", escalation.model), escalated: { from: own.model, rounds: this.rounds } };
  }
}

/** The roles of a setting in words, for the start log and `harness solve`'s defaults line: `planner on P/ID (temperature 0.2); escalation to E/ID`. */
export function describeRoles(roles: RolesConfig): string {
  return [
    ...ROLES.flatMap((role) => {
      const config = roles[role];
      if (config === undefined) return [];
      const settings = Object.entries(config.settings ?? {}).map(([key, value]) => `${key} ${String(value)}`);
      return [`${role}${config.model !== undefined ? ` on ${config.model}` : ""}${settings.length > 0 ? ` (${settings.join(", ")})` : ""}`];
    }),
    ...(roles.escalation !== undefined ? [`escalation to ${roles.escalation.model}${roles.escalation.maxShare !== undefined ? ` (at most ${roles.escalation.maxShare} of the allowance)` : ""}`] : []),
  ].join("; ");
}
