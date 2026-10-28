import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEvents } from "@seshat/core";
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

    // What runs next.
    assert.match(decomposed?.next[0] ?? "", /prove task tsk_\w+ \(pending\): prove part B/);

    // Kinds of record it does not read are counted, not dropped.
    assert.deepEqual(account.unknownKinds, { mystery: 2, zebra: 1 });
  });

  it("is rendered with every id, the unknown kinds and the way to answer, and never claims more than the journal does", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    const text = renderAccount(buildAccount(events, 1));
    s.journal.close();
    for (const id of [s.claims.proved, s.claims.leaf, s.claims.computed, s.claims.refuted, s.validations.certified, s.nodes.counter, s.nodes.obstruction, s.nodes.conjecture, s.problems.decomposed]) {
      assert.ok(text.includes(id), `the account names ${id}`);
    }
    assert.match(text, /## Records this account does not read\n\nThe journal holds records of kinds this account has no section for: 2 mystery, 1 zebra\./);
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
