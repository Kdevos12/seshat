import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { type BenchFilter, buildIndex, DISCRETE, type BenchIndex } from "@seshat/bench";
import { type HarnessEvent, type LeanCertifier, type LeanCheckOptions, type LeanCheckResult, type LeanChecker, type LeanSnippet, PROOF_BEGIN, PROOF_END, readEvents } from "@seshat/core";
import type { LineRegistry } from "@seshat/lines";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { FakeChecker, type FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import type { FakeSage } from "./fixtures/fake-sage.ts";
import { DEFAULT_CONFIG, REPO_ROOT, runBench, type RunConfig, type RunOptions, type RunResult } from "../src/index.ts";

export const DEMO_FILE = `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- Doubling is adding. -/
@[category research solved, AMS 5]
theorem two_mul' (n : ℕ) : 2 * n = n + n := by
  sorry

end Demo
`;

export function tempDir(prefix = "mh-m0-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A checkout with one problem file (or several, by file name), and its bench index (`DISCRETE` unless a filter is given). */
export function demoBench(file: string | Record<string, string> = DEMO_FILE, filter: BenchFilter = DISCRETE): { checkout: string; index: BenchIndex } {
  const checkout = tempDir("mh-checkout-");
  mkdirSync(join(checkout, "FormalConjectures"), { recursive: true });
  const files = typeof file === "string" ? { "Demo.lean": file } : file;
  for (const [name, text] of Object.entries(files)) writeFileSync(join(checkout, "FormalConjectures", name), text);
  const { errors: _errors, ...index } = buildIndex(checkout, "demo-bench", filter);
  return { checkout, index };
}

/** The PROOF region of a checked file, or undefined for a file without markers (the reference). */
export function proofOf(code: string): string | undefined {
  const lines = code.split("\n");
  const begin = lines.findIndex((l) => l.trim() === PROOF_BEGIN);
  const end = lines.findIndex((l) => l.trim() === PROOF_END);
  return begin < 0 || end < 0 ? undefined : lines.slice(begin + 1, end).join("\n");
}

/**
 * The simulated Lean of these tests. The original file checks. In a prover's file, a proof with
 * `exact trivial_proof` is accepted, `sorry` is a hole with a goal, `bad` is an unknown
 * identifier, `slow` never answers (until the call is aborted), and anything else leaves a goal.
 */
export function demoAnswer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  const lines = code.split("\n");
  const lineOf = (needle: string) => lines.findIndex((l, k) => l.includes(needle) && k > lines.findIndex((x) => x.trim() === PROOF_BEGIN)) + 1;
  if (proof.includes("exact trivial_proof")) return {};
  if (proof.includes("sorry")) {
    return { axioms: ["propext", "sorryAx"], sorries: [{ pos: { line: lineOf("sorry"), column: 2 }, goal: "n : ℕ\n⊢ n + 0 = n" }] };
  }
  if (proof.includes("bad")) {
    return { messages: [{ severity: "error", pos: { line: lineOf("bad"), column: 2 }, text: "unknown identifier 'bad'" }] };
  }
  return { messages: [{ severity: "error", pos: { line: lineOf(proof.trim().split("\n")[0] ?? ""), column: 0 }, text: "unsolved goals\nn : ℕ\n⊢ n + 0 = n" }] };
}

/** `FakeChecker`, except that a file with `slow` in its proof waits until the call is aborted. */
export class DemoLean implements LeanChecker {
  readonly implementation = "demo-lean";
  readonly version = "0";
  readonly fake: FakeChecker;
  private readonly delayMs: number;

  /** `delayMs`: how long every check takes. */
  constructor(answer: (code: string) => FakeLeanAnswer = demoAnswer, delayMs = 0) {
    this.fake = new FakeChecker(answer);
    this.delayMs = delayMs;
  }

  get calls(): LeanSnippet[] {
    return this.fake.calls;
  }

  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    if (snippets.some((s) => proofOf(s.code)?.includes("slow"))) {
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.fake.check(snippets);
  }
}

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] } } };

export function demoRegistry(lean: LeanChecker): RunOptions["registry"] {
  return (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean) }, journal, blobs });
}

