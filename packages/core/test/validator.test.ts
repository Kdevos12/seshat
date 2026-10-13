import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AUX_END,
  type CertificationRequest,
  type LeanCertifier,
  PROOF_BEGIN,
  ProofValidator,
  prepareSketch,
  renderSketch,
  scanRegion,
  SKETCH_POLICY,
  structuralCheck,
} from "../src/index.ts";
import { FakeChecker } from "./fake-lean.ts";

const fixture = readFileSync(new URL("./fixtures/erdos-125.lean", import.meta.url), "utf8");
const sketch = prepareSketch(fixture, "erdos_125.variants.positive_lower_density");

function withProof(proof: string, aux = ""): string {
  let file = renderSketch(sketch).replace(`  ${PROOF_BEGIN}\n  sorry\n`, `  ${PROOF_BEGIN}\n${proof}\n`);
  if (aux !== "") file = file.replace(`${AUX_END}\n`, `${aux}\n${AUX_END}\n`);
  return file;
}

describe("scanRegion", () => {
  it("blanks comments and keeps lines", () => {
    const scan = scanRegion("simp -- sorry\n/- native_decide /- nested -/ still -/ omega");
    assert.equal(scan.masked, "simp         \n                                       omega");
    assert.deepEqual(scan.problems, []);
  });

  it("refuses string literals, «» names and open comments", () => {
    assert.deepEqual(scanRegion('exact "--" ').problems, ["string literals are not allowed in the editable regions"]);
    assert.deepEqual(scanRegion("exact «a--b»").problems, ["«» names are not allowed in the editable regions"]);
    assert.deepEqual(scanRegion("simp /- oops").problems, ["a block comment is not closed"]);
  });
});

describe("structuralCheck", () => {
  const ok = (aux: string, proof: string) => assert.deepEqual(structuralCheck({ aux, proof }), []);
  const refused = (aux: string, proof: string, reason: RegExp) => {
    const reasons = structuralCheck({ aux, proof });
    assert.ok(reasons.some((r) => reason.test(r)), `expected ${reason} in ${JSON.stringify(reasons)}`);
  };

  it("accepts ordinary tactics, comments and aux lemmas", () => {
    ok(
      "theorem aux_a (n : ℕ) : n + 0 = n := by simp\n\n@[simp]\nlemma aux_b : (2 : ℕ) = 2 := rfl\nopen Classical in\ndef aux_c : ℕ := 3",
      "  -- sorry, native_decide would be cheating\n  simp [aux_a, Nat.digits]\n  omega",
    );
  });

  it("refuses shortcuts and meta-level code wherever they hide", () => {
    refused("", "  sorry", /proof: 'sorry' is not allowed/);
    refused("", "  native_decide", /'native_decide' is not allowed/);
    refused("", "  exact _root_.Lean.ofReduceBool", /'Lean' is not allowed/);
    refused("", "  run_tac pure ()", /'run_tac' is not allowed/);
    refused("", '  exact (by_elab pure (Lean.mkConst `True))', /'by_elab' is not allowed/);
    refused("", '  simp [show "a" = "a" from rfl]', /string literals are not allowed/);
    refused("", "  -- only a comment", /the proof is empty/);
    refused("axiom aux_x : False", "  simp", /'axiom' is not allowed/);
    refused("set_option debug.skipKernelTC true in\ntheorem aux_x : True := trivial", "  simp", /'debug' is not allowed/);
  });

  it("lets holes through under the sketch policy, and nothing else", () => {
    assert.deepEqual(structuralCheck({ aux: "theorem aux_a : 1 = 1 := by sorry", proof: "  admit" }, SKETCH_POLICY), []);
    assert.deepEqual(structuralCheck({ aux: "", proof: "  native_decide" }, SKETCH_POLICY), ["proof: 'native_decide' is not allowed"]);
  });

  it("allows only aux_ theorems and definitions with plain attributes", () => {
    refused("def helper : ℕ := 1", "  simp", /name 'helper' must start with 'aux_'/);
    refused("instance : Inhabited ℕ := ⟨0⟩", "  simp", /only theorem, lemma, def and abbrev are allowed here, found 'instance'/);
    refused("@[instance] def aux_i : Inhabited ℕ := ⟨0⟩", "  simp", /attribute 'instance' is not allowed/);
    refused("@[command_elab x] def aux_e := 1", "  simp", /'command_elab' is not allowed/);
    refused("end Erdos125\nnamespace Other", "  simp", /found 'end'/);
  });
});

