import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Models } from "@earendil-works/pi-ai";
import { newId } from "@seshat/core";
import { type HostProfile, hostProfilePath, loadHostProfile, RegistryLeanChecker } from "@seshat/registry";
import { type Check, DEFAULT_PROFILE_NAME, doctor, type DoctorReport, type DoctorSystem, realSystem, renderDoctor } from "./doctor.ts";
import { hostLeanEnv, hostName, leanEnvPin, openRegistry, REPO_ROOT } from "./implementations.ts";
import { PriceBook } from "./prices.ts";
import { renderRunReport } from "./report.ts";
import { classifyStatement, DEFAULT_HEADER, solve, SolveInputError, type Signature, type SolveOptions, type SolveResult } from "./solve.ts";
import { cheapestModel, COMPUTE_TOOL, DEFAULT_DEFAULTS, DEFAULTS_NAMES, type DefaultsName, describeSet, SEARCH_CAPABILITY, SOLVE_SWITCHES, STUDENT_DEFAULT_MAX_USD, studentLines } from "./student.ts";
import { personName } from "./team.ts";
import type { RunConfig, RunOptions } from "./run.ts";

/** The flags of `harness doctor` and `harness solve` that the commands read. */
export interface DoctorFlags {
  host?: string;
  model?: string;
  noWrite?: boolean;
  rewrite?: boolean;
}

export interface SolveFlags extends DoctorFlags {
  max?: number;
  turnUsd?: number;
  out?: string;
  as?: string;
  yes?: boolean;
  /**
   * Ask for the signature over the standard streams, for a program that drives the command (`harness ui`): the signature is printed as one
   * line, `SESHAT_SIGNATURE`, then `askNonce` (a secret the program gave this command, so that no other text can pass for the line) and then
   * its JSON; the answer is one line on standard input, `yes STATEMENT_ID` for the statement that was shown, anything else for no.
   */
  askStdin?: boolean;
  askNonce?: string;
  lean?: boolean;
  prose?: boolean;
  noCheck?: boolean;
  /** `--lean-search`: `RunConfig.leanSearch` on top of the defaults set (it is in none of them). */
  leanSearch?: boolean;
  /** `--consolidation`: `RunConfig.consolidation` on top of the defaults set (it is in none of them). */
  consolidation?: boolean;
  offpeak?: RunConfig["offpeak"];
  lines?: string[];
  /** The defaults set, `v1` or `v2` (`student.ts`); absent: `v2`. */
  defaults?: string;
  /** `--tool ID`: capabilities the provers get besides lean_check (CA17). */
  tools?: string[];
  /** `--auto-tool`: add the host's compute tool when the statement is finite, about a graph or about numbers. */
  autoTool?: boolean;
  /** `--intake`: test the statement before any paid session, and search the literature if the person agrees (Task 36). */
  intake?: boolean;
  /** `--lit`: the person agrees to the statement going to third parties, in a call that cannot ask. Implies `intake`. */
  lit?: boolean;
  /** `--no-intake`, `--no-auto-tool`, `--no-lean-search`: turn one addition of the set off (they matter with `v2`, which turns them on). */
  noIntake?: boolean;
  noAutoTool?: boolean;
  noLeanSearch?: boolean;
  /** `--private`: nothing goes outside; wins over everything. */
  private?: boolean;
  /** `--intake-usd`: the cap of the judge call. */
  intakeUsd?: number;
}

/** What the commands need from the process: streams, the machine, and the models. Tests give their own. */
export interface CommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
  models: Models;
  system?: DoctorSystem;
  /** Asks a yes/no question; absent: a terminal prompt, or a refusal when there is no terminal. */
  ask?: (question: string) => Promise<boolean>;
  /** With `askStdin`: reads the answer line; absent: standard input. */
  readLine?: () => Promise<string | undefined>;
  signal?: AbortSignal;
  configDir?: string;
  codeRev?: string;
}

/** The host a command uses: the one named, `HARNESS_HOST`, the isolated profile `doctor` wrote when it exists, then `local`. */
export function studentHost(explicit: string | undefined, configDir: string = `${REPO_ROOT}config`): string {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.HARNESS_HOST;
  if (env !== undefined && env !== "") return env;
  return existsSync(hostProfilePath(configDir, DEFAULT_PROFILE_NAME)) ? DEFAULT_PROFILE_NAME : "local";
}

