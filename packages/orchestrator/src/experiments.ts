import { DECISION_SITES } from "@seshat/core";
import { type AblationName, ablationLines, type JsonObject, LINE_ORDER, SUSPENDED_LINES } from "@seshat/lines";
import type { Arm } from "./ablation.ts";
import { type RunConfig, RunSetupError } from "./run.ts";
import { benchAdditions, type DefaultsName, setConfig } from "./student.ts";

/**
 * The experiments of the amendments (documentation/ablate.md, "Experiments"): each is a short list of arms that differ by one
 * option, run on the same problems at the same budget as the cumulative table. They are data: `harness ablate --experiment NAME`
 * builds the arms from here and the runner does the rest.
 */
export interface Experiment {
  name: string;
  /** The plan change item it measures. */
  amendment: string;
  description: string;
  /** What this experiment cannot say without a real run. */
  notRun: string;
  arms: (context: ExperimentContext) => Arm[];
}

export interface ExperimentContext {
  /** The lines the arms share: default every line of the cumulative table, in plan order. */
  lines: string[];
  /** The models of the renderings experiment, one arm per rendering and model. */
  models: string[];
  /** The host's profile, for the arms that are what `solve` would do there: the capabilities it offers and its check timeout. Absent: it offers everything. */
  host?: { capabilities: Readonly<Record<string, unknown>>; checkTimeoutSec?: number };
}

/** The lines of the full cumulative configuration. */
export function allLines(): string[] {
  return ablationLines(LINE_ORDER.filter((id) => !SUSPENDED_LINES.has(id)).at(-1) as AblationName);
}

const without = (lines: readonly string[], drop: readonly string[]) => lines.filter((id) => !drop.includes(id));
const RUNG_LINES = ["M18", "M15", "M16"];

/** The J3 sites, in the order of the registry. The budget gate's two (PB3) are measured by the `gate` experiment, not here. */
export const DECIDE_SITES: string[] = Object.keys(DECISION_SITES).filter((site) => !site.startsWith("budget."));

const arm = (name: string, description: string, lines: string[], rest: Partial<Arm> = {}): Arm => ({ name, description, lines, ...rest });

/**
 * An arm that is what `harness solve` gives a problem under a defaults set (Task 34b, decision I): the set's fields, lines and options, the
 * budget gate (`setConfig`, the function `studentConfig` itself uses), and the set's `solve`-level switches as a bench problem gets them
 * (`benchAdditions`: the intake with the bench's yes, the compute tool and `lean.search` if the host offers them). `plus` is what a later arm
 * adds to a set, one line with its options, for example `{ lines: ["M12"], lineOptions: { M12: { blueprints: true } } }`.
 */
export function solveArm(name: string, description: string, defaults: DefaultsName, context: Pick<ExperimentContext, "host">, rest: Partial<Arm> = {}, plus: { lines?: string[]; lineOptions?: Record<string, JsonObject>; config?: Arm["config"] } = {}): Arm {
  const host = context.host;
  const set = setConfig(defaults, host?.checkTimeoutSec !== undefined ? { hostCheckTimeoutSec: host.checkTimeoutSec } : {});
  const { lines, lineOptions, gate, tools: addedTools, ...config } = { ...set, ...benchAdditions(defaults, host === undefined ? undefined : (id) => id in host.capabilities) };
  const options = { ...lineOptions, ...plus.lineOptions };
  return {
    name,
    description,
    lines: [...new Set([...(lines ?? []), ...(plus.lines ?? [])])],
    ...(Object.keys(options).length > 0 ? { lineOptions: options } : {}),
    ...(gate !== undefined ? { gate } : {}),
    ...(addedTools !== undefined && addedTools.length > 0 ? { tools: [...addedTools] } : {}),
    config: { ...config, ...plus.config },
    ...rest,
  };
}

