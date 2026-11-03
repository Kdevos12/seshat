# The archive of decompositions (line M15)

Line `M15` ([lines.md](lines.md)) is rung 2 of the escalation ladder ([scheduler.md](scheduler.md#the-escalation-ladder-pe4-of-the-memory-evolution-plan-change)),
plan change PC13, amended by PE1 and PE2 of the memory-evolution change. It is ProofEvolve (arXiv 2608.26334) without training: a problem
that has spent its budget without Lean progress keeps **several** decompositions alive, not one best-first frontier, and the proofs that
closed on other problems are offered as **schemas**. It is `createM15Line` in `@seshat/scheduler` (`packages/scheduler/src/m15.ts`,
`archive.ts`, `schemas.ts`, `terms.ts`); the schema node and its index are `@seshat/library`'s. A run enables it with
`harness run --lines M1,M12,M15` (it requires M12, whose sketches become the decompositions).

**No published evidence says this pays without updating weights.** The line is an experiment, judged by [what it measures](#measured). It is on
rung 2 only so that problems the cheaper stack solves never pay for it. The line makes no model call of its own: the model's work is the outer
provers' sessions, and what the line changes is the briefing each one gets.

## The archive

A **decomposition** is a `decomposes_into` edge from the problem's claim that Lean checked (M12 registers a prover's sketch with named holes and
checks the link lemma, [scheduler.md](scheduler.md)); a proposed edge is not in the archive, because its parts say nothing about the claim until Lean
agrees. Its DAG is the edge, its parts, and the checked decomposition of each part that is itself decomposed (to depth 4). Everything is read from the
memory (`readArchive`), so a resumed run has the archive it had.

- **Fitness ρ** is the share of the DAG's leaves that are closed. A leaf is closed when its proved-modulo label (the ATMS of [graph.md](graph.md), over
  checked edges) has the empty environment: the claim is `computed` or `proved`, or the graph derives it through checked edges (a leaf that is an
  instance of a proved fact is closed though its own status is `open`). Nothing the line asserts enters it, and it does not fall while the statuses
  it counts stand.
- **Cells** are keyed `depth|family|region`: the depth of the DAG (1, 2, 3+), the family of the sketch's main proof (the strategy label of Task 2's
  classifier: `rewriting`, `induction`...; `other` for a decomposition made without a sketch), and the region, how many parts and the main symbol of the
  claim (`2p:=`).
- **Replacement.** A cell keeps one elite. A decomposition replaces it only with a strictly higher ρ; the archive is read in the order the edges were
  made, so on a tie the older stays. The other decompositions of the cell are counted but not kept as elites.

The diversity measure is the entropy, in bits, of the families of the decompositions the problems ended with.

## Choosing the cell a session extends

`beforeSession` (for each outer session, once the ladder has moved the problem to rung 2):

1. **Settles** the sessions that have ended: a pick is `improved` when the decomposition that session's sketch became closes a larger share of its leaves
   than the elite it was told to extend (on the fresh arm, when it fills a cell the archive did not have), `not_improved` when it does not or the sketch is
   not a decomposition Lean checked, and `void` when the session ended aborted. A session whose sketch the scheduler has not registered yet waits; at the end
   of the problem a session that did not end is `void`. A session with no sketch is `not_improved`. A session whose proof Lean accepted is `improved`.
