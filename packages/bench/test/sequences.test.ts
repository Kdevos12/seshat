import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildIndex,
  buildSequences,
  closedByStep,
  convertRows,
  DISCRETE,
  equationToLean,
  licenceNote,
  type ProblemEntry,
  readCache,
  readIndex,
  sequenceProblems,
  sequencesOf,
  shapeOf,
  stemOf,
  suggestTags,
  tagsByProblem,
  taggedWith,
  toProblem,
  validateAnnotations,
  writeIndex,
} from "../src/index.ts";

const entry = (path: string, fullName: string, line: number, statement = ": True"): ProblemEntry =>
  ({ id: `${path}#${fullName}`, path, fullName, declaredName: fullName.split(".").at(-1), line, category: "research solved", ams: [11], proofInFile: false, sorryInStatement: false, statement, statementId: "s", fileHash: "h", imports: [], unprovedBefore: [] }) as unknown as ProblemEntry;

const problems = [
  entry("A.lean", "erdos_1", 10),
  entry("A.lean", "erdos_1.variants.weaker", 20),
  entry("A.lean", "erdos_1.variants.stronger", 30),
  entry("A.lean", "erdos_2", 40),
  entry("B.lean", "alone", 5),
  entry("C.lean", "c_1", 5),
  entry("C.lean", "c_2", 9),
];

describe("sequences", () => {
  it("name the problem a variant belongs to", () => {
    assert.equal(stemOf("erdos_1.variants.weaker"), "erdos_1");
    assert.equal(stemOf("Ns.erdos_1.variants.weaker.more"), "Ns.erdos_1");
    assert.equal(stemOf("erdos_1"), "erdos_1");
  });

  it("group the variants of one problem and the problems of one file, the stem first", () => {
    const seqs = buildSequences(problems);
    assert.deepEqual(seqs.map((s) => [s.id, s.kind, s.problems.length]), [
      ["file:A.lean", "file", 4],
      ["file:C.lean", "file", 2],
      ["variants:A.lean#erdos_1", "variants", 3],
    ]);
    assert.deepEqual(seqs[2]?.problems, ["A.lean#erdos_1", "A.lean#erdos_1.variants.weaker", "A.lean#erdos_1.variants.stronger"]);
    assert.equal(seqs.some((s) => s.path === "B.lean"), false, "a file of one problem makes no sequence");
  });

  it("give a sequence's problems in its order, and refuse an unknown sequence", () => {
    const seqs = buildSequences(problems);
    assert.deepEqual(sequenceProblems(problems, seqs, "file:C.lean").map((p) => p.fullName), ["c_1", "c_2"]);
    assert.throws(() => sequenceProblems(problems, seqs, "nope"), /no sequence/);
  });

  it("are computed for an index that predates them", () => {
    assert.equal(sequencesOf({ problems } as never).length, 3);
  });
});