function leanProjectOf(host: string, configDir: string, system: DoctorSystem): string | undefined {
  const profile = loadHostProfile(hostProfilePath(configDir, host));
  try {
    return leanEnvPin(profile, { env: system.env })?.projectDir;
  } catch {
    return undefined;
  }
}

/** The report of `harness doctor` as data (the command prints it; `harness ui` shows it). Nothing is written unless the flags ask for it. */
export async function doctorReport(flags: DoctorFlags, io: Pick<CommandIo, "models" | "system" | "configDir">): Promise<DoctorReport> {
  const configDir = io.configDir ?? `${REPO_ROOT}config`;
  const system = io.system ?? realSystem();
  const host = studentHost(flags.host, configDir);
  const profile = loadHostProfile(hostProfilePath(configDir, host));
  return await doctor({
    system,
    models: io.models,
    profile,
    configDir,
    leanProject: leanProjectOf(host, configDir, system),
    write: flags.noWrite === true ? "never" : flags.rewrite === true ? "rewrite" : "auto",
    ...(flags.model !== undefined ? { model: flags.model } : {}),
  });
}

/** `harness doctor`: what the machine has and lacks, in plain words. Exit 1 when something a run needs is missing. */
export async function doctorCommand(flags: DoctorFlags, io: CommandIo): Promise<number> {
  const report = await doctorReport(flags, io);
  for (const line of renderDoctor(report)) io.out(line);
  return report.ok ? 0 : 1;
}

const LIT_BACKEND_NAMES: Readonly<Record<string, string>> = { openalex: "OpenAlex", arxiv: "arXiv", "semantic-scholar": "Semantic Scholar", zbmath: "zbMATH" };

/** A name taken from a host profile, shown in a prompt: control and bidirectional characters (an ANSI escape, a newline, a right-to-left override) are removed, and its length is bounded. */
export function plainName(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 80);
}

/**
 * The question asked once before a run sends anything outside (Task 36b): what the run could send, and to which services, taken from the host
 * profile (a backend with no address there is not reachable, so it is not named). `lean.search`'s services are the hosts the profile allows.
 */
export function consentQuestion(profile: HostProfile, o: { literature: boolean; leanSearch: boolean }): string {
  const parts: string[] = [];
  if (o.literature) {
    const backends = Object.keys((profile.capabilities["lit.search"]?.settings?.sources?.backends ?? {}) as Record<string, unknown>).filter((b) => b !== "bench-metadata");
    const names = (backends.length > 0 ? backends : Object.keys(LIT_BACKEND_NAMES)).map((b) => LIT_BACKEND_NAMES[b] ?? plainName(b));
    parts.push(`the literature step would send the words of this statement to ${names.join(", ")}, and the hits to the model, to look for a paper that already settled it`);
  }
  if (o.leanSearch) {
    const hosts = profile.capabilities["lean.search"]?.settings?.search?.allowedHosts;
    const names = Array.isArray(hosts) && hosts.length > 0 ? hosts.map(plainName).join(", ") : "the search services the host profile sets";
    parts.push(`lean.search would send the unknown names and the goals of your proof attempts to ${names} (without it, only a local index and pattern search are used)`);
  }
  return `This run could send content of your problem outside this machine and the model provider: ${parts.join("; and ")}. Allow that? [y/N] `;
}

/**
 * What `--intake`, `--lit` and `--lean-search` give `solve` for the answer on third parties: the intake section (with `--lit`, the yes of a call
 * that cannot ask), and the question, asked once, only where a person can answer. `--yes` or `--ask-stdin` without `--lit` gives neither a yes nor
 * a question, which `solve` journals as a no and `lean.search` keeps to its local backends.
 */
export function consentOptions(flags: SolveFlags, io: Pick<CommandIo, "ask">, profile: HostProfile, canAsk: boolean = process.stdin.isTTY === true): Pick<SolveOptions, "intake" | "askConsent"> {
  const wantsIntake = flags.intake === true || flags.lit === true;
  const ask = flags.lit !== true && flags.yes !== true && flags.askStdin !== true && (io.ask !== undefined || canAsk);
  return {
    ...(wantsIntake
      ? {
          intake: {
            hygiene: true,
            literature: true,
            ...(flags.intakeUsd !== undefined ? { capUsd: flags.intakeUsd } : {}),
            ...(flags.lit === true ? { consent: { allowed: true, via: "flag" as const } } : {}),
          },
        }
      : {}),
    ...((wantsIntake || flags.leanSearch === true) && ask
      ? { askConsent: () => (io.ask ?? terminalAsk)(consentQuestion(profile, { literature: wantsIntake, leanSearch: flags.leanSearch === true })) }
      : {}),
  };
}