/**
 * The repository's catalog on a host that also offers compute.sage through the implementations
 * `use`, each served by `sage` unless `servers` gives it another.
 */
export function sageRegistry(
  sage: FakeSage,
  use: string[] = ["local"],
  servers: Record<string, FakeSage> = {},
): (lean: LeanChecker) => RunOptions["registry"] {
  const withSage: HostProfile = { host: "test", capabilities: { ...host.capabilities, "compute.sage": { use } } };
  return (lean) => (journal, blobs) =>
    new Registry({
      catalog,
      host: withSage,
      factories: { kimina: () => leanCheckImplementation(lean) },
      journal,
      blobs,
      mcpTransport: (_server, spec) => (servers[spec.id] ?? sage).transport(),
    });
}

/** A faux model priced so that a response costs a few cents, unless `pricePerMillion` says otherwise. */
export function fauxModels(pricePerMillion = 3): { models: MutableModels; faux: FauxProviderHandle; name: string } {
  const faux = fauxProvider({
    models: [{ id: "prover", cost: { input: pricePerMillion, output: pricePerMillion * 5, cacheRead: pricePerMillion / 10, cacheWrite: pricePerMillion } }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { models, faux, name: `${model.provider}/${model.id}` };
}

/** A response that checks these regions, declaring a strategy when one is given. */
export function check(proof: string, aux = "", strategy?: string): AssistantMessage {
  return fauxAssistantMessage(
    [fauxText("Let me check this."), fauxToolCall("lean_check", { aux, proof, ...(strategy !== undefined ? { strategy } : {}) })],
    { stopReason: "toolUse" },
  );
}

/** A response that calls a tool other than lean_check. */
export function call(tool: string, args: Parameters<typeof fauxToolCall>[1]): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
}

/** A final message: the notes of the session. */
export function say(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

export function config(name: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return { ...DEFAULT_CONFIG, provers: 1, sessions: 2, selection: { all: true }, model: name, thinkingLevel: "off", ...overrides };
}

export interface DemoRun {
  result: RunResult;
  events: HarnessEvent[];
  dir: string;
}

export async function demoRun(options: {
  responses: FauxResponseStep[];
  config?: Partial<RunConfig>;
  lean?: LeanChecker;
  /** Default: `demoRegistry(lean)`. */
  registry?: (lean: LeanChecker) => RunOptions["registry"];
  problems?: number;
  pricePerMillion?: number;
  certifier?: LeanCertifier;
  signal?: AbortSignal;
  /** The run directory. Default: a new temporary one. */
  dir?: string;
  log?: (line: string) => void;
  /** The lines the run can enable (`config.lines` enables them). Default: the repository's. */
  lines?: LineRegistry;
  /** The bench's Lean file, or its files by name. Default: `DEMO_FILE`. */
  file?: string | Record<string, string>;
  /** Which problems of the file the bench keeps. Default: `DISCRETE`, solved research problems only. */
  filter?: BenchFilter;
}): Promise<DemoRun & { faux: FauxProviderHandle; lean: LeanChecker }> {
  const { checkout, index } = demoBench(options.file, options.filter);
  const { models, faux, name } = fauxModels(options.pricePerMillion);
  faux.setResponses(options.responses);
  const lean = options.lean ?? new DemoLean();
  const dir = options.dir ?? join(tempDir(), "run");
  const result = await runBench({
    config: config(name, options.config),
    index,
    problems: index.problems.slice(0, options.problems ?? 1),
    checkout,
    dir,
    models,
    registry: (options.registry ?? demoRegistry)(lean),
    ...(options.certifier !== undefined ? { certifier: options.certifier } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(options.lines !== undefined ? { lines: options.lines } : {}),
  });
  return { result, events: readEvents(join(dir, "journal.jsonl")), dir, faux, lean };
}

export function ofType<K extends HarnessEvent["type"]>(events: readonly HarnessEvent[], type: K): Array<Extract<HarnessEvent, { type: K }>> {
  return events.filter((e): e is Extract<HarnessEvent, { type: K }> => e.type === type);
}
