import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { BlobStore, Journal, loadMemoryChain, readEvents } from "@seshat/core";
import { allLessons, stagedLessons } from "@seshat/lessons";
import { MemoryStore } from "@seshat/memory";
import { consolidate, chainProblems, newestPage, modelFreePart, PAGE_KIND } from "../src/consolidate.ts";
import { injectedPart, listEvents, parsePage, PAGE_INJECT_CHARS, PAGE_STORED_CHARS } from "../src/consolidation-page.ts";
import { RunSetupError } from "../src/index.ts";
import { certifier } from "./resume-helpers.ts";
import { check, demoBench, demoRun, fauxModels, say, tempDir } from "./m0-helpers.ts";

const sha = (dir: string): string => createHash("sha256").update(readFileSync(join(dir, "journal.jsonl"))).digest("hex");

/** An earlier run: the first problem fails twice (open, with attempts), the second is proved. */
async function earlier() {
  const shared = demoBench();
  const bench = { checkout: shared.checkout, index: { ...shared.index, source: { ...shared.index.source, rev: "rev-a", lean: "leanprover/lean4:v4.20.0" } } };
  const run = await demoRun({
    bench,
    problems: 2,
    certifier: certifier().certifier,
    config: { sessions: 2 },
    responses: [check("bad"), say("n1"), check("bad"), say("n2"), check("exact trivial_proof")],
  });
  return run;
}

function ids(dir: string, claimOnly = true): string[] {
  const chain = loadMemoryChain(dir, undefined);
  const open = chainProblems(chain.segments.flatMap((s) => s.events)).find((p) => p.problemId !== undefined && listEvents(chain.segments, p.claimId).length > 0 && claimOnly);
  return open === undefined ? [] : listEvents(chain.segments, open.claimId).map((l) => l.id);
}

function pageAnswer(...lines: string[]): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxText(lines.join("\n"))]);
}

