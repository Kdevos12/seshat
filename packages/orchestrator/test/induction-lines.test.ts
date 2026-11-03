import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { declareSearch, M16, type SearchSpec } from "@seshat/induction";
import type { Line } from "@seshat/lines";
import { LINES } from "../src/index.ts";
import { check, demoRun, ofType, say } from "./m0-helpers.ts";

/**
 * The lines M8, M16, M13 and M14 in one run, with the simulated model and a simulated Lean: the answers of the model are
 * scripted in the order the lines ask (M8, then M16: the order of `LINE_ORDER`), then the prover's. Nothing here has
 * run against a real model or Lean.
 */
const FILE = `import FormalConjectures.Util.ProblemImports

namespace Induction

/-- An even number is below fifty. False: fifty. -/
@[category research solved, AMS 11]
theorem even_below_fifty (n : ℕ) (h : n % 2 = 0) : n < 50 := by
  sorry

end Induction
`;

const spec: SearchSpec = {
  description: "four distinct digits whose sum is as large as possible",
  signature: "(n) => an array of n distinct integers from 0 to 9",
  inputs: [4],
  score: "({input, output}) => Array.isArray(output) && output.length === input && new Set(output).size === input && output.every((v) => Number.isInteger(v) && v >= 0 && v <= 9) ? output.reduce((a, b) => a + b, 0) : null",
  target: 30,
  seeds: ["(n) => Array.from({length: n}, (_, i) => i)"],
  statement: "(w : List ℕ) (h : w = {witness}) : w.sum = 30",
  proof: "subst h; decide",
};

/** M16 as the registry has it, with the search declared for the problem's claim first, as the task that carries a scoring program would. */
const declaring: Line = {
  ...M16,
  hooks: {
    ...M16.hooks,
    beforeProvers: async (problem) => {
      declareSearch(problem.memory.withActor("line:M16"), problem.claimId, spec);
      await M16.hooks.beforeProvers?.(problem);
    },
  },
};

const hypotheses = {
  hypotheses: [
    { id: "grows", level: "observation", informal: "n is below n squared plus one", conclusion: "(n) => n < n * n + 1", statement: "(n : ℕ) : n < n * n + 1", uses: ["n"] },
    { id: "even_small", level: "pattern", informal: "an even number is below fifty", premise: "(n) => n % 2 === 0", conclusion: "(n) => n < 50", statement: "(n : ℕ) (h : n % 2 = 0) : n < 50", uses: ["n", "odd"] },
  ],
};

let programs = 0;
/** Answers each call by what it asks: a line's JSON answers, the programs of the search in turn, and the prover's check. */
const respond: FauxResponseFactory = (context) => {
  const last = context.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  if (/Round \d+\. Propose/.test(text)) return say(JSON.stringify(hypotheses));
  if (/How useful would this statement be as a lemma/.test(text)) return say(JSON.stringify({ score: 0.9 }));
  if (/Write version \d+/.test(text)) return say(JSON.stringify({ program: programs++ === 0 ? "(n) => Array.from({length: n}, (_, i) => 5 + i)" : "(n) => Array.from({length: n}, (_, i) => 9 - i)" }));
  return check("exact trivial_proof");
};

describe("the lines M8, M16, M13 and M14 in a run", () => {
  it("conjecture, search, explore and repair before the provers, with every claim open and Lean the only judge", async () => {
    const { events, result } = await demoRun({
      file: FILE,
      lines: { ...LINES, M16: declaring },
      config: {
        lines: ["M8", "M16", "M13", "M14"],
        sessions: 1,
        lineOptions: {
          M8: { rounds: 1, classical: false, identify: false, triviality: false, testCases: 0, maxNumber: 60 },
          M16: { samples: 1, rounds: 4, callMs: 200, totalMs: 5000 },
          M13: { maxSize: 4 },
        },
      },
      responses: Array.from({ length: 60 }, () => respond),
    });
    const claims = ofType(events, "claim.created");
    const byOrigin = (origin: string) => claims.filter((e) => e.data.origin === origin);
    // M8: the conjecture the table did not refute is an open claim derived from the target.
    const m8 = byOrigin("line:M8");
    assert.deepEqual(m8.map((e) => e.data.statement), ["(n : ℕ) : n < n * n + 1"]);
    assert.ok(m8.every((e) => e.data.status === "open"));
    // M16: the witness is a claim whose proof went through validate; the score settled nothing.
    const m16 = byOrigin("line:M16");
    assert.equal(m16.length, 1);
    assert.equal(m16[0]?.data.statement, "(w : List ℕ) (h : w = [9, 8, 7, 6]) : w.sum = 30");
    const m16Checks = ofType(events, "validation.finished").filter((e) => e.data.claimId === m16[0]?.data.claimId);
    assert.ok(m16Checks.length >= 1, "the witness was submitted to Lean");
    // M13: laws of the numbers are open claims too.
    assert.ok(byOrigin("line:M13").length >= 2);
    // M14: the hypothesis the table refuted was mended by an exception-barring, an open claim with a premise.
    const m14 = byOrigin("line:M14");
    assert.equal(m14.length, 1);
    assert.match(String(m14[0]?.data.statement), /^\(n : ℕ\) \(h : n % 2 = 0\) \(h_repair : ¬ \(\(n\) ≥ \d+\)\) : n < 50$/);
    // Every claim a line made starts open, and the statuses the run ended with come from Lean's certifier alone.
    assert.ok([...m8, ...m16, ...byOrigin("line:M13"), ...m14].every((e) => e.data.status === "open"));
    assert.equal(ofType(events, "claim.status_changed").filter((e) => e.actor.startsWith("line:")).length, 0, "no line changed a status");
    // The sites of the spend are recorded, so that the report adds them up.
    const sites = new Set(ofType(events, "model_call.finished").map((e) => e.data.site));
    for (const site of ["induction.hypotheses", "conjecture.relevance", "search.program"]) assert.ok(sites.has(site), `site ${site}`);
    assert.ok(result.report !== undefined);
  });
});
