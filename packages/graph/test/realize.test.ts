import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractSubmission, readEvents } from "@seshat/core";
import {
  checkEdge,
  completeDerivations,
  createTwin,
  createVariant,
  DERIVATION_INTENT_KIND,
  DERIVATION_KIND,
  type DerivationRecord,
  type Fact,
  GraphState,
  memorySource,
  realize,
  revokeUnsupported,
} from "../src/index.ts";
import { claim, HEADER, headerIdentity, link, proofOf, prove, reject, toyAnswer, world, type World } from "./helpers.ts";

const BASE = "(n : ℕ) : n + 0 = n";
const STRONG = "(n : ℕ) : n + 0 = n ∧ 0 + n = n";
const P = (claimId: string): Fact => ({ goal: "proved", claim: claimId });

/** A claim, a strengthening of it that is proved, and the checked edge between them. */
async function strengthening(w: World) {
  const base = await claim(w, BASE);
  const strong = await createVariant(w.memory, { from: base, relation: "strengthening", statement: STRONG });
  await prove(w, strong.claimId);
  await checkEdge({ memory: w.memory, validate: w.validate, closers: ["exact trivial_proof"] }, strong.edge.edgeId);
  const state = new GraphState(w.memory, [base]);
  return { base, strong: strong.claimId, edgeId: strong.edge.edgeId, state, headerOf: (id: string) => w.memory.claim(id)?.header };
}

/** The files Lean was given whose proof uses the graph's composed pieces. */
const composedChecks = (w: World) => w.lean.calls.map((c) => c.code).filter((code) => (proofOf(code) ?? "").includes("aux_m2_"));

