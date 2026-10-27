# Memory

The memory is what a run knows besides its attempts: claims, the edges between them, and records
of every other kind (lemmas, lessons, fingerprints...). It lives in the run's journal like every
other fact ([journal.md](journal.md)); `@seshat/memory` gives it one interface, the `MemoryStore`,
which is the one way mechanisms read and write it.

```ts
import { MemoryStore } from "@seshat/memory";

const memory = new MemoryStore({ journal, blobs });
const { claimId, created } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", header: "import Mathlib", origin: "line:M1" });
memory.addEdge({ kind: "special_case_of", from: claimId, to: otherId, note: "n = 0" });
memory.recordNode({ kind: "lesson", claimId, data: { text: "omega cannot see through digits" } });
```

Every write appends one event, which the journal checks against its invariants
([journal.md](journal.md#invariants)) before it is written; every read comes from the projection. A
store writes as its `actor` (`memory` by default); `withActor("line:M1")` gives a view of the same
store that writes as another actor. The orchestrator gives each line such a view, so the journal
says which line wrote what. `blobs` is the run's blob store, for contents too large for an event:
a node's data can name a blob by its hash.

The memory is the graph of the mathematics. The work of a run (which prover does what, with what
budget, and whether it is done) is another graph, the task ledger ([ledger.md](ledger.md)): a task
points at claims and edges, and states what it must achieve in terms of their statuses, but never
holds a status of its own for a claim, and the store has no method that writes a task.

Lines never touch the journal. The store keeps it in a private field, in every view, so a line has
no way to emit an event the store has no method for, and the trust rules ([trust.md](trust.md))
hold by construction: a line raises a claim's status only through `validate`
([lines.md](lines.md#validate)), and lowers one only through `retractClaim` ([below](#claims)), the
single named exception. A task that needs a write the store lacks adds a narrow method here, never
a raw `emit`.

## Claims

A claim is a statement with a status ([trust.md](trust.md#claim-statuses)).

| Field | Meaning |
|---|---|
| `statement` | For a formal claim, Lean in signature form: the binders, then `:` and the type, as between a theorem's name and its `:=` (`(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2`); `ensureClaim` refuses any other form ([statement form](#statement-form)). Prose for an informal claim. |
| `header` | The imports, `open`s and definitions the statement needs. A claim about a problem's own definitions takes the problem's prefix ([below](#claims-about-the-problems-own-definitions)). |
| `kind` | `formal` (default) or `informal`. |
| `gloss` | A short gloss in words. |
| `domain` | Domains, such as `msc:11`. |
| `parentId` | The claim this one comes from: a variant, a subgoal, a part. |
| `origin` | Where it comes from: `bench:<id>`, `line:M1`, a capability. |

`ensureClaim({statement, header?, origin, gloss?, domain?, kind?, parentId?})` returns the claim of
a statement: the existing claim with the same statement id, or a new one (plan §3.1, "same hash,
same claim"). It returns the claim id, the statement id, and whether it created the claim. The
first claim of a statement keeps its fields: a second `ensureClaim` with another gloss changes
nothing.

The statement id comes from a `StatementIdentity` (`{version, id(statement, {header?, kind?})}`),
which may be asynchronous. `TextIdentity`, the default, is `statementIdV0`: a hash of the text
without comments and with whitespace collapsed (`st0_`), which only catches textual duplicates
([journal.md](journal.md#statement-ids)). It reads the `header` too: given one, it hashes the
header with the statement, normalized the same way, so the same text under another header is
another claim, which keeps its own header; a statement with no header, or one whose header has
nothing in it, has the id of its text alone. So distinct statements never share a claim, and fewer
are merged than the elaborated statement will merge. `LeanIdentity` (`@seshat/lean-meta`,
[lean-meta.md](lean-meta.md#leanidentity)) is the Lean-backed identity: `st1_`, the hash of the
elaborated statement, read under its header. The store takes any identity without change. A run
uses one identity, since ids of different versions never compare equal. A line gives the run its
identity (`Line.identity`, [lines.md](lines.md#a-line)); M1 gives the text one, and no line gives
`LeanIdentity` yet.

In a run with lines the orchestrator makes each problem's claim with `ensureClaim` as well (origin
`bench:<id>`, the problem's domains, and the prefix of the problem's file as `header`), so every
claim of the run is named by the run's identity, and two problems with one statement under one
prefix share one claim and its attempts. The prefix is everything in the file before the problem's
docstring, earlier theorems included: problems of one file never share a claim. A line that states
a problem's statement again, or makes a claim about the problem's own definitions, passes the same
prefix as its `header`, and gets the problem's claim. A run without lines is M0: one claim per
problem, with the bench's `st0_` id, which is the statement's alone.

### Statement form

`ensureClaim` checks a formal statement's form before it computes the statement id, and refuses what
cannot be a signature with a message that says what to write. A statement is binders, then `:`,
then the type: the binders are bracketed groups (`(x : T)`, `{x : T}`, `[C x]`, `⦃x : T⦄`) or bare
names, and there may be none. So `: 1 + 1 = 2` and `(n : ℕ) : n + 0 = n` pass, and these do not:

| Refused | Why |
|---|---|
| `1 + 1 = 2`, `∀ n : ℕ, n = n`, `Nat.Prime 7` | A bare proposition: only binders may come before the `:`. Write `: 1 + 1 = 2`. |
| `True`, `Even n` | Names only, with no `:` before the type. |
| `theorem t : True`, `example : True` | A whole declaration. Give what follows the theorem's name. |
| `(n : ℕ) : n = n := rfl` | A proof (`:=`). Give the binders and the type. |
| `(n : ℕ` | A bracket that is not closed. |

The check is syntactic and conservative: it refuses what cannot be a signature, and Lean still
decides, when the reference file is checked, whether the binders and the type mean anything.
`signatureProblem(statement)` gives the reason, or undefined for a statement in signature form.
An informal claim (`kind: "informal"`) is prose and has no form.

### Claims about the problem's own definitions

A problem's file has its imports, `open`s, namespace and definitions before the target theorem. A
claim that a line states about them (a variant, a subgoal, a negation, a lemma on the problem's
definitions) is checked against a file made from its `header`, so it takes the problem sketch's
prefix as its header, or the names the problem defines do not resolve and its reference file does
not check:

```ts
await memory.ensureClaim({ statement: "(n : ℕ) : n < 3 → P n", header: problem.target.sketch.prefix, parentId: problem.claimId, origin: "line:M2" });
```

`problem` is the hook's context ([lines.md](lines.md#what-a-hook-gets)). The prefix is everything
before the target theorem, with the file's `namespace` lines and no `end`, which Lean accepts at
the end of a file. A claim that needs only Mathlib takes `import Mathlib` instead.

A status goes up only through the validator and the certifier ([trust.md](trust.md)). The store can
only lower one: `retractClaim(claimId, {reason})` takes back a claim whose status rested on
something that was withdrawn, which is how a mechanism revokes what it derived (the line M2, for a
claim that held only through a composed proof, and its only caller). A `computed` claim goes back to
`open`; a `proved`, `refuted` or `proved_informal` claim becomes `retracted`; an `open` or
`retracted` claim stays as it is. The method picks the lower status itself, so it cannot raise a
claim, and it refuses a blank reason. It emits `claim.status_changed` as the store's actor, which the
journal checks like any other.

## Edges

An edge goes from a claim or node to one target, or to several for `decomposes_into`. Each has a
status and its provenance: the attempt, tool run or validation it came from, and a note.

| Kind | From, to |
|---|---|
| `implies` | A implies B. |
| `equiv` | A and B are equivalent. |
| `special_case_of` | A is a special case of B. |
| `strengthens` | A strengthens B. |
| `negation_of` | A is the negation of B. |
| `decomposes_into` | A follows from the parts B1..Bn (a sketch). |
| `uses` | A proof of A uses the premise B. |
| `refuted_by` | A is refuted by the counterexample B. |
| `derived_from` | The variant A was derived from B. |
| `cites` | A cites the source B. |
| `instance_of` | A is a syntactic instance of B. |

Edge statuses are `proposed`, `computed`, `informal_checked`, `human_signed` and `lean_checked`
([trust.md](trust.md#edges)); only `lean_checked` edges propagate proofs. An edge of a kind a Lean
lemma can check (all but `uses`, `derived_from` and `cites`) carries that lemma as its `link`:
`{name, statement}`, the statement in the claims' signature form. It becomes `lean_checked`, when
it is added or later, only with a valid validation of a claim whose statement is the link's: state
the lemma with `ensureClaim`, validate a proof of it, then pass the validation's id.

`addEdge({kind, from, to, status?, attemptId?, toolRunId?, validationId?, note?, link?})` adds an
edge (`proposed` by default); `setEdgeStatus(edgeId, to, {reason, validationId?})` moves it. The
variants and the propagation over `lean_checked` edges are the line M2 ([graph.md](graph.md)).

## Nodes

A node is a record of any other kind. The plan names them (§2): lemmas, analogies, lessons,
sources, groups, inspirations, hypotheses, data tables, drifts, batteries, fingerprints, repairs.
The core only checks that a node is well formed, so a mechanism adds a kind without touching it:

- `kind` is a short lowercase word (`[a-z][a-z0-9_]*`, at most 32 characters), such as `lemma`,
  `lesson`, `data_table` or `fingerprint`;
- the package that owns a kind owns the shape of its `data` (JSON) and documents both on its
  page; only that package writes nodes of its kind, others read them;
- a node may be about a claim (`claimId`), and edges can start or end at it;
- `updateNode(nodeId, patch, reason)` applies a JSON merge patch (RFC 7386) to the data: keys set
  to `null` are removed, objects merge, anything else replaces;
- contents too large for an event go to the blob store, and the node keeps their hash.

`recordNode({kind, claimId?, data})` returns the node with its new id.

## Queries

| Query | Gives |
|---|---|
| `claim(id)` | The claim, or undefined. |
| `claimByStatement(statementId)` | The first claim with that statement id. |
| `edge(id)` | The edge. |
| `edges({from?, to?, kinds?, minStatus?})` | The edges that meet every criterion, in the order they were added. `to` matches any target and is answered from an index of targets, not by scanning the edges; `minStatus` counts in the order `proposed`, `computed`, `informal_checked`, `human_signed`, `lean_checked`. |
| `equivalents(claimId)` | The claim and every claim reached from it through `lean_checked` `equiv` edges, in both directions: the claim first. |
| `attempts(claimId, {includeEquivalents?})` | The attempts on the claim (and on its equivalents), in the order they started, with their role, strategies, premises and outcome. |
| `alreadyTried(claimId)` | The attempts on the claim and its equivalents that were accepted or failed, grouped by their classified strategy: how many, how they failed, the last failure. Never the attempts' text ([m1-identity-memory.md](m1-identity-memory.md#already-tried)). |
| `validations(claimId)` | Its validations, of the claim and of its negation, in order. |
| `node(id)` | The node, its data with every patch applied in order. |
| `nodes(kind, {claimId?})` | The nodes of a kind (about one claim), in the order they were recorded. |

Records use the events' names (`claimId`, `parentId`, `declaredStrategy`...), and a field that is
not set is absent.

## Provenance and epochs

An artifact a mechanism learns from outcomes rather than from Lean is unverified (Global
Constraint 16): an attempt record that "already tried" reads, a lesson, a posterior, a schema, a
channel statistic, a prompt. It carries a provenance stamp, and it never becomes a fact. A claim
proved by the certifier, an edge checked by a Lean lemma, a library lemma are model independent and
carry none.

```ts
interface Provenance {
  modelId: string;        // the prover model as configured, PROVIDER/ID
  promptVersion: string;  // the provers' PROMPT_VERSION
  mathlibRev: string;     // the bench's revision, until the Lean environment's hash stands in for it
  harnessVersion: string; // the code revision of the run
  budgetClass: string;    // tiny, small, medium, large, huge or unbounded, from the dollars per problem
  createdAt: string;      // ISO 8601
}
```

What is stamped, today:

| Artifact | Where the stamp is |
|---|---|
| An attempt record | `provenance` of `attempt.started`, with the model of the session. M1's "already tried" and the fleet's posteriors read these records. |
| A model's notes | `provenance` of `lesson.recorded`. |
| A node a mechanism learned | `provenance` of `node.recorded`, set by `recordNode({..., learned: true})`. |
| An epoch | `provenance` of `memory.epoch_opened`, the run that opened it. |

`store.stamp({modelId?})` is the helper that later artifacts use (lessons, schemas and cells, prompts):
it gives the stamp of an artifact made now, from the context the run gave the store
(`MemoryStoreOptions.provenance`). A mechanism that learns something stamps it, whatever record it
stores it in; a node says `learned: true` and the store stamps it. `store.attempts(...)` gives each
attempt's `provenance`, `epoch`, `included` and `withheld`, and `store.lessons(claimId)` the lessons.

The orchestrator builds the context from the run: the configured model, `PROMPT_VERSION`, the bench's
revision as `mathlibRev`, the code revision as `harnessVersion` (`unknown` without one) and the budget
class of `budget.problemUsd`. A run that is resumed stamps with its resumed process's code revision.

### Config classes

PE3 groups attempts by the configuration they ran under. `configClassOf(provenance)` gives
`{family, budgetClass}`, and `configClassKey` the same as one string. The family of a model is its
`PROVIDER/ID` without a snapshot suffix (`-20250929`, `-2025-09-29`, `@20250929`, `-latest`), so a
new snapshot is the same family and a new version number is another one: a model upgrade is what
starves a posterior (PE3). The rule reads the text of the id; an id it does not recognize is its own
family. The budget classes are `tiny` (under $0.5 per problem), `small` (under $2), `medium` (under
$10), `large` (under $50), `huge`, and `unbounded`.

### Epochs

The memory has a current epoch, 0 at first. A new epoch opens, with the event `memory.epoch_opened`
(its number, the reason in words, the changes, the stamp of the run), when the prover model family, the
prompts' major version or the Mathlib revision is not the one of the memory's previous run:

| Trigger | Compared |
|---|---|
| The prover model family | `modelFamily` of the configured model |
| The prompts' major version | `promptMajor(PROMPT_VERSION)`: the version up to its last integer, so `m0-3` is another major than `m0-2` and `m0-2.1` is the same one (a minor part is a rewording) |
| The Mathlib revision | the bench's revision |

A change of the harness version or of the budget class opens none. The orchestrator opens the epoch
when a run starts on the memory of an earlier run ([below](#memory-across-runs)); only the orchestrator
may write the event, and a store of another actor is refused by the journal. `store.epoch()` is the
current epoch, `store.epochs()` the epochs entered, and every attempt, lesson and learned node keeps the
epoch it was recorded in. Nothing is deleted: the journal keeps all.

### Probation

On a new epoch the unverified artifacts of older epochs enter probation. Their counters are shrunk
toward the prior: Beta(a, b) becomes Beta(1 + (a - 1) k, 1 + (b - 1) k), with k = 0.25 by default
(`MemoryStoreOptions.probation`). Counters here are sums of outcomes, so the shrinkage is a weight on
each outcome: `store.weightOf(epoch)` is 1 for an outcome of the current epoch and k for each epoch
opened since, and `shrinkBeta(beta, k)` is the same arithmetic on a posterior that already exists.
An item regains weight only through outcomes: the weight of an old outcome does not come back with time
or with the item being shown, and a new outcome counts in full. The [randomized inclusion](#randomized-inclusion) of unverified items treats an
item of an older epoch as new again, so it is shown at random until it has earned its place again.

## Randomized inclusion

A lesson present in a successful attempt is credited with the success even when it did not cause it,
so a lesson that is shown often gains points by being there and never leaves (plan change PE2). The
memory store draws the unverified items a session is shown at random, and judges each by its effect.
Tasks 9, 11 and 18 call it for lessons, schema hints, inspiration examples and library hint sections.

**The draw.** `store.draw(items, random, options?)` takes the ids of the unverified items a line
selected for a session and includes each with probability `pNew` (0.5) while it has been included
fewer than `nNew` (20) times in the current epoch, then `p` (0.9). It returns `{included, withheld,
fixed, chances, uses}` and writes nothing. The draw is made one item at a time in the order of the ids,
from a seeded random source, so the same seed and history give the same draw whatever order a line lists
the items in. A *use* is a session that included the item (`attempt.started`'s `included`); a withheld
item was not used. A new epoch counts uses from zero, so an item in probation is drawn at `pNew` again
([above](#probation)).

What is never drawn: a claim, whether the goal or a verified fact, and any item the caller flags
`{id, verified: true}`. They come back in `fixed`, to be shown, and appear in neither list. A line passes
only what it chose to show; the facts a proof needs and the goal are not subject to withholding.

**In a run.** A line draws in `beforeSession` with `session.draw(items, options?)`: the orchestrator
draws from the run's seeded source (`--draw-seed`, default the run's id; the stream is seeded by the
seed, the problem, the prover, the session and the line), and records both lists on `attempt.started`
(`included`, `withheld`). The briefing and the other hooks of the session read `session.drawn`, so what
the line shows is what the journal says it showed; they cannot draw, since the attempt has started. An
item drawn twice in one session keeps its first outcome. A session with no draw records neither list.

```ts
beforeSession: async (session) => {
  const { included } = session.draw(lessons.map((l) => l.id)); // recorded on attempt.started
  ...
},
briefing: async (session) => ({ title: "Lessons", text: show(session.drawn.included) }),
```

**The effect.** An item's effect is the difference between the success rates of the attempts that were
shown it and of those that were denied it, in one group of claims and one strategy label, as two Beta
posteriors. `store.itemEffect(itemId, {claimIds?, strategy?})` gives `{with, without, difference,
pNegative}`; each side is `{attempts, successes, failures, posterior}` with the posterior Beta(1 +
successes, 1 + failures). Only the attempts whose draw named the item count, the included ones on one
side and the withheld ones on the other, which is what makes the comparison causal: an attempt that
was never offered the item was selected by something else. A proof the fast check accepted is a
success, a failed check a failure, and a session that was cut says nothing. The claim group is the set of
claims the caller names (for one claim, `store.equivalents(claimId)`, the group "already tried" reads);
the strategy label is the one classified when the attempt finished, else the one declared.
`store.itemEffects(itemId, {claimIds?})` gives the effect for each label.

Each outcome counts with the probation weight of its epoch ([above](#probation)), so an item of an
older epoch regains weight only through new outcomes. `pNegative` is P(effect < 0), the chance that the
rate with the item is below the rate without it: the integral of one posterior against the other, exact
up to the integration and deterministic. `shouldDeactivate(effect, {minObservations, threshold?})` is
M5's rule: deactivate when P(effect < 0) is above the threshold (0.9) after at least `minObservations`
attempts on each side. `pNew`, `nNew`, `p`, the threshold and the minimum are options of the caller.

The presence counter that this replaces stays where it is, for comparison. The causal rule is measured
against it in lesson set size and solve rate at equal budget (Task 14); nothing here has run against a
real model.

## Reference files

A proof is checked against a reference: a Lean file, and the theorem in it that states the claim
([validator.md](validator.md)). `referenceFor(claimId, {negation?})` gives it as `{source,
theorem}`:

- a claim with a file of its own uses it: the orchestrator gives each problem's claim its bench
  file with `setReference(claimId, {source, theorem})` (not an event: the file comes from the
  problem's source, which `problem.registered` records). Only the orchestrator's root store can
  call it: a view made with `withActor`, which is what a line is given, throws. The reference is
  what a proof is compared with, so a line that could replace it could have a proof of another
  statement accepted. Every claim that is not a problem's is therefore compared with the file
  rebuilt from its journaled statement and header, whatever a line does. `referenceFor` gives a
  copy, so a line that edits the one it was given changes nothing;
- any other formal claim gets `<header>`, a blank line, then
  `theorem <claim id> <statement> := by sorry`;
- the negation appends to that file `theorem <name>_negation : ¬ (type_of% @<theorem>) := by
  sorry`. `type_of%` takes the type Lean elaborated, with its binders, section variables and
  universes, so the negation is that of the whole statement and nothing parses binders. The
  claim's own theorem is in the file, proved by `sorry`; a proof of the negation that used it
  would depend on `sorryAx`, which the validator refuses;
- an informal claim has no reference.

The lines' `validate` checks proofs of any claim, and of its negation, against these files
([lines.md](lines.md#validate)). The generated files have not been run against a real Lean yet.

`setReference` is not an event, so a store opened on a finished run's journal (to read it, or to
validate more) does not have the problems' bench files. `referenceFor` then gives a problem's claim
the generated file, and the orchestrator creates that claim without a header, so the file has no
imports or definitions and does not check. Rebuilding the bench file needs the bench checkout:
`problem.registered` names the repository, revision and path, and `setReference` gives the file
back.
A run that is resumed ([ledger.md](ledger.md#resume)) gives the claim of each problem it takes up
its bench file again, for the same reason.

## Not done yet

- The dedup of near-equal statements (plan §3.1). `LeanIdentity` exists, but no run uses it yet.
- Indexes beyond the projection's tables: embeddings, fingerprints, the subsumption index.
