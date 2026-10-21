import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AUX_END,
  type CertificationRequest,
  forbiddenTokensIn,
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

describe("forbiddenTokensIn", () => {
  it("lists the forbidden tokens of a text whose comments are blanked, in the order of the list, with whole-word matching", () => {
    assert.deepEqual(forbiddenTokensIn("n = n #eval IO.Process.exit 7 macro_rules"), ["#eval", "macro_rules", "IO"]);
    assert.deepEqual(forbiddenTokensIn("exact _root_.Lean.ofReduceBool"), ["Lean"]);
    assert.deepEqual(forbiddenTokensIn("exact ofReduceBool"), ["ofReduceBool"]);
    assert.deepEqual(forbiddenTokensIn("sorry"), ["sorry"]);
    assert.deepEqual(forbiddenTokensIn("Nat.Prime n ∧ sorry_free n ∧ n.IOx = macro"), ["macro"]);
    assert.deepEqual(forbiddenTokensIn("n % 2 = 0"), []);
    // The same screen as the structural check's, which lets holes through only under the sketch policy.
    assert.deepEqual(structuralCheck({ aux: "", proof: "  sorry" }), ["proof: 'sorry' is not allowed"]);
  });

  it("finds a token that starts with a character no identifier has wherever it stands: Lean reads x#eval as x and #eval", () => {
    assert.deepEqual(forbiddenTokensIn("n = n x#eval 1"), ["#eval"]);
    assert.deepEqual(forbiddenTokensIn("a_b'#eval 1"), ["#eval"]);
    assert.deepEqual(forbiddenTokensIn("h.#eval 1"), ["#eval"]);
    assert.deepEqual(forbiddenTokensIn("x1#print axioms"), ["#print"]);
    assert.deepEqual(forbiddenTokensIn("(x)#exit"), ["#exit"]);
    // The longest token wins in Lean's lexer, so what follows such a token does not matter: `#eval!` is a command as well.
    assert.deepEqual(forbiddenTokensIn("n = n #eval! 1"), ["#eval"]);
    assert.deepEqual(forbiddenTokensIn("n = n #evalfoo"), ["#eval"]);
    // The same for a token that ends with a character no identifier has, at its end: `eval%x` is `eval%` and `x`.
    assert.deepEqual(forbiddenTokensIn("exact eval%x"), ["eval%"]);
    assert.deepEqual(forbiddenTokensIn("exact xeval% y"), []);
  });

  it("finds a keyword after a number, which Lean reads as a token of its own, and not after an identifier that ends in digits", () => {
    assert.deepEqual(forbiddenTokensIn("exact foo 1sorry"), ["sorry"]);
    assert.deepEqual(forbiddenTokensIn("exact foo 12run_cmd"), ["run_cmd"]);
    assert.deepEqual(forbiddenTokensIn("exact h.1sorry"), ["sorry"]);
    assert.deepEqual(forbiddenTokensIn("exact x1sorry + x_12macro + a'3import + b!4elab"), []);
  });

  it("finds a keyword that Lean reads as a token of its own, whatever precedes it: a symbol, a number in any form, a letter no name has", () => {
    const tokenAfter: Array<[string, string]> = [
      // `!` and `?` end a name, they do not start one; a quote starts a character; λ, Π and Σ are not letters of names.
      ["exact !sorry", "sorry"], ["exact ?run_cmd", "run_cmd"], ["exact 'a'macro", "macro"], ["exact λelab", "elab"], ["exact Πsyntax", "syntax"], ["exact Σinitialize", "initialize"],
      // Letters of other scripts, and the accented Latin letters that only some versions of Lean take for part of a name.
      ["exact жsorry", "sorry"], ["exact 中IO", "IO"], ["exact éelab", "elab"],
      // A number is a token of its own, also when it has letters or an underscore in it.
      ["exact 1e5sorry", "sorry"], ["exact 1_000sorry", "sorry"], ["exact 0xbeefsorry", "sorry"], ["exact 0b1sorry", "sorry"], ["exact 1.5sorry", "sorry"], ["exact ₁sorry", "sorry"],
      // A dot that is not the middle of a name: after a bracket, after another dot, after a space.
      ["exact (e).sorry", "sorry"], ["exact a..macro", "macro"], ["exact f .elab", "elab"], ["exact x. sorry", "sorry"], ["exact x.1.elab", "elab"],
    ];
    for (const [text, token] of tokenAfter) assert.deepEqual(forbiddenTokensIn(text), [token], text);
  });

  it("finds a keyword glued after a symbol token that ends in letters: Lean cuts the token off at the longest match of its table", () => {
    // `#check`, `#synth` and `#reduce` are tokens of Lean, `[MOD`, `[ZMOD` and `⟫_` of Mathlib; whatever letters follow, they are a token of their own.
    const glued: Array<[string, string]> = [
      ["#checkrun_cmd 1", "run_cmd"], ["#synthrun_cmd 1", "run_cmd"], ["#reducemacro x", "macro"],
      ["a ≡ b [MODrun_cmd 1]", "run_cmd"], ["a ≡ b [ZMODrun_cmd 1]", "run_cmd"], ["a ≡ b [MODmacro x]", "macro"], ["a ≡ b [MODIO]", "IO"],
      ["⟪x, y⟫_run_cmd 1", "run_cmd"], ["⟪x, y⟫_ℝelab", "elab"],
    ];
    for (const [text, token] of glued) assert.deepEqual(forbiddenTokensIn(text), [token], text);
    // With a space after the symbol token, the keyword was found before as well.
    for (const text of ["#check run_cmd 1", "a ≡ b [MOD run_cmd 1]", "⟪x, y⟫_ run_cmd 1"]) assert.deepEqual(forbiddenTokensIn(text), ["run_cmd"], text);
  });

  it("does not trust a run of letters as a name unless the lexer starts a token right before it: after white space, ( , ) or the start", () => {
    // The table of tokens depends on what is imported, so no symbol is trusted to end a token before a name: a name glued to one is refused, also where it is a name.
    const afterSymbol: Array<[string, string]> = [
      ["simp [hprefix]", "prefix"], ["⟨hinfix, h⟩", "infix"], ["¬xIO", "IO"], ["a=b.macro", "macro"], ["n+xsorry", "sorry"], ["f[x]xelab", "elab"], ["{xsorry}", "sorry"], ["x:xdebug", "debug"],
    ];
    for (const [text, token] of afterSymbol) assert.deepEqual(forbiddenTokensIn(text), [token], text);
    // Where the lexer starts a token for sure, a name that holds a keyword is a name.
    const names = ["(xsorry)", "f (x, ysorry)", "f x,ymacro", "(h.elab)", "(f x).y.elab", "\nxsorry", "xsorry", "a ≡ b [MOD n]", "n % 2 = 0"];
    for (const name of names) assert.deepEqual(forbiddenTokensIn(name), [], JSON.stringify(name));
  });

  it("does not find a keyword that continues a name, as Lean's lexer reads one", () => {
    const names = [
      "xsorry", "x1sorry", "x_12macro", "a'3import", "b!4elab", "_elab", "x!sorry", "x?sorry", "x'sorry", "x₁sorry", "αmacro", "sorry_free", "my_run_cmd", "sorrys",
      // Dotted names, also after the symbols that precede a name.
      "Nat.sorry_lemma", "a.b.elab", "h.elab", "!x.sorry", "?x.elab", "!!x.macro", "(f x).y.elab",
    ];
    for (const name of names) assert.deepEqual(forbiddenTokensIn(`exact ${name}`), [], name);
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

  it("refuses a command glued to what precedes it, in either region", () => {
    refused("", "  exact foo x#eval 1", /proof: '#eval' is not allowed/);
    refused("", "  trivial\n  exact foo 1#exit", /proof: '#exit' is not allowed/);
    refused("theorem aux_a : True := by trivial x#print axioms aux_a", "  simp", /aux: '#print' is not allowed/);
    // A keyword that Lean reads as a token of its own: after `!`, after λ, after a number.
    refused("", "  trivial\n  !run_tac pure ()", /proof: 'run_tac' is not allowed/);
    refused("theorem aux_a : True := by trivial λmacro_rules", "  simp", /aux: 'macro_rules' is not allowed/);
    refused("", "  trivial\n  exact foo 1e5run_cmd", /proof: 'run_cmd' is not allowed/);
  });

  it("refuses a keyword glued after a symbol token that ends in letters, in either region", () => {
    refused("", "  simp\n  #checkrun_cmd 1", /proof: 'run_cmd' is not allowed/);
    refused("", "  simp\n  exact foo [MODrun_cmd 1]", /proof: 'run_cmd' is not allowed/);
    refused("", "  simp\n  exact foo [ZMODmacro x]", /proof: 'macro' is not allowed/);
    refused("", "  simp\n  exact foo ⟪x, y⟫_run_cmd 1", /proof: 'run_cmd' is not allowed/);
    refused("theorem aux_a : True := by trivial #synthrun_cmd 1", "  simp", /aux: 'run_cmd' is not allowed/);
    // The same text with a hypothesis named like a keyword after white space is still a proof.
    ok("theorem aux_a (hprefix : True) : True := hprefix", "  simp\n  exact aux_a hprefix");
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
    // A command glued to the proof before it is refused, too: it would have run in the REPL.
    const glued = await validator.validate(sketch, withProof("  simp\n  exact foo x#eval 1"), reference);
    assert.equal(glued.verdict, "invalid");
    assert.match(glued.reasons.join(), /proof: '#eval' is not allowed/);
    const afterSymbol = await validator.validate(sketch, withProof("  simp\n  exact foo [MODrun_cmd 1]"), reference);
    assert.equal(afterSymbol.verdict, "invalid");
    assert.match(afterSymbol.reasons.join(), /proof: 'run_cmd' is not allowed/);
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
