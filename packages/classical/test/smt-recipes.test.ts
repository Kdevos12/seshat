import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { type HostProfile, loadCatalog, Registry, runContract } from "@seshat/registry";
import { chcScript, findInvariant, findOptimum, optimumScript, parseOptimumSpec, parseTransitionSystem, readInvariant, readOptimum, readSexps, screenSmtLib, type SmtCall, type SmtOutput, z3Factory } from "../src/index.ts";

const root = new URL("../../../", import.meta.url).pathname;

/** x := 0; while x < 10: x := x + 1. The property: x ≤ 10. */
const COUNTER = { name: "counter", vars: ["x"], init: "(= x 0)", step: "(and (< x 10) (= x' (+ x 1)))", property: "(<= x 10)" };
/** Three bits, no two neighbours both set: at most two set. */
const BITS = { name: "bits", vars: ["a", "b", "c"], constraints: ["(<= 0 a 1)", "(<= 0 b 1)", "(<= 0 c 1)", "(<= (+ a b) 1)", "(<= (+ b c) 1)"], objective: "(+ a b c)", sense: "maximize" };

const sat = (model: string): SmtOutput => ({ status: "sat", model, exitCode: 0, elapsedMs: 3 });
const SPACER = "(\n  (define-fun inv ((x!0 Int)) Bool\n    (and (<= x!0 10) (not (<= x!0 (- 1)))))\n)";
const OPTIMUM = "(objectives\n (obj 2)\n)\n(\n  (define-fun s0 () Int\n    1)\n  (define-fun s2 () Int\n    1)\n  (define-fun s1 () Int\n    0)\n  (define-fun obj () Int\n    2)\n)";

