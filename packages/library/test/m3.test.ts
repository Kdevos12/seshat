import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";
import { LINES } from "../../orchestrator/src/lines.ts";
import { call, check, DemoLean, demoAnswer, demoBench, demoRun, ofType, say } from "../../orchestrator/test/m0-helpers.ts";
import { certifier } from "../../orchestrator/test/resume-helpers.ts";
import { libraryExportCommand } from "../../orchestrator/src/library-command.ts";
import { renderRunReport, writeReport } from "../../orchestrator/src/index.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allLemmas, candidates, createM3, libraryReport, M3, M3_OPTIONS, SECTION_ITEM, usableLemmas } from "../src/index.ts";

// The simulated model's types, as the orchestrator's test helper gives them (this package does not depend on the model library).
type Step = Parameters<typeof demoRun>[0]["responses"][number];
type TranscriptContext = Parameters<Extract<Step, (...args: never[]) => unknown>>[0];

/** The first user message of a session. */
function opening(context: TranscriptContext): string {
  const message = context.messages.find((m) => m.role === "user");
  const content = message?.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

/** The text of the last tool result of a session's transcript. */
function lastToolResult(context: TranscriptContext): string {
  const results = context.messages.filter((m) => m.role === "toolResult");
  const content = results.at(-1)?.content as Array<{ type: string; text?: string }> | undefined;
  return (content ?? []).map((c) => c.text ?? "").join("");
}

const ADD = "theorem aux_two_mul (n : ℕ) : 2 * n = n + n := by\n  exact trivial_proof";
const REFL = "theorem aux_refl (n : ℕ) : n = n := by\n  exact trivial_proof";
const LOCAL = "theorem aux_local (n : ℕ) : n + 1 = Demo.step n := by\n  bad";

/**
 * The simulated Lean: the triviality probes (files named `seshat_triviality`) are closed only for `n = n`; the other files
 * are the demo's, which accepts `exact trivial_proof` and rejects the rest.
 */
function lean(): DemoLean {
  const answer = (code: string): FakeLeanAnswer => {
    if (!code.includes("theorem seshat_triviality")) return demoAnswer(code);
    return code.includes("(n : ℕ) : n = n :=") ? {} : { messages: [{ severity: "error", pos: { line: 3, column: 0 }, text: "unsolved goals" }] };
  };
  return new DemoLean(answer);
}

const aux = [ADD, REFL, LOCAL].join("\n\n");

describe("the line M3 in a run", () => {
  it("is registered, with its options and a stateless resume", () => {
    assert.equal(LINES.M3, M3);
    assert.equal(M3.resume, "stateless");
    assert.deepEqual(M3.requires, []);
    assert.deepEqual(M3.options, M3_OPTIONS);
  });

  it("promotes the non-trivial lemma that stands alone, and says why it left the others out", { timeout: 30000 }, async () => {
    const { events, result } = await demoRun({
      lines: { M3 },
      lean: lean(),
      certifier: certifier().certifier,
      config: { lines: ["M3"], sessions: 1 },
      responses: [check("exact trivial_proof", aux)],
    });
    assert.equal(result.problems[0]?.outcome, "proved");
    const recorded = ofType(events, "node.recorded").filter((e) => e.data.kind.startsWith("library_"));
    const kinds = recorded.map((e) => e.data.kind);
    assert.deepEqual(kinds, ["library_candidate", "library_candidate", "library_candidate", "library_lemma"]);
    const lemma = recorded.find((e) => e.data.kind === "library_lemma")?.data.data as { name: string; claimId: string; statement: string; proof: string; domain: string; source: { name: string } };
    assert.match(lemma.name, /^aux_lib_two_mul_[0-9a-f]{6}$/);
    assert.deepEqual([lemma.statement, lemma.proof, lemma.domain, lemma.source.name], ["(n : ℕ) : 2 * n = n + n", "exact trivial_proof", "msc:11", "aux_two_mul"]);

    // The lemma is a claim of its own, stated under the imports alone, proved by the validator and certified: Lean decides.
    const claim = ofType(events, "claim.created").find((e) => e.data.claimId === lemma.claimId)?.data;
    assert.equal(claim?.origin, "line:M3");
    assert.equal(claim?.header, "import FormalConjectures.Util.ProblemImports");
    const changes = ofType(events, "claim.status_changed").filter((e) => e.data.claimId === lemma.claimId);
    assert.deepEqual(changes.map((e) => e.data.to), ["computed", "proved"]);

    // What came of each candidate is on its node.
    const final = new Map<string, { name: string; status: string; reason?: string }>();
    for (const e of ofType(events, "node.recorded")) if (e.data.kind === "library_candidate") final.set(e.data.nodeId, e.data.data as never);
    for (const e of ofType(events, "node.updated")) {
      const node = final.get(e.data.nodeId);
      if (node !== undefined) Object.assign(node, e.data.patch);
    }
    const byName = Object.fromEntries([...final.values()].map((c) => [c.name, c]));
    assert.equal(byName.aux_two_mul?.status, "promoted");
    assert.equal(byName.aux_refl?.status, "trivial");
    assert.match(byName.aux_refl?.reason ?? "", /closed by rfl/);
    assert.equal(byName.aux_local?.status, "unproved");
    assert.match(byName.aux_local?.reason ?? "", /not accepted/);

    // The lean.check calls of the triviality probes are tool runs of the line.
    const probes = ofType(events, "tool_run.started").filter((e) => e.actor === "line:M3" && e.data.capability === "lean.check");
    assert.equal(probes.length, 5, "a probe call for each of the three candidates, and the check of the two lemmas that were not trivial");
    const report = libraryReport(events);
    assert.deepEqual(report?.candidates, { pending: 0, promoted: 1, duplicate: 0, trivial: 1, unproved: 1 });
    assert.deepEqual(report?.lemmas, { total: 1, byDomain: { "msc:11": 1 } });
  });

  it("promotes a lemma once: the same statement from a second problem is a duplicate", { timeout: 30000 }, async () => {
    const { events } = await demoRun({
      lines: { M3 },
      lean: lean(),
      problems: 2,
      config: { lines: ["M3"], sessions: 1 },
      responses: [check("exact trivial_proof", ADD), check("exact trivial_proof", ADD)],
    });
    assert.equal(ofType(events, "node.recorded").filter((e) => e.data.kind === "library_lemma").length, 1);
    const statuses = ofType(events, "node.updated").map((e) => (e.data.patch as { status?: string }).status);
    assert.deepEqual(statuses, ["promoted", "duplicate"]);
    assert.equal(ofType(events, "claim.created").filter((e) => e.data.origin === "line:M3").length, 1);
  });

  it("offers the library to the next problem: a briefing section, a search tool, and the share of proofs that use it", { timeout: 60000 }, async () => {
    const prompts: string[] = [];
    let tool = "";
    let name = "";
    const { events, dir } = await demoRun({
      lines: { M3 },
      lean: lean(),
      problems: 2,
      certifier: certifier().certifier,
      // Many sessions, so that the draw shows the section at least once (it shows a new item about half the time).
      config: { lines: ["M3"], sessions: 6, seed: "library-1" },
      responses: [
        check("exact trivial_proof", ADD),
        ...Array.from({ length: 6 }, () => [
          (context: TranscriptContext) => {
            prompts.push(opening(context));
            return call("library_search", { query: "doubling two mul" });
          },
          (context: TranscriptContext) => {
            tool = lastToolResult(context);
            name = /aux_lib_two_mul_[0-9a-f]{6}/.exec(tool)?.[0] ?? "";
            return check(`have := ${name} 3\n  exact trivial_proof`, `theorem ${name} (n : ℕ) : 2 * n = n + n := by\n  exact trivial_proof\n`);
          },
          say("done"),
        ]).flat(),
      ],
    });
    // The second problem's tool answer has the lemma, with its source and the text to paste.
    assert.match(tool, /^1\. \[library\] aux_lib_two_mul_[0-9a-f]{6} \(n : ℕ\) : 2 \* n = n \+ n/);
    assert.match(tool, /Paste into the auxiliary region, then use it by name:\n   theorem aux_lib_two_mul_[0-9a-f]{6} \(n : ℕ\) : 2 \* n = n \+ n := by\n     exact trivial_proof/);

    // The section is drawn, and shown exactly when the draw included it.
    const started = ofType(events, "attempt.started").filter((e) => e.data.included !== undefined || e.data.withheld !== undefined);
    assert.ok(started.length >= 1);
    assert.ok(started.every((e) => [...(e.data.included ?? []), ...(e.data.withheld ?? [])].includes(SECTION_ITEM)));
    const shown = started.filter((e) => e.data.included?.includes(SECTION_ITEM));
    assert.equal(prompts.filter((p) => /# Library\n/.test(p)).length, shown.length);
    assert.ok(shown.length >= 1 && prompts.length >= 1);
    const section = prompts.find((p) => /# Library\n/.test(p)) ?? "";
    assert.match(section, /Declarations that may help, searched in this order: this file, the harness library, other packages, Mathlib\./);
    assert.match(section, /\[library\] aux_lib_two_mul_[0-9a-f]{6}/);

    // The accepted proof of the second problem used a library lemma, and the report says so.
    const report = libraryReport(events);
    assert.equal(report?.proofs.total, 2);
    assert.equal(report?.proofs.withLibrary, 1);
    assert.deepEqual(report?.bySource, { library: 1 });
    assert.ok(dir.length > 0);
  });

  it("leaves the library out of the prompt when the section has no lemma to show", { timeout: 30000 }, async () => {
    const prompts: string[] = [];
    const { events } = await demoRun({
      lines: { M3 },
      lean: lean(),
      config: { lines: ["M3"], sessions: 1, lineOptions: { M3: { tool: false, briefingLemmas: 0 } } },
      responses: [(context: TranscriptContext) => (prompts.push(opening(context)), check("exact trivial_proof"))],
    });
    assert.doesNotMatch(prompts[0] ?? "", /Library/);
    assert.equal(ofType(events, "attempt.started")[0]?.data.included, undefined, "nothing to show, nothing drawn");
  });

  it("does not offer a lemma whose claim another Lean environment reset", { timeout: 60000 }, async () => {
    const shared = demoBench();
    const bench = (rev: string) => ({ checkout: shared.checkout, index: { ...shared.index, source: { ...shared.index.source, rev, lean: "leanprover/lean4:v4.20.0" } } });
    const first = await demoRun({ lines: { M3 }, lean: lean(), bench: bench("rev-a"), certifier: certifier().certifier, config: { lines: ["M3"], sessions: 1 }, responses: [check("exact trivial_proof", ADD)] });
    assert.equal(libraryReport(first.events)?.lemmas.total, 1);
    // The next run starts on the memory of the first, under another bench revision: the lemma's claim is open again.
    const seen: Array<{ held: number; status: string | undefined; usable: number; candidates: number }> = [];
    const probe = {
      ...M3,
      hooks: {
        ...M3.hooks,
        beforeProvers: async (p: Parameters<NonNullable<typeof M3.hooks.beforeProvers>>[0]) => {
          const held = allLemmas(p.memory);
          seen.push({ held: held.length, status: held[0]?.claimStatus, usable: usableLemmas(p.memory).length, candidates: candidates(p.memory).length });
        },
      },
    };
    await demoRun({ lines: { M3: probe }, lean: lean(), bench: bench("rev-b"), memoryFrom: first.dir, config: { lines: ["M3"], sessions: 1 }, responses: [check("exact trivial_proof")] });
    assert.deepEqual(seen, [{ held: 1, status: "open", usable: 0, candidates: 1 }], "the node is carried, its claim is open again, so it is not offered");
  });

  it("can be built with another non-triviality test, as Task 6's battery will be", { timeout: 30000 }, async () => {
    const asked: string[] = [];
    const strict = createM3({ isTrivial: async (q) => (asked.push(q.statement), { trivial: true, by: "the battery" }) });
    const { events } = await demoRun({ lines: { M3: strict }, lean: lean(), config: { lines: ["M3"], sessions: 1 }, responses: [check("exact trivial_proof", ADD)] });
    assert.deepEqual(asked, ["(n : ℕ) : 2 * n = n + n"]);
    assert.equal(ofType(events, "node.recorded").filter((e) => e.data.kind === "library_lemma").length, 0);
    assert.equal(libraryReport(events)?.candidates.trivial, 1);
  });

  it("writes the library as Lean files and puts its measures in the run's report", { timeout: 30000 }, async () => {
    const { dir } = await demoRun({ lines: { M3 }, lean: lean(), certifier: certifier().certifier, config: { lines: ["M3"], sessions: 1 }, responses: [check("exact trivial_proof", aux)] });
    const out = mkdtempSync(join(tmpdir(), "mh-lean-"));
    const said: string[] = [];
    const written = libraryExportCommand(dir, { out, print: (line) => said.push(line) });
    assert.deepEqual(written, [join(out, "SeshatLib", "Msc11.lean")]);
    const text = readFileSync(written[0] as string, "utf8");
    assert.match(text, /namespace SeshatLib\.Msc11\n/);
    assert.match(text, /theorem aux_lib_two_mul_[0-9a-f]{6} \(n : ℕ\) : 2 \* n = n \+ n := by\n {2}exact trivial_proof/);
    assert.doesNotMatch(text, /aux_refl|aux_local/);
    assert.match(said.at(-1) ?? "", /have not been compiled by Lean here/);

    const report = writeReport(dir);
    assert.deepEqual(report.library?.lemmas, { total: 1, byDomain: { "msc:11": 1 } });
    assert.match(renderRunReport(report), /Library: 1 lemma\(s\) \(msc:11 1\); candidates: 1 promoted, 0 duplicate, 1 trivial, 1 not proved alone, 0 pending\. 0 of 1 accepted proof\(s\) \(0%\) use a library lemma\./);
  });
});
