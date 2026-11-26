import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, seeded } from "@seshat/core";
import type { ValidateRequest, ValidateResult } from "@seshat/lines";
import { CapabilityError } from "@seshat/registry";
import { MemoryStore } from "@seshat/memory";
import {
  applicableCertificates,
  BATTERY_RUN,
  CERTIFICATE_METHODS,
  type BatteryRunData,
  bernsteinCandidates,
  CERTIFICATE_NEEDS,
  COMPUTE_TOOLS,
  computeFallbacks,
  computeOrder,
  type ComputeAnswer,
  type ComputeCode,
  type ComputeTool,
  codeFor,
  ComputeUnsuited,
  DEFAULT_CERTIFICATES,
  DEFAULT_SETTINGS,
  modularCandidates,
  obstructingModuli,
  POLYRITH_PY,
  POLYRITH_SAGE,
  polyrithCandidates,
  Posteriors,
  primaryDomain,
  type PolyGoal,
  readPolyGoal,
  registryCompute,
  routeStatement,
  runCertificates,
  type SolveContext,
  snippetFor,
  solveGoal,
  SDP_TIME_SHARE,
  SOS_PY,
  sosCandidates,
} from "../src/index.ts";
import { Poly } from "../src/polynomial.ts";
import { rat } from "../src/rational.ts";
import { ScriptedLean, tacticOf } from "./fake-lean.ts";

const HEADER = "import Mathlib";

function goalOf(statement: string): PolyGoal {
  const g = readPolyGoal(statement);
  assert.ok(typeof g !== "string", `readable: ${String(g)}`);
  return g;
}

/**
 * Stands in for compute.python, or for compute.sage: reads the data line the stage wrote (`DATA = "..."` for Python, `cx_data = ...`
 * for Sage) and answers with what `answer` says. Like the real tools, it runs only the code written for it (`ComputeUnsuited` without
 * one), and Sage refuses an `import`, with sagemath-mcp's message.
 */
class FakeCompute implements ComputeTool {
  readonly calls: Array<{ code: string; data: Record<string, unknown> }> = [];
  released = 0;
  readonly #answer: (code: string, data: Record<string, unknown>) => string;
  readonly capability: "compute.python" | "compute.sage";

  constructor(answer: (code: string, data: Record<string, unknown>) => string, capability: "compute.python" | "compute.sage" = "compute.python") {
    this.#answer = answer;
    this.capability = capability;
  }

  async run(code: ComputeCode): Promise<ComputeAnswer> {
    const text = codeFor(code, this.capability);
    if (text === undefined) throw new ComputeUnsuited(Object.keys(code), this.capability);
    if (this.capability === "compute.sage" && /^\s*(?:import|from)\s/mu.test(text)) throw new Error("compute.sage/docker failed: the tool reported an error: Import statements are disabled for Sage executions");
    const m = this.capability === "compute.sage" ? /^cx_data = (.*)\n/u.exec(text) : /^DATA = (".*")\n/u.exec(text);
    assert.ok(m !== null, "the program starts with its data");
    const data = (this.capability === "compute.sage" ? JSON.parse(m[1] as string) : JSON.parse(JSON.parse(m[1] as string) as string)) as Record<string, unknown>;
    this.calls.push({ code: text, data });
    return { stdout: `${this.#answer(text, data)}\n` };
  }

  async release(): Promise<void> {
    this.released++;
  }
}

/** The SDP answer of a fake clarabel: each block's Gram matrix is the sum of `v vᵀ` over the squares given for it, with a little noise. */
function gramAnswer(data: Record<string, unknown>, squares: ReadonlyArray<ReadonlyArray<Record<string, number>>>): string {
  const bases = data.bases as number[][][];
  const x: number[] = [];
  bases.forEach((basis, b) => {
    const vs = (squares[b] ?? []).map((sq) => basis.map((m) => sq[m.join(",")] ?? 0));
    for (let j = 0; j < basis.length; j++) for (let i = 0; i <= j; i++) x.push(vs.reduce((acc, v) => acc + (v[i] as number) * (v[j] as number), 0) + 1e-10 * ((i + j) % 3 - 1));
  });
  x.push(0);
  return JSON.stringify({ status: "Solved", x });
}

const call = { deadline: Number.POSITIVE_INFINITY };

describe("the certificate stage reads goals as polynomials (CX4)", () => {
  it("reads binders, hypotheses, ≠, ¬ ∃ and ∀ in the conclusion", () => {
    const a = goalOf("(x y : ℤ) : x ^ 2 + y ^ 2 ≠ 3");
    assert.deepEqual(a.prelude, ["intro hcx"]);
    assert.equal(a.target.kind, "false");
    assert.equal(a.hyps[0]?.atom.rel, "=");
    const b = goalOf(": ¬ ∃ x y : ℤ, x ^ 2 = 8 * y + 2");
    assert.deepEqual(b.prelude, ["rintro ⟨x, y, hcx⟩"]);
    const c = goalOf(": ∀ a b : ℝ, 0 ≤ a → 2 * a * b ≤ a ^ 2 + b ^ 2");
    assert.deepEqual(c.prelude, ["intro a b", "intro hcx"]);
    assert.ok(c.target.kind === "atom" && c.target.atom.rel === "≤");
    // ≥ is turned around: the goal is `rhs ≥ lhs`, i.e. `lhs ≤ rhs` with the sides swapped.
    const d = goalOf("(a : ℝ) : a ^ 2 ≥ 0");
    assert.ok(d.target.kind === "atom" && d.target.atom.lhs.isZero());
  });

  it("says why a goal is outside: other sorts, functions, mixed sorts", () => {
    assert.match(String(readPolyGoal("(G : Type) [Group G] (g : G) : g * g = g")), /instance/);
    assert.match(String(readPolyGoal("(f : ℕ → ℕ) (n : ℕ) : f n ≤ n")), /sort|relation/);
    assert.match(String(readPolyGoal("(n : ℕ) (x : ℝ) : x ≤ x + 1")), /2 sorts/);
  });
});

