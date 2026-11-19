import type { RunConfig } from "./run.ts";
import { solveDefaultsOf } from "./student.ts";

/**
 * The catalogue of every parameter a person can set (documentation/parameters.md, generated from this file): the keys of `RunConfig`, the flags
 * of every `harness` command, and the keys of the host profiles. It is the one source that the audit page and a settings menu in the graphical
 * interface read. `RUN_PARAMETERS` is typed over the keys of `RunConfig`, so a key added to `RunConfig` without an entry here fails `tsc`.
 * Nothing here changes what a run does: it describes the code, and each entry was written from the place that reads the option.
 */

/** Where a parameter belongs in the page and in a menu. */
export const PARAMETER_GROUPS = ["problems", "model", "budget", "session", "scheduling", "tools", "lines", "informal", "heuristics", "third-parties", "human", "record"] as const;
export type ParameterGroup = (typeof PARAMETER_GROUPS)[number];

/** What a group holds, one line, for the page. */
export const GROUP_SUMMARY: Readonly<Record<ParameterGroup, string>> = {
  problems: "Which problems a run works on.",
  model: "The model of the run and how it is asked.",
  budget: "Dollars: what a problem and a run may spend.",
  session: "The shape of a prover's sessions, and what the session loop does with a check.",
  scheduling: "How the budget is spent over problems and launches: the gate, the rounds, the share, the typed decisions.",
  tools: "The capabilities the provers are given besides `lean_check`.",
  lines: "The mechanisms of the plan a run enables, and their options.",
  informal: "A proof in natural language before the first session, and the facts the harness computes for the briefing.",
  heuristics: "Heuristic cards in the first briefing.",
  "third-parties": "What may leave the machine: the literature step, the private mode.",
  human: "Turns for a research team, and the off-peak option.",
  record: "What the run records about its own configuration, and the prompt under measurement.",
};

/** `stable`: tested and documented, meant to be used. `beta`: works, but a ruling keeps it off by default (the consult tool, Ruling 39). `experimental`: only an ablation arm or a measurement uses it. `internal`: the harness sets it, not a person. */
export type ParameterStatus = "stable" | "beta" | "experimental" | "internal";
/** Whether a settings menu shows it: `basic` always, `advanced` behind a toggle, `hidden` never. */
export type ParameterUi = "basic" | "advanced" | "hidden";

export interface ParameterInfo {
  group: ParameterGroup;
  /** The TypeScript type, in a few words. */
  type: string;
  /** The value when nothing sets it (the words "absent" when the option is off or the harness does without it), as `harness run` has it. */
  default: string;
  /** One sentence: what it changes. */
  summary: string;
  /** The flags of `harness` that set it, without the leading dashes; empty: none. */
  cli: readonly string[];
  /** What the defaults sets of `harness solve` do with it: `v1`, `v2`, and the solve-level additions; `-` when neither sets it. */
  sets: string;
  /** The page and section of `documentation/` that describes it (`page.md#Section`); empty: none. */
  docs: string;
  /** A test file of `packages/orchestrator/test` that sets or reads it; empty: none. */
  tested: string;
  status: ParameterStatus;
  ui: ParameterUi;
  /** The sub-fields of an object, `name (type, default): what`, one per entry. */
  fields?: readonly string[];
}