describe("the consolidation pass", () => {
  it("makes no model call without --model, writes cards for open problems only, and leaves the earlier journal as it was", async () => {
    const a = await earlier();
    const before = sha(a.dir);
    const out = join(tempDir(), "c");
    const r = await consolidate({ from: a.dir, out });
    assert.equal(sha(a.dir), before, "the earlier journal's bytes are unchanged");
    assert.equal(r.cards, 1, "the proved problem has no card");
    assert.equal(r.calls, 0);
    const events = readEvents(join(out, "journal.jsonl"));
    assert.equal(events[0]?.type, "run.started");
    assert.ok(events.every((e) => e.type !== "model_call.finished"));
    const card = events.find((e) => e.type === "node.recorded" && e.data.kind === "consolidation_card");
    assert.ok(card?.type === "node.recorded" && card.data.provenance !== undefined, "a card is stamped");
    assert.equal(card?.actor, "consolidation");
    assert.match(readFileSync(join(out, "consolidation.md"), "utf8"), /State of the problem/);
    // a run again on a finished pass writes nothing
    const again = await consolidate({ from: a.dir, out });
    assert.equal(again.alreadyDone, true);
    assert.equal(readEvents(join(out, "journal.jsonl")).length, events.length);
  });

  it("refuses a consolidation node from another actor", async () => {
    const a = await earlier();
    const out = join(tempDir(), "c");
    await consolidate({ from: a.dir, out });
    const journal = Journal.open(out, readEvents(join(out, "journal.jsonl"))[0]?.type === "run.started" ? (readEvents(join(out, "journal.jsonl"))[0] as { data: { runId: string } }).data.runId : "x");
    try {
      const store = new MemoryStore({ journal, blobs: new BlobStore(join(out, "blobs")) }).withActor("line:M5");
      assert.throws(() => store.recordNode({ kind: "consolidation_page", data: {} }), /consolidation pass alone/);
    } finally {
      journal.close();
    }
  });

  it("calls the model once per open problem, keeps cited sentences and drops the others, and a page is read through the chain", async () => {
    const a = await earlier();
    const eids = ids(a.dir);
    assert.ok(eids.length >= 2);
    const [x, y] = eids as [string, string];
    const { models, faux, name } = fauxModels();
    faux.setResponses([
      pageAnswer(
        `Two attempts failed [${x}, ${y}].`,
        "This one cites nothing.",
        "This one cites an event that does not exist [e99999].",
        `One cited event is real and one is not [${x}, e99998].`,
        `A third kept sentence [${y}].`,
      ),
    ]);
    const out = join(tempDir(), "c");
    const r = await consolidate({ from: a.dir, out, model: name, maxUsd: 5, models });
    assert.equal(faux.state.callCount, 1);
    assert.equal(r.pages, 1);
    const journal = Journal.open(out, (readEvents(join(out, "journal.jsonl"))[0] as { data: { runId: string } }).data.runId);
    try {
      const store = new MemoryStore({ journal, blobs: new BlobStore(join(out, "blobs"), journal.chain?.blobDirs ?? []) });
      const claim = chainProblems(loadMemoryChain(a.dir, undefined).segments.flatMap((s) => s.events)).find((p) => store.attempts(p.claimId).length > 0 && store.claim(p.claimId)?.status !== "proved")!.claimId;
      const page = newestPage(store, claim);
      assert.deepEqual(page?.sentences.map((s) => s.text), ["Two attempts failed.", "A third kept sentence."]);
      const node = store.nodes(PAGE_KIND, { claimId: claim }).at(-1);
      assert.deepEqual((node?.data as { dropped: unknown }).dropped, { total: 3, uncited: 1, unknownEvent: 2, screened: 0, size: 0 });
      assert.ok(node?.provenance !== undefined, "the page is stamped");
    } finally {
      journal.close();
    }
    // a later run on the consolidation run reads the page through the chain
    const chain = loadMemoryChain(out, undefined);
    assert.equal(chain.segments.length, 2);
    const j2 = Journal.open(join(tempDir(), "next"), "run_next", { memory: chain });
    try {
      const store = new MemoryStore({ journal: j2, blobs: new BlobStore(join(tempDir(), "b")) });
      assert.equal(store.nodes(PAGE_KIND).length, 1);
    } finally {
      j2.close();
    }
  });

  it("does not put a literature quote in the model's input", async () => {
    const a = await earlier();
    const chain = loadMemoryChain(a.dir, undefined);
    const claim = chainProblems(chain.segments.flatMap((s) => s.events))[0]!.claimId;
    const journal = Journal.open(a.dir, chain.segments.at(-1)!.runId);
    const store = new MemoryStore({ journal, blobs: new BlobStore(join(a.dir, "blobs")) });
    store.recordNode({ kind: "literature", claimId: claim, data: { quote: "SECRET QUOTE FROM A PAPER", title: "SECRET TITLE", verdict: "restricts", url: "http://x" } });
    journal.close();
    const { models, faux, name } = fauxModels();
    faux.setResponses([pageAnswer("No usable sentence.")]);
    const out = join(tempDir(), "c");
    await consolidate({ from: a.dir, out, model: name, maxUsd: 5, models });
    const events = readEvents(join(out, "journal.jsonl"));
    const call = events.find((e) => e.type === "model_call.finished");
    assert.ok(call?.type === "model_call.finished");
    const blobs = new BlobStore(join(out, "blobs"), [join(a.dir, "blobs")]);
    const request = JSON.stringify(blobs.get(call.data.requestHash) ?? "");
    assert.doesNotMatch(request, /SECRET/);
    assert.match(request, /evidence literature verdict restricts/);
  });

  it("stops before a call the cap would not cover, and a cut pass run again pays nothing twice", async () => {
    const a = await earlier();
    const { models, faux, name } = fauxModels();
    faux.setResponses([pageAnswer("Nothing to say.")]);
    const out = join(tempDir(), "c");
    const r = await consolidate({ from: a.dir, out, model: name, maxUsd: 0.0000001, models });
    assert.equal(faux.state.callCount, 0);
    assert.equal(r.skippedForBudget, 1);
    // run again with room: the problem skipped for budget is done now; then again: nothing more
    const rerun = await consolidate({ from: a.dir, out, model: name, maxUsd: 5, models });
    assert.equal(faux.state.callCount, 1);
    assert.equal(rerun.pages, 0, "the answer cited nothing, so no page");
    assert.equal(rerun.skippedForBudget, 0);
    await consolidate({ from: a.dir, out, model: name, maxUsd: 5, models });
    assert.equal(faux.state.callCount, 1, "nothing is paid twice");
  });

  it("merges duplicate lessons and flags unsupported ones, which no session is shown until a person approves", async () => {
    const a = await earlier();
    const chain = loadMemoryChain(a.dir, undefined);
    const claim = chainProblems(chain.segments.flatMap((s) => s.events))[0]!.claimId;
    const journal = Journal.open(a.dir, chain.segments.at(-1)!.runId);
    const store = new MemoryStore({ journal, blobs: new BlobStore(join(a.dir, "blobs")), provenance: { modelId: "p/m", promptVersion: "m0-1", mathlibRev: "r", harnessVersion: "t", budgetClass: "small" } }).withActor("line:M5");
    const attemptId = store.attempts(claim)[0]!.attemptId;
    const base = { type: "strategy", scope: "global", scopeKey: "", origin: "outcome", claims: [claim], domains: [], useful: 1, harmful: 0, active: true };
    store.recordNode({ kind: "lesson", learned: true, data: { ...base, text: "Try induction early.", key: "k1", support: [attemptId] } });
    store.recordNode({ kind: "lesson", learned: true, data: { ...base, text: "try  induction early", key: "k2", support: [attemptId, "att_missing"] } });
    store.recordNode({ kind: "lesson", learned: true, data: { ...base, type: "constraint", text: "Check the bounds.", key: "k3", support: ["att_gone"] } });
    journal.close();
    const out = join(tempDir(), "c");
    const r = await consolidate({ from: a.dir, out });
    assert.equal(r.merged, 1);
    assert.equal(r.flagged, 1);
    const j = Journal.open(out, (readEvents(join(out, "journal.jsonl"))[0] as { data: { runId: string } }).data.runId);
    try {
      const s = new MemoryStore({ journal: j, blobs: new BlobStore(join(out, "blobs")) });
      const lessons = allLessons(s);
      const byText = (t: string) => lessons.filter((l) => l.text === t);
      assert.deepEqual(byText("Try induction early.").map((l) => [l.state, l.useful]), [["active", 2]]);
      assert.equal(byText("try  induction early")[0]?.state, "deactivated");
      assert.equal(byText("Check the bounds.")[0]?.state, "pending");
      assert.deepEqual(stagedLessons(s).map((l) => l.text), ["Check the bounds."]);
    } finally {
      j.close();
    }
  });

  it("refuses an output directory that holds another run", async () => {
    const a = await earlier();
    const b = await earlier();
    const out = join(tempDir(), "c");
    await consolidate({ from: a.dir, out });
    await assert.rejects(consolidate({ from: b.dir, out }), RunSetupError);
  });

  it("models the free part without writing", async () => {
    const a = await earlier();
    const chain = loadMemoryChain(a.dir, "bench:rev-a|lean:leanprover/lean4:v4.20.0");
    const j = Journal.open(join(tempDir(), "x"), "run_x", { memory: chain });
    try {
      const store = new MemoryStore({ journal: j, blobs: new BlobStore(join(tempDir(), "b")) });
      const part = modelFreePart(store, chainProblems(chain.segments.flatMap((s) => s.events)));
      assert.equal(part.cards.length, 1);
      assert.equal(part.left.length, 1);
      assert.ok((part.cards[0]?.data.approaches.length ?? 0) > 0, "the attempts of the earlier run are in the card");
    } finally {
      j.close();
    }
  });
});

