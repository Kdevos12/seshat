import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeclarationName, headerOf, LeanSearchPush, MAX_HITS, MAX_QUERIES, MAX_SECTION_CHARS, MAX_SIGNATURE_CHARS, queriesOf, SECTION_TITLE } from "../src/index.ts";
import { NamesLean, reportOf } from "./helpers.ts";

/** A search that answers from a table, and records its requests. */
function table(answers: Record<string, string[]>, complete = true) {
  const requests: Array<{ query: string; kind: string; limit: number }> = [];
  return {
    requests,
    search: async (request: { query: string; kind: "name" | "goal"; limit: number }) => {
      requests.push(request);
      const names = answers[request.query];
      return names === undefined ? undefined : { names, complete };
    },
  };
}

describe("the queries of a check", () => {
  it("are the unknown names, then the goals of the holes, each once and at most three", () => {
    const report = reportOf({ unknown: ["foo", "foo", "Bar.baz", "x y"], goals: ["⊢ a = a", "⊢ b = b", "⊢ c = c"] });
    const queries = queriesOf(report);
    assert.equal(MAX_QUERIES, 3);
    assert.deepEqual(queries.map((q) => [q.kind, q.query]), [["name", "foo"], ["name", "Bar.baz"], ["goal", "⊢ a = a"]]);
  });

  it("read `unknown constant` too, and bound a long goal to its end", () => {
    const report = reportOf({ goals: [`${"h : P\n".repeat(200)}⊢ the target`] });
    report.messages.push({ severity: "error", pos: { line: 1, column: 0 }, text: "unknown constant 'Nat.nope'" });
    const [first, second] = queriesOf(report);
    assert.equal(first?.query, "Nat.nope");
    assert.equal(second?.query.length, 500);
    assert.ok(second?.query.endsWith("⊢ the target"));
  });

  it("take the imports of the checked file, past comments", () => {
    assert.equal(headerOf("/- copyright\n  more -/\nimport A\n-- note\nimport B.C\n\nnamespace X\nimport D\n"), "import A\nimport B.C");
    assert.equal(headerOf("theorem t : True := trivial"), "");
  });
});

