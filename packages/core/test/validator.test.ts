import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AUX_END,
  type CertificationRequest,
  forbiddenTokensIn,
  hasHoles,
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

  it("opens a comment only where Lean reads white space: at the start, after a space or a line break, after another comment", () => {
    const blanked = (comment: string) => comment.replace(/[^\n]/g, " ");
    assert.equal(scanRegion("-- a\nsimp").masked, `${blanked("-- a")}\nsimp`);
    assert.equal(scanRegion("simp\n-- sorry\n/- native_decide -/ omega").masked, `simp\n${blanked("-- sorry")}\n${blanked("/- native_decide -/")} omega`);
    // A comment that follows a block comment directly.
    assert.equal(scanRegion("simp /- a -/-- sorry\nomega").masked, `simp ${blanked("/- a -/-- sorry")}\nomega`);
    assert.equal(scanRegion("simp /- a -//- run_cmd 1 -/ omega").masked, `simp ${blanked("/- a -//- run_cmd 1 -/")} omega`);
  });

  it("does not open a comment glued to a token: Lean reads <-, \\/ and // as tokens, and what follows them is code", () => {
    const glued = ["exact foo <-- #eval 1", "exact foo //- #eval 1 -/ bar", "exact foo \\/- #eval 1 -/ bar", "exact foo x--note", "exact foo (/- note -/ x)", "exact foo ⟨-- note"];
    for (const text of glued) assert.deepEqual(scanRegion(text), { masked: text, problems: [] }, text);
    // The refusals of strings and «» names see what follows a glued opener, as they see any code.
    assert.deepEqual(scanRegion('exact foo <-- "x"').problems, ["string literals are not allowed in the editable regions"]);
    assert.deepEqual(scanRegion("exact foo \\/- «a» -/").problems, ["«» names are not allowed in the editable regions"]);
  });

  it("blanks nothing after the first opener it does not take for a comment: Lean may read that one as a comment, and the openers after it with it", () => {
    const blanked = (comment: string) => comment.replace(/[^\n]/g, " ");
    // Before that opener, the comments are blanked as usual.
    assert.equal(scanRegion("simp -- a\nexact foo x--b\n-- sorry\n/- c -/ d").masked, `simp ${blanked("-- a")}\nexact foo x--b\n-- sorry\n/- c -/ d`);
    assert.equal(scanRegion("exact foo x--b /- c -/ d").masked, "exact foo x--b /- c -/ d");
    // Lean reads a comment in each of these (a doc comment for `/--` and `/-!`), up to a `-/` that lies inside what a scanner
    // that went on blanking would take for a line comment of its own, and code after it: `elab`, `sorry` and `run_cmd` would hide
    // behind a `--` that follows a space.
    for (const [text, hidden] of [["x/- a --/run_cmd", "run_cmd"], ["///-! ---/elab/--", "elab"], ["#⟫-/-! --//sorry", "sorry"], ["#e/--=\n --/run_cmd", "run_cmd"]] as const) {
      const scan = scanRegion(text);
      assert.equal(scan.masked, text, text);
      assert.ok(forbiddenTokensIn(scan.masked).includes(hidden), text);
    }
  });

  it("refuses a comment that Lean may read and that the text does not close, also behind an opener that is not taken for one", () => {
    const open = "a block comment is not closed";
    assert.deepEqual(scanRegion("exact foo x/- note").problems, [open]);
    assert.deepEqual(scanRegion("exact foo /-/ note").problems, [open]);
    assert.deepEqual(scanRegion("exact foo /-- note").problems, [open]);
    assert.deepEqual(scanRegion("exact foo x/- note -/ y").problems, []);
    assert.deepEqual(scanRegion("exact foo /-- note -/ y").problems, []);
    // Lean's reading of the opener decides: the character after `/-` belongs to it, and a doc comment has white space before its body.
    assert.deepEqual(scanRegion("exact foo /--/ y").problems, [open]);
    assert.deepEqual(scanRegion("exact foo /-! -- note -/\n y").problems, [open]);
    assert.deepEqual(scanRegion("exact foo /-/-/ y").problems, []);
    assert.deepEqual(scanRegion("exact foo /-- -- /-\n-/ y").problems, []);
    assert.deepEqual(scanRegion("exact foo /-- note -- /-\n-/ y").problems, [open]);
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
      // `_` starts a name and goes on one, but a symbol before it is a symbol like another: `;` is no more trusted to end a token than `[` is.
      [";_elab)", "elab"], ["[n_elab", "elab"], ["h;n_elab", "elab"],
    ];
    for (const [text, token] of afterSymbol) assert.deepEqual(forbiddenTokensIn(text), [token], text);
    // Where the lexer starts a token for sure, a name that holds a keyword is a name.
    const names = [
      "(xsorry)", "f (x, ysorry)", "f x,ymacro", "(h.elab)", "(f x).y.elab", "\nxsorry", "xsorry", "a ≡ b [MOD n]", "n % 2 = 0",
      // Names with an underscore in them.
      "n_elab", "x_elab", "_elab", "__elab", "f (n_elab) x", "f x,_elab)", "h _elab;", "\n_macro",
    ];
    for (const name of names) assert.deepEqual(forbiddenTokensIn(name), [], JSON.stringify(name));
  });

  it("does not find a keyword that continues a name, as Lean's lexer reads one", () => {
    const names = [
      "xsorry", "x1sorry", "x_12macro", "a'3import", "b!4elab", "_elab", "x!sorry", "x?sorry", "x'sorry", "x₁sorry", "αmacro", "sorry_free", "my_run_cmd", "sorrys",
      // Dotted names, also after the symbols that precede a name.
      "Nat.sorry_lemma", "a.b.elab", "h.elab", "!x.sorry", "?x.elab", "!!x.macro", "(f x).y.elab", "foo.IO.bar", "n.IOx",
    ];
    for (const name of names) assert.deepEqual(forbiddenTokensIn(`exact ${name}`), [], name);
  });
});

