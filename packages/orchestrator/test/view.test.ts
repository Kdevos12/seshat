import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, type HarnessEvent, Journal, readEvents } from "@seshat/core";
import { buildView, esc, writeView } from "../src/index.ts";
import { certifier } from "./resume-helpers.ts";
import { certifyingRegistry, check, demoRun, killedAt } from "./m0-helpers.ts";
import { scriptedJournal } from "./scripted-journal.ts";

const HOSTILE = `<script>alert("x")</script><img src=x onerror=alert(1)> & "quoted" 'single'`;

/** What a page that reads only the journal must not contain: a script, a link, an address, a handler. */
function assertStatic(html: string): void {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<iframe|<object|<embed|<form|<base\b/i);
  // Every `<` of a text is escaped, so a `<` that is followed by an attribute is a real tag.
  assert.doesNotMatch(html, /<[^>]*\son\w+\s*=/i, "no event handler attribute in a tag");
  assert.doesNotMatch(html, /https?:\/\//i, "no address at all");
  assert.doesNotMatch(html, /<[^>]*\s(src|href|action|formaction|xlink:href)\s*=/i, "no tag fetches anything");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
}

describe("harness view", () => {
  it("escapes every piece of text that came from the journal", () => {
    assert.equal(esc(HOSTILE), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot; &#39;single&#39;');
    const s = scriptedJournal();
    // A hostile statement, a hostile target and a hostile note, as a model or a person could have written them.
    s.journal.emit("claim.created", { claimId: "clm_hostile", statementId: "sid_h", statement: HOSTILE, origin: "test", status: "open", kind: "informal" }, "memory");
    s.journal.emit("node.recorded", { nodeId: "nod_hostile", kind: "conjecture", claimId: "clm_hostile", data: { statement: HOSTILE, evidence: [HOSTILE] } }, "line:M4");
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    const html = buildView(events, new BlobStore(join(s.dir, "blobs")));
    assertStatic(html);
    assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)"), "the hostile text is shown, escaped");
    assert.ok(!html.includes(HOSTILE));
  });

  it("is built from a recorded journal: the graph, the statuses, the turn's account, the spend and the proofs", () => {
    const s = scriptedJournal();
    const events = readEvents(join(s.dir, "journal.jsonl"));
    s.journal.close();
    const blobs = new BlobStore(join(s.dir, "blobs"));
    const html = buildView(events, blobs, {});
    assertStatic(html);
    // The graph: one box per claim, with the status of the journal, in a status class.
    assert.equal((html.match(/<g class="node /g) ?? []).length, 6);
    assert.match(html, new RegExp(`<g class="node s-proved"[^>]*><title>${s.claims.proved}: proved\\.`));
    assert.match(html, new RegExp(`<g class="node s-refuted"[^>]*><title>${s.claims.refuted}: refuted\\.`));
    assert.match(html, new RegExp(`<g class="node s-computed"[^>]*><title>${s.claims.computed}: computed\\.`));
    assert.match(html, /<path class="edge e-proposed"/);
    // The turn: its reason, its detail and the problems' states.
    assert.match(html, /Turn 1: ended at impasse/);
    assert.match(html, /every open task of goldbach is blocked/);
    // Spend per site.
    assert.match(html, /<code>prover\.session<\/code>/);
    // Candidates and evidence are marked as what they are.
    assert.match(html, /Candidates: passed the fast check, not certified/);
    assert.match(html, /Evidence, not proof/);
    assert.match(html, /No certifier ran/);
    // A claim's status is only the journal's: no box says proved for a claim the journal holds open.
    for (const open of [s.claims.root, s.claims.leaf, s.claims.stuck]) assert.doesNotMatch(html, new RegExp(`${open}: proved`));
    assert.equal(buildView(events, blobs, {}), html, "the same journal, the same page");
  });

  it("is rebuilt for a real run and a run cut in the middle, and warns when the chain is broken", async () => {
    const c = certifier();
    const run = await demoRun({ registry: certifyingRegistry(c.certifier), certifier: c.certifier, responses: [check("exact trivial_proof")] });
    const file = writeView(run.dir);
    assert.equal(file, join(run.dir, "view.html"));
    const html = readFileSync(file, "utf8");
    assertStatic(html);
    assert.match(html, /certified<\/span>/);
    assert.match(html, /exact trivial_proof/, "the proof is on the page");
    assert.match(html, /Nothing to resume: the run is finished/);

    const cut = killedAt(run.dir, (e) => e.type === "validation.finished" && e.data.method === "kernel_replay");
    const cutHtml = readFileSync(writeView(cut), "utf8");
    assertStatic(cutHtml);
    assert.doesNotMatch(cutHtml, /<span class="pill s-proved">certified/, "before the certification there is no certified proof");
    assert.match(cutHtml, /No end in the journal/);

    const events: HarnessEvent[] = readEvents(join(run.dir, "journal.jsonl"));
    const broken = events.map((e, i) => (i === 2 ? ({ ...e, ts: "2001-01-01T00:00:00.000Z" } as HarnessEvent) : e));
    assert.match(buildView(broken, new BlobStore(join(run.dir, "blobs"))), /class="banner">The journal&#39;s hash chain|class="banner">The journal's hash chain/);
  });

  it("reads and writes nothing in the run but its own file", async () => {
    const run = await demoRun({ responses: [check("bad")] });
    const before = readFileSync(join(run.dir, "journal.jsonl"), "utf8");
    writeView(run.dir, join(run.dir, "elsewhere.html"));
    assert.ok(existsSync(join(run.dir, "elsewhere.html")));
    assert.equal(readFileSync(join(run.dir, "journal.jsonl"), "utf8"), before);
    assert.ok(!existsSync(join(run.dir, "view.html")));
    void Journal;
  });
});
