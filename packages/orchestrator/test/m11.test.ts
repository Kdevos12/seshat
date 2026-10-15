import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { type LeanCheckOptions, type LeanCheckResult, type LeanChecker, type LeanSnippet, readEvents } from "@seshat/core";
import type { Line, LineRegistry } from "@seshat/lines";
import { type CounterModel, negationProofs, oeisFactory, recognizeStatement } from "@seshat/models";
import { type HostProfile, leanCheckImplementation, loadCatalog, Registry } from "@seshat/registry";
import { type Instance, SimulatedDecide } from "../../models/test/simulated-lean.ts";
import { LINES, REPO_ROOT, runBench, type RunConfig, type RunOptions } from "../src/index.ts";
import { call, check, config, DEMO_FILE, demoAnswer, DemoLean, demoBench, demoRegistry, fauxModels, ofType, proofOf, tempDir } from "./m0-helpers.ts";

/**
 * Line M11 in a run, with the simulated model and a simulated Lean. The Lean answers the evaluator's
 * `decide` files from the statement's meaning, and accepts the validator's files only for the
 * proofs it is told are right: nothing here has run against a real Lean.
 */
const FILE = `import FormalConjectures.Util.ProblemImports

namespace Magmas

/-- A magma whose product is the left projection is commutative. False: it has two elements. -/
@[category research solved, AMS 8]
theorem left_proj_comm (M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x := by
  sorry

/-- An even number is below fifty. False: fifty. -/
@[category research solved, AMS 11]
theorem even_below_fifty (n : ℕ) (h : n % 2 = 0) : n < 50 := by
  sorry

/-- A number is never 2 modulo 7. False: 2. -/
@[category research solved, AMS 11]
theorem never_two_mod_seven (n : ℕ) : n % 7 ≠ 2 := by
  sorry

end Magmas
`;
const LEFT_PROJECTION_COMMUTES = "(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x";
const EVEN_BELOW_FIFTY = "(n : ℕ) (h : n % 2 = 0) : n < 50";
const COMMUTATIVE = "(M : Type) [Mul M] : ∀ x y : M, x * y = y * x";

const normalize = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").join("\n");

/** The proof of the negation that the line sends first for a statement and its counter-model. */
function firstProof(statement: string, object: CounterModel): string {
  const recognized = recognizeStatement(statement);
  assert.ok("statement" in recognized);
  const proof = negationProofs(recognized.statement, object)[0];
  assert.ok(proof !== undefined);
  return proof.proof;
}

class MixedLean implements LeanChecker {
  readonly implementation = "mixed-lean";
  readonly version = "0";
  readonly decide: SimulatedDecide;
  readonly demo: DemoLean;

  /** `truth` decides the evaluator's examples; the validator's files accept the proofs in `accepted`, and answer as the demo Lean does for the rest. */
  constructor(truth: (instance: Instance) => boolean | undefined, accepted: readonly string[] = []) {
    this.decide = new SimulatedDecide({ truth });
    const right = new Set(accepted.map(normalize));
    this.demo = new DemoLean((code) => {
      const proof = proofOf(code);
      return proof !== undefined && right.has(normalize(proof)) ? {} : demoAnswer(code);
    });
  }

  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    return Promise.all(
      snippets.map(async (snippet) => {
        const [result] = await (snippet.code.includes("m11_stmt") ? this.decide : this.demo).check([snippet], options);
        return result as LeanCheckResult;
      }),
    );
  }
}

async function m11Run(options: {
  file?: string;
  problem: string;
  lean: LeanChecker;
  responses: FauxResponseStep[];
  lines?: LineRegistry;
  config?: Partial<RunConfig>;
  registry?: RunOptions["registry"];
}) {
  const { checkout, index } = demoBench(options.file ?? FILE);
  const entry = index.problems.find((p) => p.fullName === options.problem);
  assert.ok(entry !== undefined, `${options.problem} is in the bench`);
  const { models, faux, name } = fauxModels();
  faux.setResponses(options.responses);
  const dir = join(tempDir(), "run");
  const result = await runBench({
    config: config(name, { lines: ["M11"], ...options.config }),
    index,
    problems: [entry],
    checkout,
    dir,
    models,
    registry: options.registry ?? demoRegistry(options.lean),
    ...(options.lines !== undefined ? { lines: options.lines } : {}),
  });
  return { result, events: readEvents(join(dir, "journal.jsonl")), faux, dir };
}

