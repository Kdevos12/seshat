# Small models, fingerprints, identification

`@seshat/models` is the package behind line M11 ([lines.md](lines.md)). It looks at a statement the
way an experimenter does: it tries it on small objects before anyone tries to prove it. It builds
batteries of small objects, evaluates statements on them, keeps the vector of verdicts (the
fingerprint) as a record, proposes relations between statements from fingerprints, and turns a
counter-model into a refutation that Lean decides. It also recognizes sequences and tables.

Nothing here makes a claim true or false. A verdict computed in TypeScript or by `decide` is a
test result; the only thing that changes a claim's status is a Lean proof submitted through
`validate` ([trust.md](trust.md)). The lookups on the OEIS, FindStat and the LMFDB are capabilities of
the registry like every other external tool ([the services as
capabilities](#the-services-as-capabilities)), and the package makes no request outside them. None
of it has run against a real Lean, a real SageMath or the real sites yet ([what is not
done](#what-is-not-done)).

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
| Magma | `(M : Type) [Mul M] (h : law) ... : law`, or the hypotheses as premises of the conclusion (`: (law) → law`), or no hypothesis; `Type*` and `Type u` are accepted (and kept: [counter-models](#counter-models-and-refutations)), and `[Magma G]` with `◇` as in the equational theories project | The magmas of a battery |
| Number | `(n : ℕ) (h : P n) ... : Q n`, or `: ∀ n : ℕ, Q n` | The integers of a battery |

A *law* is `∀ x y z : M, left = right` where each side is a term in the variables and the one
operation `*` (or `◇`), which associates to the left as in Lean. Anything else is refused with the
reason: another symbol, a number, a variable the `∀` does not bind, a second type, more than 8
variables, a side with more than 64 occurrences of variables, parentheses nested more than 32 deep, a
hypothesis that is not a law, a binder that is not a hypothesis. A statement about two numbers, or
one that uses the proof of its own hypothesis, is not tried either.

**The size of a statement is limited.** `recognizeStatement` reads at most 4 000 characters
(`MAX_STATEMENT_LENGTH`; the `small_models` tool declares the same `maxLength` for its `statement`
argument), a side of a law has at most 64 occurrences of variables (`MAX_LAW_OCCURRENCES`) and
parentheses nest at most 32 deep (`MAX_LAW_NESTING`). The laws that are studied have a few occurrences
on a side, so no real statement meets these limits; they are there because the parser, the compiler of
laws and the printer recurse over the term, and the evaluator does its work for every assignment on
every occurrence. A text of a million variables, or of a hundred thousand parentheses, would otherwise
build a term that deep and run out of stack, and a long term makes each assignment cost in
proportion ([the caps](#the-caps) count that). The limits are checked while the text is read, so such
a text is refused with its reason before any term exists, and the line leaves the statement alone.

A premise that is itself a quantified law goes in parentheses: `(∀ x y : M, x * y = y * x) → ...`.
Lean reads the body of a `∀`, `∃` or `fun` (or `forall` and `exists`, written as words) to the end of
the statement, so in `∀ x y : M, x * y = y * x → ...` the arrow belongs to the body and the statement
has one premise fewer than it appears to. A statement with an arrow after an unparenthesised
quantifier is refused, with the reason, instead of being split where Lean would not split it.

A statement that holds a token the validator refuses in a proof (`#eval`, `macro_rules`, `IO`,
`Lean`, ...; core's `forbiddenTokensIn`, the list of `structuralCheck`) is not recognized either, and
the reason names the tokens. The body of a statement about a number is written as it is into the
evaluator's Lean file (`abbrev m11_stmt ... := <body>`), where text such as `n = n #eval ...` ends the
declaration and adds commands; and statements come from the claims of a run and from the `statement`
argument of the provers' tool. The screen reads the text with its comments and strings blanked,
which is the text that is written. It reads names as Lean's lexer does ([validator.md](validator.md)):
it finds `#eval` also glued to what precedes it (`n = n x#eval 1`, which Lean reads as `x` and the
command), and a keyword after a symbol or a number (`!run_cmd`, `1e5sorry`), but not one inside a name
(`xsorry`). A statement that holds a `#` at all is refused with its own reason: `#` starts a command
(`#check`, `#reduce`, `#print`...), and nothing the line reads needs it, since a statement is a
signature.

A statement holds on an object when every object that satisfies the hypotheses satisfies the
conclusion. So on a magma that breaks a hypothesis the statement holds vacuously; the object
*breaks* it when the hypotheses hold and the conclusion does not, and then it is a counter-model.

## Evaluators

An evaluator gives a verdict on each object of a battery: `true` (the statement holds), `false`, or
`null` (no verdict, with a note saying why). Three of them exist.

| Evaluator | For | How | Where |
|---|---|---|---|
| Laws in TypeScript | Magma statements | Every assignment of the variables is tried (`size ** variables` of them, the first failure ends the magma) on a law compiled once, after `magmaWork` has bounded the steps ([caps](#the-caps)). `compileMagmaStatement`, `evaluateLaw`, `lawWitness` give the verdict, and the assignment that breaks the law | `laws.ts`, `statement.ts` |
| A program in JavaScript | Any predicate on numbers, magmas (`{size, table}`) and graphs (`{n, edges}`) | `runPredicate(source, args)` and `runProgram(source, objects)`: the program is one function expression that returns a boolean | `sandbox.ts` |
| Lean | Magma and number statements | `evaluateWithLean(checker, {header, statement, objects})` | `lean-eval.ts` |

The first is the fast path: the 3 461 magmas of the default battery take a few milliseconds per
law. The third is the one that reads the statement as Lean does, and the one that runs a number
statement; it needs a `LeanChecker`, which in a run is `RegistryLeanChecker` over `lean.check`.

### The sandbox

A program from a model is not trusted. It runs in a process of its own: `node --permission`, so it
reads nothing but its own script and has no file to write, no child process and no worker; an empty
environment (`sandboxEnvironment()`), so none of the harness's keys are in its memory; and
`--max-old-space-size`. Inside it, a `node:vm` context has no global besides the language's, no
`eval` or `new Function`, and data that reaches it as JSON text only. Three limits apply, and each
has a default: 200 ms for a call, 30 seconds for the run, 128 MB of V8 heap (`PredicateLimits`).

- A call that goes over its time, throws, or returns something that is not `true` or `false` has no
  verdict (`null`, with the reason in `notes`), and the run goes on with the next object, also when
  the thrown value cannot be read (a `message` that throws in turn).
- A program that fills the heap, or that the run's total time or a cancellation kills, ends the
  run: the verdicts already given are kept, the others have none, and `stopped` says why.
- A program that does not compile, an empty one and one over 20 000 characters are refused.

It is a guard against the mistakes of a program that a model wrote, not a defense against one
written to escape. `node:vm` is not a security boundary; the process does not isolate the network
(Node's permission model does not restrict it, and the context offers none); and the 128 MB is the V8
heap, not memory: the buffers of typed arrays are outside it, and a program can use more.
[trust.md](trust.md#what-runs-where) says what it could reach.

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
- `maxFiles` limits the files one call sends, the retries of files that timed out included. When it is
  reached the objects not yet asked have no verdict, with a note, and `capped` counts them; when none
  has a verdict by then the evaluation is `unusable`, since the limit was reached before any object
  had one. In a run the limit is what is left of an allowance ([caps](#the-caps)).
- The table of a magma is a core `List` indexed by `a.val * n + b.val`, so the instance does not
  depend on Mathlib.

These verdicts are test results, and no more: `decide` ran on a statement this code wrote from the
claim's, and a counter-model becomes a refutation only through `validate`
([lines.md](lines.md#validate)). The tests answer the files with a simulated Lean that reads the
`example` lines and decides each from the statement's meaning (`SimulatedDecide`); it checks the
layout of the files and the logic around them, not that a real Lean accepts the syntax.

### The caps

Neither evaluator spends the run's budget in dollars, so each has a cap of its own, in the line's
options ([below](#the-line)). The problem's statement and the claims around it share one allowance of
each, spent in the order they are tried (the problem's first), and each call of the `small_models`
tool has an allowance of its own.

- `leanFiles` (default 200) bounds the files the Lean evaluator sends, the retries of files that
  timed out included. A statement about the numbers 0 to 100 takes 7 to 14 files (11 for one that
  fails on every odd number), so the default covers the problem's statement and eight claims around
  it. A `maxNumber` of 1000 takes 63 to 126 files for each statement and wants a larger cap, and a
  statement that `decide` cannot settle, whose files keep timing out, takes 62 files for the first 16
  numbers alone. When the cap is reached the objects not yet asked have no verdict. The problem's own
  fingerprint is recorded with those holes (`?`) and the log says how many; a claim around the
  problem that was cut short is not recorded, since a fingerprint with holes that the cap made would
  be compared as if it were whole. A cap of 0 turns the Lean evaluator off.
- `lawWork` (default 500 000 000) bounds the steps that the law evaluator takes.
  `magmaWork(statement, magmas)` gives the bound before anything runs. For each law of the statement
  (the hypotheses and the conclusion) on each magma it counts `size ** variables` assignments of
  values to the variables; an assignment costs one step for each occurrence of a variable in the law,
  since the evaluator computes both sides in full, and 4 more for the next assignment and the
  comparison. Counting the assignments alone did not bound the time: the same assignments of a law
  with 128 occurrences take more than ten times as long as those of a law with 4. The size limits of
  [Statements](#statements) keep every law within 128 occurrences, and this cap then bounds the time.
  That is the work when every law holds on every magma; a law that fails stops at its first
  counter-assignment, so the work done is usually much less. The evaluator is synchronous: while it
  runs nothing else does, and nothing can cancel it. On the machine these numbers come from a step
  takes about 8 ns in short laws and about 18 ns in the longest the parser allows, so the default
  is 4 s for short laws and 9 s for the longest: about ten seconds at worst, with room for a slower
  machine. A statement over what the cap leaves is not tried, and the log says what its bound is and
  what was left. A cap of 0 turns the law evaluator off.

The bound against the time, for laws that hold on every magma (so that every assignment is tried), on
the default battery (3 461 magmas), as measured here (a refused statement was timed by running it
without the cap):

| Statement | Assignments | Steps | Time | Default cap |
|---|---|---|---|---|
| one law, 7 variables, 7 occurrences on each side | 9.3 million | 167 million | 1.2 s | allowed |
| one law, 8 variables (the most), 8 occurrences on each side | 29.7 million | 594 million | 4.9 s | refused, 1.2 times the cap |
| one law, 5 variables, 64 occurrences on each side (the most) | 932 391 | 123 million | 2.1 s | allowed |
| one law, 6 variables, 64 occurrences on each side | 2.9 million | 385 million | 6.6 s | allowed |
| four such laws of 5 variables | 3.7 million | 492 million | 8.4 s | allowed: the longest the cap lets through |
| one law, 7 variables, 64 occurrences on each side | 9.3 million | 1.2 thousand million | 22 s | refused |
| one law, 8 variables, 64 occurrences on each side | 29.7 million | 3.9 thousand million | 71 s | refused |

A law that is true of every magma is the worst case; one that fails on most magmas stops at its first
counter-assignment. A statement that the cap refuses is tried by raising the option, with
`--line-option M11.lawWork=600000000` for the second row.

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

**The sort of the type.** The statement keeps the sort of its first binder (`MagmaStatement.sort`).
A claim over `Type*`, `Type _` or `Type u` has a universe parameter, and the negation theorem, which
Lean elaborates from `@claim`, has it as a parameter `u_1` that is rigid inside the proof: `hall`
takes `M : Type u_1`, and `Fin 2 : Type` is not one. For these claims (`needsLift`: any sort but
`Type` and `Type 0`) both forms put the counter-model on `ULift (Fin 2)`, the table transported
through `down` and `up`, and the table stays a definition on `Fin 2`:

```lean
intro hall
have key := @hall (ULift (Fin 2)) ⟨fun a b => ULift.up (([0, 0, 1, 1] : List (Fin 2)).getD (a.down.val * 2 + b.down.val) 0)⟩
revert key
decide
```

The evaluator is not affected: it instantiates its own definition at `Fin n : Type`. The lemma that
links two claims is stated over the claims' own sort, and the sorts are compared as they are
(`sortOf`: `Type`, also written `Type 0`; `Type*`, also written `Type _` or `Type u`; or `Type n`
for a fixed universe from 1). Two claims of the same sort get a lemma stated with it
(`(M : Type*) [Mul M]`, `(M : Type 1) [Mul M]`); claims of different sorts get none, and the edge
stays `computed`, since a lemma over every universe is not about a claim over `Type 1`, and a lemma
over `Type` is about neither.

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
(`always: true` asks anyway). The answer merges both, each match marked with its `source`. `oeis` is
an `OeisSource`, anything with a `search(terms)` that answers like the OEIS; the one the line uses
asks the registry's `oeis.search` ([below](#the-services-as-capabilities)). A service that fails
does not fail the lookup: the table's answer comes back with a note saying the OEIS did not answer.

`recordIdentification` writes an `identification` node about a claim and a `cites` edge from the
claim, `computed`. An identification is a lookup. It says a sequence has these terms, and a claim's
status does not depend on it: a statement about the numbers where something holds is not proved by
the numbers being the even ones. What it gives a prover is a conjecture to try (`n % 2 = 0`) and a
name to search for in the literature.

### The services as capabilities

Looking something up on a site is a tool like any other, so each service is a capability of the
registry ([capabilities.md](capabilities.md)): a manifest, a contract, and an entry in the host
profiles. Replacing the site by a mirror, or by a local copy of the data, is a change of profile or
a new implementation, not of the line.

| Capability | Service | Input | Request of the `site` implementation |
|---|---|---|---|
| `oeis.search` | The On-Line Encyclopedia of Integer Sequences | `{terms}` (1 to 100; a number past 2^53 as decimal text) or `{id}`, one of the two | `GET /search?q=1,2,3&fmt=json`, or `q=id:A000045`. Both the list and the `{count, results}` shapes of the answer are read. |
| `lmfdb.query` | The L-functions and modular forms database | `{collection, fields, limit?}` | `GET /api/<collection>/?<field>=<value>&_format=json&_limit=10` |
| `findstat.identify` | FindStat, combinatorial statistics | `{collection, data: [{object, value}, ...]}` | `POST /StatisticFinder/` with `{collection, data}` |

One capability for each service, since their inputs and answers have nothing in common, and one
implementation for each, `site`. It is built by the factory `oeis`, `lmfdb` or `findstat` of
`packages/models/src/services.ts` (registered in `FACTORIES` of `@seshat/orchestrator`) around a
client of `clients.ts`; no other code of the harness builds a client of these sites. A mirror, or a
local copy of the data behind an MCP server, would be a second implementation in the manifest and in
the host's `use` list, with the same contract. The three are `direct` and produce no status
(`produces` is empty: a lookup justifies nothing), so `harness run --tool oeis.search` gives the
provers an `oeis_search` tool the way it gives `compute_sage`, and the line asks `oeis.search` itself.
`oeis.search` and `lmfdb.query` answer with the request they made, in `url`.

**Settings** of `site` in the host profile: `baseUrl` (the profiles read it from `OEIS_URL`,
`LMFDB_URL` and `FINDSTAT_URL`, and default to the public addresses), `timeoutSec` (20),
`minIntervalMs` (1000, the pause between two requests, to be polite to the site) and `userAgent`.
The client makes one request at a time, answers the same request once from a cache, and takes an
`AbortSignal`.

**Failures.** A site that cannot be reached (a network error, the time limit, a status 5xx, 408 or
429) makes the call `unavailable`, so the registry tries the host's next implementation if there is
one. A site that answers and refuses (any other status), or answers with what the client cannot read
(not JSON, without the expected list), makes it `failed`, with the message. An input that the schema
refuses is `invalid_input`, before any request, and an `oeis.search` call with both or neither of
`terms` and `id` is `failed`, also before any request. A search without an answer is a success:
`count: 0` with no results, no `records`, no `matches`. `harness health` asks each site for its front
page (`GET /`), so the health of a whole host reaches the three sites. The profiles mark the three
`optional` ([capabilities.md](capabilities.md#host-profiles)): a site that does not answer is a `warn`
line, and the command exits with 0 when nothing else is down, so a host without outbound access still
passes it. The line goes on without a site in the same way (the table's answer stands, with a note).

**Contracts.** `oeis.search` has 5 cases, `lmfdb.query` 3 and `findstat.identify` 2, written to run
on a host that reaches the site: `pnpm harness contract oeis.search` (or `lmfdb.query`,
`findstat.identify`), which is not part of `pnpm test`. `pnpm test` runs the same cases through the
registry against `packages/models/test/fake-site.ts`, a local HTTP server that answers the requests
of the cases from `packages/models/test/fixtures/`, files written by hand in the shape the sites give,
and any other request as a site with nothing would. That shows the cases and the adapters agree,
not that the sites answer so. `packages/models/test/services.test.ts` also covers the repository's
host profiles (with the three addresses set to the fake site), the tool runs, big terms, a site that
is down, one that answers what is not JSON or refuses, and the refusals of the schemas.

**`RegistryOeis`** is the `OeisSource` the line uses. Each search is a tool run of `oeis.search`
(from the actor `line:M11`, in the journal with its input and output), and every failure of the call
(the host does not offer the capability, the site does not answer, the answer cannot be read) comes
out as a `LookupError`, which `lookupSequence` turns into a note, so that the table's answer stands.
The capability takes at most 100 terms (`OEIS_MAX_TERMS`, the `maxItems` of its manifest, which a test
keeps equal): a longer query is asked by its first 100 terms, and the option `identifyTerms` stops at
100. Any other input that the capability refuses is thrown as it is, since that is a mistake of the
line.

The OEIS, FindStat and LMFDB are not reachable from the development environment, and no request has
been made to a real site. The OEIS address and JSON fields (`number`, `data`, `name`, `offset`,
`keyword`, `count`, `results`) are written from its documentation as remembered; the FindStat and
LMFDB requests and answers are guesses from theirs and are the most likely to need adjusting, which
the contracts will show on the first host that reaches them.

## The line

`M11` is the line ([lines.md](lines.md)). `packages/orchestrator/src/lines.ts` registers it, so
`harness run --lines M11` runs it; it needs no other line, and it compares the variants of the
problem's claim when a line such as M2 has recorded them. It looks sequences up in the table and in
the OEIS through the registry's `oeis.search`, as `line:M11`; `createM11({oeis})` makes one that asks
another `OeisSource` instead. It makes no model call.

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
of the same battery (not tried again when they already have one), within what is left of the
problem's allowances ([caps](#the-caps)), and every pair among them and the problem's claim goes
through `planRelations`. The `computed` edges, with their link lemmas, that the
memory does not have yet are added, the problem's claim included. The edges that another line
proposed are not repeated.

**Identification.** For a statement about a number, the numbers where it holds, and those where it
fails, are looked up as sequences (`identifyTerms` terms at most), in the table and, when the table
has no strong match, in the OEIS through `oeis.search`. A host that does not offer the capability, or
a site that does not answer, leaves the table's answer with a note in the progress log. A set that is
every number, has fewer than 4, or starts with numbers in a row (the statement holds, or fails, from
there on) says nothing and is skipped.

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
| `identify`, `identifyTerms` | true, 40 | Look the numbers up as sequences, from at most this many terms (4 to 100, the most `oeis.search` takes) |
| `toolMaxNumber` | 30 | The numbers a statement is tried on by the tool |
| `leanFiles` | 200 | The most files the Lean evaluator sends for a problem (its statement and the claims around it together) and for each call of the tool; 0 turns it off ([caps](#the-caps)) |
| `lawWork` | 500 000 000 | The most steps the law evaluator may take, as `magmaWork` bounds them (the assignments of variables, each costing the occurrences of variables in the law and 4), for a problem and for each call of the tool; 0 turns it off ([caps](#the-caps)) |

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
with no counter-model, a statement whose numbers a stand-in OEIS (the factory `oeis` over a `fetch`
that answers from a file, behind the registry) names, with its two `oeis.search` tool runs in the
journal, and the options.

## To verify against Lean

What depends on Lean's exact behaviour and has only run against simulations. The harness's own list
is in [lean.md](lean.md#to-verify-against-lean). The first item here is the one that decides whether
a refutation of a claim over `Type*` can ever pass; it takes a minute on a Lean server with Mathlib:

1. **The negation of a claim over `Type*`, in both forms.** Elaborate this file:

   ```lean
   import Mathlib

   theorem t (M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x := sorry

   theorem t_negation : ¬ (type_of% @t) := by
     intro hall
     have key := @hall (ULift (Fin 2)) ⟨fun a b => ULift.up (([0, 0, 1, 1] : List (Fin 2)).getD (a.down.val * 2 + b.down.val) 0)⟩
     revert key
     decide

   def aux_table (a b : Fin 2) : Fin 2 := ([0, 0, 1, 1] : List (Fin 2)).getD (a.val * 2 + b.val) 0

   theorem t_negation' : ¬ (type_of% @t) := by
     intro hall
     exact absurd (@hall (ULift (Fin 2)) ⟨fun a b => ULift.up (aux_table a.down b.down)⟩) (by decide)
   ```

   What to look at: that `t_negation` has a universe parameter (`#check @t_negation`) and `hall :
   ∀ (M : Type u_1) [Mul M], ...`, so that `@hall (Fin 2) ...` fails with a type mismatch and
   `ULift (Fin 2)` is accepted in its place; that `decide` finds the `Fintype` and `DecidableEq`
   instances of `ULift (Fin 2)` and evaluates the proposition; and that both theorems elaborate with
   no error. The same file with `(M : Type)` and `Fin 2` is the plain form, which should also check.
   If `decide` cannot find an instance, the forms of `negationProofs` need to supply it.
2. **The files of the Lean evaluator.** The text of the files (`abbrev`, the `Fin` instance from a
   `List`, `decide` on the instantiated statement) is written from what Lean 4 and Mathlib accept,
   and `pnpm harness contract lean.check` does not cover it.
3. **The proofs of the negation of a claim over `Type`, and of a number.** The forms above with `Fin
   n`, and `@hall 7` for a number, which are tested only against a simulated Lean.

## What is not done

- The adapters for SageMath have not run against a real SageMath.
- A statement about groups, graphs or any other structure has no Lean evaluator: a program in
  JavaScript is the evaluator for those.
- Magmas of size 4 are sampled, never listed. Groups of order 16 and above are partly built.
- No run of the line has used a real model or a real Lean. The proofs of negations that its tests
  accept are the ones the simulated Lean was told to accept; whether Lean accepts them is the first
  thing to check ([above](#to-verify-against-lean)).
- `oeis.search`, `lmfdb.query` and `findstat.identify` have not made a request to their sites, and
  their contracts have not run against them ([the services as
  capabilities](#the-services-as-capabilities)). The table of known sequences has 65 sequences, and a
  query that is not in it is looked up only on a host that offers `oeis.search` and reaches the
  OEIS.
