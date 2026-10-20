# The graph: variants and propagation (M2)

The memory stores claims and the edges between them ([memory.md](memory.md)). The line M2 (plan
§3.2) makes the edges work, in `@seshat/graph`:

- **Variants and edges.** A strengthening, a special case, a generalization or the negation of a
  claim, joined to it by an edge. The edge is `proposed` until Lean checks its link lemma.
- **Propagation.** Nineteen rules follow the `lean_checked` edges, so that a result on one claim
  becomes a result on its neighbors: with provenance (why a fact holds) and revocation (a fact
  stops holding when what it rests on is withdrawn). What the rules derive is a proposal: the graph
  writes the composed Lean proof, and the claim changes only if `validate` accepts it.
- **The prove/refute twin.** The negation of a problem's claim is a claim of its own. A model tries
  to prove it alongside the provers; when one side settles, the graph stops the other.
- **Readings of the graph** for the other lines: "proved modulo" labels, nogoods and the value of an
  open lemma (for the scheduler, M12, and the context compiler, M4), personalized PageRank, and
  typed path queries with short ids.

The trust rules do not change ([trust.md](trust.md)). The graph never gives a claim a status: every
change goes through `validate`, so a derived result is `computed` at most, as any proof that passes
the fast check; only the certifier makes `proved` or `refuted`, and the run runs it on what the
line submitted when the problem ends ([m0-loop.md](m0-loop.md#certification)). Only `lean_checked`
edges propagate. A wrong edge can mislead a search, never prove anything.

## Using it

```sh
pnpm harness run --checkout ... --model PROVIDER/ID --lines M2
pnpm harness run --checkout ... --model PROVIDER/ID --lines M2 --line-option M2.twinTries=3
```

M2 needs no other line, and runs with M1 (`--lines M1,M2`). `--ablation M2` is the plan's cumulative
config, M0 + M1 + M10 + M2, so it refuses to start until M10 is written
([lines.md](lines.md#cumulative-configs)).

The pieces also work without a run, on a `MemoryStore`:

```ts
import { Atms, GraphState, checkEdge, createVariant, realize } from "@seshat/graph";

const variant = await createVariant(memory, { from: claimId, relation: "strengthening", statement: "(n : ℕ) : n + 0 = n ∧ 0 + n = n" });
await checkEdge({ memory, validate }, variant.edge.edgeId);   // lean_checked, once its link lemma passes validate
const state = new GraphState(memory, [claimId]);               // the engines, kept in step with the memory
await realize({ memory, state, validate, headerOf: (id) => memory.claim(id)?.header });
const labels = new Atms(state).refresh();                      // proved-modulo labels
```

`validate` is the line context's (`ProblemContext.validate`, [lines.md](lines.md#validate)).

## Variants and edges

`createVariant(memory, {from, relation, statement?, header?, gloss?, domain?, origin?, attemptId?,
note?})` states the variant with `ensureClaim` (so a statement the memory has is that claim, and the
variant's `parentId` is the claim it comes from) and adds the edge with `proposeEdge`, as
`proposed`. A negation may leave out its statement: it is `: ¬ (∀ binders, type)`, the claim's
statement as one proposition. The variant is read under the claim's header unless one is given.

| Relation | Edge | Link lemma |
|---|---|---|
| `strengthening` | `strengthens`, variant → claim | variant → claim |
| `special_case` | `special_case_of`, variant → claim | claim → variant |
| `generalization` | `special_case_of`, claim → variant | variant → claim |
| `negation` | `negation_of`, variant → claim | variant ↔ ¬ claim |

`proposeEdge(memory, {kind, from, to, ...})` adds any edge between formal claims. It writes the
edge's link lemma from the two statements, so that the lemma has the shape the rules and the
composed proofs rely on (`F` is the `from` end, `T` the `to` end, each as one parenthesized
proposition `(∀ binders, type)`):

| Edge | Link lemma |
|---|---|
| `implies`, `strengthens` | `F → T` |
| `special_case_of`, `instance_of` | `T → F` (the general statement implies the special one) |
| `equiv` | `F ↔ T` |
| `negation_of` | `F ↔ ¬ T` |
| `decomposes_into` | `T1 → ... → Tn → F` (the parts imply the whole) |
| `refuted_by` | `T → ¬ F` (the counterexample refutes the claim) |

`uses`, `derived_from` and `cites` have no lemma and do not propagate. An edge between the same
claims and of the same kind is added once. Informal claims have no variants and no lemmas.

`checkEdge({memory, validate, header?, closers?, propose?, attemptId?, log?}, edgeId)` makes an edge
`lean_checked`: it states the lemma as a claim of its own, submits proofs of it through `validate`,
and on the first valid one moves the edge with that validation (`setEdgeStatus`). The proofs come
from cheap tactics first (`closers`, by the kind of lemma: `exact fun h => h`, `tauto`, `omega`,
`aesop`, `exact Iff.rfl`...), then from `propose`, a function that returns more proofs, given what
failed (a model's, for lemmas the tactics cannot do). A lemma that does not compile stops the
search; a lemma checked before is accepted at once. The result says whether the edge is checked,
why, how many proofs were tried, and the lemma's claim and validation. The only status it changes is
the lemma's own claim, which becomes `computed` like any claim whose proof passes the fast check.

## Propagation

A fact is `P:<claim>` (the claim is proved) or `R:<claim>` (it is refuted: its negation, as one
proposition, is proved). The base facts are the claims' statuses and validations; the rules read
the `lean_checked` edges, one rule instance per edge, written as Datalog clauses over the facts.
`A` is the `from` end of the edge and `B` the `to` end.

| Rule | Says |
|---|---|
| `implies/proved` | A is proved and A implies B: B is proved. |
| `implies/refuted` | B is refuted and A implies B: A is refuted. |
| `strengthens/proved` | A strengthens B and A is proved: B is proved. |
| `strengthens/refuted` | A strengthens B and B is refuted: A is refuted. |
| `special_case_of/proved` | A is a special case of B and B is proved: A is proved. |
| `special_case_of/refuted` | A is a special case of B and A is refuted: B is refuted. |
| `instance_of/proved` | A is an instance of B and B is proved: A is proved. |
| `instance_of/refuted` | A is an instance of B and A is refuted: B is refuted. |
| `equiv/proved-forward` | A is equivalent to B and A is proved: B is proved. |
| `equiv/proved-backward` | A is equivalent to B and B is proved: A is proved. |
| `equiv/refuted-forward` | A is equivalent to B and A is refuted: B is refuted. |
| `equiv/refuted-backward` | A is equivalent to B and B is refuted: A is refuted. |
| `negation_of/proved` | A is the negation of B and A is proved: B is refuted. |
| `negation_of/refuted` | A is the negation of B and A is refuted: B is proved. |
| `negation_of/proved-back` | A is the negation of B and B is proved: A is refuted. |
| `negation_of/refuted-back` | A is the negation of B and B is refuted: A is proved. |
| `decomposes_into/parts` | Every part of A is proved: A is proved. |
| `decomposes_into/last-part` | A is refuted and every part of A but one is proved: that part is refuted. |
| `refuted_by/counterexample` | The counterexample B of A is proved: A is refuted. |

The twentieth rule is a check, not a derivation: `Engine.contradictions()` lists the claims that are
proved and refuted at once, which means a bug in a formalization or a wrong edge.

### The engine

`Engine` evaluates the rules over ground instances, semi-naively: a new base fact or edge fires only
the instances it takes part in, and the engine keeps every instance whose premises hold. So:

- `holds(fact)`, `derivedFacts()`, `facts()`: what holds, and what only a rule gave.
- `derivations(fact)`: the provenance, every instance that gives the fact now.
- `explain(fact)`: one derivation tree, the shortest, with the rule and the edge at each step. It is
  well founded even where facts support each other in a cycle.
- `removeBase`, `removeEdge`: revocation. What depended on the fact or the edge is deleted, then the
  facts that still follow from what remains are derived again (delete and re-derive), so a cycle,
  such as an equivalence, cannot keep a fact alive on its own.

Trust forms a lattice: a fact is not known, a candidate (it rests on claims that passed the fast
check, `computed`) or certified (it rests on `proved` claims only), and a derived fact is as
trusted as its weakest premise (`Level`). Two engines hold the two levels (`GraphState.candidate`
and `.certified`), and `levelOf(fact)` gives the highest level a fact holds at. A claim that is
proved and refuted at once is a contradiction, which the engine reports and does not hide.

### The state

`GraphState(memory, seeds)` keeps the two engines in step with the memory. `sync()` reads the claims
reachable from the seeds through edges of any status and of the kinds the rules read (a `cites` edge
to a shared source pulls nothing in), and changes the engines by the difference only: new
`lean_checked` edges and statuses fire rules, withdrawn ones revoke what depended on them.
It writes nothing. `levelOf(fact)` gives the level a fact holds at, `explain(fact)` its tree, and
`claims()` the claims it follows.

A claim whose only valid proofs are composed ones (below) is not a base fact: it holds only as long
as the graph still derives it. A composed proof that the certifier checked is a base fact.

### Composed proofs

A derived `P:B` says that B follows; it does not prove B. `composeProof(tree, source, headerOf)` writes
the proof from the derivation tree: the proofs on record for the premises, and the link lemmas of the
edges, become auxiliary theorems, each derived step applies a link lemma to its premises, and the last
step is the submitted proof. The proofs come from the memory (`memorySource`): a claim's valid
validations and the submissions the blob store keeps, and for a link lemma the validation that made
its edge `lean_checked`.

| Piece | Name |
|---|---|
| The proof of a premise | `aux_m2_p<n>` |
| The proof of the negation of a premise | `aux_m2_r<n>` |
| A link lemma, with the proof that checked it | `aux_m2_l<n>` |
| A derived step | `aux_m2_d<n>` |

The auxiliary declarations of a reused proof are renamed apart (`aux_foo` becomes
`aux_m2_p1_foo`). With `L` the link lemma, `X` the premise and `n` the explicit binders of the claim,
the step is:

| Rule | Step |
|---|---|
| `implies/proved`, `strengthens/proved`, `special_case_of/proved`, `instance_of/proved` | `exact L X n` |
| `implies/refuted`, `strengthens/refuted`, `special_case_of/refuted`, `instance_of/refuted` | `exact fun h => X (L h)` |
| `equiv/proved-forward` | `exact L.mp X n` |
| `equiv/proved-backward` | `exact L.mpr X n` |
| `equiv/refuted-forward` | `exact fun h => X (L.mpr h)` |
| `equiv/refuted-backward` | `exact fun h => X (L.mp h)` |
| `negation_of/proved` | `exact L.mp X` |
| `negation_of/refuted` | `exact Classical.not_not.mp (fun h => X (L.mpr h)) n` |
| `negation_of/proved-back` | `exact fun h => (L.mp h) X` |
| `negation_of/refuted-back` | `exact L.mpr X n` |
| `decomposes_into/parts` | `exact L X1 ... Xn n` |
| `decomposes_into/last-part` | `exact fun h => X (L X1 ... h ... Xn)`, with `h` for the missing part |
| `refuted_by/counterexample` | `exact L X` |

It fails, with the reason, when a premise has no proof on record, an edge lost its link proof, or
the claims do not share a header (their statements would not mean the same in one file).

`realize({memory, state, validate, headerOf, minLevel?, limit?, tried?, signal?, ...})` does the
rest. It syncs the state, then for each derived fact about a claim that is still open, shortest
derivation first, composes the proof and submits it through `validate` (the proof of the negation
for an `R:` fact, which changes no status). The claim becomes `computed` if Lean accepts it, and
the state is synced again, so that a claim just settled serves the next derivation. The certifier
checks the composed proof when the problem ends: the claim becomes `proved`, or `refuted` for a
composed refutation, and from then on it is a base fact of the graph, as it holds through a proof
of its own that carries its premises' proofs. A proof that
fails is not sent twice, and the failure is recorded. It stops at `limit` (8 by default) or when
`signal` aborts; a check cut off by the abort says nothing about the proof, so no derivation is
recorded for it and it may be sent again.

Each submission is a `derivation` node about the claim:

| Field | Meaning |
|---|---|
| `goal`, `claimId` | `proved` or `refuted`, and the claim. |
| `rule`, `edges` | The rule of the last step, and the edges the derivation used. |
| `premises` | The facts the last step read, as `{goal, claimId}`. |
| `level` | `candidate` or `certified`. |
| `verdict` | `valid` or `invalid`: what `validate` said. `skipped`: nothing was composed or submitted. |
| `validationId` | The validation, when there is one. |
| `reasons` | Why it was invalid or skipped. |

`revokeUnsupported(memory, state)` is the revocation of the claims: one that is `computed` or `proved`
only through a valid composed proof, and that the graph no longer derives, goes back to `open`
(`computed`) or to `retracted` (`proved`), by `MemoryStore.retractClaim`
([memory.md](memory.md#claims)). A claim with a proof of its own is left alone. It judges only the
claims the state follows (`state.claims()`): the memory holds the derivations of every problem of a
run, and a claim that another problem composed, outside this state's graph, is not held by this
state's engine and not this state's to withdraw. A state that reaches the claim through an edge, as
a seed or not, does judge it.

## The twin

A claim and its negation are a twin: `createTwin({memory, validate, header?, ...}, claimId)` creates
the negation as a variant, adds the `negation_of` edge, and checks it (`Iff.rfl` closes the standard
negation). Proving the negation refutes the claim and proving the claim refutes the negation
(`negation_of/proved` and `negation_of/proved-back`), so once the edge is `lean_checked` the graph
decides one side from the other.

- `twinSettled(state, twin)` reads which side has settled from the graph: `proof` (the claim is
  proved, by a proof of its own or by a derivation), `refutation`, or undefined.
- `runTwin({llm, memory, validate, state, twin, attempts, signal?})` is the refutation side: up to
  `attempts` model calls, each asking for a proof of the negation, submitted through `validate`. It
  tells the model why the last proof failed. Between tries it reads the graph, and stops as soon as a
  side has settled: `proof`, `refutation`, `exhausted` (the attempts are spent) or `stopped`.
- The framing is neutral (plan §9). The model is never told that the statement is true, or false:
  the proof side is asked to determine whether the theorem holds, and the refutation side is told
  that the theorem is the negation of a statement whose truth is not known, and to look for a
  counterexample or an argument that the statement fails. `attemptPrompt` and `extractProposal`
  (the last ```` ```lean ```` block is the proof, earlier ones are auxiliary lemmas, `NOT_PROVABLE` is
  no proof) are exported.

The proof side is the provers' own work; the twin only adds the other side.

## Labels, nogoods and the value of a lemma

`Atms(state, {level?, maxEnvironments?, maxSize?}).refresh()` gives the "proved modulo" labels of the
claims the state follows (plan §3.2): the assumption-based truth maintenance of de Kleer, over the
same rules. The assumptions are the claims still open: `+c` means "c gets proved", `-c` "c gets
refuted". The label of a fact is the set of its minimal environments, the smallest sets of
assumptions under which the rules give it. By default (`level: "candidate"`) a `computed` claim
counts as settled; with `level: "certified"` only a `proved` one does, and a `computed` claim is
still open. The result (`AtmsResult`) answers:

| Call | Gives |
|---|---|
| `label(claimId, goal?)` | The environments, as `{prove: [claim ids], refute: [claim ids]}`, smallest first, and whether some were dropped (`truncated`). The empty environment means the fact holds with no assumption. |
| `settled(claimId, goal?)` | Whether the fact holds with no assumption. |
| `nogoods` | The environments that cannot hold: under each, some claim would be proved and refuted at once (a claim and its negation both proved, for instance). Learned to a fixpoint; the labels leave out the environments that contain one. |
| `contradictions` | The claims that are proved and refuted with no assumption: the graph contradicts itself. |

An example: A, B and C are open, and `A` implies `C` and `B` implies `C` (both edges `lean_checked`).
The label of `C` is `{+A}`, `{+B}` and `{+C}`, its own assumption, which every open claim has: C is
proved modulo A, or modulo B. The briefing of the provers shows the labels that do not name the claim
itself.

`lemmaValue(result, lemmaId, {targets?})` answers the scheduler's question, what proving this open
lemma would do: the claims its proof alone would prove (`settles`), the claims it appears in a label
of (`appears`), a `weight` (for each such claim, 1 over the size of its smallest environment that
contains it), and the `bottleneckFor` targets, those that every way of proving needs the lemma for.
`rankLemmas(result, {targets?, candidates?})` orders the open claims that appear in a label of
another claim, the most valuable first: bottlenecks, then weight.

Labels are bounded: `maxEnvironments` per label (32) of at most `maxSize` assumptions (8), the
smallest kept, and `truncated` says so. They are computed per connected group of claims, and
`refresh()` computes again only the groups whose claims, statuses or edges changed
(`Atms.recomputed` counts the groups computed, which is what "incremental" means in the tests).
`computeLabels(input)` does the same on a plain description of a graph, with no memory.

## PageRank and queries

`personalizedPageRank(edges, {seeds?, damping?, direction?, kinds?, kindWeights?, minStatus?, ...})`
is the long-run chance that a random walk is at each claim, when at every step it follows an edge
with probability `damping` (0.85) and otherwise restarts at a seed. A claim scores high when many
short paths of edges lead to it from the seeds. The walk goes either way along an edge by default
(`direction`), over the edges of some kinds and at least some status, with a weight for each kind;
a claim with no edge to follow sends its share back to the seeds; the scores add up to 1. It is
power iteration, so the result does not depend on the order of the edges, and the tests check it
against the closed forms on small graphs. `nearbyClaims(memory, seeds, {limit?, statuses?, ...})` is
the walk over the edges of a memory, as a ranking of the claims nearest to some seeds, optionally
the open ones only (the lemmas still to prove).

`graphQuery(memory, query, shorts?)` is a typed path query. From `from` (claims, by id or short
name) it walks breadth first along the edges of the given `kinds` and `edgeStatuses`, in the
`direction` (`out`, `in` or `both`), through the claims with the given `claimStatuses`, up to
`depth` edges (2) and `limit` claims (50). It returns a `Subgraph`: the claims with their status,
statement and depth, the edges it followed, and whether the limit cut it. `renderSubgraph` writes it
as the text a model reads:

```
3 claims, 2 edges
G4XR  open  (n : ℕ) : n + 0 = n
7QM2  open  : ¬ (∀ (n : ℕ), n + 0 = n)
C9ZT  open  (n : ℕ) : n + 0 = n ∧ 0 + n = n
7QM2 -negation_of[lean_checked]-> G4XR
C9ZT -strengthens[proposed]-> G4XR
```

`ShortIds` gives the ids their short names: the last characters of the id, at least four, as many
more as it takes to tell it from the ids named before. A name once given never changes, and
`resolve` turns it back into the id, so a model can name a claim from an earlier answer. Keep one
`ShortIds` for as long as the names must stay valid. `parseGraphQuery(args, claimId)` checks the
arguments of the tool below.

## The line

`M2` registers `m2Line` ([lines.md](lines.md)); `createM2Line()` makes another with its own state.

| Option | Default | Meaning |
|---|---|---|
| `twin` | `true` | Create the twin of the problem's claim, and try to prove its negation alongside the provers. |
| `twinTries` | `2` | The most model calls of the refutation side, per problem. |
| `propagate` | `true` | Submit the composed proofs of what the graph derives. |
| `composed` | `8` | The most composed proofs submitted per problem. |
| `queryTool` | `true` | Give the provers the `graph_neighbors` tool. |

The claims the line creates take the problem sketch's prefix as header: the imports, `open`s and
definitions the problem's statement is read under.

| Hook | What M2 does |
|---|---|
| `beforeProvers` | Builds the graph state around the problem's claim. Creates the twin and checks its edge. Propagates: whatever the graph derives about open claims is composed and submitted through `validate`, which may settle the problem before any prover starts. If the claim is still open and its edge is `lean_checked`, starts the refutation side, which runs alongside the provers. |
| `beforeSession`, `afterCheck` | Stop the prover when the graph says the claim is refuted. |
| `briefing` | The section "What the graph knows": the open lemmas the claim would follow from (the environments of its label, up to three), and a neutral note that the claim's truth is not known and that its negation is tried by another attempt, whose success stops the session. |
| `tools` | `graph_neighbors`: the research graph around a claim, read with the arguments of `graphQuery`. Without arguments it shows the neighborhood of the theorem being proved. The context compiler's `graph_query` (M4) is built on `graphQuery` too; the names differ so that both lines can run in one session. |
| `afterAttempt` | Propagates again: an attempt, or a line before M2, may have changed a claim of the graph. |
| `afterProblem` | Joins the refutation side, propagates once more, and records the `twin` node. |

A failure of the twin or of the propagation is logged, and does not fail the problem. The refutation
side's model calls are recorded as `model_call.finished` from `line:M2` and charged to the problem's
budget; the report counts them by line.

The `twin` node is about the problem's claim:

| Field | Meaning |
|---|---|
| `negationId`, `edgeId` | The negation's claim, and the `negation_of` edge. |
| `checked` | Whether the edge is `lean_checked`. An unchecked edge propagates nothing, so the refutation side does not run. |
| `end` | What the graph says if a side has settled (`proof`, `refutation`); otherwise how the refutation side ended (`exhausted`, `stopped`, `error`), or `idle` if it never ran. |
| `tries` | Its model calls. |

What the line does not do:

- A problem whose claim the graph refutes ends as `refuted` when the certifier certified the
  refutation (the twin's proof of the negation, then the composed refutation of the claim, which
  the run certifies once `afterProblem` is over). Without a certifier, or when it rejects or cannot
  decide, nothing is refuted and the problem ends as `unsolved`.
- Stopping a session takes effect at its next `lean_check` or when it ends; a model request in
  flight is not cut.
- It creates the twin and no other variant. Strengthenings, special cases and generalizations come
  from the lines that propose them (the abductive engine, theory exploration, repairs); they use
  `createVariant`, `checkEdge` and the rules above, and the propagation then follows.

## Records

| Record | By | What |
|---|---|---|
| Claims | `line:M2` | The negation of the problem's claim and the lemmas that link claims, with `origin: line:M2`. |
| Edges and their status | `line:M2` | `negation_of` edges, `proposed`, then `lean_checked` with the validation of the link lemma. |
| Validations | `validator` | Every proof the line submits: link lemmas, the negation, composed proofs. |
| `derivation` nodes | `line:M2` | Each composed proof, as above. |
| `twin` nodes | `line:M2` | The end of each twin, as above. |

## Measured

The plan measures M2 as an ablation: a run with the line against a run without it, at equal budget
([lines.md](lines.md#measured)). The journal holds what explains a difference: the `derivation`
nodes (how many composed proofs were submitted, and how many Lean accepted), the `twin` nodes (how
often a side settled the other), the edges checked, and the line's model calls, which the report
counts under `M2`. Nothing aggregates the derivations and the twins into the report yet.

## Tested, and not yet

`packages/graph/test` covers, with the simulated Lean and a real journal and memory:

- Each rule on small graphs, with edges of the wrong arity; chains, several derivations of one fact,
  revocation of a fact and of an edge, cycles that cannot keep a fact alive, contradictions, and an
  engine updated step by step that equals one built at once.
- The state following the memory as statuses and edges change.
- Variants and the link lemma of each edge kind; `checkEdge` with closers, with proposals after a
  failure, and with a lemma that does not compile.
- Composed proofs: the steps of a chain, auxiliary declarations renamed apart, missing pieces.
  `realize`: a composed proof submitted to the simulated Lean before a claim becomes `computed`
  (never `proved`), a refused proof recorded and not sent twice, a chain in order and within the
  limit, a claim withdrawn when its premise is, a refutation that changes no status.
- The twin: the neutral framing, the answers of a model read, one side stopping the other.
- Labels and nogoods on an AND/OR graph, bottlenecks, bounds, incremental recomputation.
- PageRank against the closed forms of two small graphs, and graph queries with short ids.
- The line in a run (`demoRun`): the provers stopped when the twin proves the negation, the
  refutation side stopped when a prover proves the claim, a problem settled before the provers by a
  composed proof, the briefing (the twin, and the open lemmas the claim would follow from), the
  `graph_neighbors` tool, the options, and a link lemma Lean refuses.

Not done:

- **Nothing has run against a real Lean or a real model.** The simulated Lean in the tests judges the
  structure of a proof, not its meaning. What depends on Lean's exact behavior: that the link
  lemmas, the negations `: ¬ (∀ binders, type)` and the closers elaborate as written; that each step
  of the table above closes its goal, for statements with implicit and instance binders too (a proof
  is applied only to the explicit ones); that renamed auxiliary declarations still resolve. The
  generated reference files of the claims it creates have not been run against Lean either
  ([memory.md](memory.md#reference-files)). The first real run settles these
  ([lean.md](lean.md#to-verify-against-lean)).
- The certifier runs after `afterProblem`, so the propagation of a problem sees its own submissions
  at the candidate level only; the certified level they reach is read by the next problem's
  `beforeProvers`. Nothing here has run against a real certifier ([certifier.md](certifier.md)).
- Statement identity is textual ([memory.md](memory.md#claims)): two equivalent statements written
  differently are two claims, until the Lean-backed identity (M1).
- PageRank and the lemma ranking are not called by any line yet, and the briefing is the only
  reader of the labels. M12 and M4 will use them through the exports above.