export const EXPERIMENTS: Experiment[] = [
  {
    name: "ladder",
    amendment: "PE4",
    description: "The escalation ladder against every rung from the start and against rung 0 alone, split by difficulty.",
    notRun: "The curves come from simulated budgets; whether the ladder pays needs a real model.",
    arms: ({ lines }) => [
      arm("ladder", "the rungs above 0 wait until the ladder moves a problem up", lines, { lineOptions: { M12: { ladder: true } } }),
      arm("all-rungs", "every line works from the start of every problem", lines, { lineOptions: { M12: { ladder: false } }, versus: "ladder" }),
      arm("rung-0-only", "the lines of rung 1 and above are left out", without(lines, RUNG_LINES), { versus: "ladder" }),
    ],
  },
  {
    name: "packet-mode",
    amendment: "PD2, PE5",
    description: "A frozen prefix with a tail, an append-only packet, a packet recompiled for every request, and the naive packet.",
    notRun: "The cache ratio is the faux provider's; a provider's own cache must be read on the first real run.",
    arms: ({ lines }) => [
      arm("prefix_tail", "the default: the prefix is frozen, the tail is rebuilt", lines, { packetMode: "prefix_tail" }),
      arm("append_only", "the opening is frozen; later packets are appended as messages", lines, { packetMode: "append_only", versus: "prefix_tail" }),
      arm("recompiled", "the whole packet is compiled again for every request", lines, { packetMode: "recompiled", versus: "prefix_tail" }),
      arm("naive", "M4's naive packet: every item, no ids, no threshold", lines, { lineOptions: { M4: { naive: true } }, versus: "prefix_tail" }),
    ],
  },
  {
    name: "renderings",
    amendment: "PC5",
    description: "The three renderings of the packet's facts (list, merged, table), per model.",
    notRun: "A rendering that helps one model can hurt another: only real models tell.",
    arms: ({ lines, models }) =>
      (models.length > 0 ? models : [undefined]).flatMap((model) =>
        (["list", "merged", "table"] as const).map((rendering) =>
          arm(model === undefined ? rendering : `${rendering} (${model})`, `the facts rendered as a ${rendering}`, lines, {
            lineOptions: { M4: { rendering } },
            ...(model !== undefined ? { model } : {}),
            ...(rendering !== "list" ? { versus: model === undefined ? "list" : `list (${model})` } : {}),
          }),
        ),
      ),
  },
  {
    name: "queries",
    amendment: "PC5",
    description: "Queries extracted by the model against the raw statement as the query.",
    notRun: "The extraction call is a model's.",
    arms: ({ lines }) => [
      arm("extracted", "the model names what to look up", lines, { lineOptions: { M4: { extractQueries: true } } }),
      arm("raw", "the statement is the query", lines, { lineOptions: { M4: { extractQueries: false } }, versus: "extracted" }),
    ],
  },
  {
    name: "seeds",
    amendment: "PC13",
    description: "Pattern seeds on and off, split by difficulty.",
    notRun: "The neighbours come from the TheoremGraph and `lean.meta premises`, which need a real Lean.",
    arms: ({ lines }) => [
      arm("seeds-off", "no pattern seeds", lines, { lineOptions: { M4: { seeds: false } } }),
      arm("seeds-on", "pattern seeds among the premises", lines, { lineOptions: { M4: { seeds: true } }, versus: "seeds-off" }),
    ],
  },
  {
    name: "lessons",
    amendment: "PE2",
    description: "The lesson set deactivated by its measured effect against deactivated by presence.",
    notRun: "Needs enough problems for a lesson to collect its observations.",
    arms: ({ lines }) => [
      arm("effect", "a lesson goes when its measured effect is not positive", lines, { lineOptions: { M5: { deactivation: "effect" } } }),
      arm("presence", "a lesson goes when it stops being present", lines, { lineOptions: { M5: { deactivation: "presence" } }, versus: "effect" }),
    ],
  },
  {
    name: "cegis",
    amendment: "PD5",
    description: "M8 with its counterexample set against M8 with the set off (`M8.counterexampleSet=false`): only the set differs.",
    notRun: "The tokens saved are an estimate; the effect is on the candidates M8's model proposes, so it needs a real model.",
    arms: ({ lines }) => [
      arm("set-off", "M8 proposes and checks without the counterexample set", lines, { lineOptions: { M8: { counterexampleSet: false } } }),
      arm("set-on", "the counterexamples found so far go in the prompt and every candidate meets them first", lines, { lineOptions: { M8: { counterexampleSet: true } }, versus: "set-off" }),
    ],
  },
  {
    name: "lsp",
    amendment: "PC7",
    description: "`lean.lsp` as a tool set against M0.",
    notRun: "Needs a real Lean language server.",
    arms: () => [arm("M0", "lean_check only", []), arm("M0+lsp", "lean_check and lean.lsp", [], { tools: ["lean.lsp"], versus: "M0" })],
  },
  {
    name: "decide",
    amendment: "J1, J4, J5 (line D1)",
    description: "One arm per J3 site whose answer is asked of Jev, against the model, with the agreement between the two.",
    notRun: "Not run against real Jev: only a faux Jev answers in tests.",
    arms: ({ lines }) => [
      arm("llm", "every decision asked of the run's model", lines),
      ...DECIDE_SITES.map((site) => arm(`jev:${site}`, `${site} asked of Jev`, lines, { decide: { backend: "llm", sites: { [site]: "jev" }, votes: 1 }, versus: "llm" })),
    ],
  },
  {
    name: "gate",
    amendment: "PB4",
    description: "The budget gate: no gate, the rule alone, the rule with its cold starts and ties asked of the run's model, and the same asked of Jev. Cost to first success and the avoided spend, by arm.",
    notRun: "The avoided dollars are the gate's estimate, not a measurement; whether the gate pays (cost to first success, and the problems it wrongly skips) needs a real model. Not run against real Jev.",
    arms: ({ lines }) => [
      arm("no-gate", "every prover starts together and every session runs, as before the gate", lines, { gate: false }),
      arm("rule", "the rule alone: probe first, widen on Lean progress, the floor lets a fraction through", lines, { gate: {}, decide: { sites: { "budget.wave": "off", "budget.line": "off" } }, versus: "no-gate" }),
      arm("rule+llm", "the rule, with cold starts and ties asked of the run's model", lines, { gate: {}, decide: { backend: "llm", votes: 1 }, versus: "rule" }),
      arm("rule+jev", "the rule, with cold starts and ties asked of Jev", lines, { gate: {}, decide: { backend: "llm", sites: { "budget.wave": "jev", "budget.line": "jev" }, votes: 1 }, versus: "rule+llm" }),
    ],
  },
  {
    name: "heuristics",
    amendment: "HB3 (Task 32)",
    description: "The fleet alone, the fleet with the six directives, and the fleet with the bank of heuristic cards (its control share on): only the fleet's option differs.",
    notRun: "Whether a card helps is a model's behaviour: at a 30% base rate a 10-point effect needs about 350 sessions per arm, so a simulated run says only that the arms run.",
    arms: ({ lines }) => [
      arm("fleet", "the fleet's strategies and settings, no directive and no card", lines),
      arm("directives", "the six directives drawn by Thompson sampling, as before the bank", lines, { lineOptions: { fleet: { directives: true } }, versus: "fleet" }),
      arm("cards", "one card of the bank per session, a share of sessions with none", lines, { lineOptions: { fleet: { heuristics: true } }, versus: "directives" }),
    ],
  },
  {
    name: "solve-defaults",
    amendment: "CA2, CA21 (Task 34b)",
    description: "What `harness solve` does under defaults v1 (the baseline, solve as it was at ae3b2a0) against v2 (the edit tool, masked and bounded checks, the state card, budget rounds, M6's repeat rule, the intake gate, the compute tool and lean.search), on bench problems at the protocol's cap per problem; a third arm adds line M12's blueprints to v2, a fourth adds lines M2 (the graph) and M4 (the context compiler), neither of which is a default, a fifth adds refinement rounds (M12's option refine) to the blueprints arm, and its planner gets the informal proof too (`informalFirst`); a sixth, `solve-v2-informal`, adds only the informal proof first (a natural-language proof read by a verifier until three passes in a row say it is correct, handed on as a hint that Lean has not checked) to v2.",
    notRun: "No number of the target exists until the arms run on real problems with a real model and Lean; the compute tool and lean.search are in an arm only if the host profile offers them. The turn limit, the signature and the question are what `solve` has because a person is there, and are not in the arms.",
    arms: (context) => [
      solveArm("solve-v1", "solve's configuration under defaults v1: the baseline", "v1", context),
      solveArm("solve-v2", "solve's configuration under defaults v2, with the intake gate, the compute tool and lean.search as the host offers them", "v2", context, { versus: "solve-v1" }),
      // Line M12's blueprints are not in v2: they have not run on a real Lean. This arm measures what they would add to it.
      solveArm("solve-v2-blueprints", "solve-v2 plus line M12 with its option blueprints: holes that depend on each other, a session with tools per hole", "v2", context, { versus: "solve-v2" }, { lines: ["M12"], lineOptions: { M12: { blueprints: true } } }),
      // Lines M2 and M4 are not in v2: they have never run with a real model. This arm measures what they cost and what they add to it (plan change KG1).
      solveArm("solve-v2-graph", "solve-v2 plus line M2 (the graph of claims and variants) and line M4 (the context compiler), with their default options", "v2", context, { versus: "solve-v2" }, { lines: ["M2", "M4"] }),
      // Refinement rounds (CA12, PA11) and the repair pass (CA13): a planner call rewrites a blueprint that was refused or whose holes did not all get proved, and a session that ends on errors is cut to a blueprint. Set against the blueprints arm: only `refine` and `repair` differ.
      solveArm("solve-v2-blueprints-refine", "solve-v2-blueprints plus M12's options refine and repair: a planner call rewrites a refused or stuck blueprint, at most 8 rounds a problem, and a session that ends on Lean errors has its failing blocks cut to sorry, at most 2 repairs a problem", "v2", context, { versus: "solve-v2-blueprints" }, { lines: ["M12"], lineOptions: { M12: { blueprints: true, refine: true, repair: true } }, config: { informalFirst: {} } }),
      // The informal proof first (PA13, NL2, AL1, AL2): a natural-language proof, read by a verifier until three passes in a row say it is correct (at most four generate-or-revise calls), goes to the outer prover's first briefing and to the planner as a hint that Lean has not checked. Set against solve-v2: only `informalFirst` differs.
      solveArm("solve-v2-informal", "solve-v2 plus the informal proof first: a proof in natural language, generated and read by a verifier until 3 passes in a row (at most 4 generate-or-revise calls), handed to the first briefing as a hint not checked by Lean", "v2", context, { versus: "solve-v2" }, { config: { informalFirst: {} } }),
    ],
  },
  {
    name: "m17",
    amendment: "LC3",
    description: "The run with the library environment extended (line M17) against the run without it.",
    notRun: "Needs a real Lean environment to pin; the registry must be pinned by the caller.",
    arms: ({ lines }) => [arm("without-M17", "the base Lean environment", without(lines, ["M17"])), arm("with-M17", "the environment extended by M17", [...without(lines, ["M17"]), "M17"], { versus: "without-M17" })],
  },
];

export function experimentNames(): string[] {
  return EXPERIMENTS.map((e) => e.name);
}

export function experiment(name: string): Experiment {
  const found = EXPERIMENTS.find((e) => e.name === name);
  if (found === undefined) throw new RunSetupError(`unknown experiment ${JSON.stringify(name)}; they are ${experimentNames().join(", ")}`);
  return found;
}

/** The arms of an experiment. `lines` defaults to every line of the cumulative table. */
export function experimentArms(name: string, context: Partial<ExperimentContext> = {}): Arm[] {
  return experiment(name).arms({ lines: context.lines ?? allLines(), models: context.models ?? [], ...(context.host !== undefined ? { host: context.host } : {}) });
}