describe("(a) the modular obstruction", () => {
  it("finds the moduli where an equation has no solution, fewest cases first", () => {
    const g = goalOf("(x y : ℤ) : x ^ 2 + y ^ 2 ≠ 3");
    const p = (g.hyps[0]?.atom.lhs as Poly).sub(g.hyps[0]?.atom.rhs as Poly);
    assert.deepEqual(obstructingModuli(p, 8), [4, 8]);
  });

  it("writes the cast to ZMod, the residues generalized, and decide", () => {
    const out = modularCandidates(goalOf("(x y : ℤ) : x ^ 2 + y ^ 2 ≠ 3"), DEFAULT_CERTIFICATES);
    assert.equal(out.candidates[0]?.detail, "mod 4");
    assert.equal(
      out.candidates[0]?.script,
      [
        "intro hcx",
        "have hmod := congrArg (Int.cast : ℤ → ZMod 4) hcx",
        "push_cast at hmod",
        "revert hmod",
        "generalize (x : ZMod 4) = res",
        "generalize (y : ZMod 4) = res0",
        "revert res res0",
        "decide",
      ].join("\n"),
    );
    // An equation hypothesis refutes any goal; over ℕ the cast is Nat.cast.
    const h = modularCandidates(goalOf("(m n : ℕ) (h : m ^ 2 + n ^ 2 = 4 * m * n + 3) : m = n"), DEFAULT_CERTIFICATES);
    assert.match(h.candidates[0]?.script ?? "", /^exfalso\nhave hmod := congrArg \(Nat\.cast : ℕ → ZMod 4\) h\n/u);
  });

  it("gives nothing on an equation with solutions, or outside ℕ and ℤ", () => {
    const solvable = modularCandidates(goalOf("(x y : ℤ) : x ^ 2 + y ^ 2 ≠ 5"), DEFAULT_CERTIFICATES);
    assert.equal(solvable.candidates.length, 0);
    assert.match(solvable.note ?? "", /no modulus up to 64/);
    assert.match(modularCandidates(goalOf("(x : ℝ) : x ^ 2 ≠ -1"), DEFAULT_CERTIFICATES).note ?? "", /ℝ, not ℕ or ℤ/);
    assert.match(modularCandidates(goalOf("(x y : ℤ) (h : x < y) : x ^ 2 ≤ y ^ 2 + x"), DEFAULT_CERTIFICATES).note ?? "", /no integer equation/);
  });
});

describe("(b) local polyrith", () => {
  const STATEMENT = "(x y : ℝ) (h1 : x = y) (h2 : y = 2) : x ^ 2 = 4";
  // x² - 4 = (x + y)(x - y) + (y + 2)(y - 2)
  const cofactors = [
    [[[1, 0], "1", "1"], [[0, 1], "1", "1"]],
    [[[0, 1], "1", "1"], [[0, 0], "2", "1"]],
  ];

  it("writes the cofactors the tool found as linear_combination, checked exactly first", async () => {
    const compute = new FakeCompute(() => JSON.stringify({ member: true, cofactors }));
    const out = await polyrithCandidates(goalOf(STATEMENT), compute, call);
    assert.equal(out.candidates[0]?.script, "linear_combination (x + y) * h1 + (y + (2 : ℝ)) * h2");
    assert.equal(compute.calls.length, 1);
    assert.ok(compute.calls[0]?.code.includes("groebner"), "the program asks sympy's Gröbner basis");
    assert.deepEqual(compute.calls[0]?.data.target, [[[2, 0], "1", "1"], [[0, 0], "-4", "1"]]);
  });

  it("gives nothing outside its fragment, without calling the tool", async () => {
    const compute = new FakeCompute(() => "{}");
    assert.match((await polyrithCandidates(goalOf("(x y : ℝ) (h : x = y) : x ≤ y + 1"), compute, call)).note ?? "", /not an equation/);
    assert.match((await polyrithCandidates(goalOf("(x y : ℝ) : (x + y) ^ 2 = x ^ 2 + 2 * x * y + y ^ 2"), compute, call)).note ?? "", /no equation hypothesis/);
    assert.equal(compute.calls.length, 0);
    assert.match((await polyrithCandidates(goalOf(STATEMENT), undefined, call)).note ?? "", /skipped: the host offers no compute tool/);
  });

  it("makes no candidate of a malformed or wrong answer", async () => {
    for (const answer of ["not json", JSON.stringify({ member: true, cofactors: [[["x"]]] }), JSON.stringify({ member: true, cofactors: [cofactors[0], [[[0, 1], "1", "1"]]] }), JSON.stringify({ member: false, cofactors: null })]) {
      const out = await polyrithCandidates(goalOf(STATEMENT), new FakeCompute(() => answer), call);
      assert.equal(out.candidates.length, 0, answer);
      assert.ok(out.note !== undefined);
    }
  });

  it("sends compute.sage a program without import, whose cofactors certify the goal through Lean", async () => {
    // The fake refuses an import as sagemath-mcp does: the Python program would fail here as it did on the real pass.
    const sage = new FakeCompute(() => JSON.stringify({ member: true, cofactors }), "compute.sage");
    await assert.rejects(sage.run(`DATA = "{}"\n${POLYRITH_PY}`), /Import statements are disabled/);
    const script = "linear_combination (x + y) * h1 + (y + (2 : ℝ)) * h2";
    const lean = new ScriptedLean({ [tacticOf(snippetFor({ header: HEADER, statement: STATEMENT }, script))]: { ok: true } });
    const submitted: string[] = [];
    const out = await runCertificates({
      checker: lean,
      goal: { header: HEADER, statement: STATEMENT },
      domain: "general",
      settings: { ...DEFAULT_CERTIFICATES, methods: ["polyrith"] },
      compute: sage,
      budgetSec: 60,
      maxSubmissions: 1,
      submit: async (proof) => (submitted.push(proof), true),
    });
    assert.equal(out.winner?.tactic, "cert.polyrith");
    assert.deepEqual(submitted, [script]);
    assert.equal(sage.calls.length, 1);
    const sent = sage.calls[0]?.code ?? "";
    assert.ok(!/\bimport\b/u.test(sent), "no import reaches Sage");
    assert.ok(sent.includes("PolynomialRing(QQ, cx_nv") && sent.includes(".lift(cx_ideal)"), "Sage's own ring, ideal and lift");
    assert.deepEqual(sage.calls[0]?.data, { nvars: 2, gens: [[[[1, 0], "1", "1"], [[0, 1], "-1", "1"]], [[[0, 1], "1", "1"], [[0, 0], "-2", "1"]]], target: [[[2, 0], "1", "1"], [[0, 0], "-4", "1"]], extra: 2, integral: 0 });
    // A wrong answer from Sage still costs only the call: the cofactors are checked here.
    const wrong = await polyrithCandidates(goalOf(STATEMENT), new FakeCompute(() => JSON.stringify({ member: true, cofactors: [cofactors[0], [[[0, 1], "1", "1"]]] }), "compute.sage"), call);
    assert.match(wrong.note ?? "", /do not combine/);
  });

  it("needs integer cofactors over ℤ", async () => {
    const half = JSON.stringify({ member: true, cofactors: [[[[0, 0], "1", "2"]]] });
    const out = await polyrithCandidates(goalOf("(x y : ℤ) (h : 2 * x = 2 * y) : x = y"), new FakeCompute(() => half), call);
    assert.match(out.note ?? "", /denominators/);
  });
});

