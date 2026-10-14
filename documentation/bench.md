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

## Commands

```sh
node packages/bench/src/cli.ts stats --checkout ../formal-conjectures
node packages/bench/src/cli.ts build --checkout ../formal-conjectures --id fc-bench-v1-discrete --out bench/fc-bench-v1-discrete.json
```

`build` also takes `--ams 5,11` and `--include-proof-in-file`. Two API lemmas of the snapshot,
proved by pattern matching, cannot be cut into sketches; the commands list them and go on.