describe("realizing what the graph derives", () => {
  it("submits the composed proof to Lean, and the claim becomes a candidate only if it passes: never proved", async () => {
    const w = world();
    const { base, strong, edgeId, state, headerOf } = await strengthening(w);
    assert.equal(w.memory.claim(base)?.status, "open");
    assert.equal(composedChecks(w).length, 0);

    const results = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.equal(results.length, 1);
    const [done] = results;
    assert.deepEqual([done?.fact, done?.rule, done?.level, done?.verdict, done?.status], [P(base), "strengthens/proved", "candidate", "valid", "computed"]);

    // Lean checked the composed proof: the premise's proof and the link lemma's, then the step.
    const [file] = composedChecks(w);
    const { aux, proof } = extractSubmission(file as string);
    assert.equal(
      aux.trim(),
      [
        "theorem aux_m2_p1 (n : ℕ) : n + 0 = n ∧ 0 + n = n := by",
        "  exact trivial_proof",
        "",
        "theorem aux_m2_l1 : (∀ (n : ℕ), n + 0 = n ∧ 0 + n = n) → (∀ (n : ℕ), n + 0 = n) := by",
        "  exact trivial_proof",
      ].join("\n"),
    );
    assert.equal(proof.trim(), "exact aux_m2_l1 aux_m2_p1 n");

    // The status moved on the validation of that proof, and to `computed`: only certification proves.
    assert.equal(w.memory.claim(base)?.status, "computed");
    const validation = w.memory.validations(base).at(-1);
    assert.deepEqual([validation?.verdict, validation?.negation, validation?.validationId], ["valid", false, done?.validationId]);
    const change = readEvents(join(w.dir, "journal.jsonl")).find((e) => e.type === "claim.status_changed" && e.data.claimId === base);
    assert.ok(change?.type === "claim.status_changed");
    assert.deepEqual([change.data.to, change.data.validationId, change.actor], ["computed", done?.validationId, "orchestrator"]);

    // A derivation node says where the proof came from.
    const record = w.memory.nodes(DERIVATION_KIND, { claimId: base }).map((n) => n.data as unknown as DerivationRecord);
    assert.deepEqual(record, [
      {
        goal: "proved",
        claimId: base,
        rule: "strengthens/proved",
        edges: [edgeId],
        premises: [{ goal: "proved", claimId: strong }],
        level: "candidate",
        verdict: "valid",
        validationId: done?.validationId as string,
        signature: `proved:${base}|strengthens/proved(proved${strong})@${edgeId}`,
      },
    ]);

    // The composed proof is not an independent proof: the claim is derived, not a base fact.
    state.sync();
    assert.equal(state.candidate.isBase(P(base)), false);
    assert.equal(state.candidate.holds(P(base)), true);
    assert.deepEqual(await realize({ memory: w.memory, state, validate: w.validate, headerOf }), [], "nothing is left to realize");
    w.close();
  });

  it("finds the proof of a link lemma whether or not the identity of statements reads the header", async () => {
    for (const identity of [undefined, headerIdentity]) {
      const w = world(toyAnswer, identity);
      const { base, state, headerOf } = await strengthening(w);
      // The lemma was stated under the header of the claims; the same text under no header is another claim for an identity that reads it.
      const [done] = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
      assert.deepEqual([done?.fact, done?.verdict, done?.status], [P(base), "valid", "computed"], identity === undefined ? "text identity" : "header identity");
      w.close();
    }
  });

  it("leaves the claim open when Lean refuses the composed proof, records why, and does not send it twice", async () => {
    const w = world((code) =>
      (proofOf(code) ?? "").includes("aux_m2_") ? { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "type mismatch" }] } : toyAnswer(code),
    );
    const { base, state, headerOf } = await strengthening(w);
    const tried = new Set<string>();
    const [refused] = await realize({ memory: w.memory, state, validate: w.validate, headerOf, tried });
    assert.deepEqual([refused?.verdict, refused?.status], ["invalid", "open"]);
    assert.equal(w.memory.claim(base)?.status, "open");
    const node = w.memory.nodes(DERIVATION_KIND, { claimId: base })[0]?.data as unknown as DerivationRecord;
    assert.deepEqual([node.verdict, node.reasons?.length], ["invalid", 1]);
    assert.equal(composedChecks(w).length, 1);
    assert.deepEqual(await realize({ memory: w.memory, state, validate: w.validate, headerOf, tried }), []);
    assert.equal(composedChecks(w).length, 1, "the same derivation is not tried again in the same problem");
    w.close();
  });

  it("skips a derivation whose pieces it cannot find, and says so", async () => {
    const w = world();
    const { base, state, headerOf } = await strengthening(w);
    const source = { ...memorySource(w.memory), proofOf: () => undefined };
    const [skipped] = await realize({ memory: w.memory, state, validate: w.validate, headerOf, source });
    assert.equal(skipped?.verdict, "skipped");
    assert.match(skipped?.reasons[0] ?? "", /has no proof on record/);
    assert.equal(composedChecks(w).length, 0, "nothing was sent to Lean");
    const node = w.memory.nodes(DERIVATION_KIND, { claimId: base })[0]?.data as unknown as DerivationRecord;
    assert.equal(node.verdict, "skipped");
    // The claims are not read under one header: no proof either.
    const other = await realize({ memory: w.memory, state: new GraphState(w.memory, [base]), validate: w.validate, headerOf: (id) => (id === base ? "import Other" : HEADER), tried: new Set() });
    assert.match(other[0]?.reasons[0] ?? "", /do not share a header/);
    w.close();
  });

  it("does not compose a proof from a premise whose proof the kernel refused", async () => {
    const w = world();
    const { base, strong, state, headerOf } = await strengthening(w);
    // The fast check accepted the strengthening's proof and the certifier refused it: the claim is
    // still `computed`, a candidate for the graph, but a proof built on that file would be refused too.
    reject(w, strong);
    assert.equal(w.memory.claim(strong)?.status, "computed");
    const source = memorySource(w.memory);
    assert.equal(source.proofOf(strong, "proved"), undefined);
    const [skipped] = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.equal(skipped?.verdict, "skipped");
    assert.match(skipped?.reasons[0] ?? "", /has no proof on record/);
    assert.equal(composedChecks(w).length, 0, "nothing was sent to Lean");
    assert.equal(w.memory.claim(base)?.status, "open");
    w.close();
  });

  it("composes from a premise's proof that was not refused, even when an earlier one was", async () => {
    const w = world();
    const { base, strong, state, headerOf } = await strengthening(w);
    reject(w, strong);
    // A second proof of the premise, another file, that the kernel has not looked at.
    await prove(w, strong, "exact trivial_proof\n  -- another way");
    const source = memorySource(w.memory);
    assert.match(source.proofOf(strong, "proved")?.proof ?? "", /another way/);
    const [done] = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.deepEqual([done?.fact, done?.verdict], [P(base), "valid"]);
    w.close();
  });

  it("goes along a chain, shortest derivation first, and stops at the limit", async () => {
    const w = world();
    const [a, b, c] = [await claim(w, ": PA"), await claim(w, ": PB"), await claim(w, ": PC")] as [string, string, string];
    await prove(w, a);
    await link(w, "implies", a, b);
    await link(w, "equiv", b, c);
    const state = new GraphState(w.memory, [a]);
    const headerOf = (id: string) => w.memory.claim(id)?.header;

    const first = await realize({ memory: w.memory, state, validate: w.validate, headerOf, limit: 1 });
    assert.deepEqual(first.map((r) => [r.fact, r.verdict]), [[P(b), "valid"]]);
    assert.equal(w.memory.claim(c)?.status, "open");

    const second = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.deepEqual(second.map((r) => [r.fact, r.rule, r.verdict]), [[P(c), "equiv/proved-forward", "valid"]]);
    assert.deepEqual([b, c].map((id) => w.memory.claim(id)?.status), ["computed", "computed"]);
    // C's composed proof starts again from A's own proof, through B's step.
    const { aux, proof } = extractSubmission(composedChecks(w)[1] as string);
    assert.match(aux, /theorem aux_m2_d1 : PB := by\n {2}exact aux_m2_l1 aux_m2_p1/);
    assert.equal(proof.trim(), "exact aux_m2_l2.mp aux_m2_d1");
    w.close();
  });

  it("withdraws a claim whose composed proof lost its premise, and keeps the claims with a proof of their own", async () => {
    const w = world();
    const { base, strong, state, headerOf } = await strengthening(w);
    const own = await claim(w, ": POwn");
    const ownVariant = await createVariant(w.memory, { from: own, relation: "strengthening", statement: ": POwn ∧ PMore" });
    await prove(w, own);
    await prove(w, ownVariant.claimId);
    await checkEdge({ memory: w.memory, validate: w.validate, closers: ["exact trivial_proof"] }, ownVariant.edge.edgeId);
    state.watch(own);

    await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.equal(w.memory.claim(base)?.status, "computed");
    state.sync();
    assert.deepEqual(revokeUnsupported(w.memory, state), [], "its premise still holds");

    // The premise is withdrawn: what was derived from it goes back to open, what was proved on its own stays.
    w.memory.retractClaim(strong, { reason: "a result it used was found wrong" });
    w.memory.retractClaim(ownVariant.claimId, { reason: "a result it used was found wrong" });
    state.sync();
    const logged: string[] = [];
    assert.deepEqual(revokeUnsupported(w.memory, state, (t) => logged.push(t)), [base]);
    assert.equal(w.memory.claim(base)?.status, "open");
    assert.equal(w.memory.claim(own)?.status, "computed");
    assert.match(logged[0] ?? "", /withdrawn/);
    assert.deepEqual(revokeUnsupported(w.memory, state), [], "nothing is withdrawn twice");

    // The premise comes back, and so does the derivation.
    await prove(w, strong);
    const again = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.deepEqual(again.map((r) => [r.fact, r.verdict]), [[P(base), "valid"]]);
    assert.equal(w.memory.claim(base)?.status, "computed");
    w.close();
  });

  it("withdraws only the claims its own state follows: what another problem composed is not its to judge", async () => {
    const w = world();
    // Problem A composed the proof of `base` from `strong`: `base` is a candidate through it.
    const { base, strong, state: stateA, headerOf } = await strengthening(w);
    await realize({ memory: w.memory, state: stateA, validate: w.validate, headerOf });
    assert.equal(w.memory.claim(base)?.status, "computed");

    // Problem B works on a claim elsewhere in the graph. Its state does not reach `base`, so it does
    // not hold it, and B's propagation (realize, then revoke, as the line does) must leave it alone.
    const other = await claim(w, ": POther");
    const stateB = new GraphState(w.memory, [other]);
    stateB.sync();
    assert.equal(stateB.claims().includes(base), false);
    assert.equal(stateB.candidate.holds(P(base)), false);
    await realize({ memory: w.memory, state: stateB, validate: w.validate, headerOf });
    stateB.sync();
    assert.deepEqual(revokeUnsupported(w.memory, stateB), []);
    assert.equal(w.memory.claim(base)?.status, "computed", "problem A's claim is untouched");

    // A state that reaches the claim through an edge judges it, seed or not: here one that starts at the premise.
    const stateC = new GraphState(w.memory, [strong]);
    w.memory.retractClaim(strong, { reason: "a result it used was found wrong" });
    stateB.sync();
    stateC.sync();
    assert.deepEqual(revokeUnsupported(w.memory, stateB), [], "B still leaves it alone");
    assert.deepEqual(revokeUnsupported(w.memory, stateC), [base]);
    assert.equal(w.memory.claim(base)?.status, "open");
    w.close();
  });

  it("composes a refutation from the proof of the negation, which changes no status", async () => {
    const w = world();
    const base = await claim(w, BASE);
    const twin = await createTwin({ memory: w.memory, validate: w.validate, header: HEADER }, base);
    assert.equal(twin.checked, true);
    await prove(w, twin.negationId);
    const state = new GraphState(w.memory, [base]);
    const headerOf = (id: string) => w.memory.claim(id)?.header;

    const results = await realize({ memory: w.memory, state, validate: w.validate, headerOf });
    assert.deepEqual(results.map((r) => [r.fact, r.rule, r.verdict, r.status]), [[{ goal: "refuted", claim: base }, "negation_of/proved", "valid", "open"]]);
    assert.equal(w.memory.claim(base)?.status, "open", "a refutation is certified before it settles a claim");
    const refutation = w.memory.validations(base).filter((v) => v.negation);
    assert.deepEqual(refutation.map((v) => v.verdict), ["valid"]);
    const [file] = composedChecks(w);
    assert.equal(extractSubmission(file as string).proof.trim(), "exact aux_m2_l1.mp aux_m2_p1");
    // Once realized it is not sent again, and the state still derives it instead of counting it as given.
    assert.deepEqual(await realize({ memory: w.memory, state, validate: w.validate, headerOf }), []);
    assert.equal(state.candidate.isBase({ goal: "refuted", claim: base }), false);
    assert.equal(state.candidate.holds({ goal: "refuted", claim: base }), true);
    w.close();
  });
});

