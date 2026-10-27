/**
 * A run for a test to kill: `node killable-run.ts BENCH.json RUN_DIR SCENARIO`, with the bench the
 * test built (`{checkout, index}` as JSON) and a faux model. Each scenario ends with a prover whose
 * Lean check never answers, so the process stays in the middle of a tool run, in the middle of a
 * session, until the test kills it.
 */
import { readFileSync } from "node:fs";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { BenchIndex } from "@seshat/bench";
import type { RunConfig } from "../../src/index.ts";
import { check, demoRun, say } from "../m0-helpers.ts";

const [benchFile, dir, scenario] = process.argv.slice(2);
if (benchFile === undefined || dir === undefined || scenario === undefined) throw new Error("usage: killable-run.ts BENCH.json RUN_DIR SCENARIO");
const bench = JSON.parse(readFileSync(benchFile, "utf8")) as { checkout: string; index: BenchIndex };

const SCENARIOS: Record<string, { config: Partial<RunConfig>; responses: FauxResponseStep[] }> = {
  // Session 1 fails and leaves notes; session 2 hangs in its check.
  single: { config: { sessions: 3 }, responses: [check("bad"), say("NOTES: bad is not a lemma."), check("slow")] },
  // The prover that calls the model first hangs in its first check; the other one uses its two sessions and ends.
  pair: { config: { provers: 2, sessions: 2 }, responses: [check("slow"), check("bad"), say("NOTES: one."), check("bad"), say("NOTES: two.")] },
};
const chosen = SCENARIOS[scenario];
if (chosen === undefined) throw new Error(`no scenario ${scenario}`);

// A check that waits for an answer holds no handle, so this keeps the process alive; if the test fails to kill it, it ends by itself.
setTimeout(() => process.exit(3), 120_000);

await demoRun({ dir, bench, ...chosen });
process.exit(0);