describe("annotations", () => {
  const good = { v: 1, tags: [{ problem: "A.lean#erdos_1", kind: "induction", note: "induction on n over the sum", by: "me" }, { problem: "C.lean#c_2", kind: "analogy", with: "C.lean#c_1", note: "same argument with 2 for 1" }] };

  it("accept a file that fits the bench and give its tags by problem", () => {
    assert.deepEqual(validateAnnotations(good, problems), []);
    assert.deepEqual(tagsByProblem(good as never), { "A.lean#erdos_1": ["induction"], "C.lean#c_2": ["analogy"] });
    assert.deepEqual(taggedWith(problems, tagsByProblem(good as never), "analogy").map((p) => p.fullName), ["c_2"]);
  });

  it("refuse an unknown problem, kind or field, a missing note or partner, a self-analogy and a repeated tag", () => {
    const bad = (tag: Record<string, unknown>) => validateAnnotations({ v: 1, tags: [tag] }, problems).join("; ");
    assert.match(bad({ problem: "zzz", kind: "induction", note: "long enough note" }), /not in the bench/);
    assert.match(bad({ problem: "B.lean#alone", kind: "magic", note: "long enough note" }), /kind must be/);
    assert.match(bad({ problem: "B.lean#alone", kind: "induction", note: "short" }), /note of at least 10/);
    assert.match(bad({ problem: "B.lean#alone", kind: "analogy", note: "long enough note" }), /exactly one of/);
    assert.match(bad({ problem: "B.lean#alone", kind: "analogy", with: "B.lean#alone", note: "long enough note" }), /not an analogue of itself/);
    assert.match(bad({ problem: "B.lean#alone", kind: "induction", with: "A.lean#erdos_1", note: "long enough note" }), /only an analogy/);
    assert.match(bad({ problem: "B.lean#alone", kind: "induction", note: "long enough note", extra: 1 }), /unknown field/);
    assert.match(validateAnnotations({ v: 1, tags: [good.tags[0], good.tags[0]] }, problems).join(), /twice/);
    assert.match(validateAnnotations({ v: 2, tags: [] }, problems).join(), /version/);
  });

  it("only suggest: induction on a sum over a natural number, an analogy between statements of one shape in two files", () => {
    const ps = [
      entry("A.lean", "s1", 1, ": ∀ n : ℕ, ∑ i in Finset.range n, i = n * (n - 1) / 2"),
      entry("B.lean", "s2", 1, ": ∀ m : ℕ, ∑ j in Finset.range m, j = m * (m - 1) / 2"),
      entry("B.lean", "s3", 9, ": True"),
    ];
    const s = suggestTags(ps);
    assert.deepEqual(s.map((x) => [x.kind, x.problem]).sort(), [["analogy", "B.lean#s2"], ["induction", "A.lean#s1"], ["induction", "B.lean#s2"]]);
    assert.equal(s.find((x) => x.kind === "analogy")?.with, "A.lean#s1");
    assert.equal(shapeOf("a = 1"), shapeOf("b = 2"));
  });
});

describe("the index with sequences and tags", () => {
  it("holds them, round-trips with its hash, and refuses annotations that do not fit", () => {
    const root = mkdtempSync(join(tmpdir(), "mh-seq-"));
    mkdirSync(join(root, "FormalConjectures"), { recursive: true });
    const body = (name: string) => `@[category research solved, AMS 11]\ntheorem ${name} (n : ℕ) : n * 1 = n := by\n  sorry\n\n`;
    writeFileSync(join(root, "FormalConjectures", "T.lean"), `import FormalConjectures.Util.ProblemImports\n\nnamespace T\n\n${body("p1")}${body("p1.variants.weak")}${body("p2")}end T\n`);
    writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.27.0\n");
    const index = buildIndex(root, "toy", DISCRETE);
    assert.equal(index.counts.selected, 3);
    assert.deepEqual(index.sequences?.map((s) => s.kind), ["file", "variants"]);
    assert.equal(index.tags, undefined);
    const id = index.problems[0]?.id as string;
    const tagged = buildIndex(root, "toy", DISCRETE, { v: 1, tags: [{ problem: id, kind: "induction", note: "induction on n, base case trivial" }] });
    assert.deepEqual(Object.keys(tagged.tags ?? {}), [id]);
    assert.notEqual(tagged.hash, index.hash);
    const file = join(root, "index.json");
    writeIndex(file, tagged);
    assert.deepEqual(readIndex(file).tags, tagged.tags);
    assert.throws(() => buildIndex(root, "toy", DISCRETE, { v: 1, tags: [{ problem: "zzz", kind: "induction", note: "long enough note" }] }), /do not fit the bench/);
    assert.ok(readFileSync(file, "utf8").includes('"sequences"'));
  });
});

