import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { DISCRETE } from "@seshat/bench";
import type { CertificationRequest, CertificationResult, HarnessEvent, LeanCertifier, LeanChecker } from "@seshat/core";
import type { Line, LineRegistry } from "@seshat/lines";
import { checkEdge, createVariant, m2Line } from "@seshat/graph";
import type { MemoryStore } from "@seshat/memory";
import { LINES } from "../src/index.ts";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { lean, toyAnswer } from "../../graph/test/helpers.ts";
import { call, check, DEMO_FILE, DemoLean, demoResume, demoRun, killedAt, ofType, proofOf, say } from "./m0-helpers.ts";
import { assertSound, boundaries, consumed, nth, sessionPromptOf, spent } from "./resume-helpers.ts";

/** The text of the last tool result of a request. */
function lastResult(context: TranscriptContext): string {
  const message = context.messages.findLast((m) => m.role === "toolResult");
  if (message === undefined || message.role !== "toolResult") return "";
  return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/**
 * Records what the model is shown in every request, then answers as `step` does: the opening message
 * of a session, and what the last tool said in the requests that follow.
 */
function observed(trace: string[], steps: readonly FauxResponseStep[]): FauxResponseStep[] {
  return steps.map(
    (step): FauxResponseStep =>
      (context: TranscriptContext, ...rest) => {
        trace.push(context.messages.some((m) => m.role === "assistant") ? lastResult(context) : sessionPromptOf(context));
        return typeof step === "function" ? step(context, ...(rest as [never, never, never])) : step;
      },
  );
}

/** The data of the nodes of a kind that a journal records, in order. */
function nodesOf(events: readonly HarnessEvent[], kind: string): Array<Record<string, unknown>> {
  return ofType(events, "node.recorded")
    .filter((e) => e.data.kind === kind)
    .map((e) => e.data.data as Record<string, unknown>);
}

/** What the guards found, without the ids of the sessions. */
function findings(events: readonly HarnessEvent[]) {
  return nodesOf(events, "drift").map(({ attemptId: _attempt, ...rest }) => rest);
}

/** The usd the problem cost, as the result says. */
const costOf = (result: { problems: Array<{ usd: number }> }): number => result.problems.reduce((total, p) => total + p.usd, 0);

/**
 * A run that is cut where it stands between two sessions, at each such place in turn, and resumed
 * with the rest of the script: it reaches the outcome and the cost of the run that was not cut, and
 * each session it starts is given the same prompt. `same` compares what else the lines made.
 */
async function resumedAtEachBoundary(o: {
  config: NonNullable<Parameters<typeof demoRun>[0]["config"]>;
  script: () => FauxResponseStep[];
  /** The number of boundaries the run is expected to have. */
  boundaries: number;
  same?: (whole: HarnessEvent[], resumed: HarnessEvent[], where: string) => void;
  options?: Partial<Parameters<typeof demoRun>[0]>;
  /** The simulated Lean of a process, when the default does not do. */
  lean?: () => LeanChecker;
  /** The certifier of a process. */
  certifier?: () => LeanCertifier;
}): Promise<{ whole: Awaited<ReturnType<typeof demoRun>>; resumed: Array<Awaited<ReturnType<typeof demoResume>>> }> {
  const wholeTrace: string[] = [];
  const whole = await demoRun({
    config: o.config,
    responses: observed(wholeTrace, o.script()),
    ...(o.lean !== undefined ? { lean: o.lean() } : {}),
    ...(o.certifier !== undefined ? { certifier: o.certifier() } : {}),
    ...o.options,
  });
  const all: Array<Awaited<ReturnType<typeof demoResume>>> = [];
  const cuts = boundaries(whole.events);
  assert.equal(cuts.length, o.boundaries, "the run has the sessions the test is made of");
  for (const cut of cuts) {
    const where = `cut after event ${cut} of ${whole.events.length} (${whole.events[cut - 1]?.type})`;
    const prefix = whole.events.slice(0, cut);
    const trace: string[] = [];
    const resumed = await demoResume({
      dir: killedAt(whole.dir, cut),
      bench: whole.bench,
      responses: observed(trace, o.script().slice(consumed(prefix))),
      ...(o.options?.lines !== undefined ? { lines: o.options.lines } : {}),
      ...(o.lean !== undefined ? { lean: o.lean() } : {}),
      ...(o.certifier !== undefined ? { certifier: o.certifier() } : {}),
    });
    all.push(resumed);
    assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.attempts]), whole.result.problems.map((p) => [p.outcome, p.attempts]), where);
    assert.ok(Math.abs(costOf(resumed.result) - costOf(whole.result)) < 1e-9, `${where}: the same cost`);
    assert.deepEqual(trace, wholeTrace.slice(consumed(prefix)), `${where}: the model is shown the same, session after session`);
    assert.ok(Math.abs(spent(resumed.events).charged - spent(whole.events).charged) < 1e-9, `${where}: the same calls were billed`);
    o.same?.(whole.events, resumed.events, where);
    assertSound(resumed.events);
  }
  return { whole, resumed: all };
}

