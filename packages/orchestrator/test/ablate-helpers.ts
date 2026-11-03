import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, type HarnessEvent, type Json, newId, type ProblemOutcome, readEvents } from "@seshat/core";

/** One attempt of a scripted problem. */
export interface ScriptedAttempt {
  strategy?: string;
  outcome?: "valid" | "invalid";
  usd?: number;
  turns?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  toolTokens?: number;
  /** Unverified items the draw put in the session. */
  included?: string[];
  /** The proof used a library lemma. */
  library?: boolean;
  /** A schema was shown to the session, and whether its shape was reused. */
  hint?: { shown: boolean; reused?: boolean };
  /** Who made the valid check: default `prover:p1`. */
  actor?: string;
  /** The claim of the attempt, when it is not the problem's. */
  claim?: string;
}

export interface ScriptedProblem {
  id: string;
  path?: string;
  outcome: ProblemOutcome;
  attempts?: ScriptedAttempt[];
  /** Settled by this actor's valid check, without an attempt (`line:M10`). */
  settledBy?: string;
}

export interface ScriptedSpec {
  runId?: string;
  lines?: string[];
  problems: ScriptedProblem[];
  /** Extra claims: `{ id, origin, parentId?, status, validBy? }`, and decomposition edges from the first problem's claim. */
  claims?: Array<{ id: string; origin: string; parentId?: string; status?: string; validBy?: string; decomposedFrom?: string; checkedTo?: string }>;
  /** Tool runs by an actor, with their time. */
  toolRuns?: Array<{ actor: string; capability: string; durationMs: number }>;
  /** Decisions of the `decide` capability. */
  decisions?: Array<{ site: string; labels: string[]; answer: string; probabilities: Record<string, number>; claimId?: string; backend?: "llm" | "jev" | "faux"; key?: string; problemId?: string }>;
  /** Nodes, by kind. */
  nodes?: Array<{ kind: string; claimId?: string; data: Json }>;
  memoryFrom?: { runId: string; lastHash: string; events: number };
  config?: Record<string, Json>;
}

export interface ScriptedRun {
  dir: string;
  events: HarnessEvent[];
  /** The claim id of each problem. */
  claims: Record<string, string>;
}