/** What the host lets the switches do: the compute tool and `lean.search` only if the host offers them, and one line for each that it does not. */
export function resolveAdditions(flags: SolveFlags, defaults: string, switches: { autoTool: boolean; leanSearch: boolean }, host: string, offers: (capability: string) => boolean): { autoTool: boolean; leanSearch: boolean; notes: string[] } {
  const notes: string[] = [];
  const autoTool = switches.autoTool && offers(COMPUTE_TOOL);
  const leanSearch = switches.leanSearch && offers(SEARCH_CAPABILITY);
  if (switches.autoTool && !autoTool) notes.push(`Note: ${flags.autoTool === true ? "--auto-tool" : `the ${defaults} defaults`} has nothing to add: host ${host} does not offer ${COMPUTE_TOOL}.`);
  if (switches.leanSearch && !leanSearch) notes.push(`Note: ${flags.leanSearch === true ? "--lean-search" : `the ${defaults} defaults`} has nothing to add: host ${host} does not offer ${SEARCH_CAPABILITY}; the run goes on without it.`);
  return { autoTool, leanSearch, notes };
}

/** What `solve` does at its own level under a set and the flags: the set's switches (`SOLVE_SWITCHES`), the explicit flags on, the `--no-...` flags off. */
export function effectiveSwitches(flags: SolveFlags, defaults: DefaultsName): { intake: boolean; autoTool: boolean; leanSearch: boolean } | { conflict: string } {
  const set = SOLVE_SWITCHES[defaults];
  for (const [on, off, name] of [
    [flags.intake === true || flags.lit === true, flags.noIntake === true, "--intake (or --lit)/--no-intake"],
    [flags.autoTool === true, flags.noAutoTool === true, "--auto-tool/--no-auto-tool"],
    [flags.leanSearch === true, flags.noLeanSearch === true, "--lean-search/--no-lean-search"],
  ] as const) {
    if (on && off) return { conflict: `${name} cannot both be given` };
  }
  return {
    intake: flags.intake === true || flags.lit === true || (set.intake && flags.noIntake !== true),
    autoTool: flags.autoTool === true || (set.autoTool && flags.noAutoTool !== true),
    leanSearch: flags.leanSearch === true || (set.leanSearch && flags.noLeanSearch !== true),
  };
}

/** The checks a solve cannot start without: the others are said, and the run goes on. */
const NEEDED: ReadonlyArray<Check["id"]> = ["kimina", "credentials", "prices", "network"];

function readStatement(argument: string, flags: SolveFlags): { text: string; mode?: "lean" | "prose"; from?: string } {
  const forced = flags.lean === true ? "lean" : flags.prose === true ? "prose" : undefined;
  if (flags.lean === true && flags.prose === true) throw new SolveInputError("--lean and --prose cannot both be given");
  if (argument.length < 4096 && !argument.includes("\n") && existsSync(argument)) {
    const text = readFileSync(argument, "utf8");
    const mode = forced ?? (argument.endsWith(".lean") ? "lean" : /\.(txt|md|tex)$/.test(argument) ? "prose" : undefined);
    return { text, ...(mode !== undefined ? { mode } : {}), from: argument };
  }
  return { text: argument, ...(forced !== undefined ? { mode: forced } : {}) };
}

function showSignature(s: Signature, io: CommandIo): void {
  io.out("");
  if (s.source === "prose") {
    io.out("Your words:");
    io.out(`  ${s.prose}`);
    io.out("");
    io.out("What the model made of them, in Lean (this is what will be proved):");
  } else {
    io.out("The statement, in Lean (this is what will be proved):");
  }
  for (const line of s.theorem.split("\n")) io.out(`  ${line}`);
  if (s.testLemmas !== undefined) {
    const t = s.testLemmas;
    io.out(`  First cases: ${t.result}${t.tried > 0 ? ` (${t.tried} tried)` : ""}${t.failedAt !== undefined ? `, fails at ${t.failedAt}` : ""}${t.note !== undefined ? `; ${t.note}` : ""}`);
  }
  for (const note of s.notes) io.out(`  Note: ${note}`);
  io.out("");
}

/** The first line of standard input, or undefined when it ends before one. */
async function stdinLine(): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) return line;
    return undefined;
  } finally {
    rl.close();
  }
}

/** The marker of the line that carries a signature when the command is driven by a program (`--ask-stdin`). */
export const SIGNATURE_LINE = "SESHAT_SIGNATURE";