/**
 * A run cut at every event of its journal and resumed: it ends, soundly, with an outcome that is not
 * a failure of the harness. (The script goes on where the first process's responses stopped, so that
 * a session that was cut in the middle is not given the answers it was, and the outcome may differ
 * from the run that was not cut: the tests at the boundaries compare that.)
 */
async function resumedAtEveryEvent(o: {
  config: NonNullable<Parameters<typeof demoRun>[0]["config"]>;
  script: () => FauxResponseStep[];
  outcomes: string[];
  check?: (resumed: HarnessEvent[], where: string) => void;
  /**
   * What a cut between two sessions must leave equal to the run that was not cut (no session was cut, so
   * the resumed run is the same run): the outcome, the cost, and what this compares. A cut in the middle of a
   * session pays for it twice, so only `check` holds there.
   */
  sameBetweenSessions?: (whole: HarnessEvent[], resumed: HarnessEvent[], where: string) => void;
  options?: Partial<Parameters<typeof demoRun>[0]>;
  every?: number;
  /** True when work a session needs before it starts (a model call whose record a cut can precede) is paid again after such a cut: the cost is then not compared. */
  repeatsCost?: boolean;
}): Promise<number> {
  const whole = await demoRun({ config: o.config, responses: o.script(), ...o.options });
  const tail: FauxResponseStep[] = Array.from({ length: 8 }, () => say("done"));
  let resumedRuns = 0;
  let between = 0;
  for (let cut = 1; cut < whole.events.length; cut += o.every ?? 1) {
    const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
    const resumed = await demoResume({
      dir: killedAt(whole.dir, cut),
      bench: whole.bench,
      responses: [...o.script().slice(consumed(whole.events.slice(0, cut))), ...tail],
      ...(o.options?.lines !== undefined ? { lines: o.options.lines } : {}),
      ...(o.options?.lean !== undefined ? { lean: o.options.lean } : {}),
    });
    resumedRuns += 1;
    assert.ok(o.outcomes.includes(resumed.result.problems[0]?.outcome ?? "none"), `${where}: ${resumed.result.problems[0]?.outcome} (${resumed.result.problems[0]?.reason})`);
    assert.equal(ofType(resumed.events, "problem.finished").length, 1, where);
    assert.equal(resumed.events.at(-1)?.type, "run.finished", where);
    o.check?.(resumed.events, where);
    const prefix = whole.events.slice(0, cut);
    if (ofType(prefix, "attempt.started").length === ofType(prefix, "attempt.finished").length) {
      between += 1;
      assert.deepEqual(resumed.result.problems.map((p) => [p.outcome, p.attempts]), whole.result.problems.map((p) => [p.outcome, p.attempts]), where);
      if (o.repeatsCost !== true) assert.ok(Math.abs(costOf(resumed.result) - costOf(whole.result)) < 1e-9, `${where}: the same cost`);
      o.sameBetweenSessions?.(whole.events, resumed.events, where);
    }
    assertSound(resumed.events);
  }
  assert.ok(o.sameBetweenSessions === undefined || between > 0, "some cut fell between two sessions");
  return resumedRuns;
}

