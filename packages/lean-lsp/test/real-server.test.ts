/**
 * Tests that run the real lean-lsp-mcp, for a host that has it: set LEAN_LSP_MCP_PYTHON to a Python with
 * `pip install lean-lsp-mcp==0.31.0 leanclient==0.13.2` (for example the one of a virtual environment),
 * and run
 *     LEAN_LSP_MCP_PYTHON=/path/to/venv/bin/python pnpm test
 * They need neither Lean nor the network, and are skipped without that variable. The server is the
 * real one; only its language server and its network call are replaced by canned values
 * (fixtures/real_server_canned.py), so these tests show how the harness reads what the real tools
 * answer and the words of their errors, which the stand-in server (fixtures/fake-lean-lsp-mcp.ts)
 * only imitates.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Json } from "@seshat/core";
import { attemptLines, fileLine, layoutOf, LEAN_LSP_MCP_VERSION, leanLspFactory, type Layout, type LeanLspImplementation } from "../src/index.ts";
import { capability, invoke, onSketch, SKETCH, spec, tempProject } from "./helpers.ts";

const python = process.env.LEAN_LSP_MCP_PYTHON;
const skip =
  python === undefined || python === ""
    ? "needs the real server: set LEAN_LSP_MCP_PYTHON to a Python with lean-lsp-mcp installed (documentation/lean-lsp.md, Tests); not run against a real Lean yet"
    : false;

/** A small seeded generator, so that a failure can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Characters that make a line hard for a port: blanks of several kinds, pairs of UTF-16 units, accents, symbols. */
const POOL = [..."abcxyz_ .-/#:=()[]"].concat(["\t", " ", " ", "𝕜", "é", "∀", " ", "　", "﻿", "⊢", "'", "!"]);


const CANNED = fileURLToPath(new URL("./fixtures/real_server_canned.py", import.meta.url));

/** The factory over the real server with canned back ends; `canned` changes what they answer, between calls. */
function real(settings: Record<string, Json> = {}): { impl: LeanLspImplementation; project: string; canned: (control: Record<string, string>) => void; trials: () => string[] } {
  const project = tempProject();
  const impl = leanLspFactory()({
    capability: capability.manifest,
    spec,
    settings: {
      ...(spec.settings ?? {}),
      command: python as string,
      args: ["-I", CANNED],
      projectDir: project,
      // No cooldown: every failure mode is asked of the server again.
      siteCooldownSec: 0,
      // Sites of the host's own, which the server does not rate limit (the rate limits have a test of their own).
      loogleUrl: "http://127.0.0.1:9",
      hammerUrl: "http://127.0.0.1:9",
      ...settings,
    },
  }) as LeanLspImplementation;
  return {
    impl,
    project,
    canned: (control) => writeFileSync(join(project, ".canned.json"), JSON.stringify(control)),
    trials: () => JSON.parse(readFileSync(join(project, ".canned-trials.json"), "utf8")) as string[],
  };
}

const output = async (impl: LeanLspImplementation, input: Record<string, Json>) => (await invoke(impl, input)) as Record<string, Json>;
const GOAL = "n : ℕ\n⊢ n + 0 = n";

