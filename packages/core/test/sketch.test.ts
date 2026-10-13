import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import {
  AUX_BEGIN,
  AUX_END,
  assemble,
  editedOutsideRegions,
  extractSubmission,
  namespacesAt,
  PROOF_BEGIN,
  PROOF_END,
  prepareSketch,
  readDeclarationHead,
  renderSketch,
  SketchError,
  splitCommands,
} from "../src/index.ts";

const fixture = readFileSync(new URL("./fixtures/erdos-125.lean", import.meta.url), "utf8");

describe("lean-source", () => {
  it("cuts a file into commands, an attribute on its own lines going with its declaration", () => {
    const source = [
      "/-! # Title -/",
      "namespace A",
      "/-- doc -/",
      "@[simp, category test,",
      "AMS 11]",
      "-- a note",
      "theorem t (x : ℕ) :",
      "    x = x := by",
      "  rfl",
      "",
      "end A",
      "",
    ].join("\n");
    const commands = splitCommands(source);
    assert.deepEqual(
      commands.map((c) => [c.kind, c.text.split("\n")[0]]),
      [
        ["comment", "/-! # Title -/"],
        ["code", "namespace A"],
        ["docstring", "/-- doc -/"],
        ["code", "@[simp, category test,"],
        ["code", "end A"],
      ],
    );
    assert.equal(readDeclarationHead((commands[3] as { text: string }).text)?.name, "t");
    assert.deepEqual(namespacesAt(commands), [[], [], ["A"], ["A"], ["A"]]);
  });

  it("reads declaration heads through attributes and modifiers", () => {
    const head = readDeclarationHead("@[simp] private noncomputable def aux_f (x : ℕ) : ℕ := x");
    assert.equal(head?.keyword, "def");
    assert.equal(head?.name, "aux_f");
    assert.equal(readDeclarationHead("theorem erdos_1.variants.b : True := trivial")?.name, "erdos_1.variants.b");
  });

  it("tracks nested namespaces and sections", () => {
    const source = "namespace A.B\nsection\nnamespace C\ndef x := 1\nend C\nend\ndef y := 2\nend A.B\ndef z := 3\n";
    assert.deepEqual(namespacesAt(splitCommands(source)), [[], ["A", "B"], ["A", "B"], ["A", "B", "C"], ["A", "B", "C"], ["A", "B"], ["A", "B"], ["A", "B"], []]);
  });
});

describe("prepareSketch on a formal-conjectures file", () => {
  const target = "erdos_125.variants.positive_lower_density";
  const sketch = prepareSketch(fixture, target);

  it("finds the target with its namespace, docstring and attributes", () => {
    assert.equal(sketch.fullName, "Erdos125.erdos_125.variants.positive_lower_density");
    assert.ok(sketch.header.startsWith("/--\nLiterature question:\nDoes $A + B$ have positive lower density?"));
    assert.ok(sketch.header.includes("@[category research solved, AMS 11,"));
    assert.ok(sketch.header.endsWith("answer(False) ↔ 0 < (A + B).lowerDensity := by"));
    assert.equal(sketch.originalProof, "sorry");
    assert.equal(sketch.indent, "  ");
  });

  it("gives back the original file when nothing is edited", () => {
    assert.equal(assemble(sketch, { aux: "", proof: sketch.originalProof }, false), fixture);
    for (const name of ["erdos_125", "erdos_125.variants.zero_density", "erdos_125.variants.positive_unequal_density"]) {
      const other = prepareSketch(fixture, name);
      assert.equal(assemble(other, { aux: "", proof: other.originalProof }, false), fixture, name);
    }
  });

  it("keeps the prover's line numbers in the checked file", () => {
    const rendered = renderSketch(sketch);
    assert.equal(rendered.split("\n").filter((l) => l.trim() === AUX_BEGIN).length, 1);
    const edited = rendered
      .replace(`${AUX_END}\n`, `theorem aux_digits (n : ℕ) : n = n := rfl\n\n@[simp]\nlemma aux_two : 2 = 2 := rfl\n${AUX_END}\n`)
      .replace(`  ${PROOF_BEGIN}\n  sorry\n`, `  ${PROOF_BEGIN}\n  constructor\n  · intro h\n    exact h.elim\n  · simp\n`);
    const submission = extractSubmission(edited);
    assert.equal(submission.proof, "  constructor\n  · intro h\n    exact h.elim\n  · simp");
    assert.equal(assemble(sketch, submission), edited);
    assert.equal(editedOutsideRegions(sketch, edited), false);
  });

  it("discards edits outside the regions and says so", () => {
    const rendered = renderSketch(sketch);
    const cheating = rendered.replace("answer(False) ↔ 0 < (A + B).lowerDensity", "True");
    assert.equal(editedOutsideRegions(sketch, cheating), true);
    assert.equal(assemble(sketch, extractSubmission(cheating)), rendered);
  });

  it("asks for the markers back when they are broken", () => {
    const rendered = renderSketch(sketch);
    assert.throws(() => extractSubmission(rendered.replace(PROOF_END, "")), /exactly one line '-- HARNESS:PROOF:END', found 0/);
    assert.throws(() => extractSubmission(rendered.replace(AUX_BEGIN, `${AUX_BEGIN}\n${AUX_BEGIN}`)), SketchError);
    const swapped = rendered.replace(AUX_BEGIN, "@@").replace(AUX_END, AUX_BEGIN).replace("@@", AUX_END);
    assert.throws(() => extractSubmission(swapped), /out of order/);
  });
});