/** `{ [K in keyof RunConfig]: ParameterInfo }` with every key required: a key of `RunConfig` without an entry does not compile. */
export const RUN_PARAMETERS: { [K in keyof Required<RunConfig>]: ParameterInfo } = {
  selection: {
    group: "problems",
    type: "Json: {all} | {sample, seed} | {ids} | {sequence} | {tag}",
    default: "required (set by the problem flags)",
    summary: "How the problems were chosen, for the record; it chooses nothing by itself (the CLI picks the problems, then writes this).",
    cli: ["sample", "seed", "problem", "all", "sequence", "tag"],
    sets: "solve writes {ids: [..]} for its one statement",
    docs: "m0-loop.md#Commands",
    tested: "experiments.test.ts",
    status: "internal",
    ui: "hidden",
  },
  model: {
    group: "model",
    type: "string (provider/id)",
    default: "required (--model, else SESHAT_MODEL; solve: the host profile's recommended model if the person set one, else the cheapest capable priced one)",
    summary: "The model the provers, and every role without a model of its own, are called on.",
    cli: ["model"],
    sets: "- (solve picks it, then passes it)",
    docs: "models-setup.md#Roles: a model and settings for each place a model is called (CA15, CA23)",
    tested: "roles.test.ts",
    status: "stable",
    ui: "basic",
  },
  thinkingLevel: {
    group: "model",
    type: "off | minimal | low | medium | high | xhigh | max",
    default: "medium",
    summary: "The reasoning effort asked of the model for every session (a family that ignores a setting is told so by the host profile).",
    cli: ["thinking"],
    sets: "-",
    docs: "m0-loop.md#Commands",
    tested: "reasoning.test.ts",
    status: "stable",
    ui: "basic",
  },
  provers: {
    group: "session",
    type: "integer >= 1",
    default: "4",
    summary: "Independent provers per problem, each in its own loop of sessions.",
    cli: ["provers"],
    sets: "-",
    docs: "m0-loop.md#Commands",
    tested: "protocol.test.ts",
    status: "stable",
    ui: "advanced",
  },
  sessions: {
    group: "session",
    type: "integer >= 1",
    default: "8",
    summary: "Sessions per prover; a session starts from the notes of the one before it.",
    cli: ["sessions"],
    sets: "-",
    docs: "m0-loop.md#A prover",
    tested: "resume-run.test.ts",
    status: "stable",
    ui: "advanced",
  },
  limits: {
    group: "session",
    type: "{ steps: integer >= 1, turns: integer >= 1, contextTokens: integer >= 1000 }",
    default: "{ steps: 40, contextTokens: 120000 }",
    summary: "What ends a session: the number of model responses (steps), and the prompt size past which the context degrades.",
    cli: ["steps", "turns", "context-tokens"],
    sets: "-",
    docs: "m0-loop.md#Commands",
    tested: "hot-loop.test.ts",
    status: "stable",
    ui: "advanced",
    fields: ["steps (integer >= 1, 40): model responses in one session; flag --steps", "turns (integer >= 1): the old name of steps, the one the journal records; flag --turns; both given and different: refused", "contextTokens (integer >= 1000, 120000): prompt size that ends the session; flag --context-tokens"],
  },
  notesChars: {
    group: "session",
    type: "integer >= 100",
    default: "4000",
    summary: "The length limit of a prover's notes; with `stateCard`, at most `CARD_NOTES_CHARS` of it.",
    cli: ["notes-chars"],
    sets: "-",
    docs: "m0-loop.md#A prover",
    tested: "resume-parts.test.ts",
    status: "stable",
    ui: "advanced",
  },
  budget: {
    group: "budget",
    type: "{ problemUsd: number > 0, runUsd?: number > 0 }",
    default: "{ problemUsd: 5 }",
    summary: "Dollars a problem may spend, and, if given, the whole run: a ledger stops what would go past it.",
    cli: ["budget-usd", "run-budget-usd", "max-usd"],
    sets: "solve: both fields are --max-usd (default 2)",
    docs: "m0-loop.md#Budgets",
    tested: "budget-gate.test.ts",
    status: "stable",
    ui: "basic",
    fields: ["problemUsd (number > 0, 5): per problem; flag --budget-usd (solve: --max-usd)", "runUsd (number > 0, absent): the whole run; flag --run-budget-usd (solve: --max-usd)"],
  },
  concurrency: {
    group: "scheduling",
    type: "integer >= 1",
    default: "1",
    summary: "Problems worked on at the same time (1 when the problems are a sequence).",
    cli: ["concurrency"],
    sets: "-",
    docs: "m0-loop.md#A run",
    tested: "rounds.test.ts",
    status: "stable",
    ui: "advanced",
  },
  tools: {
    group: "tools",
    type: "string[] (capability ids, no repeats)",
    default: "[]",
    summary: "`direct` capabilities given to the provers besides `lean_check`, such as `compute.sage`; one that cannot be reached stops the run.",
    cli: ["tool", "no-tool"],
    sets: "v2: adds lean.lsp when the host offers it (and lists it in optionalTools)",
    docs: "m0-loop.md#Other tools",
    tested: "tools.test.ts",
    status: "stable",
    ui: "basic",
  },
  optionalTools: {
    group: "tools",
    type: "string[] (a subset of tools)",
    default: "absent",
    summary: "The tools the defaults set added and the person did not name: one that cannot be reached at the start is dropped with a warning instead of failing the run.",
    cli: [],
    sets: "v2: [lean.lsp] when the person did not name it",
    docs: "lean-lsp.md#The pinned version",
    tested: "lean-lsp.test.ts",
    status: "internal",
    ui: "hidden",
  },
  autoTool: {
    group: "tools",
    type: "string (a capability id)",
    default: "absent",
    summary: "A compute capability (compute.sage) the sessions get besides `tools` when the router files the statement as finite, about a graph or about numbers.",
    cli: ["auto-tool", "no-auto-tool"],
    sets: "v2: compute.sage, when the host offers it (solve switch)",
    docs: "literature.md#Solve options",
    tested: "solve-v2.test.ts",
    status: "stable",
    ui: "advanced",
  },
  firstCases: {
    group: "informal",
    type: "boolean",
    default: "absent (off)",
    summary: "With a compute tool, the harness computes the first cases of a statement with one natural-number parameter, looks the sequence up when allowed, and shows the table in the first briefing as computed data.",
    cli: [],
    sets: "v2: true",
    docs: "induction.md#The first cases the harness pushes",
    tested: "first-cases.test.ts",
    status: "stable",
    ui: "advanced",
  },
  informalFirst: {
    group: "informal",
    type: "{ passes?: integer >= 1, rounds?: integer >= 1 }",
    default: "absent (off)",
    summary: "An informal proof first: a generator and a fresh-context verifier until `passes` verdicts `correct` in a row or `rounds` calls; an accepted proof is a hint, never a status.",
    cli: [],
    sets: "neither (the arm solve-v2-informal of solve-defaults sets {})",
    docs: "informal.md#The informal proof first (plan changes PA13, NL2, AL1, AL2, AL3)",
    tested: "informal.test.ts",
    status: "experimental",
    ui: "advanced",
    fields: ["passes (integer >= 1, 3): `correct` verdicts in a row that accept a proof", "rounds (integer >= 1, 4): the most generate-or-revise calls"],
  },
  triage: {
    group: "informal",
    type: "boolean",
    default: "absent (off)",
    summary: "After the informal loop, a formal-cost triage (no model call, no Lean) classes the problem invest, short or skip, and the budget gate reads it where the probe made no Lean progress.",
    cli: [],
    sets: "neither (the arm solve-v2-informal-triage of solve-defaults sets true)",
    docs: "scheduler.md#The budget gate",
    tested: "triage.test.ts",
    status: "experimental",
    ui: "advanced",
  },
  longProof: {
    group: "informal",
    type: "{ triageUsd?: number, dryChecks?: integer >= 1, draft?: boolean, drafts?: integer >= 1, freeze?: boolean }",
    default: "absent (off)",
    summary: "Long proofs, with `triage`: an accepted informal proof over the short limits (at least half its facts found) is triaged `long` when the allowance is at least `triageUsd`, and the budget gate follows the frontier's growth for it: its sessions go on while holes close, and it stops after `dryChecks` finished sessions in a row that closed none. With line M12's `blueprints` and an accepted informal proof, the first blueprint is a `have` sketch the planner writes from it and the harness lifts into holes (`draft`); `drafts` of them are asked for and the one with the fewest holes is kept. A hole that is proved, or an `aux_` lemma of the outer file that a check accepted, moves into a locked prefix of the problem's file, shown to the models by statement only (`freeze`).",
    cli: [],
    sets: "M12's options fromInformal, drafts and freeze (a value the person gave stays)",
    docs: "scheduler.md#Long proofs: the `have` sketch and its lifter (plan changes LP2, DP1 to DP3)",
    tested: "long-proof.test.ts",
    status: "experimental",
    ui: "advanced",
    fields: ["triageUsd (number > 0, 1): the least allowance at which a proof over the short limits is `long`, not `skip`", "dryChecks (integer >= 1, 3): finished sessions in a row without a closed hole that stop a `long` problem", "draft (boolean, true): the first blueprint is drafted from the accepted informal proof (needs M12 blueprints)", "drafts (integer >= 1, 1): the drafts asked for; the one with the fewest holes after the lift is kept", "freeze (boolean, true): proved holes and accepted aux_ lemmas move into a locked prefix shown by statement only (needs M12 blueprints)"],
  },
  cards: {
    group: "heuristics",
    type: "{ max?: integer 1..MAX_CARDS }",
    default: "absent (off)",
    summary: "Once per problem, up to `max` heuristic cards whose conditions hold on the statement are put in the first prover's first briefing (no model call).",
    cli: [],
    sets: "neither (the arm solve-v2-cards of solve-defaults sets {})",
    docs: "heuristics.md#Cards in solve",
    tested: "solve-cards.test.ts",
    status: "experimental",
    ui: "advanced",
    fields: ["max (integer 1..MAX_CARDS, 1): the most cards shown to the first session of a problem"],
  },
  sorryBattery: {
    group: "tools",
    type: "{ maxSorries?: integer >= 1, timeoutSec?: number >= 1 }",
    default: "absent (off)",
    summary: "After a check whose file has no error and still has `sorry`, the harness, with no model call, tries line M10's tactics on each `sorry`, puts what Lean accepts into the session's file and says so in the check's answer; no claim's status changes.",
    cli: [],
    sets: "neither (the arm solve-v2-cpu of solve-defaults sets {})",
    docs: "classical.md#The battery on a session's sorry",
    tested: "sorry-battery.test.ts",
    status: "experimental",
    ui: "advanced",
    fields: ["maxSorries (integer >= 1, 8): the most `sorry` tried after a check, in file order", "timeoutSec (number >= 1, the longest limit of a tactic): the seconds each Lean check of the battery may take"],
  },
  cacheRetention: {
    group: "model",
    type: "none | short | long",
    default: "absent (the provider's own default)",
    summary: "The prompt cache retention asked of the provider with every request of a session.",
    cli: ["cache-retention"],
    sets: "-",
    docs: "m0-loop.md#Prices",
    tested: "packet.test.ts",
    status: "stable",
    ui: "advanced",
  },
  packetMode: {
    group: "session",
    type: "prefix_tail | append_only | recompiled",
    default: "absent (prefix_tail)",
    summary: "How a session's requests are built from a line's context packet: a frozen prefix and a tail, the packet once then the history, or the whole packet again (the measurement arm).",
    cli: ["packet-mode"],
    sets: "-",
    docs: "lines.md#Packet modes",
    tested: "packet-mode.test.ts",
    status: "experimental",
    ui: "hidden",
  },
  checkTimeoutSec: {
    group: "session",
    type: "number >= 1 (seconds)",
    default: "absent (the validator's policy, 300 s)",
    summary: "The seconds a prover's Lean check may take; the validator and the certifier keep their own limits.",
    cli: [],
    sets: "v2: the host profile's checkTimeoutSec (120 when it gives none)",
    docs: "lean.md#Bounded checks",
    tested: "hot-loop.test.ts",
    status: "stable",
    ui: "advanced",
  },
  defaults: {
    group: "record",
    type: "string (v1 | v2)",
    default: "absent",
    summary: "The name of the defaults set the configuration was made from, for the record; it changes nothing by itself.",
    cli: ["defaults"],
    sets: "v1 and v2 write their own name",
    docs: "quickstart.md#Defaults sets",
    tested: "solve.test.ts",
    status: "internal",
    ui: "basic",
  },
  editTool: {
    group: "session",
    type: "boolean",
    default: "absent (off)",
    summary: "The sessions get the tool `lean_edit(region, old, new)` and a prompt that says to use `lean_check` for the first draft and `lean_edit` after it.",
    cli: [],
    sets: "v2: true",
    docs: "m0-loop.md#The edit tool",
    tested: "hot-loop.test.ts",
    status: "stable",
    ui: "advanced",
  },
  maskOldChecks: {
    group: "session",
    type: "boolean",
    default: "absent (off)",
    summary: "The model is sent a one-line summary in place of a check result older than the last four, in batches of four; the journal is not touched.",
    cli: [],
    sets: "v2: true",
    docs: "m0-loop.md#Masked old checks",
    tested: "hot-loop.test.ts",
    status: "stable",
    ui: "advanced",
  },
  leanSearch: {
    group: "tools",
    type: "boolean",
    default: "absent (off)",
    summary: "After a check that did not accept the file, the harness searches Lean declarations for each unknown identifier and hole goal and appends the checked hits to the answer.",
    cli: ["lean-search", "no-lean-search"],
    sets: "v2: true when the host offers lean.search (solve switch)",
    docs: "lean.md#Search pushed by the harness",
    tested: "lean-search.test.ts",
    status: "stable",
    ui: "advanced",
  },
  stateCard: {
    group: "session",
    type: "boolean",
    default: "absent (off)",
    summary: "The next session's opening message carries a state card built by code from the journal, and the model's own notes are cut to `CARD_NOTES_CHARS`.",
    cli: [],
    sets: "v2: true",
    docs: "m0-loop.md#The state card",
    tested: "state-card.test.ts",
    status: "stable",
    ui: "advanced",
  },
  consolidation: {
    group: "lines",
    type: "boolean",
    default: "absent (off)",
    summary: "The sessions are shown the newest page \"what was tried and why it stopped\" that `harness consolidate` left in the memory chain, drawn like a lesson and switched off when its measured effect is negative.",
    cli: ["consolidation"],
    sets: "neither (solve passes the flag through)",
    docs: "consolidation.md#The consolidation pass (CA24)",
    tested: "consolidate.test.ts",
    status: "beta",
    ui: "advanced",
  },
  budgetRounds: {
    group: "scheduling",
    type: "boolean",
    default: "absent (off)",
    summary: "With a run budget and several problems, the problems are worked round-robin under a cap that doubles each round, and a problem without Lean progress is parked.",
    cli: [],
    sets: "v2: true (does nothing in solve, which has one problem)",
    docs: "scheduler.md#The budget in rounds",
    tested: "rounds.test.ts",
    status: "stable",
    ui: "advanced",
  },
  budgetShare: {
    group: "scheduling",
    type: "number > 0",
    default: "absent (off)",
    summary: "With a run budget, a problem's ledger is capped when it is opened at min(problemUsd, budgetShare x what remains of the run budget / problems not finished).",
    cli: [],
    sets: "v2: 2",
    docs: "scheduler.md#The budget in rounds",
    tested: "budget-share.test.ts",
    status: "stable",
    ui: "advanced",
  },
  frontier: {
    group: "session",
    type: "{ show?: boolean, weights?: Record<kind, number> }",
    default: "absent (off)",
    summary: "The verified frontier, a projection of the journal with no model call: with `show`, the state card, the turn's account, RESULT.md, report.md and the interface carry what Lean accepted so far (evidence apart, as evidence), and each outer session's opening message ends with one line on the budget left and the frontier.",
    cli: [],
    sets: "neither (settings file)",
    docs: "frontier.md#Where it is shown",
    tested: "frontier-show.test.ts",
    status: "experimental",
    ui: "advanced",
  },
  restarts: {
    group: "session",
    type: "{ schedule?: geometric | luby, base?: integer, stuckChecks?: integer }",
    default: "absent (off)",
    summary: "Cold restarts of a prover's sessions: after its first, a session starts from the original file with the frontier, the dead ends and the state card (and the tool `previous_attempt`), has the step limit of the schedule (base 6: 6, 12, 24, ... or Luby's 6, 6, 12, 6, 6, 12, 24, ...; at most `limits.steps`), and ends early when the same failure class on the same goal repeats in `stuckChecks` (3) consecutive checks.",
    cli: [],
    sets: "neither (settings file)",
    docs: "runs.md#Restarts",
    tested: "restarts.test.ts",
    status: "experimental",
    ui: "advanced",
  },
  consult: {
    group: "model",
    type: "{ model: provider/id, maxCalls?: integer, maxOutputTokens?: integer }",
    default: "absent (off; in no defaults set and no arm)",
    summary: "The tool `consult(question)` for the outer provers: one question to another model, its answer is advice in the prover's context and never a status (beta, Ruling 39).",
    cli: ["consult", "consult-calls", "consult-tokens"],
    sets: "neither (solve passes the flags through)",
    docs: "models-setup.md#Consult: advice from another model (beta)",
    tested: "consult.test.ts",
    status: "beta",
    ui: "advanced",
    fields: ["model (provider/id, required): flag --consult", "maxCalls (integer, 2): calls per prover session; flag --consult-calls", "maxOutputTokens (integer, 1000): the most tokens of an answer; flag --consult-tokens"],
  },
  roles: {
    group: "model",
    type: "{ prover?, planner?, hole?, verifier?, consult?: { model?, settings? }, escalation?: { model, maxShare } }",
    default: "absent (every role has the run's model and settings)",
    summary: "A model, and sampling settings (temperature, topP, thinking), for each place the harness calls a model from; each call is charged at its own model's price.",
    cli: ["role", "role-setting"],
    sets: "neither (solve passes the flags through)",
    docs: "models-setup.md#Roles: a model and settings for each place a model is called (CA15, CA23)",
    tested: "roles.test.ts",
    status: "stable",
    ui: "advanced",
    fields: [
      "prover, planner, hole, verifier, consult (role): { model, settings: { temperature, topP, thinking } }; flags --role ROLE=MODEL, --role-setting ROLE.KEY=VALUE",
      "escalation (role): { model, maxShare }, the planner's next model after two rounds without Lean progress; --role escalation=MODEL, --role-setting escalation.maxShare=X",
    ],
  },
  lines: {
    group: "lines",
    type: "string[] (line ids)",
    default: "absent (M0: no line)",
    summary: "The lines of the plan the run enables, such as M1 (documentation/lines.md).",
    cli: ["lines", "ablation"],
    sets: "v1: M1, M10; v2: M1, M10, M6",
    docs: "lines.md#A line",
    tested: "lines.test.ts",
    status: "stable",
    ui: "basic",
  },
  lineOptions: {
    group: "lines",
    type: "Record<lineId, JsonObject>",
    default: "absent (each line's own defaults)",
    summary: "Options of the enabled lines, by line id; they replace a line's defaults key by key.",
    cli: ["line-option"],
    sets: "v2: M6 { framing, citations, rawErrors, revisions, detectors: false; repeatRule: true }",
    docs: "lines.md#A line",
    tested: "m6.test.ts",
    status: "stable",
    ui: "advanced",
  },
  consortium: {
    group: "human",
    type: "{ limit: { tokens?, usd?, minutes? }, impasse: { posteriorBelow, minAttempts }, narrative: boolean, consolidation?: boolean }",
    default: "absent (an ordinary run)",
    summary: "Consortium mode: turns that end by themselves at a limit or a breakpoint, with an account for the research team.",
    cli: ["turn-tokens", "turn-usd", "turn-minutes", "turn-narrative", "turn-consolidation", "impasse-posterior", "impasse-attempts"],
    sets: "v1 and v2: always on in solve, with a turn limit of --turn-usd (default half the allowance)",
    docs: "human.md#Turns",
    tested: "turns-equivalence.test.ts",
    status: "stable",
    ui: "advanced",
    fields: [
      "limit.tokens (number > 0, absent): --turn-tokens",
      "limit.usd (number > 0, absent): --turn-usd",
      "limit.minutes (number > 0, absent): --turn-minutes",
      "impasse.posteriorBelow (number, 0.1): --impasse-posterior",
      "impasse.minAttempts (integer, 8): --impasse-attempts",
      "narrative (boolean, false): --turn-narrative",
      "consolidation (boolean, absent): --turn-consolidation",
    ],
  },
  horizon: {
    group: "human",
    type: "episode | campaign",
    default: "absent (episode)",
    summary: "How long the run is bound (plan change LH9): `episode`, a bounded number of sessions; or `campaign` (`harness campaign`): a prover's sessions are not capped and money, time and the claim bound the run. A campaign works in turns, so it needs `human` `digest` or `consortium`.",
    cli: ["horizon"],
    sets: "v1 and v2: episode (not set, derived)",
    docs: "runs.md#The two axes",
    tested: "run-shape.test.ts",
    status: "stable",
    ui: "advanced",
  },
  human: {
    group: "human",
    type: "none | consortium | digest",
    default: "absent (consortium when the run has consortium turns, none otherwise)",
    summary: "Whether the run stops for a person (plan change LH9): `none`, `consortium` (turns that wait; needs `consortium`; `--human` alone gives it) or `digest` (turns that do not wait, a campaign's: needs `consortium` turns and `horizon` `campaign`); `ablate` is always `none`.",
    cli: ["human"],
    sets: "v1 and v2: consortium (not set, derived)",
    docs: "runs.md#The two axes",
    tested: "run-shape.test.ts",
    status: "stable",
    ui: "advanced",
  },
  campaign: {
    group: "human",
    type: "{ usdPerDay?: number > 0, until?: ISO time, spiralTurns?: integer >= 1, dossierTokens?: integer >= 1, deadEnds?: integer >= 1, reflect?: boolean, plateauUsd?: number > 0 }",
    default: "absent (no daily cap, no end time, the guard at 8 turns)",
    summary: "The pacing and the guard of a campaign (`harness campaign`): the dollars a UTC day may spend (a turn ends when the day's spend reaches it, the next waits for the next day), the wall-clock end, and the number of turns in a row that spend without the frontier growing that end it as `spiral`. Goes with `horizon` `campaign`.",
    cli: ["usd-per-day", "until", "spiral-turns"],
    sets: "neither (`harness campaign` sets it from its flags)",
    docs: "campaign.md#The dossier",
    tested: "campaign.test.ts",
    status: "experimental",
    ui: "advanced",
    fields: [
      "usdPerDay (number, absent): the most a UTC day may spend",
      "until (ISO time, absent): the campaign stops at it",
      "spiralTurns (integer, 8): turns in a row that spent and did not grow the frontier",
      "dossierTokens (integer, 750): the dossier's bound in tokens, the state card's bound",
      "deadEnds (integer, 12): dead-end items in view before the least active half of the rest is retired",
      "reflect (boolean, false): one reflection call a turn, $0.25 in all for the run, proposes dead-end items (site `campaign.reflect`)",
      "plateauUsd (number, 10% of the allowance): spend without frontier growth that changes the plateau mode",
    ],
  },
  offpeak: {
    group: "human",
    type: "{ maxWaitMinutes?: number > 0 }",
    default: "absent (no waiting)",
    summary: "A turn or a session starts only when the host's pricing calendar for the run's model says off-peak, and otherwise waits (`turn.deferred`).",
    cli: ["offpeak", "offpeak-max-wait", "off-peak", "no-off-peak"],
    sets: "neither (solve passes the flags through)",
    docs: "human.md#Off-peak",
    tested: "offpeak.test.ts",
    status: "stable",
    ui: "basic",
    fields: ["maxWaitMinutes (number > 0, absent): the longest wait, after which the work runs anyway; flag --offpeak-max-wait"],
  },
  seed: {
    group: "record",
    type: "string | number",
    default: "absent (the run's id, so each run draws differently)",
    summary: "Seeds the draws of unverified memory items (randomized inclusion); the same seed draws the same.",
    cli: ["draw-seed"],
    sets: "-",
    docs: "memory.md#Randomized inclusion",
    tested: "draw.test.ts",
    status: "stable",
    ui: "advanced",
  },
  decide: {
    group: "scheduling",
    type: "{ backend?: llm | jev, sites?: Record<site, llm | jev | off>, votes?: integer 1..9 }",
    default: "absent (the run's model decides everywhere)",
    summary: "Who makes the typed decisions that order work: the run's model, or a third-party backend (Jev), per site, with one to nine votes.",
    cli: ["decide-backend", "decide-site", "decide-votes"],
    sets: "-",
    docs: "decide.md#Backends and configuration",
    tested: "decide.test.ts",
    status: "experimental",
    ui: "advanced",
    fields: ["backend (llm | jev, llm): --decide-backend", "sites (Record<site, llm | jev | off>, {}): --decide-site SITE=BACKEND", "votes (integer 1..9, 1): --decide-votes"],
  },
  gate: {
    group: "scheduling",
    type: "{ share?, floor?, probeFraction?, margin?, minSessions?, probeExtend? }",
    default: "absent (no gate: the provers start together)",
    summary: "The budget gate: a deterministic rule before every paid launch, a probe-first start that widens only after Lean progress, and a run on `--memory-from` that relaunches nothing already certified.",
    cli: ["gate", "gate-floor", "gate-probe", "gate-margin", "gate-min-sessions", "gate-share"],
    sets: "v1: {}; v2: { probeExtend: true } (solve always has the gate on)",
    docs: "scheduler.md#The budget gate",
    tested: "budget-gate.test.ts",
    status: "stable",
    ui: "advanced",
    fields: [
      "share (Partial<Record<wave|session|task|judge, number in (0,1]>>, wave 0.5, session 0.5, task 0.25, judge 0.1): --gate-share SITE=X",
      "floor (number, 0.1): fraction of skips let through; --gate-floor",
      "probeFraction (number, 0.1): the probe's share of the problem budget; --gate-probe",
      "margin (number, 0.1): the tie margin where decide is asked; --gate-margin",
      "minSessions (integer >= 1, 2): sessions a prover runs before the gate can end it; --gate-min-sessions",
      "probeExtend (boolean, false): one extension for a probe its cap cut; no flag",
    ],
  },
  prompts: {
    group: "record",
    type: "{ proverSystem?: string }",
    default: "absent (the merged prompt)",
    summary: "A candidate prover system prompt to measure instead of the merged one; it passes the strict screen, is recorded in `run.started`, and stamps what the run learns.",
    cli: [],
    sets: "-",
    docs: "prompts.md#Measuring a candidate: `RunConfig.prompts`",
    tested: "prompt-screen.test.ts",
    status: "internal",
    ui: "hidden",
    fields: ["proverSystem (string, absent): the prompt text with its placeholders; set by `harness optimize-prompts` for each candidate"],
  },
  intake: {
    group: "third-parties",
    type: "{ literature?, hygiene?, capUsd?, capShare?, consent?: { allowed, via } }",
    default: "absent (no intake)",
    summary: "Before any paid session: tests of the statement (vacuity, plausible, the first cases) and, with consent, a literature search and one judge call under a cap.",
    cli: ["intake", "intake-usd", "lit", "no-intake"],
    sets: "v2: hygiene on; the literature only with the person's yes (solve switch)",
    docs: "literature.md#Solve options",
    tested: "intake.test.ts",
    status: "stable",
    ui: "basic",
    fields: [
      "literature (boolean, absent): search the literature; --intake (run), --lit (solve)",
      "hygiene (boolean, absent): test the statement; --intake",
      "capUsd (number in (0,1], 0.05): the judge call's cap; --intake-usd",
      "capShare (number, absent): the cap as a share of the problem budget (solve gives 0.05)",
      "consent ({ allowed, via }, absent: no): may the statement go to third parties; via bench | asked | flag",
    ],
  },
  private: {
    group: "third-parties",
    type: "boolean",
    default: "absent (no restriction)",
    summary: "Nothing of the problem is sent outside the machine and the model provider: the literature is skipped, lean.search keeps to local backends, third-party decisions and capabilities are refused.",
    cli: ["private"],
    sets: "neither (solve passes the flag through)",
    docs: "capabilities.md#Third parties",
    tested: "third-party.test.ts",
    status: "stable",
    ui: "basic",
  },
};

