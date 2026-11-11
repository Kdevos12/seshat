import type { Models } from "@earendil-works/pi-ai";
import { hostProfilePath, loadHostProfile } from "@seshat/registry";
import { consolidate, consolidationDirOf, type ConsolidationResult } from "./consolidate.ts";
import { hostName, REPO_ROOT } from "./implementations.ts";
import { PriceBook } from "./prices.ts";

/**
 * `harness consolidate RUN_DIR [--out DIR] [--model PROVIDER/ID] [--max-usd X]` (documentation/consolidation.md): the consolidation pass over a
 * finished or paused run, written into a new run started on it. Without `--model` no model is called.
 */
export interface ConsolidateCommandOptions {
  out?: string | undefined;
  model?: string | undefined;
  maxUsd?: number | undefined;
  host?: string | undefined;
  models?: Models;
  codeRev?: string | undefined;
  signal?: AbortSignal | undefined;
  print: (line: string) => void;
  log: (line: string) => void;
}

export async function consolidateCommand(runDir: string, o: ConsolidateCommandOptions): Promise<number> {
  const prices = o.model === undefined ? undefined : new PriceBook(loadHostProfile(hostProfilePath(`${REPO_ROOT}config`, hostName(o.host))).models);
  const result = await consolidate({
    from: runDir,
    out: o.out ?? consolidationDirOf(runDir),
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.maxUsd !== undefined ? { maxUsd: o.maxUsd } : {}),
    ...(o.models !== undefined ? { models: o.models } : {}),
    ...(prices !== undefined ? { prices } : {}),
    ...(o.codeRev !== undefined ? { codeRev: o.codeRev } : {}),
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    log: o.log,
  });
  for (const line of summaryLines(result)) o.print(line);
  return 0;
}

export function summaryLines(r: ConsolidationResult): string[] {
  return [
    `${r.alreadyDone ? "The pass had already ended. " : ""}Consolidation ${r.runId} in ${r.dir}`,
    `${r.cards} state card(s), ${r.pages} page(s) from ${r.calls} model call(s) ($${r.usd.toFixed(4)}), ${r.skippedForBudget} problem(s) skipped for budget, ${r.merged} duplicate lesson(s) merged, ${r.flagged} lesson(s) flagged.`,
    `Report: ${r.report}`,
    `Start a run on it with --memory-from ${r.dir}`,
  ];
}
