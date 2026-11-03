import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, type Json } from "@seshat/core";
import type { ProblemContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { LEMMA_KIND, type LemmaData } from "../src/index.ts";

/** A memory in a run on Mathlib revision `rev`, with two computed library lemmas promoted under `rev-a`. */
export async function library(rev: string): Promise<{ memory: MemoryStore; problem: ProblemContext; asked: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "mh-library-"));
  const journal = Journal.open(dir, "run_1");
  const memory = new MemoryStore({
    journal,
    blobs: new BlobStore(join(dir, "blobs")),
    provenance: { modelId: "p/m", promptVersion: "m0-1", mathlibRev: rev, harnessVersion: "t", budgetClass: "small" },
  });
  for (const stem of ["good", "broken"]) {
    const statement = `(n : ℕ) : n + 0 = n + ${stem === "good" ? 0 : 1}`;
    const { claimId, statementId } = await memory.ensureClaim({ statement, header: "import Mathlib", origin: "line:M3" });
    const validationId = `val_${stem}`;
    journal.emit("validation.finished", { validationId, claimId, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" }, "validator");
    journal.emit("claim.status_changed", { claimId, from: "open", to: "computed", reason: "fast check", validationId }, "orchestrator");
    const data: LemmaData = {
      name: `aux_lib_${stem}_000000`,
      statementId,
      claimId,
      statement,
      proof: "omega",
      header: "import Mathlib",
      domain: "general",
      gloss: stem,
      source: { problemId: "p", claimId, attemptId: "a", name: `aux_${stem}` },
      mathlibRev: "rev-a",
    };
    memory.recordNode({ kind: LEMMA_KIND, claimId, data: data as unknown as Json });
  }
  const asked: string[] = [];
  const registry = {
    invoke: async (_id: string, input: { snippets: Array<{ id: string; code: string }> }) => {
      asked.push(...input.snippets.map((s) => s.code));
      return { output: { results: input.snippets.map((s) => ({ id: s.id, status: s.code.includes("broken") ? "lean_error" : "valid" })) } };
    },
  };
  const problem = { line: "M3", memory, registry, signal: new AbortController().signal, log: () => {} } as unknown as ProblemContext;
  return { memory, problem, asked };
}