/** The command of a flag: its own name, or `lit probe`, `library ...` and so on as the usage line writes it. */
export type FlagMaps =
  | { kind: "RunConfig"; to: string }
  | { kind: "host"; to: string }
  | { kind: "command"; to: string };

export interface CliFlag {
  /** The flag without its dashes, as the parser's table spells it (`CLI_OPTIONS`). */
  flag: string;
  /** The commands that read it. */
  commands: readonly string[];
  /** What it sets: a `RunConfig` key (dotted for a sub-field), a host profile, or the command's own option. */
  maps: FlagMaps;
  /** The help text, from the usage. */
  help: string;
}

const RUN_LIKE = ["run", "ablate", "optimize-prompts", "probe"] as const;
const rc = (to: string): FlagMaps => ({ kind: "RunConfig", to });
const cmd = (to: string): FlagMaps => ({ kind: "command", to });
const flag = (name: string, commands: readonly string[], maps: FlagMaps, help: string): CliFlag => ({ flag: name, commands, maps, help });

/** Every flag of the `harness` command line (the keys of `CLI_OPTIONS`), with the commands that read it. One parser serves every command, so a flag a command does not read is accepted and ignored there (only `resume` refuses the flags that describe a run). */
export const CLI_FLAGS: readonly CliFlag[] = [
  flag("host", ["capabilities", "health", "lit probe", "contract", "run", "ablate", "optimize-prompts", "probe", "resume", "solve", "campaign", "doctor", "consolidate"], { kind: "host", to: "config/hosts/HOST.json" }, "The host profile; default HARNESS_HOST, then local (solve and doctor use the sandboxed profile doctor wrote, when it exists)."),
  flag("implementation", ["contract"], cmd("the implementation to test"), "Test one implementation of the capability."),
  flag("case", ["contract"], cmd("the contract cases to run"), "Run only the named case (repeatable)."),
  flag("out", ["contract", "lit probe", "run", "ablate", "optimize-prompts", "probe", "solve", "campaign", "consolidate", "heuristics", "library", "view"], cmd("an output file or directory"), "Where the command writes: a directory for a run, ablation or proposals, a file for a contract report, a view or the mined cards."),
  flag("reference", ["audit"], cmd("a directory of reference dossiers"), "Show DIR/PROBLEM.md beside each dossier, and measure the Lean length of DIR/PROBLEM.lean (or the Lean blocks of PROBLEM.md) for the length table."),
  flag("query", ["lit probe"], cmd("the query words"), "The words searched."),
  flag("limit", ["lit probe"], cmd("hits per site"), "How many hits to ask for."),
  flag("no-cache", ["lit probe"], cmd("skip the response cache"), "Do not read or write the cache."),
  flag("include-computed", ["library"], cmd("export option"), "library export: include `computed` lemmas."),
  flag("config", ["library"], cmd("the library builder's config file"), "library build: the builder's configuration (default config/library-builder.json)."),
  flag("adopt", ["library"], cmd("a checkout to land an accepted build in"), "library build: land the accepted build's files in this checkout."),
  flag("approve", ["library"], cmd("the person who approves an adoption"), "library build --adopt: the approving person's name."),
  flag("registry", ["library"], cmd("the registry directory of definitions"), "library definitions, review, deprecate, build: the registry (default library/registry)."),
  flag("library-registry", ["run"], cmd("RunOptions.libraryRegistry"), "Start the run with the definitions of this registry (default library/registry when it exists)."),
  flag("runs", ["library", "ui"], cmd("the directory of runs"), "library build --adopt: refuse while a run under this directory is being written; ui: where runs are listed and written (default runs)."),
  flag("reason", ["library"], cmd("the reason of a deprecation"), "library deprecate: why the definition is dropped."),
  flag("bench", ["run", "ablate", "optimize-prompts", "probe", "resume"], cmd("the bench index file"), "The bench index (default bench/fc-bench-v1-discrete.json), or a graded bench with --grade."),
  flag("grade", ["run", "ablate", "optimize-prompts", "probe"], cmd("the grade of a graded bench"), "A, B or C: which grade of --bench FILE."),
  flag("allow-unchecked", ["run", "ablate", "optimize-prompts", "probe"], cmd("admit entries no Lean admitted"), "With a graded bench: allow entries that no Lean admitted."),
  flag("checkout", ["run", "ablate", "optimize-prompts", "probe", "resume"], cmd("the bench repository's checkout"), "A checkout of the bench's repository."),
  flag("sample", ["run", "ablate", "optimize-prompts"], rc("selection"), "Choose N problems at random."),
  flag("seed", ["run", "ablate", "optimize-prompts"], rc("selection"), "The seed of --sample (default m0); not the seed of the memory draws (that is --draw-seed)."),
  flag("problem", ["run", "ablate", "optimize-prompts"], rc("selection"), "Choose a problem by id (repeatable)."),
  flag("all", ["run", "ablate", "optimize-prompts"], rc("selection"), "Every problem of the bench."),
  flag("sequence", ["run", "ablate"], rc("selection"), "A sequence of the bench, worked in order with --concurrency 1."),
  flag("tag", ["run", "ablate"], rc("selection"), "The problems tagged analogy or induction."),
  flag("model", ["run", "ablate", "optimize-prompts", "probe", "solve", "campaign", "doctor", "consolidate"], rc("model"), "PROVIDER/ID; default SESHAT_MODEL (not for a resume); without either, solve and doctor take the host profile's recommended model if the person set one, else the cheapest capable priced one (ambient-credential providers skipped)."),
  flag("thinking", RUN_LIKE, rc("thinkingLevel"), "off, minimal, low, medium (default), high, xhigh or max."),
  flag("provers", RUN_LIKE, rc("provers"), "Provers per problem (default 4)."),
  flag("sessions", RUN_LIKE, rc("sessions"), "Sessions per prover (default 8)."),
  flag("steps", RUN_LIKE, rc("limits.steps"), "Model responses per session (default 40); a step is one model response, not the turn of --turn-usd."),
  flag("turns", RUN_LIKE, rc("limits.turns"), "The old name of --steps (same limit; give one, or the same number)."),
  flag("context-tokens", RUN_LIKE, rc("limits.contextTokens"), "Prompt size that ends a session (default 120000)."),
  flag("notes-chars", RUN_LIKE, rc("notesChars"), "The length limit of the notes (default 4000)."),
  flag("cache-retention", RUN_LIKE, rc("cacheRetention"), "none, short or long: the prompt cache retention asked of the provider."),
  flag("packet-mode", RUN_LIKE, rc("packetMode"), "prefix_tail (default), append_only or recompiled."),
  flag("budget-usd", [...RUN_LIKE, "chunks"], rc("budget.problemUsd"), "Dollars per problem (default 5); chunks: the budget of the curves."),
  flag("run-budget-usd", RUN_LIKE, rc("budget.runUsd"), "Dollars for the whole run."),
  flag("concurrency", RUN_LIKE, rc("concurrency"), "Problems at the same time (default 1)."),
  flag("tool", [...RUN_LIKE, "solve", "campaign"], rc("tools"), "A direct capability for the provers besides lean_check (repeatable), such as compute.sage."),
  flag("no-tool", ["solve", "campaign"], rc("tools"), "Drop a tool the defaults set gives (today only lean.lsp)."),
  flag("lines", [...RUN_LIKE, "solve", "campaign"], rc("lines"), "The lines to enable, comma-separated (repeatable); ablate --experiment: the lines of the arms."),
  flag("ablation", ["run"], rc("lines"), "The cumulative configuration that ends with line NAME (M0: none); not with --lines."),
  flag("configs", ["ablate"], cmd("which cumulative configurations to run"), "M0,M1,...: run only these."),
  flag("experiment", ["ablate"], cmd("the experiment to run"), "An experiment of documentation/ablate.md (ladder, packet-mode, solve-defaults, m17, ...)."),
  flag("arms", ["ablate"], cmd("which arms of the experiment to run"), "NAME,...: run only these arms, in the experiment's order."),
  flag("models", ["ablate"], cmd("the models of an experiment's arms"), "A,B: the models an experiment compares."),
  flag("split", ["ablate", "optimize-prompts"], cmd("a memory split (ablate: N problems) or the split of a candidate (optimize-prompts: dev)"), "ablate: build each configuration's memory on N problems and measure on the others; optimize-prompts: the split to rewrite on."),
  flag("split-by", ["ablate"], cmd("how --split cuts"), "none, file or stem."),
  flag("cutoff", ["optimize-prompts"], cmd("the temporal holdout's date"), "Problems newer than DATE are the temporal holdout."),
  flag("dates", ["optimize-prompts"], cmd("problem id to ISO date file"), "Else the first commit of each problem's file in the checkout."),
  flag("target", ["ablate", "optimize-prompts"], cmd("ablate: the target ratio; optimize-prompts: the prompt to rewrite"), "ablate: the ratio the baseline must reach; optimize-prompts: prover.system."),
  flag("reflector-model", ["optimize-prompts"], cmd("the model that rewrites the prompt"), "PROVIDER/ID of the reflector."),
  flag("iterations", ["optimize-prompts"], cmd("search iterations"), "Whole number of at least 1."),
  flag("minibatch", ["optimize-prompts"], cmd("problems per reflection"), "Whole number of at least 1."),
  flag("finalists", ["optimize-prompts"], cmd("candidates measured at the end"), "Whole number of at least 1."),
  flag("reflect-budget-usd", ["optimize-prompts"], cmd("the reflector's cap"), "Dollars the rewriting may spend."),
  flag("alpha", ["optimize-prompts"], cmd("the significance level"), "The level of the comparison with the merged prompt."),
  flag("max-usd", ["solve", "campaign", "consolidate", "optimize-prompts"], rc("budget"), "solve: the allowance, the run's whole budget (default 2); optimize-prompts: the cap on everything it spends (required); consolidate: the pages' cap."),
  flag("yes", ["solve", "campaign"], cmd("sign without asking"), "Sign the statement without asking; the signature is journaled before any spend."),
  flag("ask-stdin", ["solve", "campaign"], cmd("the protocol of a program that drives solve"), "The signature is one line, the answer one line on standard input (needs SESHAT_ASK_NONCE)."),
  flag("intake", ["run", "solve", "campaign"], rc("intake"), "Test the statement before any paid session; for run, search the literature for each bench problem."),
  flag("lit", ["solve", "campaign"], rc("intake.consent"), "Agree to the literature search in a call that cannot ask (also turns --intake on)."),
  flag("private", ["run", "ablate", "solve", "campaign"], rc("private"), "Send nothing to a third party."),
  flag("intake-usd", ["run", "solve", "campaign"], rc("intake.capUsd"), "The judge call's cap (default 0.05)."),
  flag("auto-tool", ["solve", "campaign"], rc("autoTool"), "Add the host's compute tool when the statement is finite, about a graph or about numbers."),
  flag("no-intake", ["solve", "campaign"], rc("intake"), "Turn the intake of the defaults set off (matters with v2)."),
  flag("no-auto-tool", ["solve", "campaign"], rc("autoTool"), "Turn the compute tool of the defaults set off (matters with v2)."),
  flag("no-lean-search", ["solve", "campaign"], rc("leanSearch"), "Turn lean.search of the defaults set off (matters with v2)."),
  flag("port", ["ui"], cmd("the port of the local interface"), "Default: a free port."),
  flag("quiet", ["run", "resume", "solve", "campaign"], cmd("print progress"), "No progress line while the run works (one line on standard error each time a session ends or a problem moves)."),
  flag("open", ["ui"], cmd("open the page"), "Open the interface in the browser (the default at a terminal with a display)."),
  flag("no-open", ["ui"], cmd("open the page"), "Do not open the interface in the browser; only print its address."),
  flag("lean", ["solve", "campaign"], cmd("the statement is Lean"), "Do not guess: the statement is Lean (not with --prose)."),
  flag("prose", ["solve", "campaign"], cmd("the statement is prose"), "Do not guess: the statement is prose, to be formalized (not with --lean)."),
  flag("no-check", ["solve", "campaign"], cmd("skip the check of the statement"), "Do not check the statement with Lean before the signature."),
  flag("sketch", ["solve", "campaign"], cmd("RunOptions.sketch"), "A text file (at most 20000 characters) with your own proof or hint, journaled as a hint under your name."),
  flag("lean-search", ["run", "solve", "campaign"], rc("leanSearch"), "Search Lean declarations after a check that did not accept the file."),
  flag("consult", ["run", "solve", "campaign"], rc("consult.model"), "Beta: give the outer prover the tool consult(question), answered by this model."),
  flag("role", ["run", "solve", "campaign"], rc("roles"), "ROLE=PROVIDER/ID (repeatable): a model for a place the harness calls a model from."),
  flag("role-setting", ["run", "solve", "campaign"], rc("roles"), "ROLE.KEY=VALUE (repeatable): temperature, topP, thinking; escalation.maxShare."),
  flag("consult-calls", ["run", "solve", "campaign"], rc("consult.maxCalls"), "Calls per session (default 2); goes with --consult."),
  flag("consult-tokens", ["run", "solve", "campaign"], rc("consult.maxOutputTokens"), "Tokens per answer (default 1000); goes with --consult."),
  flag("consolidation", ["run", "solve", "campaign"], rc("consolidation"), "Show the sessions the consolidation page of the memory chain."),
  flag("defaults", ["solve", "campaign"], rc("defaults"), "v1 or v2 (the default): the set of defaults."),
  flag("settings", ["run", "solve", "campaign"], cmd("a settings file of RunConfig keys"), "A JSON file whose keys are RunConfig keys (documentation/parameters.md, \"Settings file\"): after the defaults set, before the flags, which win."),
  flag("no-write", ["doctor"], cmd("do not write the sandboxed profile"), "Only check."),
  flag("rewrite", ["doctor"], cmd("overwrite the sandboxed profile"), "Write config/hosts/sandboxed.json over an existing file."),
  flag("allow-unpriced", ["optimize-prompts"], cmd("admit models with no price"), "Let the optimization use a model no dollar cap can see."),
  flag("min-gate-problems", ["optimize-prompts"], cmd("problems a gate needs"), "Whole number of at least 1."),
  flag("ledger", ["optimize-prompts"], cmd("a ledger file of measurements"), "Reuse and extend this file."),
  flag("reuse-gates", ["optimize-prompts"], cmd("reuse the gates' results"), "Do not measure the gates again."),
  flag("pilot", ["ablate"], cmd("a finished run's outcomes"), "The difficulty tiers of an ablation come from this run."),
  flag("baseline", ["ablate"], cmd("the baseline arm"), "The arm the others are compared with."),
  flag("chunk-k", ["chunks"], cmd("the chunk sizes of the curves"), "1,3,6,10: whole numbers of at least 1."),
  flag("probe-every", ["run"], cmd("probe the memory every K-th run of a chain"), "A whole number of at least 1."),
  flag("probe-size", ["probe", "run"], cmd("problems in the probe set"), "Default 20."),
  flag("probe-set", ["probe", "run"], cmd("a fixed probe set file"), "Problem ids, one per line."),
  flag("line-option", ["run"], rc("lineOptions"), "ID.KEY=VALUE (repeatable): an option of an enabled line, VALUE read as JSON when it parses."),
  flag("draw-seed", RUN_LIKE, rc("seed"), "Seed the draws of unverified memory items; the same seed draws the same."),
  flag("decide-backend", RUN_LIKE, rc("decide.backend"), "llm (default) or jev: who decides where no site is named."),
  flag("decide-site", RUN_LIKE, rc("decide.sites"), "SITE=llm|jev|off (repeatable)."),
  flag("decide-votes", RUN_LIKE, rc("decide.votes"), "Independent calls of the run's model per decision (1 to 9)."),
  flag("gate", RUN_LIKE, rc("gate"), "Turn on the budget gate."),
  flag("gate-floor", RUN_LIKE, rc("gate.floor"), "The fraction of skips let through (default 0.1); goes with --gate."),
  flag("gate-probe", RUN_LIKE, rc("gate.probeFraction"), "The probe's share of the problem budget (default 0.1); goes with --gate."),
  flag("gate-margin", RUN_LIKE, rc("gate.margin"), "The tie margin where decide is asked (default 0.1); goes with --gate."),
  flag("gate-min-sessions", RUN_LIKE, rc("gate.minSessions"), "Sessions a prover runs before the gate can end it (default 2); goes with --gate."),
  flag("gate-share", RUN_LIKE, rc("gate.share"), "SITE=X (repeatable): the share of what is left a launch at wave, session, task or judge may cost."),
  flag("memory-from", ["run"], cmd("RunOptions.memoryFrom"), "Start on the memory of an earlier run, pinned by its last hash and never written."),
  flag("resume", ["run", "campaign"], cmd("continue a run"), "run --resume DIR is resume DIR: no flag that describes a run may be given with it."),
  flag("human", ["run", "solve", "campaign"], rc("human"), "none, consortium or digest (digest goes with --horizon campaign). A bare --human is --human consortium: stop at a breakpoint and wait for the team; solve is always consortium."),
  flag("horizon", ["run", "solve", "campaign"], rc("horizon"), "episode or campaign: how long the run is bound (harness campaign is a campaign with a supervisor)."),
  flag("usd-per-day", ["campaign"], rc("campaign.usdPerDay"), "The most dollars a UTC day may spend: a turn ends when the day's spend reaches it, and the next one waits for the next day."),
  flag("until", ["campaign"], rc("campaign.until"), "An ISO time (2026-12-01T00:00:00Z): the campaign stops at it."),
  flag("spiral-turns", ["campaign"], rc("campaign.spiralTurns"), "Turns in a row that spend without the frontier growing end the campaign (default 8)."),
  flag("off-peak", ["campaign"], rc("offpeak"), "Start turns and sessions only at the model's off-peak rate (the default of a campaign; the host profile needs a pricing calendar)."),
  flag("no-off-peak", ["campaign"], rc("offpeak"), "A campaign that does not wait for the off-peak window."),
  flag("watch", ["campaign"], cmd("watch a campaign's run directory"), "campaign --watch RUN_DIR: restart the supervisor, with a backoff, when its heartbeat is older than a bound."),
  flag("turn-tokens", ["run", "resume", "steer"], rc("consortium.limit.tokens"), "End a turn after N tokens over every prover and line."),
  flag("turn-usd", ["run", "resume", "steer", "solve", "campaign"], rc("consortium.limit.usd"), "End a turn after X dollars (solve: default half the allowance)."),
  flag("turn-minutes", ["run", "resume", "steer"], rc("consortium.limit.minutes"), "End a turn after N minutes."),
  flag("turn-narrative", ["run", "resume"], rc("consortium.narrative"), "A model writes a short narrative of the turn ($0.25 of its own)."),
  flag("turn-consolidation", ["run"], rc("consortium.consolidation"), "The turn's report gets the model-free consolidation part."),
  flag("offpeak", ["run", "solve", "campaign"], rc("offpeak"), "Start a turn or a session only at the off-peak rate."),
  flag("offpeak-max-wait", ["run", "solve", "campaign"], rc("offpeak.maxWaitMinutes"), "The longest wait in minutes; goes with --offpeak."),
  flag("impasse-posterior", ["run"], rc("consortium.impasse.posteriorBelow"), "The posterior mean at or below which a problem is at an impasse (default 0.1)."),
  flag("impasse-attempts", ["run"], rc("consortium.impasse.minAttempts"), "Finished attempts before an impasse can be declared (default 8)."),
  flag("claim", ["hint", "steer", "frontier"], cmd("the claim a hint, a steer or a frontier is about"), "hint: the claim the hint is about (required); steer --forbid: the claim it applies to; frontier: only this claim's frontier."),
  flag("as", ["hint", "sign", "steer", "solve", "campaign", "library", "lessons"], cmd("the person's name"), "The name the answer or signature is recorded under."),
  flag("note", ["sign", "library", "lessons"], cmd("a note"), "A note recorded with the answer."),
  flag("focus", ["steer"], cmd("a claim to focus on"), "Focus the next turn on this claim."),
  flag("drop", ["steer"], cmd("a claim to drop"), "Drop this claim."),
  flag("forbid", ["steer"], cmd("a strategy to forbid"), "Forbid this strategy (with --claim, for that claim only)."),
  flag("json", ["report", "frontier"], cmd("print JSON"), "The report, or the frontier, as JSON."),
  flag("find", ["lean-env"], cmd("resolve option"), "lean-env resolve: look the environment up."),
  flag("env-dir", ["lean-env"], cmd("the environments directory"), "Default SESHAT_LEAN_ENV_DIR or lean/env."),
  flag("allow-programs", ["add"], cmd("admit a pack whose tools start programs or reach servers"), "Needed for such a pack."),
  flag("level1", ["add"], cmd("honour a pack's own level-1 request"), "From the next session."),
  flag("replace", ["add"], cmd("replace an installed pack"), "Install over a pack of the same name."),
  flag("packs-dir", ["add", "packs", "remove", "heuristics"], cmd("the packs directory"), "Default SESHAT_PACKS_DIR or packs/."),
  flag("markdown", ["parameters"], cmd("print the audit page"), "Print documentation/parameters.md (with --out FILE, write it there)."),
  flag("help", ["every command"], cmd("print the usage"), "Print the usage and exit (short form -h)."),
];

