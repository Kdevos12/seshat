import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CertifyFailedError, STANDARD_AXIOMS, type LeanCertifier } from "@seshat/core";
import type { CommandRunner } from "@seshat/lean-env";
import { type Change, DEFAULT_LIMITS, type DiffLimits, diffViolations } from "./diff.ts";
import { isDefinition, isProof, referenceFor, scanFile, screenFile, type FileScan } from "./source.ts";
import type { LibrarySpec } from "./spec.ts";

/** One rule of the gate and what it found. */
export interface GateCheck {
  rule: "diff" | "content" | "imports" | "spec" | "build" | "build_output" | "certify";
  ok: boolean;
  detail: string;
}

/** A file the gate accepted. */
export interface GateFile {
  path: string;
  content: string;
}

export interface NewDefinition {
  name: string;
  keyword: string;
  /** The module that holds it. */
  module: string;
  /** The spec's test lemmas that were proved (all of them, when the gate accepts). */
  testLemmas: string[];
}

export interface GateReport {
  /** `accepted`: every rule holds. `rejected`: a rule failed on the agent's work. `undecided`: a rule could not be decided (the certifier was unavailable, the build did not run). */
  verdict: "accepted" | "rejected" | "undecided";
  checks: GateCheck[];
  files: GateFile[];
  theorems: string[];
  definitions: NewDefinition[];
  /** A port whose files run code while Lean elaborates: adopted only with a person's approval. */
  needsApproval: boolean;
  /** The unified diff of the accepted files against the base, for the journal. */
  diff: string;
}

/** What building a fresh checkout takes: where Lake runs and what runs before `lake build`. */
export interface BuildPlan {
  /** Relative to the checkout's root. Default `.`. */
  cwd?: string;
  /** Commands before the build, `["lake", "exe", "cache", "get"]`. */
  prepare?: readonly (readonly string[])[];
  /** The `lake` program. Default `lake`. */
  lake?: string;
  /** Where the Lean files are, relative to the root: `lean`, so `lean/SeshatLib/A/B.lean` is `SeshatLib.A.B`. Default `lean`. */
  libRoot?: string;
  /** The time limit of each command, in seconds. Default 3600. */
  timeoutSec?: number;
}

