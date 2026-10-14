import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import type { Line, LineRegistry } from "@seshat/lines";
import type { MemoryStore } from "@seshat/memory";
import { LINES } from "../../orchestrator/src/lines.ts";
import { call, check, DemoLean, demoRun, ofType, proofOf, say } from "../../orchestrator/test/m0-helpers.ts";
import { checkEdge, createVariant, m2Line, M2_OPTIONS, type TwinRecord } from "../src/index.ts";
import { lean, toyAnswer } from "./helpers.ts";

// The simulated model's types, as the orchestrator's test helper gives them (this package does not depend on the model library).
type Step = Parameters<typeof demoRun>[0]["responses"][number];
type TranscriptContext = Parameters<Extract<Step, (...args: never[]) => unknown>>[0];
type Message = TranscriptContext["messages"][number];

function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** The call is the line's refutation attempt, not a prover's. */
const isTwin = (context: TranscriptContext) => /negation of a statement whose truth is not known/.test(textOf(context.messages.find((m) => m.role === "user")));

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 5) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** M2 as the run sees it, with the problem's memory and claim kept for the test's model. */
function watched(): { line: Line; seen: { memory?: MemoryStore; claimId?: string } } {
  const seen: { memory?: MemoryStore; claimId?: string } = {};
  const line: Line = {
    ...m2Line,
    hooks: {
      ...m2Line.hooks,
      beforeProvers: async (problem) => {
        seen.memory = problem.memory;
        seen.claimId = problem.claimId;
        await m2Line.hooks.beforeProvers?.(problem);
      },
    },
  };
  return { line, seen };
}

const nodes = (events: HarnessEvent[], kind: string) =>
  ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => e.data.data as Record<string, unknown>);

