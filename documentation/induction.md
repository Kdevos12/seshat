# Induction: data, classical conjectures, and what a program may do

`@seshat/induction` is the package behind the lines M8 (the inductive engine), M13 (theory exploration)
and M16 (program search) ([lines.md](lines.md)). It is the part of the harness that looks at data
before it asks for a proof: it makes tables of small cases, finds the regularities in them, and turns
the regularities into conjectures. The research notes behind it are the experimental-mathematics
chain: produce the data, identify it, conjecture, test, prove (plan §12).

**Nothing here proves anything.** A recurrence guessed from twenty terms, an integer relation found by
PSLQ, a bound that holds on every graph with six vertices: each is a conjecture, an `open` claim with
the evidence next to it. A claim changes status only when a Lean proof of it goes through `validate`
([trust.md](trust.md)); the output of a program or a computer algebra system is a `computed` edge or a
node, never a status (Ruling 13). A conjecture is `open` and stays `open` until Lean says otherwise.

This page grows with the package: the algorithms and the sandbox come first, then the line M8, the
exploration of theories and program search.

## The classical conjecturing, without a model

Three methods, each a pure function with no model call. They are what the research notes call the
channel of classical conjectures ("Notre conception", §7): cheap, deterministic, and aimed at the
conjectures that have a path to a proof.

### Linear recurrences (gfun's guess-then-prove)

| Call | Does |
|---|---|
| `berlekampMassey(terms)` | The shortest linear recurrence with constant coefficients over the rationals (exact, on `bigint`). |
| `guessLinearRecurrence(terms, {minSurplus, maxOrder})` | The Berlekamp-Massey recurrence as a `Recurrence`, when it leaves at least `minSurplus` (2) terms beyond twice its order. |
| `guessHolonomic(terms, {minSurplus, maxOrder, maxDegree})` | A recurrence with polynomial coefficients, `sum P_i(n) f(n+i) = 0`, by linear algebra over the rationals, from the shapes with the fewest unknowns up. |
| `recurrenceHolds`, `predictTerms` | Whether a recurrence holds on more terms; the next terms it predicts (a guess that stops being integral is a wrong guess). |
| `recurrenceStatement(rec, {fn})` | The recurrence as a conjecture in Lean's signature form, about a function `fn` from ℕ, read in ℤ. |

A system with as many unknowns as equations has a solution that says nothing, so every guess demands a
**surplus**: equations beyond the unknowns. The Catalan numbers come out of 12 terms as `(n+2) f(n+1) = (4n+2) f(n)`
(order 1, degree 1, four unknowns, seven equations to spare), out of 6 only when the caller accepts a
surplus of 1, and the primes give no recurrence at all. The guess does not prove itself: the conjecture
`recurrenceStatement` writes is a claim for a prover, and a recurrence that holds on the terms is
checked against more terms (`recurrenceHolds`) before the line records it.

### Integer relations (PSLQ)

`findIntegerRelation(numbers, {digits, maxCoefficient})` runs PSLQ (Ferguson and Bailey) in fixed-point
arithmetic on `bigint`, on decimal texts or on named constants (`pi`, `e`, `phi`, `sqrt(m)`, `ln(m)`,
`atan(1/k)`; `constant(name, bits)` computes them, π by the Gauss-Legendre iteration). The tolerance is
the usual `eps^0.75` of the digits given. The answer says how many digits the relation agrees to and how
many digits it takes to write, and calls the match `significant` only when the first exceeds the second
by at least `margin` (10) digits: a relation of two small integers that holds to three digits is a
coincidence. The tests find the golden ratio's polynomial, the minimal polynomial of `√2 + √3`, Machin's
formula among π and two arctangents, `ln 6 = ln 2 + ln 3`, and the BBP formula for π among π and four
series (`1, -4, 2, 1, 1`). **The PSLQ here is written for this package; no dependency was added.**

### The Dalmatian heuristic

