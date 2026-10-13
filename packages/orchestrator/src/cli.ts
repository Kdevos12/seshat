#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type BenchIndex, describeCheckout, type ProblemEntry, readIndex, sample } from "@math-harness/bench";
import { type Json, newId, readEvents } from "@math-harness/core";
import { CapabilityError, CatalogError, messageOf, runContract, type Registry } from "@math-harness/registry";
import { hostName, openRegistry, REPO_ROOT } from "./implementations.ts";
import { buildReport, renderRunReport } from "./report.ts";
import { DEFAULT_CONFIG, runBench, type RunConfig, RunSetupError } from "./run.ts";

const usage = `usage:
  harness capabilities [--host HOST]
  harness describe CAPABILITY
  harness health [CAPABILITY] [--host HOST]
  harness contract CAPABILITY [--host HOST] [--implementation ID] [--case NAME]... [--out FILE]
  harness models [PROVIDER]
  harness run --checkout DIR --model PROVIDER/ID (--sample N [--seed S] | --problem ID... | --all)
              [--bench FILE] [--host HOST] [--provers N] [--sessions N] [--turns N] [--context-tokens N]
              [--notes-chars N] [--thinking LEVEL] [--budget-usd X] [--run-budget-usd X] [--concurrency N] [--out DIR]
  harness report RUN_DIR [--json]

HOST defaults to HARNESS_HOST, then local (config/hosts/HOST.json).
models: the providers pi-ai knows and whether their credentials are set; with PROVIDER, its models.
run: the bench defaults to bench/fc-bench-v1-discrete.json, the run directory to runs/RUN_ID.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    implementation: { type: "string" },
    case: { type: "string", multiple: true },
    out: { type: "string" },
    bench: { type: "string" },
    checkout: { type: "string" },
    sample: { type: "string" },
    seed: { type: "string" },
    problem: { type: "string", multiple: true },
    all: { type: "boolean" },
    model: { type: "string" },
    thinking: { type: "string" },
    provers: { type: "string" },
    sessions: { type: "string" },
    turns: { type: "string" },
    "context-tokens": { type: "string" },
    "notes-chars": { type: "string" },
    "budget-usd": { type: "string" },
    "run-budget-usd": { type: "string" },
    concurrency: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, target] = positionals;

/** A mistake the user can fix, such as a missing file: the message is printed, and the exit code is 2. */
class InputError extends Error {}

/** A command-line mistake: the message is printed with the usage, and the exit code is 2. */
class UsageError extends InputError {}

async function main(): Promise<number> {
  if (values.help || command === undefined) {
    console.log(usage);
    return command === undefined && !values.help ? 2 : 0;
  }
  try {
    if (command === "models") return await listModels(target);
    if (command === "run") return await run();
    if (command === "report") return report();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage}`);
      return 2;
    }
    // Anything else is a bug: Node prints it with its stack, and the exit code is 1.
    if (!(error instanceof InputError || error instanceof RunSetupError)) throw error;
    console.error(error.message);
    return 2;
  }
  let registry: Registry;
  try {
    registry = openRegistry({ host: hostName(values.host) });
  } catch (error) {
    if (error instanceof CatalogError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  try {
    switch (command) {
      case "capabilities":
        return capabilities(registry);
      case "describe":
        if (target === undefined) break;
        console.log(registry.describe(target));
        return 0;
      case "health":
        return await health(registry, target);
      case "contract":
        if (target === undefined) break;
        return await contract(registry, target);
    }
    console.error(usage);
    return 2;
  } catch (error) {
    if (!(error instanceof CapabilityError)) throw error;
    console.error(error.message);
    return 2;
  } finally {
    await registry.close();
  }
}

function capabilities(registry: Registry): number {
  for (const { manifest } of registry.capabilities()) {
    const use = registry.host.capabilities[manifest.id]?.use;
    const where = use ? `${registry.host.host}: ${use.join(", ")}` : `not offered on ${registry.host.host}`;
    console.log(`${manifest.id} v${manifest.version} (${manifest.exposure}): ${manifest.title} [${where}]`);
  }
  return 0;
}

async function health(registry: Registry, id: string | undefined): Promise<number> {
  const entries = await registry.health(id);
  for (const e of entries) {
    console.log(`${e.ok ? "ok  " : "FAIL"} ${e.capability}/${e.implementation} ${e.version} (${e.durationMs} ms): ${e.detail}`);
  }
  if (entries.length === 0) console.log(`host ${registry.host.host} offers no capability`);
  return entries.every((e) => e.ok) ? 0 : 1;
}

async function contract(registry: Registry, id: string): Promise<number> {
  const report = await runContract(registry, id, {
    ...(values.implementation !== undefined ? { implementation: values.implementation } : {}),
    ...(values.case !== undefined ? { only: values.case } : {}),
    onCase: (c) => {
      console.log(`${c.passed ? "pass" : "FAIL"}  ${c.name} (${c.durationMs} ms)`);
      for (const failure of c.failures) console.log(`      ${failure}`);
    },
  });
  console.log(`${report.capability} on ${report.host} with ${report.implementation}: ${report.passed} passed, ${report.failed} failed`);
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  return report.failed === 0 ? 0 : 1;
}

function number(name: string, value: string | undefined, fallback: number): number;
function number(name: string, value: string | undefined, fallback: undefined): number | undefined;
function number(name: string, value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number, got ${JSON.stringify(value)}`);
  return parsed;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The problems a run works on, and how they were chosen. */
function selectProblems(index: BenchIndex): { problems: ProblemEntry[]; selection: Json } {
  const ways = [values.sample !== undefined, values.problem !== undefined, values.all === true].filter(Boolean).length;
  if (ways !== 1) throw new UsageError("choose the problems with exactly one of --sample, --problem and --all");
  if (values.seed !== undefined && values.sample === undefined) throw new UsageError("--seed goes with --sample");
  if (values.all) return { problems: index.problems, selection: { all: true } };
  if (values.problem !== undefined) {
    const ids = [...new Set(values.problem)];
    const byId = new Map(index.problems.map((p) => [p.id, p]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) throw new UsageError(`not in ${index.benchId}: ${unknown.join(", ")}`);
    return { problems: ids.map((id) => byId.get(id) as ProblemEntry), selection: { ids } };
  }
  const n = number("sample", values.sample, 0);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--sample must be a positive integer, got ${values.sample}`);
  const seed = values.seed ?? "m0";
  return { problems: sample(index.problems, n, seed), selection: { sample: n, seed } };
}

