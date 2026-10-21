import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attemptsOf, classify, goalList, hitsOf, layoutOf, messagesOf, stripToolPrefix, unwrapDiagnostics } from "../src/index.ts";
import { SKETCH } from "./helpers.ts";

// Answers of the real lean-lsp-mcp 0.31.0, read from a run of its server (only its back ends were replaced
// by canned values): the shapes the harness reads. The file is the contract's, proof `sorry`; see layout.test.ts.
const layout = layoutOf(SKETCH, { aux: "", proof: "sorry" });

describe("the answers of lean-lsp-mcp, as the harness reads them", () => {
  it("reads goals as text, or as the pretty form of a structured goal", () => {
    assert.deepEqual(goalList(["n : ℕ\n⊢ n + 0 = n"]), ["n : ℕ\n⊢ n + 0 = n"]);
    assert.deepEqual(goalList([{ status: "open", pretty: "⊢ True", context: [], goal: "True" }]), ["⊢ True"]);
    assert.deepEqual(goalList(null), []);
    assert.deepEqual(goalList(undefined), []);
    assert.equal(goalList(["x".repeat(5000)])[0]?.length, 4000);
  });

  it("locates a message in the region it is in, errors first", () => {
    const messages = messagesOf(
      [
        { severity: "warning", message: "declaration uses 'sorry'", line: 3, column: 9, lean_tags: null, category: "sorry", hint: null },
        { severity: "error", message: "unsolved goals\nn : ℕ\n⊢ n + 0 = n", line: 5, column: 3, lean_tags: ["unsolvedGoals"], category: "diagnostic", hint: "try simp" },
        { severity: "info", message: "Try this: simp", line: 5, column: 3, lean_tags: null, category: "suggestion", hint: null },
      ],
      layout,
      { code: true },
    );
    assert.deepEqual(messages, [
      { severity: "error", region: "proof", line: 1, column: 3, code: "sorry", message: "unsolved goals\nn : ℕ\n⊢ n + 0 = n", hint: "try simp" },
      { severity: "warning", region: "fixed", line: 3, column: 9, code: "theorem seshat_contract (n : Nat) : n + 0 = n := by", message: "declaration uses 'sorry'", category: "sorry" },
      { severity: "info", region: "proof", line: 1, column: 3, code: "sorry", message: "Try this: simp", category: "suggestion" },
    ]);
    assert.deepEqual(messagesOf([{ severity: "error", message: "m", line: 5, column: 1 }], layout, { code: false }), [{ severity: "error", region: "proof", line: 1, column: 1, message: "m" }]);
    assert.deepEqual(messagesOf("nothing", layout, { code: true }), []);
    assert.equal(messagesOf([{ severity: "error", message: "y".repeat(3000), line: 5, column: 1 }], layout, { code: false })[0]?.message.length, 1500);
  });

  it("reads the diagnostics tool's answer, which the server wraps in result", () => {
    assert.deepEqual(unwrapDiagnostics({ result: { items: [], success: true } }), { items: [], success: true });
    assert.deepEqual(unwrapDiagnostics({ items: [], success: true }), { items: [], success: true });
    assert.equal(unwrapDiagnostics("text"), undefined);
  });

  it("classifies what each tactic of multi_attempt did", () => {
    const attempts = attemptsOf(
      [
        { snippet: "omega", goals: [], diagnostics: [], timed_out: false, proof_status: null },
        { snippet: "simp", goals: ["n : ℕ\n⊢ n + 0 = n"], diagnostics: [{ severity: "warning", message: "unused", line: 5, column: 3 }], timed_out: false, proof_status: null },
        { snippet: "exact bad", goals: [], diagnostics: [{ severity: "error", message: "unknown identifier 'bad'", line: 5, column: 9 }], timed_out: false, proof_status: null },
      ],
      layout,
    );
    assert.deepEqual(
      attempts.map((a) => [a.tactic, a.result, a.goals.length, a.messages.length]),
      [["omega", "closed", 0, 0], ["simp", "open", 1, 1], ["exact bad", "error", 0, 1]],
    );
    assert.deepEqual(attempts[2]?.messages[0], { severity: "error", region: "proof", line: 1, column: 9, message: "unknown identifier 'bad'" });
  });

  it("reads the three kinds of search answer into one shape", () => {
    assert.deepEqual(hitsOf("lean_loogle", [{ name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Init.Core" }]), [
      { name: "Nat.add_comm", type: "∀ (n m : ℕ), n + m = m + n", module: "Init.Core" },
    ]);
    assert.deepEqual(hitsOf("lean_leansearch", [{ name: "Nat.add_comm", module_name: "Mathlib.Algebra", kind: "theorem", type: null }]), [
      { name: "Nat.add_comm", module: "Mathlib.Algebra", kind: "theorem" },
    ]);
    assert.deepEqual(
      hitsOf("lean_leanfinder", [{ formal_name: "Nat.add_comm", informal_name: "commutativity", kind: "theorem", type: "∀ n m, n + m = m + n", informal_description: "d", path: "Mathlib.Data.Nat" }]),
      [{ name: "Nat.add_comm", type: "∀ n m, n + m = m + n", module: "Mathlib.Data.Nat", kind: "theorem", description: "commutativity: d" }],
    );
    assert.deepEqual(hitsOf("lean_loogle", [{ type: "no name" }, null, "x"]), []);
  });

  it("tells a site that cannot be reached from a query the site refused", () => {
    assert.equal(stripToolPrefix("lean_goal", "Error executing tool lean_goal: Line 9 out of range (file has 5 lines)"), "Line 9 out of range (file has 5 lines)");
    assert.equal(stripToolPrefix("lean_goal", "plain"), "plain");
    // The network failures the server reports are the text of the exception that urllib raised.
    assert.deepEqual(classify("lean_loogle", "Error executing tool lean_loogle: loogle error:\n<urlopen error [Errno -2] Name or service not known>"), {
      kind: "site",
      site: "loogle",
      reason: "<urlopen error [Errno -2] Name or service not known>",
    });
    assert.deepEqual(classify("lean_leansearch", "Error executing tool lean_leansearch: HTTP Error 403: Forbidden"), { kind: "site", site: "leansearch", reason: "HTTP Error 403: Forbidden" });
    assert.deepEqual(classify("lean_leanfinder", "Error executing tool lean_leanfinder: Tool limit exceeded: 10 requests per 30 s. Try again later."), {
      kind: "site",
      site: "leanfinder",
      reason: "Tool limit exceeded: 10 requests per 30 s. Try again later.",
    });
    assert.deepEqual(classify("lean_loogle", "Error executing tool lean_loogle: Rate limit exceeded: 3 requests per 30s. Use --loogle-local to avoid limits."), {
      kind: "site",
      site: "loogle",
      reason: "Rate limit exceeded: 3 requests per 30s.",
    });
    assert.deepEqual(classify("lean_loogle", "Error executing tool lean_loogle: loogle query error: unknown identifier 'foo' Suggestions: bar"), {
      kind: "query",
      message: "loogle query error: unknown identifier 'foo' Suggestions: bar",
    });
    assert.deepEqual(classify("lean_hammer_premise", "Error executing tool lean_hammer_premise: No goals found at line 5, column 3 (status: no_goal_at_position). Try a different position."), {
      kind: "no_goal",
      status: "no_goal_at_position",
    });
    // The tools that ask no site: the refusal is the tool's.
    assert.deepEqual(classify("lean_goal", "Error executing tool lean_goal: HTTP Error 403: Forbidden"), { kind: "tool", message: "HTTP Error 403: Forbidden" });
  });
});
