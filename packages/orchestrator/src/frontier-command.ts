import { join, resolve } from "node:path";
import { BlobStore } from "@seshat/core";
import { frontier, frontierMarkdown, MemoryStore } from "@seshat/memory";
import { RunSetupError } from "./setup-error.ts";
import { openForAnswers } from "./team.ts";

/**
 * `harness frontier RUN_DIR [--claim ID] [--json]` (documentation/frontier.md): the verified frontier of each problem of a run that no process
 * works on (or of one claim), read from its journal. No model call and no Lean; nothing is written to the run.
 */
export interface FrontierCommandOptions {
  claimId?: string | undefined;
  json?: boolean | undefined;
  out: (line: string) => void;
}

export function frontierCommand(dir: string, o: FrontierCommandOptions): number {
  const journal = openForAnswers(resolve(dir));
  try {
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(resolve(dir), "blobs")) });
    const problems = journal.projection.problems();
    const claims = o.claimId !== undefined ? [{ problemId: undefined as string | undefined, claimId: o.claimId }] : problems.map((p) => ({ problemId: p.problem_id as string | undefined, claimId: p.claim_id }));
    if (o.claimId !== undefined && memory.claim(o.claimId) === undefined) throw new RunSetupError(`no claim ${o.claimId} in this run`);
    const frontiers = claims.map((c) => ({ ...(c.problemId !== undefined ? { problemId: c.problemId } : {}), ...frontier(memory, c.claimId) }));
    if (o.json === true) {
      o.out(JSON.stringify(frontiers, null, 2));
      return 0;
    }
    if (frontiers.length === 0) o.out("The run has no problem.");
    for (const f of frontiers) {
      const title = `Problem ${"problemId" in f ? f.problemId : f.claimId} (claim ${f.claimId})`;
      o.out(f.entries.length === 0 ? `${title}: nothing established yet.` : `${title}\n${frontierMarkdown(f, { heading: "Established so far" }).trimEnd()}`);
    }
    return 0;
  } finally {
    journal.close();
  }
}