describe("prepareSketch edge cases", () => {
  it("turns a term-mode sorry into a tactic block", () => {
    const sketch = prepareSketch("namespace W\n\ntheorem w_3 : answer(True) ↔ 1 = 1 := sorry\n\nend W\n", "w_3");
    assert.equal(sketch.fullName, "W.w_3");
    assert.equal(sketch.header, "theorem w_3 : answer(True) ↔ 1 = 1 := by");
    assert.equal(sketch.originalProof, "sorry");
    assert.equal(
      renderSketch(sketch),
      `namespace W\n\n${AUX_BEGIN}\n${AUX_END}\ntheorem w_3 : answer(True) ↔ 1 = 1 := by\n  ${PROOF_BEGIN}\n  sorry\n  ${PROOF_END}\n\nend W\n`,
    );
  });

  it("skips the := of a let in the statement, even one with a tactic block", () => {
    assert.equal(prepareSketch("theorem t : let n := 3; n = 3 := by\n  sorry\n", "t").header, "theorem t : let n := 3; n = 3 := by");
    const source = [
      "theorem c (p : ℝ) (h : p < 1) :",
      "    letI hp : p ≤ 1 := by",
      "      have : p ≤ 1 := le_of_lt h",
      "      exact this",
      "    p + 0 ≤ 1 := by",
      "  sorry",
      "",
    ].join("\n");
    const sketch = prepareSketch(source, "c");
    assert.ok(sketch.header.endsWith("    p + 0 ≤ 1 := by"));
    assert.equal(sketch.originalProof, "sorry");
    assert.equal(assemble(sketch, { aux: "", proof: "sorry" }, false), source);
  });

  it("handles _root_ names and refuses missing or duplicate targets", () => {
    assert.equal(prepareSketch("namespace A\ntheorem _root_.foo : True := by\n  trivial\nend A\n", "_root_.foo").fullName, "foo");
    assert.throws(() => prepareSketch("theorem a : True := by trivial\n", "b"), /not found/);
    assert.throws(() => prepareSketch("theorem a : True := by trivial\ntheorem a : True := by trivial\n", "a"), /declared twice/);
    assert.throws(() => prepareSketch("theorem a : True\n", "a"), /no proof found/);
  });

  it("tells same-named theorems apart by their full names", () => {
    const source = "namespace A\ntheorem t : True := by\n  trivial\nend A\nnamespace B\ntheorem t : 1 = 1 := by\n  rfl\nend B\n";
    assert.throws(() => prepareSketch(source, "t"), /declared twice; use its full name/);
    assert.equal(prepareSketch(source, "B.t").header, "theorem t : 1 = 1 := by");
  });

  it("turns a term proof into exact", () => {
    const sketch = prepareSketch("theorem t (n : ℕ) : n = n :=\n  (rfl :\n    n = n)\n", "t");
    assert.equal(sketch.header, "theorem t (n : ℕ) : n = n := by");
    assert.equal(sketch.originalProof, "exact (rfl :\n  n = n)");
  });
});

// Runs on a formal-conjectures checkout when one is around (FORMAL_CONJECTURES_DIR, or next to this repo).
const corpus = process.env.FORMAL_CONJECTURES_DIR ?? join(import.meta.dirname, "../../../../google-deepmind/formal-conjectures");

function leanFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return leanFiles(path);
    return name.endsWith(".lean") ? [path] : [];
  });
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The sketch's fixed parts are the file's own text, and the proof between them is the original one. */
function reassembles(source: string, sketch: ReturnType<typeof prepareSketch>): boolean {
  if (!source.startsWith(sketch.prefix) || !source.endsWith(sketch.suffix)) return false;
  const middle = source.slice(sketch.prefix.length, source.length - sketch.suffix.length);
  const header = middle.startsWith(sketch.header) ? sketch.header : sketch.header.slice(0, -" by".length);
  if (!middle.startsWith(header)) return false;
  const proof = middle.startsWith(sketch.header) ? sketch.originalProof : sketch.originalProof.replace(/^exact /, "");
  return flat(middle.slice(header.length)) === flat(proof);
}

describe("prepareSketch on every research-solved theorem of formal-conjectures", { skip: !existsSync(join(corpus, "FormalConjectures")) }, () => {
  it("cuts each one and gives back the original file", () => {
    let count = 0;
    let withProof = 0;
    const failures: string[] = [];
    for (const path of leanFiles(join(corpus, "FormalConjectures"))) {
      const source = readFileSync(path, "utf8");
      const commands = splitCommands(source);
      const scopes = namespacesAt(commands);
      commands.forEach((command, k) => {
        if (command.kind !== "code" || !/category\s+research\s+solved/.test(command.text)) return;
        const head = readDeclarationHead(command.text);
        if (!head || (head.keyword !== "theorem" && head.keyword !== "lemma")) return;
        count++;
        const fullName = [...(scopes[k] ?? []), head.name].join(".");
        const where = `${relative(corpus, path)}: ${fullName}`;
        try {
          const sketch = prepareSketch(source, fullName);
          if (sketch.originalProof !== "sorry") withProof++;
          if (!reassembles(source, sketch)) failures.push(`${where}: does not reassemble`);
          if (sketch.fullName !== fullName) failures.push(`${where}: full name ${sketch.fullName}`);
        } catch (error) {
          failures.push(`${where}: ${(error as Error).message}`);
        }
      });
    }
    console.log(`research-solved theorems: ${count}, with a proof in the file: ${withProof}, failures: ${failures.length}`);
    for (const failure of failures.slice(0, 30)) console.log(`  ${failure}`);
    assert.ok(count > 2000, `expected the corpus to have over 2000 such theorems, found ${count}`);
    assert.deepEqual(failures, []);
  });
});
