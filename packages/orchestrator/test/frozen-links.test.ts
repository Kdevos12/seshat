import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "@seshat/core";
import { createM12Line } from "@seshat/scheduler";
import { blueprintAnswer } from "./blueprint-helpers.ts";
import { AUX } from "./m12-helpers.ts";
import { check, DemoLean, demoResume, demoRun, killedAt, ofType, say } from "./m0-helpers.ts";
import { certifier, sessionPromptOf } from "./resume-helpers.ts";

/**
 * Frozen links (plan changes LP3, DP5): a hole proved by the scheduler moves into a locked prefix of the problem's file, and the `accepted_lemmas` node records it. The
 * blueprint is the two holes of `AUX`: `aux_left` is proved by its hole session, and `aux_right`'s session ends too hard, so that the target is still open and the next
 * outer session starts with the prefix.
 */
const OPTIONS = { blueprints: true, freeze: true, ageRatio: 1, weightRatio: 0, holeSessions: 1, rounds: 1 };
type Context = Parameters<typeof sessionPromptOf>[0];
type Step = ReturnType<typeof say>;
type Watch = (step: Step) => (context: Context) => Step;

const accepted = (events: readonly HarnessEvent[]) =>
  ofType(events, "node.recorded").filter((e) => e.data.kind === "accepted_lemmas").map((e) => e.data.data as { attemptId: string; names: string[]; lemmas?: Array<{ name: string; statementId: string; proofHash: string }> });
const codes = (lean: DemoLean) => lean.calls.map((c) => c.code);
const occurrences = (text: string, part: string) => text.split(part).length - 1;

/**
 * The run: outer session 1 checks the blueprint, the scheduler proves `aux_left` (its proof followed by `padding`, a comment) and gives up on `aux_right`, then `after`
 * (steps that may `watch` an outer session's opening prompt, kept in `prompts`) are the outer sessions that follow.
 */
function scenario(after: (watch: Watch) => Array<Step | ((c: Context) => Step)>, options: { padding?: string; sessions?: number; freeze?: boolean; dir?: string } = {}) {
  const lean = new DemoLean(blueprintAnswer);
  const cert = certifier();
  const prompts: string[] = [];
  const watch: Watch = (step) => (context) => {
    if (!context.messages.some((m) => m.role === "assistant")) prompts.push(sessionPromptOf(context));
    return step;
  };
  const responses = [watch(check("exact main_ok aux_left aux_right", AUX)), say("Two left."), check(`exact hole_ok${options.padding ?? ""}`), say("I cannot."), ...after(watch)];
  const run = () =>
    demoRun({
      lines: { M12: createM12Line() },
      config: { lines: ["M12"], provers: 1, sessions: options.sessions ?? 2, lineOptions: { M12: { ...OPTIONS, freeze: options.freeze ?? true } } },
      lean,
      certifier: cert.certifier,
      ...(options.dir !== undefined ? { dir: options.dir } : {}),
      responses: responses as never,
    });
  return { lean, cert, prompts, run };
}

