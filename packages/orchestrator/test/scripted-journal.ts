import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, newId } from "@seshat/core";

const zero = { usd: 0, inputTokens: 0, outputTokens: 0 };

/** The ids of what a scripted journal holds. */
export interface Scripted {
  dir: string;
  journal: Journal;
  blobs: BlobStore;
  claims: { root: string; proved: string; leaf: string; computed: string; refuted: string; stuck: string };
  problems: { decomposed: string; refuted: string; stuck: string };
  attempts: string[];
  nodes: { counter: string; obstruction: string; conjecture: string; judgment: string };
  edges: { implies: string; decomposes: string };
  validations: { certified: string; fast: string };
}

/**
 * A journal written by hand, as a consortium run's turn would leave it, to test what is built from a
 * journal alone. Three problems: one decomposed into three parts (a proved one, an open leaf with two
 * strategies tried, and a computed one), one refuted with a counter-model, and one that waits with
 * an obstruction and a conjecture. The turn 1 ended at an impasse. The journal stays open.
 */
export function scriptedJournal(options: { narrative?: string } = {}): Scripted {
  const dir = mkdtempSync(join(tmpdir(), "mh-scripted-"));
  const journal = Journal.open(dir, "run_scripted");
  const blobs = new BlobStore(join(dir, "blobs"));
  const o = "orchestrator";
  journal.emit(
    "run.started",
    {
      runId: "run_scripted",
      benchId: "scripted",
      problems: 3,
      host: "test",
      config: { budget: { problemUsd: 1, runUsd: 5 }, consortium: { limit: { tokens: 5000 }, impasse: { posteriorBelow: 0.1, minAttempts: 8 }, narrative: false } },
    },
    o,
  );
  journal.emit("turn.started", { runId: "run_scripted", turn: 1, limit: { tokens: 5000 }, source: "the run's option", startSpend: zero }, o);

  const id = (prefix: string) => newId(prefix);
  const claims = { root: id("clm"), proved: id("clm"), leaf: id("clm"), computed: id("clm"), refuted: id("clm"), stuck: id("clm") };
  const claim = (claimId: string, statement: string, parentId?: string, kind: "formal" | "informal" = "informal") =>
    journal.emit(
      "claim.created",
      { claimId, statementId: `sid_${claimId}`, statement, origin: "test", status: "open", kind, ...(parentId !== undefined ? { parentId } : {}) },
      "memory",
    );
  claim(claims.root, "Every even number above two is a sum of two primes");
  claim(claims.proved, "Part A: the base case holds", claims.root, "formal");
  claim(claims.leaf, "Part B: the inductive step holds", claims.root, "formal");
  claim(claims.computed, "Part C: the small cases check", claims.root, "formal");
  claim(claims.refuted, "Every odd number is prime");
  claim(claims.stuck, "The sequence has no accumulation point");
  const problems = { decomposed: "Bench.lean#goldbach", refuted: "Bench.lean#odd_prime", stuck: "Bench.lean#accumulation" };
  for (const [problemId, claimId, target] of [
    [problems.decomposed, claims.root, "goldbach"],
    [problems.refuted, claims.refuted, "odd_prime"],
    [problems.stuck, claims.stuck, "accumulation"],
  ] as const) {
    journal.emit("problem.registered", { problemId, claimId, target, source: { repo: "r", rev: "x", path: "Bench.lean" }, domain: [] }, o);
  }
  const decomposes = id("edg");
  journal.emit("edge.added", { edgeId: decomposes, kind: "decomposes_into", from: claims.root, to: [claims.proved, claims.leaf, claims.computed], status: "proposed" }, "line:M2");
  const implies = id("edg");
  journal.emit("edge.added", { edgeId: implies, kind: "implies", from: claims.proved, to: [claims.leaf], status: "proposed" }, "line:M2");

  // Attempts: two on the open leaf with different strategies, one that proved part A, one on the computed part,
  // one that refuted the odd-prime claim, and one on the stuck claim.
  const attempts: string[] = [];
  const attempt = (claimId: string, strategy: string, outcome: "valid" | "invalid", extra: { failureClass?: string; failureDetail?: string } = {}, stoppedBy = "model") => {
    const attemptId = id("att");
    attempts.push(attemptId);
    journal.emit("attempt.started", { attemptId, claimId, prover: "p1", iteration: attempts.length, model: "faux/prover", strategy }, "prover:p1");
    journal.emit("attempt.charged", { attemptId, usd: 0.01, inputTokens: 1000, outputTokens: 50 }, "prover:p1");
    journal.emit(
      "attempt.finished",
      { attemptId, outcome, stoppedBy, durationMs: 10, turns: 1, usd: 0.01, inputTokens: 1000, outputTokens: 50, strategy, ...extra },
      "prover:p1",
    );
    return attemptId;
  };
  attempt(claims.leaf, "induction", "invalid", { failureClass: "unsolved_goals", failureDetail: "unsolved goals at case succ" });
  attempt(claims.leaf, "automation", "invalid", { failureClass: "tactic_failed", failureDetail: "omega failed" });
  attempt(claims.leaf, "automation", "invalid", { failureClass: "tactic_failed", failureDetail: "simp made no progress" });
  const provedAttempt = attempt(claims.proved, "computation", "valid");
  const computedAttempt = attempt(claims.computed, "cases", "valid");
  const refutedAttempt = attempt(claims.refuted, "counterexample", "valid");
  attempt(claims.stuck, "contradiction", "invalid", { failureClass: "unsolved_goals" });

  // Validations: the certified proof of part A and of the refutation, the fast check of part C.
  const validations = { certified: id("val"), fast: id("val") };
  const refutedCheck = id("val");
  const validate = (validationId: string, claimId: string, attemptId: string, method: "repl" | "kernel_replay", negation = false) =>
    journal.emit(
      "validation.finished",
      { validationId, claimId, attemptId, method, verdict: "valid", reasons: [], axioms: ["propext"], submissionHash: "h", ...(negation ? { negation: true } : {}) },
      method === "repl" ? "validator" : "certifier",
    );
  validate(id("val"), claims.proved, provedAttempt, "repl");
  validate(validations.certified, claims.proved, provedAttempt, "kernel_replay");
  journal.emit("claim.status_changed", { claimId: claims.proved, from: "open", to: "proved", reason: "the proof was certified", attemptId: provedAttempt, validationId: validations.certified }, "validator");
  validate(validations.fast, claims.computed, computedAttempt, "repl");
  journal.emit("claim.status_changed", { claimId: claims.computed, from: "open", to: "computed", reason: "a proof passed the fast check", attemptId: computedAttempt, validationId: validations.fast }, "validator");
  validate(id("val"), claims.refuted, refutedAttempt, "repl", true);
  validate(refutedCheck, claims.refuted, refutedAttempt, "kernel_replay", true);
  journal.emit("claim.status_changed", { claimId: claims.refuted, from: "open", to: "refuted", reason: "a proof of the negation was certified", attemptId: refutedAttempt, validationId: refutedCheck }, "validator");
  journal.emit("problem.finished", { problemId: problems.refuted, claimId: claims.refuted, outcome: "refuted", attempts: 1, usd: 0.01, durationMs: 10 }, o);

  // Records: a counter-model, an obstruction, a conjecture with evidence, a disagreement, and kinds the account does not know.
  const node = (kind: string, claimId: string | undefined, data: Record<string, unknown>) => {
    const nodeId = id("nod");
    journal.emit("node.recorded", { nodeId, kind, ...(claimId !== undefined ? { claimId } : {}), data: data as never }, "line:M4");
    return nodeId;
  };
  const nodes = {
    counter: node("counter_model", claims.refuted, { description: "the number 9 is odd and not prime", battery: "b1", digest: "d", index: 0, refutation: [{ form: "negation", verdict: "valid" }] }),
    obstruction: node("obstruction", claims.stuck, { summary: "every linear recurrence tried has an eigenvalue of modulus one" }),
    conjecture: node("conjecture", claims.stuck, { statement: "the accumulation points are the roots of unity", evidence: ["checked for n up to 10^6", "matches OEIS A000010"] }),
    judgment: node("judgment", claims.leaf, { disagreement: true, subject: "the step from n to n+1" }),
  };
  node("mystery", undefined, { x: 1 });
  node("mystery", undefined, { x: 2 });
  node("zebra", claims.stuck, { stripes: true });

  // A task that waits.
  const taskId = id("tsk");
  journal.emit(
    "task.created",
    { taskId, kind: "prove", problemId: problems.decomposed, claimId: claims.leaf, dependsOn: [], acceptance: { type: "claim", claimId: claims.leaf, minStatus: "proved" }, budget: { sessions: 3 }, title: "prove part B" },
    o,
  );

  const hash = options.narrative === undefined ? undefined : blobs.put(options.narrative);
  journal.emit(
    "turn.ended",
    {
      runId: "run_scripted",
      turn: 1,
      reason: "impasse",
      detail: "every open task of goldbach is blocked",
      spent: { turn: { usd: 0.07, inputTokens: 7000, outputTokens: 350 }, run: { usd: 0.07, inputTokens: 7000, outputTokens: 350 } },
      minutes: 2.5,
      waiting: [problems.decomposed, problems.stuck],
      breakpoint: { kind: "impasse", problemId: problems.decomposed },
      ...(hash !== undefined ? { narrative: { hash } } : {}),
    },
    o,
  );
  return { dir, journal, blobs, claims, problems, attempts, nodes, edges: { implies, decomposes }, validations };
}
