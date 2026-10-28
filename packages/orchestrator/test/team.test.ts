import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Journal, readEvents } from "@seshat/core";
import { GraphState } from "@seshat/graph";
import { MemoryStore } from "@seshat/memory";
import { buildAccount, hintCommand, openForAnswers, renderAccount, signCommand, signEdge, steerCommand } from "../src/index.ts";
import { assertSound, sessionPromptOf } from "./resume-helpers.ts";
import { check, DemoLean, demoResume, demoRun, ofType } from "./m0-helpers.ts";
import { scriptedJournal } from "./scripted-journal.ts";
import { consortium, TWO_PROBLEMS } from "./turns-helpers.ts";

const quiet = { out: () => {} };

/** A run that the first call ended: its single problem waits. */
const paused = (extra: Parameters<typeof demoRun>[0] extends infer O ? Partial<O> : never = {}) =>
  demoRun({ config: { sessions: 4, consortium: consortium({ tokens: 1 }) }, responses: [check("bad"), ...Array.from({ length: 8 }, () => check("bad"))], ...extra });

describe("the team's answers", () => {
  it("a hint reaches the next session's briefing as a hint, never as a fact, and changes no status", async () => {
    const first = await paused();
    const claimId = ofType(first.events, "problem.registered")[0]?.data.claimId ?? "";
    const lines: string[] = [];
    assert.equal(hintCommand(first.dir, { claimId, text: "Try strong induction on n.", as: "alice", out: (line) => lines.push(line) }), 0);
    assert.match(lines[0] ?? "", /^alice: hint nod_\w+ recorded on claim clm_\w+\. The next sessions on it are shown it as a hint, not a fact/);

    const prompts: string[] = [];
    const next = await demoResume({
      dir: first.dir,
      bench: first.bench,
      responses: [
        (context) => {
          prompts.push(sessionPromptOf(context));
          return check("exact trivial_proof");
        },
      ],
    });
    // The journal: a node of provenance human, written under the person's name.
    const hint = ofType(next.events, "node.recorded").find((e) => e.data.kind === "hint");
    assert.equal(hint?.actor, "human:alice");
    assert.deepEqual(hint?.data.data, { provenance: "human", by: "alice", text: "Try strong induction on n.", afterTurn: 1 });
    assert.equal(hint?.data.claimId, claimId);
    // The session is told it is a suggestion; the text is there, with the person's name.
    assert.match(prompts[0] ?? "", /Hints from the team/);
    assert.match(prompts[0] ?? "", /They are suggestions, not facts and not proofs: check anything you use with Lean/);
    assert.match(prompts[0] ?? "", /- alice: Try strong induction on n\./);
    // Nothing the team sent changed a status: the only status change is the one Lean's check made.
    const changes = ofType(next.events, "claim.status_changed");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.data.to, "computed");
    assert.equal(changes[0]?.actor.startsWith("human:"), false, "no person set a status");
    assertSound(next.events);
  });

  it("a hint is not in a session before it was sent, and is refused for a claim the run does not have", async () => {
    const first = await paused();
    const earlier = ofType(first.events, "attempt.started").length;
    assert.equal(earlier, 1);
    assert.throws(() => hintCommand(first.dir, { claimId: "clm_nothing", text: "x", as: "alice", ...quiet }), /no claim clm_nothing in this run/);
    assert.throws(() => hintCommand(first.dir, { claimId: ofType(first.events, "problem.registered")[0]?.data.claimId ?? "", text: "   ", as: "alice", ...quiet }), /the hint is empty/);
    assert.throws(() => hintCommand(first.dir, { claimId: "x", text: "y", as: "bad name!", ...quiet }), /cannot be journaled/);
    assert.equal(readEvents(join(first.dir, "journal.jsonl")).some((e) => e.type === "node.recorded" && e.data.kind === "hint"), false, "nothing was written");
  });

  it("several people may answer before one resumes, each under their own name", async () => {
    const first = await paused();
    const claimId = ofType(first.events, "problem.registered")[0]?.data.claimId ?? "";
    hintCommand(first.dir, { claimId, text: "Use the Nat.add_zero lemma.", as: "alice", ...quiet });
    hintCommand(first.dir, { claimId, text: "Do not use omega.", as: "bob", ...quiet });
    const prompts: string[] = [];
    const next = await demoResume({ dir: first.dir, bench: first.bench, responses: [(context) => (prompts.push(sessionPromptOf(context)), check("exact trivial_proof"))] });
    const hints = ofType(next.events, "node.recorded").filter((e) => e.data.kind === "hint");
    assert.deepEqual(hints.map((e) => e.actor), ["human:alice", "human:bob"]);
    assert.match(prompts[0] ?? "", /- alice: Use the Nat\.add_zero lemma\.\n- bob: Do not use omega\./);
  });

  it("refuses to answer while a process works the run, and for a directory with no run", async () => {
    const s = scriptedJournal();
    assert.throws(() => openForAnswers(s.dir), /cannot be opened for an answer/);
    assert.throws(() => hintCommand(s.dir, { claimId: s.claims.leaf, text: "x", as: "alice", ...quiet }), /cannot be opened for an answer/);
    s.journal.close();
    // Free now: the same call answers.
    assert.equal(hintCommand(s.dir, { claimId: s.claims.leaf, text: "x", as: "alice", ...quiet }), 0);
    assert.throws(() => openForAnswers(join(s.dir, "nowhere")), /holds no run/);
  });

  it("a signature is recorded under the person's name and does not propagate: no claim changes, nothing is derived", async () => {
    const s = scriptedJournal();
    // The premise is certified (`proved`); an edge from it is `proposed`: Lean has not checked its link lemma.
    const memory = new MemoryStore({ journal: s.journal, blobs: s.blobs });
    const state = new GraphState(memory, [s.claims.proved]);
    state.sync();
    assert.equal(state.levelOf({ goal: "proved", claim: s.claims.proved }), "certified", "the premise holds, so a Lean-checked edge would carry it");
    const statuses = (): string[] => Object.values(s.claims).map((id) => s.journal.projection.claim(id)?.status ?? "?");
    const before = statuses();
    const events = s.journal.projection.lastSeq();

    const change = signEdge(s.journal, { by: "carol", edgeId: s.edges.implies, note: "I checked the argument by hand" });
    assert.deepEqual(change, { from: "proposed", to: "human_signed" });
    const signed = readEvents(join(s.dir, "journal.jsonl")).slice(events + 1);
    assert.deepEqual(signed.map((e) => [e.type, e.actor]), [["edge.status_changed", "human:carol"]]);
    assert.match(signed[0]?.type === "edge.status_changed" ? signed[0].data.reason : "", /^signed by carol: I checked the argument by hand$/);
    assert.equal(s.journal.projection.edge(s.edges.implies)?.status, "human_signed");

    // Propagation follows `lean_checked` edges only: the signed edge derives nothing and no status moved.
    const report = state.sync();
    assert.deepEqual(report.gained, [], "the engines gained nothing from the signature");
    assert.equal(state.levelOf({ goal: "proved", claim: s.claims.leaf }), undefined);
    assert.deepEqual(statuses(), before);
    // The control: an edge Lean checked does carry the premise.
    const link = { name: "link_ac", statement: ": A -> C" };
    const linkClaim = (await memory.ensureClaim({ statement: link.statement, origin: "test", kind: "informal" })).claimId;
    s.journal.emit(
      "validation.finished",
      { validationId: "val_link", claimId: linkClaim, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" },
      "validator",
    );
    memory.addEdge({ kind: "implies", from: s.claims.proved, to: s.claims.computed, status: "lean_checked", link, validationId: "val_link" });
    state.sync();
    assert.equal(state.levelOf({ goal: "proved", claim: s.claims.computed }), "certified", "a Lean-checked edge propagates");
    assert.equal(state.levelOf({ goal: "proved", claim: s.claims.leaf }), undefined, "a signed one does not");
    // A signature never lowers a status, and cannot repeat.
    assert.throws(() => signEdge(s.journal, { by: "carol", edgeId: s.edges.implies }), /is human_signed already/);
    assert.throws(() => signEdge(s.journal, { by: "carol", edgeId: "edg_nothing" }), /no edge edg_nothing in this run/);
    s.journal.close();
  });

  it("a signature through the command is shown in the next turn's account, as a signature that propagates nothing", async () => {
    const s = scriptedJournal();
    s.journal.close();
    const lines: string[] = [];
    assert.equal(signCommand(s.dir, { edgeId: s.edges.implies, as: "carol", out: (line) => lines.push(line) }), 0);
    assert.match(lines[0] ?? "", /^carol: edge edg_\w+ signed \(proposed -> human_signed\)\. A signature is not a Lean check: it propagates nothing and changes no claim's status\./);
    // The account of turn 1 reads only up to its end, so the signature is not in it; the account of turn 2 shows it.
    const journal = Journal.open(s.dir, "run_scripted");
    const zero = { usd: 0, inputTokens: 0, outputTokens: 0 };
    journal.emit("turn.started", { runId: "run_scripted", turn: 2, limit: {}, source: "a flag of the resumption", startSpend: zero }, "orchestrator");
    journal.emit("turn.ended", { runId: "run_scripted", turn: 2, reason: "finished", detail: "d", spent: { turn: zero, run: zero }, minutes: 0, waiting: [] }, "orchestrator");
    journal.close();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    assert.deepEqual(buildAccount(events, 1).problems[0]?.signed, []);
    const [signed] = buildAccount(events, 2).problems[0]?.signed ?? [];
    assert.deepEqual([signed?.edgeId, signed?.by, signed?.kind], [s.edges.implies, "human:carol", "implies"]);
    assert.match(renderAccount(buildAccount(events, 2)), /Signed by human:carol: edge `edg_\w+` \(implies\).*does not propagate and changes no claim's status/);
  });
});

describe("steering", () => {
  const twoAtOnce = () =>
    demoRun({
      file: TWO_PROBLEMS,
      problems: 2,
      config: { concurrency: 2, sessions: 3, consortium: consortium({ tokens: 1 }) },
      responses: Array.from({ length: 10 }, () => check("bad")),
    });
  const claimsOf = (events: Awaited<ReturnType<typeof twoAtOnce>>["events"]) => ofType(events, "problem.registered").map((e) => e.data.claimId);

  it("focus works first on the claim asked for", async () => {
    const first = await twoAtOnce();
    const [a, b] = claimsOf(first.events);
    assert.ok(a !== undefined && b !== undefined);
    steerCommand(first.dir, { focus: b, as: "alice", ...quiet });
    const next = await demoResume({
      dir: first.dir,
      bench: first.bench,
      turns: { limit: { tokens: 1 } },
      responses: Array.from({ length: 10 }, () => check("bad")),
    });
    const sessions = ofType(next.events, "attempt.started").slice(2);
    assert.equal(sessions[0]?.data.claimId, b, "the claim the team asked for is worked first");
    assert.equal(ofType(next.events, "node.recorded").find((e) => e.data.kind === "steer")?.actor, "human:alice");
  });

  it("drop gives up a claim: its problem ends aborted, with the person's name, and nothing more is spent on it", async () => {
    const first = await twoAtOnce();
    const [a, b] = claimsOf(first.events);
    assert.ok(a !== undefined && b !== undefined);
    steerCommand(first.dir, { drop: b, as: "alice", ...quiet });
    const next = await demoResume({
      dir: first.dir,
      bench: first.bench,
      turns: { limit: { tokens: 1_000_000 } },
      responses: [check("exact trivial_proof")],
    });
    const finished = ofType(next.events, "problem.finished");
    const dropped = finished.find((e) => e.data.claimId === b);
    assert.equal(dropped?.data.outcome, "aborted");
    assert.match(dropped?.data.reason ?? "", /^dropped by alice after turn 1$/);
    assert.equal(ofType(next.events, "attempt.started").slice(2).every((e) => e.data.claimId === a), true);
    // The dropped claim's status did not change: dropping is not a verdict.
    assert.equal(ofType(next.events, "claim.status_changed").some((e) => e.data.claimId === b), false);
    assert.equal(finished.find((e) => e.data.claimId === a)?.data.outcome, "candidate");
    assert.equal(ended(next.events).data.reason, "finished");
    assertSound(next.events);
  });

  it("forbid a strategy: a proof that follows it is not run, and the session is told so", async () => {
    const first = await paused({ config: { sessions: 4, consortium: consortium({ tokens: 1 }) } });
    steerCommand(first.dir, { forbid: "induction", as: "bob", ...quiet });
    const lean = new DemoLean();
    const next = await demoResume({
      dir: first.dir,
      bench: first.bench,
      lean,
      responses: [check("induction n\n  · rfl\n  · exact trivial_proof"), check("exact trivial_proof")],
      turns: { limit: { tokens: 1_000_000 } },
    });
    assert.equal(lean.calls.some((call) => call.code.includes("induction n")), false, "the forbidden proof never reached Lean");
    // The session was told why, in the tool's answer, and went on with a proof it could run.
    const attempt = ofType(next.events, "attempt.started").at(-1)?.data.attemptId ?? "";
    assert.match(readFileSync(join(first.dir, "transcripts", `${attempt}.json`), "utf8"), /Not checked \(the team\): the team rules out the strategy \\"induction\\" for this work/);
    assert.equal(ofType(next.events, "problem.finished")[0]?.data.outcome, "candidate");
  });

  it("sets the next turn's limit, which a flag of the resumption still overrides", async () => {
    const first = await paused();
    steerCommand(first.dir, { limit: { tokens: 777 }, as: "bob", ...quiet });
    const viaSteer = await demoResume({ dir: first.dir, bench: first.bench, responses: Array.from({ length: 6 }, () => check("bad")) });
    const second = ofType(viaSteer.events, "turn.started")[1];
    assert.deepEqual([second?.data.limit, second?.data.source], [{ tokens: 777 }, "a steer by bob"]);

    const again = await paused();
    steerCommand(again.dir, { limit: { tokens: 777 }, as: "bob", ...quiet });
    const viaFlag = await demoResume({ dir: again.dir, bench: again.bench, turns: { limit: { usd: 5 } }, responses: [check("exact trivial_proof")] });
    const flagged = ofType(viaFlag.events, "turn.started")[1];
    assert.deepEqual([flagged?.data.limit, flagged?.data.source], [{ usd: 5 }, "a flag of the resumption"]);

    const carried = await paused();
    const viaCarry = await demoResume({ dir: carried.dir, bench: carried.bench, responses: Array.from({ length: 6 }, () => check("bad")) });
    assert.deepEqual([ofType(viaCarry.events, "turn.started")[1]?.data.limit, ofType(viaCarry.events, "turn.started")[1]?.data.source], [{ tokens: 1 }, "carried over from turn 1"]);
  });

  it("refuses what makes no sense", async () => {
    const first = await paused();
    assert.throws(() => steerCommand(first.dir, { as: "bob", ...quiet }), /steer needs something to say/);
    assert.throws(() => steerCommand(first.dir, { focus: "clm_nothing", as: "bob", ...quiet }), /no claim clm_nothing in this run/);
    assert.throws(() => steerCommand(first.dir, { forbid: "witchcraft", as: "bob", ...quiet }), /is not a strategy label; they are induction/);
    assert.throws(() => steerCommand(first.dir, { claimId: "clm_x", as: "bob", ...quiet }), /--claim goes with --forbid/);
    assert.throws(() => steerCommand(first.dir, { limit: { tokens: -4 }, as: "bob", ...quiet }), /needs at least one positive limit/);
  });
});

function ended(events: readonly ReturnType<typeof readEvents>[number][]) {
  const turn = ofType(events, "turn.ended").at(-1);
  if (turn === undefined) throw new Error("no turn.ended");
  return turn;
}