describe("frozen links in a long proof", () => {
  it("shows a proved hole by its statement only: the prompt does not grow with its proof, and the node records it", { timeout: 60000 }, async () => {
    const sizes: number[] = [];
    for (const padding of ["", ` -- ${"a long proof ".repeat(300)}`]) {
      const s = scenario((watch) => [watch(say("stop"))], { padding });
      const { events } = await s.run();
      const prompt = s.prompts[1] ?? "";
      sizes.push(prompt.length);
      assert.match(prompt, /lemma aux_left \(n : ℕ\) : 0 \+ n = n -- proved by Lean, the proof is not shown\n\n-- HARNESS:AUX:BEGIN/);
      assert.match(prompt, /locked in the file before your AUX region/);
      assert.doesNotMatch(prompt, /exact hole_ok/);
      // One node for the session, with the lemma it locked: its name, the id of its statement and the blob of its Lean text.
      const [node, ...others] = accepted(events).filter((n) => n.lemmas !== undefined);
      assert.equal(others.length, 0);
      assert.deepEqual(node?.lemmas?.map((l) => l.name), ["aux_left"]);
      assert.match(node?.lemmas?.[0]?.statementId ?? "", /^st0_/);
    }
    assert.ok((sizes[0] ?? 0) > 0 && sizes[0] === sizes[1], `the prompt is ${sizes.join(" then ")} characters`);
  });

  it("Lean checks the prefix in every file, once; a restated lemma changes nothing", { timeout: 60000 }, async () => {
    const restated = AUX.replace("lemma aux_left (n : ℕ) : 0 + n = n := by\n  sorry", "lemma aux_left (n : ℕ) : 0 + n = n := by\n  exact other_proof");
    const s = scenario((watch) => [watch(check("exact main_ok aux_left aux_right", restated)), say("stop")]);
    await s.run();
    const ofSession = codes(s.lean).filter((c) => c.includes("HARNESS:AUX:BEGIN") && c.includes("exact main_ok aux_left aux_right") && c.includes("exact hole_ok"));
    assert.ok(ofSession.length >= 1, "the file Lean checked in the second session has the prefix");
    for (const code of ofSession) {
      assert.equal(occurrences(code, "lemma aux_left"), 1);
      assert.ok(code.indexOf("exact hole_ok") < code.indexOf("HARNESS:AUX:BEGIN"), "the prefix is before the AUX region");
    }
    assert.equal(codes(s.lean).some((c) => c.includes("theorem add_zero'") && c.includes("exact other_proof")), false, "the restated proof is in no file of the problem Lean read");
  });

  it("a proof certified in a later session is replayed whole, with its prefix", { timeout: 60000 }, async () => {
    const s = scenario((watch) => [watch(check("exact hole_ok")), say("done")]);
    const { result } = await s.run();
    assert.equal(result.problems[0]?.outcome, "proved");
    const request = s.cert.requests.find((r) => r.candidate.includes("lemma aux_left"));
    assert.ok(request !== undefined, "the certifier was given the file with the prefix");
    assert.match(request.candidate, /lemma aux_left \(n : ℕ\) : 0 \+ n = n := by\n {2}exact hole_ok/);
  });

  it("a resumed run rebuilds the prefix from the journal", { timeout: 120000 }, async () => {
    const first = scenario((watch) => [watch(say("stop")), say("more")], { sessions: 3 });
    const whole = await first.run();
    const node = whole.events.findIndex((e) => e.type === "node.recorded" && e.data.kind === "accepted_lemmas" && (e.data.data as { lemmas?: unknown }).lemmas !== undefined);
    assert.ok(node > 0);
    const prompts: string[] = [];
    const lean = new DemoLean(blueprintAnswer);
    const resumed = await demoResume({
      dir: killedAt(whole.dir, node + 1),
      bench: whole.bench,
      lines: { M12: createM12Line() },
      lean,
      certifier: certifier().certifier,
      responses: [(c: Context) => { prompts.push(sessionPromptOf(c)); return check("exact hole_ok"); }, say("done"), say("Going on.")] as never,
    });
    assert.match(prompts[0] ?? "", /lemma aux_left \(n : ℕ\) : 0 \+ n = n -- proved by Lean, the proof is not shown/);
    assert.ok(codes(lean).some((c) => occurrences(c, "lemma aux_left") === 1 && c.includes("exact hole_ok") && c.indexOf("exact hole_ok") < c.indexOf("HARNESS:AUX:BEGIN")));
    // Nothing is recorded twice: the lemma is in the one node that locked it.
    assert.equal(accepted(resumed.events).flatMap((n) => n.lemmas ?? []).length, 1);
  });

  it("without the option nothing is locked: the file is as it was, and the node has no lemmas", { timeout: 60000 }, async () => {
    const s = scenario((watch) => [watch(say("stop"))], { freeze: false });
    const { events } = await s.run();
    assert.doesNotMatch(s.prompts[1] ?? "", /proved by Lean, the proof is not shown/);
    assert.deepEqual(accepted(events), []);
  });
});
