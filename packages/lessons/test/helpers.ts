import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal } from "@seshat/core";
import type { FinishedAttempt, Llm, ProblemContext } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";

export function open(): { memory: MemoryStore; journal: Journal; root: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), "mh-lessons-"));
  const journal = Journal.open(dir, "run_1");
  const root = new MemoryStore({
    journal,
    blobs: new BlobStore(join(dir, "blobs")),
    provenance: { modelId: "p/m", promptVersion: "m0-1", mathlibRev: "rev-a", harnessVersion: "t", budgetClass: "small" },
  });
  return { memory: root.withActor("line:M5"), journal, root };
}

let counter = 0;

/** An attempt on `claimId` that was shown `included`, denied `withheld`, and ended `outcome`. */
export function attempt(
  journal: Journal,
  claimId: string,
  o: { included?: string[]; withheld?: string[]; outcome: "valid" | "invalid"; failure?: { class: string; detail: string }; strategy?: string },
): string {
  const attemptId = `att_${++counter}`;
  journal.emit(
    "attempt.started",
    { attemptId, claimId, prover: "p1", iteration: 1, model: "m", ...(o.strategy !== undefined ? { strategy: o.strategy } : {}), ...(o.included !== undefined ? { included: o.included } : {}), ...(o.withheld !== undefined ? { withheld: o.withheld } : {}) },
    "prover:p1",
  );
  journal.emit(
    "attempt.finished",
    {
      attemptId,
      outcome: o.outcome,
      ...(o.failure !== undefined ? { failureClass: o.failure.class, failureDetail: o.failure.detail } : {}),
      durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0,
    },
    "prover:p1",
  );
  return attemptId;
}

export function finished(attemptId: string, o: Partial<FinishedAttempt> = {}): FinishedAttempt {
  return {
    attemptId, prover: "p1", session: 1, model: "m", outcome: "valid", stoppedBy: "done", checks: 1, turns: 1,
    cost: { usd: 0, inputTokens: 0, outputTokens: 0 } as never, durationMs: 1,
    submission: { aux: "", proof: "simp" } as never,
    ...o,
  };
}

/** What the lines' contexts are for these tests: the memory, a claim, a domain, and a model that answers with `answers` in turn. */
export function problem(
  memory: MemoryStore,
  o: { claimId: string; domain?: string[]; human?: boolean; answers?: string[]; options?: Record<string, never> | Record<string, unknown> },
): { context: ProblemContext; logs: string[]; prompts: string[] } {
  const logs: string[] = [];
  const prompts: string[] = [];
  const answers = [...(o.answers ?? [])];
  const llm = {
    complete: async () => {
      throw new Error("not used");
    },
    completeJson: async (request: { prompt: string }) => {
      prompts.push(request.prompt);
      const next = answers.shift();
      if (next === undefined) throw new Error("the model call failed: no answer scripted");
      return { value: { constraint: next }, text: next, cost: { usd: 0 }, model: "faux/m", modelCallId: "mc", modelCallIds: ["mc"] };
    },
  } as unknown as Llm;
  const context = {
    line: "M5", runId: "run_1", problemId: "p1", claimId: o.claimId, domain: o.domain ?? ["msc:11"], memory, llm,
    budget: { exhausted: false, usd: 0 }, log: (t: string) => logs.push(t), signal: new AbortController().signal,
    options: o.options ?? {}, ...(o.human === true ? { human: true } : {}),
  } as unknown as ProblemContext;
  return { context, logs, prompts };
}