describe("the fleet in a resumed run", () => {
  const seeded = { lines: ["M1", "fleet"], sessions: 3, lineOptions: { fleet: { seed: 3 } } as never };
  /** Three sessions that fail: the first strategy is kept while Lean gets further, then drawn again. */
  const script = (): FauxResponseStep[] => [check("omega"), say("one"), check("linarith"), say("two"), check("simp"), say("three")];

  it("goes on with the strategy the prover stuck to and draws what the run that was not cut drew, as the allocations and the prompts show", async () => {
    await resumedAtEachBoundary({
      config: seeded,
      script,
      boundaries: 3,
      same: (whole, resumed, where) => {
        const bare = (events: HarnessEvent[]) => nodesOf(events, "allocation").map(({ attemptId: _attempt, ...rest }) => rest);
        assert.deepEqual(bare(resumed), bare(whole), `${where}: the same allocations, draws included`);
      },
    });
  });

  it("resumes a run cut at every event", async () => {
    const runs = await resumedAtEveryEvent({
      config: seeded,
      script,
      outcomes: ["unsolved"],
      sameBetweenSessions: (whole, resumed, where) => {
        // An allocation written for a session the cut kept from starting is written again; the sessions that started are compared.
        const bare = (events: HarnessEvent[]) => {
          const started = new Set(ofType(events, "attempt.started").map((e) => e.data.attemptId));
          return nodesOf(events, "allocation").filter((a) => started.has(a.attemptId as string)).map(({ attemptId: _attempt, ...rest }) => rest);
        };
        assert.deepEqual(bare(resumed), bare(whole), `${where}: the same strategies are drawn for the sessions that follow`);
      },
      check: (resumed, where) => {
        const started = new Set(ofType(resumed, "attempt.started").map((e) => e.data.attemptId));
        // Every session that started was allocated; one that never did was, and left nothing behind but its node.
        for (const id of started) assert.ok(nodesOf(resumed, "allocation").some((a) => a.attemptId === id), `${where}: session ${id} has its allocation`);
      },
    });
    assert.ok(runs > 30, "the whole journal was cut");
  });

  it("does not make a prover wait for one that had ended before the interruption", async () => {
    // One prover at a time on the problem: the second waits at the gate until the first has ended.
    const config = { lines: ["M1", "fleet"], provers: 2, sessions: 1, lineOptions: { fleet: { seed: 1, maxWidthProblem: 1 } } as never };
    const router = (context: TranscriptContext): AssistantMessage => (context.messages.some((m) => m.role === "toolResult") ? say("notes") : check("omega"));
    const whole = await demoRun({ config, responses: Array.from({ length: 4 }, () => router) });
    assert.equal(ofType(whole.events, "attempt.started").length, 2, "both provers ran, one after the other");
    // The first prover's task ends, and the process ends before the second one has a session.
    const cut = whole.events.findIndex((e) => e.type === "task.status_changed" && e.data.to === "failed") + 1;
    assert.ok(cut > 0 && ofType(whole.events.slice(0, cut), "attempt.started").length === 1);
    const resumed = await Promise.race([
      demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: Array.from({ length: 4 }, () => router) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the second prover waits for the first, which has ended")), 20_000).unref()),
    ]);
    assert.equal(ofType(resumed.events, "attempt.started").length, 2);
    assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["unsolved"]);
    assertSound(resumed.events);
  });
});

