import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ProblemEntry } from "@seshat/bench";
import { provenanceProblems, sha256Hex } from "@seshat/core";
import { buildReport, DEFAULT_CONFIG, REPO_ROOT, type RunConfig, type RunOptions, type RunResult } from "../src/index.ts";
import { feedbackOf, gitDates, modelReflector, optimizePromptsCommand, readDates } from "../src/optimize-command.ts";
import { patchFor, ProposalWriter, unifiedPatch } from "../src/optimize-output.ts";
import { PROMPT_TARGETS, promptTarget } from "../src/prompt-screen.ts";
import { RunSetupError } from "../src/run.ts";
import { scriptedRun } from "./ablate-helpers.ts";
import { fauxModels, tempDir } from "./m0-helpers.ts";

const target = promptTarget("prover.system");
const promptFile = join(REPO_ROOT, target.file);

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

describe("the proposals writer", () => {
  it("writes below its directory and refuses to leave it, by .., by a link, or with a file that is not text", () => {
    const dir = tempDir("mh-prop-");
    const w = new ProposalWriter(join(dir, "out"), REPO_ROOT);
    assert.ok(existsSync(w.write("candidates/c1/prompt.txt", "x")));
    assert.throws(() => w.write("../escape.txt", "x"), /outside the proposals directory/);
    assert.throws(() => w.write("/etc/escape.txt", "x"), /outside the proposals directory/);
    assert.throws(() => w.write("candidates/run.ts", "x"), /nothing else/);
    assert.throws(() => w.write("candidates/x.sh", "x"), /nothing else/);
    const outside = tempDir("mh-outside-");
    symlinkSync(outside, join(dir, "out", "link"));
    assert.throws(() => w.write("link/stolen.txt", "x"), /symbolic link/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it("refuses a directory inside the validator, the guards, the journal, the tests, the bench indexes or any protected tree, and one that holds them", () => {
    for (const tree of ["packages/core/src", "packages/guards", "packages/orchestrator/test", "bench", "lean/SeshatLib", "capabilities", "config", "plans", "documentation", ".git", "packages"]) {
      assert.throws(() => new ProposalWriter(join(REPO_ROOT, tree), REPO_ROOT), /no write access/, tree);
    }
    assert.throws(() => new ProposalWriter(REPO_ROOT, REPO_ROOT), /holds packages\//);
    assert.throws(() => new ProposalWriter(join(REPO_ROOT, ".."), REPO_ROOT), /holds packages\//);
    assert.doesNotThrow(() => new ProposalWriter(join(REPO_ROOT, "proposals", "x"), REPO_ROOT));
  });
});

describe("the proposals directory behind a link", () => {
  it("is judged by where it really is: a link into a protected tree is refused, a link to a free place is not", () => {
    const dir = tempDir("mh-link-");
    symlinkSync(join(REPO_ROOT, "packages", "guards"), join(dir, "into-guards"));
    assert.throws(() => new ProposalWriter(join(dir, "into-guards"), REPO_ROOT), /no write access/);
    assert.throws(() => new ProposalWriter(join(dir, "into-guards", "new", "deeper"), REPO_ROOT), /no write access/);
    symlinkSync(tempDir("mh-free-"), join(dir, "free"));
    assert.doesNotThrow(() => new ProposalWriter(join(dir, "free", "out"), REPO_ROOT));
  });
});

describe("a patch of a prompt file", () => {
  it("applies with git, gives exactly the candidate, and is empty for no change", () => {
    const text = readFileSync(promptFile, "utf8");
    const candidate = target.current.replace("work out the mathematics before writing Lean", "think through the mathematics before you write any Lean").replace("# Method", "# How to work");
    const patch = patchFor(target, candidate, REPO_ROOT);
    assert.match(patch, /^diff --git a\/packages\/orchestrator\/prompts\/prover\.system\.txt b\//);
    const repo = tempDir("mh-patch-");
    mkdirSync(join(repo, dirname(target.file)), { recursive: true });
    writeFileSync(join(repo, target.file), text);
    writeFileSync(join(repo, "p.patch"), patch);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "apply", "--check", "p.patch"]);
    execFileSync("git", ["-C", repo, "apply", "p.patch"]);
    assert.equal(readFileSync(join(repo, target.file), "utf8"), `${candidate}\n`);
    assert.equal(unifiedPatch("f.txt", "a\nb\n", "a\nb\n"), "");
  });

  it("makes several hunks and a pure insertion", () => {
    const before = `${Array.from({ length: 30 }, (_, k) => `line ${k}`).join("\n")}\n`;
    const after = before.replace("line 2\n", "line 2 changed\n").replace("line 25\n", "line 25\nadded\n");
    const patch = unifiedPatch("f.txt", before, after);
    assert.equal((patch.match(/^@@/gm) ?? []).length, 2);
    const repo = tempDir("mh-patch-");
    writeFileSync(join(repo, "f.txt"), before);
    writeFileSync(join(repo, "p.patch"), patch);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "apply", "p.patch"]);
    assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), after);
  });

  it("is refused for a file that is not a prompt file, a text that fails the screen, and a checkout whose prompt has changed", () => {
    assert.throws(() => patchFor({ ...target, file: "packages/guards/src/guards.ts" }, target.current, REPO_ROOT), /not a prompt file/);
    assert.throws(() => patchFor(target, target.current.replace("Never allowed", "Allowed"), REPO_ROOT), /no longer passes the strict screen/);
    const repo = tempDir("mh-patch-");
    mkdirSync(join(repo, dirname(target.file)), { recursive: true });
    copyFileSync(promptFile, join(repo, target.file));
    writeFileSync(join(repo, target.file), `${readFileSync(promptFile, "utf8")}An extra line.\n`);
    assert.throws(() => patchFor(target, target.current, repo), /not the text the optimization started from/);
  });

  it("registers prompt files only", () => {
    for (const t of PROMPT_TARGETS) assert.ok(existsSync(join(REPO_ROOT, t.file)));
  });
});

