import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Json, type LeanChecker, PROOF_BEGIN, PROOF_END, prepareSketch } from "@seshat/core";
import { leanLspFactory } from "@seshat/lean-lsp";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { FakeLeanLspMcp } from "../../lean-lsp/test/fixtures/fake-lean-lsp-mcp.ts";
import { capabilityTool, checkTools, REPO_ROOT, RunSetupError, toolBinding, toolName, type RunOptions } from "../src/index.ts";
import { call, check, DEMO_FILE, demoRun, ofType, say } from "./m0-helpers.ts";

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));

/** A directory that is a Lean project for the factory's checks. */
function leanProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "mh-lsp-project-"));
  writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
  writeFileSync(join(dir, "lakefile.toml"), 'name = "demo"\n');
  return dir;
}

/** The test host: lean.check over the simulated Lean, lean.lsp over the stand-in language server. */
function lspRegistry(fake: FakeLeanLspMcp, project: string | undefined, settings: Record<string, Json> = {}): (lean: LeanChecker) => RunOptions["registry"] {
  if (project !== undefined) fake.projectDir = project;
  const host: HostProfile = {
    host: "test",
    capabilities: {
      "lean.check": { use: ["kimina"] },
      "lean.lsp": { use: ["lean-lsp-mcp"], settings: { "lean-lsp-mcp": { projectDir: project ?? "", ...settings } } },
    },
  };
  return (lean) => (journal, blobs) =>
    new Registry({
      catalog,
      host,
      factories: { kimina: () => leanCheckImplementation(lean), "lean-lsp": leanLspFactory({ transport: () => fake.transport() }) },
      journal,
      blobs,
    });
}

/** What the prover read in the answers of a tool, in the order of its calls: [text, isError]. */
function seen(dir: string, attemptId: string, tool: string): Array<[string, boolean]> {
  return (JSON.parse(readFileSync(join(dir, "transcripts", `${attemptId}.json`), "utf8")) as AgentMessage[]).flatMap((m) =>
    m.role === "toolResult" && m.toolName === tool ? [[(m.content[0] as { text: string }).text, m.isError] as [string, boolean]] : [],
  );
}

