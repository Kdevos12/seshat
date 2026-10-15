import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Line, ProverEnd } from "@seshat/lines";
import { check, DemoLean, demoRun, ofType, say } from "./m0-helpers.ts";

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

/** A line with these hooks, under an id the registry knows. */
function line(id: Line["id"], hooks: Line["hooks"], extra: Partial<Line> = {}): Line {
  return { id, title: `the test line ${id}`, requires: [], hooks, ...extra };
}

describe("beforeCheck", () => {
  it("rejects a lean_check before Lean runs, and does not count the call", async () => {
    const results: Message[] = [];
    let checks = -1;
    const guard = line("M6", {
      beforeCheck: async (_s, proposal) => (proposal.proof.includes("forbidden") ? { reject: "the proof says forbidden" } : undefined),
      afterAttempt: async (_p, attempt) => {
        checks = attempt.checks;
        return undefined;
      },
    });
    const { result, events, lean } = await demoRun({
      lines: { M6: guard },
      config: { lines: ["M6"] },
      responses: [
        check("forbidden"),
        (context) => {
          results.push(context.messages.findLast((m) => m.role === "toolResult") as Message);
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.match(textOf(results[0] as Message), /^Not checked \(line M6\): the proof says forbidden$/);
    assert.equal((results[0] as unknown as { isError: boolean }).isError, true);
    // The rejected call is no check: one validation, and Lean never saw the file.
    assert.equal(checks, 1);
    assert.equal(ofType(events, "validation.finished").length, 1);
    assert.equal((lean as DemoLean).calls.some((snippet) => snippet.code.includes("forbidden")), false);
  });

  it("keeps the strategy of a rejected call out of the attempt", async () => {
    const guard = line(
      "M6",
      { beforeCheck: async (_s, proposal) => (proposal.proof.includes("forbidden") ? { reject: "no" } : undefined) },
      { strategies: ["induction", "other"] },
    );
    const { events } = await demoRun({
      lines: { M6: guard },
      config: { lines: ["M6"] },
      responses: [check("forbidden", "", "induction"), check("exact trivial_proof", "", "other")],
    });
    assert.equal(ofType(events, "attempt.finished")[0]?.data.declaredStrategy, "other");
  });

  it("takes the first line that rejects, in the plan's order", async () => {
    const seen: string[] = [];
    const first = line("M1", {
      beforeCheck: async () => {
        seen.push("M1");
        return { reject: "from M1" };
      },
    });
    const second = line("M6", {
      beforeCheck: async () => {
        seen.push("M6");
        return { reject: "from M6" };
      },
    });
    const results: Message[] = [];
    await demoRun({
      lines: { M1: first, M6: second },
      config: { lines: ["M6", "M1"] },
      responses: [
        check("exact trivial_proof"),
        (context) => {
          results.push(context.messages.findLast((m) => m.role === "toolResult") as Message);
          return say("done");
        },
      ],
    });
    assert.deepEqual(seen, ["M1"]);
    assert.equal(textOf(results[0] as Message), "Not checked (line M1): from M1");
  });

  it("ends the session with an error that names the line when the guard fails", async () => {
    const broken = line("M6", { beforeCheck: async () => Promise.reject(new Error("boom")) });
    const { events } = await demoRun({
      lines: { M6: broken },
      config: { lines: ["M6"] },
      responses: [check("exact trivial_proof"), check("exact trivial_proof")],
    });
    assert.deepEqual(ofType(events, "attempt.finished").map((a) => [a.data.outcome, a.data.error]), [
      ["error", "line M6 failed in beforeCheck: boom"],
      ["error", "line M6 failed in beforeCheck: boom"],
    ]);
    assert.equal(ofType(events, "validation.finished").length, 0);
  });
});

describe("reviewBriefing", () => {
  const alpha = line("M1", { briefing: async () => ({ title: "Alpha", text: "alpha text" }) });
  const beta = line("M2", { briefing: async () => ({ title: "Beta", text: "beta text" }) });

  it("gives the session the sections as the reviews left them", async () => {
    const seen: string[][] = [];
    const prompts: string[] = [];
    const reviewer = line("M6", {
      reviewBriefing: async (_s, sections) => {
        seen.push(sections.map((s) => s.title));
        return sections.filter((s) => s.title !== "Alpha").map((s) => ({ ...s, text: s.text.toUpperCase() }));
      },
    });
    const { result } = await demoRun({
      lines: { M1: alpha, M2: beta, M6: reviewer },
      config: { lines: ["M1", "M2", "M6"] },
      responses: [
        (context) => {
          prompts.push(opening(context));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(seen, [["Alpha", "Beta"]]);
    assert.match(prompts[0] ?? "", /# Beta\nBETA TEXT$/);
    assert.doesNotMatch(prompts[0] ?? "", /Alpha|alpha/);
  });

  it("keeps the sections when a review returns nothing", async () => {
    const prompts: string[] = [];
    const quiet = line("M6", { reviewBriefing: async () => undefined });
    await demoRun({
      lines: { M1: alpha, M6: quiet },
      config: { lines: ["M1", "M6"] },
      responses: [
        (context) => {
          prompts.push(opening(context));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.match(prompts[0] ?? "", /# Alpha\nalpha text$/);
  });

  it("refuses a review that adds a section", async () => {
    const adder = line("M6", { reviewBriefing: async (_s, sections) => [...sections, { title: "Gamma", text: "new" }] });
    const { result } = await demoRun({
      lines: { M1: alpha, M6: adder },
      config: { lines: ["M1", "M6"] },
      responses: [check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "error");
    assert.match(result.problems[0]?.reason ?? "", /line M6 failed in reviewBriefing: a review may drop or reword sections, not add them/);
  });
});

describe("the notes a line gives", () => {
  /** Session 1 fails and ends with notes the line rewrites; session 2 reads what it was given. */
  async function twoSessions(notes: string | undefined): Promise<{ second: string; lessons: string[] }> {
    const prompts: string[] = [];
    const rewriter = line("M6", { afterAttempt: async () => (notes === undefined ? undefined : { notes }) });
    const { events } = await demoRun({
      lines: { M6: rewriter },
      config: { lines: ["M6"] },
      responses: [
        check("bad"),
        say("RAW: unsolved goals, n : ℕ ⊢ n + 0 = n"),
        (context) => {
          prompts.push(opening(context));
          return check("exact trivial_proof");
        },
      ],
    });
    return { second: prompts[0] ?? "", lessons: ofType(events, "lesson.recorded").map((l) => l.data.text) };
  }

  it("replace the model's for the next session, and the journal keeps the model's own", async () => {
    const { second, lessons } = await twoSessions("typed: unknown identifier");
    assert.match(second, /# Your notes from the previous sessions\ntyped: unknown identifier\n/);
    assert.doesNotMatch(second, /RAW/);
    assert.deepEqual(lessons, ["RAW: unsolved goals, n : ℕ ⊢ n + 0 = n"]);
  });

  it("leave the next session without notes when the line gives an empty string", async () => {
    const { second } = await twoSessions("");
    assert.match(second, /# Your notes from the previous sessions\n\(none: this is your first session on this theorem\)\n/);
  });

  it("stay the model's when the line gives none", async () => {
    const { second } = await twoSessions(undefined);
    assert.match(second, /# Your notes from the previous sessions\nRAW: unsolved goals/);
  });
});

describe("afterProver", () => {
  it("is called once when a prover has ended, with how it ended", async () => {
    const ends: ProverEnd[] = [];
    const watcher = line("M6", {
      afterProver: async (_p, end) => {
        ends.push(end);
      },
    });
    await demoRun({
      lines: { M6: watcher },
      config: { lines: ["M6"], sessions: 2 },
      responses: [check("bad"), say("notes 1"), check("bad"), say("notes 2")],
    });
    assert.deepEqual(ends, [{ prover: "p1", stop: "sessions", attempts: 2 }]);

    ends.length = 0;
    await demoRun({ lines: { M6: watcher }, config: { lines: ["M6"] }, responses: [check("exact trivial_proof")] });
    assert.deepEqual(ends, [{ prover: "p1", stop: "solved", attempts: 1 }]);
  });

  it("is called for a prover a line stopped", async () => {
    const ends: ProverEnd[] = [];
    const stopper = line("M6", {
      beforeSession: async () => ({ stop: "enough" }),
      afterProver: async (_p, end) => {
        ends.push(end);
      },
    });
    await demoRun({ lines: { M6: stopper }, config: { lines: ["M6"] }, responses: [] });
    assert.deepEqual(ends, [{ prover: "p1", stop: "line", attempts: 0 }]);
  });
});