describe("dates", () => {
  it("reads a dates file and refuses a bad one", () => {
    const dir = tempDir("mh-dates-");
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ "A#a": "2025-01-01" }));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ "A#a": "someday" }));
    assert.deepEqual([...readDates(join(dir, "ok.json"))], [["A#a", "2025-01-01"]]);
    assert.throws(() => readDates(join(dir, "bad.json")), /not an ISO 8601 date for A#a/);
  });

  it("takes the date a file entered the checkout from git, and nothing for a file git does not know", () => {
    const repo = tempDir("mh-git-");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.org", ...args], { env: { ...process.env, GIT_AUTHOR_DATE: "2025-03-01T10:00:00Z", GIT_COMMITTER_DATE: "2025-03-01T10:00:00Z" } });
    git("init", "-q");
    writeFileSync(join(repo, "A.lean"), "a");
    git("add", "A.lean");
    git("commit", "-q", "-m", "a");
    const dates = gitDates(repo, [{ id: "A.lean#a", path: "A.lean" }, { id: "B.lean#b", path: "B.lean" }] as unknown as ProblemEntry[]);
    assert.match(dates.get("A.lean#a") ?? "", /^2025-03-01T/);
    assert.equal(dates.has("B.lean#b"), false);
  });
});

describe("what the rewriting model is told", () => {
  it("reads the attempts and Lean's last complaints of each problem from the journal", () => {
    const p = { id: "p1", fullName: "p1", path: "B.lean" } as unknown as ProblemEntry;
    const run = scriptedRun({ problems: [{ id: "p1", outcome: "unsolved", attempts: [{ usd: 0.1 }, { usd: 0.1 }] }] });
    const text = feedbackOf(run.events, [p, { id: "p2" } as unknown as ProblemEntry]);
    assert.match(text.p1 ?? "", /^2 attempts, 4 turns, stopped by model\./);
    assert.equal(text.p2, "No attempt was recorded.");
  });

  it("asks the model through the models of the run and charges what it cost", async () => {
    const { models, faux, name } = fauxModels();
    faux.setResponses([fauxAssistantMessage("<prompt>\nhello\n</prompt>")]);
    const answer = await modelReflector({ models, model: name, thinkingLevel: "off" })({ system: "s", prompt: "p" });
    assert.equal(answer.text, "<prompt>\nhello\n</prompt>");
    assert.ok(answer.usd > 0);
  });
});