describe("the Spacer recipe (plan change CX7)", () => {
  it("writes Horn clauses over its own symbols and reads the invariant into an open conjecture's Lean statement", async () => {
    const sys = parseTransitionSystem(COUNTER, "M14.invariants[0]");
    const script = chcScript(sys);
    screenSmtLib(script);
    const contract = JSON.parse(readFileSync(join(root, "capabilities/smt.z3/contract.json"), "utf8")) as { cases: Array<{ name: string; input: { smtlib: string } }> };
    assert.equal(contract.cases.find((c) => c.name === "a counter loop's invariant")?.input.smtlib, script, "the contract case is the recipe's own script");
    const asked: Array<{ smtlib: string; model?: boolean }> = [];
    const smt: SmtCall = async (input) => (asked.push(input), sat(SPACER));
    const out = await findInvariant(smt, sys);
    assert.equal(asked[0]?.model, true);
    assert.equal(out.answer, "invariant");
    assert.equal(out.invariant, "(and (<= s0 10) (not (<= s0 (- 1))))");
    assert.equal(
      out.statement,
      ": (∀ x : Int, (x = 0) → ((x ≤ 10) ∧ (¬(x ≤ (-1 : Int))))) ∧ (∀ x x' : Int, ((x ≤ 10) ∧ (¬(x ≤ (-1 : Int)))) → ((x < 10) ∧ (x' = (x + 1))) → ((x' ≤ 10) ∧ (¬(x' ≤ (-1 : Int))))) ∧ (∀ x : Int, ((x ≤ 10) ∧ (¬(x ≤ (-1 : Int)))) → (x ≤ 10))",
    );
    // The older `(model ...)` wrapper reads the same.
    assert.equal(readInvariant(sys, sat(`(model ${SPACER.slice(1)}`)).answer, "invariant");
  });

  it("gives no statement for a malformed or unknown answer, and `unsafe` for Spacer's unsat", () => {
    const sys = parseTransitionSystem(COUNTER, "t");
    const malformed = [
      "",
      "(\n (define-fun inv ((x!0 Int)) Bool (let ((a!1 (<= x!0 10))) a!1))\n)",
      "(\n (define-fun inv ((x!0 Int) (x!1 Int)) Bool true)\n)",
      "(\n (define-fun inv ((x!0 Int)) Bool (<= y!0 10))\n)",
      "(\n (define-fun inv ((x!0 Int)) Bool (ite (<= x!0 3) true false))\n)",
      "(\n (define-fun inv ((x!0 Int)) Bool (<= x!0 10))\n (define-fun aux ((x!0 Int)) Bool true)\n)",
      '(\n (define-fun inv ((x!0 Int)) Bool (<= x!0 "10"))\n)',
      "(\n (define-fun inv ((x!0 Int)) Bool (<= x!0 10)\n)",
      "sorry",
    ];
    for (const model of malformed) {
      const out = readInvariant(sys, sat(model));
      assert.equal(out.answer, "malformed", model);
      assert.equal(out.statement, undefined);
    }
    assert.deepEqual(readInvariant(sys, { status: "unsat", exitCode: 0, elapsedMs: 1 }), { answer: "unsafe", elapsedMs: 1 });
    for (const status of ["unknown", "timeout", "error"] as const) {
      const out = readInvariant(sys, { status, exitCode: 0, elapsedMs: 1 });
      assert.equal(out.answer, status);
      assert.equal(out.statement, undefined);
    }
  });

  it("refuses a system outside the fragment, with the place named", () => {
    assert.throws(() => parseTransitionSystem({ ...COUNTER, init: "(= x' 0)" }, "M14.invariants[0]"), /M14\.invariants\[0\]\.init.*x'/);
    assert.throws(() => parseTransitionSystem({ ...COUNTER, vars: ["theorem"] }, "w"), /not a plain variable name/);
    assert.throws(() => parseTransitionSystem({ ...COUNTER, vars: ["x", "x"] }, "w"), /twice/);
    assert.throws(() => parseTransitionSystem({ ...COUNTER, property: "(<= x (div x 2))" }, "w"), /fragment.*div/);
    assert.throws(() => parseTransitionSystem({ ...COUNTER, property: '(echo "hi")' }, "w"), /atoms and parentheses/);
    assert.throws(() => parseTransitionSystem({ ...COUNTER, extra: 1 }, "w"), /unknown field/);
    assert.equal(readSexps("(a (b c)"), undefined);
    assert.equal(readSexps("a)"), undefined);
  });
});

describe("the Optimize recipe (plan change CX7)", () => {
  it("writes maximize with the objectives and reads an optimum whose point it checks", async () => {
    const q = parseOptimumSpec(BITS, "M8.optima[0]");
    const script = optimumScript(q);
    screenSmtLib(script);
    assert.match(script, /^\(maximize obj\)$/mu);
    assert.match(script, /^\(get-objectives\)$/mu);
    const out = await findOptimum(async () => sat(OPTIMUM), q);
    assert.equal(out.answer, "optimum");
    assert.equal(out.value, "2");
    assert.deepEqual(out.witness, { a: "1", b: "0", c: "1" });
    assert.equal(
      out.statement,
      ": (∃ a b c : Int, ((0 ≤ a) ∧ (a ≤ 1)) ∧ ((0 ≤ b) ∧ (b ≤ 1)) ∧ ((0 ≤ c) ∧ (c ≤ 1)) ∧ ((a + b) ≤ 1) ∧ ((b + c) ≤ 1) ∧ (a + b + c) = 2) ∧ (∀ a b c : Int, ((0 ≤ a) ∧ (a ≤ 1)) → ((0 ≤ b) ∧ (b ≤ 1)) → ((0 ≤ c) ∧ (c ≤ 1)) → ((a + b) ≤ 1) → ((b + c) ≤ 1) → (a + b + c) ≤ 2)",
    );
    const min = parseOptimumSpec({ name: "m", vars: ["y"], constraints: ["(>= y (- 4))"], objective: "y", sense: "minimize" }, "m");
    const low = readOptimum(min, sat("(objectives\n (obj (- 4))\n)\n(\n  (define-fun s0 () Int\n    (- 4))\n)"));
    assert.equal(low.answer, "optimum");
    assert.equal(low.statement, ": (∃ y : Int, (y ≥ (-4 : Int)) ∧ y = (-4 : Int)) ∧ (∀ y : Int, (y ≥ (-4 : Int)) → (-4 : Int) ≤ y)");
  });

  it("gives nothing for an unbounded optimum, a point that breaks a constraint or misses the value, or a malformed answer", () => {
    const q = parseOptimumSpec(BITS, "t");
    const malformed = [
      OPTIMUM.replace("(obj 2)", "(obj oo)"),
      OPTIMUM.replace("(obj 2)", "(obj 3)"),
      OPTIMUM.replace("(define-fun s1 () Int\n    0)", "(define-fun s1 () Int\n    1)"),
      OPTIMUM.replace("(define-fun s0 () Int\n    1)", "(define-fun s0 () Int\n    1.5)"),
      OPTIMUM.replace("s2", "s7"),
      "(objectives\n (obj 2)\n)",
      "(objectives\n (obj 2) (other 1)\n)\n()",
    ];
    for (const model of malformed) {
      const out = readOptimum(q, sat(model));
      assert.equal(out.answer, "malformed", model);
      assert.equal(out.statement, undefined);
    }
    assert.equal(readOptimum(q, { status: "unsat", exitCode: 0, elapsedMs: 1 }).answer, "infeasible");
    assert.equal(readOptimum(q, { status: "unknown", exitCode: 0, elapsedMs: 1 }).answer, "unknown");
    assert.throws(() => parseOptimumSpec({ ...BITS, sense: "best" }, "M8.optima[0]"), /M8\.optima\[0\]\.sense/);
    assert.throws(() => parseOptimumSpec({ ...BITS, objective: "(<= a 1)" }, "o"), /objective.*fragment/);
  });
});

/** A stand-in z3 that answers each contract case the way z3 does (the HORN and MaxSMT answers in z3's own print format). */
const STAND_IN = [
  'if [ "$1" = "--version" ]; then echo "Z3 version 4.13.0 - 64 bit"; exit 0; fi',
  "IN=$(cat)",
  'case "$IN" in',
  `  *"set-logic HORN"*) printf 'sat\\n(\\n  (define-fun inv ((x!0 Int)) Bool\\n    (<= x!0 10))\\n)\\n';;`,
  `  *"assert-soft"*) printf 'sat\\n(objectives\\n (missed 1)\\n)\\n';;`,
  `  *":named c"*) printf 'unsat\\n(a b)\\n';;`,
  `  *"declare-const x"*"get-model"*) printf 'sat\\n(\\n  (define-fun x () Int\\n    4)\\n)\\n';;`,
  `  *) printf '(error "line 1 column 12: unknown constant x")\\n'; exit 1;;`,
  "esac",
].join("\n");

function registry(command: string, args?: string[]): Registry {
  const host: HostProfile = { host: "test", capabilities: { "smt.z3": { use: ["process"], settings: { process: { command, ...(args !== undefined ? { args } : {}) } } } } };
  const dir = mkdtempSync(join(tmpdir(), "mh-z3-"));
  return new Registry({ catalog: loadCatalog(join(root, "capabilities")), host, factories: { z3: z3Factory() }, journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) });
}