/** A journal written by hand, as a run of the given shape would leave it, for the tests of what is built from a journal alone. */
export function scriptedRun(spec: ScriptedSpec, dir = mkdtempSync(join(tmpdir(), "mh-ablate-"))): ScriptedRun {
  const runId = spec.runId ?? newId("run");
  const journal = Journal.open(dir, runId);
  const blobs = new BlobStore(join(dir, "blobs"));
  void blobs;
  const o = "orchestrator";
  const zero = { usd: 0, inputTokens: 0, outputTokens: 0 };
  journal.emit(
    "run.started",
    {
      runId,
      benchId: "scripted",
      problems: spec.problems.length,
      host: "test",
      config: { lines: (spec.lines ?? []).map((id) => ({ id, options: {} })), budget: { problemUsd: 1 }, ...(spec.config ?? {}) } as Json,
      ...(spec.memoryFrom !== undefined ? { memoryFrom: { runId: spec.memoryFrom.runId, lastHash: spec.memoryFrom.lastHash, events: spec.memoryFrom.events } as never } : {}),
    },
    o,
  );
  const claims: Record<string, string> = {};
  const claim = (claimId: string, statement: string, origin: string, parentId?: string, status = "open") =>
    journal.emit("claim.created", { claimId, statementId: `sid_${claimId}`, statement, origin, status: status as never, kind: "formal", ...(parentId !== undefined ? { parentId } : {}) }, "memory");
  const valid = (claimId: string, actor: string, attemptId?: string, method: "repl" | "kernel_replay" = "repl"): string => {
    const validationId = newId("val");
    journal.emit("validation.finished", { validationId, claimId, ...(attemptId !== undefined ? { attemptId } : {}), method, verdict: "valid", reasons: [], axioms: [], submissionHash: "h" }, method === "repl" ? actor : "certifier");
    return validationId;
  };
  const lastValid = new Map<string, string>();
  for (const p of spec.problems) {
    const claimId = newId("clm");
    claims[p.id] = claimId;
    claim(claimId, `statement of ${p.id}`, "bench:scripted");
    journal.emit("problem.registered", { problemId: p.id, claimId, target: p.id, source: { repo: "r", rev: "x", path: p.path ?? "Bench.lean" }, domain: [] }, o);
  }
  for (const c of spec.claims ?? []) {
    claims[c.id] = newId("clm");
    claim(claims[c.id] as string, `statement of ${c.id}`, c.origin, c.parentId !== undefined ? claims[c.parentId] : undefined, "open");
  }
  for (const c of spec.claims ?? []) {
    const claimId = claims[c.id] as string;
    if (c.decomposedFrom !== undefined) {
      journal.emit("edge.added", { edgeId: newId("edg"), kind: "decomposes_into", from: claims[c.decomposedFrom] as string, to: [claimId], status: "proposed" }, "line:M12");
    }
    const validationId = c.validBy !== undefined ? valid(claimId, c.validBy) : undefined;
    if (c.status !== undefined && c.status !== "open") {
      journal.emit("claim.status_changed", { claimId, from: "open", to: c.status as never, reason: "test", ...(validationId !== undefined ? { validationId } : {}) }, "validator");
    }
    // An edge Lean checked: its link lemma is this claim itself, with its valid check.
    if (c.checkedTo !== undefined && validationId !== undefined) {
      journal.emit(
        "edge.added",
        { edgeId: newId("edg"), kind: "implies", from: claimId, to: [claims[c.checkedTo] as string], status: "lean_checked", validationId, link: { name: `link_${c.id}`, statement: `statement of ${c.id}` } },
        "line:M2",
      );
    }
  }
  for (const [k, run] of (spec.toolRuns ?? []).entries()) {
    const toolRunId = `tr_${k}`;
    journal.emit("tool_run.started", { toolRunId, capability: run.capability, implementation: "x", version: "1", inputHash: "h" }, run.actor);
    journal.emit("tool_run.finished", { toolRunId, outcome: "ok", durationMs: run.durationMs }, run.actor);
  }
  for (const n of spec.nodes ?? []) {
    journal.emit("node.recorded", { nodeId: newId("nod"), kind: n.kind, ...(n.claimId !== undefined ? { claimId: claims[n.claimId] ?? n.claimId } : {}), data: n.data }, "line:test");
  }
  for (const d of spec.decisions ?? []) {
    const claimId = d.claimId !== undefined ? claims[d.claimId] : undefined;
    journal.emit(
      "decision.made",
      {
        decisionId: newId("dec"),
        key: d.key ?? newId("key"),
        line: "M10",
        problemId: d.problemId ?? (spec.problems[0]?.id as string),
        ...(claimId !== undefined ? { claimId } : {}),
        site: d.site,
        backend: d.backend ?? "llm",
        requested: d.backend ?? "llm",
        model: "faux/prover",
        type: d.site === "conjecture.relevance" ? "score" : "choice",
        labels: d.labels,
        requestHash: "r",
        stateHash: "s",
        answer: d.answer,
        probabilities: d.probabilities,
        costUsd: 0,
        modelCallIds: [],
      },
      o,
    );
  }
  let total = 0;
  for (const p of spec.problems) {
    const claimId = claims[p.id] as string;
    let usd = 0;
    let n = 0;
    for (const a of p.attempts ?? []) {
      const attemptId = newId("att");
      const cost = a.usd ?? 0.01;
      usd += cost;
      n += 1;
      const target = a.claim !== undefined ? (claims[a.claim] as string) : claimId;
      journal.emit(
        "attempt.started",
        { attemptId, claimId: target, prover: "p1", iteration: n, model: "faux/prover", ...(a.strategy !== undefined ? { strategy: a.strategy } : {}), ...(a.included !== undefined ? { included: a.included } : {}) },
        "prover:p1",
      );
      journal.emit(
        "attempt.finished",
        {
          attemptId,
          outcome: a.outcome ?? "invalid",
          stoppedBy: "model",
          durationMs: 5,
          turns: a.turns ?? 2,
          usd: cost,
          inputTokens: a.inputTokens ?? 1000,
          outputTokens: 50,
          ...(a.cachedInputTokens !== undefined ? { cachedInputTokens: a.cachedInputTokens } : {}),
          ...(a.toolTokens !== undefined ? { toolTokens: a.toolTokens } : {}),
          ...(a.strategy !== undefined ? { strategy: a.strategy } : {}),
        },
        "prover:p1",
      );
      if (a.outcome === "valid") lastValid.set(target, valid(target, a.actor ?? "prover:p1", attemptId));
      if (a.library === true) {
        journal.emit("node.recorded", { nodeId: newId("nod"), kind: "library_use", claimId: target, data: { attemptId, claimId: target, outcome: a.outcome ?? "invalid", used: [{ name: "Nat.add_comm", source: "library" }] } }, "line:M3");
      }
      if (a.hint !== undefined) {
        journal.emit("node.recorded", { nodeId: newId("nod"), kind: "m15_hint", claimId: target, data: { problemId: p.id, attemptId, schemaId: "s1", name: "schema", arm: "match", shown: a.hint.shown, ...(a.hint.reused !== undefined ? { reused: a.hint.reused } : {}) } }, "line:M15");
      }
    }
    if (p.settledBy !== undefined) lastValid.set(claimId, valid(claimId, p.settledBy));
    if (p.outcome === "proved" || p.outcome === "candidate" || p.outcome === "refuted") {
      const validationId = p.outcome === "candidate" ? lastValid.get(claimId) : valid(claimId, "certifier", undefined, "kernel_replay");
      journal.emit("claim.status_changed", { claimId, from: "open", to: p.outcome === "candidate" ? "computed" : p.outcome, reason: "test", ...(validationId !== undefined ? { validationId } : {}) }, "validator");
    }
    journal.emit("problem.finished", { problemId: p.id, claimId, outcome: p.outcome, attempts: n, usd, durationMs: 10 }, o);
    total += usd;
  }
  journal.emit(
    "run.finished",
    { runId, attempted: spec.problems.length, solved: spec.problems.filter((p) => p.outcome === "proved").length, candidates: spec.problems.filter((p) => p.outcome === "candidate").length, usd: total },
    o,
  );
  void zero;
  const events = readEvents(join(dir, "journal.jsonl"));
  journal.close();
  return { dir, events, claims };
}