`dalmatian(columns, {target, direction, maxSize})` is the conjecturing of Fajtlowicz's Graffiti, in the
form of Larson and Van Cleemput (IJCAI 2017). From the numeric invariants of a table it builds
expressions by growing size (sums, differences, products, quotients, `max`, `min`, square roots, floors,
ceilings, squares, and the constants 1 and 2), de-duplicated by their values on the objects, and keeps a
bound `target <= f` when it passes two tests:

- **truth**: it holds on every object;
- **significance**: it is strictly better than every conjecture kept so far on at least one object.

A conjecture that a newer one makes insignificant is dropped, so the output is the strongest bounds with
no known counterexample, not every true one. On the graphs with up to five vertices it finds
`maxdeg <= n - 1`, the mean degree as the bound on the smallest degree (`mindeg <= m * (2 / n)`) and as
the lower bound on the largest, and does not keep the true `mindeg <= maxdeg`, which is never the best.
`maxExpressions` caps the work and the result says when it was reached (`capped`). `boundStatement` writes
a conjecture in Lean's signature form, in ℝ, when the invariants have Lean terms.

## The sandbox for programs

A program a model proposes, or a task declares, is never trusted. `runValues(source, args, limits)` runs
a JavaScript function expression on JSON arguments and returns its JSON value on each. It is the sandbox
of `@seshat/models` ([models.md](models.md#the-sandbox)) generalized from a boolean to a value, with a
memory watcher and a scratch directory added.

| What | How |
|---|---|
| Process | One Node process for the run, started with `--permission`: it reads only its own script, and has no file to write, no child process, no worker. |
| Environment | Empty: none of the harness's keys. |
| Working directory | A scratch directory made for the run and removed after it. |
| Context | A `node:vm` context with no global but the language's: no `require`, `process`, `fetch`; no `eval` or `new Function` (code generation from strings is off); the data reaches it as JSON text. `Math.random` is a seeded generator (`seed`), so a program that draws gives the same values on every run. |
| Time | `callMs` (500) for one call, `totalMs` (30 000) for the run, which kills the process. A call over its time, a thrown error or a value that is not JSON gives no value, with the reason in `notes`, and the next call goes on. |
| Memory | `--max-old-space-size` (`memoryMb`, 128) for the V8 heap; and `rssMb` (512) for the resident memory of the process, polled every 25 ms from `/proc` where that exists (Linux), which catches what the heap limit does not (typed arrays). |
| Size | A program of at most 20 000 characters; a value of at most `maxBytes` (200 000). |

**What is isolated and what is not.** This is a guard against the mistakes of a program a model wrote
(loops, memory, thrown errors, a value too large), not against one written to escape. `node:vm` is not a
security boundary. Node's permission model, in the Node version this runs on, restricts the file system,
child processes and workers but **not the network**: the program's only barrier against the network is that
its context has no API for it, and a program that escaped the context could use one. The memory limit is
polled, not enforced by the kernel, so a program can use more than `rssMb` between two reads. SageMath is
never run this way: a Sage program goes only through the capability `compute.sage` ([compute.md](compute.md)),
which has its own limits. [trust.md](trust.md#what-runs-where) says what runs where.

## Data tables

A **data table** (`DataTable`, the node kind `datatable`) is one row for each of a list of small objects,
one column for each invariant, and the code that produced every column.

```ts
const table = await buildTable({
  family: "integers",
  objects: ints, objectIds: ints.map(String),
  columns: [{ name: "n", program: "(n) => n" }, { name: "square", program: "(n) => n * n", lean: "fun n => n ^ 2" }],
});
```

A column is JavaScript (run in the sandbox above) or Sage (`sage`, an expression in `o`, the Sage object of
the row, built from the table's `sageObject` applied to the object's id; run through the `SageRun` of
`@seshat/models`, which is `compute.sage` in a run). A value a program could not give is `null`, and the
table's `notes` say why. The table's id is the hash of its objects and the columns' code, so the same table is
the same node. `recordTable` writes a `datatable` node about a claim (the rows in the node when there are at
most 2 000 values, else in a blob the node names) and does not write a table twice; `readTables` reads them
back from the memory alone.

`invariantDependencies(table)` is the map of how the numeric columns relate: `equal` (the same on every
row), `at_most` (one never exceeds the other), `determines` (rows with the same value of one have the same
value of the other, over at least three distinct values: every column is a function of a constant) and
`monotone` (a never-decreasing relation that is not a function). They are facts about the table, which
the conjecturing then turns into claims to prove.

## Hypotheses, informal steps, test lemmas, interest and the pool

`proposeHypotheses(llm, {target, table, count, known, round, model})` asks a model (site
`induction.hypotheses`, reusable) for hypotheses about a data table at four levels: observation, pattern,
structure and generalization. Each has an informal reading, a Lean `statement` when it can be stated, a
premise and a conclusion as programs over the table's columns, and the columns it uses. Statements go
through the strict screen first (`screenLeanText`, `statementProblem`: `structuralCheck` and
`forbiddenTokensIn` on the masked text); a hypothesis whose statement fails keeps only its informal
reading. `executeHypotheses` runs the programs in the sandbox on every row and keeps the counterexamples:
a hypothesis with a counterexample is dropped before any Lean time is spent.

An informal hypothesis goes through the step DAG first (plan change PC11, item 2):
`proposeHypothesisDag` asks for a `StepDag` (checked by `checkStepDag`), `recordHypothesisDag` writes its
steps as informal claims (origin `line:M8`) with `decomposes_into` edges and a learned node last, and
`dependencyMatch` records ProofScore's dependency-match (the F1 of the declared against the found
auxiliary dependencies) as a fidelity measure. `formalizeHypothesis` then asks for the Lean statement. `harness solve` ([quickstart.md](quickstart.md#harness-solve)) uses the same function, with its screen and test lemmas, to formalize a person's prose statement before any spend.

`testLemmas` checks a statement on small cases through `evaluateWithLean` (a `decide`-style example per
case): each case is `passed`, `failed`, `skipped` or `inconclusive`, and one failure drops the
hypothesis. `TrivialityTest` tries the cheap tactics (`rfl`, `decide`, `omega`, `simp`, `norm_num`) on the
statement; one that closes it is trivial and is not kept as a conjecture.

`interestOf(hypothesis, known, properties)` scores a hypothesis on non-vacuity (the premise holds on
enough objects), novelty (against the known statements), surprise (the conclusion is not implied by a
single column) and significance (how many objects and how few counterexamples), weighted 0.2, 0.3,
0.2, 0.3; a vacuous one is flagged.

The pool of PC4, item 2 (`pool.ts`): 10 to 50 proposals, each an `open` claim with a `derived_from`
edge to the target. `relevanceOf` asks `decide` (site `conjecture.relevance`, a Score on the statement
alone, used to order) and, if no backend is configured, `judge` (levels `irrelevant`, `marginal`,
`useful`, `central`); interruptions pass through. `poolScore` combines the proof rate, the relevance and
the proof length; `prunePool` keeps the best.

## Line M8

`createM8()` (`m8.ts`; `M8` is the instance the orchestrator registers) runs, in `beforeProvers` and in
`resumeProblem`, this pipeline on the problem's target:

1. `recognizeStatement` (of `@seshat/models`) tells whether the target is about a natural number or about
   magmas; any other statement gets no table, and the log says so. The objects are the numbers 0 to
   `maxNumber`, or the magmas of `magmaBattery` (all up to `exhaustive` elements, then `samples` of size 4
   drawn with a seed from the run's: `hash32(seed/problem/M8)`).
2. The table of `defaultColumns(family)` (`columns.ts`) and the run's extra `columns` (JavaScript, or Sage
   through `compute.sage` with `sage`), recorded as a `datatable` node.
3. The classical part (option `classical`): Dalmatian bounds on the columns that have a Lean form, stated in
   Lean in the reals and entered as candidates; a linear recurrence guessed from each integer column, kept
   as a `recurrence` evidence node (the Lean form of a function of the column is for a prover to give);
   a lookup of two columns as sequences through `oeis.search` (`identification` nodes), when the host has it.
4. For each of `rounds` rounds, the model's hypotheses (site `induction.hypotheses`), run on the table; a
   hypothesis with a counterexample is dropped, so is a vacuous one (`minSupport`). One without a Lean
   statement goes through the step DAG and is formalized. The statement is screened, tried in Lean on its
   first `testCases` numbers, and dropped if Lean refutes it, or if the cheap tactics close it (the
   triviality filter; `createM8({triviality})` replaces it). The lemmas the run proved feed the next round.
5. The pool: the best `conjectures` (10 to 50) by interest become `open` claims with origin `line:M8`, the
   target as parent and a `derived_from` edge to it. Each is scored for relevance by `decide` (site
   `conjecture.relevance`) or else `judge`, pruned by `prunePool`, and the `briefTop` best go to the
   provers' briefing, re-scored with the attempts made since (the proof rate, the length of the proofs).

A hypothesis the table refutes is dropped from the pool and kept as a `refuted_hypothesis` node (the objects that
break it and a verdict for every object of the table): it is the material of the Lakatos-style repair of line M14
([repair.md](repair.md)).

Nothing here changes a claim's status. A conjecture stays `open` until a prover submits a proof through
`validate`; a recurrence, a bound or a relation is a node about a claim, never a status (Rulings 13, 22, 23).
The line declares `resume: "rebuild"`: claims, tables, edges and nodes are not written twice when the
pipeline runs again, and the model calls are `reuse`d, so a resumed process pays for nothing it already has.
More than that: once a `conjecture_pool` node exists for the problem, a resume rebuilds the pool from it (the kept entries,
read again with the attempts made since) and skips the model rounds and the pooling. The rounds' prompts carry the claims proved
so far, so after a resume they would differ from the journaled ones, `reuse` would miss, and the model would be paid again and
the pool would grow with every resume. The classical step (free, deduplicated) still runs. The open formal claims the line
holds for a target are also capped at `conjectures` in all: a pool made after a crash, before its node was written, counts
what the earlier process left.

Smaller guards: every candidate of the pool goes through the strict screen (`statementProblem`) whatever made it (a Dalmatian
bound, a column's Lean term, a model); a model round that fails, the budget included, leaves the classical candidates already
found to be pooled; an interruption at a claim write passes through instead of being logged as a refusal; a M16 witness is
rebuilt with the seed the program was scored with; the per-problem state of M8, M13 and M14 is dropped in `afterProblem`; the
theory exploration stops collecting equations past `max(2000, 50 * maxLaws)`; and the sandbox child reads a thrown value's
`message` only when it is text.

Options (`--line-option M8.<name>=<value>`): `conjectures` 20, `rounds` 2, `perRound` 12, `maxNumber` 60,
`exhaustive` 2, `samples` 40, `minSupport` 3, `classical` true, `identify` true, `testCases` 6, `triviality`
true, `counterexampleSet` true (false is the measurement arm without the set, PD5), `leanTimeoutSec` 30, `briefTop` 5, `columns` [], `programMs` 20 000.

Not run: the model's hypotheses are tested with the faux provider, Lean with a simulated `decide`, Sage
and the OEIS with stand-ins.

## Theory exploration (line M13)

`explore(structure, {maxSize, maxTerms, maxLaws})` (`explore.ts`) is QuickSpec's idea on plain data. A
`Structure` is a signature (symbols with an arity and the way Lean writes them), variables, and test points:
places with a value for each variable and a way to apply each symbol. The terms over the signature are
enumerated by size, and every term is evaluated at every point; a term that agrees with an earlier one on all
points is not kept as a new term but gives the equation `earlier = term`, and the earlier terms are the only
ones larger terms are built from (so the enumeration stays small). The equations are then reduced to a minimal
set: in order of size (the more general first), an equation is dropped when rewriting both sides to normal form
with the equations kept so far, each oriented to a smaller (size, then text) side, gives the same term. Three
structures are provided: `natStructure` (0, 1, + and *; all values to 4 when that is at most 200 points, else a
seeded sample), `freeMonoidStructure` (words over a, b, c under concatenation: the laws that hold are the
monoid laws, and `1 * 1 = 1` is dropped as a consequence of `x * 1 = x`) and `magmaStructure` (a list of
magmas). The equations hold on the points tried and nothing more: they are conjectures.

`createM13({sink})` (`m13.ts`; `M13` is the registered instance) runs `explore` on the target's domain. A target
about a natural number is explored over 0, 1, + and *; a target about magmas, over the magmas of `magmaBattery`
that satisfy its hypotheses (at most `models`), so that the laws found are consequences of the hypotheses in
the sample. Each minimal law is an `open` claim (origin `line:M13`, the target as parent, a `derived_from` edge
to it; for magmas, in the target's own binders and hypotheses) and is handed to the library's sink as a
`LibraryCandidate`. The default sink (`memorySink`) writes a `library_candidate` node about the claim, once;
the library of line M3 gives its own sink when it is built (`createM13({ sink: (memory) => ... })`), and
until then the candidates wait in the memory. The target's provers get the laws in a briefing, marked as
not theorems. M13 also does the classical conjecturing that needs no objects: the option `relations`, a list
of lists of constants (`pi`, `e`, `ln(2)`, decimal texts...), is searched with PSLQ, and a relation found
is an `integer_relation` node saying how many digits agree and whether that is significant: a numerical
coincidence until proved, never a status.

Options (`--line-option M13.<name>=<value>`): `maxSize` 5, `maxTerms` 4000, `maxLaws` 12, `models` 40, `theory`
`auto` (or `nat`), `relations` []. Resume: `rebuild` (the exploration is a function of the target and the seed;
claims, edges, candidates and relation nodes are not written twice).

## Program search (line M16)

For a subgoal that carries a computable score (a construction, a witness of a size, a bound, a search for a
counterexample), a model can write the programs that build the object. `evolve.ts` is the search, after
FunSearch (plan change PC8); `m16.ts` is the line.

A task declares its search with `declareSearch(memory, claimId, spec)`, a `search_spec` node about the claim the
witness settles. The spec (`SearchSpec`) holds the description and signature of the programs, the `inputs` they are
run on, the scoring program (`score`, a JavaScript function expression of `{input, output}` returning a number, or
null for an invalid output; or `scoreSage`, a Sage expression in `i` and `x`, run through `compute.sage`), the `seeds`
(programs to start from), an optional `target` score, and how a witness is written: `statement` (a claim of its own,
with `{witness}` in it) and `proof` (the tactic proof, `decide` by default). The line triggers on the problem's own
claim and on the claim of each unfinished task of kind `search`.

The search (`runSearch`): a `ProgramDatabase` of `islands`, each a list of clusters of programs that have the same
score on every input (the signature), the shortest `clusterSize` of a cluster kept. Each round draws `shown`
programs from one island (chosen at random among the non-empty ones; clusters by a softmax of their scores at
`temperature`, programs of a cluster biased to short ones by `lengthBias`), puts them in the prompt as versions in
order of score (`buildPrompt`) and asks the model for `samples` programs (site `search.program`, `reuse`d). Every
`resetEvery` rounds the worse half of the islands is emptied and gets a copy of the best program of a surviving
island. Every draw comes from a source seeded with the run's seed, the problem and the spec, so a search runs the
same twice, and a resumed process replays the model's answers from the journal and goes through the same rounds.
The defaults are small for our budget; all are options (`--line-option M16.rounds=20`).

Every program, the model's and the scoring one, runs in the sandbox (above) with a time per call, a total time and a heap
limit; a program that fails, loops or returns an invalid output has no score and is not added. The programs that were
scored are `search_program` nodes (code, score, signature, round, island), at most `recordPrograms`.

The score only guides the search. The best program is run on the witness input; its output is written as a Lean term
by `leanTerm`, which writes integers, booleans and lists of them and refuses anything else (so no text a model wrote
reaches a Lean file through the witness), put in the spec's templates, screened as every model-influenced Lean text is
(`screenLeanText`), and submitted through `validate` as a proof of a claim (the spec's `statement` becomes an `open`
claim with a `derived_from` edge to the problem's claim, or the claim itself is the one settled). It is submitted only
when the target score is reached (or the spec has no target). The verdict, the best score and the witness are a
`search_result` node, written once; the provers' briefing says what the search found and that a score proves nothing.

The line is on rung 2 of the escalation ladder (`rung: 2`; with the ladder of line M12 on, it works a problem only
after the ladder moves it up that far) and declares `resume: "rebuild"`. In `beforeProvers` (and `resumeProblem`) it proposes
one ledger task of kind `search` for each claim that carries a `search_spec` (the problem's own, and the claim of each
`search` task another line made), unless it already proposed one; the acceptance criterion is that the claim is at least
`computed`. The search itself is the line's `runTask` (Task 25's hook), which needs a scheduling line (M12) in the run: the
orchestrator starts the task, calls `runTask`, and ends the task `done` (the reason says the best score and Lean's
verdict) or `failed` (a search that threw, or a claim with no specification). An interruption passes through and leaves the task
`running`; the resumed run makes it ready again and the search is run again from the journal (model calls `reuse`d, a
finished search read from its `search_result` node). The briefing reads those nodes, so a resumed process has it too. Sage scoring
ran against a stand-in only.

## Graph search beyond the lists

Plan change CA20 (Task 41), for line M11's option `graphs` ([models.md](models.md#statements-about-graphs)); `graphSearch` in
`graph-search.ts`, which the orchestrator gives M11. M11 asks the model for a predicate and a score about graphs and tries the predicate on every
graph of a battery; when nothing is found and a score exists, two searches run, in the sandbox above, bounded by `GRAPH_SEARCH_BOUNDS`
(120 steps, 6 restarts, 20 s of wall time, at most 12 vertices, 24 moves scored in each step):

- **Local search.** Hill climbing with restarts: a random graph, then each step scores `neighbors` moves (add or remove an edge, add or
  remove a vertex within the filter's range) in one sandbox run and takes the best, sideways moves included; a climb that does not
  improve for 25 steps restarts. A graph whose score reaches 1 (and that passes the filter) is a hit. The draws come from `seeded(seed)`, the seed
  M11 derives from the run's seed and journals, so the same seed and score give the same graph (unless the wall time cuts the search).
- **Families.** M16's program search (`runSearch`: islands, the same prompt, the sandbox, `reuse`d model requests) with a `SearchSpec`
  whose programs map a parameter `k` (1 to 8) to a graph `{n, edges}` and whose score is the model's graph score summed over the
  parameters. This is the hook: no change to `evolve.ts` or `m16.ts` was needed (the smallest change is none). Each program that
  scored is run on the parameters and its graphs are tested with the predicate. Model requests are the ones M11 has left of its cap; none left, none made.

Every field of the filter M11 records (vertex range, edge range, connectivity) is applied to a graph before it counts as a hit, on both paths; `bounds.callMs` (default 500) is the sandbox's time for one call. A hit is returned to M11, which writes the Lean refutation and submits it through `validate`: neither search changes a status. The tests are in
`test/graph-search.test.ts` (a planted counterexample found with a fixed seed and found again by a replay, the bounds, a family proposed by the faux model).

## The counterexample set (the CEGIS rule, PD5)

Lines M8, M14 and M16 share one rule (`cegis.ts`, plan change PD5). The counterexamples found so far for a claim are a set,
kept in the memory as `counterexample` nodes: the object (a number, a magma), its name, what it refuted, and the checker that
produced it. The sources are `table_run` (a program run on a table object), `fingerprint`, `plausible`, `finite_model` (Task 7)
and `lean_decide` (a Lean `decide` of a test lemma, or Lean rejecting a witness). `admitCounterexample` takes only one of those
names: a model's own claim of a counterexample is refused with the reason, leaves the set as it was, and a node that names no
checker is not read back. The set is the proposer's input and the first thing a candidate meets.

- **M8.** Before each round the set goes into the `proposeHypotheses` prompt ("objects already shown to refute earlier
  candidates, each confirmed by a checker"). Every proposed hypothesis is then run on the set's objects alone (`screenBySet`, a
  sandbox run) before the table, the step DAG, the formalization, the Lean test lemma and the triviality probe. One that fails a
  known object is dropped. A table run adds up to three counterexamples of each refuted hypothesis (`table_run`); a failed test
  lemma adds its case (`lean_decide`). Objects found by other checkers, beyond the table (`plausible`, `fingerprint`,
  `finite_model`), enter through `admitCounterexample` and stop a candidate the table alone would have let through.
- **M14.** The Lakatos search takes the set's counterexamples of the refuted hypothesis (those in its table) as objects the
  concept must bar too (`alsoRefuted`). The repair the verdicts alone would have chosen, when the set rules it out, is a candidate
  dropped before its step DAG is asked for.
- **M16.** A witness Lean rejected is recorded (`lean_decide`). The next search for the claim shows those outputs in the sampled
  prompt next to the scored programs, and a sampled program that builds one is dropped before it is scored (seeds are not).

The counter for Task 14's table ("Counterexample set" in [ablate.md](ablate.md)) is `cegisCounter(memory, claimId?)`: candidates dropped (by line and by source) and the tokens
saved against a baseline without the set. Each drop is a `cegis_drop` node, written once for a (line, candidate), so a resume
does not count twice. The tokens are an estimate, and it is only credited when the baseline would have spent: for M8 a dropped
candidate that the table alone would have let through (the table catches the rest for free, so those drops save nothing),
costed as the step DAG and the formalization of an informal hypothesis (`2 * (350 + a quarter of the characters of the
hypothesis and the target)`; a hypothesis that came with its Lean statement saves no priced step); for M14 an informal repair's
step DAG; for M16 nothing priced (the saving is a scoring run). The estimate has not been calibrated against a real model.

## Tests, and what has not run

`packages/induction/test` has `recurrence.test.ts` (Berlekamp-Massey on Fibonacci and a sum of powers;
the Catalan, central binomial, Motzkin and derangement recurrences; the surplus; the primes),
`pslq.test.ts` (the constants to 50 digits against known values; the five relations above; a coincidence
is not significant), `dalmatian.test.ts` (truth and significance on a hand-made table; displacement;
the classical bounds on the graphs with up to five vertices; the cap; a bound in Lean), `sandbox.test.ts`
(values, errors, time and memory limits, no `require`/`process`/`eval`, a seeded `Math.random`, an empty
environment, the scratch directory removed, cancellation) and `datatable.test.ts` (columns, missing
values, Sage through a stand-in, dependencies, records) and `hypotheses.test.ts` (the screen, interest,
hypotheses and their execution, the informal DAG, test lemmas, triviality, the pool) and `m8.test.ts` (the
options, a whole problem on numbers and on magmas, resuming, the briefing) and `explore.test.ts` (the monoid
laws from the free monoid, the laws of the numbers, left-projection magmas, the cut, the line M13 with
its sink, PSLQ relations) and `m16.test.ts` (the database: clusters, seeded draws, the biases, resets; what reaches Lean;
scoring in the sandbox and through a Sage stand-in; a faux-model run that improves a toy score and submits the
witness; resume; the budget). None of it needs Lean, a model or a network.
SageMath was not run for these columns; the Sage path is tested against a stand-in that answers as Sage
prints.
