# The verified frontier

The frontier is what a run has established about a problem, as a list the harness writes from the journal with code and no model call
(plan change LH1, `plans/plan-change-long-horizon.md`). Lean becomes the progress meter of a long run, not only its final judge: the
frontier only grows within a run, and its growth per dollar is what the plateau rule (Task 59) will read.

`frontier(store, claimId, options?)` is in `@seshat/memory` (`packages/memory/src/frontier.ts`), beside the state card. It is a pure
function of the memory's projection: the same journal gives the same frontier, byte for byte (every list is sorted by the event's
sequence number, then kind, then id).

## The kinds

| Kind | What it is | Read from |
|---|---|---|
| `subclaim` | a part joined to the target by `decomposes_into` (directly or through parts) that is `computed` or `proved`; an `aux_` lemma Lean accepted | claims, `accepted_lemmas` nodes |
| `case` | a proved claim with a `special_case_of` or `instance_of` edge to the target | claims and edges |
| `variant` | any other proved claim joined to the target by `special_case_of`, `strengthens`, `equiv` or `negation_of` | claims and edges |
| `reduction` | a `lean_checked` `implies` edge into the target or a subclaim | edges |
| `dead_end` | a subclaim or variant Lean refuted, or one with a `lean_checked` `refuted_by` edge to a counter-model | claims, edges, `counter_model` nodes |
| `evidence` | a bounded computation: `plausible` found no counterexample, test lemmas passed, a first-cases table | `hygiene`, `datatable` nodes |
| `best` | the best score of an M16 search, and whether Lean certified its witness | `search_result` nodes |

Each entry has an id, a short statement, a detail, the status when it is a claim, the dollars and milliseconds of the attempts behind it
when the journal has them, and its provenance: event sequence numbers and the actor (a claim's origin, an attempt's prover) when the
journal says.

## The score

A weighted count. The defaults: every entry 1, a `reduction` or a `subclaim` 3, `evidence` 0.5, a `dead_end` 1. `RunConfig.frontier.weights`
overrides them by kind. `frontierGrowth(store, claimId)` gives the score over spend (dollars the attempts on the problem's claims had
cost, score) at each event where the frontier grew, for the plateau rule.

## Where it is shown

Only with `RunConfig.frontier.show` (off by default; `solve`'s sets `v1` and `v2` do not set it):

- the state card ends with the top entries, within a third of the card's bound;
- the consortium turn's account, `RESULT.md` and `report.md` carry a section "Established so far", with the `evidence` entries apart and
  labelled "evidence, not proof";
- the interface's run view shows the same list;
- each outer prover session's opening user message ends with one line of data: the budget left for the session and the problem, and the
  frontier's size, score and last entry (LH8). The system prompt does not change.

`harness frontier RUN_DIR [--claim ID] [--json]` prints the frontier of each problem of a run that no process works on, with no model and
no Lean.

## The trust rule

The frontier is a projection. It never changes a claim's status, and no model, tool or person can through it. An `evidence` entry is
never a status and is worded as evidence wherever it is shown. A claim in the frontier has the status Lean's check gave it.

## What has not run

Everything is tested on scripted journals and with the faux provider; no real run has measured whether the frontier tracks real progress.
The journal cannot show yet: a counter-model search (M11) that found none (the line records a `counter_model` node only for an object it
found), so that evidence is missing; and a plan's critical path, so a subclaim weighs 3 whether or not it is on one.