describe("the line M2 in a run", () => {
  it("is registered, with its options", () => {
    assert.equal(LINES.M2, m2Line);
    assert.deepEqual(m2Line.requires, []);
    assert.deepEqual(m2Line.options, M2_OPTIONS);
    assert.deepEqual(Object.keys(M2_OPTIONS), ["twin", "twinTries", "propagate", "composed", "queryTool"]);
  });

  it("stops the provers when its twin proves the negation, and composes the refutation of the claim", { timeout: 30000 }, async () => {
    const { line, seen } = watched();
    const prompts: string[] = [];
    const router = async (context: TranscriptContext) => {
      if (isTwin(context)) {
        prompts.push(textOf(context.messages.find((m) => m.role === "user")));
        return say(lean("exact trivial_proof"));
      }
      // A prover's first request: it waits for the refutation side, so that the test does not race it.
      const memory = seen.memory as MemoryStore;
      await until(() => memory.edges({ to: seen.claimId as string, kinds: ["negation_of"] }).some((e) => memory.claim(e.from)?.status === "computed"), "the negation to be proved");
      return context.messages.some((m) => m.role === "toolResult") ? say("I will stop here.") : check("bad");
    };
    const { result, events, faux } = await demoRun({
      lines: { M2: line },
      config: { lines: ["M2"], provers: 1, sessions: 3 },
      lean: new DemoLean(toyAnswer),
      responses: Array.from({ length: 8 }, () => router),
    });
    const problem = result.problems[0];
    assert.equal(problem?.outcome, "unsolved", "a run has no refuted outcome: the problem is not solved");
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;

    // The refutation side asked once, with the neutral framing, and the negation was proved.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Do not assume the original statement is true, and do not assume it is false\./);
    assert.match(prompts[0] ?? "", /theorem clm_\w+ : ¬ \(∀ \(n : ℕ\), n \+ 0 = n\)/);
    // The session that was running was stopped by the line after its check, and no other session started.
    const attempts = ofType(events, "attempt.finished");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.data.stoppedBy, "line:M2");
    assert.equal(ofType(events, "attempt.started").length, 1);
    assert.equal(faux.getPendingResponseCount() > 0, true, "the second and third sessions never asked the model");

    // The graph: the claim stays open; its negation is a candidate; the edge between them was checked by Lean.
    const changes = ofType(events, "claim.status_changed");
    assert.deepEqual(changes.filter((c) => c.data.claimId === claimId), []);
    assert.deepEqual(changes.map((c) => [c.data.to, c.actor]).filter(([to]) => to === "computed").length, 2, "the link lemma and the negation");
    assert.deepEqual(ofType(events, "edge.status_changed").map((e) => [e.data.to, e.actor]), [["lean_checked", "line:M2"]]);
    // The twin is recorded, and the composed refutation of the claim was submitted as a refutation: no status moves.
    assert.deepEqual(nodes(events, "twin").map((n) => [n.checked, n.end, n.tries]), [[true, "refutation", 1]]);
    const refutations = ofType(events, "validation.finished").filter((v) => v.data.claimId === claimId && v.data.negation === true);
    assert.deepEqual(refutations.map((v) => [v.data.verdict, v.actor]), [["valid", "validator"]]);
    assert.deepEqual(nodes(events, "derivation").map((n) => [n.goal, n.rule, n.verdict]), [["refuted", "negation_of/proved", "valid"]]);
    // Every model call of the line is recorded as the line's.
    assert.deepEqual(ofType(events, "model_call.finished").filter((m) => m.data.line === "M2").length, 1);
  });

  it("stops the refutation side when a prover proves the claim first, and tells the provers about the twin", { timeout: 30000 }, async () => {
    const { line, seen } = watched();
    const opening: string[] = [];
    const router = async (context: TranscriptContext) => {
      if (isTwin(context)) {
        // The model is slow: the claim is proved before it answers, with a proof that is wrong anyway.
        await until(() => seen.memory?.claim(seen.claimId as string)?.status === "computed", "the claim to be proved");
        return say(lean("exact bad"));
      }
      opening.push(textOf(context.messages.find((m) => m.role === "user")));
      return check("exact trivial_proof");
    };
    const { result, events } = await demoRun({
      lines: { M2: line },
      config: { lines: ["M2"], provers: 1, sessions: 2 },
      lean: new DemoLean(toyAnswer),
      responses: Array.from({ length: 6 }, () => router),
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    // The provers were told what the graph holds, without being told which way the claim goes.
    assert.match(opening[0] ?? "", /# What the graph knows\nThe truth of the claim is not known\. Its negation is the claim \w+ \(: ¬ \(∀ \(n : ℕ\), n \+ 0 = n\)\)/);
    // The twin ended with the proof side, and nothing was proved about the negation.
    const [twin] = nodes(events, "twin");
    assert.deepEqual([twin?.checked, twin?.end], [true, "proof"]);
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;
    assert.equal(ofType(events, "claim.status_changed").filter((c) => c.data.claimId === claimId).length, 1);
    // What the graph then knows is that the negation is refuted (the claim is proved): that is all it composes.
    const refuted = ofType(events, "validation.finished").filter((v) => v.data.negation === true);
    assert.deepEqual(refuted.map((v) => [v.data.verdict, v.data.claimId !== claimId]), [["valid", true]]);
    assert.deepEqual(nodes(events, "derivation").map((n) => [n.goal, n.rule, n.verdict]), [["refuted", "negation_of/proved-back", "valid"]]);
  });

  it("composes the proof of the claim from a proved strengthening, and settles the problem before the provers", { timeout: 30000 }, async () => {
    // A line before M2 (M1's place) leaves a strengthening of the problem's claim, proved, with its edge checked.
    const prepare: Line = {
      id: "M1",
      title: "prepares a strengthening",
      requires: [],
      hooks: {
        beforeProvers: async (problem) => {
          const header = problem.target.sketch.prefix;
          const variant = await createVariant(problem.memory, { from: problem.claimId, relation: "strengthening", statement: "(n : ℕ) : n + 0 = n ∧ 0 + n = n", header });
          const proof = await problem.validate({ claimId: variant.claimId, proof: "exact trivial_proof" });
          assert.equal(proof.verdict, "valid");
          const checked = await checkEdge({ memory: problem.memory, validate: problem.validate, header, closers: ["exact trivial_proof"] }, variant.edge.edgeId);
          assert.equal(checked.checked, true);
        },
      },
    };
    const lines: LineRegistry = { M1: prepare, M2: m2Line };
    const lean_ = new DemoLean(toyAnswer);
    const { result, events, faux } = await demoRun({ lines, config: { lines: ["M1", "M2"] }, lean: lean_, responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(ofType(events, "attempt.started").length, 0, "the provers never started");
    assert.equal(faux.getPendingResponseCount(), 1, "no model call was made");
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;

    // The composed proof went through the same validator, and the claim became a candidate through it.
    const validations = ofType(events, "validation.finished").filter((v) => v.data.claimId === claimId);
    assert.deepEqual(validations.map((v) => [v.data.verdict, v.actor]), [["valid", "validator"]]);
    const change = ofType(events, "claim.status_changed").find((c) => c.data.claimId === claimId);
    assert.deepEqual([change?.data.to, change?.data.validationId], ["computed", validations[0]?.data.validationId]);
    const composed = lean_.calls.map((c) => c.code).filter((code) => (proofOf(code) ?? "").includes("aux_m2_l1 aux_m2_p1"));
    assert.equal(composed.length, 1);
    // The composed proof is recorded; once the problem is over, the graph also composes that its negation is refuted.
    assert.deepEqual(nodes(events, "derivation").map((n) => [n.goal, n.rule, n.verdict, n.level]), [
      ["proved", "strengthens/proved", "valid", "candidate"],
      ["refuted", "negation_of/proved-back", "valid", "candidate"],
    ]);
    assert.deepEqual(nodes(events, "twin").map((n) => n.end), ["proof"]);
  });

  it("gives the provers a tool to read the graph, with short ids", { timeout: 30000 }, async () => {
    const results: string[] = [];
    const { result, events } = await demoRun({
      lines: { M2: m2Line },
      config: { lines: ["M2"], lineOptions: { M2: { twinTries: 0 } } },
      lean: new DemoLean(toyAnswer),
      responses: [
        call("graph_neighbors", {}),
        (context) => {
          results.push(textOf(context.messages.findLast((m) => m.role === "toolResult")));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const lines = (results[0] ?? "").split("\n");
    assert.equal(lines[0], "2 claims, 1 edge");
    assert.match(lines[1] ?? "", /^\w{4,} {2}open {2}\(n : ℕ\) : n \+ 0 = n$/);
    assert.match(lines[2] ?? "", /^\w{4,} {2}open {2}: ¬ \(∀ \(n : ℕ\), n \+ 0 = n\)$/);
    assert.match(lines[3] ?? "", /^\w{4,} -negation_of\[lean_checked\]-> \w{4,}$/);
    assert.deepEqual(nodes(events, "twin").map((n) => [n.checked, n.end, n.tries]), [[true, "proof", 0]]);
  });

  it("tells the provers which open lemmas the claim would follow from", { timeout: 30000 }, async () => {
    // A line before M2 leaves a strengthening of the claim open, with its edge checked: proving it would prove the claim.
    const prepare: Line = {
      id: "M1",
      title: "prepares an open strengthening",
      requires: [],
      hooks: {
        beforeProvers: async (problem) => {
          const header = problem.target.sketch.prefix;
          const variant = await createVariant(problem.memory, { from: problem.claimId, relation: "strengthening", statement: "(n : ℕ) : n + 0 = n ∧ 0 + n = n", header });
          const checked = await checkEdge({ memory: problem.memory, validate: problem.validate, header, closers: ["exact trivial_proof"] }, variant.edge.edgeId);
          assert.equal(checked.checked, true);
        },
      },
    };
    const openings: string[] = [];
    const { result, events } = await demoRun({
      lines: { M1: prepare, M2: m2Line },
      config: { lines: ["M1", "M2"], lineOptions: { M2: { twin: false } } },
      lean: new DemoLean(toyAnswer),
      responses: [
        (context) => {
          openings.push(textOf(context.messages.find((m) => m.role === "user")));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.match(
      openings[0] ?? "",
      /# What the graph knows\nThe claim follows from lemmas that are still open in the graph:\n- once \w{4,} \(\(n : ℕ\) : n \+ 0 = n ∧ 0 \+ n = n\) is proved(\n|$)/,
    );
    assert.doesNotMatch(openings[0] ?? "", /negation/, "without a twin the briefing says nothing of one");
    assert.deepEqual(nodes(events, "twin"), []);
  });

  it("can leave out the twin, the tool and the propagation", { timeout: 30000 }, async () => {
    const openings: string[] = [];
    const { result, events, lean: engine } = await demoRun({
      lines: { M2: m2Line },
      config: { lines: ["M2"], lineOptions: { M2: { twin: false, queryTool: false, propagate: false } } },
      lean: new DemoLean(toyAnswer),
      responses: [
        (context) => {
          openings.push(textOf(context.messages.find((m) => m.role === "user")));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(nodes(events, "twin"), []);
    assert.equal(ofType(events, "edge.added").length, 0);
    assert.doesNotMatch(openings[0] ?? "", /What the graph knows/);
    assert.equal((engine as DemoLean).calls.every((c) => !c.code.includes("Iff.rfl")), true);
    // The tool is not offered: a call to it is an unknown tool, which the model is told.
    const asked = await demoRun({
      lines: { M2: m2Line },
      config: { lines: ["M2"], lineOptions: { M2: { twin: false, queryTool: false } } },
      lean: new DemoLean(toyAnswer),
      responses: [call("graph_neighbors", {}), check("exact trivial_proof")],
    });
    assert.equal(ofType(asked.events, "attempt.finished").length, 1);
  });

  it("goes on without a twin when Lean does not accept the link lemma, and asks the model nothing", { timeout: 30000 }, async () => {
    let asked = 0;
    const answer = (code: string) =>
      (proofOf(code) ?? "").includes("Iff.rfl") ? { messages: [{ severity: "error" as const, pos: { line: 1, column: 0 }, text: "type mismatch" }] } : toyAnswer(code);
    const { result, events } = await demoRun({
      lines: { M2: m2Line },
      config: { lines: ["M2"] },
      lean: new DemoLean(answer),
      responses: [
        (context) => {
          if (isTwin(context)) asked += 1;
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(asked, 0, "an unchecked edge propagates nothing, so the refutation side does not run");
    const [twin] = nodes(events, "twin") as Array<Partial<TwinRecord>>;
    assert.deepEqual([twin?.checked, twin?.end, twin?.tries], [false, "proof", 0]);
    assert.deepEqual(ofType(events, "edge.status_changed"), []);
  });
});