async function terminalAsk(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** `harness solve STATEMENT`: prepares the problem and the student defaults, asks for the signature of prose, runs, and says where the result is. */
export async function solveCommand(argument: string, flags: SolveFlags, io: CommandIo): Promise<number> {
  const configDir = io.configDir ?? `${REPO_ROOT}config`;
  const system = io.system ?? realSystem();
  const host = studentHost(flags.host, configDir);
  const profile = loadHostProfile(hostProfilePath(configDir, host));
  const prices = new PriceBook(profile.models);
  const defaults = flags.defaults ?? DEFAULT_DEFAULTS;
  if (!(DEFAULTS_NAMES as readonly string[]).includes(defaults)) {
    io.err(`--defaults must be one of ${DEFAULTS_NAMES.join(", ")}, got ${JSON.stringify(defaults)}`);
    return 2;
  }
  const statement = readStatement(argument, flags);
  const maxUsd = flags.max ?? STUDENT_DEFAULT_MAX_USD;
  const user = personName(flags.as);

  // The model: the one named, or the cheapest priced model of the providers with credentials.
  let model = flags.model;
  if (model === undefined) {
    const choice = await cheapestModel(io.models, prices);
    if (choice === undefined) {
      io.err("No model can be chosen: no provider with credentials has a model with a price, so no dollar cap could see its cost.");
      io.err("Run `harness doctor` to see what is missing, or name a model with --model PROVIDER/ID.");
      return 2;
    }
    model = choice.name;
    io.out(`Model: ${choice.name} (the cheapest priced model you can use, $${choice.price.toFixed(2)} per million tokens input plus output${choice.others.length > 0 ? `; next: ${choice.others.slice(0, 2).map((o) => o.name).join(", ")}` : ""}). Name another with --model.`);
  } else {
    io.out(`Model: ${model} (named by you).`);
  }
  const turn = flags.turnUsd ?? Math.round(maxUsd * 0.5 * 1e6) / 1e6;
  io.out(`Allowance: $${maxUsd} in all. The run stops by itself at that, and stops earlier, for you to look, once a turn has spent $${turn}.`);
  io.out(`Defaults: ${defaults}${defaults === DEFAULT_DEFAULTS ? "" : ` (the default is ${DEFAULT_DEFAULTS})`}${describeSet(defaults as DefaultsName).length > 0 ? `: ${describeSet(defaults as DefaultsName).join("; ")}` : ""}. Turn an addition off alone with --no-intake, --no-auto-tool or --no-lean-search.`);
  const switches = effectiveSwitches(flags, defaults as DefaultsName);
  if ("conflict" in switches) {
    io.err(switches.conflict);
    return 2;
  }
  io.out(`Host: ${host}. Lines: ${(flags.lines ?? studentLines(defaults as DefaultsName)).join(", ")}, with the budget gate and the probe first.`);

  // The machine: what a run cannot start without is said now, in words, and nothing is spent.
  let report: DoctorReport | undefined;
  if (flags.noCheck !== true) {
    report = await doctor({
      system,
      models: io.models,
      profile,
      configDir,
      leanProject: leanProjectOf(host, configDir, system),
      write: "never",
      model,
    });
    const blocked = report.checks.filter((c) => c.status === "missing" && NEEDED.includes(c.id));
    if (blocked.length > 0) {
      io.err("This machine cannot start the run yet:");
      for (const c of blocked) {
        io.err(`  ${c.title}: ${c.detail}`);
        if (c.fix !== undefined) io.err(`    What to do: ${c.fix}`);
      }
      io.err("`harness doctor` checks everything and writes the isolation profile when it can. Nothing was spent.");
      return 2;
    }
    for (const c of report.checks) if (c.status !== "ok" && !NEEDED.includes(c.id)) io.out(`${c.status === "warn" ? "Warning" : "Missing"}: ${c.title}: ${c.detail}`);
  }

  const registry: RunOptions["registry"] = (journal, blobs, options) => openRegistry({ host, journal, blobs, ...(options?.leanEnv !== undefined ? { leanEnv: options.leanEnv } : {}) });
  const checkerRegistry = openRegistry({ host });
  const mode = statement.mode ?? classifyStatement(statement.text);
  if (flags.private === true) {
    // A tool that would send the problem to a third party cannot be given to a private run: said now, before anything is spent.
    checkerRegistry.restrictThirdParties({ private: true });
    const refused = (flags.tools ?? []).flatMap((id) => (checkerRegistry.catalog.capabilities.has(id) ? [checkerRegistry.thirdPartyRefusal(id)] : [])).filter((r): r is string => r !== undefined);
    if (refused.length > 0) {
      for (const r of refused) io.err(`--private: ${r}. Drop --private or drop the tool. Nothing was spent.`);
      await checkerRegistry.close();
      return 2;
    }
  }
  // The additions of the set that the host cannot give are said in one line and the run goes on without them.
  const additions = resolveAdditions(flags, defaults as DefaultsName, switches, host, (capability) => checkerRegistry.offers(capability));
  for (const note of additions.notes) io.out(note);
  const { autoTool, leanSearch } = additions;
  const dir = resolve(flags.out ?? join("runs", newId("run")));
  let result: SolveResult;
  try {
    result = await solve({
      statement: statement.text,
      mode,
      dir,
      models: io.models,
      model,
      maxUsd,
      user,
      host,
      prices,
      header: DEFAULT_HEADER,
      checker: new RegistryLeanChecker(checkerRegistry, { actor: "orchestrator" }),
      ...(flags.turnUsd !== undefined ? { turnUsd: flags.turnUsd } : {}),
      ...(flags.offpeak !== undefined ? { offpeak: flags.offpeak } : {}),
      ...(flags.lines !== undefined ? { lines: flags.lines } : {}),
      ...(leanSearch || flags.consolidation === true ? { base: { ...(leanSearch ? { leanSearch: true } : {}), ...(flags.consolidation === true ? { consolidation: true } : {}) } } : {}),
      defaults: defaults as DefaultsName,
      ...(profile.checkTimeoutSec !== undefined ? { hostCheckTimeoutSec: profile.checkTimeoutSec } : {}),
      ...(flags.tools !== undefined && flags.tools.length > 0 ? { tools: flags.tools } : {}),
      ...(autoTool ? { autoTool: COMPUTE_TOOL } : {}),
      ...(flags.private === true ? { private: true } : {}),
      ...consentOptions({ ...flags, intake: switches.intake, leanSearch }, io, profile),
      confirm: async (signature) => {
        if (flags.askStdin === true) {
          if (flags.askNonce === undefined || flags.askNonce === "") throw new SolveInputError("--ask-stdin needs the nonce its caller gives in the environment (SESHAT_ASK_NONCE)");
          io.out(`${SIGNATURE_LINE} ${flags.askNonce} ${JSON.stringify(signature)}`);
          const answer = await (io.readLine ?? stdinLine)();
          // The answer names the statement that was shown: a yes for any other statement is a no.
          const yes = answer !== undefined && answer.trim() === `yes ${signature.statementId}`;
          if (!yes) io.err("Not signed: nothing was run.");
          return yes;
        }
        showSignature(signature, io);
        // A Lean statement is signed too: the person may have downloaded it, and what is proved is this text and no other.
        if (flags.yes === true) {
          io.out("Signed with --yes.");
          return true;
        }
        const ask = io.ask ?? terminalAsk;
        const yes = await ask("Does this say what you mean? Sign it and start the run? [y/N] ");
        if (!yes) io.err("Not signed: nothing was run. Change your words, or write the statement in Lean, and run solve again. (--yes signs without asking.)");
        return yes;
      },
      show: (line) => io.out(line),
      registry,
      leanEnvironment: (options) => hostLeanEnv({ host, ...(options?.leanEnv !== undefined ? { leanEnv: options.leanEnv } : {}) }),
      ...(io.signal !== undefined ? { signal: io.signal } : {}),
      log: (line) => io.err(line),
      ...(io.codeRev !== undefined ? { codeRev: io.codeRev } : {}),
    });
  } catch (error) {
    if (error instanceof SolveInputError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  } finally {
    await checkerRegistry.close();
  }
  if (result.state === "declined" || result.result === undefined) return 1;
  io.out(renderRunReport(result.result.report));
  io.out(`The result: ${join(result.dir, "RESULT.md")}`);
  io.out(`The picture: harness view ${result.dir}`);
  if (result.result.turn !== undefined) io.out(`Turn ${result.result.turn.number} ended: ${result.result.turn.reason} (${result.result.turn.detail}). The account: ${join(result.dir, result.result.turn.account)}`);
  if (result.result.turn?.paused === true) io.out(`The run waits for you. To spend more of the allowance and go on: ${result.resume}`);
  if (result.result.stopped === undefined || result.result.stopped === "budget_exhausted") return 0;
  return result.result.stopped === "aborted" ? 130 : 1;
}
