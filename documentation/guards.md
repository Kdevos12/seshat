# M6: guards and drift detectors

M6 is an ablation line ([lines.md](lines.md)). A run enables it with `harness run --lines M6` or
`--ablation M6` (which is M0 plus the lines before it); without it none of this exists. It holds the
plan's guards against hallucination and drift (plan §9). All of them are deterministic: text rules
and counters, never a model. It needs no other line, and uses M1's classifiers, which are plain
functions of `@seshat/memory`.

The code is in `@seshat/guards`. The line is `createM6(env)` in `m6.ts`; `M6` is `createM6()`.

A guard never changes a claim's status. A claim becomes `computed` only when Lean accepts a proof
through `validate`, and `proved` only through the certifier ([trust.md](trust.md)). What a guard
does is act on the session (reject a call, take a text out of what a model reads, stop the session)
and write what it found as a `drift` node of the claim.

## Drift nodes

Every finding is a node of kind `drift`, recorded through the memory store as `line:M6`; the package
owns the shape of its `data` (`DriftData`):

| Field | Meaning |
|---|---|
| `kind` | what was found, below |
| `action` | what was done: `stopped_session`, `rejected_call`, `removed_text`, `dropped_section`, `restarted` or `noted` |
| `detail` | one typed line of this page's words, labels and counts; never a piece of an attempt |
| `attemptId`, `prover`, `session`, `check` | where it happened; `check` counts from 1 and, for a rejected call, is the number the call would have had |
| `evidence` | what was measured, for audit: counts, labels, names, the references that did not resolve. A model never reads it |

`driftNodes(memory, claimId, {kind?, prover?, attemptId?})` reads them back in order.

| Kind | Found by | Action |
|---|---|---|
| `non_neutral_framing` | a briefing section asks to prove an open conjecture | `noted` |
| `unresolved_citation` | a reference that resolves to nothing | `rejected_call`, or `removed_text` in the notes |
| `sorry_as_known` | a `sorry` presented as a known result | `rejected_call` |
| `raw_error_text` | Lean's output in a section or in the notes | `removed_text`, or `dropped_section` |
| `unanchored_revision` | a check that follows no signal | `rejected_call` |
| `strategy_loop`, `restated_target`, `statement_drift`, `length_growth` | the detectors | `stopped_session` |
| `session_loop` | the detector across sessions | `restarted` |