describe("(c) sums of squares", () => {
  it("rounds the SDP's Gram matrix, factors it exactly, and writes the squares as hints and as an identity", async () => {
    const compute = new FakeCompute((_, data) => gramAnswer(data, [[{ "1,0": 1, "0,1": -1 }]]));
    const out = await sosCandidates(goalOf("(a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2"), compute, call);
    assert.deepEqual(out.candidates.map((c) => c.script), [
      "nlinarith [sq_nonneg (a - b)]",
      "have hsos : (0 : ℝ) ≤ (1 : ℝ) * (a - b) ^ 2 := mul_nonneg (by norm_num) (sq_nonneg (a - b))\nlinear_combination hsos",
    ]);
    assert.ok(compute.calls[0]?.code.includes("clarabel"));
  });

  it("uses the hypotheses 0 ≤ g as Putinar multipliers", async () => {
    // a³ + b³ - a²b - ab² = a (a - b)² + b (a - b)²: no plain sum of squares (odd degree), one square per multiplier.
    const compute = new FakeCompute((_, data) => gramAnswer(data, [[], [{ "1,0": 1, "0,1": -1 }], [{ "1,0": 1, "0,1": -1 }]]));
    const out = await sosCandidates(goalOf("(a b : ℝ) (ha : 0 ≤ a) (hb : 0 ≤ b) : a ^ 2 * b + a * b ^ 2 ≤ a ^ 3 + b ^ 3"), compute, call);
    assert.equal(out.candidates[0]?.script, [
      "have hpos : (0 : ℝ) ≤ a := by linarith",
      "have hpos0 : (0 : ℝ) ≤ b := by linarith",
      "nlinarith [mul_nonneg hpos (sq_nonneg (a - b)), mul_nonneg hpos0 (sq_nonneg (a - b))]",
    ].join("\n"));
    assert.match(out.candidates[1]?.script ?? "", /have hsos : \(0 : ℝ\) ≤ \(1 : ℝ\) \* \(a\) \* \(a - b\) \^ 2 \+ \(\(1 : ℝ\) \* \(b\) \* \(a - b\) \^ 2\) := add_nonneg/u);
  });

  it("gives nothing outside its fragment, without calling the tool", async () => {
    const compute = new FakeCompute(() => "{}");
    assert.match((await sosCandidates(goalOf("(a b : ℝ) : 2 * a * b < a ^ 2 + b ^ 2 + 1"), compute, call)).note ?? "", /not a non-strict inequality/);
    assert.match((await sosCandidates(goalOf("(m n : ℤ) : 2 * m * n ≤ m ^ 2 + n ^ 2"), compute, call)).note ?? "", /ℤ, not ℝ or ℚ/);
    assert.match((await sosCandidates(goalOf("(x : ℝ) : x ^ 3 ≤ x ^ 3 + x"), compute, call)).note ?? "", /odd degree/);
    assert.equal(compute.calls.length, 0);
    assert.match((await sosCandidates(goalOf("(a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2"), undefined, call)).note ?? "", /skipped: the host offers no compute tool/);
  });

  it("makes no candidate of a malformed answer, or of a Gram matrix that is not positive semidefinite", async () => {
    const goal = goalOf("(a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2");
    for (const answer of ["{", JSON.stringify({ status: "Solved", x: [1, -1] }), JSON.stringify({ status: "Solved", x: [1, "-1", 1, 0] }), JSON.stringify({ status: "PrimalInfeasible", x: [1, -1, 1, 0] })]) {
      const out = await sosCandidates(goal, new FakeCompute(() => answer), call);
      assert.equal(out.candidates.length, 0, answer);
    }
    // a² - 3ab + b² is no sum of squares: whatever Gram matrix comes back, the exact LDLᵀ refuses it.
    const indefinite = await sosCandidates(goalOf("(a b : ℝ) : 3 * a * b ≤ a ^ 2 + b ^ 2"), new FakeCompute(() => JSON.stringify({ status: "Solved", x: [1, -1.5, 1, 0] })), call);
    assert.equal(indefinite.candidates.length, 0);
    assert.match(indefinite.note ?? "", /no rounding/);
  });
});

describe("(c) on Sage alone", () => {
  it("is skipped with a note, and no program is sent: clarabel is Python's", async () => {
    const sage = new FakeCompute(() => "{}", "compute.sage");
    const out = await sosCandidates(goalOf("(a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2"), sage, call);
    assert.equal(out.candidates.length, 0);
    assert.equal(out.note, "skipped: needs compute.python (clarabel); the host's compute tool here is compute.sage");
    assert.equal(sage.calls.length, 0);
    // A goal outside (c)'s fragment still says so first.
    assert.match((await sosCandidates(goalOf("(x : ℤ) : 0 ≤ x ^ 2"), sage, call)).note ?? "", /outside the fragment/);
  });
});

