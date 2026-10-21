import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractSubmission, renderSketch, SKETCH_POLICY, structuralCheck, type Json } from "@seshat/core";
import { UnavailableError } from "@seshat/registry";
import { ALLOWED_TOOLS, RefusedError } from "../src/index.ts";
import { FakeLeanLspMcp, GOAL, USED_TOOLS } from "./fixtures/fake-lean-lsp-mcp.ts";
import { build, invoke, onSketch, RICH, SKETCH, tempDir, tempProject } from "./helpers.ts";

const out = (value: Json): Record<string, Json> => value as Record<string, Json>;

describe("lean.lsp over the server: the operations on the sketch file", () => {
  it("gives the goals before and after a line, in the prover's terms", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "goal", line: 1 })));
    assert.deepEqual(answer, { op: "goal", status: "ok", region: "proof", line: 1, lineText: "  sorry", goalsBefore: [GOAL], goalsAfter: [] });
    // PROOF line 1 is the file's line 5; the server is given the file's line.
    assert.deepEqual(fake.of("lean_goal").map((a) => ({ ...a, file_path: "<file>" })), [{ file_path: "<file>", line: 5 }]);
    await impl.close();
  });

  it("gives the goals at a position, with the server's status in words", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    assert.deepEqual(out(await invoke(impl, onSketch({ op: "goal", line: 1, column: 3, timeoutSec: 30 }))), {
      op: "goal", status: "goals", region: "proof", line: 1, column: 3, lineText: "  sorry", goals: [GOAL],
    });
    assert.equal(fake.of("lean_goal")[0]?.column, 3);
    assert.equal(fake.of("lean_goal")[0]?.timeout_s, 30, "the time limit becomes the server's own");
    const done = out(await invoke(impl, onSketch({ op: "goal", line: 1, column: 3, proof: "done" })));
    assert.deepEqual([done.status, done.goals], ["complete", []]);
    const blank = out(await invoke(impl, onSketch({ op: "goal", line: 2, column: 1, proof: "simp\n\nsorry" })));
    assert.deepEqual([blank.status, blank.goals, blank.line], ["no_goal_here", [], 2]);
    await impl.close();
  });

  it("says that Lean was still elaborating, for the goals before and after a line as for a position", async () => {
    // The server waits for the elaboration before it looks at the column: on a time limit it answers
    // `still_elaborating` and no goals, whether or not a column was given.
    const timeout = { structured: { line_context: "  sorry", goals: [], goals_before: null, goals_after: null, status: "still_elaborating" } };
    const fake = new FakeLeanLspMcp().on("lean_goal", () => timeout);
    const { impl } = build(fake);
    const line = out(await invoke(impl, onSketch({ op: "goal", line: 1, timeoutSec: 5 })));
    assert.deepEqual(line, { op: "goal", status: "still_elaborating", region: "proof", line: 1, lineText: "  sorry" });
    const position = out(await invoke(impl, onSketch({ op: "goal", line: 1, column: 3, timeoutSec: 5 })));
    assert.deepEqual([position.status, position.goals, "goalsBefore" in position], ["still_elaborating", undefined, false]);
    await impl.close();
  });

  it("says that Lean was still elaborating, and does not search, when the goal for a search is not there yet", async () => {
    const timeout = { structured: { line_context: "  sorry", goals: [], goals_before: null, goals_after: null, status: "still_elaborating" } };
    const fake = new FakeLeanLspMcp().on("lean_goal", () => timeout);
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "state_search", line: 1, timeoutSec: 5 })));
    assert.deepEqual(answer, { op: "state_search", status: "still_elaborating", region: "proof", line: 1, column: 3, lineText: "  sorry" });
    assert.equal(fake.of("lean_leanfinder").length, 0, "no goal, no search");
    await impl.close();
  });

  it("builds the file from the sketch and the regions, in a scratch directory of the project that git ignores", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    await invoke(impl, onSketch({ op: "goal", line: 1, aux: "lemma aux_a : True := trivial", proof: "simp" }, SKETCH), "att_7");
    const [call] = fake.of("lean_goal");
    assert.match(String(call?.file_path), /^\.seshat-lsp\/att_7-[0-9a-f]{8}\.lean$/);
    const dir = join(project, ".seshat-lsp");
    assert.deepEqual(readdirSync(dir).sort(), [".gitignore", readdirSync(dir).find((f) => f.endsWith(".lean")) as string].sort());
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
    assert.equal(readFileSync(join(project, String(call?.file_path)), "utf8"), renderSketch(SKETCH, "lemma aux_a : True := trivial", "simp"));
    await impl.close();
  });

  it("defaults the proof to the sketch's own and the aux to nothing", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    await invoke(impl, onSketch({ op: "diagnostics" }));
    const file = String(fake.of("lean_diagnostic_messages")[0]?.file_path);
    assert.equal(readFileSync(join(project, file), "utf8"), renderSketch(SKETCH, "", SKETCH.originalProof));
    await impl.close();
  });

  it("gives the type expected at a position", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "term_goal", line: 1, column: 9, proof: "exact Nat.add_zero n" })));
    assert.deepEqual(answer, { op: "term_goal", status: "ok", region: "proof", line: 1, column: 9, lineText: "  exact Nat.add_zero n", expectedType: "n + 0 = n" });
    assert.deepEqual(fake.of("lean_term_goal").map((a) => [a.line, a.column]), [[5, 9]]);
    fake.on("lean_term_goal", () => ({ structured: { line_context: "", expected_type: null } }));
    assert.equal(out(await invoke(impl, onSketch({ op: "term_goal", line: 1 }))).status, "no_term_goal");
    await impl.close();
  });

  it("lists Lean's messages by region and line, errors first, and counts them", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "diagnostics", proof: "simp\nexact bad\nsorry" })));
    assert.deepEqual(answer.messages, [
      { severity: "error", region: "proof", line: 2, column: 9, code: "exact bad", message: "unknown identifier 'bad'" },
      { severity: "warning", region: "fixed", line: 3, column: 9, code: "theorem seshat_contract (n : Nat) : n + 0 = n := by", message: "declaration uses 'sorry'", category: "sorry" },
    ]);
    assert.deepEqual([answer.status, answer.errors, answer.warnings], ["ok", 1, 1]);
    assert.deepEqual(Object.keys(fake.of("lean_diagnostic_messages")[0] ?? {}).sort(), ["file_path"], "no line range, no interactive mode, no declaration filter");
    const errors = out(await invoke(impl, onSketch({ op: "diagnostics", proof: "exact bad\nsorry", severity: "error", timeoutSec: 20 })));
    assert.deepEqual([errors.errors, errors.warnings, (errors.messages as Json[]).length], [1, 0, 1]);
    assert.deepEqual([fake.of("lean_diagnostic_messages")[1]?.severity, fake.of("lean_diagnostic_messages")[1]?.timeout_s], ["error", 20]);
    const aux = out(await invoke(impl, onSketch({ op: "diagnostics", aux: "lemma aux_a : True := bad", proof: "exact bad", region: "aux" })));
    assert.deepEqual((aux.messages as Array<{ region: string; line: number }>).map((m) => [m.region, m.line]), [["aux", 1]]);
    await impl.close();
  });

  it("says when Lean was still elaborating, and what failed to build", async () => {
    const fake = new FakeLeanLspMcp();
    fake.on("lean_diagnostic_messages", () => ({
      structured: { result: { partial: true, still_elaborating_lines: [[5, 6]], success: false, timed_out: false, items: [], failed_dependencies: ["/srv/lean/.lake/packages/mathlib/Mathlib/A.lean"] } },
    }));
    const { impl, project } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "diagnostics" })));
    assert.equal(answer.status, "partial");
    assert.match(String(answer.note), /^Lean was still elaborating when the time limit came, so the list may be incomplete: ask again\. 1 import\(s\) of the file did not build: /);
    assert.ok(!String(answer.note).includes(project));
    await impl.close();
  });

  it("caps a long list of messages and says how many it leaves out", async () => {
    const fake = new FakeLeanLspMcp();
    fake.on("lean_diagnostic_messages", () => ({
      structured: { result: { partial: false, success: false, timed_out: false, items: Array.from({ length: 40 }, (_, k) => ({ severity: "error", message: `e${k}`, line: 5, column: 3 })), failed_dependencies: [] } },
    }));
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "diagnostics" })));
    assert.deepEqual([(answer.messages as Json[]).length, answer.more, answer.errors], [25, 15, 40]);
    await impl.close();
  });

  it("tries several tactics at a line and says what each did", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "multi_attempt", line: 1, tactics: ["omega", "ring", "exact bad"] })));
    assert.deepEqual(answer.attempts, [
      { tactic: "omega", result: "closed", goals: [], messages: [] },
      { tactic: "ring", result: "open", goals: [GOAL], messages: [] },
      { tactic: "exact bad", result: "error", goals: [GOAL], messages: [{ severity: "error", region: "proof", line: 1, column: 9, message: "unknown identifier 'bad'" }] },
    ]);
    const [sent] = fake.of("lean_multi_attempt");
    // The harness names the column the server would default to (the first non-blank character), so
    // that the text it screens is the text the server joins to the tactic.
    assert.deepEqual([sent?.line, sent?.snippets, sent?.column], [5, ["omega", "ring", "exact bad"], 3]);
    await invoke(impl, onSketch({ op: "multi_attempt", line: 1, column: 3, tactics: ["simp"] }));
    assert.equal(fake.of("lean_multi_attempt")[1]?.column, 3);
    await impl.close();
  });

  it("searches Loogle and LeanSearch with the limits it names", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const loogle = out(await invoke(impl, { op: "loogle", query: "  Nat.add_comm \n" }));
    assert.deepEqual(loogle, {
      op: "loogle",
      status: "ok",
      results: [
        { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Init.Core" },
        { name: "Nat.add_zero", type: "∀ (n : ℕ), n + 0 = n", module: "Init.Core" },
      ],
    });
    assert.deepEqual(fake.of("lean_loogle"), [{ query: "Nat.add_comm", num_results: 8 }]);
    const search = out(await invoke(impl, { op: "leansearch", query: "addition is commutative", limit: 1 }));
    assert.deepEqual(search.results, [{ name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Mathlib.Algebra.Group.Nat", kind: "theorem" }]);
    assert.deepEqual(fake.of("lean_leansearch"), [{ query: "addition is commutative", num_results: 1 }]);
    assert.equal(fake.of("lean_goal").length, 0, "a search needs no file");
    assert.equal(existsSync(join(impl["o"].scratch.dir)), false, "and writes none");
    await impl.close();
  });

  it("searches for the goal at a position through Lean Finder, with the goal as the query", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake, { leanFinderVersion: "v4.24.0" });
    const answer = out(await invoke(impl, onSketch({ op: "state_search", line: 1 })));
    assert.deepEqual(answer, {
      op: "state_search",
      status: "ok",
      region: "proof",
      line: 1,
      column: 3,
      lineText: "  sorry",
      goal: GOAL,
      results: [{ name: "Nat.add_zero", type: "∀ (n : ℕ), n + 0 = n", module: "Init.Core", kind: "theorem", description: "adding zero: Adding zero to a natural number changes nothing." }],
    });
    assert.deepEqual(fake.calls.map((c) => c.tool), ["lean_goal", "lean_leanfinder"]);
    assert.equal(fake.of("lean_goal")[0]?.column, 3, "the position defaults to the line's first character");
    assert.deepEqual(fake.of("lean_leanfinder"), [{ query: GOAL, num_results: 5, version: "v4.24.0" }]);
    const none = out(await invoke(impl, onSketch({ op: "state_search", line: 1, column: 3, proof: "done" })));
    assert.deepEqual([none.status, "results" in none], ["complete", false]);
    assert.equal(fake.of("lean_leanfinder").length, 1, "no goal, no search");
    await impl.close();
  });

  it("sends Lean Finder the end of a long goal, where the target is", async () => {
    const fake = new FakeLeanLspMcp();
    fake.on("lean_goal", () => ({ structured: { line_context: "", goals: [`${"h : True\n".repeat(400)}⊢ target`], status: "goals" } }));
    const { impl } = build(fake);
    await invoke(impl, onSketch({ op: "state_search", line: 1 }));
    const query = String(fake.of("lean_leanfinder")[0]?.query);
    assert.equal(query.length, 1500);
    assert.ok(query.endsWith("⊢ target"));
    await impl.close();
  });

  it("asks the premise server for the goal at a position", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "hammer_premise", line: 1 })));
    assert.deepEqual(answer, { op: "hammer_premise", status: "ok", region: "proof", line: 1, column: 3, lineText: "  sorry", premises: ["Nat.add_zero", "Nat.zero_add"] });
    assert.deepEqual(fake.of("lean_hammer_premise").map((a) => [a.line, a.column, a.num_results]), [[5, 3, 16]]);
    const none = out(await invoke(impl, onSketch({ op: "hammer_premise", line: 2, column: 1, proof: "simp\n\nsorry" })));
    assert.deepEqual([none.status, none.premises], ["no_goal_here", undefined]);
    assert.match(String(none.note), /no open goal here/);
    await impl.close();
  });

  it("works on a problem with a prefix and a different indentation, and on the AUX region", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "goal", line: 2, column: 5, aux: "lemma aux_a : True := by\n  trivial", region: "aux" }, RICH)));
    assert.deepEqual([answer.region, answer.line, answer.lineText, answer.status], ["aux", 2, "  trivial", "goals"]);
    const file = readFileSync(join(project, String(fake.of("lean_goal")[0]?.file_path)), "utf8").split("\n");
    assert.equal(file[(fake.of("lean_goal")[0]?.line as number) - 1], "  trivial");
    const proof = out(await invoke(impl, onSketch({ op: "goal", line: 1, proof: "simp" }, RICH)));
    assert.equal(proof.lineText, "    simp", "the proof carries the indentation of the sketch");
    await impl.close();
  });
});

