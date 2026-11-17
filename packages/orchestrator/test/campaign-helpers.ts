import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { readEvents, type LeanCertifier } from "@seshat/core";
import { runCampaign, type CampaignEnd, type CampaignOptions, type RunConfig, type RunResult } from "../src/index.ts";
import { certifyingRegistry, check, demoResume, demoRun, tempDir } from "./m0-helpers.ts";
import { consortium } from "./turns-helpers.ts";

/** A campaign's configuration for a test: turns that end at `turnUsd`, an allowance, cold restarts and the frontier. */
export function campaignConfig(o: { turnUsd: number; allowance: number; over?: Partial<RunConfig> }): Partial<RunConfig> {
  return {
    horizon: "campaign",
    human: "digest",
    consortium: consortium({ usd: o.turnUsd }),
    restarts: { base: 2 },
    frontier: { show: true },
    limits: { turns: 3, contextTokens: 120_000 },
    sessions: 1,
    budget: { problemUsd: o.allowance, runUsd: o.allowance },
    campaign: { spiralTurns: 1000 },
    ...o.over,
  };
}

/** Responses that fail a check, as many as a turn could ask for. */
export const failing = (n = 60): FauxResponseStep[] => Array.from({ length: n }, () => check("bad"));

export interface Harness {
  dir: string;
  turns: RunResult[];
  /** What a test does in the gap before turn `n` (n >= 2). */
  before?: (n: number) => void | Promise<void>;
}

/**
 * A campaign over the simulations: its first turn is `demoRun`, the others `demoResume`, with the responses `responses(n)` gives turn n. `extra`
 * goes to `runCampaign` (a clock, a sleep, a signal).
 */
export async function simulatedCampaign(o: {
  config: Partial<RunConfig>;
  responses: (turn: number) => FauxResponseStep[];
  pricePerMillion?: number;
  before?: (n: number, dir: string) => void | Promise<void>;
  wallClock?: () => number;
  extra?: Partial<CampaignOptions>;
  dir?: string;
  certifier?: LeanCertifier;
}): Promise<{ end: CampaignEnd; dir: string; turns: RunResult[]; events: ReturnType<typeof readEvents> }> {
  const dir = o.dir ?? join(tempDir("mh-campaign-"), "run");
  const turns: RunResult[] = [];
  const certified = o.certifier !== undefined ? { certifier: o.certifier, registry: certifyingRegistry(o.certifier) } : {};
  let bench: Awaited<ReturnType<typeof demoRun>>["bench"] | undefined;
  const end = await runCampaign({
    dir,
    first: async () => {
      const run = await demoRun({ dir, config: o.config, responses: o.responses(1), pricePerMillion: o.pricePerMillion ?? 3, ...certified, ...(o.wallClock !== undefined ? { wallClock: o.wallClock } : {}) });
      bench = run.bench;
      turns.push(run.result);
      return run.result;
    },
    next: async ({ limit }) => {
      const n = turns.length + 1;
      await o.before?.(n, dir);
      const run = await demoResume({
        dir,
        bench: bench as NonNullable<typeof bench>,
        responses: o.responses(n),
        pricePerMillion: o.pricePerMillion ?? 3,
        ...certified,
        ...(limit !== undefined ? { turns: { limit } } : {}),
        ...(o.wallClock !== undefined ? { wallClock: o.wallClock } : {}),
      });
      turns.push(run.result);
      return run.result;
    },
    ...o.extra,
  });
  return { end, dir, turns, events: readEvents(join(dir, "journal.jsonl")) };
}