describe("(d) Bernstein subdivision", () => {
  it("writes the Bernstein products as hints on one box", () => {
    const out = bernsteinCandidates(goalOf("(x : ℝ) (h0 : 0 ≤ x) (h1 : x ≤ 1) : x ^ 3 ≤ x"), DEFAULT_CERTIFICATES);
    assert.deepEqual(out.candidates.map((c) => c.script), [
      "linarith [mul_nonneg (sub_nonneg.2 h0) (pow_nonneg (sub_nonneg.2 h1) 2), mul_nonneg (pow_nonneg (sub_nonneg.2 h0) 2) (sub_nonneg.2 h1)]",
      "nlinarith [mul_nonneg (sub_nonneg.2 h0) (pow_nonneg (sub_nonneg.2 h1) 2), mul_nonneg (pow_nonneg (sub_nonneg.2 h0) 2) (sub_nonneg.2 h1)]",
    ]);
  });

  it("splits a box where a coefficient is negative, and joins the boxes by rcases", () => {
    // (x - 1)² (x + 2) has a double root at 1, the midpoint of [0, 2].
    const out = bernsteinCandidates(goalOf("(x : ℝ) (h0 : 0 ≤ x) (h1 : x ≤ 2) : x ^ 3 - 3 * x + 2 ≥ 0"), DEFAULT_CERTIFICATES);
    assert.equal(out.candidates[0]?.detail, "2 box(es)");
    assert.equal(out.candidates[0]?.script, [
      "rcases le_total x (1 : ℝ) with hbox | hbox",
      "· linarith [pow_nonneg (sub_nonneg.2 hbox) 3, mul_nonneg (sub_nonneg.2 h0) (pow_nonneg (sub_nonneg.2 hbox) 2)]",
      "· linarith [mul_nonneg (pow_nonneg (sub_nonneg.2 hbox) 2) (sub_nonneg.2 h1), pow_nonneg (sub_nonneg.2 hbox) 3]",
    ].join("\n"));
  });

  it("gives nothing without numeral bounds, on a false inequality, or past maxBoxes", () => {
    assert.match(bernsteinCandidates(goalOf("(x : ℝ) (h0 : 0 ≤ x) : x ^ 3 ≤ x"), DEFAULT_CERTIFICATES).note ?? "", /without numeral bounds/);
    assert.match(bernsteinCandidates(goalOf("(x : ℝ) (h0 : 0 ≤ x) (h1 : x ≤ 2) : x ^ 3 ≤ x"), DEFAULT_CERTIFICATES).note ?? "", /fails at a corner/);
    // 1/1000 above a double root at 1/3, which no dyadic midpoint hits: more boxes than allowed.
    const tight = bernsteinCandidates(goalOf("(x : ℝ) (h0 : 0 ≤ x) (h1 : x ≤ 1) : 0 ≤ (3 * x - 1) ^ 2 + 1 / 1000"), { maxBoxes: 1 });
    assert.match(tight.note ?? "", /within 1 boxes/);
  });
});