export interface GateOptions {
  spec: LibrarySpec;
  changes: readonly Change[];
  /** The repository the agent started from, trusted: the gate checks out its own copy at `base`. */
  repo: string;
  base: string;
  run: CommandRunner;
  /** The certifier for a Lean project directory (the fresh checkout's root or its `cwd`). */
  certifierFor: (projectDir: string) => LeanCertifier;
  build?: BuildPlan;
  limits?: DiffLimits;
  /** At most this many theorems are certified; more is a rejection (the certifier compiles each one). Default 100. */
  maxTheorems?: number;
  /** Where the gate's checkout is made. Default: the system's temporary directory. */
  workRoot?: string;
  /** The time limit of a certification, in seconds. */
  certifyTimeoutSec?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
const SORRY_OUTPUT = /declaration uses ['`‘]?sorry/i;

/** The import `Foo.Bar` is allowed when a listed module is `Foo.Bar` or a prefix of it, or it is one of the agent's own modules. */
function importAllowed(module: string, spec: LibrarySpec): boolean {
  const own = spec.job === "port" && spec.port !== undefined ? spec.port.name : `SeshatLib.${spec.domain}`;
  const allowed = [...spec.imports, own];
  if (spec.job === "port") allowed.push("Mathlib", "Batteries", "Aesop", "Lean", "Std");
  return allowed.some((a) => module === a || module.startsWith(`${a}.`));
}

function moduleOf(path: string, libRoot: string): string {
  return path.slice(libRoot.length + 1).replace(/\.lean$/, "").split("/").join(".");
}

const lastComponent = (name: string): string => name.split(".").pop() as string;

/** Cuts a long text for a check's detail. */
const clip = (text: string, n = 1500): string => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * Seshat's gate (plan change LC4). The agent never runs any of it. In order: the diff only adds files under the spec's
 * directory; the files pass the validator's token screen (no `sorry`, no axiom, no code that runs while Lean elaborates) and
 * import only what the spec allows; the spec's items and test lemmas are there; a fresh checkout of the base plus these files
 * builds with `lake build`; the build printed no `sorry`; and the certifier certifies every new theorem, each test lemma against the
 * spec's statement of it, as terms. The files are read once, before anything runs, and the checkout is made from those bytes.
 */
export async function runGate(o: GateOptions): Promise<GateReport> {
  const { spec, changes } = o;
  const plan = o.build ?? {};
  const libRoot = plan.libRoot ?? "lean";
  const log = o.log ?? (() => {});
  const checks: GateCheck[] = [];
  const report = (verdict: GateReport["verdict"], extra: Partial<GateReport> = {}): GateReport => ({
    verdict,
    checks,
    files: [],
    theorems: [],
    definitions: [],
    needsApproval: false,
    diff: "",
    ...extra,
  });
  const reject = (rule: GateCheck["rule"], detail: string): GateReport => {
    checks.push({ rule, ok: false, detail });
    return report("rejected");
  };

  // 1. The diff.
  const violations = diffViolations(changes, spec, libRoot, o.limits ?? DEFAULT_LIMITS);
  if (violations.length > 0) return reject("diff", violations.slice(0, 12).join("; "));
  checks.push({ rule: "diff", ok: true, detail: `${changes.length} file(s) added under ${libRoot}/${spec.job === "port" ? `ports/${spec.port?.name}` : `SeshatLib/${spec.domain}`}/` });
  const files: GateFile[] = [];
  for (const c of changes) {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(c.content as Buffer);
    } catch {
      return reject("content", `${c.path} is not valid UTF-8`);
    }
    files.push({ path: c.path, content });
  }
  const lean = files.filter((f) => f.path.endsWith(".lean"));

  // 2. Content: the validator's token screen, and the imports.
  const problems: string[] = [];
  let needsApproval = false;
  const scans = new Map<string, FileScan>();
  for (const f of lean) {
    const screen = screenFile(f.content);
    if (screen.holes.length > 0) problems.push(`${f.path}: ${screen.holes.join(", ")} is not allowed`);
    // A ported package uses strings and quoted names freely; the scanner reads them less exactly than other code, so a port that has
    // them is adopted only with approval. A fill has none, and an unclosed comment is refused in either.
    const hard = screen.problems.filter((p) => spec.job === "fill" || !/string literals|«»/.test(p));
    if (hard.length > 0) problems.push(`${f.path}: ${hard.join("; ")}`);
    if (hard.length < screen.problems.length) needsApproval = true;
    if (screen.meta.length > 0) {
      if (spec.job === "fill") problems.push(`${f.path}: ${screen.meta.join(", ")} is not allowed in a fill`);
      else needsApproval = true;
    }
    const scan = scanFile(f.content);
    scans.set(f.path, scan);
    for (const imp of scan.imports) if (!importAllowed(imp, spec)) problems.push(`${f.path}: imports ${imp}, which the spec does not allow`);
  }
  if (problems.length > 0) return reject("content", problems.slice(0, 12).join("; "));
  checks.push({ rule: "content", ok: true, detail: `${lean.length} Lean file(s) pass the token screen${needsApproval ? " (a port with code that runs while Lean elaborates: adoption needs approval)" : ""}` });

  // 3. The spec: the items, and the test lemmas by name.
  const proofs = lean.flatMap((f) => (scans.get(f.path) as FileScan).declarations.filter(isProof).map((d) => ({ file: f, scan: scans.get(f.path) as FileScan, d })));
  const defs = lean.flatMap((f) => (scans.get(f.path) as FileScan).declarations.filter((d) => isDefinition(d) && d.name !== "").map((d) => ({ file: f, d })));
  const missing: string[] = [];
  for (const item of spec.items) {
    const pool = item.kind === "def" ? defs.map((x) => x.d) : proofs.map((x) => x.d);
    if (!pool.some((d) => lastComponent(d.name) === item.expectedName)) missing.push(`${item.kind} ${item.expectedName}`);
  }
  const testTargets = new Map<string, (typeof proofs)[number]>();
  for (const t of spec.testLemmas) {
    const found = proofs.filter((p) => lastComponent(p.d.name) === t.name);
    if (found.length === 0) missing.push(`test lemma ${t.name}`);
    else if (found.length > 1) missing.push(`test lemma ${t.name} (declared ${found.length} times)`);
    else testTargets.set(t.name, found[0] as (typeof proofs)[number]);
  }
  if (missing.length > 0) return reject("spec", `missing from the new files: ${missing.join(", ")}`);
  if (proofs.length > (o.maxTheorems ?? 100)) return reject("spec", `${proofs.length} new theorems, more than the ${o.maxTheorems ?? 100} the gate certifies`);
  const definitions: NewDefinition[] = defs.map(({ file, d }) => ({
    name: d.name,
    keyword: d.keyword,
    module: moduleOf(file.path, libRoot),
    testLemmas: spec.testLemmas.map((t) => t.name),
  }));
  checks.push({ rule: "spec", ok: true, detail: `${spec.items.length} item(s) and ${spec.testLemmas.length} test lemma(s) are there; ${definitions.length} new definition(s), ${proofs.length} new theorem(s)` });

  // 4. A fresh checkout at the base plus these files, built.
  const root = mkdtempSync(join(o.workRoot ?? tmpdir(), "seshat-gate-"));
  try {
    const checkout = join(root, "checkout");
    const git = async (args: readonly string[], cwd: string) => await o.run("git", [...GIT, ...args], { cwd, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    const cloned = await git(["clone", "--quiet", "--local", "--no-hardlinks", o.repo, checkout], root);
    const checked = cloned.code === 0 ? await git(["checkout", "--quiet", "--detach", o.base], checkout) : cloned;
    if (checked.code !== 0) {
      checks.push({ rule: "build", ok: false, detail: `the gate could not make its checkout: ${clip(checked.output)}` });
      return report("undecided");
    }
    for (const f of files) {
      mkdirSync(dirname(join(checkout, f.path)), { recursive: true });
      writeFileSync(join(checkout, f.path), f.content);
    }
    await git(["add", "--all", "--force"], checkout);
    const diff = (await git(["diff", "--cached", "--no-color", "--no-ext-diff", o.base], checkout)).output;

    const project = join(checkout, plan.cwd ?? ".");
    const lake = plan.lake ?? "lake";
    const modules = spec.job === "port" && spec.port !== undefined ? spec.port.libs : lean.map((f) => moduleOf(f.path, libRoot));
    const commands = [...(plan.prepare ?? []), [lake, "build", ...modules]];
    const limit = AbortSignal.timeout((plan.timeoutSec ?? 3600) * 1000);
    let buildOutput = "";
    for (const argv of commands) {
      const [program, ...args] = argv as readonly string[];
      log(`gate: ${argv.join(" ")}`);
      const signal = o.signal !== undefined ? AbortSignal.any([o.signal, limit]) : limit;
      const result = await o.run(program as string, args, { cwd: project, signal, onLine: (line) => log(`  ${line}`) });
      buildOutput += `${result.output}\n`;
      if (result.code !== 0) {
        const how = result.code === null ? "did not run to its end" : `exited with ${result.code}`;
        // Lake's own failure on the agent's files is the agent's; a program that did not run says nothing about them.
        checks.push({ rule: "build", ok: false, detail: `${argv.join(" ")} ${how}: ${clip(result.output)}` });
        return result.code === null ? report("undecided") : report("rejected");
      }
    }
    checks.push({ rule: "build", ok: true, detail: `${commands.map((c) => c.join(" ")).join("; ")} passed in a fresh checkout` });
    if (SORRY_OUTPUT.test(buildOutput)) return reject("build_output", "the build reports a declaration that uses sorry");
    checks.push({ rule: "build_output", ok: true, detail: "the build printed no sorry" });

    // 5. The certifier, on every new theorem.
    const certifier = o.certifierFor(project);
    const certified: string[] = [];
    for (const { file, d } of proofs) {
      const test = spec.testLemmas.find((t) => lastComponent(d.name) === t.name && testTargets.get(t.name)?.d === d);
      const reference = referenceFor(file.content, d, test?.statement);
      if (reference === undefined) return reject("certify", `${d.name}: its statement cannot be separated from its proof, so it cannot be compared (state it as \`theorem name binders : statement := proof\`)`);
      try {
        const verdict = await certifier.certify(
          { original: reference, candidate: file.content, target: d.name, allowedAxioms: STANDARD_AXIOMS },
          { ...(o.certifyTimeoutSec !== undefined ? { timeoutSec: o.certifyTimeoutSec } : {}), ...(o.signal !== undefined ? { signal: o.signal } : {}) },
        );
        if (verdict.verdict !== "certified") {
          return reject("certify", `${d.name}${test !== undefined ? " (a test lemma, against the spec's statement)" : ""} was rejected: ${verdict.reasons.slice(0, 3).join(" | ")}`);
        }
        certified.push(d.name);
      } catch (error) {
        if (error instanceof CertifyFailedError) {
          checks.push({ rule: "certify", ok: false, detail: `${d.name}: no verdict (${error.reason}): ${error.message}` });
          return report("undecided");
        }
        throw error;
      }
    }
    checks.push({ rule: "certify", ok: true, detail: `${certified.length} theorem(s) certified, ${spec.testLemmas.length} of them test lemmas against the spec's statements` });
    return report("accepted", { files, theorems: certified, definitions, needsApproval, diff });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