describe("lean.lsp: what it refuses", () => {
  it("refuses regions and tactics that lean_check would, before the server is even started", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 1, proof: "#eval 1" })), (e: unknown) => e instanceof RefusedError && /^Refused before Lean ran; nothing was asked:\n- proof: '#eval' is not allowed/.test(e.message));
    await assert.rejects(invoke(impl, onSketch({ op: "diagnostics", aux: "axiom bad_axiom : False", proof: "simp" })), (e: unknown) => e instanceof RefusedError);
    await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1, tactics: ["omega", "run_cmd 1"] })), (e: unknown) => e instanceof RefusedError && /tactic 2: 'run_cmd' is not allowed/.test(e.message));
    await assert.rejects(invoke(impl, { op: "loogle", query: "" }), /the query is empty/);
    assert.deepEqual([fake.connections, fake.calls.length], [0, 0]);
    assert.equal(existsSync(join(impl["o"].scratch.dir)), false, "and no file was written");
    await impl.close();
  });

  it("refuses a line break that only the language server counts, and writes a CRLF as a line feed", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    await assert.rejects(
      invoke(impl, onSketch({ op: "goal", line: 1, proof: "simp -- note\u2028#eval 1" })),
      (e: unknown) => e instanceof RefusedError && /- proof: remove U\+2028 .*line break/.test(e.message),
    );
    await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1, tactics: ["omega\u0085"] })), (e: unknown) => e instanceof RefusedError && /tactic 1: remove U\+0085/.test(e.message));
    assert.deepEqual([fake.connections, fake.calls.length], [0, 0]);
    const answer = out(await invoke(impl, onSketch({ op: "goal", line: 2, proof: "simp\r\nring" })));
    assert.equal(answer.lineText, "  ring");
    const file = readFileSync(join(project, String(fake.of("lean_goal")[0]?.file_path)), "utf8");
    assert.ok(!file.includes("\r"), "the file has line feeds only, so that its lines are the server's");
    await impl.close();
  });

  it("says what is wrong with a position", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 9 })), /^Error: PROOF has 1 line; there is no line 9$|PROOF has 1 line; there is no line 9/);
    await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 1, region: "aux" })), /AUX is empty, so it has no line 1/);
    await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 1, column: 40 })), /column 40 is past the end of the line, which has 7 characters/);
    await assert.rejects(invoke(impl, onSketch({ op: "goal" })), /goal needs a line of the PROOF region/);
    await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1 })), /multi_attempt needs tactics/);
    await assert.rejects(invoke(impl, { op: "goal", line: 1 }), /works on the problem's sketch/);
    await assert.rejects(invoke(impl, { op: "loogle" }), /loogle needs a query/);
    await assert.rejects(invoke(impl, { op: "build" }), /lean\.lsp has no operation build/);
    await assert.rejects(impl.invoke(onSketch({ op: "goal", line: 1 }) as Json, { signal: new AbortController().signal, timeoutMs: 1000 }), /needs a scope/);
    assert.equal(fake.calls.length, 0);
    await impl.close();
  });

  it("passes what the server says about a position, without the project's paths", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    fake.failing.set("lean_goal", `File not found: ${project}/.seshat-lsp/att_1-0123abcd.lean (looked in ${project})`);
    await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 1 })), (e: unknown) => {
      assert.ok(e instanceof Error && !(e instanceof UnavailableError));
      assert.equal(e.message, "File not found: the sketch file (looked in <project>)");
      return true;
    });
    fake.failing.clear();
    await impl.close();
  });

  it("never calls a tool outside the eight, whatever the server lists", async () => {
    const fake = new FakeLeanLspMcp({ tools: [...USED_TOOLS, "lean_run_code", "lean_build", "lean_declaration_file"] });
    const { impl } = build(fake);
    const input = (op: string, more: Record<string, Json> = {}) => onSketch({ op, line: 1, query: "x", tactics: ["simp"], ...more });
    for (const op of ["goal", "term_goal", "diagnostics", "multi_attempt", "loogle", "leansearch", "state_search", "hammer_premise"]) await invoke(impl, input(op));
    const used = new Set(fake.calls.map((c) => c.tool));
    assert.deepEqual([...used].filter((t) => !(ALLOWED_TOOLS as readonly string[]).includes(t)), []);
    assert.deepEqual([...used].sort(), [...ALLOWED_TOOLS].sort(), "and every one of the eight is used");
    await impl.close();
  });
});