describe("M6 in a resumed run", () => {
  const M6_ONLY = { lines: ["M6"] };
  const equalFindings = (whole: HarnessEvent[], resumed: HarnessEvent[], where: string) =>
    assert.deepEqual(findings(resumed), findings(whole), `${where}: the guards found the same things at the same checks`);

  it("tells the next session what the stopped one was told to change, as the run that was not cut did", async () => {
    await resumedAtEachBoundary({
      config: { ...M6_ONLY, sessions: 2 },
      script: () => [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), check("exact trivial_proof")],
      boundaries: 2,
      same: equalFindings,
    });
  });

  it("does not tell a notice again to a session after the one that already got it", async () => {
    // Session 1 is stopped for repeating a strategy; session 2 is told; session 3 must not be told again, wherever the run was cut before it.
    await resumedAtEachBoundary({
      config: { ...M6_ONLY, sessions: 3 },
      script: () => [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), say("nothing more"), check("linarith"), say("done")],
      boundaries: 3,
      same: (whole, resumed, where) => {
        equalFindings(whole, resumed, where);
        assert.equal(findings(whole).filter((f) => f.action === "stopped_session").length, 1, where);
      },
    });
  });

  it("tells it again to the session that follows a cut one, which did not carry it on", async () => {
    // The session that was told is cut after its briefing: the next one is told again.
    const script = () => [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), check("exact trivial_proof")];
    const whole = await demoRun({ config: { ...M6_ONLY, sessions: 3 }, responses: script() });
    const prompts: string[] = [];
    const cut = nth(whole.events, "attempt.started", 2) + 1;
    const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, responses: observed(prompts, [check("exact trivial_proof")]) });
    assert.equal(resumed.result.problems[0]?.outcome, "candidate");
    assert.match(prompts[0] ?? "", /# Course change\nThe harness stopped your last session: 3 checks in a row used the strategy automation/);
    assertSound(resumed.events);
  });

  it("restarts a prover whose sessions repeat one strategy at the session the run that was not cut did", async () => {
    await resumedAtEachBoundary({
      config: { ...M6_ONLY, sessions: 4, lineOptions: { M6: { sessionRepeats: 2 } } },
      script: () => [check("omega"), say("notes one"), check("linarith"), say("notes two"), check("simp"), say("notes three"), say("done")],
      boundaries: 4,
      same: equalFindings,
    });
  });

  it("rejects a file the last session left and sent again, from the check it kept", async () => {
    await resumedAtEachBoundary({
      config: { ...M6_ONLY, sessions: 2 },
      script: () => [check("omega"), check("-- again\nomega"), check("linarith"), say("nothing new"), check("linarith"), check("omega"), say("done")],
      boundaries: 2,
      same: (whole, resumed, where) => {
        equalFindings(whole, resumed, where);
        assert.deepEqual(findings(resumed).map((f) => [f.kind, f.session, f.check]), [["unanchored_revision", 1, 2], ["unanchored_revision", 2, 1]], where);
      },
    });
  });

  it("notes a framing once for the problem, not once for each process", async () => {
    const framer: Line = {
      id: "M10",
      title: "a helper line of the tests",
      requires: [],
      resume: "stateless",
      hooks: { briefing: async () => ({ title: "Goal", text: "Prove that the statement holds for all n." }) },
    };
    const lines: LineRegistry = { ...LINES, M10: framer };
    await resumedAtEachBoundary({
      config: { lines: ["M6", "M10"], sessions: 3, selection: { all: true } },
      script: () => [check("omega"), say("one"), check("linarith"), say("two"), check("simp"), say("three")],
      boundaries: 3,
      options: { lines, file: DEMO_FILE.replaceAll("research solved", "research open"), filter: { ...DISCRETE, categories: ["research solved", "research open"] } },
      same: (whole, resumed, where) => {
        equalFindings(whole, resumed, where);
        assert.equal(findings(resumed).filter((f) => f.kind === "non_neutral_framing").length, 1, where);
      },
    });
  });

  it("resumes runs cut at every event", async () => {
    const runs = await resumedAtEveryEvent({
      config: { ...M6_ONLY, sessions: 2 },
      script: () => [check("omega"), check("linarith"), check("simp"), check("simp\nomega"), check("exact trivial_proof")],
      outcomes: ["candidate", "unsolved"],
      sameBetweenSessions: equalFindings,
    });
    const more = await resumedAtEveryEvent({
      config: { ...M6_ONLY, sessions: 4, lineOptions: { M6: { sessionRepeats: 2 } } },
      script: () => [check("omega"), say("notes one"), check("linarith"), say("notes two"), check("simp"), say("notes three"), say("done")],
      outcomes: ["unsolved"],
      sameBetweenSessions: equalFindings,
    });
    assert.ok(runs + more > 60);
  });
});

/** M2 as the run sees it, with the problem's memory and claim kept for a test's model to wait on. */
function watchedM2(): { line: Line; seen: { memory?: MemoryStore; claimId?: string } } {
  const seen: { memory?: MemoryStore; claimId?: string } = {};
  const keep = (problem: { memory: MemoryStore; claimId: string }) => {
    seen.memory = problem.memory;
    seen.claimId = problem.claimId;
  };
  const line: Line = {
    ...m2Line,
    hooks: {
      ...m2Line.hooks,
      beforeProvers: async (problem) => {
        keep(problem);
        await m2Line.hooks.beforeProvers?.(problem);
      },
      resumeProblem: async (problem, held) => {
        keep(problem);
        await m2Line.hooks.resumeProblem?.(problem, held);
      },
    },
  };
  return { line, seen };
}

const isTwin = (context: TranscriptContext): boolean => /negation of a statement whose truth is not known/.test(sessionPromptOf(context));