/**
 * The repository's catalog on a host that also offers oeis.search, served by the real implementation
 * over a `fetch` that answers from the test: the lookup goes through the registry, and no request
 * leaves this machine.
 */
function registryWithOeis(lean: LeanChecker, fetch: typeof globalThis.fetch): RunOptions["registry"] {
  const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
  const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "oeis.search": { use: ["site"], settings: { site: { minIntervalMs: 0 } } } } };
  return (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), oeis: oeisFactory({ fetch }) }, journal, blobs });
}

type Message = TranscriptContext["messages"][number];
function textOf(message: Message): string {
  if (message.role === "assistant") return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const content = message.content as string | Array<{ type: string; text?: string }>;
  return typeof content === "string" ? content : content.map((c) => c.text ?? "").join("");
}

describe("line M11 in a run", () => {
  it("is registered, as the repository's line for M11", () => {
    assert.ok(Object.keys(LINES).includes("M11"));
    assert.equal(LINES.M11?.id, "M11");
  });

  it("refutes a false statement of magmas: the negation passes Lean's check, the claim stays open and the provers do not start", async () => {
    const proof = firstProof(LEFT_PROJECTION_COMMUTES, { kind: "magma", id: "2:0011", size: 2, table: [0, 0, 1, 1] });
    const { result, events, faux } = await m11Run({
      problem: "Magmas.left_proj_comm",
      lean: new MixedLean(() => true, [proof]),
      responses: [check("exact trivial_proof")],
    });
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;

    // The negation was submitted by the line, and passed; the claim is as it was.
    const validations = ofType(events, "validation.finished");
    assert.deepEqual(validations.map((v) => [v.actor, v.data.claimId, v.data.negation, v.data.verdict]), [["validator", claimId, true, "valid"]]);
    assert.deepEqual(ofType(events, "claim.status_changed"), []);

    // The records: the battery, the fingerprint, the counter-model with what became of its refutation, and a computed edge.
    const nodes = ofType(events, "node.recorded");
    assert.deepEqual(nodes.map((n) => [n.actor, n.data.kind, n.data.claimId]), [
      ["line:M11", "battery", undefined],
      ["line:M11", "fingerprint", claimId],
      ["line:M11", "counter_model", claimId],
    ]);
    const fingerprint = nodes[1]?.data.data as { battery: string; evaluator: string; counts: { fails: number }; verdicts: string };
    assert.deepEqual([fingerprint.battery, fingerprint.evaluator, fingerprint.verdicts.length], ["magmas:3+4x120@1", "law", 3461]);
    assert.ok(fingerprint.counts.fails >= 2);
    const counterModel = nodes[2]?.data.data as { object: unknown; evaluator: string };
    assert.deepEqual(counterModel.object, { kind: "magma", size: 2, table: [0, 0, 1, 1] });
    const [update] = ofType(events, "node.updated");
    assert.equal(update?.data.nodeId, nodes[2]?.data.nodeId);
    const refutation = (update?.data.patch as { refutation: Array<{ form: string; verdict: string; validationId: string; status: string }> }).refutation;
    assert.deepEqual(refutation.map((a) => [a.form, a.verdict, a.validationId, a.status]), [["have-revert", "valid", validations[0]?.data.validationId, "open"]]);
    const edges = ofType(events, "edge.added");
    assert.deepEqual(edges.map((e) => [e.data.kind, e.data.status, e.data.from, e.data.to]), [["refuted_by", "computed", claimId, [nodes[2]?.data.nodeId]]]);

    // Magmas are tried in TypeScript: the line's only use of Lean is the check of the proof of the negation.
    assert.equal(ofType(events, "tool_run.started").filter((t) => t.actor === "line:M11" && t.data.capability === "lean.check").length, 1);

    // The provers were stopped before their first session, and the model was never asked.
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.equal(result.problems[0]?.reason, "provers stopped: 1 line");
    assert.equal(ofType(events, "attempt.started").length, 0);
    assert.equal(faux.getPendingResponseCount(), 1);
  });

  it("tries a statement about a number with decide through lean.check, refutes it, and looks the failing numbers up as a sequence", async () => {
    const proof = firstProof(EVEN_BELOW_FIFTY, { kind: "integer", id: "50", value: 50 });
    const { result, events, faux } = await m11Run({
      problem: "Magmas.even_below_fifty",
      lean: new MixedLean((i) => (i.kind === "nat" ? i.value % 2 !== 0 || i.value < 50 : undefined), [proof]),
      responses: [check("exact trivial_proof")],
    });
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;

    // The evaluator's files went through the registry, as the line's tool runs: the probe of the first 16 numbers, the 6 files of
    // the 85 others, the 2 files of the negations of the 26 that failed, and then the check of the proof of the negation.
    const leanRuns = ofType(events, "tool_run.started").filter((t) => t.actor === "line:M11" && t.data.capability === "lean.check");
    assert.equal(leanRuns.length, 4);

    const nodes = ofType(events, "node.recorded");
    assert.deepEqual(nodes.map((n) => n.data.kind), ["battery", "fingerprint", "counter_model", "identification"]);
    const fingerprint = nodes[1]?.data.data as { battery: string; evaluator: string; counts: { holds: number; fails: number; unknown: number } };
    assert.deepEqual([fingerprint.battery, fingerprint.evaluator, fingerprint.counts], ["integers:0..100", "lean", { holds: 75, fails: 26, unknown: 0 }]);
    assert.deepEqual((nodes[2]?.data.data as { object: unknown }).object, { kind: "integer", value: 50 });

    // The numbers where it holds start with 0, 1, 2, ... in a row, which says nothing; those where it fails are the even numbers from 50.
    const identification = nodes[3]?.data.data as { subject: string; strength: string; matches: Array<{ id: string; source: string; offset: number; start: number; next: string[] }> };
    assert.equal(identification.subject, "the numbers from 0 to 100 where the statement fails");
    assert.equal(identification.strength, "strong");
    assert.deepEqual(identification.matches[0], {
      id: "A005843",
      name: "The even numbers: a(n) = 2n.",
      source: "local",
      offset: 0,
      start: 25,
      next: ["102", "104", "106", "108", "110"],
      prefix: false,
    });
    const edges = ofType(events, "edge.added");
    assert.deepEqual(edges.map((e) => [e.data.kind, e.data.status, e.data.from]), [["refuted_by", "computed", claimId], ["cites", "computed", claimId]]);

    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.negation, v.data.verdict]), [[true, "valid"]]);
    assert.deepEqual(ofType(events, "claim.status_changed"), []);
    assert.equal(result.problems[0]?.reason, "provers stopped: 1 line");
    assert.equal(faux.getPendingResponseCount(), 1);
  });

  it("looks the numbers up in the OEIS through the registry's oeis.search, when its table does not know them", async () => {
    const lean = new MixedLean((i) => (i.kind === "nat" ? i.value % 7 !== 2 : undefined));
    const asked: string[] = [];
    // A made-up sequence for the numbers that are 2 modulo 7; the site has nothing for the others.
    const site = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      return new Response(
        JSON.stringify(
          url.includes("q=2%2C9%2C16%2C23")
            ? { count: 1, results: [{ number: 999999, data: "2,9,16,23,30,37,44,51,58,65,72,79,86,93,100,107,114", name: "Numbers that are 2 mod 7 (made up for the test).", offset: "1,1" }] }
            : { count: 0, results: null },
        ),
      );
    }) as typeof fetch;
    const { result, events, faux } = await m11Run({
      problem: "Magmas.never_two_mod_seven",
      lean,
      responses: [check("exact trivial_proof")],
      registry: registryWithOeis(lean, site),
      config: { lines: ["M11"], lineOptions: { M11: { refute: false, stopWhenRefuted: false } } },
    });
    // Two searches, the numbers where the statement holds and those where it fails, each a tool run of the capability, from the line.
    const runs = ofType(events, "tool_run.started").filter((t) => t.data.capability === "oeis.search");
    assert.deepEqual(runs.map((t) => [t.actor, t.data.implementation]), [["line:M11", "site"], ["line:M11", "site"]]);
    assert.equal(asked.length, 2);
    assert.match(asked[1] ?? "", /^https:\/\/oeis\.org\/search\?q=2%2C9%2C16%2C23%2C30%2C37%2C44%2C51%2C58%2C65%2C72%2C79%2C86%2C93%2C100&fmt=json$/);
    assert.deepEqual(ofType(events, "tool_run.finished").filter((t) => runs.some((r) => r.data.toolRunId === t.data.toolRunId)).map((t) => [t.data.outcome, t.data.summary]), [["ok", { count: 0 }], ["ok", { count: 1 }]]);

    const identifications = ofType(events, "node.recorded").filter((n) => n.data.kind === "identification");
    assert.equal(identifications.length, 1);
    const found = identifications[0]?.data.data as { subject: string; matches: Array<{ id: string; source: string; offset: number; start: number | null; next: string[] }> };
    assert.equal(found.subject, "the numbers from 0 to 100 where the statement fails");
    assert.deepEqual(found.matches.map((m) => [m.id, m.source, m.offset, m.start]), [["A999999", "oeis", 1, 1]]);
    assert.deepEqual(found.matches[0]?.next, ["107", "114"]);
    // The line proposed no refutation and left the provers to work: the demo Lean accepts their file.
    assert.deepEqual(ofType(events, "validation.finished").filter((v) => v.data.negation === true), []);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(result.problems[0]?.outcome, "candidate");
  });

  it("goes on with the provers when Lean does not accept the negation, tells them so, compares the claims another line recorded, and tests a lemma on request", async () => {
    const prompts: string[] = [];
    const answers: string[] = [];
    // What the line M2 will do: record a stronger statement as a variant of the problem's.
    const variants: Line = {
      id: "M2",
      title: "variants",
      requires: [],
      hooks: {
        beforeProvers: async (problem) => {
          const { claimId } = await problem.memory.ensureClaim({ statement: COMMUTATIVE, header: problem.target.sketch.prefix, parentId: problem.claimId, origin: "line:M2" });
          problem.memory.addEdge({ kind: "strengthens", from: claimId, to: problem.claimId, status: "proposed" });
        },
      },
    };
    const { result, events } = await m11Run({
      problem: "Magmas.left_proj_comm",
      lean: new DemoLean(),
      lines: { M2: variants, M11: LINES.M11 as Line },
      config: { lines: ["M2", "M11"] },
      responses: [
        (context) => {
          prompts.push(textOf(context.messages.find((m) => m.role === "user") as Message));
          return call("small_models", { statement: COMMUTATIVE });
        },
        (context) => {
          answers.push(textOf(context.messages.findLast((m) => m.role === "toolResult") as Message));
          return check("exact trivial_proof");
        },
      ],
    });
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId as string;
    const variant = ofType(events, "claim.created").find((c) => c.data.origin === "line:M2")?.data.claimId as string;

    // Only the left projections of 2 and 3 elements are counter-models in the battery. The negation was sent in both forms for each, and none passed: the provers started.
    const negations = ofType(events, "validation.finished").filter((v) => v.data.negation === true);
    assert.deepEqual(negations.map((v) => v.data.verdict), ["invalid", "invalid", "invalid", "invalid"]);
    assert.equal(ofType(events, "node.recorded").filter((n) => n.data.kind === "counter_model").length, 2);
    assert.equal(ofType(events, "attempt.started").length, 1);
    assert.equal(result.problems[0]?.outcome, "candidate");

    // Both claims have a fingerprint of the same battery, and the inclusion is a candidate edge: computed, with its lemma.
    const fingerprints = ofType(events, "node.recorded").filter((n) => n.data.kind === "fingerprint");
    assert.deepEqual(fingerprints.map((n) => n.data.claimId).sort(), [claimId, variant].sort());
    const implies = ofType(events, "edge.added").filter((e) => e.data.kind === "implies");
    assert.deepEqual(implies.map((e) => [e.actor, e.data.status, e.data.from, e.data.to]), [["line:M11", "computed", variant, [claimId]]]);
    assert.equal(implies[0]?.data.link?.name, `m11_implies_${variant}_${claimId}`);
    assert.equal(implies[0]?.data.link?.statement, "(M : Type) [Mul M] (h : ∀ x y : M, x * y = y * x) : (∀ x y : M, x * y = x) → ∀ x y : M, x * y = y * x");
    assert.ok(ofType(events, "edge.added").every((e) => e.data.status !== "lean_checked"));
    assert.ok(ofType(events, "edge.status_changed").every((e) => e.data.to !== "lean_checked"));

    // The first message to the prover has a section of the line's, and the tool answered the model.
    const section = /# Small models \(line M11\)\n([\s\S]*?)(?:\n\n# |$)/.exec(prompts[0] ?? "")?.[1] ?? "";
    assert.match(section, /^Before any prover started, the statement was tried on 3461 small objects \(battery magmas:3\+4x120@1, by evaluating its laws\)/);
    assert.match(section, /A counter-model: the magma of size 2 with the table \[\[0,0\],\[1,1\]\]/);
    assert.match(section, /Lean did not accept the proofs of the negation built from it/);
    assert.match(section, new RegExp(`this claim is implied by claim ${variant}, \`${COMMUTATIVE.replace(/[()[\]*]/g, "\\$&")}\``));
    assert.match(answers[0] ?? "", /^On magmas:3\+4x120@1 \(3461 objects, by evaluating its laws\) the statement holds on \d+ and fails on \d+\./);
    assert.match(answers[0] ?? "", /It implies the statement you are proving on this battery: it looks stronger/);
  });

  it("tells the provers that nothing was found against a statement that holds on every small object, and sends no negation", async () => {
    const prompts: string[] = [];
    const lean = new MixedLean(() => true);
    const { result, events } = await m11Run({
      file: DEMO_FILE,
      problem: "Demo.add_zero'",
      lean,
      config: { lines: ["M11"], lineOptions: { M11: { maxNumber: 20 } } },
      responses: [
        (context) => {
          prompts.push(textOf(context.messages.find((m) => m.role === "user") as Message));
          return check("exact trivial_proof");
        },
      ],
    });
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.deepEqual(ofType(events, "validation.finished").filter((v) => v.data.negation === true), []);
    const kinds = ofType(events, "node.recorded").map((n) => n.data.kind);
    assert.deepEqual(kinds, ["battery", "fingerprint"]);
    assert.match(prompts[0] ?? "", /# Small models \(line M11\)\nBefore any prover started, the statement was tried on 21 small objects \(battery integers:0\.\.20, by `decide` in Lean\): it holds on 21, fails on 0\.\nNo counter-model among them: this is evidence for the statement, and no proof of it\./);
    assert.ok(lean.decide.calls.length > 0);
  });

  it("refuses an option that is not one of the line's, and one of the wrong type, before the run starts", async () => {
    await assert.rejects(
      m11Run({ problem: "Magmas.left_proj_comm", lean: new DemoLean(), responses: [], config: { lines: ["M11"], lineOptions: { M11: { depth: 3 } } } }),
      /line M11 has no option depth; its options are exhaustive, sampleSize, samples, seed, maxNumber/,
    );
    await assert.rejects(
      m11Run({ problem: "Magmas.left_proj_comm", lean: new DemoLean(), responses: [], config: { lines: ["M11"], lineOptions: { M11: { refute: "yes" } } } }),
      /option M11\.refute must be a boolean, got "yes"/,
    );
  });

  it("ends the problem with an error that names the option when its value is out of range", async () => {
    const { result } = await m11Run({
      problem: "Magmas.left_proj_comm",
      lean: new DemoLean(),
      responses: [check("exact trivial_proof")],
      config: { lines: ["M11"], lineOptions: { M11: { exhaustive: 4 } } },
    });
    assert.equal(result.problems[0]?.outcome, "error");
    assert.equal(result.problems[0]?.reason, "line M11 failed in beforeProvers: option M11.exhaustive is an integer from 0 to 3, not 4");
  });
});
