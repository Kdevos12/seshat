import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { INFORMAL_PROOF_KIND, informalProofOfNodes, informalSection } from "@seshat/memory";
import type { Llm } from "@seshat/lines";
import { withJson } from "@seshat/lines";
import { checkInformalFirst, informalSettings, lookupFacts, runInformalLoop, splitProof } from "../src/informal.ts";
import { createM12Line } from "@seshat/scheduler";
import { BP_AUX, BP_PROOF, blueprintAnswer } from "./blueprint-helpers.ts";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { sessionPromptOf } from "./resume-helpers.ts";

/**
 * The informal proof first (PA13, NL2, AL1, AL2): faux provider and a simulated Lean. The faux provider answers in order, whatever the model, so a
 * script lists the generator's, the verifier's and the prover's answers as the loop asks for them.
 */
type Context = Parameters<typeof sessionPromptOf>[0];
interface Seen {
  model: string;
  system: string;
  prompt: string;
  messages: string;
}
const watching = (seen: Seen[], response: ReturnType<typeof say>) => (context: Context, _options: unknown, _state: unknown, model: { id: string }) => {
  seen.push({ model: model.id, system: (context as { systemPrompt?: string }).systemPrompt ?? "", prompt: sessionPromptOf(context), messages: JSON.stringify(context.messages) });
  return response;
};

const PROOF_A = "Proof A. Zero is the identity of addition on the left and on the right, by induction on n.";
const PROOF_B = "Proof B. Unfold the definition of addition: n + 0 is n by the first equation, so we are done.";
const PROOF_C = "Proof C, the repaired one. Induct on n; the step uses the hypothesis and the second equation of addition.";
const FACTS = "\n\nMathlib facts:\n- Nat.add_zero\n- Nat.succ_add";
const gen = (proof: string, facts = FACTS) => say(`${proof}${facts}`);
const verdict = (v: string, findings: string[] = []) => say(JSON.stringify({ verdict: v, findings }));
const correct = () => verdict("correct");
/** A prover that does not solve: one failing check, then its notes. The claim stays open. */
const failingProver = () => [check("exact bad"), say("Notes.")];

const informalCalls = (events: readonly HarnessEvent[]) => ofType(events, "model_call.finished").filter((m) => String(m.data.site).startsWith("informal."));
const sites = (events: readonly HarnessEvent[]) => informalCalls(events).map((m) => m.data.site);
const nodes = (events: readonly HarnessEvent[]) => ofType(events, "node.recorded").filter((e) => e.data.kind === INFORMAL_PROOF_KIND);
const nodeData = (events: readonly HarnessEvent[]) => nodes(events)[0]?.data.data as Record<string, unknown>;

async function run(responses: unknown[], informalFirst: { passes?: number; rounds?: number } = {}, extra: Parameters<typeof demoRun>[0] extends infer O ? Partial<O> : never = {}) {
  return await demoRun({ config: { sessions: 1, informalFirst, ...(extra.config ?? {}) }, ...extra, responses: responses as never });
}

