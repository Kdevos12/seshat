import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Line } from "@seshat/lines";
import { LINES } from "../../orchestrator/src/lines.ts";
import { call, check, demoRun, ofType, say } from "../../orchestrator/test/m0-helpers.ts";
import { certifier } from "../../orchestrator/test/resume-helpers.ts";
import { createM4, KNN_ITEM, LIBRARY_ITEM, M4, M4_OPTIONS, PACKET_KIND, type PacketRecord } from "../src/index.ts";

type Step = Parameters<typeof demoRun>[0]["responses"][number];
type Context = Parameters<Extract<Step, (...args: never[]) => unknown>>[0];

/** The texts of the user message of a request: two (prefix, tail) for a frozen packet, one for a string. */
function texts(context: Context): string[] {
  const users = context.messages.filter((m) => m.role === "user");
  assert.equal(users.length, 1, "a packet leaves one user message");
  const content = (users[0] as { content: string | Array<{ type: string; text?: string }> }).content;
  return typeof content === "string" ? [content] : content.map((c) => c.text ?? "");
}


const FILE = `import FormalConjectures.Util.ProblemImports

namespace Demo

/-- Adding zero changes nothing. -/
@[category research solved, AMS 11]
theorem add_zero' (n : ℕ) : n + 0 = n := by
  sorry

/-- Doubling is adding. -/
@[category research solved, AMS 11]
theorem two_mul' (n : ℕ) : 2 * n = n + n := by
  sorry

end Demo
`;

/** A run of one problem where M4 alone is on, with a model that asks for `proofs` in turn. */
async function packets(proofs: string[], lineOptions: Record<string, unknown> = {}, line: Line = M4) {
  const seen: Context[] = [];
  const steps: Step[] = proofs.map((proof) => (context: Context) => (seen.push(context), check(proof)));
  const done = await demoRun({ lines: { M4: line }, config: { lines: ["M4"], lineOptions: { M4: { extractQueries: false, ...lineOptions } } }, responses: steps });
  return { ...done, seen };
}