describe("lean.lsp against the real lean-lsp-mcp", { skip }, () => {
  it("builds the document of a tactic as the server's build_attempt_text does", () => {
    const next = random(20261021);
    const pick = (n: number) => Math.floor(next() * n);
    const text = (max: number) => Array.from({ length: pick(max + 1) }, () => POOL[pick(POOL.length)] as string).join("");
    const cases = Array.from({ length: 1500 }, () => {
      const lines = Array.from({ length: 1 + pick(6) }, () => text(12));
      const line = 1 + pick(lines.length);
      const column = 1 + pick([...(lines[line - 1] as string)].length + 1);
      const snippet = Array.from({ length: 1 + pick(4) }, () => text(8)).join("\n") + "\n".repeat([0, 0, 1, 2][pick(4)] as number);
      return { lines, line, column, snippet };
    });
    const dir = mkdtempSync(join(tmpdir(), "mh-lean-lsp-real-"));
    writeFileSync(join(dir, "cases.json"), JSON.stringify(cases));
    const script = fileURLToPath(new URL("./fixtures/real_attempt_texts.py", import.meta.url));
    const printed = execFileSync(python as string, ["-I", script, join(dir, "cases.json")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, maxBuffer: 64 * 1024 * 1024 });
    const real = JSON.parse(printed) as { version: string; documents: string[] };
    assert.equal(real.version, LEAN_LSP_MCP_VERSION, "this is a test of the pinned release");
    assert.equal(real.documents.length, cases.length);
    const different = cases.flatMap((c, k) => {
      const layout = { text: `${c.lines.join("\n")}\n`, lines: c.lines, begin: { aux: 0, proof: 0 }, end: { aux: 0, proof: 0 } } satisfies Layout;
      const ours = `${attemptLines(layout, c.line, c.column, c.snippet).join("\n")}\n`;
      return ours === real.documents[k] ? [] : [{ case: c, ours, real: real.documents[k] }];
    });
    assert.deepEqual(different.slice(0, 2), [], `${different.length} of ${cases.length} documents differ from the real server's`);
  });

  it("finds the release, and the eight tools it uses and no other, when the server switches the rest off", async () => {
    const { impl } = real();
    try {
      const health = await impl.health({ signal: new AbortController().signal });
      assert.equal(health.ok, true, health.detail);
      assert.match(health.detail ?? "", /^Lean LSP 0\.31\.0, 8 tools used; project /);
      assert.doesNotMatch(health.detail ?? "", /never calls/, "the server lists none of the 14 others");
    } finally {
      await impl.close();
    }
  });

  it("answers each operation in the shapes the harness reads, and has the real server elaborate the document the screen examined", async () => {
    const { impl, canned, trials } = real();
    try {
      const line = await output(impl, onSketch({ op: "goal", line: 1 }));
      assert.deepEqual([line.status, line.goalsBefore, line.goalsAfter, line.lineText], ["ok", [GOAL], [GOAL], "  sorry"]);
      assert.deepEqual((await output(impl, onSketch({ op: "goal", line: 1, column: 3 }))).goals, [GOAL]);
      canned({ goal: "complete" });
      assert.equal((await output(impl, onSketch({ op: "goal", line: 1, column: 3 }))).status, "complete");
      canned({ goal: "no_goal" });
      assert.equal((await output(impl, onSketch({ op: "goal", line: 1, column: 3 }))).status, "no_goal_here");
      canned({});
      assert.equal((await output(impl, onSketch({ op: "term_goal", line: 1, column: 3 }))).expectedType, "ℕ");

      const diagnostics = await output(impl, onSketch({ op: "diagnostics" }));
      assert.deepEqual([diagnostics.status, diagnostics.errors, diagnostics.warnings], ["ok", 1, 1]);
      assert.deepEqual((diagnostics.messages as Array<Record<string, Json>>).map((m) => [m.severity, m.region, m.line, m.column]), [
        ["error", "fixed", 3, 1],
        ["warning", "fixed", 3, 9],
      ]);
      canned({ diagnostics: "partial" });
      const partial = await output(impl, onSketch({ op: "diagnostics", timeoutSec: 1 }));
      assert.equal(partial.status, "partial");
      canned({});

      const tactics = ["simp", "omega", "bad_tactic"];
      const attempts = (await output(impl, onSketch({ op: "multi_attempt", line: 1, tactics }))).attempts as Array<Record<string, Json>>;
      assert.deepEqual(attempts.map((a) => [a.tactic, a.result]), [["simp", "open"], ["omega", "closed"], ["bad_tactic", "error"]]);
      assert.deepEqual((attempts[2]?.messages as Array<Record<string, Json>>).map((m) => [m.region, m.line, m.column, m.message]), [["proof", 1, 3, "unknown tactic"]]);
      // The documents that the real build_attempt_text made of the call are those that the harness screens.
      const layout = layoutOf(SKETCH, { aux: "", proof: SKETCH.originalProof });
      const expected = tactics.map((t) => `${attemptLines(layout, fileLine(layout, "proof", 1), 3, t).join("\n")}\n`);
      assert.deepEqual(trials(), expected);

      assert.equal(((await output(impl, { op: "loogle", query: "Nat.add_comm" })).results as Array<Record<string, Json>>)[0]?.name, "Nat.add_comm");
      assert.equal(((await output(impl, { op: "leansearch", query: "add comm" })).results as Array<Record<string, Json>>)[0]?.module, "Mathlib.Algebra");
      const finder = await output(impl, onSketch({ op: "state_search", line: 1 }));
      assert.deepEqual([finder.goal, (finder.results as Array<Record<string, Json>>)[0]?.name], [GOAL, "Nat.add_comm"]);
      assert.deepEqual((await output(impl, onSketch({ op: "hammer_premise", line: 1 }))).premises, ["Nat.add_comm", "Nat.add_zero"]);
    } finally {
      await impl.close();
    }
  });

  it("reads a timeout of the language server as still elaborating, in line mode as at a position", async () => {
    const { impl, canned } = real();
    try {
      canned({ barrier: "timeout" });
      for (const input of [{ op: "goal", line: 1, timeoutSec: 1 }, { op: "goal", line: 1, column: 3, timeoutSec: 1 }, { op: "state_search", line: 1, timeoutSec: 1 }]) {
        const answer = await output(impl, onSketch(input));
        assert.equal(answer.status, "still_elaborating", JSON.stringify(input));
        assert.equal(answer.goalsBefore, undefined);
        assert.equal(answer.results, undefined);
      }
    } finally {
      await impl.close();
    }
  });

  it("takes the words the real server gives to a site that cannot be reached for an outage, and any other failure for a failure of the call", async () => {
    const { impl, canned } = real();
    const ask = (op: string) => output(impl, op === "loogle" || op === "leansearch" ? { op, query: "x" } : onSketch({ op, line: 1 }));
    const sites: Array<[string, string]> = [["loogle", "loogle"], ["leansearch", "leansearch"], ["state_search", "leanfinder"], ["hammer_premise", "hammer"]];
    const outages: Array<[string, RegExp]> = [
      ["http503", /\(HTTP Error 503: Service Unavailable\)/],
      ["dns", /\(<urlopen error \[Errno -2\] Name or service not known>\)/],
      ["refused", /\(<urlopen error \[Errno 111\] Connection refused>\)/],
      ["connect_timeout", /\(<urlopen error timed out>\)/],
      ["timeout", /\(timed out\)/],
      ["reset", /\(\[Errno 104\] Connection reset by peer\)/],
      ["closed", /\(Remote end closed connection without response\)/],
    ];
    try {
      for (const [mode, reason] of outages) {
        for (const [op, site] of sites) {
          canned({ [site]: mode });
          const answer = await ask(op);
          assert.equal(answer.status, "unavailable", `${op} with ${mode}: ${JSON.stringify(answer)}`);
          assert.match(String(answer.unavailable), reason, `${op} with ${mode}`);
        }
      }
      // A site that answers with something that is not JSON is not out of reach: the call fails with what the server said.
      for (const [op, site] of sites) {
        canned({ [site]: "html" });
        await assert.rejects(ask(op), (e: unknown) => e instanceof Error && /unexpected character.*line 1 column 1 \(char 0\)/.test(e.message), op);
      }
    } finally {
      await impl.close();
    }
  });

  it("takes the server's own rate limits for a site out of reach, with the words of the release", async () => {
    // The public Loogle is rate limited by the server (3 requests per 30 s), as Lean Finder is (10 per 30 s).
    const { impl } = real({ loogleUrl: "", leanFinderUrl: "" });
    try {
      const loogle: string[] = [];
      for (let k = 0; k < 4; k++) loogle.push(String((await output(impl, { op: "loogle", query: `q${k}` })).status));
      assert.deepEqual(loogle, ["ok", "ok", "ok", "unavailable"]);
      const limited = await output(impl, { op: "loogle", query: "q4" });
      assert.match(String(limited.unavailable), /^Loogle cannot be reached \(Rate limit exceeded: 3 requests per 30s\.\)/);
      let last: Record<string, Json> = {};
      let asked = 0;
      while (asked < 12 && last.status !== "unavailable") {
        asked++;
        last = await output(impl, onSketch({ op: "state_search", line: 1 }));
      }
      assert.equal(asked, 11, "the eleventh request in 30 s is the first to be refused");
      assert.match(String(last.unavailable), /^Lean Finder cannot be reached \(Tool limit exceeded: 10 requests per 30 s\. Try again later\.\)/);
    } finally {
      await impl.close();
    }
  });
});