describe("the stage in the battery", () => {
  const STATEMENT = "(x y : ℤ) : x ^ 2 + y ^ 2 ≠ 3";

  async function context(lean: ScriptedLean, statement: string, options: { validate?: (r: ValidateRequest) => ValidateResult; compute?: ComputeTool; certificates?: boolean } = {}) {
    const requests: ValidateRequest[] = [];
    const store = new MemoryStore({ journal: Journal.open(mkdtempSync(join(tmpdir(), "mh-cert-")), "run_1"), blobs: new BlobStore(join(tmpdir(), "mh-cert-blobs")) }).withActor("line:M10");
    const { claimId } = await store.ensureClaim({ statement, header: HEADER, origin: "test" });
    const ctx: SolveContext = {
      checker: lean,
      memory: store,
      validate: async (r) => {
        requests.push(r);
        return options.validate?.(r) ?? { verdict: "valid", status: "computed", reasons: [], validationId: "val_1" };
      },
      host: { have: new Set() },
      settings: { ...DEFAULT_SETTINGS, order: "mean", ...(options.certificates === false ? {} : { certificates: DEFAULT_CERTIFICATES }) },
      random: seeded(1),
      signal: new AbortController().signal,
      log: () => {},
      ...(options.compute !== undefined ? { compute: options.compute } : {}),
    };
    return { ctx, requests, claimId, store };
  }

  const keyOf = (statement: string, script: string): string => tacticOf(snippetFor({ header: HEADER, statement }, script));

  it("runs after the tactics on a goal tagged E6, submits through validate, and journals its tries with posteriors", async () => {
    const certificate = modularCandidates(goalOf(STATEMENT), DEFAULT_CERTIFICATES).candidates[0]?.script as string;
    const lean = new ScriptedLean({ [keyOf(STATEMENT, certificate)]: { ok: true } });
    const { ctx, requests, claimId, store } = await context(lean, STATEMENT);
    const out = await solveGoal(ctx, { claimId, header: HEADER, statement: STATEMENT });
    assert.ok(out.settled);
    assert.deepEqual(out.winner, { tactic: "cert.modular", proof: certificate });
    assert.deepEqual(requests, [{ claimId, proof: certificate }]);
    // The tactics came first, all of them, then the certificate.
    const ids = lean.calls.map((c) => c.id);
    assert.equal(ids.at(-1), "m10:cert.modular");
    assert.ok(ids.slice(0, -1).every((id) => !id.includes("cert.")) && ids.length > 5);
    const data = store.nodes(BATTERY_RUN, { claimId })[0]?.data as unknown as BatteryRunData;
    assert.deepEqual(data.solved, { tactic: "cert.modular", proof: certificate });
    const domain = primaryDomain(routeStatement(STATEMENT));
    assert.equal(Posteriors.from(store).counts(domain, "cert.modular").wins, 1);
  });

  it("records a refused or failed certificate as a loss, and says why the other methods gave nothing", async () => {
    const lean = new ScriptedLean({});
    const compute = new FakeCompute(() => "{}");
    const { ctx, claimId, store, requests } = await context(lean, STATEMENT, { compute });
    const out = await solveGoal(ctx, { claimId, header: HEADER, statement: STATEMENT });
    assert.equal(out.settled, false);
    assert.equal(requests.length, 0);
    const domain = primaryDomain(routeStatement(STATEMENT));
    assert.equal(Posteriors.from(store).counts(domain, "cert.modular").losses, 2, "two moduli, two failed checks");
    const data = store.nodes(BATTERY_RUN, { claimId })[0]?.data as unknown as BatteryRunData;
    assert.deepEqual(data.certificates?.map((n) => n.method), ["modular", "polyrith", "sos", "bernstein"]);
    assert.equal(compute.calls.length, 0, "an integer disequation is outside (b) and (c): the tool is not called");
  });

  it("does nothing on a goal not tagged E6, or when the settings have no certificates", async () => {
    const linear = "(n : ℕ) : n + 0 = n";
    const a = await context(new ScriptedLean({}), linear);
    await solveGoal(a.ctx, { claimId: a.claimId, header: HEADER, statement: linear });
    const b = await context(new ScriptedLean({}), STATEMENT, { certificates: false });
    await solveGoal(b.ctx, { claimId: b.claimId, header: HEADER, statement: STATEMENT });
    for (const { store, claimId } of [a, b]) {
      const data = store.nodes(BATTERY_RUN, { claimId })[0]?.data as unknown as BatteryRunData;
      assert.ok(!data.tries.some((t) => t.tactic.startsWith("cert.")));
      assert.equal(data.certificates, undefined);
    }
  });

  it("keeps a reserve of the budget for the stage, and stops when the budget is spent", async () => {
    const certificate = modularCandidates(goalOf(STATEMENT), DEFAULT_CERTIFICATES).candidates[0]?.script as string;
    const table = new ScriptedLean({ omega: { timeMs: 40_000 }, [keyOf(STATEMENT, certificate)]: { ok: true } });
    const { ctx, claimId } = await context(table, STATEMENT);
    const out = await solveGoal({ ...ctx, settings: { ...ctx.settings, parallel: 1, only: ["omega", "nlinarith"] } }, { claimId, header: HEADER, statement: STATEMENT });
    // omega spends 40 s of the 30 the tactics have; the 30 s reserve is still the stage's.
    assert.equal(out.winner?.tactic, "cert.modular");
    const spent = await runCertificates({ checker: new ScriptedLean({}), goal: { header: HEADER, statement: STATEMENT }, domain: "general", settings: DEFAULT_CERTIFICATES, budgetSec: 0.5, maxSubmissions: 1, submit: async () => true });
    assert.equal(spent.tries.length, 0);
    assert.ok(spent.notes.every((n) => /budget is spent/.test(n.note)));
  });

  it("keeps no reserve on a goal tagged E6 that no method can take: the tactics get the whole budget", async () => {
    // Tagged E6 (an impossibility over arithmetic), but a factorial is no polynomial: no method's fragment holds it.
    const statement = "(n x : ℕ) : n ! + 1 ≠ x ^ 4";
    assert.ok(routeStatement(statement).moves.includes("E6"));
    assert.deepEqual(applicableCertificates(statement, CERTIFICATE_METHODS, true), []);
    const lean = new ScriptedLean({ omega: { timeMs: 40_000 }, nlinarith: { ok: true } });
    const { ctx, claimId } = await context(lean, statement);
    const out = await solveGoal({ ...ctx, settings: { ...ctx.settings, parallel: 1, only: ["omega", "nlinarith"] } }, { claimId, header: HEADER, statement });
    // omega spends 40 s of 60; without a reserve the 20 s left are nlinarith's.
    assert.equal(out.winner?.tactic, "nlinarith");
  });

  it("gives what the stage left of its reserve back to the tactics it cut short", async () => {
    assert.deepEqual(applicableCertificates(STATEMENT, CERTIFICATE_METHODS, false), ["modular"]);
    const lean = new ScriptedLean({ nlinarith: { timeMs: 40_000 }, omega: { ok: true } });
    const { ctx, claimId, store } = await context(lean, STATEMENT);
    const out = await solveGoal({ ...ctx, settings: { ...ctx.settings, parallel: 1, only: ["omega", "nlinarith"] } }, { claimId, header: HEADER, statement: STATEMENT });
    // nlinarith (first in this domain) spends 40 s, past the tactics' 30; the stage's two modular certificates fail at once;
    // omega gets the rest.
    assert.equal(out.winner?.tactic, "omega");
    const tried = (store.nodes(BATTERY_RUN, { claimId })[0]?.data as unknown as BatteryRunData).tries.map((t) => t.tactic);
    assert.deepEqual(tried, ["nlinarith", "cert.modular", "cert.modular", "omega"]);
  });

  it("refuses a candidate the screen refuses, before Lean sees it", async () => {
    // A hypothesis name is the goal's own text: one that spells a forbidden token never reaches Lean.
    const statement = "(x y : ℤ) (sorry : x ^ 2 + y ^ 2 = 3) : False";
    const lean = new ScriptedLean({});
    const out = await runCertificates({ checker: lean, goal: { header: HEADER, statement }, domain: "general", settings: { ...DEFAULT_CERTIFICATES, methods: ["modular"] }, budgetSec: 60, maxSubmissions: 1, submit: async () => true });
    assert.equal(lean.calls.length, 0);
    assert.match(out.notes[0]?.note ?? "", /screen/);
  });
});

