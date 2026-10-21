/**
 * Tests that run the real lean-lsp-mcp, for a host that has it: set LEAN_LSP_MCP_PYTHON to a Python with
 * `pip install lean-lsp-mcp==0.31.0` (for example the one of a virtual environment), and run
 *     LEAN_LSP_MCP_PYTHON=/path/to/venv/bin/python pnpm test
 * They need neither Lean nor the network, and are skipped without that variable.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { attemptLines, LEAN_LSP_MCP_VERSION, type Layout } from "../src/index.ts";

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
});