The orchestrator turns the findings that stopped a session or restarted a prover (`stopped_session`,
`restarted`) into routing decisions about the attempt's task, `branch` for a loop and `reset_upstream`
for a restated target or a drifted statement; it records them and acts on none
([ledger.md](ledger.md#routing-decisions)). The findings a guard dealt with in place are not routed.

## Neutral framing

A prover is never asked to demonstrate an open conjecture. BrokenMath measures 29% of false "proofs"
of false statements when the model is told to prove them. A problem whose theorem has no category,
or a category that says `open` (`@[category research open, AMS 11]`, read from the theorem's header),
gets a section "The question" in every session: *Determine whether this theorem holds. It is an open
conjecture: it may be true, or false as formalized... Look for a proof and for a counterexample with
equal care.* It tells the model that `lean_check` accepts only a proof, and to say in its notes, with
the witness, if it comes to believe the statement is false.

- A problem whose category says it is solved gets nothing by default. `framingAll` gives it the
  question anyway, in the wording for a known statement ("a proof is expected, but a formalization
  can be wrong"), for experiments. The committed bench (575 solved problems) is such a bench, so
  this guard does nothing on it unless `framingAll` is set.
- `framingProblems(text)` finds the wordings that put a statement as a thing to demonstrate ("prove
  that", "your task is to prove", "help you prove"). A test runs it on M0's own prompts. When another
  line's section has such a wording on an open conjecture, M6 records it (`noted`) once per problem and
  leaves the section as it is: it cannot tell a lemma that is right to prove from the conjecture.
- The prove-and-refute twin is the graph line's (`@seshat/graph`, M2), not this one's.

## Resolved citations

A reference in a prover's output must be an id the prover was given, or resolve to something the
harness knows. The check runs on every `lean_check`, on the comments of the AUX and PROOF regions,
before Lean is run; and on the notes that go to the next session.

What counts as a reference:

| Form | Example |
|---|---|
| a marker | `[cite: C17]`, `[cite: clm_..., src:Smith2019]` (several ids to a marker) |
| an external identifier | `arXiv:2101.01234`, `doi:10.1000/xyz`, `OEIS A000045`, `MR 1234567` |
| an appeal with no id | "well-known", "a known result", "the standard theorem on...", "folklore", "Theorem 3.2 of...", "Smith (2019)", "by a theorem of Erdős" |

A passage with a marker or an identifier is judged by those alone; an appeal with none is a
reference with no source. A reference resolves when it is:

1. an id of the session's packet (`C17`, `L4`; the context compiler of M4 will give them, through the
   `packetIds` option of `createM6`);
2. an id of the graph: a claim (`clm_...`), an edge (`edg_...`) or a node (`nod_...`) of the memory;
3. a name that a `source` node of the memory answers to: its `id`, `ref`, `name`, `declaration`,
   `title`, `url`, `arxiv`, `doi` or `oeis`, or one of its `names`, `aliases` or `refs`, compared
   without case or extra spacing. `src:` in front of a reference restricts it to sources;
4. a declaration of the project (a Mathlib lemma), when `declarationExists` is given: the Lean meta
   tool will answer it.

An unresolved reference rejects the call. The model gets, as a tool error, the references that did not
resolve and what to do; the call is no check: Lean does not run, it is not counted, and a strategy
it declared is not recorded. In the notes, the lines that cite what does not resolve are replaced by
`[unsourced reference removed]` in the notes that go to the next session.

A `sorry` presented as a known result blocks. A comment just above a declaration, or inside it or
inside a proof, that appeals to a known result or cites a source, next to a `sorry` or `admit` in the
code, rejects the call, even when the citation resolves: a `sorry` is an open goal, not a result.

## No raw error text

The negative memory passes typed summaries and never the text of a failed attempt ([the already-tried
section](m1-identity-memory.md#already-tried)). M6 keeps Lean's raw output out of what a model reads:

- **Sections.** After the lines have made their briefing sections, M6 removes the blocks of Lean's
  output from each one and drops a section that is only that. The section of M1 is made of typed
  lines and stays.
- **Notes.** The notes a session writes are what the next one starts from. M6 takes the blocks of
  Lean's output out of them; the journal keeps what the model wrote.

What it reads as Lean's output, in lines: a goal with its context (hypotheses `n : ℕ`, a `case`
line, or an error opener above it), a location (`Foo.lean:12:4`), an `error:` or `warning:`
header, the words of a type mismatch (`has type`, `but is expected to have type`), a quoted unknown
identifier, an unexpected token, and a copy of the harness's own report of a check (`Errors (2):`,
`1. PROOF line 3`). In the notes, a code fence that holds a goal or an error is also taken out. Each
removed block is replaced by `[Lean output removed]`. A typed summary (`unsolved goals at case succ`)
and a goal named in prose (`the goal is ⊢ n = 0`) stay. The check of the model's own current file,
in its tool results and in the opening message, is not touched: it is the feedback the loop works from.

## Anchored revisions

A revision follows a signal from outside the model: Lean's errors, a calculation, a counterexample
(plan §9). M6 rejects the two calls that cannot have one:

- a file that is the one last checked, comments and spacing aside: Lean answers a file the same way
  twice and its answer is in front of the model. The last check is the session's, or for the first
  call of a session, the one the prover's previous session ended with. Sending it again is allowed
  when that check never reached Lean or ran out of time;
- a file that differs from the last one, after a check that never reached Lean: there was nothing
  to revise from.

`hasSignal(report)` and `revisionProblem(last, proposal)` are plain functions that another line can
use. A model's rewriting of its notes is not judged: a session that only uses tools has no signal to
show for it and would be flagged wrongly.

## Drift detectors

They run after each `lean_check` and stop the session; the prover starts a fresh one (that is what
the loop does when a session ends), and the next session's briefing has a section "Course change"
that says, once, what was found. It is made of this page's words, labels and counts. A check that
makes the claim a candidate is never stopped.

**Lean progress** is `improves` of `@seshat/memory` ([the depth of a check](m1-identity-memory.md#how-far-a-check-got)):
a deeper failure, or the same depth with fewer errors, or with as many errors and fewer holes
(a closed subgoal), than the best check of the session so far.

| Detector | Stops the session when | Option |
|---|---|---|
| `statement_drift` | the file proves a statement that is not the target (the failure class `statement_changed`: Lean accepts the file but the validator finds the type changed) | |
| `restated_target` | an auxiliary lemma restates the target: M1's class `restates_target` (equal after normalization), or the injected `nearEquivalent(lemma, target)` says it is nearly equivalent | |
| `strategy_loop` | `repeats` checks in a row have the same strategy label (the one the model declared, else the one computed from the file) and none went further than the best check before them. The first check of a session always goes further than nothing and is not one of the `repeats`, so the earliest stop is at check `repeats` + 1 | `repeats` (3) |
| `length_growth` | the file's code is `lengthFactor` times its size at the last progress and `lengthMinChars` characters longer, with no subgoal closed | `lengthFactor` (2), `lengthMinChars` (800) |

They are tried in this order, and the first finding ends the session. Across sessions, `session_loop`
counts the sessions of one prover whose last check has the same strategy label and whose best check
went no further than any session of the prover before it (the prover's first session sets the bar and
is not counted). After `sessionRepeats` (3) of them the prover restarts afresh: M6 clears its notes (the journal keeps them) and the next session is told so
in "Course change". The count starts again.

## Options

`harness run --lines M6 --line-option M6.repeats=5`. The six switches let one guard be ablated alone.

| Option | Default | Meaning |
|---|---|---|
| `framing` | true | the neutral question for open conjectures |
| `framingAll` | false | the question for every problem |
| `citations` | true | reject unresolved citations and a sorry presented as known |
| `rawErrors` | true | take Lean's output out of sections and notes |
| `revisions` | true | reject unanchored revisions |
| `detectors` | true | the drift detectors |
| `repeats` | 3 | `strategy_loop`: checks in a row without progress, after the one that set the session's best |
| `sessionRepeats` | 3 | `session_loop`: sessions in a row without progress, after the one that set the prover's best |
| `lengthFactor` | 2 | `length_growth`: size factor |
| `lengthMinChars` | 800 | `length_growth`: minimum growth in characters |

`createM6({nearEquivalent, declarationExists, packetIds})` builds the line with the parts that a
later task provides: the near-equivalence of two statements and the existence of a declaration (the
Lean meta tool), and the ids of the packet (the context compiler). Without them, only M1's
`restates_target` is found, a reference resolves through the graph and the `source` nodes, and no
packet id exists.

## Resuming

M6 declares `resume: "rebuild"`. After each attempt it records a `watch` node (kind `watch`, as
`line:M6`) holding what its detectors watched in the session: the strategy label and the best Lean
state it reached if it watched them, and the last check (the sha256 of its normalized code, its signal, whether it was a
retry: the file itself is in the submission's blob, and the node keeps no copy of it). On resuming a problem, `resumeProblem` replays the detectors over the `watch` nodes of the
problem's attempts that were not cut, in order, so that the counts of repeats and of stalls are the
ones the process that ended had; reads back from the `drift` nodes the framings it has already
noted (once for the problem, not once for each process); restores the last check of each prover,
which the identical-file rule compares with; and delivers again the notice that was meant for the
session that followed a stopped or restarted one, when that session was cut or never started.
A cut session's own `watch` node is not read: what it watched is counted again when the session
is.

## The hooks it uses

The line API got four additions for this ([lines.md](lines.md)): `beforeCheck`, which rejects a call
before Lean runs; `reviewBriefing`, which lets a line drop or reword the sections the others made;
`AttemptAnnotation.notes`, which replaces the notes a session passes on; and `afterProver`.

## Tests and what is not done

`packages/guards/test` runs each rule on its own: the comments of Lean sources, the framing, the
references and their resolution, the raw-output reader on Lean's messages and on the typed
summaries that must stay, the revision rules, each detector on scripted sessions, and the drift
nodes. `packages/orchestrator/test/m6.test.ts` runs the line in whole runs with the simulated Lean
and a faux model: the briefing of an open conjecture, a rejected call that Lean never sees, a
session stopped by each detector and restarted with its notice, the notes cleaned, and that the
only events the line writes are `drift` nodes.

- `packages/orchestrator/test/resume-lines.test.ts` resumes runs of M6 at each boundary between
  sessions (the same findings at the same checks, a notice told again after a cut session, a framing
  noted once) and at every event of the journal.
- Nothing ran against a real model or a real Lean. The thresholds (3 repeats, a growth of 2 and 800
  characters) are a first guess to set on the bench.
- The bench holds solved problems only, so the framing guard has no effect there until a bench has
  open ones.
- A `source` node has no owner yet: M6 reads the names it may carry (`ref`, `name`, `declaration`...)
  and will follow the page of the line that writes them.
- The near-equivalence of statements and the existence of a declaration need the Lean meta tool
  (`@seshat/lean-meta`); they are injected until it is plugged in.
- A model that writes a reference in some other form than the ones above is not seen.
- No effect on the success rate is measured: that is what an ablation of M6 against the run without
  it will say.