/** The keys of a host profile (`config/hosts/*.json`, `packages/registry/src/host.ts`): where it is read, and what happens when it is absent. */
export interface HostProfileKey {
  /** The path of the key, `models.<provider/id>.pricing.cacheHit` style. */
  key: string;
  type: string;
  /** What it does and what the code does without it. */
  summary: string;
  /** Whether a shipped profile (`local.json`, `server.json`) sets it. */
  shipped: boolean;
}

export const HOST_PROFILE_KEYS: readonly HostProfileKey[] = [
  { key: "host", type: "string (^[a-z][a-z0-9-]*$)", summary: "The profile's name; required.", shipped: true },
  { key: "description", type: "string", summary: "Free text for a person; nothing reads it.", shipped: true },
  { key: "leanEnv", type: "string", summary: "The Lean environment of the host (lean/env/NAME.toml), usually ${env:LEAN_ENV:-base}; absent: the host names none and tool runs record the manifests' pins alone.", shipped: true },
  { key: "models", type: "Record<provider/id, ModelEntry>", summary: "What the host says of the models a run uses; a model with no entry is charged at pi-ai's numbers and ignores no setting.", shipped: true },
  { key: "models.*.pricing", type: "object", summary: "Dollars per million tokens: cacheHit, cacheMiss, output, and an optional calendar.", shipped: true },
  { key: "models.*.ignores", type: "Record<setting, string[]>", summary: "The sampling settings a model's family ignores (not sent, recorded as ignored).", shipped: true },
  { key: "recommended", type: "string[] (provider/id or provider/*)", summary: "The person's own preference: the models a command not told one prefers, in order; one that is available, priced and capable wins over a cheaper one (documentation/models-setup.md); absent: the cheapest capable model. The shipped profiles set none: the person chooses their models.", shipped: false },
  { key: "checkTimeoutSec", type: "number >= 1", summary: "The seconds a prover's Lean check may take under `RunConfig.checkTimeoutSec`; absent: DEFAULT_CHECK_TIMEOUT_SEC (120).", shipped: false },
  { key: "healthTimeoutMs", type: "integer >= 1", summary: "How long `harness health` waits for an implementation; absent: DEFAULT_HEALTH_TIMEOUT_MS (15000).", shipped: false },
  { key: "leanServerMemoryWarnMb", type: "number >= 1", summary: "`harness doctor` warns when the Lean server's resident memory passes it; absent: 8192.", shipped: false },
  { key: "capabilities", type: "Record<capability id, CapabilityBinding>", summary: "The capabilities the host offers; one the profile does not name is unavailable.", shipped: true },
  { key: "capabilities.*.use", type: "string[] (min 1)", summary: "Implementation ids in order of preference; the next is tried only when one cannot be reached.", shipped: true },
  { key: "capabilities.*.settings", type: "Record<implementation id, object>", summary: "Settings of an in-process implementation, or fields of an MCP server that replace the manifest's; ${env:NAME} reads a variable.", shipped: true },
  { key: "capabilities.*.timeoutMs", type: "integer >= 1", summary: "Replaces the manifest's time limit on this host.", shipped: true },
  { key: "capabilities.*.optional", type: "boolean", summary: "The harness can do without it: `harness health` shows an unreachable implementation as a warning (default false).", shipped: true },
];