describe("ProofValidator", () => {
  it("reads the reference type from the original file", async () => {
    const checker = new FakeChecker(() => ({ type: "Iff False (LT.lt 0 x)", axioms: ["sorryAx"] }));
    const reference = await new ProofValidator(checker).reference(sketch, fixture);
    assert.deepEqual(reference, { fullName: sketch.fullName, ppType: `@${sketch.fullName} : Iff False (LT.lt 0 x)` });
    assert.equal(checker.calls[0]?.code.startsWith(fixture), true);
  });

  it("refuses a broken original file", async () => {
    const checker = new FakeChecker(() => ({ messages: [{ severity: "error", pos: { line: 3, column: 0 }, text: "unknown identifier" }] }));
    await assert.rejects(new ProofValidator(checker).reference(sketch, fixture), /does not compile: 3: unknown identifier/);
  });

  it("accepts a proof that Lean checks with the original type and standard axioms", async () => {
    const checker = new FakeChecker();
    const validator = new ProofValidator(checker);
    const reference = await validator.reference(sketch, fixture);
    const report = await validator.validate(sketch, withProof("  simp [aux_a]\n  omega", "theorem aux_a : True := trivial"), reference);
    assert.deepEqual(report.reasons, []);
    assert.equal(report.verdict, "valid");
    assert.equal(report.method, "repl");
    assert.deepEqual(report.axioms, ["propext", "Classical.choice", "Quot.sound"]);
    assert.equal(report.editsOutsideRegions, false);
    assert.equal(checker.calls[1]?.code.startsWith(report.checked), true);
  });

  it("refuses sorryAx, a changed type, a timeout and unreadable output", async () => {
    const validate = async (answer: ConstructorParameters<typeof FakeChecker>[0]) => {
      const validator = new ProofValidator(new FakeChecker(answer));
      return validator.validate(sketch, withProof("  simp"), { fullName: sketch.fullName, ppType: `@${sketch.fullName} : T` });
    };
    assert.match((await validate(() => ({ axioms: ["propext", "sorryAx"] }))).reasons.join(), /depends on sorryAx/);
    assert.match((await validate(() => ({ type: "U" }))).reasons.join(), /no longer elaborates to the original type/);
    const timeout = await validate(() => ({ error: { status: "timeout", message: "timed out after 300s" } }));
    assert.equal(timeout.verdict, "invalid");
    assert.equal(timeout.leanStatus, "timeout");
    assert.match((await validate(() => ({ axioms: null }))).reasons.join(), /could not read the axioms/);
    assert.match((await validate(() => ({ type: null }))).reasons.join(), /could not read the type/);
  });

  it("reports Lean errors at the prover's own line numbers", async () => {
    const file = withProof("  simp\n  exact foo");
    const line = file.split("\n").indexOf("  exact foo") + 1;
    const checker = new FakeChecker(() => ({ messages: [{ severity: "error", pos: { line, column: 8 }, text: "unknown identifier 'foo'" }] }));
    const report = await new ProofValidator(checker).validate(sketch, file, { fullName: sketch.fullName, ppType: `@${sketch.fullName} : T` });
    assert.equal(report.verdict, "invalid");
    assert.equal(report.checked.split("\n")[line - 1], "  exact foo");
    assert.deepEqual(report.messages.map((m) => [m.pos.line, m.text]), [[line, "unknown identifier 'foo'"]]);
  });

  it("does not run Lean on a refused or unreadable submission", async () => {
    const checker = new FakeChecker();
    const validator = new ProofValidator(checker);
    const reference = { fullName: sketch.fullName, ppType: "T" };
    assert.equal((await validator.validate(sketch, withProof("  native_decide"), reference)).verdict, "invalid");
    const unmarked = await validator.validate(sketch, "theorem x : True := trivial", reference);
    assert.match(unmarked.reasons.join(), /restore the markers/);
    assert.equal(checker.calls.length, 0);
  });

  it("checks the original statement even when the prover rewrote it", async () => {
    const checker = new FakeChecker();
    const validator = new ProofValidator(checker);
    const cheating = withProof("  trivial").replace("answer(False) ↔ 0 < (A + B).lowerDensity", "True");
    const report = await validator.validate(sketch, cheating, { fullName: sketch.fullName, ppType: `@${sketch.fullName} : T` });
    assert.equal(report.editsOutsideRegions, true);
    assert.ok(report.checked.includes("answer(False) ↔ 0 < (A + B).lowerDensity := by"));
  });

  it("checks a sketch with holes and returns its goals, never valid", async () => {
    const reference = { fullName: sketch.fullName, ppType: `@${sketch.fullName} : T` };
    const file = withProof("  have h := aux_a\n  sorry", "theorem aux_a : 1 = 1 := by sorry");
    const goalLine = file.split("\n").indexOf("  sorry") + 1;
    const sorries = [{ pos: { line: goalLine, column: 2 }, goal: "h : 1 = 1\n⊢ False" }];
    const sketching = new ProofValidator(new FakeChecker(() => ({ sorries, axioms: ["sorryAx"] })), { policy: SKETCH_POLICY });
    const report = await sketching.validate(sketch, file, reference);
    assert.equal(report.verdict, "invalid");
    assert.equal(report.holes, true);
    assert.deepEqual(report.sorries, sorries);
    assert.deepEqual(report.reasons, [
      "the file still has holes (sorry or admit)",
      "lean: 1 sorry(s) left",
      `lean: ${sketch.fullName} depends on sorryAx`,
    ]);

    // A hole the target does not use still makes the file invalid, whatever Lean reports.
    const unused = withProof("  simp", "theorem aux_a : 1 = 1 := by sorry");
    const quiet = new ProofValidator(new FakeChecker(), { policy: SKETCH_POLICY });
    assert.deepEqual((await quiet.validate(sketch, unused, reference)).reasons, ["the file still has holes (sorry or admit)"]);

    // Without holes, the sketch policy gives the default verdict.
    const complete = await quiet.validate(sketch, withProof("  simp"), reference);
    assert.equal(complete.verdict, "valid");
    assert.equal(complete.holes, false);
  });

  it("hands a valid candidate to the certifier, if there is one", async () => {
    const reference = { fullName: sketch.fullName, ppType: `@${sketch.fullName} : T` };
    const plain = new ProofValidator(new FakeChecker());
    const report = await plain.validate(sketch, withProof("  simp"), reference);
    assert.equal(await plain.certify(sketch, fixture, report), undefined);

    const requests: CertificationRequest[] = [];
    const certifier: LeanCertifier = {
      implementation: "fake-certifier",
      version: "0",
      certify: async (request) => {
        requests.push(request);
        return { verdict: "certified", reasons: [], axioms: ["propext"], timeMs: 1 };
      },
    };
    const certifying = new ProofValidator(new FakeChecker(), { certifier });
    assert.equal((await certifying.certify(sketch, fixture, report))?.verdict, "certified");
    assert.equal(requests[0]?.candidate, report.checked);
    assert.equal(requests[0]?.target, sketch.fullName);
    const refused = await certifying.validate(sketch, withProof("  sorry"), reference);
    await assert.rejects(certifying.certify(sketch, fixture, refused), /only a valid candidate/);
  });
});