/** Waits until the condition holds, polling; a test whose model must not run ahead of the line uses it. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 5) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A line before M2 that leaves a proved strengthening of the problem's claim with its edge checked, from which M2 composes a proof of the claim. */
function preparing(): Line {
  return {
    id: "M1",
    title: "prepares a strengthening",
    requires: [],
    resume: "stateless",
    hooks: {
      beforeProvers: async (problem) => {
        const header = problem.target.sketch.prefix;
        const variant = await createVariant(problem.memory, { from: problem.claimId, relation: "strengthening", statement: "(n : ℕ) : n + 0 = n ∧ 0 + n = n", header });
        await problem.validate({ claimId: variant.claimId, proof: "exact trivial_proof" });
        await checkEdge({ memory: problem.memory, validate: problem.validate, header, closers: ["exact trivial_proof"] }, variant.edge.edgeId);
      },
    },
  };
}

describe("M2 in a resumed run", () => {
  const twinCalls = (events: readonly HarnessEvent[]) => ofType(events, "model_call.finished").filter((m) => m.data.site === "graph.attempt").length;

  /**
   * The refutation side answers wrong once, then right (its first answer is the one `already` calls
   * before it), and the prover waits for the line to settle the claim the other way before it
   * starts: the model calls of the two do not race.
   */
  function twinScenario(already = 0, wrongFirst = true) {
    const { line, seen } = watchedM2();
    let calls = already;
    const router = async (context: TranscriptContext): Promise<AssistantMessage> => {
      if (isTwin(context)) {
        calls += 1;
        return say(lean(calls === 1 && wrongFirst ? "exact bad" : "exact trivial_proof"));
      }
      // The line has settled the claim the other way, or has no calls left: whichever comes first.
      const memory = seen.memory as MemoryStore;
      await until(
        () => memory.edges({ to: seen.claimId as string, kinds: ["negation_of"] }).some((e) => memory.claim(e.from)?.status === "computed") || calls >= 2,
        "the refutation side to be done",
      );
      return context.messages.some((m) => m.role === "toolResult") ? say("I will stop here.") : check("bad");
    };
    return { lines: { M2: line } as LineRegistry, responses: Array.from({ length: 12 }, () => router) };
  }

  it("makes the twin once, asks the refutation side only for the calls it has left, and writes the twin once, wherever it was cut", async () => {
    const first = twinScenario();
    const whole = await demoRun({
      lines: first.lines,
      config: { lines: ["M2"], sessions: 3 },
      lean: new DemoLean(toyAnswer),
      responses: first.responses,
    });
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["unsolved"]);
    assert.equal(twinCalls(whole.events), 2);
    assert.deepEqual(nodesOf(whole.events, "twin").map((n) => [n.checked, n.end, n.tries]), [[true, "refutation", 2]]);
    const edges = ofType(whole.events, "edge.added").length;
    const claims = ofType(whole.events, "claim.created").length;
    const sides = new Set<string>();
    for (let cut = 1; cut < whole.events.length; cut++) {
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const again = twinScenario(twinCalls(whole.events.slice(0, cut)));
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        lines: again.lines,
        lean: new DemoLean(toyAnswer),
        responses: again.responses,
      });
      assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["unsolved"], `${where}: ${resumed.result.problems[0]?.reason}`);
      // One twin, whoever made it: the edge and the claims are not made twice, and the model is not asked for more than two calls.
      assert.equal(ofType(resumed.events, "edge.added").length, edges, `${where}: one negation edge`);
      assert.equal(ofType(resumed.events, "claim.created").length, claims, `${where}: no claim twice`);
      assert.equal(nodesOf(resumed.events, "twin_work").length, 1, `${where}: one twin kept`);
      assert.ok(twinCalls(resumed.events) <= 2, `${where}: ${twinCalls(resumed.events)} calls of the refutation side`);
      const [twin] = nodesOf(resumed.events, "twin");
      assert.equal(nodesOf(resumed.events, "twin").length, 1, `${where}: the twin is written once`);
      sides.add(String(twin?.end));
      assert.ok(twin?.end === "refutation" || twin?.end === "exhausted", `${where}: the side ${String(twin?.end)}`);
      assert.equal(twin?.tries, twinCalls(resumed.events), `${where}: the calls it made, whichever process made them`);
      assertSound(resumed.events);
    }
    assert.ok(sides.has("refutation"), "a cut after which the side proved the negation");
  });

  it("recovers the certifications a cut left pending, once each, wherever the run was cut", async () => {
    // The twin's proof is right on the first call: the link lemma, the twin and the composed refutation are certified, in that order.
    const requestsOf: CertificationRequest[][] = [];
    const makeCertifier = (): LeanCertifier => {
      const requests: CertificationRequest[] = [];
      requestsOf.push(requests);
      return {
        implementation: "fake-certifier",
        version: "0",
        certify: async (request): Promise<CertificationResult> => {
          requests.push(request);
          return { verdict: "certified", reasons: [], axioms: ["propext"], timeMs: 1 };
        },
      };
    };
    const first = twinScenario(0, false);
    const whole = await demoRun({
      lines: first.lines,
      config: { lines: ["M2"], sessions: 3 },
      lean: new DemoLean(toyAnswer),
      certifier: makeCertifier(),
      responses: first.responses,
    });
    const kernel = (events: readonly HarnessEvent[]) => ofType(events, "validation.finished").filter((v) => v.data.method === "kernel_replay");
    assert.deepEqual(whole.result.problems.map((p) => p.outcome), ["refuted"]);
    assert.equal(kernel(whole.events).length, 3);
    for (let cut = 1; cut < whole.events.length; cut++) {
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const prefix = whole.events.slice(0, cut);
      const again = twinScenario(twinCalls(prefix), false);
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        lines: again.lines,
        lean: new DemoLean(toyAnswer),
        certifier: makeCertifier(),
        responses: again.responses,
      });
        assert.deepEqual(resumed.result.problems.map((p) => p.outcome), ["refuted"], `${where}: ${resumed.result.problems[0]?.reason}`);
      // Every certification is on record once, and the certifier was asked for exactly the ones the first process had not got an answer for.
      const certified = kernel(resumed.events).map((v) => v.data.claimId);
      assert.equal(certified.length, 3, `${where}: three certifications`);
      assert.equal(new Set(certified).size, 3, `${where}: one for each claim`);
      assert.equal(requestsOf.at(-1)?.length, 3 - kernel(prefix).length, `${where}: only what was missing was certified`);
      assertSound(resumed.events);
    }
  });

  it("gives a resumed session the graph's short names and what the graph tool said", async () => {
    const aliases = (events: HarnessEvent[]) => nodesOf(events, "alias").length;
    await resumedAtEachBoundary({
      config: { lines: ["M2"], sessions: 2, lineOptions: { M2: { twinTries: 0 } } },
      lean: () => new DemoLean(toyAnswer),
      script: () => [call("graph_neighbors", {}), check("bad"), say("one"), call("graph_neighbors", {}), check("bad"), say("two")],
      boundaries: 2,
      same: (whole, resumed, where) => assert.equal(aliases(resumed), aliases(whole), `${where}: the same names, none given twice`),
    });
  });

  for (const accepted of [true, false]) {
    it(`records the derivation of a composed proof Lean ${accepted ? "accepted" : "refused"} before the process ended, once, and does not submit the proof again`, async () => {
      const composedProof = (code: string) => (proofOf(code) ?? "").includes("aux_m2_l1 aux_m2_p1");
      const answer = (code: string): FakeLeanAnswer => (!accepted && composedProof(code) ? { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "type mismatch" }] } : toyAnswer(code));
      const composed = (lean: DemoLean) => lean.calls.filter((c) => composedProof(c.code)).length;
      const options = { lines: { M1: preparing(), M2: m2Line } };
      const config = { lines: ["M1", "M2"], sessions: 1, lineOptions: { M2: { twin: false } } };
      const lean = new DemoLean(answer);
      const whole = await demoRun({ config, ...options, lean, responses: [check(accepted ? "exact trivial_proof" : "bad")] });
      assert.equal(whole.result.problems[0]?.outcome, accepted ? "candidate" : "unsolved");
      assert.equal(composed(lean), 1);
      const derivations = (events: readonly HarnessEvent[]) => nodesOf(events, "derivation").filter((n) => n.rule === "strengthens/proved");
      assert.equal(derivations(whole.events).length, 1);
      // After Lean's answer to the composed proof, and until its derivation node is written, no cut may submit it again or leave it unrecorded.
      const claimId = ofType(whole.events, "problem.registered")[0]?.data.claimId;
      const answered = whole.events.findIndex((e) => e.type === "validation.finished" && e.data.attemptId === undefined && e.data.method === "repl" && e.data.claimId === claimId);
      assert.ok(answered > 0);
      const written = whole.events.findIndex((e, i) => i > answered && e.type === "node.recorded" && e.data.kind === "derivation");
      assert.ok(written > answered, "the derivation node is written after Lean's answer");
      for (let cut = answered + 1; cut <= written; cut++) {
        const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
        const again = new DemoLean(answer);
        const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, ...options, lean: again, responses: [check(accepted ? "exact trivial_proof" : "bad")] });
        assert.equal(resumed.result.problems[0]?.outcome, accepted ? "candidate" : "unsolved", `${where}: ${resumed.result.problems[0]?.reason}`);
        assert.equal(derivations(resumed.events).length, 1, `${where}: the derivation is recorded once`);
        assert.equal(composed(again), 0, `${where}: the composed proof is not submitted again`);
        assertSound(resumed.events);
      }
    });
  }

  it("does not submit again a composed proof Lean refused, in the next process", async () => {
    // A line before M2 leaves a proved strengthening, from which M2 composes a proof of the claim that this Lean refuses.
    const prepare = preparing();
    const refused = (code: string): FakeLeanAnswer =>
      (proofOf(code) ?? "").includes("aux_m2_l1 aux_m2_p1") ? { messages: [{ severity: "error", pos: { line: 1, column: 0 }, text: "type mismatch" }] } : toyAnswer(code);
    const leans: DemoLean[] = [];
    const composedChecks = (index: number) => (leans[index]?.calls ?? []).filter((c) => (proofOf(c.code) ?? "").includes("aux_m2_l1 aux_m2_p1")).length;
    const { whole } = await resumedAtEachBoundary({
      config: { lines: ["M1", "M2"], sessions: 2, lineOptions: { M2: { twin: false } } },
      options: { lines: { M1: prepare, M2: m2Line } },
      lean: () => {
        const made = new DemoLean(refused);
        leans.push(made);
        return made;
      },
      script: () => [check("bad"), say("one"), check("bad"), say("two")],
      boundaries: 2,
    });
    assert.ok(composedChecks(0) >= 1, "the composed proof was submitted");
    // Resumed after the first session (the first boundary), the process submits none of what the first one had.
    assert.equal(composedChecks(1), 0, "the composed proof Lean refused is not submitted again");
    assert.equal(whole.result.problems.length, 1);
  });
});