describe("the line M4", () => {
  it("is registered, stateless, with its options, and needs no other line", () => {
    assert.equal(LINES.M4, M4);
    assert.equal(M4.resume, "stateless");
    assert.deepEqual(M4.options, M4_OPTIONS);
    assert.deepEqual(M4.requires, []);
  });

  it("gives the second request the packet in place of the history: the frozen prefix, then a tail that changed", { timeout: 60000 }, async () => {
    const { seen, result } = await packets(["bad", "sorry", "exact trivial_proof"]);
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.equal(seen.length, 3);
    const [a, b, c] = seen.map(texts) as [string[], string[], string[]];
    // The prefix is the same bytes on every request; the tail is not.
    assert.equal(a.length, 2);
    assert.ok(Buffer.from(a[0] as string).equals(Buffer.from(b[0] as string)) && Buffer.from(a[0] as string).equals(Buffer.from(c[0] as string)));
    assert.notEqual(a[1], b[1]);
    assert.notEqual(b[1], c[1]);
    assert.match(a[0] as string, /^# Goal C1\n/);
    assert.match(a[0] as string, /theorem Demo.add_zero' \(n : ℕ\) : n \+ 0 = n/);
    // Nothing of the conversation is in the request: no assistant message, no tool result, only the packet.
    for (const context of seen) assert.deepEqual(context.messages.map((m) => m.role), ["system", "user"]);
    // The second request's tail says what the first check did, raw, and shows the file as it was left.
    assert.match(b[1] as string, /request 2\./);
    assert.match(b[1] as string, /PROOF region:\n```lean\nbad\n```/);
    assert.match(b[1] as string, /# Last Lean feedback \(only the last check is shown\)\n[\s\S]*unknown identifier 'bad'/);
    // The third shows the hole of the sketch the second left, and only the last feedback.
    assert.match(c[1] as string, /# Open holes \(1\)\n1\. n : ℕ\n   ⊢ n \+ 0 = n/);
    assert.doesNotMatch(c[1] as string, /unknown identifier/);
    // The prover can expand and query.
    // (The tools are exercised in the next test; the faux provider shows only the messages.)
  });

  it("records each packet it compiles, with its size and what each section kept", { timeout: 60000 }, async () => {
    const { events } = await packets(["exact trivial_proof"]);
    const nodes = ofType(events, "node.recorded").filter((e) => e.data.kind === PACKET_KIND);
    assert.equal(nodes.length, 1);
    const data = nodes[0]?.data.data as unknown as PacketRecord;
    assert.equal(data.naive, false);
    assert.ok(data.prefixTokens > 0 && data.prefixTokens <= data.budget);
    assert.deepEqual(data.shown, { facts: 0, edges: 0, premises: 0, tried: 0, lessons: 0 });
  });

  it("answers expand and graph_query from the packet's own ids, and shows the model the answer in the next tail only", { timeout: 60000 }, async () => {
    const seen: Context[] = [];
    const step = (response: ReturnType<typeof check>) => (context: Context) => (seen.push(context), response);
    await demoRun({
      lines: { M4: M4 },
      config: { lines: ["M4"], lineOptions: { M4: { extractQueries: false } } },
      responses: [step(call("expand", { id: "C1" })), step(call("graph_query", { depth: 1 })), step(call("expand", { id: "C99" })), step(check("exact trivial_proof"))],
    });
    const tails = seen.map((c) => texts(c)[1] as string);
    assert.match(tails[1] as string, /# Answers to your last tool calls \(only the last turn's are shown\)\nexpand:\nC1 \[open\] \(n : ℕ\) : n \+ 0 = n\n/);
    assert.match(tails[2] as string, /graph_query:\n1 claim, 0 edges\nC1  open/);
    assert.doesNotMatch(tails[2] as string, /expand:/, "an older answer is not carried");
    assert.match(tails[3] as string, /expand \(error\):\nError: no item "C99" in this session/);
  });

  it("is deterministic: the same inputs give the same prefix and the same first tail", { timeout: 60000 }, async () => {
    const one = await packets(["bad", "exact trivial_proof"], { rendering: "table" });
    const two = await packets(["bad", "exact trivial_proof"], { rendering: "table" });
    assert.deepEqual(one.seen.map(texts), two.seen.map(texts));
  });

  it("carries a proved fact of an earlier problem into the next problem's packet with a badge and an id, and expand finds it", { timeout: 60000 }, async () => {
    const seen: Context[] = [];
    const steps: Step[] = [check("exact trivial_proof"), (context: Context) => (seen.push(context), call("expand", { id: "C2" })), (context: Context) => (seen.push(context), check("exact trivial_proof"))];
    await demoRun({
      lines: { M1: LINES.M1 as Line, M4 },
      file: FILE,
      problems: 2,
      certifier: certifier().certifier,
      config: { lines: ["M1", "M4"], lineOptions: { M4: { extractQueries: false, factThreshold: 0.1 } } },
      responses: steps,
    });
    const prefix = texts(seen[0] as Context)[0] as string;
    assert.match(prefix, /# Useful facts \(checked by Lean\)\nC2 \[proved: Lean's kernel replayed the proof\] \(n : ℕ\) : n \+ 0 = n/);
    assert.match(texts(seen[1] as Context)[1] as string, /expand:\nC2 \[proved\] \(n : ℕ\) : n \+ 0 = n/);
  });

  it("shows a lesson exactly when the draw included it, with an id that expand resolves, and records the draw", { timeout: 120000 }, async () => {
    const sessions = 6;
    const prefixes: string[] = [];
    const steps: Step[] = [
      check("exact trivial_proof"),
      ...Array.from({ length: sessions }, () => [(context: Context) => (prefixes.push(texts(context)[0] as string), check("rw [bad_lemma]")), say("notes")]).flat(),
    ];
    const { events } = await demoRun({
      lines: { M1: LINES.M1 as Line, M5: LINES.M5 as Line, M4 },
      file: FILE,
      problems: 2,
      certifier: certifier().certifier,
      config: { lines: ["M1", "M4", "M5"], sessions, seed: "m4-lessons", lineOptions: { M4: { extractQueries: false }, M5: { fromFailures: false } } },
      responses: steps,
    });
    const lesson = ofType(events, "node.recorded").find((e) => e.data.kind === "lesson");
    const lessonId = lesson?.data.nodeId as string;
    const second = ofType(events, "attempt.started").filter((e) => [...(e.data.included ?? []), ...(e.data.withheld ?? [])].includes(lessonId));
    assert.equal(second.length, sessions);
    const included = second.filter((e) => e.data.included?.includes(lessonId)).length;
    assert.ok(included >= 1 && included < sessions, `the draw included it ${included} of ${sessions} times`);
    const shown = prefixes.filter((p) => /# Active lessons/.test(p));
    assert.equal(shown.length, included);
    assert.match(shown[0] as string, /\nA1 \(msc:11\) A proof using the rewriting strategy passed the fast check on msc:11 problems; try that strategy early\./);
    // M5's own briefing section is in the opening prompt, which the packet replaces: the model reads the lesson once.
    assert.ok(prefixes.every((p) => (p.match(/rewriting strategy/g) ?? []).length <= 1));
    // The packet's record says what the draw did.
    const records = ofType(events, "node.recorded").filter((e) => e.data.kind === PACKET_KIND).map((e) => e.data.data as unknown as PacketRecord);
    assert.equal(records.filter((r) => r.included.includes(lessonId)).length, included);
  });
});

describe("the naive packet", () => {
  it("has the same content without selection, order or ids, and no tools", { timeout: 60000 }, async () => {
    const seen: Context[] = [];
    const steps: Step[] = [check("exact trivial_proof"), (context: Context) => (seen.push(context), check("bad")), (context: Context) => (seen.push(context), check("exact trivial_proof"))];
    await demoRun({
      lines: { M1: LINES.M1 as Line, M4 },
      file: FILE,
      problems: 2,
      certifier: certifier().certifier,
      config: { lines: ["M1", "M4"], lineOptions: { M4: { naive: true, extractQueries: false } } },
      responses: steps,
    });
    const [first, second] = seen.map(texts) as [string[], string[]];
    assert.equal(first.length, 1, "a string, compiled again for every request");
    assert.match(first[0] as string, /^Theorem Demo.two_mul' \(n : ℕ\) : 2 \* n = n \+ n/);
    assert.match(first[0] as string, /Facts:\n\(n : ℕ\) : n \+ 0 = n/);
    assert.doesNotMatch(first[0] as string, /\bC\d+\b|# Goal|Useful facts/);
    assert.match(second[0] as string, /PROOF region:\n```lean\nbad\n```/);
  });
});

describe("query extraction and the premise sources", () => {
  const declarations = async () => [
    { name: "Nat.add_zero", signature: "(n : ℕ) : n + 0 = n", module: "Mathlib.Algebra.Group.Defs" },
    { name: "Nat.dvd_add", signature: "{a b c : ℕ} (h₁ : a ∣ b) (h₂ : a ∣ c) : a ∣ b + c", module: "Mathlib.Algebra.Group.Basic" },
    { name: "Real.sqrt_nonneg", signature: "(x : ℝ) : 0 ≤ Real.sqrt x", module: "Mathlib.Analysis.SpecialFunctions.Pow.Real" },
    { name: "Finset.sum_comm", signature: "∑ x in s, ∑ y in t, f x y = ∑ y in t, ∑ x in s, f x y", module: "PFR.Sums", package: "PFR" },
  ];

  it("turns the goal into queries with one model call at the site context.queries, and finds premises with them", { timeout: 60000 }, async () => {
    const seen: Context[] = [];
    const { events } = await demoRun({
      lines: { M4: createM4({ declarations }) },
      config: { lines: ["M4"], lineOptions: { M4: { premiseThreshold: 0.3 } } },
      responses: [say('{"concepts": ["adding zero on the natural numbers"], "names": ["Nat.add_zero", "Nat.nonsense"]}'), (context: Context) => (seen.push(context), check("exact trivial_proof"))],
    });
    const calls = ofType(events, "model_call.finished").filter((e) => e.data.site === "context.queries");
    assert.equal(calls.length, 1);
    const prefix = texts(seen[0] as Context)[0] as string;
    assert.match(prefix, /# Candidate premises \(this file, the library, other packages, Mathlib\)\nL1 \[Mathlib\] Nat\.add_zero \(n : ℕ\) : n \+ 0 = n \(needs: import Mathlib\.Algebra\.Group\.Defs\) \(rewrite\)/);
    assert.doesNotMatch(prefix, /nonsense|Real\.sqrt/, "a name the index does not have is not shown");
    assert.doesNotMatch(prefix, /PFR/, "a package the header does not import is not shown");
    const record = ofType(events, "node.recorded").map((e) => e.data).find((d) => d.kind === PACKET_KIND)?.data as unknown as PacketRecord;
    assert.deepEqual(record.queries, ["adding zero on the natural numbers"]);
    assert.equal(record.shown.premises, 1);
  });

  it("falls back to the statement alone, and says so, when the queries cannot be extracted", { timeout: 60000 }, async () => {
    const logs: string[] = [];
    const seen: Context[] = [];
    const { result } = await demoRun({
      lines: { M4: createM4({ declarations }) },
      config: { lines: ["M4"] },
      log: (l) => logs.push(l),
      responses: [say("no json here"), say("still none"), (context: Context) => (seen.push(context), check("exact trivial_proof"))],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.ok(logs.some((l) => /the queries could not be extracted/.test(l)));
    assert.match(texts(seen[0] as Context)[0] as string, /^# Goal C1/);
  });

  it("names the draws of the unverified premises: the library section and the k-NN's suggestions", () => {
    assert.equal(LIBRARY_ITEM, "library:section");
    assert.equal(KNN_ITEM, "context:knn");
  });
});