describe("lean.lsp: multi_attempt joins a tactic to the start of its line, and screens what the server elaborates", () => {
  // The server does not try a tactic alone: it replaces the line from the line asked with the first
  // `column - 1` characters of that line followed by the tactic (and every further line of the tactic
  // after the same characters). Each text below is clean alone and in the region, and not joined.
  const SPLICES: Array<[string, string, number, string[], RegExp]> = [
    ["a name cut in two", "Le", 5, ["an.Elab.Command.x"], /'Lean' is not allowed/],
    ["a command cut in two", "run_", 7, ["cmd 1"], /'run_cmd' is not allowed/],
    ["a #eval cut in two", "#ev", 6, ["al 1"], /'#eval' is not allowed/],
    ["a command cut in two on the second line of a tactic", "#ev\nsimp", 6, ["skip\nal 1"], /'#eval' is not allowed/],
    ["a comment closed by the tactic, which frees the line after it", "/- note\n#eval 1\n-/\nsimp", 3, ["-/"], /'#eval' is not allowed/],
  ];

  for (const [name, proof, column, tactics, reason] of SPLICES) {
    it(`refuses ${name}, before the server hears of it`, async () => {
      const fake = new FakeLeanLspMcp();
      const { impl } = build(fake);
      // Each part is accepted alone: that is what makes the splice a way round the screen.
      await assert.doesNotReject(invoke(impl, onSketch({ op: "diagnostics", proof })));
      for (const tactic of tactics) await assert.doesNotReject(invoke(impl, onSketch({ op: "diagnostics", proof: tactic })));
      const before = fake.calls.length;
      await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1, column, proof, tactics })), (e: unknown) => {
        assert.ok(e instanceof RefusedError, String(e));
        assert.match(e.message, reason);
        assert.match(e.message, /^Refused before Lean ran; nothing was asked:\n- tactic 1 /, "it names the tactic");
        return true;
      });
      assert.equal(fake.of("lean_multi_attempt").length, 0, "the server was not asked");
      assert.equal(fake.calls.length, before, "and nothing else was either");
      await impl.close();
    });
  }

  it("says what the server elaborates, and where the tactic is joined", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1, column: 5, proof: "Le", tactics: ["an.Elab.Command.x"] })), (e: unknown) => {
      assert.ok(e instanceof RefusedError);
      assert.equal(e.reasons.length, 1);
      assert.equal(e.reasons[0], "tactic 1 is joined to the first 4 characters of PROOF line 1, so that the server elaborates `Lean.Elab.Command.x`: proof: 'Lean' is not allowed");
      return true;
    });
    await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1, column: 1, proof: "/- note\n#eval 1\n-/\nsimp", tactics: ["-/"] })), (e: unknown) => {
      assert.ok(e instanceof RefusedError);
      assert.equal(e.reasons[0], "tactic 1 takes the place of PROOF line 1, so that the server elaborates the lines around it with `-/`: proof: '#eval' is not allowed");
      return true;
    });
    await impl.close();
  });

  it("lets a clean splice through, with the column the server will join at", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const answer = out(await invoke(impl, onSketch({ op: "multi_attempt", line: 2, column: 3, proof: "intro n\nsimp\nring", tactics: ["omega", "simp\nring"] })));
    assert.equal((answer.attempts as Json[]).length, 2);
    assert.deepEqual(fake.of("lean_multi_attempt").map((a) => [a.line, a.column, a.snippets]), [[6, 3, ["omega", "simp\nring"]]]);
    assert.deepEqual(
      fake.trials.map((t) => t.text.split("\n").slice(4, 8)),
      [["  intro n", "  omega", "  ring", "  -- HARNESS:PROOF:END"], ["  intro n", "  simp", "  ring", "  -- HARNESS:PROOF:END"]],
    );
    await impl.close();
  });

  it("refuses a tactic with more lines than the region has from the line asked: the server would replace what follows the region", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await assert.rejects(invoke(impl, onSketch({ op: "multi_attempt", line: 1, proof: "simp", tactics: ["intro n\nsimp"] })), (e: unknown) => {
      assert.ok(e instanceof RefusedError);
      assert.equal(
        e.reasons[0],
        "tactic 1 has 2 lines, and the server replaces as many lines of the file as a tactic has, from the line asked; PROOF has 1 from there, so it would replace the end of the region and what follows it",
      );
      return true;
    });
    assert.equal(fake.calls.length, 0);
    // The same tactic fits where the region has the lines.
    await assert.doesNotReject(invoke(impl, onSketch({ op: "multi_attempt", line: 1, proof: "simp\nring", tactics: ["intro n\nsimp"] })));
    await impl.close();
  });

  it("sends the tactics with line feeds only, as the file has them", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await invoke(impl, onSketch({ op: "multi_attempt", line: 1, proof: "simp\nring", tactics: ["simp\r\nring"] }));
    assert.deepEqual(fake.of("lean_multi_attempt")[0]?.snippets, ["simp\nring"]);
    await impl.close();
  });

  it("never lets through a splice whose document, as the server builds it, the policy would refuse", async () => {
    // The oracle is the fake's own port of the server's build_attempt_text and the core policy, not the screen under test.
    const proofs = ["Le", "run_", "#ev", "simp", "intro n\nsimp", "/- note\n#eval 1\n-/\nsimp", "-- c", "sim"];
    const tactics = ["an.Elab.Command.x", "cmd 1", "al 1", "omega", "skip\nal 1", "-/", "x#ev\nal 1", "p\nrun_cmd 1"];
    const columns = [undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    let accepted = 0;
    let refused = 0;
    for (const proof of proofs) {
      for (const tactic of tactics) {
        for (const column of columns) {
          const input = onSketch({ op: "multi_attempt", line: 1, proof, tactics: [tactic], ...(column !== undefined ? { column } : {}) });
          const sent = fake.of("lean_multi_attempt").length;
          const trials = fake.trials.length;
          const result = await invoke(impl, input).then(
            () => "accepted" as const,
            (e: unknown) => (e instanceof Error ? ("refused" as const) : Promise.reject(e)),
          );
          if (result === "accepted") {
            accepted++;
            assert.equal(fake.trials.length, trials + 1, JSON.stringify(input));
            const text = fake.trials[trials]?.text ?? "";
            assert.deepEqual(structuralCheck(extractSubmission(text), SKETCH_POLICY), [], `accepted, but the server would elaborate:\n${text}\n${JSON.stringify(input)}`);
          } else {
            refused++;
            assert.equal(fake.of("lean_multi_attempt").length, sent, "a refused call is not sent");
          }
        }
      }
    }
    assert.ok(accepted > 50 && refused > 50, `the combinations cover both outcomes: ${accepted} accepted, ${refused} refused`);
    await impl.close();
  });
});

