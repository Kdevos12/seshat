import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attemptPrompt, createTwin, extractProposal, GraphState, proveWithModel, runTwin, twinSettled } from "../src/index.ts";
import { certify, claim, HEADER, lean, prove, scripted, world } from "./helpers.ts";

const A = "(n : ℕ) : n + 0 = n";

describe("model attempts", () => {
  it("read the proof from the answer: the last block, with the earlier blocks as auxiliary lemmas", () => {
    assert.deepEqual(extractProposal(lean("by\n  simp")), { proof: "simp" });
    assert.deepEqual(extractProposal(`First a lemma.\n${lean("theorem aux_one : True := trivial")}\nThen the proof.\n${lean("exact aux_one")}`), {
      proof: "exact aux_one",
      aux: "theorem aux_one : True := trivial",
    });
    assert.deepEqual(extractProposal("exact trivial_proof"), { proof: "exact trivial_proof" }, "an answer without a fence is the proof itself");
    assert.equal(extractProposal("NOT_PROVABLE: the statement is false"), undefined);
    assert.equal(extractProposal("```lean\n```"), undefined);
    assert.deepEqual(extractProposal("```lean\nexact foo"), { proof: "exact foo" }, "a fence that was never closed");
  });

  it("frame a statement of unknown truth neutrally, and the negation as a search for a counterexample", () => {
    const file = "theorem t : 1 = 1 := by\n  sorry";
    const prove = attemptPrompt("prove", file, []);
    const refute = attemptPrompt("refute", file, []);
    assert.match(prove, /Determine whether the theorem below holds, and if it does, prove it\. Do not assume that it does\./);
    assert.match(refute, /negation of a statement whose truth is not known/);
    assert.match(refute, /counterexample/);
    assert.match(refute, /Do not assume the original statement is true, and do not assume it is false\./);
    for (const prompt of [prove, refute]) {
      assert.ok(prompt.includes(file));
      assert.doesNotMatch(prompt, /\b(prove that|show that|must hold|well[- ]known|it is known)\b/i, "the prompt never says which way the statement goes");
    }
    assert.match(attemptPrompt("link", file, []), /link lemma/);
    assert.match(attemptPrompt("prove", file, ["unknown identifier 'x'"]), /Your previous attempt failed:\n- unknown identifier 'x'\nGive a different proof\./);
  });

  it("submit each proof through validate, tell the model what failed, and stop at the first valid one", async () => {
    const w = world();
    const a = await claim(w, A);
    const { llm, prompts } = scripted((_, call) => (call === 1 ? lean("exact bad") : lean("exact trivial_proof")));
    const attempt = await proveWithModel({ llm, memory: w.memory, validate: w.validate }, a, "prove", 3);
    assert.deepEqual([attempt.verdict, attempt.tries], ["valid", 2]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /Your previous attempt failed:\n- unknown identifier 'bad'/);
    assert.equal(w.memory.claim(a)?.status, "computed", "validate moved the status, nothing else did");
    assert.equal(attempt.validationId, w.memory.validations(a).at(-1)?.validationId);

    // The model that says it cannot is not asked again.
    const b = await claim(w, ": 2 + 2 = 5");
    const none = scripted(() => "NOT_PROVABLE: it is false");
    assert.deepEqual((await proveWithModel({ llm: none.llm, memory: w.memory, validate: w.validate }, b, "prove", 3)).verdict, "none");
    assert.equal(none.prompts.length, 1);
    w.close();
  });
});

