# Bench

## Source

Problems come from [formal-conjectures](https://github.com/google-deepmind/formal-conjectures)
(Apache-2.0), a repository of research problems stated in Lean. Each theorem carries
`@[category ...]` (`research open`, `research solved`, `test`, `API`, `textbook`), AMS subject
codes, and sometimes `formal_proof using <kind> at "<url>"` pointing to a formal proof elsewhere.
Many statements use `answer(...)` for the answer to a yes/no question.

The bench is pinned to the tag `bench-v1-lean4.27.0` (commit `7a41db3d`, May 2026, Lean v4.27.0).
Benchmark tags are immutable and are the snapshots the repository's authors publish for
comparison, so results stay comparable with theirs. The scanner also reads the current main
branch (Lean v4.33.1, every file a `module`), which has about three times as many solved problems,
for later benches.

## The first bench: `fc-bench-v1-discrete`

The filter `DISCRETE` (`packages/bench/src/bench.ts`) keeps a theorem when:

- its category is `research solved`;
- every one of its AMS codes is in 05 (combinatorics), 06 (order, lattices), 08 (general algebraic
  systems), 11 (number theory) or 20 (group theory), so an analytic number theory problem tagged
  11 and 30 is left out;
- its statement holds no `sorry` (`answer(sorry)` means the answer itself is unknown);
- its file does not already prove it, since the file might then also hold lemmas made for that
  proof;
- no definition above it in its file uses `sorry`, and no axiom or opaque constant is declared
  there.

At `bench-v1-lean4.27.0`:

| Step | Theorems |
|---|---|
| Theorems with a category | 2618 |
| `research solved` | 840 |
| with discrete AMS codes only | 623 |
| without `sorry` in the statement (−11), not proved in the file (−36), clean context (−1) | 575 |

The 575 problems come from 284 files: Erdős problems 432, Green's open problems 56, Wikipedia 56,
Written on the Wall II 12, papers 8, arXiv 5, OEIS 4, others 2. By AMS codes: 11 alone 351,
05 alone 107, 05 and 11 107, 20 alone 7, others 3. 85 have an `answer` (53 `True`, 32 `False`);
70 point to a formal proof elsewhere.

These are research results: most have no known formal proof, and a low solve rate is expected.
If the ablations need more signal, an easier tier (the 70 with a formal proof, discrete
`textbook` problems) can be added as a separate bench.

## Index

`bench/fc-bench-v1-discrete.json` is committed. It holds the source (`repo`, `rev`, `tag`, `lean`),
the filter, counts, the problems, and a `hash` of all of it. Reading an index checks the hash, so a
bench cannot change without its hash changing. A test rebuilds the index from the pinned snapshot,
when it is on disk, and compares hashes.

Each problem has:

| Field | Meaning |
|---|---|
| `id` | `<path>#<full name>`, stable across runs. |
| `path`, `line` | File in the checkout and line of the `theorem` keyword. |
| `fullName`, `declaredName` | Name with namespaces, and as written. |
| `category`, `ams`, `formalProof`, `answer` | From the attributes and the statement. |
| `statement`, `statementId` | Binders and type as written, and their `st0_` id (of the statement alone: a run with lines names the problem's claim by the statement and its file's prefix). |
| `fileHash` | sha256 of the file in plain-header form, checked before a run uses it. |
| `imports` | The file's imports. |
| `proofInFile`, `sorryInStatement`, `unprovedBefore` | What the filter looked at. |

`sample(problems, n, seed)` takes a deterministic subset: the `n` problems whose hash with the seed
is smallest.

## Sequences

An index built from Task 14 on also holds `sequences`: lists of related problems, built from the checkout's structure alone, for the lemma library (line M3). A problem solved early leaves lemmas the later ones can use, so a run that works a sequence in order measures what the library gives; `--memory-from` chains runs, and `--split` of `harness ablate` measures a library built on one part of the bench on another.

| Kind | Id | Members, in order |
|---|---|---|
| `variants` | `variants:<path>#<stem>` | the problem `<stem>`, then its variants (`<stem>.variants.<name>`) by line |
| `file` | `file:<path>` | every problem of a file with at least two, by line (they share its definitions) |

A sequence has at least two problems. An index without the field (the committed one predates it) gets them computed (`sequencesOf`). `harness run --sequence ID` (or `harness ablate`) works one in order, with `--concurrency 1` forced, so that an earlier problem is done before a later one starts; `harness-bench sequences --index FILE` lists them.

## Tags: analogy and induction

Problems tagged with an analogy or an induction are the inputs the lines that look for them need (M8 for induction; analogy cards). The tags are written by a person in `bench/annotations.json` and checked; `harness-bench build --annotations FILE` refuses a file that does not fit the bench and puts the tags in the index (`tags`, by problem id, and part of the hash).

```json
{ "v": 1, "tags": [
  { "problem": "<bench problem id>", "kind": "induction", "note": "induction on n over the sum, base case trivial", "by": "name" },
  { "problem": "<bench problem id>", "kind": "analogy", "with": "<bench problem id>", "note": "the same argument with 2 for 1" },
  { "problem": "<bench problem id>", "kind": "analogy", "withText": "a result outside the bench", "note": "..." } ] }
```

Rules (`harness-bench tags validate --index FILE --annotations FILE`): the problem is in the bench; the kind is `analogy` or `induction`; the note (at least 10 characters) says why; an analogy names what it is an analogue of with exactly one of `with` (a bench problem other than itself) or `withText`; only an analogy has them; no tag twice; no unknown field. `harness-bench tags suggest --index FILE` only proposes candidates from the shape of the statements (a natural number quantified over a sum, a product, a power or a factorial; two statements of one shape in two files): a suggestion is not a tag. `harness run --tag induction` runs the problems that carry a tag. No annotations file is committed: the tags are the team's to write.

## bench-ext: the equational-theories data

`bench-ext` (plan change PD6) reads the equational-theories challenge's data (the SAIR Foundation's benchmark dataset) and turns each row, an implication between two equations of a magma, into a problem: a Lean statement over `Mul`, as an implication when the answer is true and as a counter-magma `∃ (G : Type) (_ : Mul G), ...` when it is false. It is there to measure the battery, the fingerprints and the first-order tools on implication problems.