/** The CLI flags that set a `RunConfig` key (by its first path segment), from the flag table. */
export function flagsOfKey(key: keyof RunConfig): string[] {
  return CLI_FLAGS.filter((f) => f.maps.kind === "RunConfig" && f.maps.to.split(".")[0] === key).map((f) => f.flag);
}

/** The findings the audit makes that no table shows: read from the code by a person, one line each. Each is a fact of the commit the page was generated at. */
export const MANUAL_FINDINGS: readonly string[] = [
  "No flag of `harness run` or `harness solve` sets `editTool`, `maskOldChecks`, `checkTimeoutSec`, `stateCard`, `budgetRounds`, `budgetShare`, `firstCases`, `triage`, `informalFirst`, `cards` or `frontier`: `--settings FILE` sets them (the section \"Settings file\"), and the defaults set `v2` turns the first seven on.",
  "`informalFirst` and `cards` are also set by the arms `solve-v2-informal` and `solve-v2-cards` of `harness ablate --experiment solve-defaults`; `ablate` does not read `--settings`, and no defaults set has them.",
  "One parser serves every command (`CLI_OPTIONS`): a flag a command does not read is accepted and ignored there (`harness report --provers 4` runs). Only `resume` refuses the flags that describe a run.",
  "Two flags mean different things by command: `--target` (ablate: a ratio; optimize-prompts: a prompt name) and `--split` (ablate: a number of problems; optimize-prompts: a split name).",
  "Two names for the seed: `--seed` seeds `--sample` (recorded in `selection`), `--draw-seed` seeds the memory draws (`RunConfig.seed`); the key and the flag do not match.",
  "Three names for a dollar limit: `--budget-usd` and `--run-budget-usd` (run), `--max-usd` (solve, which sets both fields of `budget`), `--turn-usd` (`consortium.limit.usd`); `--max-usd` also means a cap in `consolidate` and `optimize-prompts`.",
  "Two meanings of \"turn\" were confused: a session's model responses (now `--steps`, `limits.steps`; `--turns` and `limits.turns` stay as aliases, and the journal still records `turns`) and the consortium turn (`--turn-tokens`, `--turn-usd`, `--turn-minutes`). The vocabulary is in `runs.md`. `--consolidation` (`consolidation`), `--turn-consolidation` (`consortium.consolidation`) and the command `harness consolidate` are three different things.",
  "`consult.model` and `roles.consult.model` are two ways to name the consult model (documented: `consult.model` wins); `--consult` and `--role consult=` set them.",
  "`--private` is listed in the usage of `ablate` as meaning something only with `--experiment solve-defaults`, but the code sets `private` for every ablate run that is given the flag.",
  "`--lit` and `--sketch` are accepted by `run` and refused there with a message; `--no-intake`, `--no-auto-tool`, `--no-lean-search` matter only with `--defaults v2` and are ignored under `v1`.",
  "`--no-tool` can drop only `lean.lsp`; any other id is a usage error.",
  "`prompts`, `optionalTools`, `selection` and `defaults` are set by the harness, not a person (`--defaults` is a flag, but it names a set rather than a value).",
  "The impasse text in documentation/human.md says \"at or below\" `--impasse-posterior`, as the code does (`mean <= posteriorBelow`), while the field is named `posteriorBelow`: the name says \"below\".",
  "The shipped host profiles (`local.json`, `server.json`) set none of `checkTimeoutSec`, `healthTimeoutMs`, `leanServerMemoryWarnMb`, so every host uses the code's defaults for them (120 s, 15000 ms, 8192 MB).",
];

