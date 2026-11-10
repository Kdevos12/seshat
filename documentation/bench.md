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

## A bench of one problem

`harness solve` ([quickstart.md](quickstart.md#harness-solve)) writes a checkout of one file and an index of one problem under the run directory (`problem/Solve.lean`, `problem/index.json`): `category` `research open`, no AMS code, `benchId` `solve-HASH`, the source `local:HASH`. The index has the shape and the hash check of the bench's and is read by `readIndex`, so `harness resume RUN_DIR --checkout RUN_DIR/problem --bench RUN_DIR/problem/index.json` takes it like any other.

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

## The graded bench (CA1)

The bench of 575 research results cannot show a gain: today's harness solves few of them. `bench/graded-v1.json` is the yardstick of the capability plan change ([plan-change-capabilities.md](../plans/plan-change-capabilities.md), section 2): three grades, on which the harness does not score zero. (Not the escalation ladder of line M12: "grade" is the word here.) It is built by `harness-bench graded` from local checkouts, and nothing of the sources is vendored.

| Grade | Level | Source | Rule |
|---|---|---|---|
| A | exercise | formal-conjectures at the bench tag | every `textbook` and `test` theorem with discrete AMS codes only (05, 06, 08, 11, 20), without `sorry` in the statement, not proved in its file, no sorried definition above it |
| B | competition | PutnamBench (`lean4/src`) | a seeded sample of 100 of its problems, with the same last three conditions (a Putnam problem whose answer is a definition still `sorry`, `..._solution`, is left out: the sketch cannot fill it) |
| C | research | formal-conjectures | a seeded sample of at most 70 of `fc-bench-v1-discrete`'s problems with a formal proof elsewhere (`formal_proof`) |

```sh
node packages/bench/src/cli.ts graded --fc ../formal-conjectures --putnam ../PutnamBench --seed graded-v1 \
  --lean-project lean/env/base --out bench/graded-v1.json      # [--size-b 100] [--size-c 70]
```

- **The file.** `v`, `kind: "graded"`, `benchId`, the `seed` of the samples, `sources` (repository, commit, tag, Lean toolchain and licence of each checkout), `grades` (what each rule is, the number of candidates, entries and statements Lean rejected) and `entries`, with a `hash` of all of it that reading checks. Each entry is a problem entry of the bench (statement, file hash, imports) with its `grade`, `source`, `sourceCommit`, `statementHash` (sha256 of the statement), `licence` and `admission`.
- **The sample is seeded.** Candidates are put in the order of the hash of the seed, the grade and their id, and the sample is the first ones: the same seed and checkouts give the same sample (`sample` of this page is that prefix), and a statement Lean rejects is replaced by the next one.
- **Admission.** A statement is admitted only when it compiles under the Lean environment: the file up to the theorem, its proof `sorry`, is run with `lake env lean` in the project of `lean/env/base` (`--lean-project`, built by `harness lean-env build base`). A statement Lean cannot read is never an "unsolved" problem. Without `--lean-project` the builder records every entry as `unchecked`, and a run refuses unchecked entries unless it is given `--allow-unchecked`.
- **Running.** `harness run` and `harness ablate` take `--bench bench/graded-v1.json --grade A|B|C` (`--allow-unchecked` for an unchecked file). Every entry of a grade has one source, so one `--checkout` serves a run: formal-conjectures for A and C, PutnamBench for B. A grade needs the bench to be graded, and `--grade` is refused with an ordinary index.
- **PutnamBench's layout.** It writes `theorem name`, then each binder and the statement at column 0. The command splitter of `@seshat/core` treats a line that begins with `(`, `{`, `[`, `⦃` or `:` as a continuation, since no Lean command starts with one (a change to `splitCommands`, tested in `sketch.test.ts`); formal-conjectures files read as before.

What was and was not done where this was written. The sources could be fetched (a shallow `git clone` of each into a temporary directory): formal-conjectures at `bench-v1-lean4.27.0` gave 111 grade A candidates and 70 for grade C (the whole of the 70 with a formal proof elsewhere), PutnamBench's default branch (commit `a635813f`) gave 326 candidates for a sample of 100, all unchecked. **No index is committed**: no Lean was available to admit the statements, and an unchecked file would be refused by every run. PutnamBench's head is on Lean v4.33.1, not v4.27.0, so a commit of it that builds under the base environment is still to find (or its own environment through `lean/env/NAME.toml`, as M17 does), and the licences are read from the checkouts' LICENSE files (Apache-2.0 for formal-conjectures and for PutnamBench's Lean part) and are to be confirmed before an index is shared. The builder is tested on fixture checkouts and with a fake `lake`. Not run: the real sources through a real admission, and any run on a grade.

## Commands

```sh
node packages/bench/src/cli.ts stats --checkout ../formal-conjectures
node packages/bench/src/cli.ts build --checkout ../formal-conjectures --id fc-bench-v1-discrete --out bench/fc-bench-v1-discrete.json
```

`build` also takes `--ams 5,11`, `--include-proof-in-file` and `--annotations FILE`. `sequences`, `tags` and `ext` are described above. Two API lemmas of the snapshot,
proved by pattern matching, cannot be cut into sketches; the commands list them and go on.