describe("a derivation a run ended in the middle of", () => {
  /** A `validate` that Lean answers for and the process then dies in: the answer is journaled, the derivation node is not. */
  const dyingAfter = (w: World) => async (request: Parameters<World["validate"]>[0]) => {
    await w.validate(request);
    throw new Error("the process ended");
  };
  const nodesOf = (w: World, kind: string) => w.memory.nodes(kind).map((n) => n.data as unknown as DerivationRecord);

  it("is written from the validation that answered it, once, and not submitted again", async () => {
    const w = world();
    const { state, headerOf } = await strengthening(w);
    await assert.rejects(realize({ memory: w.memory, state, validate: dyingAfter(w), headerOf, problemId: "prb_1" }), /the process ended/);
    assert.equal(nodesOf(w, DERIVATION_KIND).length, 0, "the node the run would have written is missing");
    assert.equal(w.memory.nodes(DERIVATION_INTENT_KIND).length, 1, "what it meant to do was said first");
    const checked = composedChecks(w).length;

    const written = completeDerivations(w.memory, "prb_1");
    assert.equal(written.length, 1);
    const [node] = nodesOf(w, DERIVATION_KIND);
    assert.deepEqual([node?.problemId, node?.verdict, node?.rule], ["prb_1", "valid", "strengthens/proved"]);
    assert.ok(node?.validationId !== undefined && node.signature !== undefined);
    assert.equal(completeDerivations(w.memory, "prb_1").length, 0, "a second call writes nothing");
    assert.equal(completeDerivations(w.memory, "prb_other").length, 0, "another problem's intents are not this problem's");
    assert.equal(composedChecks(w).length, checked);
    w.close();
  });

  it("is left to be submitted again when the process ended before Lean answered", async () => {
    const w = world();
    const { state, headerOf } = await strengthening(w);
    const before = async (): Promise<never> => Promise.reject(new Error("the process ended"));
    await assert.rejects(realize({ memory: w.memory, state, validate: before, headerOf, problemId: "prb_1" }), /the process ended/);
    assert.equal(completeDerivations(w.memory, "prb_1").length, 0);
    assert.equal(nodesOf(w, DERIVATION_KIND).length, 0);
    w.close();
  });
});
