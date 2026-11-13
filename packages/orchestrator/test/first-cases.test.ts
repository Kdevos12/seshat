import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type LeanChecker, readEvents } from "@seshat/core";
import { type Fetch, oeisFactory } from "@seshat/models";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { firstCasesCode, firstCasesPlan, FIRST_CASES_TITLE, REPO_ROOT, solve, type SolveOptions, studentConfig } from "../src/index.ts";
import { fakeSage } from "./fixtures/fake-sage.ts";
import { check, DemoLean, fauxModels, ofType, tempDir } from "./m0-helpers.ts";

/** The first cases the harness computes and puts in the first briefing (plan change PA10): a stand-in compute capability and a stand-in OEIS, no model, no Lean. */
const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));

// A statement of the shape of Putnam 1983 A4: a parameter k, an equation whose left side is a sum of binomials.
const A4 = "(k : ℕ) (hk : 0 < k) : ∑ j ∈ Finset.range (k + 1), (-1 : ℤ) ^ j * (Nat.choose (3 * k) (3 * j) : ℤ) = (-1 : ℤ) ^ (k + 1) * 3 ^ (3 * k - 1) + 1";
const NO_PARAMETER = "(x : ℝ) (h : 0 < x) : ∑ i ∈ Finset.range 3, x = 3 * x";

/** What the stand-in Sage prints for the table of A4: the closed form on both sides, k = 1..8, as the harness's code asks. */
function table(code: string): string | undefined {
  if (!code.includes("_cell")) return undefined;
  const rows = Array.from({ length: 8 }, (_, i) => {
    const k = BigInt(i + 1);
    const v = ((k + 1n) % 2n === 0n ? 1n : -1n) * 3n ** (3n * k - 1n) + 1n;
    return [Number(k), String(v), String(v)];
  });
  return `${JSON.stringify(rows)}\n`;
}

function setup(statement: string, over: Partial<SolveOptions> = {}) {
  const sage = fakeSage("0.9.5", table);
  const searched: string[] = [];
  const fetch: Fetch = async (input) => {
    searched.push(String(input));
    return new Response(JSON.stringify([{ number: 1234, name: "Stand-in sequence", data: "28,-80", offset: "1", keyword: "nonn" }]), { status: 200 });
  };
  const host: HostProfile = {
    host: "test",
    capabilities: {
      "lean.check": { use: ["kimina"] },
      "compute.sage": { use: ["local"] },
      "oeis.search": { use: ["site"], settings: { site: { baseUrl: "https://oeis.test", minIntervalMs: 0 } } },
    },
  };
  const lean: LeanChecker = new DemoLean();
  const { models, faux, name } = fauxModels();
  faux.setResponses([check("exact trivial_proof")]);
  const dir = join(tempDir("mh-first-cases-"), "run");
  const options: SolveOptions = {
    statement,
    dir,
    models,
    model: name,
    maxUsd: 2,
    user: "alice",
    registry: (journal, blobs) =>
      new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), oeis: oeisFactory({ fetch }) }, journal, blobs, mcpTransport: () => sage.transport() }),
    checker: lean,
    confirm: async () => true,
    autoTool: "compute.sage",
    base: { firstCases: true },
    ...over,
  };
  return { options, dir, sage, searched };
}

/** The first message of the prover's first session. */
function firstBriefing(dir: string): string {
  const [attemptId] = ofType(readEvents(join(dir, "journal.jsonl")), "attempt.started").map((e) => e.data.attemptId as string);
  const messages = JSON.parse(readFileSync(join(dir, "transcripts", `${attemptId}.json`), "utf8")) as AgentMessage[];
  const first = messages.find((m) => m.role === "user");
  return JSON.stringify(first?.content);
}

