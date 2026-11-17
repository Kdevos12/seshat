# The lemma library (line M3)

Line `M3` ([lines.md](lines.md)) is a library of lemmas that grows from problem to problem: the auxiliary
lemmas a prover proves on the way to a proof are promoted when they are non-trivial and general, indexed, and
offered to the provers before Mathlib. The Nexus baseline throws these lemmas away; LEGO-Prover (ICLR 2024)
showed that reusing them pays. It is `createM3` in `@seshat/library` (`M3` is the line with its defaults); a run
enables it with `harness run --lines M3` and it requires no other line.

Whether it pays on this harness is not known: the share of accepted proofs that use a library lemma is in the
report ([Measured](#measured)), and the cost on a problem B after solving a neighbouring problem A is measured
by Task 14 on sequences of related problems (`harness run --sequence ID`, [bench.md](bench.md#sequences); `harness ablate --split N` builds the library on one part of the bench and measures it on another). Nothing here has run against a real Lean or model.

## Promotion

After each session `afterAttempt` reads the auxiliary region of the session's last check. An attempt whose proof the
fast check accepted (`outcome: valid`; `fromFailed` also takes failed ones) gives its **candidates**: the
declarations that are `theorem` or `lemma`, named `aux_...`, with a statement in signature form
([memory.md](memory.md#statement-form)) and a `:=` proof, read with the validator's own scanner
([validator.md](validator.md#finding-the-proof)). A candidate is left out, with the reason in the log, when it
is a `def`, has a hole, or uses another `aux_` declaration of the region (it would not stand alone). Each candidate is a
`library_candidate` node, `pending`.

When the problem ends (`afterProblem`, which may run twice for a problem and does not repeat a decision) the pending
candidates are judged, in order, each by three criteria; the first one it fails settles it:

| Criterion | How | If it fails |
|---|---|---|
| **Not a duplicate** | The statement's id (the run's identity, under the lemma's header) names a claim that already is a library lemma. Dedup is by statement id, so with the text identity only textual duplicates are caught, and with `LeanIdentity` (`st1_`) the elaborated statement decides ([memory.md](memory.md#claims)). | `duplicate` |
| **Non-trivial** | The non-triviality test ([below](#the-non-triviality-test)) says the battery's cheapest automation does not close the statement. | `trivial` |
| **General, and proved alone** | The lemma becomes a claim of its own (`origin: line:M3`) under the imports of the problem's header and nothing else, and its proof goes through `validate` ([lines.md](lines.md#validate)). The claim's reference file is `imports`, then the statement with `sorry`: there is no local definition, hypothesis or `open` in it, so a lemma that depends on the problem's context does not compile there. | `unproved` |

A candidate that passes all three is **promoted**: a `library_lemma` node on the lemma's claim. The claim is `computed`
after `validate` and `proved` when the certifier replays it (it is a line's submission for another claim, certified
when the problem ends like any: [lines.md](lines.md#validate)). The library never raises a status itself, and a lemma's
standing is its claim's: a lemma is offered only while its claim is `computed` or `proved`, and its status line says which (`computed` is the fast check; only `proved` is the certifier's replay, and only `proved` lemmas are written to `lean/SeshatLib` unless `harness library export --include-computed`, which marks the others). A claim an earlier run
established under another Lean environment is `open` again here ([memory.md](memory.md#memory-across-runs)), so
the library of an earlier run is not offered in a different environment, and a lemma that no longer compiles
([below](#compiled-again-when-mathlib-changes)) is not offered either. A promotion stops at `maxPerProblem` (10)
candidates a problem.

"General" means what the plan says and nothing more: no local definitions, no hypotheses of the target, only the
reference header's imports. The criterion is tested by Lean on the lemma alone, not by reading its text.

### The non-triviality test

`TrivialityTest` is `(question: {statement, header}, problem) => Promise<{trivial, by?}>`, an argument of
`createM3({isTrivial})`. The default, `cheapTacticTest`, sends one `lean.check` call (a tool run of `line:M3`) with the
statement closed by `rfl`, `trivial`, `decide`, `simp`, `omega`, `norm_num`, `ring`, `linarith` and `positivity`, one
file each and a time limit of 10 seconds each; the lemma is trivial when any file is `valid`. A call whose files all
failed in the server leaves the candidate pending. This is the default of Ruling 3; Task 6's battery (line M10, not
merged) plugs in as `isTrivial`, which is the only place that needs to change.

## What is stored

| Node kind | About | `data` |
|---|---|---|
| `library_candidate` | the problem's claim | `status` (`pending`, `promoted`, `duplicate`, `trivial`, `unproved`), `reason`, `problemId`, `claimId`, `attemptId`, `name`, `statement`, `proof`, `doc`, `header`, `libraryName` |
| `library_lemma` | the lemma's claim | `name` (`aux_lib_<stem>_<six digits of the statement id>`), `statementId`, `claimId`, `statement`, `proof` (tactics, no `by`), `doc`, `header` (the imports), `domain` (the problem's first, `msc:11`, or `general`), `gloss`, `source` (`problemId`, `claimId`, `attemptId`, `name`), `mathlibRev`, `leanEnv`, `promotedAt`, and after a compile again `checkedRev` and `stale` |
| `library_use` | the problem's claim | `attemptId`, `claimId`, `outcome`, `used`: the library lemmas and other declarations a submission names, each with its source |

The index, the counters and the report are rebuilt from these nodes and the claims' statuses (the line is
`resume: "stateless"`); nothing is kept in the process but a cache of the environment's declarations.
A library lemma carries no provenance stamp: it is a Lean fact, independent of the model that found it
(Global Constraint 16). The `mathlibRev` it records is the revision it was compiled under, for the next section.

### Compiled again when Mathlib changes

At the start of each problem (`beforeProvers`) every lemma whose claim is not `open` and whose `checkedRev`
(its `mathlibRev` before the first check) is not the run's Mathlib revision is compiled again as a file of its own
through `lean.check`: its imports, then its text. One that no longer compiles is marked `stale` and not offered; the node
and the claim stay in the journal. The library fails closed: a lemma is offered only once it was compiled under the run's
revision, so a lemma that Lean did not answer for (an error, a timeout, Lean down: the hook logs it and does not throw), or that
is past the limit of `maxRecheck` (50) lemmas a call, is withheld until a later call compiles it. With `recheck` off, a lemma
of another revision is never offered. The revision is the bench's, the plan's stand-in for Mathlib's: updating the bench checkout makes
every lemma due, whether or not Mathlib changed (the same limit as the epochs: [memory.md](memory.md#memory-across-runs)).
This is plan change PE1.

## Search

The index is a BM25 over three fields, name (weight 3), signature (2) and gloss (1), the method of TheoremGraph's own search (it
matches LeanSearch v2 without a model reranker). Words are split at camelCase, underscores and dots, lowercased, one-letter
words are dropped and every symbol of a statement (`∣`, `≤`, `+`) is a token. It is rebuilt from the memory each time it is
used (`BM25` over the usable lemmas is cheap at library size), so nothing can be stale.

The order of the results is by source first, then by score (plan change LC2), at most a few from each:

| Order | Source | Where it comes from | Shown as |
|---|---|---|---|
| 1 | this file | the declarations of the problem's file before the target (`localEntries`) | `[this file]` |
| 2 | the harness library | usable `library_lemma` nodes; each result carries a ready `aux_lib_...` lemma | `[library]` |
| 3 | extra packages | the declarations of the Lean environment's extra packages | `[PFR]`, `[LeanAPAP]`... |
| 4 | Mathlib | the declarations of Mathlib | `[Mathlib]` |

The caps are 3, 5, 3 and 5 (`DEFAULT_CAPS`). A result from a package says which module to import when the export knows
it and the problem's header does not have it.

**The export of the environment's declarations (LC2)** is an interface, `DeclarationExport = (env) => Promise<ExportedDeclaration[]>`
(`{name, signature, gloss?, package?, module?}`), an argument of `createM3({declarations})`. It is called once per
environment hash, as the run's registry pins it, and its answer is cached for the process, both for Mathlib and for the extra packages,
which are indexed with the same BM25 as the library. Task 21 provides the real export through `lean.meta`; until it is
plugged in, no declaration is exported and a search covers the file and the library. A test supplies a fixture. A failed export is
logged and tried again at the next call.

**Hybrid ranking (plan change PC5 item 2).** `ranking: "hybrid"` ranks each source by a convex combination of the
normalized BM25 and a hashed vector channel (cosine over hashed character trigrams, no model), with `bm25Weight`
(0.7) on BM25. The personalized-PageRank channel of the plan is not wired: `combine` takes any number of channels, and
`compareChannels(judged, channels)` is the rule that keeps the hybrid only if it beats the best single channel: it tunes the
weights on a grid on half of the judged queries and scores every channel and the hybrid, by mean reciprocal rank, on the
other half. The default is BM25 alone, because no judged queries exist yet; Task 14 makes them.

### What the provers see

- **The briefing section "Library"**, drawn: the top `briefingLemmas` (5) results for the problem's theorem name and statement, each
  with its source, the module to import for a package's, and for a library lemma its text, to paste into the auxiliary
  region (a problem's header is fixed and cannot import the library, so the lemma travels as text. This is a
  decision: `lean/SeshatLib/` is the compiled, reviewed copy, and a Lean environment can include it later). The section is
  unverified advice about which lemmas to look at, so it goes through the draw of [memory.md](memory.md#randomized-inclusion)
  as one item, `library:section`: a session may be denied it, and the report of the effect of the section is the memory's
  `itemEffect("library:section")`. The lemmas themselves are Lean-checked and are not what the draw withholds.
- **The tool `library_search`** (`{query, limit?}`), always offered unless `tool: false`: the same search, for words the
  prover chooses. It is not drawn.

### `lean.search`, pushed by the harness

The library's search is pulled: a briefing section and the tool `library_search`. The plan change CA22 adds a search the harness pushes
(`RunConfig.leanSearch`, [lean.md](lean.md#search-pushed-by-the-harness)): after a check with an unknown identifier or a hole, it asks the
capability `lean.search` and appends the hits that Lean confirms to the check's answer. It is a separate mechanism with its own backends
and does not read the library; a local index for it can be written from the same export of the environment's declarations
(`DeclarationExport`) as an `index` file of `{name, type, doc?}`. What it shows is Lean's `#check` text, never a gloss or a doc string a
backend returned, and its hits are not library lemmas: nothing is promoted or recorded from them.

## Schemas

The library also holds **schemas**, the shapes of decompositions that closed (line `M15`, [archive.md](archive.md), [schemas.md](schemas.md)): the node
kind `library_schema`, its data (`SchemaData`: the skeletons of the conclusion, the parts and the main proof, the family and region, the decompositions
it was made from, a state) and an index of its own, `SchemaIndex`, a BM25 over the shape of the conclusion, rebuilt from the nodes each time like the
lemmas'. They are in `packages/library/src/schemas.ts`; the line that makes and shows them is in `@seshat/scheduler`. A schema is learned from an
outcome and not proved, so unlike a lemma its node carries a provenance stamp ([memory.md](memory.md#provenance-and-epochs)), is shown only
through the randomized inclusion, and leaves use by its measured effect. Lemma search (`library_search`, the briefing section) does not read schemas.

## The Lean files

`harness library export RUN_DIR [--out DIR]` writes `SeshatLib/<Domain>.lean` under `lean/` (or `DIR`) from the memory of a
run and the runs it started on: one file per domain, module `SeshatLib.<Domain>` (`msc:11` is `Msc11`, Ruling 26), with the union of the
lemmas' imports, a namespace, and each usable lemma under a comment with its provenance (problem, attempt, claim, status,
statement id, Mathlib revision, environment, date). The files are generated and not to be edited. **Nothing compiles them here.** The
contract for a Lean host: every file of `lean/SeshatLib/` compiles with the environment's Lean (`lake env lean FILE`, or the files
sent through `lean.check`), and a lemma that does not is a bug in the journal's record, to be reported. A lemma proved under the bench's
header imports (`import FormalConjectures.Util.ProblemImports`) keeps that import, so its file compiles only in an
environment that has it; promoting a lemma to a bare `import Mathlib` header is not done.

### Measures and re-promotion

A pasted library lemma names itself in its own `theorem` line; that is not a use, so the report's share counts a lemma only when the rest of
the submission names it. A candidate whose lemma is already in the library with a `stale` proof is not a duplicate: a new proof that
`validate` accepts replaces the stale one in the same entry. A candidate of a failed attempt (`fromFailed`) that holds a token the validator
forbids is not read, since nothing has screened it.

### Glosses are screened

A lemma's gloss and the docstring pasted with it come from the prover's own prose (or, for a declaration of the file, the bench's), which
no check has verified. They are kept only if they pass the strict screen of `@seshat/memory` (`screenProse`): one line of at most 160
characters with no code, no Lean token the validator forbids, no link, no name that looks like a declaration and nothing that reads as
an instruction. Otherwise the lemma has no docstring and its gloss is "Auxiliary lemma NAME from THEOREM". The screen runs when a lemma
is promoted and again when an entry is built to be shown, so a journal written before it is covered.

## Definitions that are not reviewed

A statement that mentions a definition added by the library builder and not yet reviewed cannot be a claim, so it cannot be a library lemma either: the
candidate is settled `unproved` with that reason ([library-builder.md](library-builder.md#review-status-of-definitions)).

## Measured

The report ([m0-loop.md](m0-loop.md#the-report)) has a paragraph and a `library` object: the lemmas by domain, what the candidates came to
(promoted, duplicate, trivial, not proved alone, pending), the share of accepted proofs that use a library lemma, and the number of accepted
proofs that use a declaration from each source, the harness library, each extra package and Mathlib (LC2). Use is read from the text of the
submission (an identifier that is a known name, or the last component of exactly one): an approximation that `#seshat_premises` of the
Lean meta tool ([lean-meta.md](lean-meta.md)) would replace. PC12 (tactic mining) is not built: it waits for these numbers.

## Options

| Option | Default | Meaning |
|---|---|---|
| `promote` | true | Grow the library. |
| `fromFailed` | false | Also read the auxiliary lemmas of failed attempts. |
| `maxPerAttempt`, `maxPerProblem` | 5, 10 | Candidates read from one attempt; promotions per problem. |
| `briefingLemmas` | 5 | Results in the briefing section; 0 leaves it out (and nothing is drawn). |
| `tool` | true | Offer `library_search`. |
| `ranking`, `bm25Weight` | `bm25`, 0.7 | `bm25` or `hybrid`. |
| `recheck`, `maxRecheck` | true, 50 | Compile the library again when the Mathlib revision changed. |

## Tested, and not yet

`packages/library/test` covers: reading the auxiliary region (statements, term and tactic proofs, definitions, holes, siblings), names and text that
read back; BM25 and the hybrid (normalization, the weight grid, the held-out comparison, the keep-only-if-better rule); the tiers and their order and
caps; the files; the compile again with a stub Lean; and whole runs with the simulated model and Lean: promotion
(each criterion and its reason), a duplicate across problems, the briefing section drawn and shown only when included, the tool, the
share of proofs that use the library, a different non-triviality test, a lemma carried from an earlier run under another environment not offered,
the export command and the report. Not run: a real Lean (the lemmas, the triviality probes and the files are accepted by a simulated one), the export of
declarations through `lean.meta`, Task 6's battery as the triviality test, a real model's use of the section, and the effect of the library on
cost (Task 14).
