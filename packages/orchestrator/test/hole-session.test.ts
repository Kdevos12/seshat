import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line, HOLE_HISTORY_CHARS } from "@seshat/scheduler";
import { call, check, DemoLean, demoResume, demoRun, killedAt, ofType, proofOf, say } from "./m0-helpers.ts";
import { loopTelemetry } from "../src/loop-telemetry.ts";
import { BP_AUX, BP_PROOF, blueprintAnswer, HARD_AUX, LEFT_STUB, WRONG_AUX } from "./blueprint-helpers.ts";
import { assertSound, certifier, consumed, sessionPromptOf } from "./resume-helpers.ts";

const nodes = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((e) => e.data.kind === kind).map((e) => e.data.data as Record<string, unknown>);
const OPTIONS = { blueprints: true, ageRatio: 1, weightRatio: 0 };

describe("blueprints: sessions with tools on holes", () => {
  it("works a dependent hole on stubs, waits for its dependency, validates it after, and settles the problem", { timeout: 60000 }, async () => {
    const { certifier: cert } = certifier();
    const lean = new DemoLean(blueprintAnswer);
    const { result, events, faux } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 3, lineOptions: { M12: OPTIONS } },
      lean,
      certifier: cert,
      responses: [
        check(BP_PROOF, BP_AUX),
        say("Three lemmas are left."),
        // aux_right first: its work is done on the stub of aux_left; it cannot be validated yet.
        check("exact dep_ok", LEFT_STUB),
        // aux_left: proved at once.
        check("exact hole_ok"),
      ],
    });
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(result.problems[0]?.outcome, "proved");
    const claims = ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma"));
    const [right, left, third] = claims.map((c) => c.data.claimId as string);
    const status = (id: string | undefined) => ofType(events, "claim.status_changed").filter((e) => e.data.claimId === id).map((e) => e.data.to);
    for (const id of [left, right, third]) assert.deepEqual(status(id).slice(0, 1), ["computed"]);
    // The order of the events: aux_right's work is done (an m12_session with workDone) before aux_left is accepted, and aux_right is validated after.
    const at = (match: (e: HarnessEvent) => boolean) => events.findIndex(match);
    const worked = at((e) => e.type === "node.recorded" && e.data.kind === "m12_session" && (e.data.data as { workDone?: boolean }).workDone === true);
    const leftAccepted = at((e) => e.type === "claim.status_changed" && e.data.claimId === left && e.data.to === "computed");
    const rightAccepted = at((e) => e.type === "claim.status_changed" && e.data.claimId === right && e.data.to === "computed");
    assert.ok(worked >= 0 && worked < leftAccepted && leftAccepted < rightAccepted, `work ${worked}, left ${leftAccepted}, right ${rightAccepted}`);
    // The work record holds the proof and its hash; it is no status.
    const session = nodes(events, "m12_session").find((n) => n.workDone === true);
    assert.equal(session?.verdict, "proved");
    assert.equal(session?.ok, false, "work done on stubs is workDone, not ok: only validate accepting the proof is ok");
    assert.match(String(session?.workHash), /^[0-9a-f]{64}$/);
    // The dependency edge was checked by Lean, and the hole was derived through it (a composed proof through `validate`), not by its own check.
    const edges = ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into");
    assert.equal(edges.length, 2);
    assert.deepEqual(ofType(events, "edge.status_changed").map((e) => e.data.to), ["lean_checked", "lean_checked"]);
    const derived = nodes(events, "derivation").filter((d) => d.verdict === "valid").map((d) => d.claimId);
    assert.ok(derived.includes(right), "aux_right was derived through its dependency edge");
    assert.ok(derived.length >= 2, "and so was the target, from its holes");
    // One verdict node for each of the three holes (the battery's for aux_third), the claim id and the session id on each.
    const verdicts = nodes(events, "hole_verdict");
    assert.deepEqual(verdicts.map((v) => v.verdict), ["proved", "proved", "proved"]);
    assert.ok(verdicts.every((v) => typeof v.claimId === "string" && typeof v.sessionId === "string"));
    // The session's file holds the header, the stub and the hole, and nothing of the sketch.
    const file = lean.calls.map((c) => c.code).find((code) => code.includes("exact dep_ok") && !code.includes("h_aux_1"));
    assert.ok(file !== undefined);
    assert.match(file, /lemma aux_left \(n : ℕ\) : 0 \+ n = n := by\n {2}sorry/);
    assert.match(file, /theorem clm_\w+ \(n : ℕ\) : n \+ 0 = 0 \+ n/);
    assert.doesNotMatch(file, /aux_third|main_ok|n \* 1/);
    // The sessions are priced as model calls of the line, at its site.
    assert.equal(ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.hole").length, 2, "one response for each of the two sessions; aux_third was closed by the battery");
  });

  /** One hole, named by the main proof; one hole session, then the run goes on to a second outer session whose prompt is kept. */
  async function oneHole(aux: string, session: ReturnType<typeof say>, options: Record<string, unknown> = {}, extra: ReturnType<typeof say>[] = [], lean: DemoLean = new DemoLean(blueprintAnswer), config: Record<string, unknown> = {}) {
    const prompts: string[] = [];
    const run = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 2, ...config, lineOptions: { M12: { ...OPTIONS, holeSessions: 1, rounds: 1, ...options } } },
      lean,
      responses: [
        check("exact main_ok aux_x", aux),
        say("One lemma is left."),
        session,
        ...extra,
        (context: Parameters<typeof sessionPromptOf>[0]) => {
          if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
          return say("Going on.");
        },
      ],
    });
    return { ...run, prompts, lean };
  }
  const named = (aux: string): string => aux.replace(/aux_\w+/, "aux_x");
  const statusOf = (events: readonly HarnessEvent[], hole: string) => ofType(events, "claim.status_changed").filter((e) => e.data.claimId === hole).map((e) => e.data.to);
  const holeOf = (events: readonly HarnessEvent[]) => ofType(events, "claim.created").filter((e) => e.actor === "line:M12" && !(e.data.gloss ?? "").startsWith("link lemma"))[0]?.data.claimId as string;

  it("gives a hole session's checks the run's checkTimeoutSec", { timeout: 60000 }, async () => {
    const limits: Array<number | undefined> = [];
    const lean = new DemoLean(blueprintAnswer);
    const inner = lean.check.bind(lean);
    lean.check = async (snippets, options) => {
      limits.push(options?.timeoutSec);
      return inner(snippets, options);
    };
    await oneHole(named(HARD_AUX), check("exact hole_ok"), {}, [], lean, { checkTimeoutSec: 11 });
    assert.ok(limits.includes(11), `a check ran under 11 s: ${JSON.stringify(limits)}`);
  });

  it("makes a hole with no dependency proved only when validate accepts its proof, and too_hard with the validator's reasons when it refuses", { timeout: 60000 }, async () => {
    const answer = (code: string) => (code.includes("exact bad_axiom") ? { axioms: ["evil_axiom"] } : blueprintAnswer(code));
    const refused = await oneHole(named(HARD_AUX), check("exact bad_axiom"), {}, [], new DemoLean(answer));
    assert.deepEqual(nodes(refused.events, "hole_verdict").map((v) => v.verdict), ["too_hard"]);
    const session = nodes(refused.events, "m12_session")[0];
    assert.equal(session?.ok, false);
    assert.equal(session?.verdict, "too_hard");
    assert.match(String((session?.reasons as string[] | undefined)?.[0]), /depends on evil_axiom/);
    assert.deepEqual(statusOf(refused.events, holeOf(refused.events)), [], "no status changed");
    assert.ok(!ofType(refused.events, "task.status_changed").some((e) => String(e.data.reason).includes("waits for its dependencies")));
    const accepted = await oneHole(named(HARD_AUX), check("exact hole_ok"));
    assert.deepEqual(nodes(accepted.events, "hole_verdict").map((v) => v.verdict), ["proved"]);
    assert.deepEqual(statusOf(accepted.events, holeOf(accepted.events)), ["computed"]);
  });

  it("records a session that ends in an error as an error, with no verdict node", { timeout: 60000 }, async () => {
    const { events } = await oneHole(named(HARD_AUX), fauxAssistantMessage([], { stopReason: "error", errorMessage: "the model is down" }));
    assert.deepEqual(nodes(events, "hole_verdict"), [], "no verdict");
    assert.deepEqual(nodes(events, "m12_session").map((n) => [n.ok, n.stop, n.verdict]), [[false, "error", undefined]]);
    assert.equal(nodes(events, "suspect_false").length, 0);
    assert.deepEqual(statusOf(events, holeOf(events)), []);
  });

  /** The blueprint of `BP_AUX`: aux_right (works on the stub of aux_left) first, aux_left second; then the prompt of the next outer session is returned. */
  async function twoHoles(second: ReturnType<typeof say>, lean: DemoLean) {
    const prompts: string[] = [];
    const run = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 2, lineOptions: { M12: { ...OPTIONS, holeSessions: 1, rounds: 1 } } },
      lean,
      responses: [
        check(BP_PROOF, BP_AUX),
        say("Three lemmas are left."),
        check("exact dep_ok", LEFT_STUB),
        second,
        (context: Parameters<typeof sessionPromptOf>[0]) => {
          if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
          return say("Going on.");
        },
      ],
    });
    return { ...run, prompts };
  }

  it("gives a hole session a prompt with only the header, the stubs, the hole and the bounded history of its earlier sessions", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const { events, faux } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 2, lineOptions: { M12: { ...OPTIONS, holeSessions: 2, rounds: 1 } } },
      lean: new DemoLean(blueprintAnswer),
      responses: [
        check(BP_PROOF, BP_AUX),
        say("Three lemmas are left."),
        say("I cannot do this."),
        (context: Parameters<typeof sessionPromptOf>[0]) => {
          if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
          return check("exact dep_ok", LEFT_STUB);
        },
        check("exact hole_ok"),
        say("Done."),
      ],
    });
    assert.ok(faux.getPendingResponseCount() >= 0 && events.length > 0);
    const prompt = prompts[0] ?? "";
    assert.match(prompt, /Session 2 of 2: prove the lemma aux_right/);
    assert.match(prompt, /import FormalConjectures.Util.ProblemImports\n\nnamespace Demo/, "the header is whole, imports included");
    assert.match(prompt, /lemma aux_left \(n : ℕ\) : 0 \+ n = n := by\n {2}sorry/);
    assert.match(prompt, /Earlier sessions on this lemma did not succeed:\n- session 1:/);
    assert.ok(prompt.slice(prompt.indexOf("Earlier sessions")).length <= HOLE_HISTORY_CHARS + 80);
    assert.doesNotMatch(prompt, /aux_third|main_ok|n \* 1|Three lemmas are left/, "no sketch, no other hole, no outer notes");
  });

  it("tells the next session that a hole's dependency is false, not that the hole waits for it to be proved", { timeout: 60000 }, async () => {
    const { prompts } = await twoHoles(call("hole_verdict", { verdict: "statement_wrong", argument: "false", negation_proof: "exact neg_ok" }), new DemoLean(blueprintAnswer));
    const prompt = prompts[0] ?? "";
    assert.match(prompt, /a lemma it uses is false \(Lean accepted a proof of its negation\): aux_right \(uses aux_left\)/);
    assert.doesNotMatch(prompt, /waiting for the lemmas it uses to be proved/);
  });

  it("tells the next session that validate refused the derivation of a hole whose dependencies are proved, instead of waiting silently", { timeout: 60000 }, async () => {
    const answer = (code: string) => (code.includes("aux_m2_p1") ? { messages: [{ severity: "error" as const, pos: { line: 1, column: 0 }, text: "composed refused" }] } : blueprintAnswer(code));
    const { prompts, events } = await twoHoles(check("exact hole_ok"), new DemoLean(answer));
    assert.ok(nodes(events, "derivation").some((d) => d.verdict === "invalid"), "validate refused a composed proof");
    const prompt = prompts[0] ?? "";
    assert.match(prompt, /validate refused the proof composed from them: aux_right/);
    assert.doesNotMatch(prompt, /waiting for the lemmas it uses to be proved/);
  });

  it("ends a session that says nothing, or says it is too hard, with the verdict too_hard", { timeout: 60000 }, async () => {
    for (const session of [say("I cannot do this."), call("hole_verdict", { verdict: "too_hard" })]) {
      const { events, faux } = await oneHole(named(HARD_AUX), session);
      assert.equal(faux.getPendingResponseCount(), 0);
      assert.deepEqual(nodes(events, "hole_verdict").map((v) => v.verdict), ["too_hard"]);
      assert.deepEqual(nodes(events, "m12_session").map((n) => [n.ok, n.verdict]), [[false, "too_hard"]]);
      assert.deepEqual(statusOf(events, holeOf(events)), [], "no status changed");
      assert.equal(nodes(events, "suspect_false").length, 0);
    }
  });

  it("makes a negation computed only through a Lean-checked proof of it: the verdict statement_wrong, counted by the telemetry", { timeout: 60000 }, async () => {
    const { events, prompts } = await oneHole(named(WRONG_AUX), call("hole_verdict", { verdict: "statement_wrong", argument: "n + 0 = n, not n + 1", negation_proof: "exact neg_ok" }));
    const hole = holeOf(events);
    // The negation went through `validate` with the negation flag, and the claim's status did not move.
    const negations = ofType(events, "validation.finished").filter((e) => e.data.claimId === hole && e.data.negation === true);
    assert.deepEqual(negations.at(-1) === undefined ? [] : [negations.at(-1)?.data.method, negations.at(-1)?.data.verdict], ["repl", "valid"], "the session's proof of the negation");
    assert.equal(negations.filter((e) => e.data.verdict === "valid").length, 1, "the pre-flight's tries of the battery were all refused");
    assert.deepEqual(statusOf(events, hole), []);
    assert.deepEqual(nodes(events, "hole_verdict").map((v) => [v.verdict, v.negationValidated, v.claimId === hole]), [["statement_wrong", true, true]]);
    assert.equal(nodes(events, "suspect_false").length, 0);
    assert.deepEqual(loopTelemetry(events).holes, { verdicts: 1, wrong: 1, share: 1 });
    // The next outer session is told it is false, as a fact.
    assert.match(prompts[0] ?? "", /False, and Lean accepted a proof of the negation of: aux_x/);
  });

  it("records only a suspicion when the prover gives an argument and no proof: a suspect_false node, no status, labelled unverified", { timeout: 60000 }, async () => {
    const { events, prompts } = await oneHole(named(WRONG_AUX), call("hole_verdict", { verdict: "statement_wrong", argument: "take n = 0: 0 = 1" }));
    const hole = holeOf(events);
    assert.equal(ofType(events, "validation.finished").filter((e) => e.data.claimId === hole && e.data.negation === true && e.data.verdict === "valid").length, 0, "no negation passed Lean");
    assert.deepEqual(statusOf(events, hole), []);
    assert.deepEqual(nodes(events, "suspect_false").map((n) => [n.checked, n.source]), [[false, "session"]]);
    assert.deepEqual(nodes(events, "hole_verdict").map((v) => [v.verdict, v.negationValidated]), [["statement_wrong", undefined]]);
    assert.deepEqual(loopTelemetry(events).holes, { verdicts: 1, wrong: 0, share: 0, suspected: 1 }, "a suspicion is not counted as false");
    // It does not stop the work on the parent, and the next session reads it as unverified.
    assert.equal(ofType(events, "problem.finished").length, 1);
    assert.match(prompts[0] ?? "", /Suspected false, UNVERIFIED/);
    assert.match(prompts[0] ?? "", /take n = 0/);
    assert.doesNotMatch(prompts[0] ?? "", /False, and Lean accepted/);
  });

  it("refuses a proof of the negation that Lean refuses, and then records only the suspicion", { timeout: 60000 }, async () => {
    const { events } = await oneHole(named(WRONG_AUX), call("hole_verdict", { verdict: "statement_wrong", argument: "false", negation_proof: "exact bad" }));
    const hole = holeOf(events);
    const negations = ofType(events, "validation.finished").filter((e) => e.data.claimId === hole && e.data.negation === true).map((e) => e.data.verdict);
    assert.ok(negations.length >= 1 && negations.every((v) => v === "invalid"), negations.join());
    assert.equal(nodes(events, "suspect_false").length, 1);
    assert.deepEqual(nodes(events, "hole_verdict").map((v) => v.negationValidated), [undefined]);
  });

  it("settles a hole before any paid session when the battery proves its negation, and the telemetry counts it", { timeout: 60000 }, async () => {
    // The battery's first tactic that Lean closes on the negation: the simulated Lean accepts any proof of it that is no `sorry`.
    const lean = new DemoLean((code) => {
      const proof = proofOf(code);
      return proof !== undefined && code.includes("n + 0 = n + 1") && code.includes("¬") && !proof.includes("sorry") ? {} : blueprintAnswer(code);
    });
    const run = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 2, lineOptions: { M12: { ...OPTIONS, holeSessions: 1, rounds: 1 } } },
      lean,
      responses: [check("exact main_ok aux_x", named(WRONG_AUX)), say("One lemma is left."), say("Going on.")],
    });
    const hole = holeOf(run.events);
    assert.equal(ofType(run.events, "model_call.finished").filter((m) => m.data.site === "scheduler.hole").length, 0, "no paid session");
    assert.equal(ofType(run.events, "validation.finished").filter((e) => e.data.claimId === hole && e.data.negation === true && e.data.verdict === "valid").length, 1);
    assert.deepEqual(nodes(run.events, "hole_verdict").map((v) => [v.verdict, v.negationValidated]), [["statement_wrong", true]]);
    assert.equal(nodes(run.events, "m12_preflight").length, 1);
    assert.deepEqual(loopTelemetry(run.events).holes, { verdicts: 1, wrong: 1, share: 1 });
  });

  it("prices a hole session as a task, with its sessions and its turns, and the gate can refuse it", { timeout: 60000 }, async () => {
    const { events, faux } = await demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: 2, seed: "hole-gate", budget: { problemUsd: 1 }, gate: { floor: 0, minSessions: 1, share: { task: 0.0001 } }, lineOptions: { M12: { ...OPTIONS, holeSessions: 2, holeTurns: 24, rounds: 1 } } },
      lean: new DemoLean(blueprintAnswer),
      responses: [check("exact main_ok aux_x", named(HARD_AUX)), say("One lemma is left."), say("Going on.")],
    });
    const created = ofType(events, "task.created").filter((e) => e.data.proposedBy === "line:M12");
    assert.deepEqual(created.map((e) => e.data.budget), [{ sessions: 2, turns: 24 }]);
    const row = ofType(events, "budget.gated").find((e) => e.data.site === "task");
    assert.ok(row !== undefined);
    // Two sessions of 24 turns, each priced at twice what a session of the usual 12 turns costs (the mean of the sessions already paid).
    const paid = ofType(events, "attempt.finished").map((e) => e.data.usd);
    const mean = paid[0] ?? 0; // the gate had seen one session when it priced the task
    assert.ok(mean > 0 && Math.abs((row.data.estimateUsd as number) - mean * 2 * (24 / 12)) < 1e-9, `${String(row.data.estimateUsd)} against ${mean}`);
    assert.equal(row.data.action, "skip");
    assert.equal(ofType(events, "model_call.finished").filter((m) => m.data.site === "scheduler.hole").length, 0);
    assert.equal(faux.getPendingResponseCount(), 0);
  });

  it("resumes a blueprint run cut in the middle of a wave to the run that was not cut", { timeout: 240000 }, async () => {
    const script = () => [check(BP_PROOF, BP_AUX), say("Three lemmas are left."), check("exact dep_ok", LEFT_STUB), check("exact hole_ok")];
    const config = { lines: ["M12"], provers: 1, sessions: 3, lineOptions: { M12: OPTIONS } };
    const run = () => ({ lines: { M12: createM12Line() }, lean: new DemoLean(blueprintAnswer), certifier: certifier().certifier });
    const whole = await demoRun({ ...run(), config, responses: script() });
    assert.equal(whole.result.problems[0]?.outcome, "proved");
    const made = (events: readonly HarnessEvent[]) => {
      const names = new Map<string, string>();
      const name = (id: unknown): string => (typeof id === "string" ? (names.get(id) ?? (names.set(id, `#${names.size}`), names.get(id)!)) : String(id));
      return {
        verdicts: nodes(events, "hole_verdict").map((v) => [name(v.claimId), v.verdict]),
        statuses: ofType(events, "claim.status_changed").map((e) => `${name(e.data.claimId)} ${e.data.to}`).sort(),
        edges: ofType(events, "edge.status_changed").map((e) => e.data.to),
      };
    };
    // The cuts that fall in the wave: after a hole's session was recorded, a verdict, a pre-flight, a task's creation or a status of a hole.
    const marks = whole.events.flatMap((e, k) => (e.type === "node.recorded" && ["m12_session", "hole_verdict", "m12_preflight"].includes(e.data.kind)) || e.type === "task.created" || e.type === "edge.status_changed" || (e.type === "claim.status_changed" && k > 0) ? [k + 1] : []);
    // A cut inside a hole session (a response was paid, its record is not written) loses the session: it is asked again and paid again, so it is not a cut that resumes to the same run.
    const inSession = (prefix: readonly HarnessEvent[]): boolean => {
      const last = (match: (e: HarnessEvent) => boolean) => prefix.map(match).lastIndexOf(true);
      return last((e) => e.type === "model_call.finished" && e.data.site === "scheduler.hole") > last((e) => e.type === "node.recorded" && e.data.kind === "m12_session");
    };
    const cuts = marks.filter((cut) => !inSession(whole.events.slice(0, cut)));
    assert.ok(cuts.length >= 12 && cuts.length < marks.length, `${cuts.length} cuts of ${marks.length}`);
    for (const cut of cuts) {
      const prefix = whole.events.slice(0, cut);
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut), bench: whole.bench, ...run(),
        responses: [...script().slice(consumed(prefix)), ...Array.from({ length: 6 }, () => say("Going on."))],
      });
      assert.equal(resumed.result.problems[0]?.outcome, "proved", `${where}: ${resumed.result.problems[0]?.outcome}`);
      assertSound(resumed.events);
      assert.equal(JSON.stringify(made(resumed.events)), JSON.stringify(made(whole.events)), where);
    }
  });
});