describe("forbiddenTokensIn after a quote that may start a character literal", () => {
  it("takes no run of letters for a name after it: the literal takes two characters, a boundary among them, and what follows is a token", () => {
    // `' x` is the literal (a broken one), `sorry` a token of its own: Lean lexes what follows as it would at a token start.
    const hidden: Array<[string, string]> = [
      ["' xsorry", "sorry"], ["'(xrun_cmd 1", "run_cmd"], ["',xelab", "elab"], ["1'\n_run_cmd", "run_cmd"], ["x ' _macro", "macro"], ["⟫_x 1'\n_run_cmd", "run_cmd"],
      ["(f x)' ab IO", "IO"], ["[h'] xsorry", "sorry"], ["'a' xsorry", "sorry"],
    ];
    for (const [text, token] of hidden) assert.deepEqual(forbiddenTokensIn(text), [token], text);
    // Before the first such quote the lexer is in step, and a name that holds a keyword is a name; so is every `'` that ends a name.
    for (const text of ["xsorry ' a", "(xsorry) ' a b", "x' xsorry", "h1' (ysorry, x'", "f x' (zsorry) h'"]) assert.deepEqual(forbiddenTokensIn(text), [], text);
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
    refused("", "  simp\n  #reducemacro x", /proof: 'macro' is not allowed/);
    refused("", "  simp\n  exact foo [MODrun_cmd 1]", /proof: 'run_cmd' is not allowed/);
    refused("", "  simp\n  exact foo [ZMODmacro x]", /proof: 'macro' is not allowed/);
    refused("", "  simp\n  exact foo ⟪x, y⟫_run_cmd 1", /proof: 'run_cmd' is not allowed/);
    refused("theorem aux_a : True := by trivial #synthrun_cmd 1", "  simp", /aux: 'run_cmd' is not allowed/);
    // The same text with a hypothesis named like a keyword after white space is still a proof.
    ok("theorem aux_a (hprefix : True) : True := hprefix", "  simp\n  exact aux_a hprefix");
  });

  it("refuses what follows an opener that a token has swallowed, which Lean reads as code: <-- #eval 1", () => {
    refused("", "  simp\n  exact foo <-- #eval 1", /proof: '#eval' is not allowed/);
    refused("", "  simp\n  exact foo <-- #exit", /proof: '#exit' is not allowed/);
    refused("", "  simp\n  exact foo //- #eval 1 -/ bar", /proof: '#eval' is not allowed/);
    refused("", "  simp\n  exact foo \\/- #eval 1 -/ bar", /proof: '#eval' is not allowed/);
    refused("theorem aux_a : True := by trivial <-- #eval 1", "  simp", /aux: '#eval' is not allowed/);
    refused("", '  simp\n  exact foo <-- "x"', /proof: string literals are not allowed/);
    refused("", "  simp\n  exact foo \\/- «a» -/", /proof: «» names are not allowed/);
    // The safe side: a comment glued to a symbol or a name is code to the screen, and is refused if it holds a keyword.
    refused("", "  simp\n  exact foo x--sorry", /proof: 'sorry' is not allowed/);
    refused("", "  simp\n  exact foo |-- run_cmd 1", /proof: 'run_cmd' is not allowed/);
    ok("", "  simp\n  exact foo x--note");
    ok("", "  simp\n  exact foo |-- note");
  });

  it("refuses what a later comment would hide if the scanner went on blanking after an opener that Lean may read as a comment", () => {
    refused("", "  simp\n  exact x/- a --/run_cmd", /proof: 'run_cmd' is not allowed/);
    refused("", "  simp\n  ///-! ---/elab/--", /proof: 'elab' is not allowed/);
    refused("", "  simp\n  #⟫-/-! --//sorry", /proof: 'sorry' is not allowed/);
    refused("", "  simp\n  #e/--=\n --/run_cmd", /proof: 'run_cmd' is not allowed/);
    refused("theorem aux_a : True := by trivial x--note\n-- sorry", "  simp", /aux: 'sorry' is not allowed/);
    ok("", "  simp -- a\n  exact foo x--note\n  omega");
  });

  it("still blanks a comment where Lean reads one: after a space, a line break, the start or another comment", () => {
    ok("", "  simp\n  exact foo -- run_cmd 1");
    ok("", "  simp\n  -- #eval 1\n  exact foo /- run_cmd 1 -/");
    ok("", "-- #eval 1\n  simp");
    ok("", "  simp /- a -/-- run_cmd 1\n  exact foo /- b -//- #eval 1 -/");
    ok("theorem aux_a : True := trivial -- sorry", "  exact aux_a");
    // A name that ends in `'`, after a token start, does not shake the reading: `x'`, `h1'`, `Nat.succ'`, `(h'`.
    ok("", "  simp\n  exact foo x' h1' -- run_cmd 1\n  exact (Nat.succ' h'') /- #eval 1 -/ y'");
  });

  it("does not take for a comment what Lean reads as a character literal, which takes the next two characters: ' -- #eval", () => {
    // `'`, a space and the first `-` are a literal (a broken one), so the second `-` is no comment and `#eval` is a command.
    const literal = ["  trivial\n  ' -- x #eval 7777", "  exact foo ' --'  x #eval 7777", "  trivial\n  '\n  -- x #eval 7777", "  trivial\n  ''' -- x #eval 7777", "  trivial\n  (f x)' -- #eval 7777", "  trivial\n  1' -- #eval 7777"];
    for (const proof of literal) refused("", proof, /proof: '#eval' is not allowed/);
    refused("theorem aux_a : True := by trivial ' -- #eval 1", "  simp", /aux: '#eval' is not allowed/);
    // A symbol token of Mathlib that ends like a name is followed by a literal where a name would have ended; the table is not known.
    refused("", "  trivial\n  exact ⟪x, y⟫_' -- #eval 7777", /proof: '#eval' is not allowed/);
    refused("", "  trivial\n  exact a ≡ b [MOD' -- #eval 7777", /proof: '#eval' is not allowed/);
    // A literal that Lean reads whole does not hide a `--` it holds, but the screen cannot tell: it refuses the keyword in what follows.
    refused("", "  trivial\n  exact f 'a' -- #eval 7777", /proof: '#eval' is not allowed/);
    // Comments before the quote are blanked, a `'` that ends a name does not turn the reading off, and neither does one in a comment.
    ok("", "  trivial -- #eval 1\n  exact f x' -- #eval 1\n  -- it's fine\n  /- don't -/ simp");
  });

  it("does not take for a comment what Lean reads as the opener of a longer comment: the character after /- is part of it", () => {
    // `/-/` opens a comment and `/-/-/` is one whole comment, so `-/ #eval 7777` is code.
    refused("", "  trivial\n  /-/-/ -/ #eval 7777 -- -/", /proof: '#eval' is not allowed/);
    refused("", "  trivial\n  /-/--/ #eval 7777 -- -/", /proof: '#eval' is not allowed/);
    refused("", "  trivial\n  /-\t-/ #eval 7777", /proof: '#eval' is not allowed/);
    refused("theorem aux_a : True := trivial\n/-/-/ -/ #eval 1 -- -/", "  simp", /aux: '#eval' is not allowed/);
    // After a space, a line break or the end of the text, nothing changes.
    ok("", "  simp\n  /- #eval 1 /- nested -/ run_cmd 1 -/ omega\n  /-\n #eval 1\n -/");
    refused("", "  simp /-", /a block comment is not closed/);
  });

  it("does not take for a comment what Lean reads as a doc comment, whose white space and body it reads on other terms", () => {
    // `/--` and `/-!` are tokens: after them a `--` is a line comment (the `/-` in it opens nothing), and the body starts after it.
    refused("", "  trivial\n  /-- -- /-\n-/ #eval 7777 -- -/", /proof: '#eval' is not allowed/);
    refused("theorem aux_a : True := trivial\n/-! -- /-\n-/ #eval 1 -- -/", "  simp", /aux: '#eval' is not allowed/);
    refused("", "  trivial\n  /--/ #eval 7777 -/", /proof: '#eval' is not allowed/);
    // A hole hides the same way, and `hasHoles` reads the same text.
    refused("", "  trivial\n  /-- -- /-\n-/ sorry -- -/", /proof: 'sorry' is not allowed/);
    assert.equal(hasHoles({ aux: "", proof: "  trivial\n  /-- -- /-\n-/ sorry -- -/" }), true);
    // The price: a doc comment is code to the screen, so are the comments after it.
    ok("/-- helper for the bound -/\ntheorem aux_a : True := trivial", "  exact aux_a");
    refused("/-- helper -/\ntheorem aux_a : True := trivial -- sorry", "  exact aux_a", /aux: 'sorry' is not allowed/);
    refused("", "  trivial\n  /-- the macro -/", /proof: 'macro' is not allowed/);
  });

  it("does not take a run of letters after a character literal for a name: ' xrun_cmd is a literal and a command", () => {
    refused("", "  trivial\n  ' xrun_cmd IO.println 1", /proof: 'run_cmd' is not allowed/);
    refused("", "  trivial\n  '(xelab foo", /proof: 'elab' is not allowed/);
    refused("theorem aux_a : True := by trivial ' xmacro", "  simp", /aux: 'macro' is not allowed/);
    ok("", "  trivial\n  exact (hsorry x') -- fine, the name comes before the quote");
  });

  it("pins the price of the strict reading: after a quote that may start a literal, the comments that follow are screened as code", () => {
    refused("", "  simp [h']\n  -- not the macro", /proof: 'macro' is not allowed/);
    refused("", "  exact ⟨x', h⟩ -- the Lean way", /proof: 'Lean' is not allowed/);
    refused("", '  exact s ⁻¹\' t -- "quoted"', /string literals are not allowed/);
    ok("", "  exact (f x') -- not the way\n  simp [ h' ] -- a space avoids it");
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

describe("hasHoles", () => {
  it("finds a hole behind an opener that a token has swallowed, which Lean reads as code, and not in a comment", () => {
    assert.equal(hasHoles({ aux: "", proof: "  exact foo <-- sorry" }), true);
    assert.equal(hasHoles({ aux: "theorem aux_a : True := by trivial //- admit -/", proof: "  simp" }), true);
    assert.equal(hasHoles({ aux: "", proof: "  exact foo -- sorry" }), false);
    assert.equal(hasHoles({ aux: "", proof: "  exact foo /- admit -/" }), false);
  });

  it("finds a hole that a character literal, the character after /- or a doc comment would hide", () => {
    for (const proof of ["  ' -- sorry", "  /-/-/ -/ sorry -- -/", "  /-- -- /-\n-/ admit -- -/", "  /-! -- /-\n-/ sorry -- -/"]) assert.equal(hasHoles({ aux: "", proof }), true, proof);
    assert.equal(hasHoles({ aux: "", proof: "  exact f x' -- sorry\n  /- admit -/" }), false);
    assert.equal(hasHoles({ aux: "", proof: "  ' xsorry" }), true);
    assert.equal(hasHoles({ aux: "theorem aux_a : True := by ' xadmit", proof: "  simp" }), true);
    assert.equal(hasHoles({ aux: "", proof: "  exact (xsorry) ' a" }), false);
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
    const swallowed = await validator.validate(sketch, withProof("  simp\n  exact foo <-- #eval 1"), reference);
    assert.equal(swallowed.verdict, "invalid");
    assert.match(swallowed.reasons.join(), /proof: '#eval' is not allowed/);
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

describe("regions on which a real Lean ran a command", () => {
  // Recorded with Lean 4.27.0 (Init only) by the Task 7 re-review of 2026-10-27: random regions after a tactic block, a
  // declaration or a definition, each with the payload `#eval 7777` somewhere in it; the payload ran in these (see the README of
  // the fixtures). Lean is not run here. The screen must refuse every one of them, whatever the reason it gives.
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/lean-oracle-regions.json", import.meta.url), "utf8")) as {
    lean: string;
    payload: string;
    missed: string[];
    sample: string[];
  };

  it("is the recording its header says: a few hundred regions that earlier screens accepted, and a seeded sample of the others", () => {
    assert.equal(recorded.lean, "4.27.0");
    assert.equal(recorded.payload, "#eval 7777");
    assert.ok(recorded.missed.length >= 600 && recorded.sample.length >= 3000);
    for (const region of [...recorded.missed, ...recorded.sample]) assert.ok(region.includes("#eval 7777"), JSON.stringify(region));
    assert.equal(new Set([...recorded.missed, ...recorded.sample]).size, recorded.missed.length + recorded.sample.length);
  });

  it("is refused by the token screen in every case: the payload is seen as code, or the region holds a string, a «» name or an open comment", () => {
    const accepted = [...recorded.missed, ...recorded.sample].filter((region) => {
      const scan = scanRegion(region);
      return scan.problems.length === 0 && !forbiddenTokensIn(scan.masked).includes("#eval");
    });
    assert.deepEqual(accepted.slice(0, 20), []);
    assert.equal(accepted.length, 0);
  });

  it("is refused by structuralCheck as the proof region, and as an auxiliary region after a theorem", () => {
    const accepted = [...recorded.missed, ...recorded.sample].filter((region) => structuralCheck({ aux: "", proof: region }).length === 0 || structuralCheck({ aux: `theorem aux_a : True := trivial\n${region}`, proof: "  simp" }).length === 0);
    assert.deepEqual(accepted.slice(0, 20), []);
    assert.equal(accepted.length, 0);
  });
});
