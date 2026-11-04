import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { readIndex } from "@seshat/bench";
import { readEvents } from "@seshat/core";
import { classifyStatement, isSignature, leanProblem, SolveInputError, solve, type SolveOptions, TARGET_NAME } from "../src/index.ts";
import { certifier } from "./resume-helpers.ts";
import { certifyingRegistry, check, DemoLean, demoResume, fauxModels, ofType, say, tempDir } from "./m0-helpers.ts";

const SIGNATURE = "(n : ℕ) : n + 0 = n";

function options(over: Partial<SolveOptions> & { responses: Parameters<ReturnType<typeof fauxModels>["faux"]["setResponses"]>[0]; price?: number }): { o: SolveOptions; c: ReturnType<typeof certifier>; lean: DemoLean; signatures: unknown[]; name: string } {
  const { models, faux, name } = fauxModels(over.price);
  faux.setResponses(over.responses);
  const c = certifier();
  const lean = new DemoLean();
  const signatures: unknown[] = [];
  const { responses: _r, price: _p, ...rest } = over;
  const o: SolveOptions = {
    statement: SIGNATURE,
    dir: join(tempDir("mh-solve-"), "run"),
    models,
    model: name,
    maxUsd: 2,
    user: "alice",
    registry: certifyingRegistry(c.certifier)(lean),
    certifier: c.certifier,
    checker: lean,
    confirm: async (s) => {
      signatures.push(s);
      return true;
    },
    ...rest,
  };
  return { o, c, lean, signatures, name };
}

describe("reading the person's statement", () => {
  it("tells Lean from prose", () => {
    assert.equal(classifyStatement("theorem foo (n : ℕ) : n + 0 = n := by sorry"), "lean");
    assert.equal(classifyStatement("import Mathlib\n\ntheorem foo : True := by sorry"), "lean");
    assert.equal(classifyStatement(SIGNATURE), "lean");
    assert.equal(classifyStatement("(a b : ℕ) {h : a ≤ b} : a ≤ b"), "lean");
    assert.equal(classifyStatement("Every even number greater than two is the sum of two primes."), "prose");
    assert.equal(classifyStatement("For (n : ℕ) we claim that n + 0 = n"), "prose");
    assert.equal(isSignature("(n : ℕ) := foo"), false);
    assert.equal(isSignature("∀ n : ℕ, n = n"), false);
  });

  it("makes a problem file of a signature, a proposition, a bare theorem and a whole file", () => {
    const sig = leanProblem(SIGNATURE);
    assert.equal(sig.fullName, TARGET_NAME);
    assert.match(sig.source, /^import Mathlib\n\ntheorem solve_target \(n : ℕ\) : n \+ 0 = n := by\n {2}sorry\n$/);
    assert.match(sig.notes.join(" "), /no name/);
    assert.match(leanProblem("∀ n : ℕ, n + 0 = n").source, /theorem solve_target : ∀ n : ℕ, n \+ 0 = n := by/);
    assert.match(leanProblem("theorem foo (n : ℕ) : n = n").source, /theorem foo \(n : ℕ\) : n = n := by\n {2}sorry/);
    const file = leanProblem("import Mathlib\nopen Nat\n\nnamespace A\n\nlemma helper : 1 = 1 := rfl\n\ntheorem main (n : ℕ) : n = n := by\n  sorry\n\nend A\n");
    assert.equal(file.fullName, "A.main");
    assert.equal((file.source.match(/import Mathlib/g) ?? []).length, 1);
    const two = leanProblem("theorem a : True := by sorry\ntheorem b : True := by sorry");
    assert.equal(two.fullName, "b");
    assert.match(two.notes.join(" "), /2 declarations/);
  });

  it("refuses a statement with nothing to prove or with a sorry inside", () => {
    assert.throws(() => leanProblem("theorem a : True := trivial"), SolveInputError);
    assert.throws(() => leanProblem(""), /empty/);
    assert.throws(() => leanProblem("(n : ℕ) : sorry"), /holds `sorry`/);
  });
});

