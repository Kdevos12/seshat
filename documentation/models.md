# Small models, fingerprints, identification

`@seshat/models` is the package behind line M11 ([lines.md](lines.md)). It looks at a statement the
way an experimenter does: it tries it on small objects before anyone tries to prove it. It builds
batteries of small objects, evaluates statements on them, keeps the vector of verdicts (the
fingerprint) as a record, proposes relations between statements from fingerprints, and turns a
counter-model into a refutation that Lean decides. It also recognizes sequences and tables.

Nothing here makes a claim true or false. A verdict computed in TypeScript or by `decide` is a
test result; the only thing that changes a claim's status is a Lean proof submitted through
`validate` ([trust.md](trust.md)). The package has no network access of its own, and none of it has
run against a real Lean, a real SageMath or the real OEIS, FindStat and LMFDB yet
([what is not done](#what-is-not-done)).

## Batteries

A battery is a fixed list of small objects of one family, with the code that made it. Its `id`
says what it holds and how it was made, its `digest` is the hash of the objects' ids in order, and
its `generator` holds the name and the parameters that make it again. Two batteries with the same
`id` and `digest` hold the same objects in the same order, so fingerprints computed on them can be
compared position by position. A battery holds at most 20 000 objects: a fingerprint has one
verdict for each and goes into the journal.

| Battery | Call | Holds | `id` (example) |
|---|---|---|---|
| Magmas | `magmaBattery({exhaustive, sampleSize, samples, seed})` | All magmas up to isomorphism of size 1 to `exhaustive` (at most 3), then `samples` magmas of size `sampleSize` | `magmas:3+4x120@1` |
| Groups | `groupBattery(maxOrder)` | `smallGroups(maxOrder)` | `groups:12` |
| Graphs | `graphBattery(maxVertices, {connected})` | The graphs on 1 to `maxVertices` vertices (at most 8) up to isomorphism | `graphs:6`, `graphs:connected:5` |
| Integers | `integerBattery(max, {min})` | The integers from `min` (0) to `max` | `integers:0..40` |
| Graphs from nauty | `sageGraphBattery(run, {vertices, flags})` | What `geng` makes, through SageMath | `graphs:geng:7 -c` |
| Groups from GAP's library | `sageGroupBattery(run, orders)` | The groups of the SmallGroups library, through SageMath | `groups:sage:6,8` |

The default magma battery has 3 461 magmas: the 1, 10 and 3 330 classes of size 1, 2 and 3, and 120
sampled classes of size 4, all different, drawn with a seed.

### Magmas

A magma is a set `0..n-1` with a table `table[a * n + b]` for the product. Two magmas are
isomorphic when a renaming of the elements turns one table into the other; the canonical form of a
magma is the smallest table over all renamings (`canonicalMagma`, for sizes up to 6), and the
battery lists each class once, in canonical form.

| Size | Classes | How |
|---|---|---|
| 1, 2, 3 | 1, 10, 3 330 | Listed: every table is tried, and the canonical ones kept (`allMagmas`). Equals OEIS A001329. |
| 4 | 178 981 952 | Counted by Burnside's lemma (`countMagmas`, sizes 1 to 8, exact with BigInt); sampled, not listed. |

The sample (`sampleMagmas(size, count, seed)`) cycles through seven ways of drawing a table,
because a uniform table is almost never commutative, idempotent or a quasigroup, and a battery
that holds none of those cannot tell the laws about them apart: `uniform`, `commutative`,
`idempotent`, `affine` (`a*b = ua + vb + w` modulo the size), `latin`, `row-constant` and
`column-constant`. The generator is a seeded PRNG (`Rng`, mulberry32), so a seed gives the same
sample on every machine. Isomorphic samples are dropped, so the sample may be shorter than asked
only when the size has fewer classes.

### Groups

`smallGroups(maxOrder)` builds groups in TypeScript and checks each one (`groupObject` refuses a
table that is not associative or has no identity or inverses, and says which). A group object
carries its name, its identity and the inverse of each element.

| Family | Builder | Orders |
|---|---|---|
| Cyclic `C<n>` | `cyclicGroup(n)` | any |
| Dihedral `D<n>` | `dihedralGroup(n)` | 2n |
| Dicyclic `Dic<n>`, `Q8` | `dicyclicGroup(n)` | 4n |
| Symmetric `S<n>` | `symmetricGroup(n)`, n up to 5 | n! |
| Alternating `A<n>` | `alternatingGroup(n)`, n from 3 to 5 | n!/2 |
| Direct products | `directProduct(a, b)`; `abelianGroups(n)` lists every abelian group of order n | |

`smallGroups` is complete up to order 15 (a test counts them against OEIS A000001: 1, 1, 1, 2, 1,
2, 1, 5, 2, 2, 1, 5, 1, 2, 1, and tells the groups apart by whether they commute and the orders
of their elements). From order 16 it holds only some of the groups; `GROUPS_OF_ORDER` has the
numbers of groups of order 1 to 32, so a caller can see what is missing. The SmallGroups library
through SageMath (below) is the complete source.

### Graphs

A graph is `{n, edges, graph6}` on the vertices `0..n-1`, simple and undirected; its id is its
graph6 string (`toGraph6`, `fromGraph6`). `graphsUpToIso(n)` lists the graphs on n vertices (1 to
8) up to isomorphism by adding one vertex at a time to the classes of n-1 vertices and keeping the
canonical forms. The canonical form of a graph is the smallest adjacency key over the vertex
orderings that respect a colour refinement of the vertices (`canonicalGraph`).

| Vertices | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Graphs | 1 | 2 | 4 | 11 | 34 | 156 | 1 044 | 12 346 |
| Time here | | | | | | 50 ms | 0.3 s | 4.5 s |

The counts equal OEIS A000088, the connected ones (`isConnected`) A001349, and the counts for 1 to
6 vertices equal what nauty gave in the contract of `compute.sage` (a test reads
`capabilities/compute.sage/contract.json`).

### Integers

`integerBattery(max)` is the integers from 0 to `max`; it is the battery of the statements about
a natural number, such as `n * n + n` is even.

## Batteries from SageMath

The graphs of nauty and the SmallGroups library are reached through the capability `compute.sage`
([compute.md](compute.md)). The adapters take a `SageRun`, a function from Sage code to the text
of its last expression; `sageThroughRegistry(registry, {scope})` makes one from the registry, in a
Sage session of its own, and a test gives a stand-in.

- `sageGraphBattery` evaluates `[g.graph6_string() for g in graphs.nauty_geng("7")]` in slices of
  1 000 graphs, so that no answer is long, and reads the graph6 strings. `flags` are `geng`'s (`-c`
  connected, `-t` triangle-free); anything that is not a flag is refused before it reaches Sage.
- `sageGroupBattery` reads each `SmallPermutationGroup(n, k)` of the orders asked (1 to 32) as a
  Cayley table, and checks that it is a group.

The tests run both adapters against a stand-in that answers as Sage does, and check that the graphs
of `geng` and the TypeScript generator agree. A test against a real SageMath runs only when
`SAGEMATH_MCP_COMMAND` names the `sagemath-mcp` executable
([development.md](development.md#tests-that-use-real-data)); it has not been run here.

## Statements

The line works on the statements of claims, which are in signature form
([memory.md](memory.md#statement-form)). `recognizeStatement(statement)` says which of two shapes a
statement has, or why it has neither; a statement of another shape is left alone.

| Shape | Written as | Tried on |
|---|---|---|
| Magma | `(M : Type) [Mul M] (h : law) ... : law`, or the hypotheses as premises of the conclusion (`: (law) → law`), or no hypothesis; `Type*` and `Type u` are accepted, and `[Magma G]` with `◇` as in the equational theories project | The magmas of a battery |
| Number | `(n : ℕ) (h : P n) ... : Q n`, or `: ∀ n : ℕ, Q n` | The integers of a battery |

A *law* is `∀ x y z : M, left = right` where each side is a term in the variables and the one
operation `*` (or `◇`), which associates to the left as in Lean. Anything else is refused with the
reason: another symbol, a number, a variable the `∀` does not bind, a second type, more than 8
variables, a hypothesis that is not a law, a binder that is not a hypothesis. A statement about two
numbers, or one that uses the proof of its own hypothesis, is not tried either.

A statement holds on an object when every object that satisfies the hypotheses satisfies the
conclusion. So on a magma that breaks a hypothesis the statement holds vacuously; the object
*breaks* it when the hypotheses hold and the conclusion does not, and then it is a counter-model.

## Evaluators

An evaluator gives a verdict on each object of a battery: `true` (the statement holds), `false`, or
`null` (no verdict, with a note saying why). Three of them exist.

| Evaluator | For | How | Where |
|---|---|---|---|
| Laws in TypeScript | Magma statements | Every assignment of the variables is tried (`size ** variables` of them, the first failure ends the magma) on a law compiled once. `compileMagmaStatement`, `evaluateLaw`, `lawWitness` give the verdict, and the assignment that breaks the law | `laws.ts`, `statement.ts` |
| A program in JavaScript | Any predicate on numbers, magmas (`{size, table}`) and graphs (`{n, edges}`) | `runPredicate(source, args)` and `runProgram(source, objects)`: the program is one function expression that returns a boolean | `sandbox.ts` |
| Lean | Magma and number statements | `evaluateWithLean(checker, {header, statement, objects})` | `lean-eval.ts` |

The first is the fast path: the 3 461 magmas of the default battery take a few milliseconds per
law. The third is the one that reads the statement as Lean does, and the one that runs a number
statement; it needs a `LeanChecker`, which in a run is `RegistryLeanChecker` over `lean.check`.

### The sandbox

A program from a model is not trusted. It runs in a process of its own (`node --permission`, so it
has no file, no child process and no worker, and `--max-old-space-size`), inside a `node:vm`
context with no global besides the language's, no `eval` or `new Function`, and data that reaches it
as JSON text only. Three limits apply, and each has a default: 200 ms for a call, 30 seconds for the
run, 128 MB of memory (`PredicateLimits`).

- A call that goes over its time, throws, or returns something that is not `true` or `false` has no
  verdict (`null`, with the reason in `notes`), and the run goes on with the next object.
- A program that fills the memory, or that the run's total time or a cancellation kills, ends the
  run: the verdicts already given are kept, the others have none, and `stopped` says why.
- A program that does not compile, an empty one and one over 20 000 characters are refused.

It is a guard against the mistakes of a program that a model wrote, not a defense against one
written to escape: the process does not isolate the network (the context offers none), and the
memory limit is the process's, not the program's.

### The Lean evaluator

The statement becomes a proposition `m11_stmt` about its structure, after the claim's header, and
each object an `example` on a line of its own:

```lean
import Mathlib

abbrev m11_stmt (M : Type) [Mul M] : Prop := (∀ x y : M, x * y = x) → ∀ x y : M, x * y = y * x
example : @m11_stmt (Fin 2) ⟨fun a b => ([0, 0, 1, 1] : List (Fin 2)).getD (a.val * 2 + b.val) 0⟩ := by decide
```

A number is written as itself (`@m11_stmt 7`). Lean accepting the example says the statement holds
on the object. For the objects whose example fails, a second file asks `example : ¬ @m11_stmt ...`;
Lean accepting it says the statement fails. When `decide` settles neither (a time limit, a
statement it cannot decide such as one about `Nat.Prime`), the object has no verdict. The line of
an error says which object it is about, since the position of an error in the answer is the line of
the file as sent ([lean.md](lean.md)).

- Up to 16 objects go in a file and 8 files in a call to the checker. A file that times out is
  split in two, down to one object.
- The first file is a probe. When an error falls before the examples (the definition does not
  elaborate) or `decide` settles none of the first objects, the evaluation stops there and says so
  in `unusable`, instead of sending the rest.
- The table of a magma is a core `List` indexed by `a.val * n + b.val`, so the instance does not
  depend on Mathlib.

These verdicts are test results, and no more: `decide` ran on a statement this code wrote from the
claim's, and a counter-model becomes a refutation only through `validate`
([lines.md](lines.md#validate)). The tests answer the files with a simulated Lean that reads the
`example` lines and decides each from the statement's meaning (`SimulatedDecide`); it checks the
layout of the files and the logic around them, not that a real Lean accepts the syntax.

## Fingerprints

The fingerprint of a statement on a battery is the vector of an evaluator's verdicts, written as a
string with one character for each object in the battery's order: `1` (the statement holds on the
object), `0` (it fails: the object is a counter-model) or `?` (no verdict). Only the fingerprints of
one battery, the same `id` and `digest`, can be compared.

A claim is a statement about every object of a kind, and the verdict on an object is the claim at
that object. `relate(a, b)` compares two fingerprints on the objects where both have a verdict:

| Result | When | Candidate edge |
|---|---|---|
| `equivalent` | Equal, and not constant | `equiv` |
| `implies`, `implied_by` | One is below the other everywhere (where it holds the other holds), they differ, the lower one holds somewhere and the upper one fails somewhere | `implies`, from the lower to the upper |
| `unrelated` | Neither is below the other | none |
| `uninformative` | One of the first two, but a fingerprint is constant | none |

A fingerprint that is `1` everywhere says no object was found against the statement, and one that is
`0` everywhere is false on every object; each is related to every other statement, so a relation
that rests on one of them says nothing and is not proposed.

`planRelations` and `addPlannedEdges` turn the relations of a claim with others into edges. Each
edge is `computed`, never `lean_checked`: it comes from a finite battery, and a statement can agree
with another on every small object and differ on a large one. Its note gives the counts. When both
claims are about the same structure the edge carries the lemma that would make it true, in the claims'
signature form, which `validate` can check and which then lets the edge propagate
([memory.md](memory.md#edges)):

```lean
-- implies: for every magma, the first statement at the magma implies the second
(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x : M, x * x = x
-- equiv
(M : Type) [Mul M] : (∀ x y z : M, x * y = x * z) ↔ (∀ x y : M, x * y = x * x)
```

On the default battery, the associative magmas of size 1, 2 and 3 are 1, 5 and 24 (OEIS A027851),
`x * y = x` has one model of each size, `x * y = x * z` and `x * y = x * x` have the same
fingerprint (they are equivalent), `x * y = x` is included in associativity, idempotence and
`x * y = x * z`, and associativity and commutativity are unrelated; the tests check each.

### The records

The package writes four kinds of nodes ([memory.md](memory.md#nodes)); other packages read them.

| Kind | About | `data` |
|---|---|---|
| `battery` | | `id`, `family`, `digest`, `size`, `generator` (its name and parameters): recorded once for each battery a run uses |
| `fingerprint` | A claim | `battery`, `digest`, `evaluator` (`law`, `lean` or `program`), `verdicts` (the string), `counts`, `batteryNode`; not recorded again when the claim already has the same |
| `counter_model` | A claim | `battery`, `digest`, `index`, `object`, `description`, `evaluator`, `witness` (the values that break the conclusion), `refutation` (what each submission of the negation came to) |
| `identification` | A claim | `subject` (what was looked up, in words), `query` (the terms, as text), `reading` (for a table), `strength`, `matches` (`id`, `name`, `source`, `offset`, `start`, `next`, `prefix`), `note` |

## Counter-models and refutations

A fingerprint with a `0` is a counter-model, and never a refutation. `recordCounterModel` writes
the `counter_model` node and a `refuted_by` edge from the claim to it, `computed`: an object was
found by a tool, and nothing is proved. The refutation is a Lean proof of the claim's negation,
submitted through `validate({claimId, negation: true, ...})` ([lines.md](lines.md#validate)). The
validator asks for `¬ (type_of% @claim)`, and `negationProofs` writes the proof from the object:

```lean
intro hall
have key := @hall (Fin 2) ⟨fun a b => ([0, 0, 1, 1] : List (Fin 2)).getD (a.val * 2 + b.val) 0⟩
revert key
decide
```

`@hall <object>` is the claim at the object: an implication from its hypotheses to its conclusion,
which `decide` shows to be false. A second form puts the table in a `def aux_...` and ends with
`exact absurd (@hall ...) (by decide)`; `submitRefutation` sends the first, and sends the second only
when the first is invalid, and returns what each came to. Both pass the validator's structural check
(`structuralCheck`: no forbidden token, no string, auxiliary names starting with `aux_`), which the
tests run.

What the validation path does with it: a valid proof of a negation is recorded as a validation with
`negation: true` and changes no status. The claim becomes `refuted` only when the certifier replays
the proof in a fresh process ([trust.md](trust.md), [lean.md](lean.md)); until then the claim is
`open`, with a valid negation recorded. Both the proof forms and this path are tested with a simulated
Lean; neither has run against a real one.

## Identification

`identifySequence(terms)` says which known sequences have the given integers as consecutive terms.
It looks in a table of 65 sequences shipped with the package (`knownSequences()`), each
with its OEIS number, name, offset and terms. The table is code, so that it needs no network and
a wrong entry can be found by a test: a sequence given by a formula or a recurrence is computed with
exact integers (`bigint`), the decimal expansions of π, e, √2 and the golden ratio are computed with
integer arithmetic, and the few counts that no formula gives (groups, graphs, trees, relations,
magmas, semigroups) are written out. The tests compare those with the package's own enumerations
(magmas of size 1 to 5, graphs on 1 to 6 vertices, groups of order 1 to 32, semigroups of size 1 to 3)
and the constants with an independent computation, and spot-check the others against values written
from memory of the OEIS entries.

- Terms are numbers, `bigint`s or decimal text; a number that is not a safe integer is refused
  rather than rounded.
- A query may start anywhere in a sequence, since the numbers where a statement holds may begin at the
  middle of one. A match gives the sequence's offset, the index where the query starts, and the next
  terms (at most five), a prediction to check. The sequences that begin with the query come first.
- At least four terms (`minTerms`), and at most eight matches (`maxMatches`).
- `strength` is `strong` for six or more terms with four different values, or ten terms with three;
  `weak` for a shorter or flatter query that matches (1, 1, 1, 1 matches the sequence of ones, which says little); `none`
  when nothing matches or the query is too short. It measures how unlikely a match is by chance
  and nothing else.

`identifyTable(rows)` reads a table the way the OEIS does and looks up each reading: by rows, by
columns, row sums, first column, last column, main diagonal, and, for a rectangular table, the
complete antidiagonals read from the first row and from the first column. It returns the readings
that matched.

`lookupSequence(terms, {oeis})` asks the table first, and the OEIS when the table has no strong match
(`always: true` asks anyway). The answer merges both, each match marked with its `source`. A service
that fails does not fail the lookup: the table's answer comes back with a note saying the OEIS did not
answer.

`recordIdentification` writes an `identification` node about a claim and a `cites` edge from the
claim, `computed`. An identification is a lookup. It says a sequence has these terms, and a claim's
status does not depend on it: a statement about the numbers where something holds is not proved by
the numbers being the even ones. What it gives a prover is a conjecture to try (`n % 2 = 0`) and a
name to search for in the literature.

### Clients of the services

| Client | Service | Request |
|---|---|---|
| `OeisClient` | The On-Line Encyclopedia of Integer Sequences | `search(terms)`: `GET /search?q=1,2,3&fmt=json`; `lookup('A000045')`: `q=id:A000045`. Both the list and the `{count, results}` shapes of the answer are read. |
| `LmfdbClient` | The L-functions and modular forms database | `query(collection, fields)`: `GET /api/<collection>/?<field>=<value>&_format=json&_limit=10` |
| `FindStatClient` | FindStat, combinatorial statistics | `identify(collection, [[object, value], ...])`: `POST /StatisticFinder/` with `{collection, data}` |

They share a small base. Each takes a `fetch` (the tests give one that answers from a file), a base
address, a time limit for a request (20 s), a pause between two requests (1 s, to be polite to the
site), and an `AbortSignal`; one request runs at a time, the same request is answered once from a
cache, and every failure (a network error, a status other than 200, an answer that is not JSON, one
without the expected list, the time limit) is a `LookupError`.

The OEIS, FindStat and LMFDB are not reachable from the development environment. The tests answer from
files in `packages/models/test/fixtures/` that were written by hand in the shape the sites give. No
request has been made to a real site. The OEIS address and JSON fields (`number`, `data`, `name`,
`offset`, `keyword`, `count`, `results`) are written from its documentation as remembered; the
FindStat and LMFDB requests and answers are guesses from theirs and are the most likely to need
adjusting. The clients are libraries of this package, not capabilities of the registry
([capabilities.md](capabilities.md)); a capability that wraps `lookupSequence` is the way to give them
a manifest and a contract when they can be tried against the sites.

## The line

`M11` is the line ([lines.md](lines.md)). `packages/orchestrator/src/lines.ts` registers it, so
`harness run --lines M11` runs it; it needs no other line, and it compares the variants of the
problem's claim when a line such as M2 has recorded them. `createM11({oeis})` makes one that also
looks sequences up in the OEIS through a client. It makes no model call.

| Hook | What it does |
|---|---|
| `beforeProvers` | Reads the problem's statement with `recognizeStatement`; one of another shape is left alone, and the reason goes to the progress log. Takes the battery, the magmas of the options for a statement of magmas and the numbers from 0 to `maxNumber` for a statement about a number. Gets the verdicts, with the law evaluator for magmas and with `decide` in Lean through `lean.check` for numbers (the evaluator's files are the line's tool runs, from `line:M11`); a statement that Lean cannot try at all is left alone, with the reason. Records the battery and the fingerprint. Then, in order: the counter-models, the neighbors, the identification. |
| `briefing` | A section `Small models (line M11)` in the session's opening message, written from the records: the fingerprint's counts, the counter-model and what became of its negation, the candidate relations with their link lemmas, the sequences that matched. |
| `beforeSession` | Stops the prover when the claim has a valid validation of its negation (`stopWhenRefuted`), since the claim is false as it is written and a session would spend the budget for nothing. The problem then ends `unsolved` with `provers stopped: 1 line`; a refuted problem has no outcome of its own yet. |
| `tools` | `small_models`, below. |

**Counter-models.** For each of the first `counterModels` objects where the statement fails, in the
battery's order (the smallest first), the line records the `counter_model` node with its `refuted_by`
edge, submits the negation through `validate` in both forms, and writes what each submission came to
into the node (`refutation`). It goes on to the next counter-model only while no negation has passed.
`refute: false` records the first counter-model and submits nothing. A valid negation is a validation
with `negation: true`; the claim stays `open` until the certifier replays it
([trust.md](trust.md)), and the briefing says so.

**Neighbors.** The memory has no listing of its claims, so the claims related to the problem's are
found by following the edges `implies`, `equiv`, `special_case_of`, `strengthens`, `instance_of` and
`derived_from`, in both directions, up to `neighborDepth` edges away and `neighbors` claims. Those
whose statement the package reads, about the same kind of object as the problem's, get a fingerprint
of the same battery (not tried again when they already have one), and every pair among them and the
problem's claim goes through `planRelations`. The `computed` edges, with their link lemmas, that the
memory does not have yet are added, the problem's claim included. The edges that another line
proposed are not repeated.

**Identification.** For a statement about a number, the numbers where it holds, and those where it
fails, are looked up as sequences (`identifyTerms` terms at most), in the table and in the OEIS when a
client was given. A set that is every number, has fewer than 4, or starts with numbers in a row (the
statement holds, or fails, from there on) says nothing and is skipped.

**`small_models`.** A tool for the provers, so that a model can test a lemma or a variant before it
proves it. With a `statement` it does what the line does for the problem's, on the numbers up to
`toolMaxNumber`, and says how the statement compares with the one being proved when the battery is
the same: equivalent, stronger or weaker, or neither. With a `program` (a JavaScript function that
takes an object and returns true when the property holds) and a `battery` (`magmas`, `groups`,
`graphs` up to 6 vertices or `integers`), it runs the sandboxed program on the battery. Either way it
shows the smallest counter-models and says it is a test and no proof. It records nothing.

What the line never does: it changes no status (only `validate` does, with a Lean proof), it adds no
edge that is not `computed`, and a fingerprint alone refutes nothing. The options, with a run's
`--line-option M11.<name>=<value>`:

| Option | Default | |
|---|---|---|
| `exhaustive`, `sampleSize`, `samples`, `seed` | 3, 4, 120, 1 | The magma battery: all magmas up to `exhaustive` elements (0 to 3), then `samples` magmas of size `sampleSize` (4 to 6) drawn with `seed` |
| `maxNumber` | 100 | A statement about a number is tried on 0 to this number (at most 1000) |
| `leanTimeoutSec` | 60 | Lean's time limit for each file of the evaluator |
| `refute` | true | Submit the negation of a statement that fails |
| `counterModels` | 3 | The most counter-models to submit while none passes |
| `stopWhenRefuted` | true | Stop the provers once a negation has passed |
| `neighbors`, `neighborDepth` | 8, 2 | The claims compared with the problem's, and how far the edges are followed |
| `identify`, `identifyTerms` | true, 40 | Look the numbers up as sequences, from at most this many terms |
| `toolMaxNumber` | 30 | The numbers a statement is tried on by the tool |

A value out of range fails the problem's `beforeProvers` with the name of the option.

On the bench, where the problems are solved ones, a counter-model means that the statement as
formalized is not the theorem its source proves; and most statements use definitions of their own,
which the line leaves alone. It earns its keep once other lines produce statements of the shapes it
reads: variants, lemma candidates, instances.

`packages/models/test/line.test.ts` runs the hooks with a stand-in for the context (the options, the
counter-models and their submissions, the neighbors and their edges, the identification, the
briefing, the stop, the tool), and `packages/orchestrator/test/m11.test.ts` runs the line in
`runBench` with the simulated model and Lean: a statement of magmas refuted with the provers left
idle, a statement about a number tried through `lean.check`, refuted and identified, a run where
Lean does not accept the negation and the provers go on with the briefing and the tool, a statement
with no counter-model, and the options.

## What is not done

- The adapters for SageMath have not run against a real SageMath.
- The Lean evaluator has not run against a real Lean. The text of the files (`abbrev`, the `Fin`
  instance from a `List`, `decide` on the instantiated statement) is written from what Lean 4 and
  Mathlib accept, and `pnpm harness contract lean.check` does not cover it.
- A statement about groups, graphs or any other structure has no Lean evaluator: a program in
  JavaScript is the evaluator for those.
- Magmas of size 4 are sampled, never listed. Groups of order 16 and above are partly built.
- No run of the line has used a real model or a real Lean. The proofs of negations that its tests
  accept are the ones the simulated Lean was told to accept; whether Lean accepts them is the first
  thing to check ([lean.md](lean.md#to-verify-against-lean)).
- The OEIS, FindStat and LMFDB clients have not made a request to their sites (see above). The table of
  known sequences has 65 sequences, and a query that is not in it is looked up only if an
  OEIS client is given.
