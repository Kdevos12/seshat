import { type BlobStore, type Journal, newId, TASK_WRITER } from "@seshat/core";
import { createDecide, type DecideConfig, registryBackends } from "@seshat/decide";
import type { Decide, LineId, Llm } from "@seshat/lines";
import type { Registry } from "@seshat/registry";
import type { Ledger } from "./budget.ts";
import { type Turn, TurnEndedError } from "./turns.ts";

export interface ProblemDecideOptions {
  line: LineId;
  config: DecideConfig;
  journal: Journal;
  blobs: BlobStore;
  registry: Registry;
  /** The line's `llm`: the run's model, charged to the problem. */
  llm: Llm;
  ledger: Ledger;
  problemId: string;
  claimId: string;
  signal: AbortSignal;
  turn?: Turn;
}

/**
 * A line's `decide` for one problem (documentation/decide.md). The backends outside the process (Jev,
 * the faux one) are called through the registry, each call a tool run of `decide.ask` and a
 * `model_call.finished` of the line at the decision's site, charged to the problem's ledger; the
 * decision is written by the orchestrator, as `decision.made`, which no line can write.
 */
export function problemDecide(o: ProblemDecideOptions): Decide {
  const actor = `line:${o.line}`;
  const backends = registryBackends(o.registry, { actor });
  return createDecide({
    config: o.config,
    llm: o.llm,
    signal: o.signal,
    async unavailable(backend) {
      return backends.unavailable(backend);
    },
    async external(backend, input, signal) {
      if (o.ledger.exhausted) throw new Error("the problem's budget is spent: no more decisions");
      const started = performance.now();
      const { output, toolRunId } = await backends.call(backend, input, signal);
      const modelCallId = newId("mc");
      const inputTokens = output.inputTokens ?? 0;
      const outputTokens = output.outputTokens ?? 0;
      o.journal.emit(
        "model_call.finished",
        {
          modelCallId,
          line: o.line,
          problemId: o.problemId,
          model: output.model,
          outcome: "ok",
          site: input.site,
          requestHash: o.blobs.putJson(input as never),
          responseHash: o.blobs.putJson(output as never),
          durationMs: Math.round(performance.now() - started),
          usd: output.costUsd,
          inputTokens,
          outputTokens,
        },
        actor,
      );
      o.ledger.charge({ usd: output.costUsd, inputTokens, outputTokens });
      return { output, toolRunId, modelCallIds: [modelCallId] };
    },
    find(key) {
      const row = o.journal.projection.decisionByKey(o.problemId, key);
      return row === undefined ? undefined : row.data;
    },
    blob: (value) => o.blobs.putJson(value as never),
    record(draft) {
      const decisionId = newId("dec");
      o.journal.emit("decision.made", { ...draft, decisionId, line: o.line, problemId: o.problemId, claimId: o.claimId }, TASK_WRITER);
      return decisionId;
    },
    interrupted() {
      const over = o.turn?.ended;
      return over === undefined ? undefined : new TurnEndedError(over);
    },
  });
}