describe("tools besides lean_check: lean.lsp", () => {
  it("is the tool lean_lsp, whose parameters do not show the sketch, which the harness fills in", () => {
    const fake = new FakeLeanLspMcp();
    const registry = lspRegistry(fake, leanProject())({} as LeanChecker)(undefined as never, undefined as never);
    assert.equal(toolName("lean.lsp"), "lean_lsp");
    assert.deepEqual(checkTools(registry, ["lean.lsp"]), []);
    const plain = capabilityTool("lean.lsp", { registry, attemptId: "att_1", actor: "prover:p1" });
    assert.ok("sketch" in ((plain.parameters as { properties: object }).properties));
    const sketch = { fullName: "x", declaredName: "x", statement: "", prefix: "", header: "", originalProof: "sorry", suffix: "", indent: "  " };
    const bound = capabilityTool("lean.lsp", {
      registry,
      attemptId: "att_1",
      actor: "prover:p1",
      binding: { hidden: ["sketch"], bind: (params) => ({ ...params, sketch: sketch as unknown as Json }) },
    });
    const parameters = bound.parameters as { required: string[]; properties: Record<string, object>; additionalProperties: boolean };
    assert.deepEqual(Object.keys(parameters.properties), ["op", "aux", "proof", "region", "line", "column", "tactics", "query", "limit", "severity", "timeoutSec"]);
    assert.deepEqual(parameters.required, ["op"]);
    assert.equal(parameters.additionalProperties, false);
  });

  it("binds the tool to the problem: its sketch replaces any a call carries, and the regions default to the last check's", async () => {
    const fake = new FakeLeanLspMcp();
    const registry = lspRegistry(fake, leanProject())({} as LeanChecker)(undefined as never, undefined as never);
    const sketch = prepareSketch(DEMO_FILE, "Demo.add_zero'");
    const state = { regions: { aux: "", proof: "simp" } };
    const binding = toolBinding("lean.lsp", { sketch, current: () => state.regions });
    assert.ok(binding);
    assert.equal(toolBinding("compute.sage", { sketch, current: () => state.regions }), undefined, "no other capability has a binding");
    const tool = capabilityTool("lean.lsp", { registry, attemptId: "att_1", actor: "prover:p1", binding });
    const forged = { fullName: "x", declaredName: "x", statement: "", prefix: "import Evil", header: "", originalProof: "", suffix: "", indent: "" };
    try {
      // Called as pi does after its own check; here without it, to see what the binding does by itself.
      const first = await tool.execute("c1", { op: "goal", line: 1, sketch: forged } as never);
      assert.notEqual(first.isError, true, JSON.stringify(first.content));
      state.regions = { aux: "", proof: "omega" };
      await tool.execute("c2", { op: "goal", line: 1 } as never);
      await tool.execute("c3", { op: "goal", line: 1, proof: "ring" } as never);
    } finally {
      await registry.close();
    }
    const files = fake.calls.map((c) => c.file ?? "");
    assert.ok(files.every((file) => file.startsWith("import FormalConjectures.Util.ProblemImports\n") && !file.includes("Evil")));
    assert.deepEqual(files.map((file) => file.split("\n").filter((l) => /^ {2}(simp|omega|ring)$/.test(l))), [["  simp"], ["  omega"], ["  ring"]]);
  });

  it("reads the file of the prover's last lean_check, answers in the prover's terms, and is journaled like any tool", async () => {
    const fake = new FakeLeanLspMcp();
    const project = leanProject();
    const { result, events, dir } = await demoRun({
      registry: lspRegistry(fake, project),
      config: { tools: ["lean.lsp"], sessions: 1 },
      responses: [
        call("lean_lsp", { op: "goal", line: 1 }),
        check("bad"),
        call("lean_lsp", { op: "diagnostics" }),
        call("lean_lsp", { op: "multi_attempt", line: 1, tactics: ["exact trivial_proof", "bad"] }),
        call("lean_lsp", { op: "loogle", query: "Nat.add_comm" }),
        check("exact trivial_proof"),
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");

    // The tools the language server was asked for, and the file each time: first the sketch as given, then the last check's.
    const files = fake.calls.filter((c) => c.file !== undefined);
    assert.deepEqual(fake.calls.map((c) => c.tool), ["lean_goal", "lean_diagnostic_messages", "lean_multi_attempt", "lean_loogle"]);
    const proofOf = (text: string | undefined) => {
      const lines = (text ?? "").split("\n");
      return lines.slice(lines.findIndex((l) => l.trim() === PROOF_BEGIN) + 1, lines.findIndex((l) => l.trim() === PROOF_END));
    };
    assert.deepEqual(proofOf(files[0]?.file), ["  sorry"], "before any check: the sketch's own proof");
    assert.deepEqual(proofOf(files[1]?.file), ["  bad"], "after lean_check: its regions");
    assert.deepEqual(proofOf(files[2]?.file), ["  bad"]);
    assert.ok((files[0]?.file ?? "").startsWith("import FormalConjectures.Util.ProblemImports\n\nnamespace Demo"), "the problem's own file");
    assert.deepEqual(fake.of("lean_multi_attempt")[0]?.snippets, ["exact trivial_proof", "bad"]);

    // Each call is a tool run of the attempt, in its scope, on the pinned implementation.
    const [attemptId] = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    const runs = ofType(events, "tool_run.started").filter((e) => e.data.capability === "lean.lsp");
    assert.deepEqual(
      runs.map((e) => [e.data.attemptId, e.data.scope, e.data.implementation, e.data.version]),
      Array(4).fill([attemptId, attemptId, "lean-lsp-mcp", "0.31.0"]),
    );
    const started = ofType(events, "run.started")[0]?.data.config as { tools: unknown[] };
    assert.deepEqual(started.tools, [{ capability: "lean.lsp", implementation: "lean-lsp-mcp", version: "0.31.0" }]);
    assert.deepEqual(result.report.tools["lean.lsp"], { calls: 4, outcomes: { ok: 4 }, attempts: 1, proofs: 1 });
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /tools: lean_check, lean\.lsp \(lean-lsp-mcp 0\.31\.0\)\./);

    // What the prover read.
    const [goal, diagnostics, tried, found] = seen(dir, attemptId as string, "lean_lsp");
    assert.deepEqual(goal, ["Before PROOF line 1, `sorry`: 1 goal(s)\nn : Nat\n⊢ n + 0 = n\n\nAfter PROOF line 1, `sorry`: no goal.", false]);
    // The error is in the prover's region; the warning is Lean's, about the other theorem of the file that still has its sorry.
    assert.match(
      diagnostics?.[0] ?? "",
      /^Lean's messages on the file: 1 error\(s\), 1 warning\(s\)\.\n1\. error, PROOF line 1, column 3, `bad`:\n {3}unknown identifier 'bad'\n2\. warning, line \d+ of the fixed part, column 9, `theorem add_zero' /,
    );
    assert.match(tried?.[0] ?? "", /\n1\. `exact trivial_proof`: leaves 1 goal\(s\)\.[\s\S]*\n2\. `bad`: gives an error\./);
    assert.match(found?.[0] ?? "", /^Loogle found 2 declaration\(s\):\n- Nat\.add_comm : /);

    // The attempt's file went with the attempt.
    assert.deepEqual(readdirSync(join(project, ".seshat-lsp")).filter((f) => f.endsWith(".lean")), []);
  });

  it("refuses a sketch or a path in a prover's call: the problem's own file is the only one, and the language server hears of nothing else", async () => {
    const fake = new FakeLeanLspMcp();
    const forged = { fullName: "x", declaredName: "x", statement: "", prefix: "import Evil", header: "", originalProof: "", suffix: "", indent: "" };
    const { events, dir } = await demoRun({
      registry: lspRegistry(fake, leanProject()),
      config: { tools: ["lean.lsp"], sessions: 1 },
      responses: [
        call("lean_lsp", { op: "goal", line: 1, sketch: forged }),
        call("lean_lsp", { op: "goal", line: 1, file_path: "/etc/passwd" }),
        call("lean_lsp", { op: "build" }),
        check("exact trivial_proof"),
      ],
    });
    const [attemptId] = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    const answers = seen(dir, attemptId as string, "lean_lsp");
    assert.equal(answers.length, 3);
    assert.ok(answers.every(([, isError]) => isError), "all three are refused");
    assert.match(answers[0]?.[0] ?? "", /^Validation failed for tool "lean_lsp":\n {2}- sketch: schema is false/);
    assert.match(answers[1]?.[0] ?? "", /^Validation failed for tool "lean_lsp":\n {2}- file_path: schema is false/);
    assert.match(answers[2]?.[0] ?? "", /^Validation failed for tool "lean_lsp":\n {2}- op: must be equal to one of the allowed values/);
    assert.deepEqual(fake.calls, [], "the server heard of none of them");
    assert.equal(ofType(events, "tool_run.started").filter((e) => e.data.capability === "lean.lsp").length, 0);
  });

  it("never changes a claim's status or records a validation: only lean_check does", async () => {
    const fake = new FakeLeanLspMcp();
    // A language server that says the proof is complete and the file has no error.
    fake.on("lean_goal", (args, f) => ({
      structured: { line_context: f.lines(String(args.file_path))[Number(args.line) - 1], goals: [], goals_before: null, goals_after: null, status: "complete" },
    }));
    fake.on("lean_diagnostic_messages", () => ({
      structured: { result: { partial: false, still_elaborating_lines: null, success: true, timed_out: false, items: [], failed_dependencies: [] } },
    }));
    const { result, events, dir } = await demoRun({
      registry: lspRegistry(fake, leanProject()),
      config: { tools: ["lean.lsp"], sessions: 1 },
      responses: [
        call("lean_lsp", { op: "goal", line: 1, column: 3, proof: "exact trivial_proof" }),
        call("lean_lsp", { op: "diagnostics", proof: "exact trivial_proof" }),
        say("Lean's server says it is complete; I did not check."),
      ],
    });
    const [attemptId] = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    const [goal, diagnostics] = seen(dir, attemptId as string, "lean_lsp");
    assert.match(goal?.[0] ?? "", /Lean's language server reports no goal left here\. That is not a verdict: only lean_check judges a proof\./);
    assert.match(diagnostics?.[0] ?? "", /^Lean's messages on the file: 0 error\(s\), 0 warning\(s\)\.$/);
    assert.equal(ofType(events, "validation.finished").length, 0);
    assert.equal(ofType(events, "claim.status_changed").length, 0);
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.deepEqual(ofType(events, "attempt.finished").map((e) => e.data.outcome), ["no_submission"]);
    // The claim is as the run found it.
    const claim = ofType(events, "claim.created")[0]?.data.claimId;
    assert.ok(typeof claim === "string");
    assert.equal(events.filter((e) => e.type.startsWith("validation.") || e.type === "claim.status_changed").length, 0);
  });

  it("goes on when a search site is down: the answer says so, the site is left alone, and the run is not failed", async () => {
    const fake = new FakeLeanLspMcp();
    // The words of the exception urllib raises, as the server passes them on.
    fake.failing.set("lean_loogle", "loogle error:\n<urlopen error [Errno 111] Connection refused>");
    const { result, events, dir } = await demoRun({
      registry: lspRegistry(fake, leanProject()),
      config: { tools: ["lean.lsp"], sessions: 1 },
      responses: [
        call("lean_lsp", { op: "loogle", query: "Nat.add_comm" }),
        call("lean_lsp", { op: "loogle", query: "Nat.add_zero" }),
        call("lean_lsp", { op: "goal", line: 1 }),
        check("exact trivial_proof"),
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const [attemptId] = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    const answers = seen(dir, attemptId as string, "lean_lsp");
    assert.deepEqual(answers.map(([, isError]) => isError), [false, false, false]);
    assert.match(answers[0]?.[0] ?? "", /^Loogle cannot be reached \(<urlopen error \[Errno 111\] Connection refused>\); it is not asked again for 60 second\(s\)\. Go on without it\.$/);
    assert.match(answers[1]?.[0] ?? "", /^Loogle is out of reach \(<urlopen error \[Errno 111\] Connection refused>\); it is not asked again for 60 more second\(s\)\. Go on without it\.$/);
    assert.match(answers[2]?.[0] ?? "", /^Before PROOF line 1/, "the other operations are not affected");
    assert.equal(fake.of("lean_loogle").length, 1, "the site was asked once");
    const finished = ofType(events, "tool_run.finished").filter((e) => (e.data.summary as { status?: string } | undefined)?.status !== undefined);
    assert.deepEqual(finished.map((e) => [e.data.outcome, (e.data.summary as { status: string }).status]), [["ok", "unavailable"], ["ok", "unavailable"], ["ok", "ok"]]);
    assert.deepEqual(result.report.tools["lean.lsp"]?.outcomes, { ok: 3 });
  });

  it("stops asking the language server for the rest of the session when it dies, and the prover goes on with lean_check", async () => {
    const fake = new FakeLeanLspMcp();
    fake.on("lean_goal", (_args, f) => {
      f.crash();
      return { structured: {} };
    });
    const { result, events, dir } = await demoRun({
      registry: lspRegistry(fake, leanProject()),
      config: { tools: ["lean.lsp"], sessions: 1 },
      responses: [call("lean_lsp", { op: "goal", line: 1 }), call("lean_lsp", { op: "goal", line: 1 }), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const [attemptId] = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    const [first, second] = seen(dir, attemptId as string, "lean_lsp");
    assert.equal(first?.[1], true);
    assert.match(first?.[0] ?? "", /^Error: lean_lsp cannot be reached \(.*Lean language server stopped.*\)\. Go on without it: it stays unavailable in this session\.$/);
    assert.match(second?.[0] ?? "", /^Error: lean_lsp is unavailable in this session/);
    assert.equal(fake.of("lean_goal").length, 1, "the second call never reached the server");
    assert.equal(fake.connections, 1);
    assert.equal(ofType(events, "tool_run.started").filter((e) => e.data.capability === "lean.lsp").length, 1);
  });

  it("tells the prover what is wrong with a call: a line outside the region, a refused tactic, a position past the line", async () => {
    const fake = new FakeLeanLspMcp();
    const { events, dir } = await demoRun({
      registry: lspRegistry(fake, leanProject()),
      config: { tools: ["lean.lsp"], sessions: 1 },
      responses: [
        call("lean_lsp", { op: "goal", line: 7 }),
        call("lean_lsp", { op: "multi_attempt", line: 1, tactics: ["native_decide"] }),
        call("lean_lsp", { op: "goal", line: 1, column: 40 }),
        call("lean_lsp", { op: "goal", line: 1, proof: "import Mathlib" }),
        check("exact trivial_proof"),
      ],
    });
    const [attemptId] = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    const answers = seen(dir, attemptId as string, "lean_lsp");
    assert.ok(answers.every(([, isError]) => isError));
    assert.match(answers[0]?.[0] ?? "", /^Error: PROOF has 1 line; there is no line 7/);
    assert.match(answers[1]?.[0] ?? "", /^Error: Refused before Lean ran; nothing was asked:\n- tactic 1: 'native_decide' is not allowed/);
    assert.match(answers[2]?.[0] ?? "", /^Error: column 40 is past the end of the line, which has 7 characters/);
    assert.match(answers[3]?.[0] ?? "", /^Error: Refused before Lean ran; nothing was asked:\n- proof: /);
    assert.deepEqual(fake.calls, [], "the server heard of none of them");
  });

  it("is a turn of the prover and costs what the model's response costs, like any other tool", async () => {
    const fake = new FakeLeanLspMcp();
    const { events, result } = await demoRun({
      registry: lspRegistry(fake, leanProject()),
      config: { tools: ["lean.lsp"], sessions: 1, limits: { turns: 2, contextTokens: 100_000 } },
      responses: [call("lean_lsp", { op: "goal", line: 1 }), call("lean_lsp", { op: "goal", line: 1 })],
    });
    const [attempt] = ofType(events, "attempt.finished");
    assert.deepEqual([attempt?.data.outcome, attempt?.data.stoppedBy, attempt?.data.turns], ["no_submission", "turns", 2]);
    assert.ok((attempt?.data.usd ?? 0) > 0);
    assert.equal(result.problems[0]?.outcome, "unsolved");

    // And the problem's budget stops a prover that only looks.
    const costly = new FakeLeanLspMcp();
    const stopped = await demoRun({
      registry: lspRegistry(costly, leanProject()),
      pricePerMillion: 100_000,
      config: { tools: ["lean.lsp"], budget: { problemUsd: 1 } },
      responses: [call("lean_lsp", { op: "goal", line: 1 }), call("lean_lsp", { op: "goal", line: 1 }), call("lean_lsp", { op: "goal", line: 1 })],
    });
    assert.equal(stopped.result.problems[0]?.reason, "the problem's budget ran out");
    assert.deepEqual(ofType(stopped.events, "attempt.finished").map((a) => a.data.outcome), ["budget_exhausted"]);
    assert.ok((ofType(stopped.events, "attempt.finished")[0]?.data.usd ?? 0) >= 1);
    assert.deepEqual(costly.of("lean_goal"), [], "the response that used the budget up ended the session before its tool call");
  });

  it("gives every attempt its own file, so that provers working at once do not read each other's regions", async () => {
    const fake = new FakeLeanLspMcp();
    const project = leanProject();
    const { events } = await demoRun({
      registry: lspRegistry(fake, project),
      config: { tools: ["lean.lsp"], sessions: 2 },
      responses: [
        check("first attempt, bad"),
        call("lean_lsp", { op: "diagnostics" }),
        say("NOTES: bad."),
        call("lean_lsp", { op: "goal", line: 1 }),
        check("exact trivial_proof"),
      ],
    });
    const attempts = ofType(events, "attempt.started").map((e) => e.data.attemptId as string);
    assert.equal(attempts.length, 2);
    const paths = fake.calls.map((c) => String(c.args.file_path));
    assert.equal(new Set(paths).size, 2, "one file for each attempt");
    assert.ok(paths.every((p) => p.startsWith(".seshat-lsp/")), "inside the project's scratch directory");
    // The second session starts from the regions the first one ended with.
    assert.match(fake.calls[1]?.file ?? "", /first attempt, bad/);
    assert.deepEqual(readdirSync(join(project, ".seshat-lsp")).filter((f) => f.endsWith(".lean")), []);
  });
});

describe("the run with --tool lean.lsp", () => {
  const attempt = async (registry: (lean: LeanChecker) => RunOptions["registry"], tools: string[] = ["lean.lsp"]): Promise<string> => {
    try {
      await demoRun({ responses: [], config: { tools }, registry });
    } catch (error) {
      assert.ok(error instanceof RunSetupError);
      return error.message;
    }
    return assert.fail("the run started");
  };

  it("refuses to start when the language server is not the pinned release", async () => {
    const message = await attempt(lspRegistry(new FakeLeanLspMcp({ version: "0.30.0" }), leanProject()));
    assert.match(message, /^lean\.lsp cannot be reached on host test \(lean-lsp-mcp: .*reports version 0\.30\.0, the manifest pins 0\.31\.0.*\)$/);
  });

  it("refuses to start without a Lean project, saying how to name one", async () => {
    const message = await attempt(lspRegistry(new FakeLeanLspMcp(), undefined));
    assert.match(message, /^lean\.lsp cannot be reached on host test \(lean-lsp-mcp: lean\.lsp needs the Lean project it works in: set LEAN_PROJECT_DIR/);
  });

  it("refuses to start when the project is not a Lean project, or the server lacks a tool it uses", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mh-lsp-empty-"));
    assert.match(await attempt(lspRegistry(new FakeLeanLspMcp(), empty)), /is not a Lean project \(it needs lean-toolchain and a lakefile\.lean or lakefile\.toml\)/);
    assert.match(await attempt(lspRegistry(new FakeLeanLspMcp({ tools: ["lean_goal"] }), leanProject())), /lean_diagnostic_messages/);
  });

  it("leaves no scratch file in the project after the run", async () => {
    const fake = new FakeLeanLspMcp();
    const project = leanProject();
    await demoRun({
      registry: lspRegistry(fake, project),
      config: { tools: ["lean.lsp"] },
      responses: [call("lean_lsp", { op: "goal", line: 1 }), check("exact trivial_proof")],
    });
    assert.ok(existsSync(join(project, ".seshat-lsp")));
    assert.deepEqual(readdirSync(join(project, ".seshat-lsp")).filter((f) => f.endsWith(".lean")), []);
  });
});
