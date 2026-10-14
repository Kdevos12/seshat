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

## Claims

A claim is a statement with a status ([trust.md](trust.md#claim-statuses)).

| Field | Meaning |
|---|---|
| `statement` | For a formal claim, Lean in signature form: the binders, then `:` and the type, as between a theorem's name and its `:=` (`(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2`). Prose for an informal claim. |
| `header` | The imports, `open`s and definitions the statement needs. |
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
([journal.md](journal.md#statement-ids)). A Lean-backed identity (`st1_`, the hash of the
elaborated statement) is planned; the store takes any identity without change. A run uses one
identity, since ids of different versions never compare equal. The bench gives each problem's claim
its `st0_` id, so with `TextIdentity` a line that states a problem's statement again gets the
problem's claim.

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
edge (`proposed` by default); `setEdgeStatus(edgeId, to, {reason, validationId?})` moves it.

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
| `edges({from?, to?, kinds?, minStatus?})` | The edges that meet every criterion, in the order they were added. `to` matches any target; `minStatus` counts in the order `proposed`, `computed`, `informal_checked`, `human_signed`, `lean_checked`. |
| `equivalents(claimId)` | The claim and every claim reached from it through `lean_checked` `equiv` edges, in both directions: the claim first. |
| `attempts(claimId, {includeEquivalents?})` | The attempts on the claim (and on its equivalents), in the order they started, with their role, strategies, premises and outcome. |
| `validations(claimId)` | Its validations, of the claim and of its negation, in order. |
| `node(id)` | The node, its data with every patch applied in order. |
| `nodes(kind, {claimId?})` | The nodes of a kind (about one claim), in the order they were recorded. |

Records use the events' names (`claimId`, `parentId`, `declaredStrategy`...), and a field that is
not set is absent.

## Reference files

A proof is checked against a reference: a Lean file, and the theorem in it that states the claim
([validator.md](validator.md)). `referenceFor(claimId, {negation?})` gives it as `{source,
theorem}`:

- a claim with a file of its own uses it: the orchestrator gives each problem's claim its bench
  file with `setReference(claimId, {source, theorem})` (not an event: the file comes from the
  problem's source, which `problem.registered` records);
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

## Not done yet

- The Lean-backed statement identity, and the dedup of near-equal statements (plan §3.1).
- Propagation over `lean_checked` edges and revocation (plan §3.2): the edges are stored, nothing
  follows them yet except `equivalents`.
- Indexes beyond the projection's tables: embeddings, fingerprints, the subsumption index.