describe("the host's compute tool for the stage", () => {
  it("is compute.python before compute.sage, a tool run of the actor in the goal's scope", async () => {
    const calls: Array<{ id: string; input: unknown; options: unknown }> = [];
    const registry = {
      offers: (id: string) => id === "compute.python" || id === "compute.sage",
      invoke: async (id: string, input: unknown, options: unknown) => {
        calls.push({ id, input, options });
        return { output: { result_type: "statement", stdout: "ok\n", elapsed_ms: 1 } };
      },
      release: async () => {},
    };
    const tool = registryCompute(registry as never, { actor: "line:M10", scope: "s1", needs: CERTIFICATE_NEEDS });
    assert.equal(tool?.capability, "compute.python");
    assert.deepEqual(await tool?.run("print(1)", { timeoutSec: 5 }), { stdout: "ok\n" });
    assert.deepEqual(calls[0], { id: "compute.python", input: { code: "print(1)", timeout: 5 }, options: { actor: "line:M10", scope: "s1", timeoutMs: 5000 } });
    assert.equal(registryCompute({ ...registry, offers: () => false } as never, { actor: "a", scope: "s" }), undefined);
  });

  it("is Sage when compute.python is offered but cannot be reached, for that call and the later ones", async () => {
    const calls: string[] = [];
    const codes: string[] = [];
    const registry = {
      offers: (id: string) => id === "compute.python" || id === "compute.sage",
      invoke: async (id: string, input: { code: string }) => {
        calls.push(id);
        codes.push(input.code);
        if (id === "compute.python") throw new CapabilityError("unavailable", id, "compute.python: no implementation could be reached (pyodide: Pyodide is not installed)");
        return { output: { result_type: "statement", stdout: '{"member": false}\n', elapsed_ms: 1 } };
      },
      release: async () => {},
    };
    const tool = registryCompute(registry as never, { actor: "line:M10", scope: "s1", needs: CERTIFICATE_NEEDS });
    const out = await polyrithCandidates(goalOf("(x y : ℚ) (h : x = y) : x ^ 2 = 2"), tool, call);
    assert.equal(out.note, "the conclusion is not in the ideal of the equation hypotheses", "(b) got Sage's answer");
    assert.equal(tool?.capability, "compute.sage");
    await tool?.run("1", { timeoutSec: 5 });
    assert.deepEqual(calls, ["compute.python", "compute.sage", "compute.sage"]);
    // Each tool got the program written for it: Python's with its imports, Sage's without.
    assert.match(codes[0] ?? "", /^DATA = .*\nimport itertools, json/u);
    assert.ok(codes[1]?.startsWith("cx_data = ") && codes[1].endsWith(POLYRITH_SAGE));
    // (c)'s program is Python's alone: on Sage it is not sent, and the stage says why.
    const sos = await sosCandidates(goalOf("(a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2"), tool, call);
    assert.match(sos.note ?? "", /^skipped: needs compute.python \(clarabel\); the host's compute tool here is compute.sage$/u);
    assert.equal(calls.length, 3);
  });

  it("passes over a tool the code has no text for, without marking it unavailable", async () => {
    const calls: string[] = [];
    const registry = {
      offers: () => true,
      invoke: async (id: string) => {
        calls.push(id);
        if (id === "compute.python") throw new CapabilityError("unavailable", id, "compute.python: Pyodide is not installed");
        return { output: { result_type: "statement", stdout: `${id}\n`, elapsed_ms: 1 } };
      },
      release: async () => {},
    };
    // Sage first (the run's order): a Python-only call passes over Sage, goes to Python and finds it down. Sage is left, and has no
    // code for the call: it is unsuited, and Sage stays the tool for the calls that have code for it.
    const tool = registryCompute(registry as never, { actor: "a", scope: "s" });
    assert.equal(tool?.capability, "compute.sage");
    await assert.rejects(tool?.run({ "compute.python": "print(1)" }, { timeoutSec: 5 }) as Promise<unknown>, ComputeUnsuited);
    assert.deepEqual(await tool?.run({ "compute.sage": "1", "compute.python": "1" }, { timeoutSec: 5 }), { stdout: "compute.sage\n" });
    assert.deepEqual(calls, ["compute.python", "compute.sage"]);
    // With Python first, a call Sage has no code for, once Python is down, is unsuited: nothing is sent.
    const python = registryCompute(registry as never, { actor: "a", scope: "s", needs: CERTIFICATE_NEEDS });
    assert.equal((await python?.run("x", { timeoutSec: 5 }))?.stdout, "compute.sage\n");
    calls.length = 0;
    await assert.rejects(python?.run({ "compute.python": "x" }, { timeoutSec: 5 }) as Promise<unknown>, (error: unknown) => error instanceof ComputeUnsuited && error.capability === "compute.sage" && error.wanted.join() === "compute.python");
    assert.deepEqual(calls, []);
  });

  it("is one order with the run's: Sage first, and the tools with clarabel first for the stage", () => {
    assert.deepEqual(COMPUTE_TOOLS, ["compute.sage", "compute.python"]);
    assert.deepEqual(computeOrder(), ["compute.sage", "compute.python"]);
    assert.deepEqual(computeOrder(CERTIFICATE_NEEDS), ["compute.python", "compute.sage"]);
    const offers = { offers: () => true };
    assert.deepEqual(computeFallbacks(offers, "compute.sage"), ["compute.python"]);
    assert.deepEqual(computeFallbacks(offers, "compute.python", CERTIFICATE_NEEDS), ["compute.sage"]);
  });
});

/** The programs are plain Python: where the machine has a python3, they parse, and (b)'s cofactor search runs with sympy stubbed. */
const python3 = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe("the stage's Python programs", () => {
  it("parse, and the cofactor search finds x² - 4 = (x + y)(x - y) + (y + 2)(y - 2)", { skip: python3 ? false : "no python3 on this host" }, () => {
    for (const program of [POLYRITH_PY, SOS_PY]) {
      const parsed = spawnSync("python3", ["-I", "-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: `DATA = "{}"\n${program}`, encoding: "utf8", env: {} });
      assert.equal(parsed.status, 0, parsed.stderr);
    }
    const dir = mkdtempSync(join(tmpdir(), "mh-cert-py-"));
    // The Gröbner membership is sympy's; here it is stubbed to say yes, so that the plain-Python ansatz is what runs.
    writeFileSync(join(dir, "sympy.py"), "class _G:\n    def contains(self, f): return True\ndef groebner(*a, **k): return _G()\ndef symbols(s): return tuple(range(int(s.split(':')[1])))\ndef Add(*a): return 0\ndef Mul(*a): return 1\ndef Rational(a, b): return 1\n");
    const data = { nvars: 2, gens: [[[[1, 0], "1", "1"], [[0, 1], "-1", "1"]], [[[0, 1], "1", "1"], [[0, 0], "-2", "1"]]], target: [[[2, 0], "1", "1"], [[0, 0], "-4", "1"]], extra: 2 };
    const driver = `import sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nDATA = ${JSON.stringify(JSON.stringify(data))}\nexec(sys.stdin.read())`;
    const run = spawnSync("python3", ["-I", "-c", driver], { input: POLYRITH_PY, encoding: "utf8", env: {} });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim()) as { member: boolean; cofactors: unknown[] };
    assert.equal(out.member, true);
    // The cofactors combine to the target, exactly.
    const n = 2;
    const poly = (raw: unknown): Poly => new Poly(n, (raw as Array<[number[], string, string]>).map(([m, a, b]) => [m, rat(BigInt(a), BigInt(b))]));
    const poly1 = (raw: unknown): Poly => new Poly(1, (raw as Array<[number[], string, string]>).map(([m, a, b]) => [m, rat(BigInt(a), BigInt(b))]));
    const sum = poly(out.cofactors[0]).mul(poly(data.gens[0])).add(poly(out.cofactors[1]).mul(poly(data.gens[1])));
    assert.ok(sum.equals(poly(data.target)));
    // Over ℤ: x = (-1)·2x + 1·3x. The first solution, with the free cofactor at 0, is x = (1/2)·2x; an integral one is found.
    const integral = { nvars: 1, gens: [[[[1], "2", "1"]], [[[1], "3", "1"]]], target: [[[1], "1", "1"]], extra: 2 };
    for (const [flag, integers] of [[true, true], [false, false]] as const) {
      const input = { ...integral, integral: flag };
      const driven = spawnSync("python3", ["-I", "-c", driver.replace(JSON.stringify(JSON.stringify(data)), JSON.stringify(JSON.stringify(input)))], { input: POLYRITH_PY, encoding: "utf8", env: {} });
      assert.equal(driven.status, 0, driven.stderr);
      const got = JSON.parse(driven.stdout.trim()) as { cofactors: Array<Array<[number[], string, string]>> };
      const cof = got.cofactors.map((c) => poly1(c));
      assert.ok(cof[0]?.mul(poly1(integral.gens[0])).add((cof[1] as Poly).mul(poly1(integral.gens[1]))).equals(poly1(integral.target)));
      assert.equal(cof.every((c) => c.integral()), integers, `integral ${flag}`);
    }
  });
});

/**
 * A stand-in for the few names of Sage that (b)'s Sage program uses, in plain Python: `QQ` (rationals with Sage's `numerator()` and
 * `denominator()` methods), `PolynomialRing(QQ, n, "v")` whose elements are built from exponent dictionaries and give `exponents()`
 * and `coefficients()`, and an ideal whose membership (`MEMBER`) and `lift` (`LIFT`) the driver plants.
 */
const SAGE_STUB = String.raw`from fractions import Fraction
class Q:
    def __init__(s, v): s.v = v.v if isinstance(v, Q) else Fraction(v)
    def __add__(s, o): return Q(s.v + Q(o).v)
    __radd__ = __add__
    def __sub__(s, o): return Q(s.v - Q(o).v)
    def __rsub__(s, o): return Q(Q(o).v - s.v)
    def __mul__(s, o): return Q(s.v * Q(o).v)
    __rmul__ = __mul__
    def __truediv__(s, o): return Q(s.v / Q(o).v)
    def __eq__(s, o): return s.v == Q(o).v
    def __ne__(s, o): return not s == o
    def __hash__(s): return hash(s.v)
    def numerator(s): return s.v.numerator
    def denominator(s): return s.v.denominator
QQ = Q
class Poly:
    def __init__(s, d): s.d = {tuple(k): Q(v) for k, v in d.items() if Q(v) != 0}
    def exponents(s): return list(s.d)
    def coefficients(s): return list(s.d.values())
    def lift(s, ideal): return [Poly(c) for c in LIFT]
class Ideal:
    def __init__(s, g): s.g = g
    def __contains__(s, p): return MEMBER
class Ring:
    def __call__(s, d): return Poly(d)
    def ideal(s, g): return Ideal(g)
def PolynomialRing(base, n, name):
    assert base is QQ and name == "v"
    return Ring()
`;

describe("the stage's Sage program", () => {
  it("parses as Python with no import, and runs its plumbing and its ℤ ansatz on CPython with Sage stubbed", { skip: python3 ? false : "no python3 on this host" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-cert-sage-"));
    writeFileSync(join(dir, "stub.py"), SAGE_STUB);
    writeFileSync(join(dir, "program.py"), POLYRITH_SAGE);
    const driver = [
      "import ast, json, sys",
      "src = open(sys.argv[1] + '/program.py').read()",
      "assert not any(isinstance(n, (ast.Import, ast.ImportFrom)) for n in ast.walk(ast.parse(src))), 'an import'",
      "assert not any(isinstance(n, (ast.FunctionDef, ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)) for n in ast.walk(ast.parse(src))), 'a function or a comprehension'",
      "exec(open(sys.argv[1] + '/stub.py').read())",
      "case = json.loads(sys.stdin.read())",
      "MEMBER = case['member']",
      "LIFT = [{tuple(e): Fraction(int(a), int(b)) for e, a, b in c} for c in case['lift']]",
      "cx_data = case['data']",
      "exec(src)",
    ].join("\n");
    const run = (input: unknown): { member: boolean; cofactors: Array<Array<[number[], string, string]>> | null } => {
      const out = spawnSync("python3", ["-I", "-c", driver, dir], { input: JSON.stringify(input), encoding: "utf8", env: {} });
      assert.equal(out.status, 0, out.stderr);
      const last = out.stdout.trim().split("\n").at(-1) as string;
      return JSON.parse(last) as { member: boolean; cofactors: Array<Array<[number[], string, string]>> | null };
    };
    // x² - 4 = (x + y)(x - y) + (y + 2)(y - 2): the lift's cofactors come back as the strict parser reads them.
    const data = { nvars: 2, gens: [[[[1, 0], "1", "1"], [[0, 1], "-1", "1"]], [[[0, 1], "1", "1"], [[0, 0], "-2", "1"]]], target: [[[2, 0], "1", "1"], [[0, 0], "-4", "1"]], extra: 2, integral: 0 };
    const lift = [[[[1, 0], "1", "1"], [[0, 1], "1", "1"]], [[[0, 1], "1", "1"], [[0, 0], "2", "1"]]];
    const got = run({ member: true, lift, data });
    assert.equal(got.member, true);
    const poly = (n: number, raw: unknown): Poly => new Poly(n, (raw as Array<[number[], string, string]>).map(([m, a, b]) => [m, rat(BigInt(a), BigInt(b))]));
    const sum = poly(2, got.cofactors?.[0]).mul(poly(2, data.gens[0])).add(poly(2, got.cofactors?.[1]).mul(poly(2, data.gens[1])));
    assert.ok(sum.equals(poly(2, data.target)));
    assert.deepEqual(run({ member: false, lift: [], data }), { member: false, cofactors: null });
    // Over ℤ: x = (-1)·2x + 1·3x. The lift x = (1/2)·2x has a denominator; with integral 1 the ansatz finds integers.
    const integral = { nvars: 1, gens: [[[[1], "2", "1"]], [[[1], "3", "1"]]], target: [[[1], "1", "1"]], extra: 2 };
    for (const flag of [1, 0]) {
      const out = run({ member: true, lift: [[[[0], "1", "2"]], []], data: { ...integral, integral: flag } });
      const cof = (out.cofactors ?? []).map((c) => poly(1, c));
      assert.ok(cof[0]?.mul(poly(1, integral.gens[0])).add((cof[1] as Poly).mul(poly(1, integral.gens[1]))).equals(poly(1, integral.target)));
      assert.equal(cof.every((c) => c.integral()), flag === 1, `integral ${flag}`);
    }
  });
});

describe("the stage's time", () => {
  /** A compute tool that answers nothing useful and uses `use(timeoutSec)` milliseconds of each call. */
  const slowTool = (use: (timeoutSec: number) => number) => {
    const calls: Array<{ timeoutSec: number; timeLimit: unknown }> = [];
    const tool: ComputeTool = {
      capability: "compute.python",
      async run(code, { timeoutSec }) {
        const data = JSON.parse(JSON.parse((/^DATA = (".*")\n/u.exec(codeFor(code, "compute.python") as string) as RegExpExecArray)[1] as string) as string) as Record<string, unknown>;
        calls.push({ timeoutSec, timeLimit: data.timeLimit });
        await new Promise((resolveWait) => setTimeout(resolveWait, use(timeoutSec)));
        return { stdout: "{}\n" };
      },
    };
    return { tool, calls };
  };

  it("takes (c)'s time again before its Putinar program, and gives clarabel 0.8 of each call", async () => {
    const { tool, calls } = slowTool(() => 1100);
    await sosCandidates(goalOf("(x : ℝ) (h : 0 ≤ x) : 0 ≤ x ^ 2 + 1"), tool, { deadline: Date.now() + 3500 });
    assert.deepEqual(calls.map((c) => c.timeoutSec), [3, 2], "the second call gets what the first left");
    assert.deepEqual(calls.map((c) => c.timeLimit), [3 * SDP_TIME_SHARE, 2 * SDP_TIME_SHARE]);
    const late = slowTool(() => 0);
    const out = await sosCandidates(goalOf("(x : ℝ) (h : 0 ≤ x) : 0 ≤ x ^ 2 + 1"), late.tool, { deadline: Date.now() + 500 });
    assert.equal(late.calls.length, 0);
    assert.match(out.note ?? "", /time for this method is spent/);
  });

  it("keeps a slice of the budget for (d) when (c) uses all the time it is given", async () => {
    const statement = "(x : ℝ) (h0 : 0 ≤ x) (h1 : x ≤ 1) : x ^ 2 ≤ x";
    const bernstein = bernsteinCandidates(goalOf(statement), DEFAULT_CERTIFICATES).candidates[0]?.script as string;
    const lean = new ScriptedLean({ [tacticOf(snippetFor({ header: HEADER, statement }, bernstein))]: { ok: true } });
    const { tool, calls } = slowTool((timeoutSec) => timeoutSec * 1000);
    const out = await runCertificates({ checker: lean, goal: { header: HEADER, statement }, domain: "general", settings: DEFAULT_CERTIFICATES, compute: tool, budgetSec: 5, maxSubmissions: 1, submit: async () => true });
    // Of 5 s, 1.25 s are kept for (d): (c) gets one call of 3 s, and no time for its second.
    assert.deepEqual(calls.map((c) => c.timeoutSec), [3]);
    assert.equal(out.winner?.tactic, "cert.bernstein");
  });
});

describe("the bounds of (c)", () => {
  it("leaves a program with too many constraints outside, before any call", async () => {
    // Degree 8 in 4 variables: 495 monomials to match, far above the bound on constraints.
    const compute = new FakeCompute(() => "{}");
    const out = await sosCandidates(goalOf("(a b c d : ℝ) : 0 ≤ (a + b + c + d) ^ 8 + a ^ 8 + b ^ 8 + c ^ 8 + d ^ 8"), compute, call);
    assert.equal(compute.calls.length, 0);
    assert.match(out.note ?? "", /outside the fragment: more than/);
  });
});