describe("harness solve", () => {
  it("solves a Lean statement with the student defaults and leaves RESULT.md and the exact resume command", async () => {
    const { o, c, signatures } = options({ responses: [check("exact trivial_proof")] });
    const run = await solve(o);
    assert.equal(run.state, "ran");
    assert.equal(c.requests.length, 1, "the certifier ran");
    // The defaults: a capped budget, the gate, probe first, the classical battery, a consortium stop at half the allowance.
    assert.deepEqual(run.config?.budget, { problemUsd: 2, runUsd: 2 });
    assert.deepEqual(run.config?.gate, {});
    assert.deepEqual(run.config?.lines, ["M1", "M10"]);
    assert.equal(run.config?.consortium?.limit.usd, 1);
    // The one-problem bench is a real index.
    const index = readIndex(run.problem.indexFile);
    assert.equal(index.problems.length, 1);
    assert.equal(index.problems[0]?.id, "Solve.lean#solve_target");
    assert.equal((signatures[0] as { source: string }).source, "lean");
    const events = readEvents(join(run.dir, "journal.jsonl"));
    const signed = ofType(events, "statement.signed");
    assert.equal(signed.length, 1);
    assert.equal(signed[0]?.actor, "human:alice");
    assert.equal(signed[0]?.user, "alice");
    assert.equal(signed[0]?.data.source, "lean");
    assert.equal(signed[0]?.data.formalization, undefined);
    assert.ok(events.every((e) => e.type === "statement.signed" || e.user === "alice" || e.user === undefined));
    const text = readFileSync(join(run.dir, "RESULT.md"), "utf8");
    assert.match(text, /Certified by kernel replay|certified/i);
    assert.match(text, /\*\*Proved\.\*\*/);
    const saved = JSON.parse(readFileSync(join(run.dir, "resume.json"), "utf8")) as { checkout: string; bench: string };
    assert.deepEqual([saved.checkout, saved.bench], [run.problem.checkout, run.problem.indexFile]);
  });

  it("formalizes prose, shows the signature, and journals the signature before any spend", async () => {
    const formalization = fauxAssistantMessage([fauxText(JSON.stringify({ statement: SIGNATURE }))]);
    const { o, signatures } = options({ statement: "Adding zero to a natural number changes nothing.", responses: [formalization, check("exact trivial_proof")] });
    const run = await solve(o);
    const signature = signatures[0] as { source: string; prose: string; theorem: string; testLemmas?: unknown };
    assert.equal(signature.source, "prose");
    assert.match(signature.theorem, /^theorem solve_target \(n : ℕ\) : n \+ 0 = n$/);
    assert.ok(run.formalization !== undefined && run.formalization.usd > 0);
    const events = readEvents(join(run.dir, "journal.jsonl"));
    const signedAt = events.findIndex((e) => e.type === "statement.signed");
    assert.deepEqual([events[0]?.type, signedAt], ["run.started", 1], "the signature is the first event after the start, before any task or spend");
    const signed = ofType(events, "statement.signed")[0];
    assert.equal(signed?.data.prose, "Adding zero to a natural number changes nothing.");
    assert.equal(signed?.data.statement, "(n : ℕ) : n + 0 = n");
    assert.equal(signed?.data.model, o.model);
    assert.ok(signed?.data.formalization !== undefined);
    // The request and the response are in the run's blobs.
    const blobPath = (h: string): string => join(run.dir, "blobs", h.slice(0, 2), h);
    assert.ok(existsSync(blobPath(signed?.data.formalization?.requestHash ?? "")));
    assert.match(readFileSync(blobPath(signed?.data.formalization?.responseHash ?? ""), "utf8"), /n \+ 0 = n/);
    // The formalization comes off the allowance: the run's budget is what is left.
    assert.ok((run.config?.budget.runUsd ?? 2) < 2);
    assert.ok(Math.abs((run.config?.budget.runUsd ?? 0) + run.formalization.usd - 2) < 1e-6);
    const text = readFileSync(join(run.dir, "RESULT.md"), "utf8");
    assert.match(text, /You signed this statement \(alice/);
    assert.match(text, /Formalizing your words cost/);
  });

  it("spends nothing more and starts no run when the person does not sign", async () => {
    const formalization = fauxAssistantMessage([fauxText(JSON.stringify({ statement: SIGNATURE }))]);
    const { o } = options({ statement: "Adding zero changes nothing.", responses: [formalization], confirm: async () => false });
    const run = await solve(o);
    assert.equal(run.state, "declined");
    assert.equal(existsSync(join(run.dir, "journal.jsonl")), false);
    assert.equal(run.result, undefined);
  });

  it("refuses a formalization the screen refuses, a bad allowance and a directory that holds a run", async () => {
    const bad = fauxAssistantMessage([fauxText(JSON.stringify({ statement: "(n : ℕ) : n = n := by simp" }))]);
    await assert.rejects(solve(options({ statement: "Everything equals itself.", responses: [bad] }).o), /refused/);
    await assert.rejects(solve({ ...options({ responses: [] }).o, maxUsd: 0 }), /--max-usd/);
    const { o } = options({ responses: [check("exact trivial_proof")] });
    await solve(o);
    await assert.rejects(solve(o), /already holds a run/);
    await assert.rejects(solve({ ...options({ responses: [] }).o, user: "not a name!" }), /cannot sign/);
  });

  it("stops with its account when a turn has spent half the allowance, and never goes past the allowance", async () => {
    const proofs = Array.from({ length: 12 }, () => [check("bad"), say("NOTES: bad")]).flat();
    const { o } = options({ responses: proofs, maxUsd: 0.12, price: 30, base: { sessions: 12 } });
    const run = await solve(o);
    assert.ok(run.result !== undefined);
    assert.ok(run.result.usd <= 0.12 + 1e-9, `spent ${run.result.usd}`);
    assert.ok(run.result.turn !== undefined, "the run stopped as a turn");
    assert.ok(existsSync(join(run.dir, "turns", "1", "report.md")));
    const text = readFileSync(join(run.dir, "RESULT.md"), "utf8");
    assert.ok(text.includes(`--checkout ${run.problem.checkout}`) && text.includes(`--bench ${run.problem.indexFile}`), "the resume command names the one-problem checkout and index");
    // The command works: the index and checkout it names are the ones the run began with.
    const resumed = await demoResume({
      dir: run.dir,
      bench: { checkout: run.problem.checkout, index: readIndex(run.problem.indexFile) },
      responses: [check("exact trivial_proof")],
      registry: certifyingRegistry(certifier().certifier),
      certifier: certifier().certifier,
      pricePerMillion: 30,
    });
    assert.equal(ofType(resumed.events, "run.resumed").length, 1, "the run was resumed on the one-problem bench");
  });
});
