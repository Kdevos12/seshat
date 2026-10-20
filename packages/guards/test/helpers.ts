import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, type ValidationReport } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";

/** A memory over a new journal. The journal is closed by the process's end. */
export function openMemory(): { memory: MemoryStore; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "mh-guards-"));
  const journal = Journal.open(dir, "run_1");
  return { memory: new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }), journal };
}

/** A failed check's report, with these Lean errors. */
export function failed(...errors: string[]): ValidationReport {
  return {
    verdict: "invalid", method: "repl", reasons: [`lean: ${errors.length} error(s)`], axioms: [],
    messages: errors.map((text, k) => ({ severity: "error" as const, pos: { line: 10 + k, column: 2 }, text })),
    sorries: [], checked: "", submissionHash: "h", editsOutsideRegions: false, holes: false, leanStatus: "lean_error",
  };
}