describe("reading a statement's expressions", () => {
  it("translates the sum of A4 and its right side, and starts at 1 for a positive parameter", () => {
    const plan = firstCasesPlan(A4);
    assert.equal(plan?.variable, "k");
    assert.equal(plan?.from, 1);
    assert.deepEqual(plan?.sides.map((s) => s.label), ["lhs", "rhs"]);
    assert.match(plan?.sides[0]?.sage ?? "", /^sum\(.* for j in range\(\(k \+ 1\)\)\)$/);
    assert.match(plan?.sides[0]?.sage ?? "", /binomial\(\(3 \* k\), \(3 \* j\)\)/);
    assert.match(firstCasesCode(plan as never), /range\(1, 9\)/);
  });

  it("reads nothing else: no parameter, a hypothesis only, a quantifier, a division, a subtraction in the naturals, another relation", () => {
    assert.equal(firstCasesPlan(NO_PARAMETER), undefined);
    assert.equal(firstCasesPlan("(n : ℕ) (m : ℕ) : ∑ i ∈ Finset.range n, i = m"), undefined, "two parameters");
    assert.equal(firstCasesPlan("(n : ℕ) : ∀ m : ℕ, ∑ i ∈ Finset.range n, i = m"), undefined);
    assert.equal(firstCasesPlan("(n : ℕ) : ∑ i ∈ Finset.range n, i / 2 = n"), undefined);
    assert.equal(firstCasesPlan("(n : ℕ) : ∑ i ∈ Finset.range n, (i - 1) = n"), undefined, "ℕ subtraction truncates");
    assert.equal(firstCasesPlan("(n : ℕ) : ∑ i ∈ Finset.range n, i ≤ n ^ 2"), undefined);
    assert.equal(firstCasesPlan("(n : ℕ) : n + 0 = n"), undefined, "no sum, product, binomial or factorial");
    assert.equal(firstCasesPlan("(n : ℕ) : ∑ i ∈ Finset.range n, foo i = n"), undefined, "an unknown name");
  });

  it("reads a product and a factorial, and one side alone", () => {
    const plan = firstCasesPlan("(n : ℕ) : ∏ i ∈ Finset.Icc 1 n, i = Nat.factorial n");
    assert.deepEqual(plan?.sides.map((s) => s.sage), ["prod((i) for i in range(1, n + 1))", "factorial(n)"]);
    assert.equal(plan?.from, 0);
    const one = firstCasesPlan("(n : ℕ) : Nat.factorial n = foo n");
    assert.deepEqual(one?.sides.map((s) => s.label), ["lhs"]);
  });
});

describe("the first cases in the first briefing (v2's firstCases)", () => {
  it("puts the table of an A4-shaped statement and the OEIS match in the first briefing, as computed data", async () => {
    const { options, dir, sage, searched } = setup(`theorem a4 ${A4}`);
    await solve(options);
    const briefing = firstBriefing(dir);
    assert.ok(briefing.includes(FIRST_CASES_TITLE), briefing);
    assert.ok(briefing.includes("k | lhs | rhs"));
    assert.ok(briefing.includes("1 | 10 | 10"), "k = 1: 3^2 + 1");
    assert.match(briefing, /A001234 \\"Stand-in sequence\\"/);
    assert.match(briefing, /data, not a proof/);
    assert.equal(sage.calls.filter((c) => String(c.args.code).includes("binomial(")).length, 1, "one compute call");
    assert.equal(searched.length, 1);
    assert.match(searched[0] as string, /q=10%2C-?\d+/);
    // Both are tool runs of the journal under the harness's actors, and no claim's status is touched by them.
    const events = readEvents(join(dir, "journal.jsonl"));
    const runs = ofType(events, "tool_run.started").map((e) => [e.data.capability, e.actor]);
    assert.deepEqual(runs.filter(([, actor]) => String(actor).startsWith("harness:first_cases")), [["compute.sage", "harness:first_cases"], ["oeis.search", "harness:first_cases_oeis"]]);
  });

  it("gives a statement without an integer parameter no section and calls nothing", async () => {
    const { options, dir, sage, searched } = setup(`theorem none ${NO_PARAMETER}`);
    await solve(options);
    assert.ok(!firstBriefing(dir).includes(FIRST_CASES_TITLE));
    assert.deepEqual(sage.calls, []);
    assert.deepEqual(searched, []);
  });

  it("does not call the OEIS in a private run, and keeps the table", async () => {
    const { options, dir, searched } = setup(`theorem a4 ${A4}`, { private: true });
    await solve(options);
    const briefing = firstBriefing(dir);
    assert.ok(briefing.includes("k | lhs | rhs"));
    assert.ok(!briefing.includes("A001234"));
    assert.deepEqual(searched, []);
  });

  it("is off without the setting, in v1, and without the compute tool", async () => {
    const off = setup(`theorem a4 ${A4}`, { base: { firstCases: false } });
    await solve(off.options);
    const v1 = setup(`theorem a4 ${A4}`, { base: {}, defaults: "v1" });
    await solve(v1.options);
    assert.ok(!firstBriefing(v1.dir).includes(FIRST_CASES_TITLE));
    assert.deepEqual(v1.sage.calls, []);
    assert.ok(!firstBriefing(off.dir).includes(FIRST_CASES_TITLE));
    assert.deepEqual(off.sage.calls, []);
    assert.equal(studentConfig({ selection: { all: true }, model: "faux/m", maxUsd: 1, defaults: "v1" }).firstCases, undefined);
    assert.equal(studentConfig({ selection: { all: true }, model: "faux/m", maxUsd: 1, defaults: "v2" }).firstCases, true);
    const noTool = setup(`theorem a4 ${A4}`);
    const { autoTool: _drop, ...rest } = noTool.options;
    await solve(rest);
    assert.ok(!firstBriefing(noTool.dir).includes(FIRST_CASES_TITLE));
  });
});
