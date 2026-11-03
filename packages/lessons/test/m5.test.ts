import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Line } from "@seshat/lines";
import { LINES } from "../../orchestrator/src/lines.ts";
import { lessonsCommand } from "../../orchestrator/src/lessons-command.ts";
import { renderRunReport, writeReport } from "../../orchestrator/src/index.ts";
import { consortium } from "../../orchestrator/test/turns-helpers.ts";
import { check, demoRun, ofType, say } from "../../orchestrator/test/m0-helpers.ts";
import { certifier } from "../../orchestrator/test/resume-helpers.ts";
import { allLessons, lessonReport, M5, M5_OPTIONS, stagedLessons } from "../src/index.ts";
import { BlobStore } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import { openForAnswers } from "../../orchestrator/src/team.ts";

// The simulated model's types, as the orchestrator's test helper gives them (this package does not depend on the model library).
type Step = Parameters<typeof demoRun>[0]["responses"][number];
type TranscriptContext = Parameters<Extract<Step, (...args: never[]) => unknown>>[0];

function opening(context: TranscriptContext): string {
  const message = context.messages.find((m) => m.role === "user");
  const content = message?.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** Two solved problems of one domain, so that what the first teaches is in scope for the second. */
const FILE = `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- Doubling is adding. -/
@[category research solved, AMS 11]
theorem two_mul' (n : ℕ) : 2 * n = n + n := by
  sorry

end Demo
`;

describe("the line M5 in a run", () => {
  it("is registered, with its options and a stateless resume", () => {
    assert.equal(LINES.M5, M5);
    assert.equal(M5.resume, "stateless");
    assert.deepEqual(M5.options, M5_OPTIONS);
    assert.deepEqual(M5.requires, ["M1"]);
  });

  it("learns a lesson from an accepted proof, shows it to the next problem when the draw includes it, and counts the outcomes", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    const sessions = 6;
    const { events, dir } = await demoRun({
      lines: { M1: LINES.M1 as Line, M5 },
      file: FILE,
      problems: 2,
      certifier: certifier().certifier,
      // Many sessions, so that the draw shows the lesson at least once (a new item is shown about half the time).
      config: { lines: ["M1", "M5"], sessions, seed: "lessons-1", lineOptions: { M5: { fromFailures: false } } },
      responses: [
        check("exact trivial_proof"),
        ...Array.from({ length: sessions }, () => [(context: TranscriptContext) => (prompts.push(opening(context)), check("rw [bad_lemma]")), say("my private notes")]).flat(),
      ],
    });
    assert.doesNotMatch(prompts.slice(0, 1).join(""), /# Lessons/, "nothing is learned before the first proof");

    // The accepted proof of the first problem taught a domain lesson, stamped as a learned record.
    const recorded = ofType(events, "node.recorded").filter((e) => e.data.kind === "lesson");
    assert.equal(recorded.length, 1);
    const lessonId = recorded[0]?.data.nodeId as string;
    assert.ok((recorded[0]?.data as { provenance?: unknown }).provenance !== undefined, "a lesson carries a provenance stamp");
    const data = recorded[0]?.data.data as { scope: string; scopeKey: string; strategy: string; text: string; claims: string[] };
    assert.deepEqual([data.scope, data.scopeKey, data.strategy], ["domain", "msc:11", "rewriting"]);
    assert.equal(data.text, "A proof using the rewriting strategy passed the fast check on msc:11 problems; try that strategy early.");

    // The draw names it in every session of the second problem; the section is shown exactly when it included it.
    const started = ofType(events, "attempt.started");
    const drawn = started.filter((e) => [...(e.data.included ?? []), ...(e.data.withheld ?? [])].includes(lessonId));
    assert.equal(drawn.length, sessions);
    const shown = drawn.filter((e) => e.data.included?.includes(lessonId));
    assert.ok(shown.length >= 1 && shown.length <= sessions);
    const withSection = prompts.filter((p) => /\n# Lessons\n/.test(p));
    assert.equal(withSection.length, shown.length);
    assert.match(withSection[0] ?? "", /\n# Lessons\nAdvice from the outcomes of earlier attempts in this harness\. It is not proved and may be wrong for this problem: Lean's verdicts and the goal decide\.\n- \(msc:11\) A proof using the rewriting strategy passed the fast check/);

    // The lessons took the notes' place: no session starts from the model's prose.
    assert.ok(prompts.every((p) => !p.includes("my private notes")));

    // Presence counters: each failed attempt that was shown the lesson, on its strategy (`rw` is rewriting), lost a point.
    const [lesson] = withMemory(dir, (memory) => allLessons(memory));
    assert.deepEqual([lesson?.useful, lesson?.harmful, lesson?.state], [0, shown.length, "active"]);

    // The report puts the presence counters next to what the draw measured.
    const report = writeReport(dir);
    assert.deepEqual(report.lessons?.byState, { active: 1, deactivated: 0, pending: 0, rejected: 0 });
    assert.deepEqual([report.lessons?.lessons[0]?.with, report.lessons?.lessons[0]?.without], [{ attempts: shown.length, accepted: 0 }, { attempts: sessions - shown.length, accepted: 0 }]);
    assert.match(renderRunReport(report), /Lessons: 1 \(1 active\)\. Presence counters: 0 useful, \d harmful\. Accepted proofs among attempts that were drawn a lesson: 0\/\d with it, 0\/\d without it\./);
    assert.deepEqual(lessonReport(events)?.lessons.map((l) => l.nodeId), [lessonId]);
  });

  it("passes the model's notes on when the lessons are told not to replace them", { timeout: 30000 }, async () => {
    const prompts: string[] = [];
    await demoRun({
      lines: { M1: LINES.M1 as Line, M5 },
      config: { lines: ["M1", "M5"], sessions: 2, lineOptions: { M5: { replaceNotes: false } } },
      responses: [check("simp"), say("my private notes"), (context: TranscriptContext) => (prompts.push(opening(context)), check("simp")), say("again")],
    });
    assert.match(prompts[0] ?? "", /# Your notes from the previous sessions\nmy private notes\n/);
  });

  it("distills a failure that recurs across claims into a constraint with one model call, at the site lessons.distill", { timeout: 60000 }, async () => {
    const bad = [check("rw [bad_lemma]"), say("notes")];
    const { events } = await demoRun({
      lines: { M1: LINES.M1 as Line, M5 },
      file: FILE,
      problems: 2,
      config: { lines: ["M1", "M5"], sessions: 2 },
      responses: [...bad, ...bad, ...bad, ...bad, say('{"constraint": "Name the lemma you rewrite with; guessed names are not found."}')],
    });
    const calls = ofType(events, "model_call.finished").filter((e) => e.data.site === "lessons.distill");
    assert.equal(calls.length, 1);
    const lessons = ofType(events, "node.recorded").filter((e) => e.data.kind === "lesson").map((e) => e.data.data as { type: string; scope: string; origin: string; text: string; support: string[] });
    assert.equal(lessons.length, 1);
    assert.deepEqual([lessons[0]?.type, lessons[0]?.scope, lessons[0]?.origin, lessons[0]?.support.length], ["constraint", "global", "distilled", 4]);
    assert.equal(lessons[0]?.text, "Name the lemma you rewrite with; guessed names are not found.");
  });

  it("stages a lesson for the global scope in a run with --human until the team answers, and answers by command", { timeout: 60000 }, async () => {
    const { events, dir } = await demoRun({
      lines: { M1: LINES.M1 as Line, M5 },
      file: FILE,
      config: {
        lines: ["M1", "M5"], sessions: 1, consortium: consortium({ tokens: 1_000_000_000 }),
        lineOptions: { M5: { globalMinDomains: 1, globalMinClaims: 1 } },
      },
      certifier: certifier().certifier,
      responses: [check("exact trivial_proof")],
    });
    const scopes = ofType(events, "node.recorded").filter((e) => e.data.kind === "lesson").map((e) => (e.data.data as { scope: string; pending?: boolean }));
    assert.deepEqual(scopes.map((s) => [s.scope, s.pending]), [["domain", undefined], ["global", true]]);
    const said: string[] = [];
    const out = (l: string) => said.push(l);
    lessonsCommand("pending", dir, { out });
    assert.match(said[0] ?? "", /^nod_\w+  \[strategy\] A proof using the rewriting strategy passed the fast check in 1 domains \(msc:11\); try that strategy early\.  \(1 claim\(s\), 1 attempt\(s\)\)$/);
    assert.match(said[1] ?? "", /^Answer with: harness lessons approve\|reject /);
    const id = said[0]?.split("  ")[0] as string;

    assert.throws(() => lessonsCommand("approve", dir, { out }), /needs the id of a lesson/);
    assert.throws(() => lessonsCommand("approve", dir, { id: "nod_nope", out }), /no lesson nod_nope/);
    said.length = 0;
    lessonsCommand("approve", dir, { id, as: "ada", note: "fine", out });
    assert.match(said[0] ?? "", /^ada: lesson nod_\w+ approved\. It is offered to every problem from the next session/);
    assert.throws(() => lessonsCommand("reject", dir, { id, as: "ada", out }), /is active: only a lesson that waits for the team can be approved or rejected/);

    // The decision is a node under the person's name, and the lesson is active now.
    withMemory(dir, (memory) => {
      assert.deepEqual(allLessons(memory).map((l) => l.state), ["active", "active"]);
      assert.equal(stagedLessons(memory).length, 0);
    });
    said.length = 0;
    lessonsCommand("pending", dir, { out });
    assert.deepEqual(said, ["No lesson waits for the team."]);
    // No claim's status changed by any of it.
    const journal = openForAnswers(dir);
    try {
      const decision = [...journal.projection.nodes("lesson_decision")];
      assert.equal(decision.length, 1);
    } finally {
      journal.close();
    }
  });
});

/** Reads the memory of a finished run's directory, and closes the journal again. */
function withMemory<T>(dir: string, read: (memory: MemoryStore) => T): T {
  const journal = openForAnswers(dir);
  try {
    return read(new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")) }));
  } finally {
    journal.close();
  }
}
