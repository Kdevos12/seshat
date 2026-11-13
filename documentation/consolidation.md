# The consolidation pass (CA24)

`harness consolidate RUN_DIR [--out DIR] [--model PROVIDER/ID --max-usd X] [--host HOST]` looks backward over a finished or paused run and
leaves, in a **new run started on it**, what a later run should know. The new run is built by the same chain as `--memory-from`
([memory.md](memory.md#memory-across-runs)): its journal starts with a `run.started` that pins the earlier journal's last hash, the
earlier directory is opened for reading only, and a later run is started on the consolidation run with `--memory-from DIR`. The default
directory is `RUN_DIR.consolidation`, beside the earlier run. The new run records the earlier run's model, prompt version, bench and Lean
environment, so that a later run's epochs and the carrying of statuses are decided as if the pass were not there; the pass's own model and
cap are in `config.consolidation`. A chain whose Lean environment cannot be compared (an unrecorded revision or toolchain) carries no
status ([memory.md](memory.md#memory-across-runs)): the pass then sees every claim as `open` and writes a card for a problem Lean has settled.

Everything the pass writes is a node of four kinds, written by the actor `consolidation` and by no other (the journal refuses them from any
other actor, [journal.md](journal.md#consolidation-nodes)), and recorded so that the report can be read back from the journal.

## The model-free part

For every problem of the chain that is not settled (its claim is not `proved` or `refuted`) and has at least one attempt in any run of the
chain:

- **A card.** The state card of Task 35 (`stateCardData`, `renderStateCard`, [m0-loop.md](m0-loop.md#the-state-card)), counted over every
  run of the chain (`acrossRuns`; the session's own card counts the current run's attempts only), is a `consolidation_card` node on the
  problem's claim. It is stamped, since what it says comes from outcomes (Global Constraint 16).
- **Duplicate lessons merged** ([lessons.md](lessons.md#consolidation)): same type, scope and normalised text.
- **Lessons the journal no longer backs flagged** ([lessons.md](lessons.md#consolidation)).

No model is called. Without `--model` this is all the pass does; each open problem gets a `consolidation_pass` record saying so.

## The page: what was tried and why it stopped

With `--model`, at most **one model call per open problem**, the problems taken in order. Before a call is sent it is priced (the input at
the host's input price or pi-ai's, plus the whole answer allowance at the output price); a call that would bring the pass's spend past
`--max-usd` is not sent, and the problem is recorded `skipped_budget`. The spend counts over every run of the pass on the directory.

**Input.** The state card, and a numbered list of the problem's events from the chain, each with an id `eN` (N is the event's place in the
chain's journals, oldest first, from 0): finished attempts (outcome, failure class, strategy, the normalised first error that the card has),
tool runs of the problem's attempts by capability and outcome, validations by method and verdict, and evidence nodes by kind and verdict
token. **Text from an external source is never in the input**: a literature node is `evidence literature verdict restricts`, with no
quote, title or url; a tool's output body, a search result and every other node's data are not sent. At most the latest 120 events are listed.

**Answer and the sentence rule.** One sentence per line, each ending with its citations: `The induction approach failed twice [e12, e40].`
A sentence is kept only if it cites at least one event, every event it cites is in the list this problem was given, its text (without the
citations) is at most 400 characters and passes the strict prose screen of `@seshat/memory` (no code, link, declaration name or
instruction). A sentence with no citation is dropped; a sentence citing an event that does not exist, or one of another problem, is
dropped whole. The dropped count is recorded, with its causes (`uncited`, `unknownEvent`, `screened`, `size`). A page with no sentence left
is not written (`no_page`). The stored page is cut at 4000 characters (`PAGE_STORED_CHARS`, citations included); the part shown to a session
has its own cap of 1500 (`PAGE_INJECT_CHARS`), whole sentences without their citations.

**The artifact.** The page is a `consolidation_page` node on the claim, recorded `learned` with the provenance stamp: never a fact, never a
claim's status, never an edge. One page per problem and one writer: only this pass writes the kind. A later pass over a chain that already
holds a page writes a new one that names it (`supersedes`); only the newest is ever shown, and if the newest is switched off no older one
takes its place.

**The call.** It goes through the model layer of the other one-shot calls: `model_call.finished` at the site `consolidation.page`, request
and response as blobs, usage and cost in the journal. No concrete model is named anywhere: the model is the one `--model` gives.

**A pass that was cut** is run again on the same `--out`: the cards, merges and flags already recorded are skipped, a problem with a page
or with `no_page` is skipped, and a call the journal holds for the very same request (cut between the call and the page) is read back at
no cost. A problem that was `skipped_budget`, `failed` or `no_model` is tried again. Nothing is paid twice. A pass that had ended and has
nothing new to do writes nothing. `--out` that holds a run started on another earlier run is refused.

## The report

`consolidation.md` in the new directory, built from its journal: per problem the card, the page with its kept and dropped sentence counts
and its cost, then the merged and flagged lessons. The command prints a short summary.

## Showing the page to a later run

`harness run --consolidation` and `harness solve --consolidation` (`RunConfig.consolidation`; off by default and in neither defaults set).
With it on and a page for the problem's claim in the run's memory chain:

- The capped part of the newest page is added to the session's **first user message**, in a section "Unverified notes from an earlier run"
  that says the notes are not proved and possibly wrong. Never to the system prompt: the system prompt and its hash are the same with the
  option on or off.
- It is **drawn** like a lesson ([memory.md](memory.md#randomized-inclusion)): the page's node id is an item of the session's draw, included
  with probability 0.5 while it is new and 0.9 after, from the run's seeded source (`--draw-seed`), so sessions with and without it exist,
  and `attempt.started` records `included` or `withheld`.
- It is **judged by its effect**: `itemEffect` over the claim group, and when P(effect < 0) is above 0.9 with at least 8 observations with the
  page and 8 without it, the run switches the page off (`active: false` with the rule and the reason, a `node.updated` of the orchestrator)
  and it is shown no more. As with lessons, an old epoch's evidence weighs less ([memory.md](memory.md#probation)).

## At the end of a consortium turn

`--turn-consolidation` (`ConsortiumConfig.consolidation`, off by default; it makes the run a consortium run like `--turn-narrative`): when
the turn ends the model-free part is computed, read-only, and rendered as a section of the turn's report (`turns/N/report.md`, and
`consolidation` in `report.json`). **No model call, and nothing written beyond what the turn already records** (the rule of Task 17: nothing is
spent before the team answers). The page needs `harness consolidate`, run by a person on the paused or finished run.

## Trust

The page and the cards are unverified artifacts ([trust.md](trust.md#learned-records-and-the-consolidation-pass)). Lean is the judge: nothing
here changes a claim's status.

## Tested, and not run

Tested with the simulated model (pi-ai's faux provider) and no Lean: the earlier journal's bytes unchanged, a sentence with no citation, with
a citation of an event that does not exist and with a citation of another problem's event dropped, the injected cap cut at a sentence end,
one call per open problem and none for a settled problem or without `--model`, the dollar cap stopping the pass before a call, a cut pass run
again, merged duplicates, an unsupported lesson flagged and not shown, the page read through the chain by a later run, the option off and on
(the first user message, the unchanged system prompt hash, the draw), the switch-off by effect on scripted outcomes, no literature quote in
the model's input, and the turn-end section. **Not run: a real model.** Whether a page helps a prover is not known; the option's effect is what
the draw measures.