describe("lean.lsp: the search sites", () => {
  const NETWORK = "loogle error:\n<urlopen error [Errno -2] Name or service not known>";

  it("degrades when a site cannot be reached: an answer that says so, not a failure, and the site is left alone for a while", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, clock } = build(fake);
    fake.failing.set("lean_loogle", NETWORK);
    const first = out(await invoke(impl, { op: "loogle", query: "Nat.add_comm" }));
    assert.deepEqual(first, {
      op: "loogle",
      status: "unavailable",
      unavailable: "Loogle cannot be reached (<urlopen error [Errno -2] Name or service not known>); it is not asked again for 60 second(s). Go on without it.",
    });
    assert.equal(fake.of("lean_loogle").length, 1);
    clock.now += 20_000;
    const second = out(await invoke(impl, { op: "loogle", query: "Nat.add_zero" }));
    assert.equal(second.status, "unavailable");
    assert.equal(second.unavailable, "Loogle is out of reach (<urlopen error [Errno -2] Name or service not known>); it is not asked again for 40 more second(s). Go on without it.");
    assert.equal(fake.of("lean_loogle").length, 1, "within the pause the site is not asked");
    // The other sites, and the file operations, are not affected.
    assert.equal(out(await invoke(impl, { op: "leansearch", query: "add" })).status, "ok");
    assert.equal(out(await invoke(impl, onSketch({ op: "goal", line: 1 }))).status, "ok");
    // After the pause it is asked again.
    clock.now += 41_000;
    fake.failing.clear();
    assert.equal(out(await invoke(impl, { op: "loogle", query: "Nat.add_comm" })).status, "ok");
    assert.equal(fake.of("lean_loogle").length, 2);
    await impl.close();
  });

  it("treats the server's own rate limit, and an HTTP status, as the site being out of reach", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    fake.failing.set("lean_leanfinder", "Tool limit exceeded: 10 requests per 30 s. Try again later.");
    fake.failing.set("lean_hammer_premise", "HTTP Error 502: Bad Gateway");
    const finder = out(await invoke(impl, onSketch({ op: "state_search", line: 1 })));
    assert.deepEqual([finder.status, finder.goal], ["unavailable", GOAL]);
    assert.match(String(finder.unavailable), /^Lean Finder cannot be reached \(Tool limit exceeded: 10 requests per 30 s\. Try again later\.\)/);
    const hammer = out(await invoke(impl, onSketch({ op: "hammer_premise", line: 1 })));
    assert.deepEqual([hammer.status, hammer.unavailable], ["unavailable", "the premise server cannot be reached (HTTP Error 502: Bad Gateway); it is not asked again for 60 second(s). Go on without it."]);
    await impl.close();
  });

  it("fails the call, and does not blame the site, when the site refuses the query", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    fake.failing.set("lean_loogle", "loogle query error: unknown identifier 'foo' Suggestions: bar");
    await assert.rejects(invoke(impl, { op: "loogle", query: "foo" }), (e: unknown) => e instanceof Error && !(e instanceof UnavailableError) && e.message === "loogle query error: unknown identifier 'foo' Suggestions: bar");
    fake.failing.clear();
    assert.equal(out(await invoke(impl, { op: "loogle", query: "foo" })).status, "ok", "and the site is asked again at once");
    await impl.close();
  });

  it("does not hold back a site for a failure of a file operation", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    fake.failing.set("lean_goal", "HTTP Error 403: Forbidden");
    await assert.rejects(invoke(impl, onSketch({ op: "goal", line: 1 })), /HTTP Error 403: Forbidden/);
    await assert.rejects(invoke(impl, onSketch({ op: "state_search", line: 1 })), /HTTP Error 403: Forbidden/);
    fake.failing.clear();
    assert.equal(out(await invoke(impl, onSketch({ op: "state_search", line: 1 }))).status, "ok");
    await impl.close();
  });
});