/** Findings computed from the tables. */
export function computedFindings(): string[] {
  const out: string[] = [];
  const keys = Object.keys(RUN_PARAMETERS) as Array<keyof RunConfig>;
  for (const k of keys) {
    const p = RUN_PARAMETERS[k];
    if (p.docs === "") out.push(`\`${k}\` has no documentation.`);
    if (p.tested === "") out.push(`\`${k}\` has no test.`);
    if (p.cli.length === 0 && p.status !== "internal") out.push(`\`${k}\` (${p.status}) has no CLI flag: settings file only (\`--settings\`).`);
  }
  return out;
}

const escape = (text: string): string => text.replace(/\|/g, "\\|");
const row = (cells: readonly string[]): string => `| ${cells.map(escape).join(" | ")} |`;
const code = (text: string): string => (text === "" ? "none" : `\`${text}\``);

/** The page `documentation/parameters.md`, generated; a test holds the committed page equal to it (`pnpm harness parameters --markdown`). */
export function renderParametersPage(): string {
  const lines: string[] = [];
  const keys = Object.keys(RUN_PARAMETERS) as Array<keyof RunConfig>;
  const solveV2 = solveDefaultsOf("v2");
  lines.push(
    "# Parameters",
    "",
    "<!-- Generated by `pnpm harness parameters --markdown --out documentation/parameters.md` from `packages/orchestrator/src/parameters.ts`: edit the catalogue, not this page. A test fails when they differ. -->",
    "",
    `The audit of every setting: the ${keys.length} keys of \`RunConfig\` (\`packages/orchestrator/src/run.ts\`), the ${CLI_FLAGS.length} flags of \`harness\`, and the keys of the host profiles. The catalogue is typed over \`RunConfig\`, so a key added there without an entry does not compile; a test holds the flags to the parser's table and the host keys to the shipped profiles. It is the source a settings menu of the graphical interface ([ui.md](ui.md)) reads. Nothing in it changes what a run does.`,
    "",
    "Columns: **default** is what `harness run` has when nothing sets it; **solve v2** is the value `harness solve` runs with under its default set, `-` when it is the one `harness run` has (derived from the code that builds the solve configuration); **sets** is what the defaults sets `v1` and `v2` of `harness solve` do ([quickstart.md](quickstart.md#defaults-sets)); **status** is `stable`, `beta`, `experimental` or `internal` (set by the harness); **ui** is whether a settings menu shows it (`basic`, `advanced`, `hidden`).",
    "",
    "## Run configuration",
    "",
  );
  for (const group of PARAMETER_GROUPS) {
    const here = keys.filter((k) => RUN_PARAMETERS[k].group === group);
    if (here.length === 0) continue;
    lines.push(`### ${group}`, "", GROUP_SUMMARY[group], "", row(["key", "type", "default", "solve v2", "what it changes", "flags", "sets", "docs", "test", "status", "ui"]), row(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]));
    for (const k of here) {
      const p = RUN_PARAMETERS[k];
      lines.push(row([`\`${k}\``, p.type, p.default, solveV2[k] ?? "-", p.summary, p.cli.length === 0 ? "none" : p.cli.map((f) => `\`--${f}\``).join(" "), p.sets, p.docs === "" ? "none" : p.docs, p.tested === "" ? "none" : `\`${p.tested}\``, p.status, p.ui]));
    }
    lines.push("");
    const withFields = here.filter((k) => RUN_PARAMETERS[k].fields !== undefined);
    for (const k of withFields) {
      lines.push(`\`${k}\`:`, "", ...(RUN_PARAMETERS[k].fields ?? []).map((f) => `- ${f}`), "");
    }
  }
  const accepted = settingsFileKeys();
  lines.push(
    "## Settings file",
    "",
    "`harness run` and `harness solve` take `--settings FILE`: a JSON object whose keys are `RunConfig` keys (documentation/quickstart.md, \"A settings file\"). The order is the defaults set, then the file, then the flags, which win. A key the harness sets itself (`status` internal) or a hidden one (`ui` hidden) is refused naming the key, and so is a value that fails the type below or `checkConfig`. In `solve`, the keys its own flags take are refused naming the flag: " + Object.entries(SOLVE_OWN_FLAGS).map(([k, f]) => `\`${k}\` (\`${f}\`)`).join(", ") + ".",
    "",
    `The file accepts these ${accepted.length} keys, the ones a settings menu of the interface shows: ${accepted.map((k) => `\`${k}\``).join(", ")}.`,
    "",
    `Refused: ${keys.filter((k) => !settingsFileAccepts(k)).map((k) => `\`${k}\``).join(", ")}.`,
    "",
  );
  lines.push("## Command line flags", "", "One table for every flag of `harness` (the keys of `CLI_OPTIONS` in `cli-options.ts`). One parser serves every command, so the *commands* column says where a flag is read.", "", row(["flag", "commands", "sets", "help"]), row(["---", "---", "---", "---"]));
  for (const f of CLI_FLAGS) lines.push(row([`\`--${f.flag}\``, f.commands.join(", "), `${f.maps.kind === "RunConfig" ? "RunConfig." : f.maps.kind === "host" ? "host: " : ""}${f.maps.to}`, f.help]));
  lines.push("", "## Host profile keys", "", "The keys of `config/hosts/*.json` (`packages/registry/src/host.ts`). `*` stands for a model or a capability id.", "", row(["key", "type", "what it does", "in a shipped profile"]), row(["---", "---", "---", "---"]));
  for (const k of HOST_PROFILE_KEYS) lines.push(row([code(k.key), k.type, k.summary, k.shipped ? "yes" : "no"]));
  lines.push("", "## Defaults sets and arms", "", "`harness solve --defaults v1|v2` (`DEFAULTS_SETS`, `SOLVE_SWITCHES` and `setConfig` in `student.ts`):", "");
  lines.push("- `v1`: no `RunConfig` field beyond `defaults`, `gate: {}`, the lines M1 and M10, the consortium turn limit and the budget.", "- `v2`: `v1` plus `editTool`, `maskOldChecks`, `checkTimeoutSec` (the host's, 120 by default), `stateCard`, `budgetRounds`, `budgetShare: 2`, `firstCases`, `gate.probeExtend`, line M6 with its repeat rule alone, and the solve-level switches: the intake, `autoTool`, `leanSearch` and `lean.lsp` in `tools` (the last three when the host offers them).", "- Arms of `harness ablate --experiment solve-defaults`: `solve-v1`, `solve-v2`, `solve-v2-blueprints`, `solve-v2-graph`, `solve-v2-blueprints-refine`, `solve-v2-informal` (adds `informalFirst`), `solve-v2-cards` (adds `cards`), `solve-v2-cpu` (adds `sorryBattery`).", "");
  lines.push("## Findings", "", "What the audit found, one line each. Nothing is fixed by this page.", "", "From the tables (computed):", "");
  const computed = computedFindings();
  lines.push(...(computed.length === 0 ? ["- none"] : computed.map((c) => `- ${c}`)), "", "From reading the code:", "", ...MANUAL_FINDINGS.map((m) => `- ${m}`), "");
  return lines.join("\n");
}

