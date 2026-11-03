# Context compiler (line M4)

Line `M4` ([lines.md](lines.md)) in `@seshat/context` writes what a prover reads at each request: a packet compiled from the graph, the
library and the lessons, in place of the conversation's history. It also gives the prover two tools, `expand` and `graph_query`, to
look further than the packet shows. A run enables it with `harness run --lines M4` (it requires no other line, and uses whatever
M1, M2, M3 and M5 have recorded). With the line off nothing changes.

The principle: the model should not carry the whole conversation to find the next move. What it needs is the goal, the state of its
file, the few facts and premises that bear on the goal, what was already tried, and the last raw answer of Lean. The compiler selects
these, in a fixed order, under a token budget.

## The packet

A `FrozenPacket` ([lines.md](lines.md#the-context-packet)): a `prefix` the session freezes at its first request and sends byte for byte
afterwards, and a `tail` compiled again for every request. The request carries the system prompt, the tool declarations, the prefix and
the tail, and nothing of the conversation. Setting `naive: true` gives the comparison arm instead (below).

**The prefix**, in this order, each section within its share of the budget (`tokens`, of which `prefixShare` goes to the prefix; spare tokens carried forward; the goal is
always kept):

| Section | Content |
|---|---|
| Goal | The claim's id and its statement, as Lean. |
| Useful facts | Claims of the graph with their badges (`proved`, `computed`), chosen by a personalised PageRank from the goal, then by symbol similarity (a convex mix, `graphWeight`), under `factThreshold`; with a block of relations among them (`list`, `merged` or `table`, at most `graphEdges` edges: 100, or 200 for a model in `strongModels`). |
| Candidate premises | Local declarations, then the library, then other packages, then Mathlib, in that order ([Premises](#premises)). |
| Already tried | The memory's `alreadyTried` lines (M1), at most `maxTried`. |
| Active lessons | The lessons M5 offers, as the draw left them. |
| Notes from other lines | The briefing sections of the other enabled lines (the graph's findings, a fleet directive, a step plan, a curriculum), taken from the opening message the packet replaces, each line passed through the strict screen and capped. The sections M4 replaces with its own (already tried, library, lessons, the classical battery) and the team's sections (the harness adds those to every packet) are not repeated. |

**The tail**, for each request: where the session stands (session, request, budget left), the file's regions as last checked, the
holes of the sketch, the last raw Lean feedback (only the last check is shown), the answers to the tools the prover called in its last
turn (`expand`, `graph_query`: the packet replaces the history, so an answer would otherwise vanish), the instruction of the wrap-up
request, and, with `newSince`, the facts learned since the prefix was frozen, each with its standing. A claim the prefix shows whose status the projection has since withdrawn (a `computed` claim back to `open`, a settled one `retracted`) or a library lemma that is no longer usable is named under "No longer valid since this session started", so that the frozen prefix and the cache stay as they are while the model is not left with a false fact. Every part of the tail is cut to its share of the tail's budget with a visible mark (`[... n lines not shown]`).

Every item that is shown has a citable id (an item the budget cut has none): `C` a claim, `E` an edge, `L` a premise, `A` a lesson. Ids are short, stable within the session, and
resolved without regard to case. M6 resolves them like any other citation.

## What is lost when M4 is on

The packet replaces the opening message, so the opening message's own content is not shown: the prover's notes from earlier sessions (the M0 loop's mechanism; the sketch's state and the last feedback take their place, and M5's lessons are the advice that carries over), and any section of another line that M4 replaces by title. The briefing sections of the other lines are kept as the "Notes from other lines" section above.

## Resume

M4 keeps nothing in its process. Each attempt leaves a `context_carry` node (the regions, the holes and the raw feedback of its last check, by claim and prover), and the next session of the prover reads it back, so a run cut and resumed gives the first tail an uncut run gives. The packet records (`context_packet` nodes) carry the prefix and tail sizes, the budget and whether the goal alone was above it; the naive arm records its size too.

## Premises

`retrievePremises` takes the goal's statement and the queries (below) and scores the entries of each source with a selector:

- **MePo**, with a pass mark of 0.5 and a convergence of 3.2: facts sharing the goal's symbols, the rarer first, widening through what
  it took. **SInE**, with a trigger relation over symbols. Both index the signature, not the name, and bound variable names are
  stripped.
- An online **k-NN** over the run's own proofs (IDF-weighted symbols): the lemmas that closed similar goals. Small learned components
  used as they are are allowed (Global Constraint 3); nothing is trained.
- With `seeds`, the **pattern seeds** of PC5: for a goal with a recognisable shape, the lemma families that usually apply (`add_comm`
  and friends), with their dependency neighbours.
- The channels are combined by a convex combination, and `compareChannels` (M3's) measures them against MePo alone. A selector from
  elsewhere (LeanHammer's) is a `Selector`, a pluggable channel; no capability is built here.

**The accessibility filter.** A premise whose module the file's header cannot see is not offered, or is offered with
`(needs: import M)`. `assumedImports` (`Mathlib`) lists the roots the base environment always has.

**Query extraction.** With `extractQueries`, one `completeJson` call at the site `context.queries` turns the goal into at most
`maxQueries` concept queries and likely Lean names. A name counts only if it exists in the index. The call is made once per session;
a failure is swallowed, and the packet is then compiled from the statement alone.

**The draw.** Unverified items go through Task 23's draw, made in `beforeSession` and recorded on `attempt.started`: each lesson, the
library section (`library:section`, M3's own item, so its effect is one number) and the k-NN's suggestions (`context:knn`). A claim
is never drawn. An item the draw withheld is not in the packet. The packet's record (a `context_packet` node) says what was
included and what each section kept.

## The tools

`expand(id)` shows one item in full. For a claim: its statement, status, and a table of neighbours. A hub (over 50 neighbours) answers
the counts per relation kind first, and `kind` then lists one kind. `graph_query` has three modes: a `pattern` (a constant, a shape
with `?x` backreferences and `_`, or a conclusion `⊢ ...`); `anchors`, the connect mode of [graph.md](graph.md#connecting-claims),
which renders the paths between claims as chains, merged or a table; and a typed query by relation, depth and status. An id that does
not exist answers an error that lists the ids that do.

What a tool shows from the graph passes the strict screens (`screenLean` for Lean text, `screenProse` for prose) like the rest of the
packet: text a model or another run wrote does not enter as an instruction. The depth of the facts' neighbourhood is `baseDepth`, plus
one after each failed session, up to `maxDepth`.

## The naive packet

`naive: true` compiles the same content without selection, order or ids and without tools: the goal, then every fact, lemma and
lesson in one string, compiled again for each request. It is the comparison arm of Task 14; the packet is measured against it, not
assumed better.

## Options

`tokens`, `prefixShare`, `premiseThreshold`, `factThreshold`, `graphWeight`, `maxFacts`, `factStatuses`, `baseDepth`, `maxDepth`,
`graphEdges`, `graphEdgesStrong`, `strongModels`, `rendering`, `gloss`, `badges`, `maxLessons`, `maxTried`, `extractQueries`,
`maxQueries`, `seeds`, `knn`, `knnK`, `accessibility`, `assumedImports`, `newSince`, `tools`, `naive`. The defaults are in
`M4_OPTIONS`; they are untuned.

## Seams

- The packet API takes the append-only mode of PD2: `{prefix, tail}` is the only shape the hook answers, and which request builds on
  which is the session's, not the line's. Whether append-only pays is measured in Task 14.
- Task 28's `keepReasoning`/`rewriteHistory` apply to the history, which M4 replaces; the line does not touch them.

## Tested, and not yet

Tested with a simulated Lean, the faux model and fixtures: the selectors, the filter, the seeds, fact ranking, the render within
budget, the frozen prefix over three requests, the tools and their screens, the draws, the query extraction and the naive arm. Not
run: against a real Lean or model; against the real Mathlib export (the premise index is an interface fed by a fixture, like M3's);
the tree-similarity channel is not built; the ATMS labels of a fact are not used; the thresholds and shares are untuned; and no
measure says the compiled packet beats the history. The carry of the last session's feedback into the next one is in-process only.

## Size and bounds

`estimateTokens` is an upper bound, not an estimate: an ASCII character costs a third of a token, any other character (Lean's symbols) one and a half. Every part of the packet is cut to a share of its budget; when the goal alone is above the prefix's budget the prefix is the goal, the record says `overBudget` and the session's log says so.

The tools are bounded: a pattern has at most 64 characters and four metavariables or wildcards and is matched token by token with a step counter (no regular expression sees a model's string), `graph_query` takes at most 50 results, a depth of 4, 6 anchors and 10 start claims, every answer is cut at 12000 characters, and the proof text of a promoted library lemma is shown line by line through the strict screen (a line with a comment or an instruction is replaced by `(line not shown)`). `graph_query` reaches only the claims whose ids the packet or an answer has shown.