describe("the page's sentence rule", () => {
  const allowed = new Set(["e1", "e2"]);
  it("drops a sentence with no citation, an unknown event and a mix", () => {
    const { kept, dropped } = parsePage("Plain. Good one [e1]. Bad id [e7]. Half good [e1, e9]. Two ok [e1, e2].", allowed);
    assert.deepEqual(kept.map((k) => k.text), ["Good one.", "Two ok."]);
    assert.deepEqual([dropped.uncited, dropped.unknownEvent], [1, 2]);
  });
  it("cuts the injected part at a sentence end and caps the stored page", () => {
    const sentence = (i: number) => ({ text: `Sentence number ${i} says a fairly ordinary thing about the attempts.`, cites: ["e1"] });
    const many = Array.from({ length: 60 }, (_, i) => sentence(i));
    const part = injectedPart(many);
    assert.ok(part.length <= PAGE_INJECT_CHARS && part.endsWith("."));
    assert.ok(!part.includes("["));
    const long = many.map((s) => `${s.text.replace(/\.$/, "")} [e1].`).join("\n");
    const parsed = parsePage(long, allowed);
    assert.ok(parsed.kept.map((k) => k.text).join(" ").length <= PAGE_STORED_CHARS);
    assert.ok(parsed.dropped.size > 0);
  });
});