/** The commit of this repository, with `+dirty` when tracked files have changes. */
function codeRevision(): string | undefined {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const rev = git(["rev-parse", "HEAD"]);
    return git(["status", "--porcelain", "--untracked-files=no"]) === "" ? rev : `${rev}+dirty`;
  } catch {
    return undefined;
  }
}

/** Reads an input of the command; a failure, such as a missing file, is the user's to fix. */
function readInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new InputError(messageOf(error), { cause: error });
  }
}

async function run(): Promise<number> {
  if (target !== undefined) throw new UsageError(`run takes no positional argument, got ${target}`);
  if (values.checkout === undefined) throw new UsageError("run needs --checkout: a checkout of the bench's repository");
  if (values.model === undefined) throw new UsageError("run needs --model PROVIDER/ID (harness models lists them)");
  const thinking = (values.thinking ?? DEFAULT_CONFIG.thinkingLevel) as ThinkingLevel;
  if (!THINKING_LEVELS.includes(thinking)) throw new UsageError(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  const checkout = values.checkout;
  if (!existsSync(checkout)) throw new InputError(`no directory ${checkout}`);
  const index = readInput(() => readIndex(values.bench ?? join(REPO_ROOT, "bench", "fc-bench-v1-discrete.json")));
  const { problems, selection } = selectProblems(index);
  const source = describeCheckout(checkout);
  if (source.rev !== index.source.rev) {
    console.error(`warning: the checkout is at ${source.rev}, the bench at ${index.source.rev}; each problem file is still checked against the index`);
  }
  const runUsd = number("run-budget-usd", values["run-budget-usd"], undefined);
  const config: RunConfig = {
    selection,
    model: values.model,
    thinkingLevel: thinking,
    provers: number("provers", values.provers, DEFAULT_CONFIG.provers),
    sessions: number("sessions", values.sessions, DEFAULT_CONFIG.sessions),
    limits: {
      turns: number("turns", values.turns, DEFAULT_CONFIG.limits.turns),
      contextTokens: number("context-tokens", values["context-tokens"], DEFAULT_CONFIG.limits.contextTokens),
    },
    notesChars: number("notes-chars", values["notes-chars"], DEFAULT_CONFIG.notesChars),
    budget: { problemUsd: number("budget-usd", values["budget-usd"], DEFAULT_CONFIG.budget.problemUsd), ...(runUsd !== undefined ? { runUsd } : {}) },
    concurrency: number("concurrency", values.concurrency, DEFAULT_CONFIG.concurrency),
  };
  const host = hostName(values.host);
  const runId = newId("run");
  const dir = resolve(values.out ?? join("runs", runId));
  const controller = new AbortController();
  let interruptedAt: number | undefined;
  process.on("SIGINT", () => {
    if (interruptedAt !== undefined) {
      // pnpm passes the terminal's Ctrl-C on to its child, so one keypress can arrive twice.
      if (Date.now() - interruptedAt > 1000) process.exit(130);
      return;
    }
    interruptedAt = Date.now();
    console.error("stopping: the problems in progress end as aborted (Ctrl-C again quits at once)");
    controller.abort();
  });
  const codeRev = codeRevision();
  const result = await runBench({
    config,
    index,
    problems,
    checkout,
    dir,
    models: builtinModels(),
    registry: (journal, blobs) => openRegistry({ host, journal, blobs }),
    signal: controller.signal,
    log: (line) => console.error(line),
    runId,
    ...(codeRev !== undefined ? { codeRev } : {}),
  });
  process.stdout.write(renderRunReport(result.report));
  console.log(`Run directory: ${dir}`);
  if (result.stopped === undefined || result.stopped === "budget_exhausted") return 0;
  return result.stopped === "aborted" ? 130 : 1;
}

/** The providers pi-ai knows and whether they have credentials, or the models of one provider. */
async function listModels(provider: string | undefined): Promise<number> {
  const models = builtinModels();
  if (provider === undefined) {
    for (const p of models.getProviders()) {
      const auth = await models.checkAuth(p.id).catch(() => undefined);
      const credentials = auth === undefined ? "no credentials" : `credentials from ${auth.source ?? auth.type}`;
      console.log(`${p.id}: ${models.getModels(p.id).length} model(s), ${credentials}`);
    }
    return 0;
  }
  if (models.getProvider(provider) === undefined) throw new InputError(`unknown provider ${provider}`);
  for (const m of models.getModels(provider)) {
    const price = `$${m.cost.input}/$${m.cost.output} per million input/output tokens`;
    console.log(`${provider}/${m.id}: context ${m.contextWindow} tokens, ${price}${m.reasoning ? ", thinking" : ""}`);
  }
  return 0;
}

function report(): number {
  if (target === undefined) throw new UsageError("report needs a run directory");
  const journal = join(target, "journal.jsonl");
  if (!existsSync(journal)) throw new InputError(`${target} is not a run directory: it has no journal.jsonl`);
  const events = readInput(() => readEvents(journal));
  if (!events.some((e) => e.type === "run.started")) throw new InputError(`${target}: the run did not start, its journal is empty`);
  const built = buildReport(events);
  process.stdout.write(values.json ? `${JSON.stringify(built, null, 2)}\n` : renderRunReport(built));
  return 0;
}

// `harness models | head` closes the output early, which is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.exit(0);
});

process.exitCode = await main();