describe("the informal proof first (PA13, NL2, AL1)", () => {
  it("accepts a proof after three correct verdicts in a row, journals it as a hint of the claim and leaves the claim open", async () => {
    const prompts: string[] = [];
    const { events, faux } = await run([gen(PROOF_A), correct(), correct(), correct(), (context: Context) => { prompts.push(sessionPromptOf(context)); return check("exact bad"); }, say("Notes.")]);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(sites(events), ["informal.generate", "informal.verify", "informal.verify", "informal.verify"]);
    const [node, ...more] = nodes(events);
    assert.equal(more.length, 0);
    const data = nodeData(events);
    assert.equal(data.accepted, true);
    assert.equal(data.passes, 3);
    assert.equal(data.rounds, 1);
    assert.deepEqual(data.verdicts, ["correct", "correct", "correct"]);
    assert.equal(data.stop, "accepted");
    assert.deepEqual(data.facts, ["Nat.add_zero", "Nat.succ_add"]);
    assert.deepEqual(data.hits, [], "the host has no lean.search");
    // On the problem's claim; the proof is a blob.
    const [problem] = ofType(events, "problem.registered");
    assert.equal(node?.data.claimId, problem?.data.claimId);
    assert.equal(typeof data.proofHash, "string");
    // Never a status: the claim is open at the end, no status event touched it, and no word of the node says proved.
    assert.equal(ofType(events, "claim.status_changed").filter((e) => e.data.claimId === problem?.data.claimId).length, 0);
    assert.equal(ofType(events, "claim.created").find((c) => c.data.claimId === problem?.data.claimId)?.data.status, "open");
    assert.doesNotMatch(JSON.stringify(node?.data), /proved/i);
    // Charged to the problem, at the sites, from the line of the loop.
    for (const call of informalCalls(events)) {
      assert.equal(call.data.problemId, problem?.data.problemId);
      assert.equal(call.data.line, "informal");
      assert.equal(call.data.outcome, "ok");
    }
    // The first briefing of the outer prover: the proof, marked, and the facts. Before any session.
    const first = prompts[0] ?? "";
    assert.match(first, /# An informal proof, checked by 3 verifier passes and not by Lean/);
    assert.match(first, /> Proof A\. Zero is the identity/);
    assert.match(first, /Mathlib facts it relies on, as it names them: Nat\.add_zero; Nat\.succ_add/);
    assert.ok(events.findIndex((e) => e.type === "attempt.started") > events.indexOf(node as HarnessEvent));
  });

  it("sends the statement, its docstring and a person's sketch to the generator, in a fresh call", async () => {
    const seen: Seen[] = [];
    await run([watching(seen, gen(PROOF_A)) as never, correct(), correct(), correct(), ...failingProver()], {}, { user: "ada", sketch: "Induct on n." });
    const [generate] = seen;
    assert.match(generate?.prompt ?? "", /theorem target \(n : ℕ\) : n \+ 0 = n/);
    assert.match(generate?.prompt ?? "", /Adding zero changes nothing\./);
    assert.match(generate?.prompt ?? "", /A sketch from ada/);
    assert.match(generate?.prompt ?? "", /> Induct on n\./);
    assert.match(generate?.prompt ?? "", /Mathlib facts:/);
    assert.equal(generate?.messages.includes("An earlier approach failed"), false);
  });

  it("revises a fixable proof with its findings, and the verdicts after the revision count from zero", async () => {
    const seen: Seen[] = [];
    const { events, faux } = await run([
      gen(PROOF_A),
      correct(),
      correct(),
      verdict("fixable", ["The base case is missing", "The step uses an unproved lemma"]),
      watching(seen, gen(PROOF_C)) as never,
      correct(),
      correct(),
      correct(),
      ...failingProver(),
    ]);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(sites(events), ["informal.generate", "informal.verify", "informal.verify", "informal.verify", "informal.revise", "informal.verify", "informal.verify", "informal.verify"]);
    const [revise] = seen;
    assert.match(revise?.prompt ?? "", /Proof A\./, "the revision reads the previous proof");
    assert.match(revise?.prompt ?? "", /- The base case is missing\n- The step uses an unproved lemma/, "and the findings");
    const data = nodeData(events);
    assert.equal(data.accepted, true);
    assert.equal(data.rounds, 2);
    assert.equal(data.passes, 3, "three in a row after the revision, not the two before it");
    assert.deepEqual(data.verdicts, ["correct", "correct", "fixable", "correct", "correct", "correct"]);
  });

  it("starts a fresh generation after a wrong verdict, which does not see the rejected proof, only one line", async () => {
    const seen: Seen[] = [];
    const { events, faux } = await run([
      gen(PROOF_A),
      verdict("wrong", ["The induction divides by zero in the step", "A second finding"]),
      watching(seen, gen(PROOF_B)) as never,
      correct(),
      correct(),
      correct(),
      ...failingProver(),
    ]);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(sites(events).slice(0, 3), ["informal.generate", "informal.verify", "informal.generate"]);
    const [again] = seen;
    assert.doesNotMatch(again?.messages ?? "", /Proof A/, "the rejected proof is not shown");
    assert.doesNotMatch(again?.messages ?? "", /A second finding/);
    assert.match(again?.prompt ?? "", /An earlier approach failed: The induction divides by zero in the step\./);
    assert.equal(nodeData(events).accepted, true);
  });

  it("gives the verifier the final proof text only: no reasoning content, no earlier round, no finding, no list of facts", async () => {
    const seen: Seen[] = [];
    const thought = (proof: string) => fauxAssistantMessage([fauxThinking("SECRET REASONING of the generator"), fauxText(`${proof}${FACTS}`)]);
    await run([
      thought(PROOF_A) as never,
      watching(seen, verdict("fixable", ["FINDING one"])) as never,
      thought(PROOF_C) as never,
      watching(seen, correct()) as never,
      watching(seen, correct()) as never,
      watching(seen, correct()) as never,
      ...failingProver(),
    ]);
    assert.equal(seen.length, 4);
    const [first, ...later] = seen as [Seen, ...Seen[]];
    assert.match(first.prompt, /Proof A\./);
    for (const request of [first, ...later]) {
      assert.doesNotMatch(request.messages, /SECRET REASONING/, "no reasoning content");
      assert.doesNotMatch(request.messages, /Nat\.succ_add/, "not the facts the generator listed");
      assert.equal((JSON.parse(request.messages) as Array<{ role: string }>).filter((m) => m.role !== "system").length, 1, "one user message: no conversation");
    }
    for (const request of later) {
      assert.match(request.prompt, /Proof C, the repaired one/, "the final text");
      assert.doesNotMatch(request.messages, /Proof A/, "no earlier round");
      assert.doesNotMatch(request.messages, /FINDING one/, "no verifier finding");
    }
  });

  it("stops at the rounds cap and keeps the last proof as not accepted: nobody is shown it", async () => {
    const prompts: string[] = [];
    const { events, faux } = await run(
      [gen(PROOF_A), verdict("wrong", ["no"]), gen(PROOF_B), verdict("wrong", ["still no"]), (context: Context) => { prompts.push(sessionPromptOf(context)); return check("exact bad"); }, say("Notes.")],
      { rounds: 2 },
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(sites(events), ["informal.generate", "informal.verify", "informal.generate", "informal.verify"]);
    const data = nodeData(events);
    assert.equal(data.accepted, false);
    assert.equal(data.rounds, 2);
    assert.equal(data.stop, "rounds");
    assert.equal(data.passes, 0);
    assert.equal(typeof data.proofHash, "string", "the last proof is kept in the journal");
    assert.doesNotMatch(prompts[0] ?? "", /Proof B|informal proof/i, "a proof that was not accepted is shown to no one");
  });

  it("sends the verifier's calls to the verifier role's model and the generator's to the planner role's, recording the role", async () => {
    const seen: Seen[] = [];
    const { events, faux } = await run(
      [watching(seen, gen(PROOF_A)) as never, watching(seen, correct()) as never, watching(seen, correct()) as never, watching(seen, correct()) as never, ...failingProver()],
      {},
      { extraModels: ["planner", "verifier"], config: { sessions: 1, informalFirst: {}, roles: { planner: { model: "faux/planner" }, verifier: { model: "faux/verifier" } } } },
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(seen.map((s) => s.model), ["planner", "verifier", "verifier", "verifier"]);
    assert.deepEqual(informalCalls(events).map((m) => [m.data.model, m.data.role]), [["faux/planner", "planner"], ["faux/verifier", "verifier"], ["faux/verifier", "verifier"], ["faux/verifier", "verifier"]]);
    assert.deepEqual(nodeData(events).models, { planner: "faux/planner", verifier: "faux/verifier" });
  });

  it("verifies with the generator's model in a fresh context when no verifier role is named", async () => {
    const seen: Seen[] = [];
    const { events } = await run([gen(PROOF_A), watching(seen, correct()) as never, correct(), correct(), ...failingProver()]);
    assert.equal(seen[0]?.model, "prover");
    assert.deepEqual(nodeData(events).models, { planner: "faux/prover", verifier: "faux/prover" });
    assert.equal((JSON.parse(seen[0]?.messages ?? "[]") as Array<{ role: string }>).filter((m) => m.role !== "system").length, 1);
  });

  it("reaches the planner's prompt of a refinement round when accepted, and not when it is not", async () => {
    const planner = async (informal: unknown[], accepted: boolean) => {
      const prompts: string[] = [];
      const { faux, events } = await demoRun({
        lines: { M12: createM12Line() },
        config: { lines: ["M12"], provers: 1, sessions: 1, informalFirst: { rounds: 1 }, lineOptions: { M12: { blueprints: true, refine: true, holeSessions: 1, rounds: 1, ageRatio: 1, weightRatio: 0, maxInnerTasks: 0 } } },
        lean: new DemoLean(blueprintAnswer),
        responses: [...informal, check("exact main_ok", BP_AUX), say("Done."), ((context: Context) => { prompts.push(sessionPromptOf(context)); return say(JSON.stringify({ aux: BP_AUX, proof: BP_PROOF })); }) as never] as never,
      });
      assert.equal(faux.getPendingResponseCount(), 0);
      assert.equal(nodeData(events).accepted, accepted);
      return prompts[0] ?? "";
    };
    const accepted = await planner([gen(PROOF_A), correct(), correct(), correct()], true);
    assert.match(accepted, /An informal proof, checked by 3 verifier passes and not by Lean\. Use it as a hint/);
    assert.match(accepted, /> Proof A\./);
    const rejected = await planner([gen(PROOF_B), verdict("wrong", ["no"])], false);
    assert.doesNotMatch(rejected, /informal proof|Proof B/i);
  });

  it("is recorded in the run's configuration with its defaults", async () => {
    const { events } = await run([gen(PROOF_A), correct(), correct(), correct(), ...failingProver()]);
    const started = ofType(events, "run.started")[0];
    assert.deepEqual((started?.data.config as { informalFirst?: unknown }).informalFirst, { passes: 3, rounds: 4 });
  });

  it("is off without the setting: no call, no node, the prompt as it was", async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({ config: { sessions: 1 }, responses: [(context: Context) => { prompts.push(sessionPromptOf(context)); return check("exact bad"); }, say("Notes.")] as never });
    assert.equal(informalCalls(events).length, 0);
    assert.equal(nodes(events).length, 0);
    assert.doesNotMatch(prompts[0] ?? "", /informal proof/i);
  });

  it("is not run again when the journal holds its node, and is run again, from its start, when the process was cut before it", async () => {
    const script = () => [gen(PROOF_A), correct(), correct(), correct(), ...failingProver()];
    const whole = await run(script());
    // Cut after the node: the resumed process makes no informal call and keeps the node.
    const after = killedAt(whole.dir, (e) => e.type === "attempt.started");
    const logs: string[] = [];
    const kept = await demoResume({ dir: after, bench: whole.bench, responses: failingProver() as never, log: (l) => logs.push(l) });
    assert.equal(informalCalls(kept.events).length, 4, "the four calls of the first process, none more");
    assert.equal(nodes(kept.events).length, 1);
    // Cut mid-way (after the second verdict): no node, so the loop is run again, from its start, and says so.
    let made = 0;
    const mid = killedAt(whole.dir, (e) => e.type === "model_call.finished" && String(e.data.site).startsWith("informal.") && ++made === 4);
    const again = await demoResume({ dir: mid, bench: whole.bench, responses: script().slice(0, 4).concat(failingProver() as never), log: (l) => logs.push(l) });
    assert.equal(nodes(again.events).length, 1);
    assert.equal(informalCalls(again.events).length, 3 + 4, "the calls of the cut loop stay in the journal and the loop is run again");
    assert.ok(logs.some((l) => /informal proof has no record in the journal: its loop is run again from its start/.test(l)));
    assert.equal(again.faux.getPendingResponseCount(), 0);
  });
});

describe("the informal loop, alone", () => {
  /** An `Llm` that answers from a script, recording each request. */
  function scripted(answers: string[]) {
    const requests: Array<{ site?: string; prompt: string }> = [];
    const queue = [...answers];
    const llm: Llm = withJson(async (request) => {
      requests.push({ ...(request.site !== undefined ? { site: request.site } : {}), prompt: request.prompt });
      const text = queue.shift() ?? "";
      return { text, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, model: "m", modelCallId: `mc${requests.length}` };
    });
    return { llm, requests };
  }
  const base = { statement: "(n : ℕ) : n + 0 = n", signal: new AbortController().signal, estimateUsd: 0.01 };
  const json = (v: string, findings: string[] = []) => JSON.stringify({ verdict: v, findings });

  it("is asked of the gate before every call, and a skip ends the loop with what it has", async () => {
    const { llm, requests } = scripted([PROOF_A, json("correct"), json("correct"), json("correct")]);
    const asked: number[] = [];
    // The gate lets two calls through (the generation and the first verification) and skips the third.
    const outcome = await runInformalLoop({
      ...base,
      llm,
      settings: { passes: 3, rounds: 4 },
      ask: async (estimate) => {
        asked.push(estimate);
        return asked.length <= 2 ? { action: "launch", reason: "ok" } : { action: "skip", reason: "the gate: no room" };
      },
    });
    assert.equal(outcome.stop, "gate");
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.detail, "the gate: no room");
    assert.equal(requests.length, 2);
    assert.deepEqual(asked, [0.01, 0.01, 0.01]);
    assert.equal(outcome.proof, PROOF_A, "the last proof is kept, not accepted");
    assert.equal(outcome.passes, 1);
  });

  it("is skipped from the start: no call is made and no proof exists", async () => {
    const { llm, requests } = scripted([]);
    const outcome = await runInformalLoop({ ...base, llm, settings: { passes: 3, rounds: 4 }, ask: async () => ({ action: "skip", reason: "no" }) });
    assert.equal(requests.length, 0);
    assert.equal(outcome.proof, undefined);
    assert.equal(outcome.stop, "gate");
  });

  it("ends, not accepted, when the verifier's answer is not a verdict", async () => {
    const { llm } = scripted([PROOF_A, "not json", "still not json"]);
    const outcome = await runInformalLoop({ ...base, llm, settings: { passes: 1, rounds: 2 } });
    assert.equal(outcome.stop, "failed");
    assert.match(outcome.detail ?? "", /verifier's answer was not a verdict/);
    assert.equal(outcome.proof, PROOF_A);
  });

  it("counts one pass per correct verdict, at one pass accepts at once", async () => {
    const { llm, requests } = scripted([PROOF_A, json("correct")]);
    const outcome = await runInformalLoop({ ...base, llm, settings: { passes: 1, rounds: 1 } });
    assert.equal(outcome.accepted, true);
    assert.equal(requests.length, 2);
  });

  it("splits a proof from its list of facts, at most five, and checks the setting", () => {
    assert.deepEqual(splitProof(`${PROOF_A}\n\n**Mathlib facts:**\n1. Nat.add_zero\n- a\n- b\n- c\n- d\n- e\n- f`), { proof: PROOF_A, facts: ["Nat.add_zero", "a", "b", "c", "d"] });
    assert.deepEqual(splitProof(PROOF_A), { proof: PROOF_A, facts: [] });
    assert.deepEqual(informalSettings({}), { passes: 3, rounds: 4 });
    assert.deepEqual(informalSettings({ passes: 2, rounds: 6 }), { passes: 2, rounds: 6 });
    assert.deepEqual(checkInformalFirst({}), []);
    assert.equal(checkInformalFirst({ passes: 0 }).length, 1);
    assert.equal(checkInformalFirst({ rounds: 1.5 }).length, 1);
    assert.equal(checkInformalFirst({ passes: 1, ...({ extra: 1 } as object) }).length, 1);
  });

  it("looks the facts up with at most five queries and keeps each name once", async () => {
    const queries: string[] = [];
    const names = await lookupFacts(["a", "b", "c", "d", "e", "f", "g"], async (query) => {
      queries.push(query);
      return query === "a" ? ["Nat.add_zero", "Nat.zero_add", "x", "y"] : query === "b" ? ["Nat.add_zero"] : undefined;
    });
    assert.equal(queries.length, 5);
    assert.deepEqual(names, ["Nat.add_zero", "Nat.zero_add", "x"]);
  });

  it("shows only an accepted proof, as a section that says Lean has not checked it", () => {
    const row = (data: Record<string, unknown>) => [{ node_id: "n1", data }];
    const read = (hash: string) => (hash === "h" ? PROOF_A : undefined);
    const accepted = informalProofOfNodes(row({ problemId: "p", accepted: true, passes: 3, required: 3, rounds: 1, verdicts: [], models: { planner: "a", verifier: "b" }, stop: "accepted", proofHash: "h", facts: ["F"], hits: ["H.x"] }), read);
    const section = informalSection(accepted);
    assert.equal(section?.title, "An informal proof, checked by 3 verifier passes and not by Lean");
    assert.match(section?.text ?? "", /> Proof A\./);
    assert.match(section?.text ?? "", /F/);
    assert.match(section?.text ?? "", /H\.x/);
    assert.equal(informalSection(informalProofOfNodes(row({ problemId: "p", accepted: false, passes: 0, proofHash: "h" }), read)), undefined);
    assert.equal(informalSection(undefined), undefined);
  });
});