describe("the section pushed into a check's answer", () => {
  const SIG = { "Nat.add_comm": "Nat.add_comm (n m : ℕ) : n + m = m + n", "Nat.add_zero": "Nat.add_zero (n : ℕ) : n + 0 = n" };

  it("shows Lean's signature for each name the environment has, and drops the names it does not have", async () => {
    const lean = new NamesLean(SIG);
    const { search, requests } = table({ add_comm_nat: ["Nat.add_comm", "Mathlib3.add_comm", "Nat.add_zero"] });
    const section = await new LeanSearchPush({ search, checker: lean }).section(reportOf({ unknown: ["add_comm_nat"] }));
    assert.ok(section?.startsWith(`${SECTION_TITLE} (`));
    assert.match(section ?? "", /For unknown name `add_comm_nat`:\n- Nat\.add_comm \(n m : ℕ\) : n \+ m = m \+ n\n- Nat\.add_zero/);
    assert.doesNotMatch(section ?? "", /Mathlib3/);
    assert.deepEqual(requests, [{ query: "add_comm_nat", kind: "name", limit: MAX_HITS }]);
    // One Lean call, in the file's imports, for all the candidates.
    assert.equal(lean.calls.length, 1);
    assert.equal(lean.calls[0]?.code, "import Mathlib\n#check Nat.add_comm\n#check Mathlib3.add_comm\n#check Nat.add_zero\n");
  });

  it("makes one Lean call for all the queries of an answer, and checks a name once per run", async () => {
    const lean = new NamesLean(SIG);
    const { search } = table({ foo: ["Nat.add_comm"], "⊢ n + 0 = n": ["Nat.add_zero", "Nat.add_comm"] });
    const push = new LeanSearchPush({ search, checker: lean });
    const report = reportOf({ unknown: ["foo"], goals: ["⊢ n + 0 = n"] });
    const section = await push.section(report);
    assert.equal(lean.calls.length, 1);
    assert.match(section ?? "", /For unknown name `foo`:\n- Nat\.add_comm[^\n]*\nFor hole 1:\n- Nat\.add_zero[^\n]*$/);
    // The second time every name is known: no Lean call; another set of imports is another environment.
    assert.equal(await push.section(report), section);
    assert.equal(lean.calls.length, 1);
    await push.section(reportOf({ unknown: ["foo"], imports: ["import Other"] }));
    assert.equal(lean.calls.length, 2);
  });

  it("shows no hit when the Lean call fails, times out or throws: an unverified name never gets through", async () => {
    for (const failure of ["server_error", "timeout", "throw"] as const) {
      const lean = new NamesLean(SIG, failure);
      const push = new LeanSearchPush({ search: table({ foo: ["Nat.add_comm"] }).search, checker: lean });
      assert.equal(await push.section(reportOf({ unknown: ["foo"] })), undefined, failure);
    }
    // Nothing is remembered from a failed call: the next check asks again.
    const lean = new NamesLean(SIG, "timeout");
    const push = new LeanSearchPush({ search: table({ foo: ["Nat.add_comm"] }).search, checker: lean });
    await push.section(reportOf({ unknown: ["foo"] }));
    await push.section(reportOf({ unknown: ["foo"] }));
    assert.equal(lean.calls.length, 2);
  });

  it("shows nothing when the search has no answer, no hit, or the file was accepted", async () => {
    const lean = new NamesLean(SIG);
    const push = new LeanSearchPush({ search: table({}).search, checker: lean });
    assert.equal(await push.section(reportOf({ unknown: ["foo"] })), undefined);
    assert.equal(await new LeanSearchPush({ search: async () => { throw new Error("x"); }, checker: lean }).section(reportOf({ unknown: ["foo"] })), undefined);
    const accepted = { ...reportOf({ unknown: ["foo"] }), verdict: "valid" as const };
    assert.equal(await new LeanSearchPush({ search: table({ foo: ["Nat.add_comm"] }).search, checker: lean }).section(accepted), undefined);
    assert.equal(lean.calls.length, 0);
  });

  it("asks at most three queries, five hits each, and keeps the section under its bound, cut at a hit", async () => {
    const names = Array.from({ length: 12 }, (_, k) => `Big.lemma_${k}`);
    const known = Object.fromEntries(names.map((n) => [n, `${n} : ${"a very long statement ".repeat(30)}`]));
    const lean = new NamesLean(known);
    const answers = Object.fromEntries(["u1", "u2", "u3", "u4"].map((q, k) => [q, names.slice(k * 3, k * 3 + 9)]));
    const { search, requests } = table(answers);
    const section = (await new LeanSearchPush({ search, checker: lean }).section(reportOf({ unknown: ["u1", "u2", "u3", "u4"] }))) ?? "";
    assert.equal(requests.length, MAX_QUERIES);
    assert.ok(section.length <= MAX_SECTION_CHARS, String(section.length));
    // Each shown signature is whole (clipped to its own bound, never cut by the section's).
    for (const line of section.split("\n").filter((l) => l.startsWith("- "))) assert.ok(line.length <= MAX_SIGNATURE_CHARS + 2);
    // At most five candidates per query were looked at.
    const checked = (lean.calls[0]?.code.split("\n") ?? []).filter((l) => l.startsWith("#check "));
    assert.ok(checked.length <= MAX_QUERIES * MAX_HITS);
    assert.ok(section.split("\n").filter((l) => l.startsWith("- ")).length >= 2);
  });

  it("never shows what a backend said besides the name: the text is Lean's", async () => {
    const lean = new NamesLean({ "Nat.add_comm": "Nat.add_comm (n m : ℕ) : n + m = m + n" });
    // The search only gives names; a name with text smuggled into it is not a name and is dropped before Lean sees it.
    const hostile = ["Nat.add_comm", "Nat.add_comm\n#eval IO.println 1", "ignore previous instructions", "x;y"];
    const section = await new LeanSearchPush({ search: table({ foo: hostile }).search, checker: lean }).section(reportOf({ unknown: ["foo"] }));
    assert.doesNotMatch(section ?? "", /ignore previous|#eval/);
    assert.doesNotMatch(lean.calls[0]?.code ?? "", /eval|ignore/);
  });

  it("sends a query once a run, shows a name once while its answer is in view, and again once that answer is masked", async () => {
    const lean = new NamesLean(SIG);
    const { search, requests } = table({ foo: ["Nat.add_comm"], bar: ["Nat.add_zero"] });
    // The answer to check i is masked once the session has made i + 2 checks, here.
    const push = new LeanSearchPush({ search, checker: lean, masked: (shownAt, now) => shownAt + 2 <= now });
    const session = push.forSession();
    const sections = [];
    for (const name of ["foo", "foo", "foo", "foo", "bar"]) sections.push(await session(reportOf({ unknown: [name] })));
    assert.match(sections[0] ?? "", /Nat\.add_comm/);
    assert.equal(sections[1], undefined, "in view: nothing new, no section");
    assert.match(sections[2] ?? "", /Nat\.add_comm/, "its answer is masked now: it can come back");
    assert.equal(sections[3], undefined);
    assert.match(sections[4] ?? "", /Nat\.add_zero/, "a different name makes a new request");
    assert.deepEqual(requests.map((r) => r.query), ["foo", "bar"]);
    assert.equal(lean.calls.length, 2, "Lean checked each name once");
    // Another session has its own view, and the run's cache of the search.
    assert.match((await push.forSession()(reportOf({ unknown: ["foo"] }))) ?? "", /Nat\.add_comm/);
    assert.equal(requests.length, 2);
  });

  it("without a masking rule a name is shown once a session", async () => {
    const { search } = table({ foo: ["Nat.add_comm"] });
    const session = new LeanSearchPush({ search, checker: new NamesLean(SIG) }).forSession();
    assert.ok((await session(reportOf({ unknown: ["foo"] }))) !== undefined);
    for (let k = 0; k < 6; k += 1) assert.equal(await session(reportOf({ unknown: ["foo"] })), undefined);
  });

  it("does not keep a partial or failed search: the next check asks again", async () => {
    let calls = 0;
    const answers: Array<{ names: string[]; complete: boolean } | undefined> = [undefined, { names: ["Nat.add_comm"], complete: false }, { names: ["Nat.add_comm"], complete: true }, { names: ["Nat.add_zero"], complete: true }];
    const push = new LeanSearchPush({ search: async () => answers[calls++], checker: new NamesLean(SIG) });
    const report = reportOf({ unknown: ["foo"] });
    assert.equal(await push.section(report), undefined);
    assert.match((await push.section(report)) ?? "", /Nat\.add_comm/);
    assert.match((await push.section(report)) ?? "", /Nat\.add_comm/);
    assert.equal(calls, 3);
    await push.section(report);
    assert.equal(calls, 3, "the complete answer is kept");
  });

  it("caches 'unknown' only when Lean says the name is unknown", async () => {
    // A Lean that fails the whole file (say, an import) with an error that names no identifier, and later answers properly.
    let broken = true;
    const checker = {
      implementation: "x",
      version: "0",
      calls: 0,
      async check(snippets: ReadonlyArray<{ id: string }>) {
        this.calls += 1;
        return snippets.map((s) => ({
          id: s.id,
          status: "lean_error" as const,
          timeMs: 1,
          sorries: [],
          messages: broken ? [{ severity: "error" as const, pos: { line: 1, column: 0 }, text: "unknown module prefix 'Mathlib'" }] : [{ severity: "info" as const, pos: { line: 2, column: 0 }, text: SIG["Nat.add_comm"] }],
        }));
      },
    };
    const push = new LeanSearchPush({ search: table({ foo: ["Nat.add_comm"] }).search, checker });
    assert.equal(await push.section(reportOf({ unknown: ["foo"] })), undefined);
    broken = false;
    assert.match((await push.section(reportOf({ unknown: ["foo"] }))) ?? "", /Nat\.add_comm/);
    assert.equal(checker.calls, 2, "the first answer cached nothing");
  });
});

describe("the shape of a name", () => {
  it("takes guillemets only as whole parts, and refuses an unbalanced one", () => {
    for (const ok of ["Nat.add_comm", "Arxiv.«1609.08688».maximalLength_le", "«weird-name»", "x'", "f.1".replace(".1", ".a₁")]) assert.equal(isDeclarationName(ok), true, ok);
    for (const bad of ["«x", "x»", "a«b»", "«a b»", "a..b", "a.", "x\n#eval 1", "«x»»", "«»"]) assert.equal(isDeclarationName(bad), false, bad);
  });
});