- **Nothing downloads, nothing is vendored.** The rows are read from a local cache directory the user fills (`harness-bench ext convert --cache DIR`, `.jsonl` or `.json` files), or from a file of rows (`--rows FILE`). A missing cache is an error that says so. The tests use three hand-written rows.
- **The licence is not stated** where this was written: the command prints a reminder, and no row may be copied into a repository before the licence is read. The Lean judge package (`stage2-judge`) is Apache 2.0 on Reservoir. No submission to the challenge is planned; its rules are unread.
- **What a row may hold.** An id is 1 to 64 letters, digits, dots, dashes and underscores. An equation is two terms of variables, `◇`, and balanced parentheses; a variable may not be a Lean keyword or `G`, `Mul`, `sorry`. A row that fails these is refused at conversion, so a statement the judge cannot parse never becomes an "unsolved" problem that skews the share closed without a model. The step report counts a problem closed by the first valid fast check of its own claim, not by a proof of a negation or a certification.
- **The row shape is an assumption** from the dataset's description: `id`, `equation1`, `equation2` (written with `◇`), and `answer` (true or false), with the aliases `eq1`, `eq2`, `implies` and `name`. It must be checked against the real files the first time they are read.
- **The share closed without a model**, per step of plan section 15's order: `harness-bench ext steps RUN_DIR` reads the journal of a run over these problems and gives, for each problem, the first step that closed it (subsumption by M12, fingerprint or small model by M11, battery or ATP and SMT by M10, then the model), and the share closed without a model. The run itself, with Tasks 6 and 7, has not been made.

## Commands

```sh
node packages/bench/src/cli.ts stats --checkout ../formal-conjectures
node packages/bench/src/cli.ts build --checkout ../formal-conjectures --id fc-bench-v1-discrete --out bench/fc-bench-v1-discrete.json
```

`build` also takes `--ams 5,11`, `--include-proof-in-file` and `--annotations FILE`. `sequences`, `tags` and `ext` are described above. Two API lemmas of the snapshot,
proved by pattern matching, cannot be cut into sketches; the commands list them and go on.