describe("harness optimize-prompts on a simulated bench", () => {
  const entry = (path: string, fullName: string) => ({ id: `${path}#${fullName}`, path, fullName }) as unknown as ProblemEntry;
  const problems = [
    ...["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "o", "p"].map((x) => entry(`Old${x}.lean`, x)),
    ...["n", "m", "q", "r", "s", "t"].map((x) => entry(`New${x}.lean`, x)),
  ];
  const dates = new Map(problems.map((p) => [p.id, p.path.startsWith("New") ? "2026-06-01" : "2025-01-01"]));
  const base: RunConfig = { ...DEFAULT_CONFIG, selection: { all: true }, model: "faux/prover", thinkingLevel: "off", provers: 1, sessions: 2 };
  const template = { index: { benchId: "scripted", source: { rev: "benchrev" } }, checkout: "/nowhere", models: {}, codeRev: "abc123" } as unknown as Omit<RunOptions, "config" | "dir" | "problems" | "runId" | "memoryFrom" | "turns">;
  const improved = target.current.replace("# Method", "# Method (Better)");

  /** Under the merged prompt the prover solves the first problem of each part; under the rewrite it also solves the second. */
  function fakeRun(seen: string[] = []) {
    return async (o: RunOptions): Promise<RunResult> => {
      const marker = o.config.prompts?.proverSystem === undefined ? "merged" : "better";
      seen.push(`${marker}:${o.problems.map((p) => p.fullName).join("")}`);
      const solves = marker === "merged" ? 1 : 99;
      const run = scriptedRun({ problems: o.problems.map((p, k) => (k < solves ? { id: p.id, outcome: "proved" as const, attempts: [{ outcome: "valid" as const, usd: 0.1 }] } : { id: p.id, outcome: "unsolved" as const, attempts: [{ usd: 0.1 }] })) }, o.dir);
      const report = buildReport(run.events);
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
    };
  }

  const command = (dir: string, extra: Partial<Parameters<typeof optimizePromptsCommand>[0]> = {}) => {
    const printed: string[] = [];
    const { models, faux, name } = fauxModels();
    faux.setResponses([fauxAssistantMessage(`<prompt>\n${improved}\n</prompt>`)]);
    return {
      printed,
      args: { template: { ...template, models }, config: { ...base, model: name }, problems, dir, repoRoot: REPO_ROOT, cutoff: "2026-01-01", dates, iterations: 2, minibatch: 3, minGateProblems: 1, ledger: join(tempDir("mh-ledger-"), "gate-ledger.json"), now: () => new Date("2026-11-03T00:00:00.000Z"), print: (l: string) => printed.push(l), ...extra },
    };
  };

  it("finds a better prompt, gates it on the held-out split and the temporal holdout, and writes a patch, evidence and a report without touching a prompt", async () => {
    const before = sha256Hex(readFileSync(promptFile, "utf8"));
    const dir = join(tempDir("mh-opt-"), "out");
    const seen: string[] = [];
    const { args, printed } = command(dir, { run: fakeRun(seen) });
    const result = await optimizePromptsCommand(args);
    assert.equal(result.finalists.length, 1);
    assert.equal(result.finalists[0]?.accepted, true);
    assert.equal(sha256Hex(readFileSync(promptFile, "utf8")), before, "no prompt changed");
    // Everything the command wrote of its own is a proposal, and the measurements are under work/.
    const written = files(dir);
    assert.ok(written.every((f) => /^(report\.md|optimization\.json|candidates\/c\d+\/[\w.-]+\.(txt|json|patch)|work\/.+)$/.test(f)), written.join("\n"));
    assert.ok(written.includes("candidates/c1/prompt.txt") && written.includes("candidates/c1/prover.system.patch") && written.includes("candidates/c1/evidence.json"));
    const evidence = JSON.parse(readFileSync(join(dir, "candidates/c1/evidence.json"), "utf8"));
    assert.deepEqual(provenanceProblems(evidence.provenance), []);
    assert.equal(evidence.provenance.modelId, "faux/prover");
    assert.equal(evidence.provenance.harnessVersion, "abc123");
    assert.equal(evidence.status, "accepted");
    assert.deepEqual(evidence.gates.map((g: { split: string; accepted: boolean }) => [g.split, g.accepted]), [["heldout", true], ["temporal", true]]);
    assert.equal(evidence.promptSha256, sha256Hex(improved));
    assert.equal(readFileSync(join(dir, "candidates/c1/prompt.txt"), "utf8"), `${improved}\n`);
    // The patch applies to the prompt file, and gives the candidate.
    const repo = tempDir("mh-apply-");
    mkdirSync(join(repo, dirname(target.file)), { recursive: true });
    copyFileSync(promptFile, join(repo, target.file));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "apply", join(dir, "candidates/c1/prover.system.patch")]);
    assert.equal(readFileSync(join(repo, target.file), "utf8"), `${improved}\n`);
    // The report says what it is.
    const report = readFileSync(join(dir, "report.md"), "utf8");
    assert.equal(printed.join("\n"), report, "what is printed is what is saved");
    assert.match(report, /^# Prompt optimization: prover\.system/);
    assert.match(report, /SIMULATED/);
    assert.match(report, /### c1: accepted: beats the merged prompt on the held-out split and on the temporal holdout/);
    assert.match(report, /nothing changes until a person merges one/);
    // The merged prompt and the candidate were run on the same held-out and temporal problems.
    const held = seen.filter((s) => (s.split(":")[1] ?? "").length === 6);
    assert.equal(held.length, 4, "the merged prompt and the candidate, each on the held-out and the temporal problems");
    assert.deepEqual(held.filter((s) => s.startsWith("merged")).map((s) => s.split(":")[1]).sort(), held.filter((s) => s.startsWith("better")).map((s) => s.split(":")[1]).sort());
    assert.equal(JSON.parse(readFileSync(args.ledger as string, "utf8"))[0].problems.length, 12, "the gate splits are recorded as spent");
    const optimization = JSON.parse(readFileSync(join(dir, "optimization.json"), "utf8"));
    assert.deepEqual(optimization.splits.temporal.sort(), ["Newm.lean#m", "Newn.lean#n", "Newq.lean#q", "Newr.lean#r", "News.lean#s", "Newt.lean#t"]);
    for (const id of optimization.splits.temporal) assert.ok(!optimization.splits.dev.includes(id) && !optimization.splits.heldout.includes(id));
  });

  it("writes the patch under another name when the gain is indicative only", async () => {
    const dir = join(tempDir("mh-opt-"), "out");
    // The better prompt solves three problems more than the merged one on each split: 3-0 is p=0.125.
    const run = async (o: RunOptions): Promise<RunResult> => {
      const better = o.config.prompts?.proverSystem !== undefined;
      const solves = better ? (o.problems.length >= 6 && o.problems.every((p) => p.path.startsWith("Old")) && o.dir.includes("dev") ? 99 : 4) : 1;
      const r = scriptedRun({ problems: o.problems.map((p, k) => (k < solves ? { id: p.id, outcome: "proved" as const, attempts: [{ outcome: "valid" as const, usd: 0.1 }] } : { id: p.id, outcome: "unsolved" as const, attempts: [{ usd: 0.1 }] })) }, o.dir);
      const report = buildReport(r.events);
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
    };
    const { args } = command(dir, { run });
    const result = await optimizePromptsCommand(args);
    assert.equal(result.finalists[0]?.status, "needs_review");
    const written = files(dir);
    assert.ok(written.includes("candidates/c1/prover.system.needs-review.patch"));
    assert.ok(!written.includes("candidates/c1/prover.system.patch"), "no plain patch for a gain that is indicative only");
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /needs review: beats the merged prompt on both splits, but a gain is indicative only/);
  });

  it("refuses a gate with too few problems, and the reuse of problems an earlier optimization gated on, unless told to", async () => {
    const run = fakeRun();
    await assert.rejects(optimizePromptsCommand(command(join(tempDir(), "o"), { run, minGateProblems: 8 }).args), /fewer than the 8 a gate needs/);
    const ledger = join(tempDir("mh-ledger-"), "gate-ledger.json");
    await optimizePromptsCommand(command(join(tempDir(), "first"), { run, ledger }).args);
    const again = command(join(tempDir(), "second"), { run, ledger });
    await assert.rejects(optimizePromptsCommand(again.args), /already used as a gate by .*first/);
    const allowed = command(join(tempDir(), "third"), { run, ledger, reuseGates: true });
    await optimizePromptsCommand(allowed.args);
    assert.match(readFileSync(join(allowed.args.dir, "report.md"), "utf8"), /already used by .*first/);
    assert.equal(JSON.parse(readFileSync(ledger, "utf8")).length, 2);
  });

  it("writes no patch for a candidate that does not beat the merged prompt on both splits", async () => {
    const dir = join(tempDir("mh-opt-"), "out");
    // A prover that solves more on dev problems and the same as before elsewhere: the gate says no.
    const run = async (o: RunOptions): Promise<RunResult> => {
      const better = o.config.prompts?.proverSystem !== undefined;
      const onDev = o.problems.length > 0 && o.problems.every((p) => p.path.startsWith("Old")) && o.dir.includes("dev");
      const solves = better && onDev ? 3 : 1;
      const r = scriptedRun({ problems: o.problems.map((p, k) => (k < solves ? { id: p.id, outcome: "proved" as const, attempts: [{ outcome: "valid" as const, usd: 0.1 }] } : { id: p.id, outcome: "unsolved" as const, attempts: [{ usd: 0.1 }] })) }, o.dir);
      const report = buildReport(r.events);
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
    };
    const { args } = command(dir, { run });
    const result = await optimizePromptsCommand(args);
    assert.equal(result.finalists[0]?.accepted, false);
    const written = files(dir);
    assert.ok(written.includes("candidates/c1/evidence.json"));
    assert.ok(!written.some((f) => f.endsWith(".patch")), "no patch for a candidate that was not accepted");
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /Nothing was accepted\. The prompt is unchanged, and no patch was written\./);
    assert.equal(JSON.parse(readFileSync(join(dir, "candidates/c1/evidence.json"), "utf8")).status, "rejected");
  });

  it("refuses, before it spends anything, a directory in a protected tree, a split other than dev, a finished directory and a target that is not a prompt file", async () => {
    const spent: string[] = [];
    const run = fakeRun(spent);
    for (const tree of ["packages/guards", "packages/core/src", "bench"]) {
      await assert.rejects(optimizePromptsCommand(command(join(REPO_ROOT, tree, "proposals"), { run }).args), /no write access/);
    }
    await assert.rejects(optimizePromptsCommand(command(join(tempDir(), "o"), { run, split: "heldout" }).args), /--split takes dev/);
    await assert.rejects(optimizePromptsCommand(command(join(tempDir(), "o"), { run, target: "guards" }).args), /no prompt target/);
    const done = tempDir("mh-opt-");
    writeFileSync(join(done, "report.md"), "x");
    await assert.rejects(optimizePromptsCommand(command(done, { run }).args), /holds a finished optimization/);
    await assert.rejects(optimizePromptsCommand(command(join(tempDir(), "o"), { run, cutoff: "2030-01-01" }).args), /no temporal holdout/);
    assert.deepEqual(spent, []);
    assert.equal(existsSync(join(REPO_ROOT, "packages/guards/proposals")), false);
  });

  it("renders a report that says no candidate was measured when none beat the merged prompt on dev", async () => {
    const dir = join(tempDir("mh-opt-"), "out");
    const same = async (o: RunOptions): Promise<RunResult> => {
      const r = scriptedRun({ problems: o.problems.map((p) => ({ id: p.id, outcome: "unsolved" as const, attempts: [{ usd: 0.1 }] })) }, o.dir);
      const report = buildReport(r.events);
      return { runId: report.runId, dir: o.dir, problems: [], usd: report.usd, report };
    };
    const { args } = command(dir, { run: same });
    const result = await optimizePromptsCommand(args);
    assert.equal(result.finalists.length, 0);
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /No candidate beat the merged prompt on dev/);
    assert.ok(!files(dir).some((f) => f.startsWith("candidates/")));
  });
});
