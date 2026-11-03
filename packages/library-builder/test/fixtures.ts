import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CertificationRequest, CertifyFailedError, type LeanCertifier } from "@seshat/core";
import { type CommandRunner, spawnRunner } from "@seshat/lean-env";
import { type AgentSettings, CodingAgentBuilder, type CodingAgentOptions, type LibrarySpec } from "../src/index.ts";

export const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");

/** A git repository holding a small Lake project: a lakefile and one library file. */
export function projectRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mh-lb-repo-"));
  const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
  sh("init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "lakefile.toml"), 'name = "seshat_env"\n');
  mkdirSync(join(dir, "lean/SeshatLib"), { recursive: true });
  writeFileSync(join(dir, "lean/SeshatLib/Base.lean"), "import Mathlib\n");
  sh("add", "--all");
  sh("commit", "--quiet", "-m", "base");
  return dir;
}

export const SPEC: LibrarySpec = {
  job: "fill",
  domain: "Combinatorics",
  reason: "mulDiv was asked for in three attempts",
  imports: ["Mathlib"],
  items: [{ informal: "Multiply a by b, then divide by b.", expectedName: "mulDiv", kind: "def" }],
  testLemmas: [{ name: "mulDiv_one", statement: "(n : Nat) : mulDiv n 1 = n" }],
};

/** `lake build` that fails on a marker and prints a sorry warning on another; every other command goes to the real program. */
export function fakeRunner(log: string[] = []): CommandRunner {
  return async (command, args, options) => {
    if (command !== "lake") return await spawnRunner(command, args, options);
    log.push(`lake ${args.join(" ")} (in ${options.cwd})`);
    const texts = args.slice(1).map((m) => {
      try {
        return readFileSync(join(options.cwd, "lean", `${m.split(".").join("/")}.lean`), "utf8");
      } catch {
        return "";
      }
    });
    const all = texts.join("\n");
    if (all.includes("BUILDFAIL")) return { code: 1, output: "error: Basic.lean:9:0: unexpected token" };
    if (all.includes("BUILDWARNS")) return { code: 0, output: "warning: Basic.lean:6:8: declaration uses 'sorry'" };
    return { code: 0, output: "Build completed successfully." };
  };
}

/** The statement of `theorem NAME ... :=` in a file, in one line. */
function statementOf(text: string, name: string): string | undefined {
  const m = new RegExp(`theorem\\s+${name}\\b([^]*?):=`).exec(text);
  return m === null ? undefined : (m[1] as string).replace(/\s+/g, " ").trim();
}

/**
 * A certifier that stands in for the kernel: a theorem is certified when the candidate and the reference state it alike,
 * the candidate has no `sorry`, and the theorem extra_fact does not carry the marker CERTFAIL; CERTUNAVAILABLE makes the call fail with no verdict.
 */
export class FakeCertifier implements LeanCertifier {
  readonly implementation = "fake-certifier";
  readonly version = "0";
  readonly calls: CertificationRequest[] = [];
  readonly projectDirs: string[] = [];

  async certify(request: CertificationRequest): Promise<{ verdict: "certified" | "rejected"; reasons: string[]; axioms: string[]; timeMs: number }> {
    this.calls.push(request);
    if (request.candidate.includes("CERTUNAVAILABLE")) throw new CertifyFailedError("unavailable", "no Lean here");
    const short = request.target.split(".").pop() as string;
    const reasons: string[] = [];
    if (short === "extra_fact" && request.candidate.includes("CERTFAIL")) reasons.push("the kernel refuses a declaration");
    if (/\bsorry\b/.test(request.candidate)) reasons.push("the candidate uses sorry");
    if (statementOf(request.candidate, short) !== statementOf(request.original, short)) reasons.push("the statement is not the reference's");
    return { verdict: reasons.length === 0 ? "certified" : "rejected", reasons, axioms: [], timeMs: 1 };
  }
}

export interface Harness {
  repo: string;
  certifier: FakeCertifier;
  commands: string[];
  builder: (scenario: string, extra?: Partial<CodingAgentOptions>, settings?: Partial<AgentSettings>) => CodingAgentBuilder;
}

/** A project, a fake certifier, and a builder that runs the fake agent in a scenario. */
export function harness(): Harness {
  const repo = projectRepo();
  const certifier = new FakeCertifier();
  const commands: string[] = [];
  return {
    repo,
    certifier,
    commands,
    builder: (scenario, extra = {}, settings = {}) =>
      new CodingAgentBuilder({
        settings: { agent: "pi", command: [process.execPath, FAKE_AGENT], unsandboxed: true, env: { FAKE_SCENARIO: scenario }, ...settings },
        repo,
        certifierFor: (dir) => {
          certifier.projectDirs.push(dir);
          return certifier;
        },
        run: fakeRunner(commands),
        ...extra,
      }),
  };
}