describe("M1, M2, M6 and the fleet together in a resumed run", () => {
  it("resumes a run cut at every event", async () => {
    // The refutation side always answers wrong; the prover tries one strategy and stops, session after session.
    const router = (context: TranscriptContext): AssistantMessage => {
      if (isTwin(context)) return say(lean("exact bad"));
      return context.messages.some((m) => m.role === "toolResult") ? say("notes") : check("omega");
    };
    const runs = await resumedAtEveryEvent({
      config: { lines: ["M1", "M2", "M6", "fleet"], sessions: 3, selection: { all: true }, lineOptions: { fleet: { seed: 5 }, M2: { twinTries: 2 } } as never },
      script: () => Array.from({ length: 12 }, () => router),
      outcomes: ["unsolved"],
      options: { lean: new DemoLean(toyAnswer) },
      // Every second cut: each line's every cut is made by its own tests above, and the four together are checked at half of them.
      every: 2,
      check: (resumed, where) => {
        assert.equal(nodesOf(resumed, "twin_work").length, 1, `${where}: one twin kept`);
        assert.ok(nodesOf(resumed, "twin").length <= 1, `${where}: the twin is written at most once`);
        assert.ok(ofType(resumed, "model_call.finished").filter((m) => m.data.site === "graph.attempt").length <= 2, `${where}: the refutation side's calls stay within its budget`);
      },
    });
    assert.ok(runs > 25, `half of the journal was cut (${runs} cuts)`);
  });
});

