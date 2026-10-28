import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { type LeanCertifier, PROOF_BEGIN, statementIdV0 } from "@seshat/core";
import type { Line } from "@seshat/lines";
import { STRATEGIES, type StatementIdentity } from "@seshat/memory";
import { M1 } from "../src/index.ts";
import { check, DemoLean, demoAnswer, demoRun, ofType, proofOf, say } from "./m0-helpers.ts";

type Message = TranscriptContext["messages"][number];

/** The opening message of a session. */
function opening(context: TranscriptContext): string {
  const message = context.messages.find((m) => m.role === "user") as Message;
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

interface ToolSpec {
  name: string;
  parameters: { required: string[]; properties: Record<string, { enum?: string[] }> };
}

/** `lean_check` as the model is given it: pi puts the tools in the system message. */
function leanCheckSpec(context: TranscriptContext): ToolSpec {
  const system = context.messages.find((m) => (m.role as string) === "system") as unknown as { toolsAdded: ToolSpec[] };
  return system.toolsAdded.find((t) => t.name === "lean_check") as ToolSpec;
}

const IMPORTS = "import FormalConjectures.Util.ProblemImports\n\nnamespace Demo\n\n";

/** A problem file: the prefix, then a solved problem. */
function problemFile(theorem: string, prefix = IMPORTS): string {
  return `${prefix}/-- Adding zero changes nothing. -/\n@[category research solved, AMS 11]\n${theorem} := by\n  sorry\n\nend Demo\n`;
}

/** Two files that read the same: one prefix, and one statement, spaced differently. */
const TWICE = {
  "Demo.lean": problemFile("theorem add_zero' (n : ℕ) : n + 0 = n"),
  "DemoAgain.lean": problemFile("theorem add_zero_again (n : ℕ)  :  n + 0 = n"),
};

/** Two files with one statement under two prefixes: the second opens a namespace the first does not. */
const APART = {
  "Demo.lean": TWICE["Demo.lean"],
  "DemoAgain.lean": problemFile("theorem add_zero_again (n : ℕ) : n + 0 = n", `${IMPORTS}open Nat\n\n`),
};

/** One file with two statements that differ only in the name of a variable. */
const ALPHA = `${IMPORTS}/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- The same statement, with another variable. -/
@[category research solved, AMS 11]
theorem add_zero_m (m : ℕ) : m + 0 = m := by
  sorry

end Demo
`;

const INDUCTION = "induction n with\n| zero => exact Nat.add_zero 0\n| succ k ih => omega";

/** Lean as the demo has it, except that an induction leaves the successor case. */
function lean(): DemoLean {
  return new DemoLean((code) => {
    if (proofOf(code)?.includes("induction") !== true) return demoAnswer(code);
    const line = code.split("\n").findIndex((l) => l.trim() === PROOF_BEGIN) + 2;
    const text = "unsolved goals\ncase succ\nk : ℕ\nih : k + 0 = k\n⊢ k + 1 + 0 = k + 1";
    return { messages: [{ severity: "error", pos: { line, column: 2 }, text }] };
  });
}

const certifier: LeanCertifier = {
  implementation: "fake-certifier",
  version: "0",
  certify: async () => ({ verdict: "certified", reasons: [], axioms: ["propext"], timeMs: 1 }),
};

describe("M1 in a run", () => {
  it("gives problems with one statement one claim, and tells the second what failed on the first", async () => {
    const prompts: string[] = [];
    const specs: ToolSpec[] = [];
    const { result, events, dir } = await demoRun({
      file: TWICE,
      problems: 2,
      lean: lean(),
      config: { lines: ["M1"], sessions: 1 },
      responses: [
        (context) => {
          prompts.push(opening(context));
          specs.push(leanCheckSpec(context));
          return check(INDUCTION, "", "induction");
        },
        say("The successor case is not closed by omega."),
        (context) => {
          prompts.push(opening(context));
          // The model's label is its own; the memory groups by what the proof is.
          return check(INDUCTION, "", "cases");
        },
        say("The same."),
      ],
    });
    assert.deepEqual(result.problems.map((p) => [p.outcome, p.attempts]), [["unsolved", 1], ["unsolved", 1]]);

    // One claim, made through the memory, with the file's prefix as its header and in its id.
    const claims = ofType(events, "claim.created");
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.actor, "orchestrator");
    assert.equal(claims[0]?.data.origin, "bench:demo-bench");
    assert.equal(claims[0]?.data.header, IMPORTS);
    assert.equal(claims[0]?.data.statementId, statementIdV0("(n : ℕ) : n + 0 = n", IMPORTS));
    assert.deepEqual(claims[0]?.data.domain, ["msc:11"]);
    const registered = ofType(events, "problem.registered");
    assert.equal(registered.length, 2);
    assert.equal(registered[0]?.data.claimId, claims[0]?.data.claimId);
    assert.equal(registered[1]?.data.claimId, claims[0]?.data.claimId);
    assert.notEqual(registered[0]?.data.problemId, registered[1]?.data.problemId);

    // The first problem's session knew nothing; the second problem's began with the typed summary.
    assert.doesNotMatch(prompts[0] ?? "", /Already tried/);
    assert.match(
      prompts[1] ?? "",
      /# What Lean said about the file as it is\n.*\n\n# Already tried\nTyped summaries of the attempts on this statement or an equivalent one, by you and the other provers \(their text is not kept\):\ninduction: 1 attempt, unsolved goals at case succ$/,
    );
    assert.doesNotMatch(prompts[1] ?? "", /omega/);

    // Each attempt: the declared label, the classified one, the failure and the names the proof uses.
    const finished = ofType(events, "attempt.finished").map((e) => e.data);
    assert.deepEqual(
      finished.map((d) => [d.declaredStrategy, d.strategy, d.failureClass, d.failureDetail, d.premises]),
      [
        ["induction", "induction", "unsolved_goals", "unsolved goals at case succ", ["Nat.add_zero"]],
        ["cases", "induction", "unsolved_goals", "unsolved goals at case succ", ["Nat.add_zero"]],
      ],
    );

    // lean_check offers the labels, and still needs only the two regions.
    assert.deepEqual(specs[0]?.parameters.required, ["aux", "proof"]);
    assert.deepEqual(Object.keys(specs[0]?.parameters.properties ?? {}), ["aux", "proof", "strategy"]);
    assert.deepEqual(specs[0]?.parameters.properties.strategy?.enum, [...STRATEGIES]);

    // The second attempt failed as the first had: one redundant attempt of two.
    assert.deepEqual(result.report.redundancy, { attempts: 2, redundant: 1, share: 0.5 });
    assert.match(
      readFileSync(join(dir, "report.md"), "utf8"),
      /^Redundant attempts: 1 of 2 labeled attempts \(50%\) failed again as an earlier attempt on the same claim or an equivalent one had\.$/m,
    );
    assert.deepEqual((JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { redundancy: unknown }).redundancy, { attempts: 2, redundant: 1, share: 0.5 });
  });

  it("puts the section in the first message of a prover's second session", async () => {
    const prompts: string[] = [];
    const { result, events } = await demoRun({
      lean: lean(),
      config: { lines: ["M1"], sessions: 2 },
      responses: [
        (context) => {
          prompts.push(opening(context));
          return check(INDUCTION);
        },
        say("Induction leaves the successor case."),
        (context) => {
          prompts.push(opening(context));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0] ?? "", /Already tried/);
    assert.match(prompts[1] ?? "", /\n\n# Already tried\nTyped summaries .*:\ninduction: 1 attempt, unsolved goals at case succ$/);
    // No label was declared, and the accepted attempt has the one its proof gets.
    const finished = ofType(events, "attempt.finished").map((e) => e.data);
    assert.deepEqual(finished.map((d) => [d.declaredStrategy, d.failureDetail]), [[undefined, "unsolved goals at case succ"], [undefined, undefined]]);
    assert.equal(typeof finished[1]?.strategy, "string");
    assert.equal(result.report.redundancy?.redundant, 0);
  });

  it("drops the section at 0 lines, and labels the attempts all the same", async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({
      lean: lean(),
      config: { lines: ["M1"], sessions: 2, lineOptions: { M1: { maxLines: 0 } } },
      responses: [
        (context) => (prompts.push(opening(context)), check(INDUCTION)),
        say("Induction leaves the successor case."),
        (context) => (prompts.push(opening(context)), say("Done.")),
      ],
    });
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[1] ?? "", /Already tried/);
    // The option sets what the sessions are told, not what the memory keeps.
    assert.equal(ofType(events, "attempt.finished")[0]?.data.strategy, "induction");
    const started = ofType(events, "run.started")[0]?.data.config as { lines?: unknown };
    assert.deepEqual(started.lines, [{ id: "M1", version: "m1-2", options: { maxLines: 0 } }]);
  });

  it("refuses a strategy that is not in the vocabulary, and goes on", async () => {
    const results: string[] = [];
    const checker = lean();
    const { events } = await demoRun({
      lean: checker,
      config: { lines: ["M1"], sessions: 1 },
      responses: [
        check(INDUCTION, "", "magic"),
        (context) => {
          const last = context.messages.findLast((m) => m.role === "toolResult") as Message;
          results.push(JSON.stringify(last.content));
          return check(INDUCTION, "", "induction");
        },
        say("Done."),
      ],
    });
    assert.match(results[0] ?? "", /strategy/);
    // The bad call was not a check.
    assert.equal(checker.calls.filter((c) => proofOf(c.code) !== undefined).length, 1);
    assert.equal(ofType(events, "attempt.finished")[0]?.data.declaredStrategy, "induction");
  });
});

describe("claims of one statement under two prefixes", () => {
  it("are two claims: the same text under another prefix is another statement", async () => {
    const prompts: string[] = [];
    const { result, events } = await demoRun({
      file: APART,
      problems: 2,
      lean: lean(),
      config: { lines: ["M1"], sessions: 1 },
      responses: [
        check(INDUCTION),
        say("The successor case is not closed by omega."),
        (context) => (prompts.push(opening(context)), say("Nothing yet.")),
      ],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["unsolved", "unsolved"]);
    const claims = ofType(events, "claim.created");
    assert.equal(claims.length, 2);
    assert.notEqual(claims[0]?.data.statementId, claims[1]?.data.statementId);
    assert.deepEqual(claims.map((c) => c.data.header), [IMPORTS, `${IMPORTS}open Nat\n\n`]);
    assert.deepEqual(ofType(events, "problem.registered").map((e) => e.data.claimId), claims.map((c) => c.data.claimId));
    // Nothing is shared: the second problem's first session is told nothing about the first's attempt.
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0] ?? "", /Already tried/);
    assert.equal(result.report.redundancy?.redundant, 0);
  });

  it("end a problem as an error, not the run, when the identity cannot name its statement", async () => {
    const refusing: StatementIdentity = {
      version: "st9",
      id: async (statement) => {
        if (statement.includes("n + 0")) throw new Error("no name for this statement");
        return `st9:${statement}`;
      },
    };
    const line: Line = { ...M1, identity: () => refusing };
    const { result, events } = await demoRun({
      problems: 2,
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      responses: [check("exact trivial_proof")],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["error", "candidate"]);
    assert.match(result.problems[0]?.reason ?? "", /^the memory could not name the statement: no name for this statement$/);
    assert.equal(result.problems[0]?.attempts, 0);
    // The failed problem is registered like any other, and the run goes on to the next.
    assert.equal(ofType(events, "problem.registered").length, 2);
    assert.equal(ofType(events, "attempt.started").length, 1);
  });
});

describe("M0 beside M1", () => {
  it("keeps its claims, its tool and its journal when no line is enabled", async () => {
    const specs: ToolSpec[] = [];
    const { result, events, dir } = await demoRun({
      file: TWICE,
      problems: 2,
      lean: lean(),
      config: { sessions: 1 },
      responses: [
        (context) => {
          specs.push(leanCheckSpec(context));
          return check(INDUCTION);
        },
        say("Not closed."),
        check(INDUCTION),
        say("Not closed."),
      ],
    });
    // One claim per problem, as before: the statement ids are equal, the claims are not shared.
    const claims = ofType(events, "claim.created");
    assert.equal(claims.length, 2);
    assert.equal(claims[0]?.data.statementId, claims[1]?.data.statementId);
    assert.notEqual(claims[0]?.data.claimId, claims[1]?.data.claimId);
    assert.deepEqual(claims.map((c) => [c.actor, c.data.header, c.data.domain]), [["orchestrator", undefined, undefined], ["orchestrator", undefined, undefined]]);
    assert.deepEqual(result.problems.map((p) => p.attempts), [1, 1]);
    // The same tool, with the two regions only.
    assert.deepEqual(Object.keys(specs[0]?.parameters.properties ?? {}), ["aux", "proof"]);
    assert.deepEqual(specs[0]?.parameters.required, ["aux", "proof"]);
    // The failure class is finer than it was; nothing else is added to the attempts.
    const finished = ofType(events, "attempt.finished").map((e) => e.data);
    assert.deepEqual(finished.map((d) => d.failureClass), ["unsolved_goals", "unsolved_goals"]);
    assert.ok(finished.every((d) => d.strategy === undefined && d.premises === undefined && d.failureDetail === undefined && d.declaredStrategy === undefined));
    assert.equal(result.report.redundancy, undefined);
    assert.doesNotMatch(readFileSync(join(dir, "report.md"), "utf8"), /Redundant attempts/);
    assert.equal("redundancy" in (JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as object), false);
  });
});

describe("the run's identity", () => {
  it("names the claims with the identity an enabled line gives, and hands it the registry", async () => {
    const environments: unknown[] = [];
    // Statements are equal up to the name of the variable: alpha-equivalent statements share a claim.
    const alpha: StatementIdentity = {
      version: "st9",
      id: (statement) => `st9:${statement.replace(/\s+/g, " ").replace(/\bm\b/g, "n")}`,
    };
    const line: Line = { ...M1, version: "alpha-1", identity: (env) => (environments.push(env), alpha) };
    const { result, events } = await demoRun({
      file: ALPHA,
      problems: 2,
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      responses: [check("exact trivial_proof"), check("exact trivial_proof")],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["candidate", "candidate"]);
    assert.equal(environments.length, 1);
    assert.equal(typeof (environments[0] as { registry: { close: unknown } }).registry.close, "function");
    const claims = ofType(events, "claim.created");
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.data.statementId, "st9:(n : ℕ) : n + 0 = n");
    const registered = ofType(events, "problem.registered").map((e) => e.data.claimId);
    assert.deepEqual(registered, [claims[0]?.data.claimId, claims[0]?.data.claimId]);
    // The second problem's proof leaves the claim as the first one's made it.
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });

  it("settles a shared claim once, whichever problem certifies it", async () => {
    const { result, events } = await demoRun({
      file: TWICE,
      problems: 2,
      certifier,
      config: { lines: ["M1"], sessions: 1 },
      responses: [check("exact trivial_proof"), check("exact trivial_proof")],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["proved", "proved"]);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => [c.data.from, c.data.to]), [["open", "computed"], ["computed", "proved"]]);
    assert.deepEqual(ofType(events, "validation.finished").map((v) => v.data.method), ["repl", "kernel_replay", "repl", "kernel_replay"]);
  });
});