describe("bench-ext", () => {
  // Three rows in the dataset's assumed shape, written by hand: nothing here comes from the dataset.
  const rows = [
    { id: "t1", equation1: "x = y ◇ (x ◇ z)", equation2: "x = x ◇ x", answer: true },
    { id: "t2", eq1: "x ◇ y = y ◇ x", eq2: "x = x ◇ x", implies: "false" },
    { name: "t3", equation1: "x = x", equation2: "x ◇ y = x ◇ y", answer: true },
  ];

  it("converts a row to a Lean statement over Mul, true as an implication and false as a counter-magma", () => {
    const [t1, t2, t3] = convertRows(rows.map((r) => JSON.stringify(r)).join("\n"));
    assert.equal(t1?.id, "bench-ext#t1");
    assert.equal(t1?.statement, ": ∀ (G : Type) [Mul G], (∀ x y z : G, x = y * (x * z)) → ∀ x : G, x = x * x");
    assert.equal(t2?.answer, false);
    assert.equal(t2?.statement, ": ∃ (G : Type) (_ : Mul G), (∀ x y : G, x * y = y * x) ∧ ¬ (∀ x : G, x = x * x)");
    assert.equal(t3?.id, "bench-ext#t3");
    assert.equal(convertRows(JSON.stringify(rows)).length, 3, "a JSON array reads too");
  });

  it("refuses a row it cannot read or an equation that is not one", () => {
    assert.throws(() => convertRows('{"id":"a","equation1":"x = y","equation2":"x = y"}'), /answer/);
    assert.throws(() => convertRows('{"equation1":"x = y","equation2":"x = y","answer":true}'), /no id/);
    assert.throws(() => equationToLean("x ◇ y"), /not an equation/);
    assert.throws(() => equationToLean("x = y; rm"), /variables/);
    assert.equal(toProblem({ id: "u", equation1: "x = y", equation2: "y = x", answer: true }).source, "bench-ext");
  });

  it("reads a local cache and never downloads: a missing or empty cache says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-ext-"));
    assert.throws(() => readCache(join(dir, "missing")), /never downloads/);
    assert.throws(() => readCache(dir), /no \.jsonl or \.json/);
    writeFileSync(join(dir, "b.jsonl"), `${JSON.stringify(rows[0])}\n`);
    writeFileSync(join(dir, "a.json"), JSON.stringify([rows[1], rows[2]]));
    assert.deepEqual(readCache(dir).map((p) => p.id), ["bench-ext#t2", "bench-ext#t3", "bench-ext#t1"]);
    assert.match(licenceNote, /not stated/);
  });

  it("reports the step that closed each problem, and the share closed without a model", async () => {
    const { Journal, newId } = await import("@seshat/core");
    const dir = mkdtempSync(join(tmpdir(), "mh-ext-run-"));
    const journal = Journal.open(dir, "run_x");
    journal.emit("run.started", { runId: "run_x", benchId: "ext", problems: 4, host: "t", config: {} }, "orchestrator");
    const make = (id: string, actor: string | undefined, firstOrder?: boolean) => {
      const claimId = newId("clm");
      journal.emit("claim.created", { claimId, statementId: `s${id}`, statement: ": True", origin: "bench:ext", status: "open", kind: "formal" }, "memory");
      journal.emit("problem.registered", { problemId: id, claimId, target: id, source: { repo: "r", rev: "x", path: "p" }, domain: [] }, "orchestrator");
      if (firstOrder === true) journal.emit("node.recorded", { nodeId: newId("nod"), kind: "first_order_run", claimId, data: { solved: { tactic: "aesop" } } }, "line:M10");
      if (actor !== undefined) journal.emit("validation.finished", { validationId: newId("val"), claimId, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" }, actor);
    };
    make("a", "line:M10");
    make("b", "line:M10", true);
    make("c", "prover:p1");
    make("d", undefined);
    journal.close();
    const { readEvents } = await import("@seshat/core");
    const report = closedByStep(readEvents(join(dir, "journal.jsonl")));
    assert.deepEqual(report.byStep, { subsumption: 0, fingerprint: 0, battery: 1, atp_smt: 1, model: 1, unsolved: 1 });
    assert.equal(report.withoutModel, 0.5);
  });
});
