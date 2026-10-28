import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { type HarnessEvent, Journal } from "@seshat/core";
import type { AllocationData } from "@seshat/fleet";
import { DISCRETE } from "@seshat/bench";
import { ANTI_SYCOPHANCY } from "@seshat/lines";
import { TaskLedger } from "@seshat/scheduler";
import { Router } from "../src/routing.ts";
import { check, DEMO_FILE, DemoLean, demoAnswer, demoRun, ofType, proofOf, say, tempDir } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

function textOf(message: Message): string {
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

const opening = (context: TranscriptContext): string => textOf(context.messages.find((m) => m.role === "user") as Message);

/** The allocation nodes of a run, in order. */
function allocations(events: readonly HarnessEvent[]): AllocationData[] {
  return ofType(events, "node.recorded").filter((e) => e.data.kind === "allocation").map((e) => e.data.data as AllocationData);
}

const nodesOf = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind);

const FLEET = { lines: ["M1", "fleet"] };
const seed = (n: number, more: Record<string, unknown> = {}) => ({ lineOptions: { fleet: { seed: n, epsilon: 0, widen: false, ...more } } as never });

describe("sampled settings in a run", () => {
  it("records the settings on the attempt and acts on them: the temperature and thinking level reach the model", async () => {
    const seen: Array<{ temperature: number | undefined; reasoning: string | undefined }> = [];
    const respond = (context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessage => {
      seen.push({ temperature: options?.temperature, reasoning: options?.reasoning });
      return context.messages.some((m) => m.role === "toolResult") ? say("notes") : check("exact trivial_proof");
    };
    const { result, events } = await demoRun({
      config: { ...FLEET, ...seed(1, { strategies: false, temperature: 0.37, thinking: ["high"] }), sessions: 1 },
      responses: [respond, respond],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const started = ofType(events, "attempt.started")[0]?.data;
    assert.deepEqual(started?.settings, { temperature: 0.37, thinking: "high" });
    assert.equal(seen[0]?.temperature, 0.37, "the provider is asked with the temperature the fleet sampled");
    assert.equal(seen[0]?.reasoning, "high");
    assert.deepEqual(allocations(events)[0]?.settings, { temperature: 0.37, thinking: "high" });
  });

  it("leaves the run's own settings alone when nothing is sampled", async () => {
    const seen: Array<number | undefined> = [];
    const respond = (_context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessage => {
      seen.push(options?.temperature);
      return check("exact trivial_proof");
    };
    const { events } = await demoRun({ config: { ...FLEET, ...seed(1), sessions: 1 }, responses: [respond] });
    assert.equal(ofType(events, "attempt.started")[0]?.data.settings, undefined);
    assert.equal(seen[0], undefined);
  });

  it("gives a session a diversity directive in its briefing, framed so that M6 flags nothing", async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({
      file: DEMO_FILE.replaceAll("research solved", "research open"),
      filter: { ...DISCRETE, categories: ["research solved", "research open"] },
      config: { lines: ["M1", "M6", "fleet"], ...seed(2, { strategies: false, directives: true }), sessions: 1 },
      responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    const label = ofType(events, "attempt.started")[0]?.data.settings?.directive as string;
    assert.ok(label !== undefined && /^(small_cases|more_general|other_tool|shortest|skeleton|doubt)$/.test(label), label);
    assert.match(prompts[0] ?? "", /\n\n# Directive for this session\nThe harness drew this directive for the session/);
    assert.ok(!nodesOf(events, "drift").length, "M6 found nothing to flag in the directive");
  });
});

describe("the anti-sycophancy instruction (PC10)", () => {
  it("ends M6's question about an open conjecture, once, and no prompt shows a verdict of another agent", async () => {
    const prompts: string[] = [];
    await demoRun({
      file: DEMO_FILE.replaceAll("research solved", "research open"),
      filter: { ...DISCRETE, categories: ["research solved", "research open"] },
      config: { lines: ["M1", "M6"], sessions: 1 },
      responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.ok((prompts[0] ?? "").includes(ANTI_SYCOPHANCY));
    assert.equal((prompts[0] ?? "").split(ANTI_SYCOPHANCY).length, 2, "once");
  });

  it("leaves the question about a solved problem as it was", async () => {
    const prompts: string[] = [];
    await demoRun({ config: { lines: ["M1", "M6"], sessions: 1 }, responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }] });
    assert.ok(!(prompts[0] ?? "").includes(ANTI_SYCOPHANCY));
  });
});

describe("informal-first sessions (nl_first)", () => {
  const dag = {
    proof: "Adding zero changes nothing, by the definition of addition.",
    steps: [
      { id: "s1", statement: "Zero is a right identity for addition on the naturals.", dependsOn: [] },
      { id: "s2", statement: "Hence n + 0 = n for every n.", dependsOn: ["s1"] },
      { id: "s3", statement: "The theorem is an instance of the previous statement.", dependsOn: ["s2"] },
    ],
  };
  const cyclic = { proof: "p", steps: [{ id: "a", statement: "A", dependsOn: ["b"] }, { id: "b", statement: "B", dependsOn: ["a"] }] };
  const AUX = "lemma aux_s1 : True := by\n  trivial\n\nlemma aux_s2 : True := by\n  nope\n";

  /** A Lean that finds an error in the lemma aux_s2, whatever the proof, unless the proof is the accepted one. */
  const leanWithError = () =>
    new DemoLean((code) => {
      const proof = proofOf(code);
      if (proof === undefined || proof.includes("exact trivial_proof")) return demoAnswer(code);
      const lines = code.split("\n");
      const at = lines.findIndex((line) => line.startsWith("lemma aux_s2"));
      return at < 0 ? demoAnswer(code) : { messages: [{ severity: "error", pos: { line: at + 2, column: 2 }, text: "unknown tactic" }] };
    });

  const isDagCall = (context: TranscriptContext): boolean => opening(context).includes("write the informal argument, and break it into");

  it("asks for a step DAG, checks it, records it with the steps as open claims, and briefs the session with it", async () => {
    const prompts: string[] = [];
    const respond = (context: TranscriptContext): AssistantMessage => {
      if (isDagCall(context)) return say(JSON.stringify(dag));
      if (context.messages.some((m) => m.role === "toolResult")) return say("notes");
      prompts.push(opening(context));
      return check(prompts.length === 1 ? "omega" : "exact trivial_proof", AUX);
    };
    const { result, events } = await demoRun({
      lean: leanWithError(),
      config: { ...FLEET, ...seed(4, { strategies: false, modes: ["nl_first"] }), sessions: 2 },
      responses: Array.from({ length: 10 }, () => respond),
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    // One call for the DAG, for the whole claim: the second session reads the recorded one.
    assert.equal(ofType(events, "model_call.finished").filter((e) => e.data.site === "fleet.dag").length, 1);
    const [recorded] = nodesOf(events, "step_dag");
    assert.equal(recorded?.actor, "line:fleet");
    assert.ok(recorded?.data.provenance !== undefined, "learned, so it is stamped");
    // Each step is an informal claim of the fleet; they and the target are linked by decomposes_into edges, as proposals.
    const claims = ofType(events, "claim.created").filter((e) => e.data.origin === "line:fleet");
    assert.deepEqual(claims.map((e) => e.data.statement), dag.steps.map((s) => s.statement));
    const edges = ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into");
    assert.equal(edges.length, 3);
    assert.ok(edges.every((e) => e.data.status === "proposed"));
    // No status moved but the target's, by Lean: the steps stay open.
    const moved = ofType(events, "claim.status_changed").map((e) => e.data.claimId);
    assert.ok(claims.every((c) => !moved.includes(c.data.claimId)), "an informal step never changes status");
    // The sessions were told the plan, and the second one what Lean said of each lemma.
    assert.match(prompts[0] ?? "", /\n\n# Step plan\nThis session works informal-first\./);
    assert.match(prompts[0] ?? "", /- s2 \(uses s1\): Hence n \+ 0 = n for every n\./);
    assert.doesNotMatch(prompts[0] ?? "", /Lean reports an error in it/);
    assert.match(prompts[1] ?? "", /- s1 \(uses nothing before it; closed \(Lean accepts its lemma without a hole\)\)/);
    assert.match(prompts[1] ?? "", /- s2 \(uses s1; Lean reports an error in it\)/);
    assert.match(prompts[1] ?? "", /- s3 \(uses s2; no lemma for it yet\)/);
    // Lean's errors went back to the step they are in, as counts and states.
    const [status] = nodesOf(events, "step_status");
    assert.deepEqual((status?.data.data as { states: unknown }).states, { s1: "closed", s2: "error", s3: "missing" });
    assert.equal(JSON.stringify(status?.data.data).includes("unknown tactic"), false, "no text of Lean's is kept");
    // The allocation says where the plan came from, and the attempt that the session ran in this mode.
    assert.deepEqual(allocations(events).map((a) => [a.settings?.mode, a.dag === recorded?.data.nodeId]), [["nl_first", true], ["nl_first", true]]);
    assert.deepEqual(ofType(events, "attempt.started").map((e) => e.data.settings?.mode), ["nl_first", "nl_first"]);
  });

  it("runs the session as a standard one, and says so, when the model cannot write a DAG that checks", async () => {
    const prompts: string[] = [];
    const respond = (context: TranscriptContext): AssistantMessage => {
      if (isDagCall(context)) return say(JSON.stringify(cyclic));
      if (context.messages.some((m) => m.role === "toolResult")) return say("notes");
      prompts.push(opening(context));
      return check("exact trivial_proof");
    };
    const { result, events } = await demoRun({
      config: { ...FLEET, ...seed(5, { strategies: false, modes: ["nl_first"] }), sessions: 1 },
      responses: Array.from({ length: 8 }, () => respond),
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(ofType(events, "model_call.finished").filter((e) => e.data.site === "fleet.dag").length, 2, "the DAG is asked for once more with what was wrong");
    assert.equal(nodesOf(events, "step_dag").length, 0);
    assert.equal(nodesOf(events, "step_dag_failure").length, 1);
    assert.equal(ofType(events, "attempt.started")[0]?.data.settings?.mode, "standard");
    const [record] = allocations(events);
    assert.match(record?.dagNote ?? "", /the step DAG did not check: the steps form a cycle/);
    assert.doesNotMatch(prompts[0] ?? "", /# Step plan/);
  });

  it("stops asking after two failed tries on a claim", async () => {
    const respond = (context: TranscriptContext): AssistantMessage => {
      if (isDagCall(context)) return say(JSON.stringify(cyclic));
      if (context.messages.some((m) => m.role === "toolResult")) return say("notes");
      return check("omega");
    };
    const { events } = await demoRun({
      config: { ...FLEET, ...seed(6, { strategies: false, modes: ["nl_first"] }), sessions: 4 },
      responses: Array.from({ length: 30 }, () => respond),
    });
    assert.equal(nodesOf(events, "step_dag_failure").length, 2);
    assert.equal(ofType(events, "model_call.finished").filter((e) => e.data.site === "fleet.dag").length, 4, "two tries of two calls");
    const notes = allocations(events).map((a) => a.dagNote ?? "");
    assert.match(notes[2] ?? "", /no step DAG that checks after 2 tries on this claim/);
  });
});

describe("routing a stalled claim to a stronger model (retry_stronger)", () => {
  const loop = [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), check("exact trivial_proof")];
  const rows = (events: readonly HarnessEvent[]) => ofType(events, "task.routed").map((e) => [e.data.action, e.data.signal.value]);

  it("takes the place of branch when every failure ran under a weaker model, and the next session uses the strongest", async () => {
    const { result, events } = await demoRun({
      extraModels: ["strong"],
      config: { lines: ["M1", "M6", "fleet"], sessions: 2, ...seed(7, { strategies: false, ranking: ["faux/prover", "faux/strong"] }) },
      responses: loop,
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(rows(events), [["retry_fresh", "unsolved_goals"], ["retry_stronger", "strategy_loop"]]);
    const routed = ofType(events, "task.routed").find((e) => e.data.action === "retry_stronger");
    assert.match(routed?.data.reason ?? "", /^a guard found strategy_loop \(stopped_session\).*try that first, before/s);
    // The first session decided nothing (no strategy, no model), so it left no allocation: the only one is the second session's.
    const [second] = allocations(events);
    assert.equal(allocations(events).length, 1);
    assert.deepEqual([second?.model, second?.routed], ["faux/strong", "retry_stronger"]);
    assert.deepEqual(ofType(events, "attempt.started").map((e) => e.data.model), ["faux/prover", "faux/strong"]);
  });

  it("leaves the branch when the failure already ran under the strongest model", async () => {
    const { events } = await demoRun({
      extraModels: ["strong"],
      config: { lines: ["M1", "M6", "fleet"], sessions: 2, ...seed(8, { strategies: false, models: ["faux/strong"], ranking: ["faux/prover", "faux/strong"] }) },
      responses: loop,
    });
    assert.deepEqual(rows(events), [["retry_fresh", "unsolved_goals"], ["branch", "strategy_loop"]]);
    assert.ok(allocations(events).every((a) => a.routed === undefined));
  });

  it("is a Router decision of the claim's attempts alone: a unit check of the three cases", () => {
    const setup = (model: string, ranking?: { order: string[]; budgetClass: string }) => {
      const journal = Journal.open(tempDir(), "run_1");
      const o = "orchestrator";
      journal.emit("claim.created", { claimId: "clm_1", statementId: "st0", statement: ": A", origin: "bench", status: "open" }, o);
      journal.emit("problem.registered", { problemId: "prb_1", claimId: "clm_1", target: "t", source: { repo: "r", rev: "v", path: "X.lean" }, domain: [] }, o);
      const tasks = new TaskLedger(journal);
      const taskId = tasks.create({ kind: "prove", problemId: "prb_1", claimId: "clm_1", owner: "prover:p1", acceptance: { type: "claim", claimId: "clm_1", minStatus: "computed" } });
      tasks.markReady(taskId, "no dependencies");
      tasks.start(taskId, "the prover starts");
      journal.emit("attempt.started", { attemptId: "att_1", claimId: "clm_1", prover: "p1", iteration: 1, model }, "prover:p1");
      journal.emit("attempt.finished", { attemptId: "att_1", outcome: "invalid", failureClass: "unsolved_goals", stoppedBy: "model", durationMs: 1, turns: 1, usd: 0, inputTokens: 0, outputTokens: 0 }, "prover:p1");
      journal.emit("node.recorded", { nodeId: "nod_1", kind: "drift", claimId: "clm_1", data: { kind: "strategy_loop", action: "stopped_session", detail: "3 checks", attemptId: "att_1", prover: "p1" } }, "line:M6");
      return { journal, taskId, router: new Router(journal, tasks, ranking) };
    };
    const ranking = { order: ["faux/prover", "faux/strong"], budgetClass: "small" };
    for (const [model, given, expected] of [
      ["faux/prover", ranking, "retry_stronger"],
      ["faux/strong", ranking, "branch"],
      ["faux/prover", undefined, "branch"],
    ] as const) {
      const { journal, taskId, router } = setup(model, given);
      const decisions = router.attemptEnded({ attemptId: "att_1", taskId, claimId: "clm_1" });
      assert.deepEqual(decisions.map((d) => d.action), [expected], `${model} ${given === undefined ? "unranked" : "ranked"}`);
      journal.close();
    }
  });
});

describe("the soft failure memory across runs", () => {
  const respond = (prompts: string[]) => (context: TranscriptContext): AssistantMessage => {
    if (context.messages.some((m) => m.role === "toolResult")) return say("notes");
    prompts.push(opening(context));
    return check("exact trivial_proof");
  };
  const earlier = () => demoRun({ extraModels: ["strong"], config: { ...FLEET, ...seed(9), sessions: 2 }, responses: [check("omega"), say("a"), check("omega"), say("b")] });

  it("counts an earlier run's failures gamma each in the posteriors: Beta(1, 1 + 2 * 0.8), not Beta(1, 3)", async () => {
    const first = await earlier();
    const prompts: string[] = [];
    const second = await demoRun({
      extraModels: ["strong"], bench: first.bench, memoryFrom: first.dir,
      config: { ...FLEET, ...seed(9, { gamma: 0.8 }), sessions: 1 }, responses: [respond(prompts), respond(prompts)],
    });
    const [record] = allocations(second.events);
    assert.equal(record?.attempts, 2);
    assert.equal(record?.successRate, 0.2778, "alpha 1, beta 1 + 2 * 0.8: 1 / 3.6");
    // Same model, same configuration: no line comes from a smaller model.
    assert.doesNotMatch(prompts[0] ?? "", /with a smaller model/);
    const undiscounted = await demoRun({
      extraModels: ["strong"], bench: first.bench, memoryFrom: first.dir,
      config: { ...FLEET, ...seed(9, { gamma: 1 }), sessions: 1 }, responses: [respond([]), respond([])],
    });
    assert.equal(allocations(undiscounted.events)[0]?.successRate, 0.25, "with gamma 1 the two failures count in full: 1 / (1 + 3)");
  });

  it("tells a session that a line comes from a smaller model, and shrinks it again by the epoch the new model opened", async () => {
    const first = await earlier();
    const prompts: string[] = [];
    const second = await demoRun({
      extraModels: ["strong"], bench: first.bench, memoryFrom: first.dir,
      config: { ...FLEET, ...seed(9, { gamma: 0.8, ranking: ["faux/prover", "faux/strong"] }), model: "faux/strong", sessions: 1 },
      responses: [respond(prompts), respond(prompts)],
    });
    assert.match(prompts[0] ?? "", /# Already tried\n[^\n]*\n?automation: 2 attempts, unsolved goals \(with a smaller model\)/);
    // gamma (one run on the problem since) times the probation of the epoch the new model family opened (0.25): 0.2 each, so beta = 1.4.
    const [record] = allocations(second.events);
    assert.equal(record?.attempts, 2);
    assert.equal(record?.successRate, 0.4167);
  });
});
