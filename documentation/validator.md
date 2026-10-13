# Problem sketches and the proof validator

## Sketches

A problem is a theorem in a Lean file. `prepareSketch(source, target)` cuts the file around the
target (given by its full name, or by its written name when that is unambiguous) into:

| Part | Content |
|---|---|
| `prefix` | Everything before the target's docstring. Fixed. |
| auxiliary region | Lemmas and definitions the prover adds before the target. Editable. |
| `header` | Docstring, attributes and `theorem name binders : type := by`. Fixed. |
| proof region | The tactic proof. Editable. |
| `suffix` | Everything after the proof. Fixed. |

The sketch also records the target's full name (namespaces included), its statement as written,
and the original proof. A term-mode proof becomes a tactic block: `:= sorry` becomes
`:= by sorry`, and `:= t` becomes `:= by exact t`.

The prover sees the file with its two regions between marker lines:

```lean
-- HARNESS:AUX:BEGIN (auxiliary lemmas go between this line and HARNESS:AUX:END)
theorem aux_two : 2 = 2 := rfl
-- HARNESS:AUX:END
@[category research solved, AMS 11]
theorem erdos_125.variants.positive_lower_density :
    answer(False) ↔ 0 < (A + B).lowerDensity := by
  -- HARNESS:PROOF:BEGIN
  sorry
  -- HARNESS:PROOF:END
```

`extractSubmission` reads the two regions back. Edits outside them are discarded and reported
(`editsOutsideRegions`), so the statement and its context cannot change. Missing, duplicated or
reordered markers are refused with a message asking to restore them.

The file that is checked has exactly the prover's lines, so Lean's line numbers are the prover's.

## Finding the proof

The proof starts at the first `:=` at bracket depth 0 that does not belong to a `let`, `letI`,
`have` or `haveI` of the statement. With `:= by`, the tactic block must run to the end of the
declaration: Lean ends a block at the first line indented less than its first tactic, so a block
that stops earlier belongs to the statement. This handles statements such as:

```lean
theorem c (p : ℝ) (h : p < 1) :
    letI hp : p ≤ 1 := by
      exact le_of_lt h
    p + 0 ≤ 1 := by
  sorry
```

The scanner (`packages/core/src/lean-source.ts`) does not parse Lean. It cuts a file into commands
at lines that start at column 0 outside comments, strings and brackets. An attribute or an
`open ... in` on its own lines belongs to the declaration below it. A line at column 0 still
belongs to the previous command when that command cannot stop where it did (after `:`, `,`, an
arrow, a connective or a relation), or when it starts with `|`.

It is tested on every research-solved theorem of formal-conjectures, at the `bench-v1-lean4.27.0`
snapshot (840 theorems) and at the current main branch (2409): every one is cut and reassembles
into its original file.

## Plain-header form

`toPlainHeader` rewrites a file, line for line, so that its first non-blank lines are its imports:
comments and `module` before the last import become blank lines, `public import` and
`meta import` become `import`, and `@[expose] public section` becomes `section`. Lean REPL servers
take the leading imports as the header, and with this form they report the same line numbers as
the file on disk ([lean.md](lean.md#kimina-lean-server)). Problem files are always used in this
form.

## The fast check

`ProofValidator.validate(sketch, submitted, reference)`:

1. Extracts the two regions and rebuilds the file from the fixed parts.
2. Runs the structural checks below. A refused submission never reaches Lean, so nothing in it
   runs.
3. Sends the file to the `LeanChecker` with these commands appended:

   ```lean
   #print axioms Full.Name
   set_option pp.all true in
   set_option pp.maxSteps 100000000 in
   #check @Full.Name
   ```

   `pp.maxSteps` is raised so that a large statement is never printed with `⋯` for a subterm.
4. Accepts the proof when Lean reports no error in the file, the axioms are a subset of
   `propext`, `Classical.choice` and `Quot.sound`, and the printed type equals the reference.

The reference comes from `ProofValidator.reference(sketch, originalSource)`, which runs the
original file with the same commands, once per problem, and fails if the file has errors.

Messages are split by line: those in the file go back to the prover; the axioms message is the
info on the line of `#print axioms`; the type is the only other info message after it.

A pass makes a candidate. `ProofValidator.certify` hands a candidate to the `LeanCertifier`, when
one is configured ([trust.md](trust.md#two-levels-of-checking)).

## Structural checks

Both regions are scanned with comments blanked. Refused anywhere in the regions:

- string literals and `«»` names, because a light scanner cannot follow interpolated strings
  exactly, and a scanner that disagrees with Lean about where a comment starts would let tokens
  hide from the checks; an unclosed block comment;
- ways to skip or weaken a proof: `sorry`, `admit`, `axiom`, `native_decide`, `ofReduceBool`,
  `ofReduceNat`, `trustCompiler`, `implemented_by`, `extern`, `unsafe`, `debug`, `skipKernelTC`;
- commands and attributes that run code or change the syntax: `#eval`, `#exit`, `#print`,
  `run_cmd`, `run_elab`, `run_meta`, `run_tac`, `by_elab`, `eval%`, `elab`, `elab_rules`, `macro`,
  `macro_rules`, `syntax`, `declare_syntax_cat`, `notation`, `infix`, `infixl`, `infixr`, `prefix`,
  `postfix`, `initialize`, `builtin_initialize`, `import`, `tactic`, `command_elab`, `term_elab`,
  `delab`, `app_unexpander`, `simproc`, `dsimproc`, `simproc_decl`, `register_option`,
  `register_simp_attr`;
- the meta level, which a proof of a mathematical statement never needs: `Lean` (also as
  `_root_.Lean`), `Meta`, `Elab`, `MetaM`, `TacticM`, `CoreM`, `TermElabM`, `CommandElabM`, `IO`,
  `unsafeIO`, `unsafeBaseIO`, `unsafeEIO`, `Environment`, `setEnv`, `modifyEnv`, `addDecl`,
  `addDeclCore`, `addDeclWithoutChecking`, `addAndCompile`.

Tokens match whole identifiers only: `Nat.sorry_lemma` would not match `sorry`.

In the auxiliary region, each command must be a `theorem`, `lemma`, `def` or `abbrev` (optionally
after `open ... in` or `set_option ... in`), named `aux_...` so that it cannot shadow a name of the
statement, with no attribute other than `simp`, `reducible`, `irreducible` and `local simp`.

The proof region must not be empty.

These checks keep the usual shortcuts and code execution out of the REPL. They are not what makes
a proof trusted; the Lean checks and certification are.

## Reports

`ValidationReport` carries `verdict` (`valid` or `invalid`), `method` (`repl`), `reasons`, the
target's `axioms`, the Lean `messages` and `sorries` located in the prover's file, the `checked`
file, the `submissionHash`, `editsOutsideRegions`, and the checker's status.