describe("the contract of smt.z3", () => {
  it("passes its cases, the invariant and the MaxSMT optimum among them, with a stand-in binary that answers like z3", async () => {
    const report = await runContract(registry("sh", ["-c", STAND_IN, "z3"]), "smt.z3");
    assert.equal(report.failed, 0, JSON.stringify(report.cases.filter((c) => !c.passed)));
    assert.equal(report.passed, 5);
  });

  const real = process.env.Z3_COMMAND ?? "z3";
  const present = spawnSync(real, ["--version"], { stdio: "ignore" }).status === 0;
  it("passes its cases with the real z3, and the recipes read its answers", { skip: present ? false : `no ${real} binary on this host` }, async () => {
    const r = registry(real);
    const report = await runContract(r, "smt.z3");
    assert.equal(report.failed, 0, JSON.stringify(report.cases.filter((c) => !c.passed)));
    const smt: SmtCall = async (input) => (await r.invoke("smt.z3", input as never)).output as unknown as SmtOutput;
    assert.equal((await findInvariant(smt, parseTransitionSystem(COUNTER, "t"))).answer, "invariant");
    const optimum = await findOptimum(smt, parseOptimumSpec(BITS, "t"));
    assert.deepEqual([optimum.answer, optimum.value], ["optimum", "2"]);
  });
});