describe("lean.lsp: the server and its files", () => {
  it("is unavailable when the server reports another version or lacks a tool of the eight", async () => {
    const old = build(new FakeLeanLspMcp({ version: "0.30.0" }));
    await assert.rejects(invoke(old.impl, onSketch({ op: "goal", line: 1 })), (e: unknown) => e instanceof UnavailableError && /reports version 0\.30\.0, the manifest pins 0\.31\.0/.test(e.message));
    const lacking = build(new FakeLeanLspMcp({ tools: USED_TOOLS.filter((t) => t !== "lean_multi_attempt") }));
    await assert.rejects(invoke(lacking.impl, { op: "loogle", query: "x" }), (e: unknown) => e instanceof UnavailableError && /has no tool lean_multi_attempt \(it has lean_goal, /.test(e.message));
    assert.deepEqual(await old.impl.health({ signal: new AbortController().signal }), { ok: false, detail: "the MCP server reports version 0.30.0, the manifest pins 0.31.0" });
  });

  it("answers its health check without touching Lean or a site", async () => {
    const fake = new FakeLeanLspMcp({ tools: [...USED_TOOLS, "lean_run_code"] });
    const { impl, project } = build(fake);
    const health = await impl.health({ signal: new AbortController().signal });
    assert.deepEqual(health, { ok: true, detail: `Lean LSP 0.31.0, 8 tools used; it also lists 1 tool(s) that the harness never calls; project ${project}` });
    assert.deepEqual(fake.calls, [], "no tool was called");
    await impl.close();
  });

  it("opens the connection again after the server went away", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await invoke(impl, { op: "loogle", query: "a" });
    fake.crash();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(out(await invoke(impl, { op: "loogle", query: "b" })).status, "ok");
    assert.equal(fake.connections, 2);
    // A server that goes away while it answers: this call is unavailable, the next one reconnects.
    fake.on("lean_loogle", () => {
      fake.crash();
      return { structured: { items: [] } };
    });
    await assert.rejects(invoke(impl, { op: "loogle", query: "c" }), (e: unknown) => e instanceof UnavailableError && /^the Lean language server stopped/.test(e.message));
    fake.on("lean_loogle", () => ({ structured: { items: [] } }));
    assert.equal(out(await invoke(impl, { op: "loogle", query: "d" })).status, "ok");
    assert.equal(fake.connections, 3);
    await impl.close();
  });

  it("keeps a file for each scope, and deletes it with the scope", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    await invoke(impl, onSketch({ op: "goal", line: 1 }), "att_a");
    await invoke(impl, onSketch({ op: "goal", line: 1, proof: "simp" }), "att_b");
    const files = () => readdirSync(join(project, ".seshat-lsp")).filter((f) => f.endsWith(".lean")).sort();
    assert.equal(files().length, 2);
    assert.deepEqual(fake.of("lean_goal").map((a) => a.file_path === fake.of("lean_goal")[0]?.file_path), [true, false]);
    await impl.release("att_a");
    assert.equal(files().length, 1);
    await impl.release("never_seen");
    await impl.close();
    assert.deepEqual(files(), [], "closing removes what is left");
  });

  it("writes a scope's file again when its regions change, and not when they do not", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl, project } = build(fake);
    const text = async (proof: string) => {
      await invoke(impl, onSketch({ op: "diagnostics", proof }));
      return readFileSync(join(project, String(fake.of("lean_diagnostic_messages").at(-1)?.file_path)), "utf8");
    };
    assert.match(await text("simp"), /\n {2}simp\n/);
    assert.match(await text("omega"), /\n {2}omega\n/);
    assert.match(await text("omega"), /\n {2}omega\n/);
    await impl.close();
  });

  it("serves one call at a time in a scope, so that the file holds the regions of the call that is running", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    const seen: string[] = [];
    fake.on("lean_goal", (args, f) => {
      seen.push(f.lines(String(args.file_path)).join("\n"));
      return { structured: { line_context: "", goals: [GOAL], goals_before: null, goals_after: null, status: "goals" } };
    });
    await Promise.all([
      invoke(impl, onSketch({ op: "goal", line: 1, column: 3, proof: "simp" }), "att_1"),
      invoke(impl, onSketch({ op: "goal", line: 1, column: 3, proof: "omega" }), "att_1"),
      invoke(impl, onSketch({ op: "goal", line: 1, column: 3, proof: "ring" }), "att_2"),
    ]);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map((t) => /\n {2}(simp|omega|ring)\n/.exec(t)?.[1]).sort(), ["omega", "ring", "simp"]);
    // And in each scope the second call saw its own text, not the first's.
    const by = (word: string) => seen.findIndex((t) => t.includes(`\n  ${word}\n`));
    assert.ok(by("simp") < by("omega"), "the calls of one scope ran in order");
    await impl.close();
  });

  it("is a different file for every scope, even when two scopes' names sanitize alike", async () => {
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake);
    await invoke(impl, onSketch({ op: "diagnostics" }), "a/b");
    await invoke(impl, onSketch({ op: "diagnostics" }), "a:b");
    const [one, two] = fake.of("lean_diagnostic_messages").map((a) => String(a.file_path));
    assert.notEqual(one, two);
    assert.match(String(one), /^\.seshat-lsp\/a_b-[0-9a-f]{8}\.lean$/);
    await impl.close();
  });

  it("works from a project it was given by name, and refuses one that is not a Lean project", async () => {
    const project = tempProject();
    const fake = new FakeLeanLspMcp();
    const { impl } = build(fake, { projectDir: project, scratchDir: "scratch/lsp" });
    await invoke(impl, onSketch({ op: "diagnostics" }));
    assert.match(String(fake.of("lean_diagnostic_messages")[0]?.file_path), /^scratch\/lsp\/att_1-[0-9a-f]{8}\.lean$/);
    await impl.close();
    assert.throws(() => build(fake, { projectDir: "" }), (e: unknown) => e instanceof UnavailableError && /needs the Lean project it works in/.test(e.message));
    assert.throws(() => build(fake, { projectDir: "/nonexistent/project" }), (e: unknown) => e instanceof UnavailableError && /is not a directory/.test(e.message));
    assert.throws(() => build(fake, { projectDir: join(project, ".seshat-lsp") }), UnavailableError);
    // The server starts only on a directory with lean-toolchain and a lakefile: say so before starting it.
    const needs = /is not a Lean project \(it needs lean-toolchain and a lakefile\.lean or lakefile\.toml\)/;
    const bare = tempDir();
    assert.throws(() => build(fake, { projectDir: bare }), needs);
    writeFileSync(join(bare, "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
    assert.throws(() => build(fake, { projectDir: bare }), needs, "a toolchain file alone");
    writeFileSync(join(bare, "lakefile.lean"), "import Lake\n");
    assert.doesNotThrow(() => build(fake, { projectDir: bare }), "lakefile.lean");
    const toml = tempDir();
    writeFileSync(join(toml, "lakefile.toml"), 'name = "x"\n');
    assert.throws(() => build(fake, { projectDir: toml }), needs, "a lakefile alone");
    for (const scratchDir of ["/tmp/x", "../x", "a/../../x", "."]) assert.throws(() => build(fake, { projectDir: project, scratchDir }), /scratch directory/, scratchDir);
  });
});
