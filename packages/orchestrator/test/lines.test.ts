import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { Line, LineHooks, LineId, LlmResult, ValidateResult } from "@seshat/lines";
import { RunSetupError } from "../src/index.ts";
import { call, check, demoRun, ofType, say, tempDir } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

function textOf(message: Message): string {
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** A line whose hooks write down when they run, with `extra` over them. */
function recorder(calls: string[], id: LineId, extra: Partial<LineHooks> = {}): Line {
  const note = (text: string) => calls.push(`${id}.${text}`);
  return {
    id,
    title: `the test line ${id}`,
    requires: [],
    version: "test-1",
    options: { weight: 1 },
    hooks: {
      beforeProvers: async () => void note("beforeProvers"),
      beforeSession: async (s) => {
        note(`beforeSession ${s.prover}#${s.session}`);
        return { strategy: `${id} strategy` };
      },
      briefing: async (s) => {
        note(`briefing ${s.strategy}`);
        return { title: `Briefing of ${id}`, text: `${id} says hello.` };
      },
      tools: async () => {
        note("tools");
        return [];
      },
      afterCheck: async (_s, c) => {
        note(`afterCheck ${c.index} ${c.report.verdict}`);
        return undefined;
      },
      afterAttempt: async (_p, attempt) => {
        note(`afterAttempt ${attempt.outcome} ${attempt.checks}`);
        return { failureDetail: `${id} detail` };
      },
      afterProblem: async (p, end) => {
        note(`afterProblem ${end.outcome} ${p.signal.aborted}`);
      },
      ...extra,
    },
  };
}

describe("lines in a run", () => {
  it("calls the hooks of the enabled lines at their points, in the plan's order", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const results: string[] = [];
    const echo = recorder(calls, "M1", {
      tools: async () => {
        calls.push("M1.tools");
        return [
          {
            name: "echo",
            description: "Says the text back.",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            run: async (args) => {
              calls.push(`echo ${String(args.text)}`);
              return `echo: ${String(args.text)}`;
            },
          },
        ];
      },
    });
    const { result, events, dir } = await demoRun({
      lines: { M1: echo, M2: recorder(calls, "M2") },
      config: { lines: ["M2", "M1"], lineOptions: { M2: { weight: 2 } } },
      responses: [
        (context) => {
          prompts.push(textOf(context.messages.find((m) => m.role === "user") as Message));
          return call("echo", { text: "hi" });
        },
        (context) => {
          results.push(textOf(context.messages.findLast((m) => m.role === "toolResult") as Message));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(calls, [
      "M1.beforeProvers",
      "M2.beforeProvers",
      "M1.beforeSession p1#1",
      "M2.beforeSession p1#1",
      "M1.briefing M2 strategy",
      "M2.briefing M2 strategy",
      "M1.tools",
      "M2.tools",
      "echo hi",
      "M1.afterCheck 1 valid",
      "M2.afterCheck 1 valid",
      "M1.afterAttempt valid 1",
      "M2.afterAttempt valid 1",
      "M1.afterProblem candidate false",
      "M2.afterProblem candidate false",
    ]);
    assert.match(prompts[0] ?? "", /# What Lean said about the file as it is\n.*\n\n# Briefing of M1\nM1 says hello\.\n\n# Briefing of M2\nM2 says hello\.$/);
    assert.equal(results[0], "echo: hi");

    // The later line's strategy and annotation win.
    assert.equal(ofType(events, "attempt.started")[0]?.data.strategy, "M2 strategy");
    assert.equal(ofType(events, "attempt.finished")[0]?.data.failureDetail, "M2 detail");
    const started = ofType(events, "run.started")[0]?.data.config as { lines?: unknown };
    assert.deepEqual(started.lines, [
      { id: "M1", version: "test-1", options: { weight: 1 } },
      { id: "M2", version: "test-1", options: { weight: 2 } },
    ]);
    assert.deepEqual(result.report.lines, ["M1", "M2"]);
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), / Lines: M1, M2\.$/m);
  });

  it("records nothing of the lines in a run that enables none", async () => {
    const { events, result, dir } = await demoRun({ config: { lines: [] }, responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal("lines" in (ofType(events, "run.started")[0]?.data.config as object), false);
    assert.equal("lines" in JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), false);
    assert.equal(result.report.lines, undefined);
    assert.doesNotMatch(readFileSync(join(dir, "report.md"), "utf8"), /Lines:/);
  });

  it("settles a problem in beforeProvers through validate, and leaves the provers idle", async () => {
    const results: ValidateResult[] = [];
    const later: string[] = [];
    let other = "";
    const settler: Line = {
      id: "M1",
      title: "settles",
      requires: [],
      hooks: {
        beforeProvers: async (problem) => {
          // Another claim gets a reference file of its own; a valid proof makes it a candidate.
          other = (await problem.memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", header: "import Mathlib", origin: "test" })).claimId;
          results.push(await problem.validate({ claimId: other, proof: "exact trivial_proof" }));
          results.push(await problem.validate({ claimId: problem.claimId, proof: "bad" }));
          results.push(await problem.validate({ claimId: problem.claimId, negation: true, proof: "exact trivial_proof" }));
          results.push(await problem.validate({ claimId: problem.claimId, proof: "exact trivial_proof" }));
        },
      },
    };
    const { result, events, faux } = await demoRun({
      lines: { M1: settler, M10: recorder(later, "M10") },
      config: { lines: ["M1", "M10"] },
      responses: [check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(results.map((r) => [r.verdict, r.status]), [
      ["valid", "computed"],
      ["invalid", "open"],
      ["valid", "open"],
      ["valid", "computed"],
    ]);
    const validations = ofType(events, "validation.finished");
    assert.deepEqual(validations.map((v) => [v.data.verdict, v.data.negation ?? false]), [
      ["valid", false],
      ["invalid", false],
      ["valid", true],
      ["valid", false],
    ]);
    assert.deepEqual(results.map((r) => r.validationId), validations.map((v) => v.data.validationId));
    // Only valid proofs move a status; the refutation is recorded and changes nothing.
    const target = ofType(events, "problem.registered")[0]?.data.claimId;
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => [c.data.claimId, c.data.to, c.data.validationId]), [
      [other, "computed", results[0]?.validationId],
      [target, "computed", results[3]?.validationId],
    ]);
    assert.equal(ofType(events, "claim.created").find((c) => c.data.claimId === other)?.actor, "line:M1");
    // The problem was settled: the next line's beforeProvers, the provers and the model did nothing.
    assert.deepEqual(later, ["M10.afterProblem candidate false"]);
    assert.equal(ofType(events, "attempt.started").length, 0);
    assert.equal(faux.getPendingResponseCount(), 1);
  });

  it("refuses unknown, planned and unmet lines before writing anything", async () => {
    const dir = join(tempDir(), "run");
    await assert.rejects(demoRun({ dir, responses: [], config: { lines: ["M99"] } }), (error: Error) => {
      assert.ok(error instanceof RunSetupError);
      assert.match(error.message, /^the lines of the run: unknown line "M99"; the lines are M1, M10, M2/);
      return true;
    });
    await assert.rejects(
      demoRun({ dir, responses: [], config: { lines: ["M10"] } }),
      /the lines of the run: line M10 \(classical battery per subgoal before any model, domain router, ATP and SMT\) is planned, not implemented yet$/,
    );
    const needy: Line = { id: "M2", title: "needs M1", requires: ["M1"], hooks: {} };
    await assert.rejects(demoRun({ dir, responses: [], lines: { M2: needy }, config: { lines: ["M2"] } }), /line M2 requires line M1, which is not enabled/);
    assert.equal(existsSync(dir), false);
  });

  it("ends the problem with an error that names the line when a hook fails", async () => {
    const calls: string[] = [];
    const failing = recorder(calls, "M1", { beforeProvers: async () => Promise.reject(new Error("boom")) });
    const { result, events } = await demoRun({ lines: { M1: failing }, config: { lines: ["M1"] }, responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "error");
    assert.equal(result.problems[0]?.reason, "line M1 failed in beforeProvers: boom");
    assert.deepEqual(calls, ["M1.afterProblem error false"]);
    assert.equal(ofType(events, "attempt.started").length, 0);
  });

  it("lets beforeSession skip a session and afterCheck stop one, without asking for notes", async () => {
    const drift: Line = {
      id: "M6",
      title: "drift",
      requires: [],
      hooks: {
        beforeSession: async (s) => (s.session === 1 ? { skip: "not now" } : undefined),
        afterCheck: async (_s, c) => (c.index === 1 ? { stop: "drifting" } : undefined),
      },
    };
    const lines = { M6: drift };
    const { result, events } = await demoRun({
      lines,
      config: { lines: ["M6"], sessions: 3 },
      responses: [check("bad"), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(ofType(events, "attempt.started").map((a) => a.data.iteration), [2, 3]);
    // A proof that passes wins over the stop that comes with its check.
    assert.deepEqual(ofType(events, "attempt.finished").map((a) => [a.data.outcome, a.data.stoppedBy]), [
      ["invalid", "line:M6"],
      ["valid", "solved"],
    ]);
    assert.equal(ofType(events, "lesson.recorded").length, 0);

    const stopper: Line = { id: "M6", title: "stops", requires: [], hooks: { beforeSession: async () => ({ stop: "enough" }) } };
    const stopped = await demoRun({ lines: { M6: stopper }, config: { lines: ["M6"] }, responses: [check("exact trivial_proof")] });
    assert.equal(stopped.result.problems[0]?.outcome, "unsolved");
    assert.equal(stopped.result.problems[0]?.reason, "provers stopped: 1 line");
    assert.equal(ofType(stopped.events, "attempt.started").length, 0);
  });

  it("gives a line one-shot model calls charged to the problem, and the context packet of each request", async () => {
    let answer: LlmResult | undefined;
    const requests: string[][] = [];
    const packet: Line = {
      id: "M4",
      title: "packet",
      requires: [],
      hooks: {
        beforeProvers: async (problem) => {
          answer = await problem.llm.complete({ system: "Be brief.", prompt: "Say hi." });
        },
        contextPacket: async (_s, request) => `PACKET ${request.request}: ${request.transcript.map((e) => e.role).join(",")}`,
      },
    };
    const seen = (context: TranscriptContext) => requests.push(context.messages.map((m) => `${m.role}: ${textOf(m).slice(0, 40)}`));
    const { result, events } = await demoRun({
      lines: { M4: packet },
      config: { lines: ["M4"] },
      responses: [
        (context) => {
          seen(context);
          return say("hi");
        },
        (context) => {
          seen(context);
          return check("bad");
        },
        (context) => {
          seen(context);
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(answer?.text, "hi");
    const [modelCall] = ofType(events, "model_call.finished");
    assert.deepEqual([modelCall?.actor, modelCall?.data.line, modelCall?.data.outcome, modelCall?.data.modelCallId], ["line:M4", "M4", "ok", answer?.modelCallId]);
    assert.ok((modelCall?.data.usd ?? 0) > 0 && modelCall?.data.responseHash !== undefined);
    const sessions = ofType(events, "attempt.finished").reduce((sum, a) => sum + a.data.usd, 0);
    assert.ok(Math.abs((result.problems[0]?.usd ?? 0) - sessions - (modelCall?.data.usd ?? 0)) < 1e-9, "the problem pays for the call");
    assert.deepEqual(result.report.modelCalls, { total: 1, outcomes: { ok: 1 }, lines: { M4: 1 } });

    // Each request of the session is the system prompt and the packet, nothing else.
    assert.deepEqual(requests[0]?.slice(-2), ["system: Be brief.", "user: Say hi."]);
    assert.deepEqual(requests[1]?.map((m) => m.split(":")[0]), ["system", "user"]);
    assert.equal(requests[1]?.[1], "user: PACKET 1: user");
    assert.equal(requests[2]?.[1], "user: PACKET 2: user,assistant,tool");
  });

  it("ends a session with an error when its context packet fails", async () => {
    const broken: Line = { id: "M4", title: "broken", requires: [], hooks: { contextPacket: async () => Promise.reject(new Error("no packet")) } };
    const { result, events } = await demoRun({ lines: { M4: broken }, config: { lines: ["M4"] }, responses: [check("exact trivial_proof")] });
    assert.deepEqual(ofType(events, "attempt.finished").map((a) => [a.data.outcome, a.data.stoppedBy, a.data.error]), [
      ["error", "error", "line M4 failed in contextPacket: no packet"],
      ["error", "error", "line M4 failed in contextPacket: no packet"],
    ]);
    assert.equal(result.problems[0]?.outcome, "error");
    assert.equal(result.problems[0]?.reason, "every prover failed: line M4 failed in contextPacket: no packet");
  });
});