/** A short listing for the terminal: group, key, default. */
export function renderParametersList(): string[] {
  return (Object.keys(RUN_PARAMETERS) as Array<keyof RunConfig>).map((k) => `${RUN_PARAMETERS[k].group.padEnd(14)} ${k.padEnd(16)} ${RUN_PARAMETERS[k].default}`);
}

/** Whether a settings file (`harness run|solve --settings FILE`) may set a key: a key of the catalogue that a person sees (`ui` is not `hidden`) and the harness does not set itself (`status` is not `internal`). */
export function settingsFileAccepts(key: string): key is keyof RunConfig {
  if (!Object.hasOwn(RUN_PARAMETERS, key)) return false;
  const p = RUN_PARAMETERS[key as keyof RunConfig];
  return p.ui !== "hidden" && p.status !== "internal";
}

/** The keys a settings file accepts, in the catalogue's order. */
export function settingsFileKeys(): Array<keyof RunConfig> {
  return (Object.keys(RUN_PARAMETERS) as Array<keyof RunConfig>).filter(settingsFileAccepts);
}

/**
 * The keys that `harness solve` decides from its own flags, and the flag that takes the place of each: a settings file cannot set them for a
 * solve (it would be ignored or would skip a consent), so the file is refused naming the flag. A settings menu of the interface leaves them out of a solve.
 */
export const SOLVE_OWN_FLAGS: Readonly<Partial<Record<keyof RunConfig, string>>> = {
  model: "--model",
  budget: "--max-usd",
  consortium: "--turn-usd",
  human: "--human",
  gate: "--defaults",
  intake: "--intake",
  tools: "--tool",
  autoTool: "--auto-tool",
  private: "--private",
};