describe("the soft failure memory in a resumed run (sampled settings, exploration, informal-first sessions)", () => {
  /** What the fleet decided for each session and what the attempt recorded of it, without the ids. */
  const decided = (events: HarnessEvent[]) => {
    const started = new Set(ofType(events, "attempt.started").map((e) => e.data.attemptId));
    return {
      allocations: nodesOf(events, "allocation").filter((a) => started.has(a.attemptId as string)).map(({ attemptId: _attempt, ...rest }) => rest),
      attempts: ofType(events, "attempt.started").map((e) => [e.data.prover, e.data.iteration, e.data.model, e.data.strategy, e.data.settings, e.data.exploration]),
    };
  };
  const failing = (context: TranscriptContext): AssistantMessage => (context.messages.some((m) => m.role === "toolResult") ? say("notes") : check("omega"));

  const sampled = {
    lines: ["M1", "fleet"],
    sessions: 5,
    lineOptions: { fleet: { seed: 11, epsilon: 0.4, thinking: ["low", "high"], temperature: [0.2, 0.8], directives: true } } as never,
  };

  it("draws the same settings and the same exploration sessions as the run that was not cut, at every boundary", async () => {
    const { whole } = await resumedAtEachBoundary({
      config: sampled,
      script: () => Array.from({ length: 12 }, () => failing),
      boundaries: 5,
      same: (whole, resumed, where) => assert.deepEqual(decided(resumed), decided(whole), `${where}: the same decisions`),
    });
    const attempts = ofType(whole.events, "attempt.started");
    assert.ok(attempts.every((e) => e.data.settings?.thinking !== undefined && typeof e.data.exploration === "boolean"), "settings and the flag are on every attempt");
    assert.ok(attempts.some((e) => e.data.exploration === true), "the floor took some session");
  });

  it("resumes a run cut at a sample of its events with the settings and the floor on", async () => {
    const runs = await resumedAtEveryEvent({
      config: sampled,
      script: () => Array.from({ length: 12 }, () => failing),
      outcomes: ["unsolved"],
      every: 5,
      sameBetweenSessions: (whole, resumed, where) => assert.deepEqual(decided(resumed), decided(whole), `${where}: the same decisions`),
    });
    assert.ok(runs > 10, `${runs} cuts`);
  });

  describe("informal-first", () => {
    const dag = {
      proof: "By the definition of addition.",
      steps: [
        { id: "s1", statement: "Zero is a right identity.", dependsOn: [] },
        { id: "s2", statement: "Hence n + 0 = n.", dependsOn: ["s1"] },
      ],
    };
    const router = (context: TranscriptContext): AssistantMessage => {
      if (sessionPromptOf(context).includes("write the informal argument, and break it into")) return say(JSON.stringify(dag));
      return context.messages.some((m) => m.role === "toolResult") ? say("notes") : check("omega", "lemma aux_s1 : True := by\n  trivial\n");
    };
    const config = { lines: ["M1", "fleet"], sessions: 3, lineOptions: { fleet: { seed: 2, epsilon: 0, strategies: false, modes: ["nl_first"] } } as never };
    const steps = (events: HarnessEvent[]) => ({
      dags: nodesOf(events, "step_dag").length,
      status: nodesOf(events, "step_status").map(({ attemptId: _attempt, dagNodeId: _dag, ...rest }) => rest),
      stepClaims: ofType(events, "claim.created").filter((e) => e.data.origin === "line:fleet").length,
      edges: ofType(events, "edge.added").filter((e) => e.data.kind === "decomposes_into").length,
    });

    it("writes the step DAG once and tells each later session the same plan, wherever the run was cut between sessions", async () => {
      const { whole } = await resumedAtEachBoundary({
        config,
        script: () => Array.from({ length: 14 }, () => router),
        boundaries: 3,
        same: (whole, resumed, where) => {
          assert.deepEqual(steps(resumed), steps(whole), `${where}: one DAG, its claims and edges, the same states`);
          assert.deepEqual(decided(resumed), decided(whole), `${where}: the same decisions`);
        },
      });
      assert.deepEqual(steps(whole.events).dags, 1);
    });

    it("resumes a run cut at a sample of its events, and never records the DAG twice, nor its edges", async () => {
      const runs = await resumedAtEveryEvent({
        config,
        script: () => Array.from({ length: 14 }, () => router),
        outcomes: ["unsolved"],
        every: 3,
        // A cut after the DAG call was paid and before it was recorded asks for the DAG again: the call is paid twice.
        repeatsCost: true,
        sameBetweenSessions: (_whole, resumed, where) => assert.ok(steps(resumed).dags === 1, `${where}: the DAG is there after the first session`),
        check: (resumed, where) => {
          assert.ok(steps(resumed).dags <= 1, `${where}: at most one DAG`);
          assert.equal(steps(resumed).edges, steps(resumed).dags === 0 ? steps(resumed).edges : 2, `${where}: its two edges`);
          assert.ok(steps(resumed).stepClaims <= 2, `${where}: its two step claims`);
        },
      });
      assert.ok(runs > 15, `${runs} cuts`);
    });
  });
});
