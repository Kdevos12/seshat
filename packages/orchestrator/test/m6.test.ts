import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { HarnessEvent } from "@seshat/core";
import { createM6, framingProblems, REMOVED_MARK, UNSOURCED_MARK } from "@seshat/guards";
import type { Line } from "@seshat/lines";
import { sessionPrompt, systemPrompt } from "../src/prompt.ts";
import { DISCRETE } from "@seshat/bench";
import { check, DEMO_FILE, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

function textOf(message: Message): string {
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** The opening message of a session. */
function opening(context: TranscriptContext): string {
  return textOf(context.messages.find((m) => m.role === "user") as Message);
}

/** What the last tool result of a request said. */
function lastResult(context: TranscriptContext): string {
  return textOf(context.messages.findLast((m) => m.role === "toolResult") as Message);
}

/** A test line, under an id of the plan that sorts before M6. */
function helper(hooks: Line["hooks"]): Line {
  return { id: "M10", title: "a helper line of the tests", requires: [], hooks };
}

/** The drift nodes of a run: who recorded them, and what. */
function drifts(events: readonly HarnessEvent[]) {
  return ofType(events, "node.recorded")
    .filter((e) => e.data.kind === "drift")
    .map((e) => ({ actor: e.actor, ...(e.data.data as { kind: string; action: string; detail: string; prover?: string; session?: number; check?: number; evidence?: Record<string, unknown> }) }));
}

const OPEN_FILE = DEMO_FILE.replaceAll("research solved", "research open");
/** The bench keeps solved problems only; these runs also keep the open ones. */
const OPEN_BENCH = { filter: { ...DISCRETE, categories: ["research solved", "research open"] } };
const M6_ONLY = { lines: ["M6"] };

describe("M6 neutral framing", () => {
  it("asks an open conjecture to be determined, in a section of the briefing", async () => {
    const prompts: string[] = [];
    const { result } = await demoRun({
      file: OPEN_FILE,
      ...OPEN_BENCH,
      config: M6_ONLY,
      responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.match(prompts[0] ?? "", /\n\n# The question\nDetermine whether this theorem holds\. It is an open conjecture/);
    assert.deepEqual(framingProblems(prompts[0] ?? ""), []);
  });

  it("puts nothing to a problem that is a solved one, unless asked, and nothing when switched off", async () => {
    const prompts: string[] = [];
    const respond = [(context: TranscriptContext) => { prompts.push(opening(context)); return check("exact trivial_proof"); }];
    await demoRun({ config: M6_ONLY, responses: respond });
    await demoRun({ config: { ...M6_ONLY, lineOptions: { M6: { framingAll: true } } }, responses: respond });
    await demoRun({ file: OPEN_FILE, ...OPEN_BENCH, config: { ...M6_ONLY, lineOptions: { M6: { framing: false } } }, responses: respond });
    assert.doesNotMatch(prompts[0] ?? "", /The question/);
    assert.match(prompts[1] ?? "", /# The question\nDetermine whether this theorem holds as formalized\. It comes from a solved problem/);
    assert.doesNotMatch(prompts[2] ?? "", /The question/);
  });

  it("is a harness whose own prompts never say to prove a statement", () => {
    const system = systemPrompt(2000, ["compute_sage"]);
    const first = sessionPrompt({ theorem: "Demo.add_zero'", file: "theorem x := by sorry", notes: undefined, lastCheck: undefined, session: 1, sessions: 2 });
    assert.deepEqual(framingProblems(`${system}\n${first}`), []);
  });

  it("notes, and drops nothing, when another line frames an open conjecture as a thing to prove", async () => {
    const prompts: string[] = [];
    const framer = helper({ briefing: async () => ({ title: "Goal", text: "Prove that the statement holds for all n." }) });
    const { events } = await demoRun({
      file: OPEN_FILE,
      ...OPEN_BENCH,
      lines: { M10: framer, M6: createM6() },
      config: { lines: ["M10", "M6"], sessions: 2 },
      responses: [(context) => { prompts.push(opening(context)); return check("omega"); }, check("linarith"), (context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.match(prompts[0] ?? "", /# Goal\nProve that the statement holds/);
    // One record for the problem, though two sessions read the section.
    const found = drifts(events).filter((d) => d.kind === "non_neutral_framing");
    assert.equal(found.length, 1);
    assert.deepEqual([found[0]?.action, found[0]?.evidence], ["noted", { section: "Goal", phrases: ["prove that"] }]);
  });
});

describe("M6 resolved citations", () => {
  it("rejects a check that appeals to a known result with no source, and does not run it", async () => {
    const results: string[] = [];
    const { result, events, lean } = await demoRun({
      config: M6_ONLY,
      responses: [
        check("-- this is a well-known result\nexact trivial_proof"),
        (context) => { results.push(lastResult(context)); return check("exact trivial_proof"); },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.match(results[0] ?? "", /^Not checked \(line M6\): The file refers to an appeal to a known result, with no source, and that resolves to no id/);
    assert.equal(ofType(events, "validation.finished").length, 1);
    assert.equal((lean as DemoLean).calls.some((snippet) => snippet.code.includes("well-known")), false);
    const [found, ...rest] = drifts(events);
    assert.deepEqual(rest, []);
    assert.deepEqual([found?.actor, found?.kind, found?.action, found?.check], ["line:M6", "unresolved_citation", "rejected_call", 1]);
    assert.deepEqual(found?.evidence, { references: ["an appeal to a known result, with no source"] });
  });

  it("lets a reference through when it names an id of the packet, a claim of the graph or a source", async () => {
    const lines = {
      M10: helper({
        beforeProvers: async (problem) => {
          problem.memory.recordNode({ kind: "source", data: { ref: "Smith 2019", aliases: ["smith2019"] } });
        },
      }),
      M6: createM6({ packetIds: () => ["C17"] }),
    };
    const claims: string[] = [];
    const { result, events } = await demoRun({
      lines,
      config: { lines: ["M10", "M6"], sessions: 1 },
      responses: [
        (context) => { claims.push(opening(context)); return check("-- [cite: C17] and [cite: src:smith2019], see arXiv:1234.5678\nomega"); },
        check("-- [cite: C17, Smith 2019]\nlinarith"),
        check("-- [cite: C99]\nsimp"),
        say("done"),
      ],
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    // The first check names an arXiv id that no source holds: rejected. The second one resolves. The third names C99.
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.check, d.evidence]), [
      ["unresolved_citation", 1, { references: ["arXiv:1234.5678"] }],
      ["unresolved_citation", 2, { references: ["[cite: C99]"] }],
    ]);
    assert.equal(ofType(events, "validation.finished").length, 1);
  });

  it("asks a declaration of the project through the predicate it is given", async () => {
    const known = createM6({ declarationExists: (name) => name === "Nat.add_zero" });
    const { events } = await demoRun({
      lines: { M6: known },
      config: { ...M6_ONLY, sessions: 1 },
      responses: [check("-- [cite: Nat.add_zero]\nomega"), check("-- [cite: Nat.add_made_up]\nlinarith"), say("done")],
    });
    assert.deepEqual(drifts(events).map((d) => d.evidence), [{ references: ["[cite: Nat.add_made_up]"] }]);
  });

  it("rejects a sorry presented as a known result, even when its citation resolves", async () => {
    const results: string[] = [];
    const { events } = await demoRun({
      lines: { M6: createM6({ packetIds: () => ["C17"] }) },
      config: { ...M6_ONLY, sessions: 1 },
      responses: [
        check("exact trivial_proof", "-- the standard theorem [cite: C17]\ntheorem aux_known (n : ℕ) : n + 0 = n := by\n  sorry"),
        (context) => { results.push(lastResult(context)); return say("done"); },
      ],
    });
    assert.match(results[0] ?? "", /^Not checked \(line M6\): A sorry in aux_known is presented as a known result in a comment\. A sorry is an open goal, not a result/);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action, d.evidence]), [["sorry_as_known", "rejected_call", { declarations: ["aux_known"] }]]);
    assert.equal(ofType(events, "validation.finished").length, 0);
  });

  it("is off when the option says so", async () => {
    const { events } = await demoRun({
      config: { ...M6_ONLY, lineOptions: { M6: { citations: false } } },
      responses: [check("-- a well-known result\nexact trivial_proof")],
    });
    assert.deepEqual(drifts(events), []);
    assert.equal(ofType(events, "validation.finished").length, 1);
  });

  it("takes the unsourced line out of the notes the next session starts from", async () => {
    const prompts: string[] = [];
    const notes = "Plan: induction on n.\nBy a well-known theorem of Erdős the bound holds.\nThen close with simp.";
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [check("omega"), say(notes), (context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.match(prompts[0] ?? "", new RegExp(`Plan: induction on n\\.\\n\\${UNSOURCED_MARK.slice(0, -1)}\\]\\nThen close with simp\\.`));
    assert.doesNotMatch(prompts[0] ?? "", /Erdős/);
    // The journal keeps what the model wrote.
    assert.equal(ofType(events, "lesson.recorded")[0]?.data.text, notes);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action]), [["unresolved_citation", "removed_text"]]);
  });
});

describe("M6 no raw error text", () => {
  const goal = "case succ\nn : ℕ\nih : n + 0 = n\n⊢ n + 1 + 0 = n + 1";

  it("takes Lean's output out of a section of another line, and drops a section that is only that", async () => {
    const prompts: string[] = [];
    const lines = {
      M10: helper({
        briefing: async () => ({ title: "Lessons", text: `The last proof failed:\n${goal}\nTry another way.` }),
      }),
      M2: { id: "M2", title: "another helper", requires: [], hooks: { briefing: async () => ({ title: "Raw", text: `unsolved goals\n${goal}` }) } } satisfies Line,
      M6: createM6(),
    };
    const { events } = await demoRun({
      lines,
      config: { lines: ["M10", "M2", "M6"] },
      responses: [(context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.match(prompts[0] ?? "", new RegExp(`# Lessons\\nThe last proof failed:\\n\\${REMOVED_MARK.slice(0, -1)}\\]\\nTry another way\\.`));
    assert.doesNotMatch(prompts[0] ?? "", /# Raw|⊢ n \+ 1/);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action, d.evidence]), [
      ["raw_error_text", "removed_text", { section: "Lessons", blocks: 1 }],
      ["raw_error_text", "dropped_section", { section: "Raw", blocks: 1 }],
    ]);
  });

  it("leaves the typed summaries of the already-tried section as they are", async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({
      config: { lines: ["M1", "M6"], sessions: 2 },
      responses: [check("omega"), say("tried omega"), (context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.match(prompts[0] ?? "", /# Already tried\n.*\nautomation: 1 attempt, unsolved goals/);
    assert.deepEqual(drifts(events), []);
  });

  it("takes Lean's output out of the notes, and keeps the model's text in the journal", async () => {
    const prompts: string[] = [];
    const notes = `It fails with:\n${goal}\nI will try cases.\n\`\`\`\nunsolved goals\n⊢ False\n\`\`\`\nDone.`;
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [check("omega"), say(notes), (context) => { prompts.push(opening(context)); return check("exact trivial_proof"); }],
    });
    assert.match(prompts[0] ?? "", new RegExp(`It fails with:\\n\\${REMOVED_MARK.slice(0, -1)}\\]\\nI will try cases\\.\\n\\${REMOVED_MARK.slice(0, -1)}\\]\\nDone\\.`));
    assert.equal(ofType(events, "lesson.recorded")[0]?.data.text, notes);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action, d.evidence]), [["raw_error_text", "removed_text", { blocks: 2 }]]);
  });

  it("leaves the check of the current file alone, which is what the model works from", async () => {
    const results: string[] = [];
    await demoRun({
      config: M6_ONLY,
      responses: [check("omega"), (context) => { results.push(lastResult(context)); return check("exact trivial_proof"); }],
    });
    assert.match(results[0] ?? "", /unsolved goals\n\s+n : ℕ\n\s+⊢ n \+ 0 = n/);
  });
});

describe("M6 anchored revisions", () => {
  it("rejects the same file sent again, and a file left by the last session sent again", async () => {
    const results: string[] = [];
    const seen = (next: () => ReturnType<typeof check>) => (context: TranscriptContext) => {
      results.push(lastResult(context));
      return next();
    };
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [
        check("omega"),
        seen(() => check("-- again\nomega")),
        seen(() => check("linarith")),
        seen(() => say("nothing new")),
        // The second session starts from the file the first one left, which Lean has answered.
        check("linarith"),
        seen(() => check("omega")),
        seen(() => say("done")),
      ],
    });
    assert.match(results[1] ?? "", /^Not checked \(line M6\): This file is the one you checked last/);
    assert.match(results[2] ?? "", /unsolved goals/, "a different file is a revision after Lean's answer");
    assert.match(results[3] ?? "", /^Not checked \(line M6\): This file is the one you checked last/);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action, d.session, d.check, d.evidence]), [
      ["unanchored_revision", "rejected_call", 1, 2, { reason: "identical" }],
      ["unanchored_revision", "rejected_call", 2, 1, { reason: "identical" }],
    ]);
    assert.equal(ofType(events, "validation.finished").length, 3);
  });

  it("is off when the option says so", async () => {
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 1, lineOptions: { M6: { revisions: false } } },
      responses: [check("omega"), check("omega"), say("done")],
    });
    assert.deepEqual(drifts(events), []);
    assert.equal(ofType(events, "validation.finished").length, 2);
  });
});

describe("M6 drift detectors", () => {
  it("stops a session that tries one strategy again and again, and restarts it with a notice", async () => {
    const prompts: string[] = [];
    const { result, events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [
        check("omega"),
        check("linarith"),
        check("simp"),
        check("simp\nomega"),
        (context) => { prompts.push(opening(context)); return check("exact trivial_proof"); },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const finished = ofType(events, "attempt.finished");
    assert.deepEqual(finished.map((a) => [a.data.outcome, a.data.stoppedBy]), [["invalid", "line:M6"], ["valid", "solved"]]);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action, d.session, d.check, d.detail]), [
      ["strategy_loop", "stopped_session", 1, 4, "3 checks in a row with the strategy automation, and Lean got no further"],
    ]);
    assert.match(prompts[0] ?? "", /# Course change\nThe harness stopped your last session: 3 checks in a row used the strategy automation/);
    // The notice is told once.
    assert.equal(drifts(events).length, 1);
  });

  it("stops a session whose auxiliary lemma restates the target", async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [
        check("exact aux_main n", "theorem aux_main (n : ℕ) : n + 0 = n := by\n  sorry"),
        (context) => { prompts.push(opening(context)); return check("exact trivial_proof"); },
      ],
    });
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.detail, d.evidence]), [
      ["restated_target", "auxiliary lemma aux_main restates the target", { check: 1, via: "restates_target", lemma: "aux_main" }],
    ]);
    assert.match(prompts[0] ?? "", /an auxiliary lemma aux_main states the theorem again/);
  });

  it("finds a lemma nearly equivalent to the target through the predicate it is given", async () => {
    const asked: Array<[string, string]> = [];
    const near = createM6({
      nearEquivalent: (lemma, target) => {
        asked.push([lemma, target]);
        return lemma.includes("0 + n");
      },
    });
    const { events } = await demoRun({
      lines: { M6: near },
      config: { ...M6_ONLY, sessions: 1 },
      responses: [
        check("omega", "theorem aux_comm (n : ℕ) : n + 1 = 1 + n := by\n  omega"),
        check("linarith", "theorem aux_close (n : ℕ) : 0 + n = n := by\n  sorry"),
      ],
    });
    assert.deepEqual(asked, [
      ["(n : ℕ) : n + 1 = 1 + n", "(n : ℕ) : n + 0 = n"],
      ["(n : ℕ) : 0 + n = n", "(n : ℕ) : n + 0 = n"],
    ]);
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.evidence]), [["restated_target", { check: 2, via: "predicate", lemma: "aux_close" }]]);
  });

  it("stops a session whose file grows and closes no subgoal", async () => {
    const long = `${"have h : (1 : ℕ) = 1 := rfl\n".repeat(30)}omega`;
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 1 },
      responses: [check("omega"), check(long)],
    });
    const [found, ...rest] = drifts(events);
    assert.deepEqual(rest, []);
    assert.equal(found?.kind, "length_growth");
    assert.match(found?.detail ?? "", /^the file grew from \d+ to \d+ characters and no subgoal was closed$/);
    assert.deepEqual(ofType(events, "attempt.finished").map((a) => a.data.stoppedBy), ["line:M6"]);
  });

  it("clears the notes of a prover whose sessions repeat one strategy with Lean no further", async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({
      config: { ...M6_ONLY, sessions: 4, lineOptions: { M6: { sessionRepeats: 2 } } },
      responses: [
        check("omega"), say("notes one"),
        check("linarith"), say("notes two"),
        check("simp"), say("notes three"),
        (context) => { prompts.push(opening(context)); return say("done"); },
      ],
    });
    assert.deepEqual(drifts(events).map((d) => [d.kind, d.action, d.session]), [["session_loop", "restarted", 3]]);
    assert.match(prompts[0] ?? "", /# Your notes from the previous sessions\n\(none: this is your first session on this theorem\)/);
    assert.match(prompts[0] ?? "", /# Course change\nYour last 2 sessions all used the strategy automation and Lean got no further, so your notes were cleared/);
    // The journal still holds what the model wrote.
    assert.deepEqual(ofType(events, "lesson.recorded").map((e) => e.data.text), ["notes one", "notes two", "notes three", "done"]);
  });

  it("does nothing to a session that goes further, and nothing when the detectors are off", async () => {
    const further = await demoRun({
      config: { ...M6_ONLY, sessions: 1 },
      responses: [check("omega"), check("exact bad_name\nsorry"), say("done")],
    });
    assert.deepEqual(drifts(further.events), []);
    const off = await demoRun({
      config: { ...M6_ONLY, sessions: 1, lineOptions: { M6: { detectors: false } } },
      responses: [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), say("done")],
    });
    assert.deepEqual(drifts(off.events), []);
  });
});

describe("M6 and the claim's status", () => {
  it("records drift nodes and changes nothing else: only Lean's verdict settles the claim", async () => {
    const { result, events } = await demoRun({
      config: { ...M6_ONLY, sessions: 2 },
      responses: [
        check("-- a well-known result\nomega"),
        check("omega"),
        check("omega"),
        check("linarith"),
        check("simp"),
        check("simp\nomega"),
        check("exact trivial_proof"),
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    const byGuard = events.filter((e) => e.actor === "line:M6");
    assert.ok(byGuard.length >= 3);
    assert.deepEqual([...new Set(byGuard.map((e) => e.type))], ["node.recorded"]);
    assert.deepEqual([...new Set(byGuard.map((e) => (e.data as { kind?: string }).kind))], ["drift"]);
    // The claim became a candidate through a validation of the validator, not through a guard.
    const statuses = ofType(events, "claim.status_changed");
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every((e) => e.actor !== "line:M6"));
  });
});