2. **Retires** the schemas whose effect says they hurt ([below](#the-effect-of-a-schema)).
3. **Picks** by Thompson sampling over the cells of the archive and a **fresh** arm (`new`: a decomposition unlike the archive's). Each arm's posterior is a
   Beta over the picks that came to an end, `improved` a success and `not_improved` a failure, pooled across the problems of the memory, with each count
   weighted by the probation of its epoch (`weightOf`, [memory.md](memory.md#provenance-and-epochs)): a pick from before a new epoch weighs a quarter, and
   regains its weight only through new picks. The draw comes from the run's seed (or the option `seed`), the problem, the prover and the session, so a
   resumed run draws the same.
4. **Records** a `m15_pick` node (stamped, `learned`): the session, the cell, the elite it was told to extend, the fitness then and the cells there were.

The briefing section for a cell is **Decomposition to extend**: the elite's holes under their names, each marked closed (with Lean's accepted proof when it
is a bare tactic proof that passes the strict screen) or open, and its main proof; it asks the session to extend it and says that Lean decides what is
proved. For the fresh arm it is **Decompositions tried**: the kinds the archive holds, and a request for another kind. Both are advice, not facts about the
theorem. A statement or proof that fails the strict screen ([schemas.md](schemas.md#making-a-schema)) leaves the section out.

## Schemas

When a problem ends (`afterProblem`), the line records a snapshot of the archive (`m15_archive`, a reading of Lean's verdicts, not stamped). Schemas are
made from the snapshots of the problems that have ended, at the start of each later session and at the end of each problem, and only from a
decomposition **the kernel closed**: every leaf closed at the certified level (`Member.certified`, the ATMS at level `certified`), so a leaf the fast check
accepted (`computed`) is not enough. The certifier runs after the line's last hook of a problem, which is why a problem's schema appears when a later problem
escalates (or in a later run that starts on this journal with `--memory-from`), not at its own end. `skeletonOf` reads the decomposition through the strict
screen, and `keepSchema` makes it another support of a schema that covers it, the generalization of the first schema it can be anti-unified with (which becomes
`superseded`), or a schema of its own ([schemas.md](schemas.md#merging)). The schema node is stamped with the run's provenance (PE1), so it enters probation on a
new epoch. Fitness ρ, which guides the picks, still counts a `computed` leaf as closed.

A sketch whose auxiliary region holds anything but its holes gives no schema: its helper lemma is specific to its problem.

## Offering a schema

For a session of another problem, `beforeSession` looks for active schemas whose supports are not all this problem's own claim, and:

- **`retrieval: "match"`** (default): the schemas whose conclusion matches the goal lexically are ordered by the BM25 index of the schemas
  (`SchemaIndex`), and up to `candidates` are asked of `lean.meta` whether the goal is an instance of the schema's conclusion
  ([schemas.md](schemas.md#confirmation-by-leanmeta)); the line fails closed, so a refusal, no answer or a no means no hint, with the reason in the log.
  A confirmed schema is instantiated at the goal, and its parts are compared with the facts Lean accepted for this problem, so the hint says which are
  covered. `confirm: false` takes the lexical match, for a run without `lean.meta`.
- **`retrieval: "random"`**: a random active schema, shown as it is stored, with its variables. This is the control the plan asks for: schema reuse against
  random retrieval.

The schemas are unverified advice, so they go through the **randomized inclusion** (PE2, [memory.md](memory.md#randomized-inclusion)): `session.draw` includes
or withholds each, and the journal's `attempt.started` records which. The `m15_hint` node (stamped) records each plan with `shown`, so a withheld hint is the
control of the effect. Only a drawn-in schema reaches the briefing, in the section **Decompositions that closed before**, which says it is advice from other
problems and is not proved, and that a sketch built from it is checked with `lean_check`. A hint is recorded before the session starts; a session that never
starts (the budget ended) leaves a hint nobody read, which the report and the effect ignore.

Reuse is measured by shape (`reuses`): once a session's sketch is registered, the hint is marked `reused` when the sketch's holes are an instance of the
schema's parts, whoever suggested the schema and whether or not the session was shown it.

## The effect of a schema

A schema stays in use by its measured effect, not its presence (PE2). Before each session, `retireWorn` asks the memory for each active schema's effect
(`itemEffect`): the accepted attempts among those that were shown it against those that were denied it, as a posterior. When the observations on each side reach
`minObservations` and P(effect < 0) exceeds `threshold`, the schema becomes `inactive`, with the numbers as the reason, and leaves the index; the journal keeps it.
A schema that was only present often is not retired for that. Nothing deletes a schema, and a schema that generalized another leaves that one `superseded`.

## What it can never do

- **A decomposition never changes a claim's status.** A claim changes status only through `validate` and the certifier. The line's actor writes nodes (picks,
  hints, snapshots, schemas), updates to them and `lean.meta` tool runs, and nothing else; a test checks that every event of the line is of those kinds. The
  sessions it steers submit their proofs through `validate` like any other.
- **Text derived from a model never reaches a prompt or Lean unscreened.** Every statement and proof a schema keeps, and every statement the briefing shows from
  an elite, passes the strict screen: no comment, string, control or direction character, no token the validator forbids, no variable notation, bounded length.
- **Learned records are stamped.** Picks, hints and schemas carry the provenance of the run; a pick's weight in the posteriors follows the probation of its epoch.

## Options

`--line-option M15.NAME=VALUE`:

| Option | Default | Meaning |
|---|---|---|
| `cells` | `true` | Choose a cell by Thompson sampling. Off: sessions are not steered. |
| `hints` | `1` | Schemas offered to a session, at most. 0 turns hints off. |
| `retrieval` | `match` | `match` or `random` (the control). |
| `confirm` | `true` | Ask `lean.meta` to confirm a lexical match before instantiating. Off, a lexical match is trusted. |
| `candidates` | `5` | The most schemas put to `lean.meta` for one session. |
| `extract` | `true` | Keep the closed decompositions of a finished problem as schemas. |
| `minSpecificity` | `0.5` | The share of fixed tokens a skeleton must keep. |
| `minObservations` | `8` | Attempts with and without a schema before its effect can retire it. |
| `threshold` | `0.9` | The P(effect < 0) that retires it. |
| `seed` | run's seed | Seeds the line's draws. |

## Measured

The run report ([m0-loop.md](m0-loop.md)) has a paragraph, from the journal alone (`archiveReport`, `packages/scheduler/src/archive-report.ts`):

- **The archive**: problems with a checked decomposition, cells filled, the mean of the best ρ of each problem, the mechanisms (families) and their entropy.
- **Picks**: of the picks that came to an end, how many improved on the elite, for a cell and for the fresh arm.
- **Schemas**: made, active, generalized, retired by their effect.
- **Hints, by retrieval arm**: the accepted proofs among sessions that were shown the hint and among those denied it, and how often the session's sketch had the
  schema's shape in each.

The plan's three measures are these: solves at equal budget (run the same bench with `M1,M12` and with `M1,M12,M15` at the same `--problem-usd` and compare the
outcomes and the dollars per rung of the ladder table, [scheduler.md](scheduler.md)); diversity of mechanisms (the entropy above, M15 against the ladder
without it); and schema reuse against random retrieval (`--line-option M15.retrieval=random` against `match`, the reuse counts and the accepted proofs of
the two arms). The line is removed if it does not beat the ladder without it at equal budget.

## Resuming

M15 declares `resume: "stateless"`: it keeps nothing in the process. The archive is read from the memory; picks, hints, snapshots and schemas are nodes;
`settle` and `keepSchema` are safe to call twice (a settled node is not settled again, a decomposition already among a schema's supports is skipped);
the only cache is the answers of `lean.meta`, which a resumed process asks again. A pick is made once per session because the session's attempt id names it.
`packages/orchestrator/test/resume-m15.test.ts` cuts a whole run after every event of its journal and resumes each: the run ends, at most one snapshot and one
schema are recorded, one pick per session, and the cuts between sessions have the outcome of the run that was not cut.

## Tests, and what has not run

`packages/scheduler/test/archive.test.ts` covers the archive (checked decompositions only, fitness from the labels, nested depth, cells and the replacement rule,
entropy), the posteriors (Beta counts, probation weights), the choice (both arms tried, the same seed the same pick, stamped), settling (improved or not, waiting,
reuse), the effect and the retirement, and `keepSchema`. `terms.test.ts` and `schemas.test.ts` cover the schema machinery ([schemas.md](schemas.md#tested-and-not-yet)).
`packages/orchestrator/test/m15.test.ts` runs whole two-problem runs: registration, the snapshot and schema of a solved problem, the line writing only nodes and
tool runs, a hint shown or withheld as the draw recorded, the briefing, `lean.meta` confirmation (yes, no, a refusal), the lexical and random arms, the options off,
and the report.

Everything runs with a simulated Lean and `lean.meta`, and a faux model. **Not run**: against a real model (whether a briefing that names an elite makes the next
sketch extend it, whether a schema hint is read and used), a real Lean (the checked link lemma of each decomposition), or a real `lean.meta` (the statement
`generalStatement` writes has never been elaborated; the cost of being wrong is that no schema is confirmed). **Nothing says the archive or the schemas pay**:
only the comparison above can.
