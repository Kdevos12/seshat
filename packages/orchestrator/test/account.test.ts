import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { type HarnessEvent, Journal, loadMemoryChain, environmentOf, readEvents } from "@seshat/core";
import { buildAccount, renderAccount, turnNarrative, unresolvedInNarrative, writeAccount } from "../src/index.ts";
import { scriptedJournal } from "./scripted-journal.ts";

describe("the account of a turn", () => {
  it("is built from a scripted journal: ids, statuses, who checked, the tree, the open leaves and what was tried", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    const account = buildAccount(events, 1);
    s.journal.close();

    assert.equal(account.turn, 1);
    assert.deepEqual(account.ended, { reason: "impasse", detail: "every open task of goldbach is blocked", minutes: 2.5, breakpoint: { kind: "impasse", problemId: s.problems.decomposed } });
    assert.equal(account.summary.problems, 3);
    assert.deepEqual([account.summary.proved, account.summary.refuted], [0, 1], "the problem outcomes are the journal's: one refuted");
    assert.deepEqual(account.summary.waiting, [s.problems.decomposed, s.problems.stuck]);
    assert.match(account.summary.asked.join("\n"), /goldbach|impasse/i);
    assert.deepEqual(account.spend.turn, { usd: 0.07, tokens: 7350 });
    assert.equal(account.spend.budgetUsd, 5);
    assert.ok(Math.abs((account.spend.leftUsd ?? 0) - (5 - account.spend.run.usd)) < 1e-9);

    const [decomposed, refuted, stuck] = account.problems;
    // Claims proved, computed and refuted: their ids, statuses and the check behind each.
    assert.deepEqual(decomposed?.claims.map((c) => [c.id, c.status]), [[s.claims.proved, "proved"], [s.claims.computed, "computed"]]);
    assert.match(decomposed?.claims[0]?.checkedBy ?? "", new RegExp(`kernel replay ${s.validations.certified} \\(certifier\\).*p1`));
    assert.match(decomposed?.claims[1]?.checkedBy ?? "", new RegExp(`fast Lean check ${s.validations.fast} \\(validator\\)`));
    assert.deepEqual(refuted?.claims.map((c) => [c.id, c.status]), [[s.claims.refuted, "refuted"]]);
    assert.match(refuted?.claims[0]?.checkedBy ?? "", /kernel replay .*, of the negation/);
    assert.equal(refuted?.state, "refuted");
    assert.equal(stuck?.state, "waiting");

    // The tree and its open leaves.
    assert.deepEqual(decomposed?.tree.map((n) => [n.id, n.depth, n.leaf, n.status]), [
      [s.claims.root, 0, false, "open"],
      [s.claims.proved, 1, true, "proved"],
      [s.claims.leaf, 1, true, "open"],
      [s.claims.computed, 1, true, "computed"],
    ]);
    assert.deepEqual(decomposed?.openLeaves.map((l) => l.id), [s.claims.leaf]);
    // The strategies tried on the open leaf, and how the last of each failed.
    assert.deepEqual(
      decomposed?.openLeaves[0]?.tried.map((t) => [t.strategy, t.attempts, t.outcomes, t.lastFailure]),
      [
        ["induction", 1, { invalid: 1 }, "unsolved_goals; unsolved goals at case succ; ended by model"],
        ["automation", 2, { invalid: 2 }, "tactic_failed; simp made no progress; ended by model"],
      ],
    );

    // Counterexamples, obstructions and conjectures with their evidence.
    assert.deepEqual(refuted?.counterexamples.map((r) => [r.id, r.claimId]), [[s.nodes.counter, s.claims.refuted]]);
    assert.match(refuted?.counterexamples[0]?.text ?? "", /the number 9 is odd and not prime.*Refutation submissions: 1/);
    assert.deepEqual(stuck?.obstructions.map((r) => r.id), [s.nodes.obstruction]);
    assert.match(stuck?.conjectures[0]?.text ?? "", /accumulation points are the roots of unity.*Evidence: 2 item\(s\), such as checked for n up to 10\^6/);

    // What runs next is the ready tasks only; the other open ones are said by status.
    assert.deepEqual(decomposed?.next.map((line) => line.match(/task (tsk_\w+)/)?.[1]), [s.tasks.ready]);
    assert.match(decomposed?.next[0] ?? "", /prove task tsk_\w+ \(ready\): certify part C/);
    assert.deepEqual(decomposed?.otherOpen, { pending: 1 });

    // The fleet's leading strategies, from its allocation nodes: the most sessions first.
    assert.deepEqual(decomposed?.fleet, [
      { strategy: "induction", sessions: 2, escalated: 1, successRate: 0.1 },
      { strategy: "automation", sessions: 1, escalated: 0, successRate: 0.25 },
    ]);

    // Kinds of record it has no section for are counted, not dropped: the lines' own records (fingerprints, identifications,
    // drift findings) are among them. The kinds it reads are not.
    assert.deepEqual(account.unknownKinds, { drift: 1, fingerprint: 2, identification: 1, mystery: 2, zebra: 1 });
  });

  it("is rendered with every id, the unknown kinds and the way to answer, and never claims more than the journal does", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    const text = renderAccount(buildAccount(events, 1));
    s.journal.close();
    for (const id of [s.claims.proved, s.claims.leaf, s.claims.computed, s.claims.refuted, s.validations.certified, s.nodes.counter, s.nodes.obstruction, s.nodes.conjecture, s.problems.decomposed]) {
      assert.ok(text.includes(id), `the account names ${id}`);
    }
    assert.match(text, /## Records this account does not detail\n\nThe journal holds records of kinds this account has no section for: 2 fingerprint, 2 mystery, 1 drift, 1 identification, 1 zebra\./);
    assert.match(text, /- Ready: prove task tsk_\w+ \(ready\): certify part C\n- Other tasks that are not over: 1 pending\./);
    assert.match(text, /- The fleet's leading strategies: `induction` \(2 sessions, 1 on the stronger model, success rate 0\.1\); `automation` \(1 session, success rate 0\.25\)\./);
    assert.match(text, /built from the journal alone, with no model call/);
    assert.match(text, /Lean is the judge: nothing here changes a claim's status/);
    assert.match(text, /### Open leaves and what was tried\n\n- `clm_\w+`: Part B/);
    assert.match(text, /Informal validators disagree about clm_\w+ \(nod_\w+\)/, "a disagreement is reported even when the turn ended otherwise");
    assert.match(text, /harness hint <runDir> --claim ID/);
    assert.doesNotMatch(text, /\bproved\b[^.\n]*Part B/, "the open leaf is never called proved");
  });

  it("is the same for the same journal, and does not read what came after its turn", () => {
    const s = scriptedJournal();
    const before = buildAccount(readEvents(join(s.dir, "journal.jsonl")), 1);
    // The team answers after the turn: the turn's account is unchanged.
    s.journal.emit(
      "node.recorded",
      { nodeId: "nod_late", kind: "hint", claimId: s.claims.leaf, data: { provenance: "human", by: "alice", text: "try strong induction", afterTurn: 1 } },
      "human:alice",
    );
    const after = buildAccount(readEvents(join(s.dir, "journal.jsonl")), 1);
    s.journal.close();
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(after), JSON.stringify(before));
  });

  it("is written as turns/N/report.md and report.json, with the model's narrative marked as model-written when there is one", () => {
    // The narrative is a blob the turn's end names; its ids are those of a journal of the same shape.
    const shape = scriptedJournal();
    const narrative = `Part A is proved [cite: ${shape.claims.proved}] and the open leaf [cite: ${shape.claims.leaf}] still resists.`;
    shape.journal.close();
    const run = scriptedJournal({ narrative });
    run.journal.close();
    const account = writeAccount(run.dir, 1);
    assert.ok(existsSync(join(run.dir, "turns", "1", "report.md")));
    const json = JSON.parse(readFileSync(join(run.dir, "turns", "1", "report.json"), "utf8")) as typeof account;
    assert.deepEqual(json, JSON.parse(JSON.stringify(account)));
    assert.equal(account.narrative?.modelWritten, true);
    assert.equal(account.narrative?.text, narrative);
    const md = readFileSync(join(run.dir, "turns", "1", "report.md"), "utf8");
    assert.match(md, /### Narrative \(written by a model, not part of the record\)/);
    assert.match(md, /> Part A is proved/);
    assert.throws(() => writeAccount(run.dir, 2), /no turn 2/);
  });
});

describe("the account (review round 1)", () => {
  const zero = { usd: 0, inputTokens: 0, outputTokens: 0 };

  it("says a problem whose candidate was certified at the end of the turn is proved, asks the team to read it, and does not count it among those that wait for a proof", () => {
    const s = scriptedJournal();
    const o = "orchestrator";
    s.journal.emit("turn.started", { runId: "run_scripted", turn: 2, limit: { tokens: 1 }, source: "a flag of the resumption", startSpend: zero }, o);
    // The limit was reached by a response that left a candidate: the run certified it before it exited (kernel replay), and the problem has no outcome yet.
    const fast = "val_cut_fast";
    const cert = "val_cut_cert";
    const validate = (validationId: string, method: "repl" | "kernel_replay") =>
      s.journal.emit("validation.finished", { validationId, claimId: s.claims.stuck, method, verdict: "valid", reasons: [], axioms: ["propext"], submissionHash: "h" }, method === "repl" ? "validator" : "certifier");
    validate(fast, "repl");
    s.journal.emit("claim.status_changed", { claimId: s.claims.stuck, from: "open", to: "computed", reason: "a proof passed the fast check", validationId: fast }, "validator");
    validate(cert, "kernel_replay");
    s.journal.emit("claim.status_changed", { claimId: s.claims.stuck, from: "computed", to: "proved", reason: "the candidate was certified", validationId: cert }, "validator");
    s.journal.emit("turn.ended", { runId: "run_scripted", turn: 2, reason: "tokens", detail: "a limit", spent: { turn: zero, run: zero }, minutes: 0, waiting: [s.problems.decomposed, s.problems.stuck] }, o);
    const account = buildAccount(readEvents(join(s.dir, "journal.jsonl")), 2);
    s.journal.close();
    const stuck = account.problems.find((x) => x.problemId === s.problems.stuck);
    assert.equal(stuck?.state, "proved", "the account says proved from the certification");
    assert.match(stuck?.claims[0]?.checkedBy ?? "", new RegExp(`kernel replay ${cert}`));
    assert.match(stuck?.reason ?? "", /closes when the run resumes/);
    assert.equal(account.summary.proved, 1);
    assert.match(account.summary.asked.join("\n"), new RegExp(`Problem ${s.problems.stuck} is settled \\(its claim was certified in this turn\\)`), "the settled problem is asked about although a limit ended the turn");
    assert.match(renderAccount(account), /Nothing to search: the claim is certified, and the next turn closes the problem\./);
    // Turn 1 did not have it.
    assert.equal(buildAccount(readEvents(join(s.dir, "journal.jsonl")), 1).problems.find((x) => x.problemId === s.problems.stuck)?.state, "waiting");
  });

  it("does not print Signed by for an actor that is not a person", () => {
    const s = scriptedJournal();
    s.journal.emit("edge.status_changed", { edgeId: s.edges.implies, from: "proposed", to: "human_signed", reason: "signed by carol" }, "human:carol");
    s.journal.emit("turn.started", { runId: "run_scripted", turn: 2, limit: {}, source: "x", startSpend: zero }, "orchestrator");
    s.journal.emit("turn.ended", { runId: "run_scripted", turn: 2, reason: "finished", detail: "d", spent: { turn: zero, run: zero }, minutes: 0, waiting: [] }, "orchestrator");
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    assert.match(renderAccount(buildAccount(events, 2)), /Signed by human:carol: edge/);
    // A journal that an older version wrote (the journal now refuses a signature from a line) is shown for what it is.
    const forged = events.map((e): HarnessEvent => (e.type === "edge.status_changed" ? { ...e, actor: "line:M2" } : e));
    const text = renderAccount(buildAccount(forged, 2));
    assert.doesNotMatch(text, /Signed by line:M2/);
    assert.match(text, /Marked human_signed by line:M2, which is not a person/);
  });

  it("counts what a run took from earlier journals, since their claims are not its own", () => {
    const config = { model: "m", prompt: { version: "x" }, bench: { hash: "h", source: { repo: "r", rev: "rev", lean: "lean4:v4" } }, consortium: { limit: { tokens: 5 }, impasse: { posteriorBelow: 0.1, minAttempts: 8 }, narrative: false } };
    const base = mkdtempSync(join(tmpdir(), "mh-acc-"));
    const earlier = Journal.open(join(base, "a"), "run_a");
    earlier.emit("run.started", { runId: "run_a", benchId: "b", problems: 1, host: "t", config }, "orchestrator");
    for (const id of ["clm_a1", "clm_a2"]) earlier.emit("claim.created", { claimId: id, statementId: `sid_${id}`, statement: `: P_${id}`, origin: "test", status: "open" }, "memory");
    earlier.emit("node.recorded", { nodeId: "nod_a", kind: "fingerprint", claimId: "clm_a1", data: { d: 1 } }, "line:M11");
    earlier.emit("node.recorded", { nodeId: "nod_hint_a", kind: "hint", claimId: "clm_a1", data: { provenance: "human", by: "old", text: "an old team's hint" } }, "human:old");
    earlier.close();
    const chain = loadMemoryChain(join(base, "a"), environmentOf(config));
    const dir = join(base, "b");
    const journal = Journal.open(dir, "run_b", { memory: chain });
    journal.emit("run.started", { runId: "run_b", benchId: "b", problems: 0, host: "t", config, memoryFrom: chain.from }, "orchestrator");
    journal.emit("turn.started", { runId: "run_b", turn: 1, limit: { tokens: 5 }, source: "the run's option", startSpend: zero }, "orchestrator");
    journal.emit("turn.ended", { runId: "run_b", turn: 1, reason: "finished", detail: "d", spent: { turn: zero, run: zero }, minutes: 0, waiting: [] }, "orchestrator");
    journal.close();
    const account = writeAccount(dir, 1);
    assert.equal(account.turn, 1);
    assert.deepEqual(account.inherited && !("unreadable" in account.inherited) ? [account.inherited.claims, account.inherited.nodes] : undefined, [2, 1], "two claims and one node (the old team's hint is not carried)");
    assert.equal(account.team.hints, 0, "the earlier team's hint is not this run's");
    const md = readFileSync(join(dir, "turns", "1", "report.md"), "utf8");
    assert.match(md, /## Memory carried over from earlier runs\n\nThe run started on the memory of earlier runs: 2 claims \(none with a status that carried\)/);
    assert.match(md, /this account covers this run's own journal/);
    // The directory of the earlier run is gone: the account says so and is still written.
    const moved = join(base, "a-moved");
    renameSync(join(base, "a"), moved);
    const again = writeAccount(dir, 1);
    assert.ok(again.inherited && "unreadable" in again.inherited);
  });
});

describe("the narrative of a turn", () => {
  const ending = (s: ReturnType<typeof scriptedJournal>) => ({ reason: "impasse", detail: "d", waiting: [s.problems.stuck] });

  it("accepts a narrative whose every id resolves, and keeps its text", async () => {
    const s = scriptedJournal();
    const kept: string[] = [];
    const asked: string[] = [];
    const answer = `Part A is proved [cite: ${s.claims.proved}], checked by [cite: ${s.validations.certified}]; part B is open [cite: ${s.claims.leaf}, ${s.problems.decomposed}].`;
    const result = await turnNarrative({
      journal: s.journal,
      turn: 1,
      ending: ending(s),
      call: async (request) => {
        asked.push(request.prompt);
        return { text: answer, modelCallId: "mc_1" };
      },
      keep: (text) => (kept.push(text), "hash1"),
    });
    s.journal.close();
    assert.deepEqual(result, { hash: "hash1" });
    assert.deepEqual(kept, [answer]);
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? "", /Turn 1 of run run_scripted/, "the model sees the account");
  });

  it("asks once more when an id does not resolve, then accepts the corrected narrative", async () => {
    const s = scriptedJournal();
    const prompts: string[] = [];
    const answers = [`Part A is proved [cite: clm_00000000000000000000000000].`, `Part A is proved [cite: ${s.claims.proved}].`];
    const result = await turnNarrative({
      journal: s.journal,
      turn: 1,
      ending: ending(s),
      call: async (request) => (prompts.push(request.prompt), { text: answers[prompts.length - 1] ?? "", modelCallId: "mc" }),
      keep: () => "h",
    });
    s.journal.close();
    assert.deepEqual(result, { hash: "h" });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /cited clm_00000000000000000000000000, which name nothing in this journal/);
  });

  it("refuses a narrative that cites ids that do not exist, or the literature, and records why", async () => {
    const s = scriptedJournal();
    let calls = 0;
    const result = await turnNarrative({
      journal: s.journal,
      turn: 1,
      ending: ending(s),
      call: async () => ((calls += 1), { text: "By the well known result of Hardy [cite: arXiv:1234.5678] and [cite: nod_0000000000000000000000000X] this is settled.", modelCallId: "mc" }),
      keep: () => assert.fail("nothing is kept"),
    });
    s.journal.close();
    assert.equal(calls, 2);
    assert.equal(result.hash, undefined);
    assert.match(result.rejected ?? "", /cited .*arXiv:1234\.5678.*resolve to nothing in the journal/);
  });

  it("checks ids against the journal: markers, bare ids, literature and empty markers", () => {
    const s = scriptedJournal();
    const p = s.journal.projection;
    assert.deepEqual(unresolvedInNarrative(p, `Fine [cite: ${s.claims.proved}] and ${s.nodes.counter} and ${s.problems.refuted}.`), []);
    assert.deepEqual(unresolvedInNarrative(p, `Bad [cite: clm_NOPE] and [cite: ] and a bare clm_0000000000000000000000000Z and doi:10.1000/xyz.`).length, 4);
    s.journal.close();
  });
});