describe("the prove/refute twin", () => {
  it("is the negation as a claim of its own, joined to the claim by a negation_of edge that Lean checked", async () => {
    const w = world();
    const a = await claim(w, A);
    const twin = await createTwin({ memory: w.memory, validate: w.validate, header: HEADER }, a);
    assert.equal(twin.checked, true);
    assert.equal(twin.claimId, a);
    assert.equal(w.memory.claim(twin.negationId)?.statement, ": ¬ (∀ (n : ℕ), n + 0 = n)");
    assert.equal(w.memory.claim(twin.negationId)?.parentId, a);
    const edge = w.memory.edge(twin.edgeId);
    assert.deepEqual([edge?.kind, edge?.from, edge?.to, edge?.status], ["negation_of", twin.negationId, [a], "lean_checked"]);
    // Creating the twin again finds the same claim and edge.
    assert.deepEqual(await createTwin({ memory: w.memory, validate: w.validate, header: HEADER }, a), twin);
    w.close();
  });

  it("is settled as refuted when the negation is proved, and the graph says so at the level asked", async () => {
    const w = world();
    const a = await claim(w, A);
    const twin = await createTwin({ memory: w.memory, validate: w.validate, header: HEADER }, a);
    const state = new GraphState(w.memory, [a]);
    assert.equal(twinSettled(state, twin), undefined);
    const { llm, prompts } = scripted(() => lean("exact trivial_proof"));
    const result = await runTwin({ llm, memory: w.memory, validate: w.validate, state, twin, attempts: 3 });
    assert.deepEqual(result, { end: "refutation", attempts: 1 });
    assert.match(prompts[0] ?? "", /negation of a statement whose truth is not known/);
    assert.equal(w.memory.claim(twin.negationId)?.status, "computed");
    assert.equal(w.memory.claim(a)?.status, "open", "refuting a claim is a proposal until it is certified");
    assert.equal(state.explain({ goal: "refuted", claim: a })?.tree.rule, "negation_of/proved");
    assert.equal(twinSettled(state, twin, "candidate"), "refutation");
    assert.equal(twinSettled(state, twin, "certified"), undefined);
    certify(w, twin.negationId);
    assert.equal(twinSettled(state, twin, "certified"), "refutation");
    w.close();
  });

  it("stops the refutation side when the claim is proved meanwhile, or was proved already", async () => {
    const w = world();
    const a = await claim(w, A);
    const twin = await createTwin({ memory: w.memory, validate: w.validate, header: HEADER }, a);
    const state = new GraphState(w.memory, [a]);
    // The provers find a proof while the model is answering: the next try does not happen.
    const meanwhile = scripted(async () => {
      await prove(w, a);
      return lean("exact bad");
    });
    const result = await runTwin({ llm: meanwhile.llm, memory: w.memory, validate: w.validate, state, twin, attempts: 5 });
    assert.deepEqual(result, { end: "proof", attempts: 1 });
    assert.equal(meanwhile.prompts.length, 1);
    // Settled before it starts: the model is never asked.
    const idle = scripted(() => lean("exact trivial_proof"));
    assert.deepEqual(await runTwin({ llm: idle.llm, memory: w.memory, validate: w.validate, state, twin, attempts: 5 }), { end: "proof", attempts: 0 });
    assert.equal(idle.prompts.length, 0);
    assert.equal(w.memory.claim(twin.negationId)?.status, "open");
    w.close();
  });

  it("ends exhausted when no attempt works, stopped when aborted, and learns from each failure", async () => {
    const w = world();
    const a = await claim(w, A);
    const twin = await createTwin({ memory: w.memory, validate: w.validate, header: HEADER }, a);
    const state = new GraphState(w.memory, [a]);
    const failing = scripted(() => lean("exact bad"));
    assert.deepEqual(await runTwin({ llm: failing.llm, memory: w.memory, validate: w.validate, state, twin, attempts: 2 }), { end: "exhausted", attempts: 2 });
    assert.match(failing.prompts[1] ?? "", /unknown identifier 'bad'/);
    assert.equal(w.memory.claim(twin.negationId)?.status, "open");

    const controller = new AbortController();
    controller.abort();
    const never = scripted(() => lean("exact trivial_proof"));
    assert.deepEqual(await runTwin({ llm: never.llm, memory: w.memory, validate: w.validate, state, twin, attempts: 2, signal: controller.signal }), { end: "stopped", attempts: 0 });
    assert.equal(never.prompts.length, 0);

    // An abort that interrupts a model call is not an error.
    const live = new AbortController();
    const interrupted = scripted(async () => {
      live.abort();
      throw new Error("aborted");
    });
    assert.deepEqual(await runTwin({ llm: interrupted.llm, memory: w.memory, validate: w.validate, state, twin, attempts: 2, signal: live.signal }), { end: "stopped", attempts: 0 });
    // Any other failure is raised.
    const broken = scripted(() => Promise.reject(new Error("the model is down")));
    await assert.rejects(runTwin({ llm: broken.llm, memory: w.memory, validate: w.validate, state, twin, attempts: 2 }), /the model is down/);
    w.close();
  });
});
