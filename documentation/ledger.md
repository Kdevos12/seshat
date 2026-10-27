# Task ledger

The ledger is the record of the work of a run: what has to be done, who does it, what it may spend,
and when it is done. It is a graph of tasks over the *work*. The mathematics is another graph, the
claims and their edges ([memory.md](memory.md)), and the ledger never copies it: a task points at
claims and edges, and states what it must achieve in terms of their statuses. A claim has one
status, in the journal, and a task never holds one for it.

The ledger is infrastructure, not an ablation line: with no line enabled, a run of M0 records one
`prove` task per prover and behaves as it did before.

This page describes the events, the transitions and the rules the journal enforces
(`@seshat/core`), and `TaskLedger`, the orchestrator's handle on them (`@seshat/scheduler`).

## Tasks

A task is made by `task.created`:

| Field | Meaning |
|---|---|
| `taskId` | `tsk_` plus a ULID. |
| `kind` | `prove`, `refute`, `formalize`, `battery`, `search`, `compute`, `abduce`, `induce`, `repair` or `review`. |
| `problemId?`, `claimId?`, `edgeId?` | What the task is about. |
| `dependsOn` | Tasks that must be `done` before this one is `ready`. They exist already, so dependencies cannot make a cycle. |
| `owner?` | Who works on it: an actor such as `prover:p1` or `line:M12`. Set here, or later by `task.assigned`. |
| `acceptance` | What must hold for the task to be `done` ([below](#acceptance-criteria)). |
| `budget` | What it may spend: `usd?`, `sessions?`. A limit that is missing is no limit. |
| `parentTaskId?` | The task this one continues or replaces. |
| `proposedBy?` | The line that proposed it, when a line did. |
| `title?` | A few words on what it is for. |

`task.assigned` (`taskId`, `owner`, `reason`) gives a task that has not started a new owner.
`task.status_changed` (`taskId`, `from`, `to`, `reason`, `blockedBy?`) moves it.
`task.routed` records a routing decision ([Routing](#routing-decisions)). The projection keeps the
tasks in the `tasks` table and the decisions in `task_routes`; both are rebuilt from the journal.

## Statuses

| Status | Meaning |
|---|---|
| `pending` | Made, not yet cleared to start. Every task starts here. |
| `ready` | Its dependencies are `done`. It may be started. |
| `running` | Someone works on it. It has an owner. |
| `blocked` | It waits for something named: task ids, or `ext:<name>` for a person or a resource. |
| `done` | Its acceptance criterion holds. Final. |
| `failed` | It could not be done. Final. |
| `cancelled` | It was given up, or it became pointless. Final. |

The transitions are fixed:

```
pending -> ready | blocked | cancelled
ready   -> running | blocked | cancelled
running -> done | failed | blocked | cancelled | ready (only after a resumption)
blocked -> ready | failed | cancelled
```

More work on a goal that a final task did not reach is a new task, with the old one as its parent.
The words of the task statuses and those of the claim statuses (`open`, `computed`, `refuted`,
`proved`, `proved_informal`, `retracted`) are all different, and a test checks it.

## Acceptance criteria

A criterion is stated on a claim or an edge, and read from the projection when the task is moved to
`done`:

- `{type: "claim", claimId, minStatus}` with `minStatus` one of `computed`, `proved_informal`,
  `proved` or `refuted`. It means "at least": `computed` also holds for a claim that is `proved`,
  since a certified proof was a candidate first; `refuted` holds only for a refuted claim.
- `{type: "edge", edgeId, minStatus}` with an edge status. The order is the one of the edge
  statuses ([trust.md](trust.md#edges)): `proposed`, `computed`, `informal_checked`, `human_signed`,
  `lean_checked`, so `lean_checked` holds only for an edge Lean checked.

A task whose goal has no claim or edge to point at cannot say when it is done; the criteria will
grow, additively, when a task needs one.

## What the journal enforces

`Journal.emit` refuses a task event, and writes nothing, when:

- the actor is not `orchestrator`. Only the orchestrator appends task events: a line *proposes*
  tasks, and the orchestrator commits them. (A line has no handle on the journal; the memory store
  keeps it private.)
- a task is made twice, has an unknown kind, or names a problem, claim, edge, dependency or parent
  that does not exist, a criterion of the wrong shape or about a claim or edge that does not exist,
  or a budget that is not made of non-negative numbers;
- a status change's `from` is not the task's status, or the transition is not in the table, or it
  comes without a reason;
- a task becomes `ready` or `running` while a task it depends on is not `done`;
- a task becomes `running` without an owner;
- a task is `blocked` by nothing, by itself, by a task that does not exist or is `done`, or a task
  that is not `blocked` has `blockedBy`; a blocked task becomes `ready` only when the tasks that
  block it are `done`;
- a task becomes `done` while its criterion does not hold in the projection;
- a `running` task goes back to `ready` before the run was resumed since the task started
  ([Resume](#resume));
- a task that has started changes owner;
- an attempt works for a task that is not `running`, or for another claim than the task's.

A task event never carries a claim status and never changes one. A claim becomes `computed`,
`proved` or `refuted` only through the validations that [trust.md](trust.md) describes; the
ledger can only notice it, and a task whose criterion asks for more than the claim has is refused
its `done`.

## TaskLedger

`TaskLedger` (`packages/scheduler/src/ledger.ts`) is what the orchestrator writes the ledger with.
It wraps the events above as moves, and the journal's rules still decide: a move that is not
allowed throws, and nothing is written.

| Method | What it does |
|---|---|
| `get(taskId)`, `list(filter?)` | Read tasks: one by id, or those that meet a filter (problem, statuses, owner...), in the order they were made. |
| `create(task)` | Makes a `pending` task and returns its id. |
| `assign(taskId, owner, reason)` | Gives a task that has not started an owner. |
| `markReady`, `start`, `complete`, `fail`, `cancel`, `block` | The moves of the table above. `complete` is refused while the criterion does not hold. |
| `holds(taskId)`, `completeIfHolds(taskId, reason)` | Reads the criterion; completes a running task whose criterion holds. |
| `promote(problemId?)` | Moves to `ready` the `pending` tasks whose dependencies are done, and the `blocked` ones whose blockers are tasks that are done. A task that waits for an `ext:` key is released by `markReady`. |
| `interrupt(reason, problemId?)` | After `run.resumed`: `running` tasks back to `ready`. |
| `closeProblem(problemId, reason)` | Cancels every task of the problem that has not ended. |
| `route(decision)` | Writes a `task.routed`. |
| `propose(context, proposal)` | Commits what a line proposed, or refuses it with a reason. |

A line never gets a `TaskLedger`. It proposes through its context (`TaskApi` in
[lines.md](lines.md)), and `propose` makes the task the problem's, `pending`, proposed by the line and
owned by it, unless the orchestrator assigns it to someone else. A proposal names no status and no
owner. Its dependencies and parent must be tasks of the same problem, and a problem takes at most
200 proposed tasks (the option `maxProposed`), so that a line that proposes without end is stopped
with a reason it can read. What the journal refuses (a claim that does not exist, a criterion of the
wrong shape) comes back as the reason, and nothing is written.

## What M0 records

A run with no line enabled records, for each problem that is worked on, one `prove` task per
prover, and no other task. The problem's reference file has been checked by then (a problem that is
skipped has no task), and the tasks are made before the lines' `beforeProvers`, so that a line can
read them.

| Moment | Event |
|---|---|
| The problem will be worked on | `task.created` per prover: `kind: prove`, the problem and its claim, owner `prover:pN`, the criterion "the claim is at least `computed`", the budget (`usd`: the problem's, `sessions`: the prover's), a title. Then `pending` to `ready`, since nothing is waited for. |
| A prover starts | `ready` to `running`. Its attempts say `taskId` and `site` (`prover.session`) in `attempt.started`. |
| A prover ends | The task ends ([below](#how-a-provers-task-ends)); the tasks that waited for it become `ready`. |
| The problem ends | Before `problem.finished`: every task of the problem that has not ended is `cancelled`, with the reason "the problem ended: `<outcome>`". These are the tasks no prover took up and the ones lines proposed that nobody ran. |

### How a prover's task ends

The task ends when the prover does, before the lines' `afterProver`:

| The prover | The task |
|---|---|
| found a proof that passed the fast check | `done`, if the claim is at least `computed`, which it is |
| used its sessions | `failed`, unless the claim reached the criterion without it |
| found its budget spent (the problem's or the run's) | `failed`, with the same exception |
| had two sessions in a row end with an error (the model or Lean could not be reached) | `failed`, with the same exception |
| was stopped (the run was stopped) | `cancelled`: "the run was stopped" |
| was stopped by a line's `beforeSession` | `cancelled`: "a line stopped prover pN" |
| crashed (a failure of the harness) | `failed`: "the harness failed in prover pN: ..." |

The exception is the claim that reached the criterion through another prover's proof: the task is
then `cancelled`, "another prover's proof passed first; this task is pointless", because its goal
was reached without it. `done` is for the prover whose own proof passed. The journal would refuse a
`done` for any task whose criterion did not hold, and the orchestrator never asks for one.

A `done` prover task means a candidate, not a proof: its criterion is `computed`. The certification
that follows ([m0-loop.md](m0-loop.md#certification)) is a step of the orchestrator, recorded as a
`kernel_replay` validation, not a task; the claim becomes `proved` or `refuted` only through it, and
the task statuses never stand for a claim's.

## Routing decisions

`task.routed` (`taskId`, `action`, `signal`, `reason`, `attemptId?`, `nodeId?`) is a decision about
a task that met a typed signal. The signal has a type and a value: a failure class of a check
(`failure_class`, [m1-identity-memory.md](m1-identity-memory.md#failure-classes)), a kind of drift a
guard found (`drift_kind`, [guards.md](guards.md)), or a refuted part of a decomposition
(`subgoal_refuted`, the part's claim id). The event is the decision and nothing more: it changes no
task status and no claim status, and the journal accepts it from the orchestrator only.

The action is one of three:

| Action | Meaning |
|---|---|
| `retry_fresh` | A new session on the same task. The error is local: the next session reads what Lean said and fixes it. |
| `reset_upstream` | Go back to the planning above the task and decompose the parent again. The error is in what the task rests on, not in its proof. |
| `branch` | Open an alternative task under other constraints. The task is stuck, and more of the same would not get further. |

The table is in `packages/orchestrator/src/routing.ts`, typed over `FailureClass` and `DriftKind`, so
that a class or a kind added later does not compile until it is routed:

| Signal | Action |
|---|---|
| `refused`, `lean_unavailable`, `timeout`, `syntax`, `unknown_identifier`, `type_mismatch`, `tactic_failed`, `unsolved_goals`, `holes`, `axioms`, `other` | `retry_fresh` |
| `statement_changed`, `restates_target` | `reset_upstream` |
| drift `statement_drift`, `restated_target` | `reset_upstream` |
| `subgoal_refuted` | `reset_upstream` |
| drift `strategy_loop`, `session_loop` | `branch` |
| drift `length_growth`, `unresolved_citation`, `sorry_as_known`, `raw_error_text`, `unanchored_revision`, `non_neutral_framing` | `retry_fresh` |

Each row has its reason in the table, and the decision's `reason` is "what was seen: why this
action", for example "the last check failed as restates_target: an auxiliary lemma states the target
again, so it decomposes nothing; go back to the parent and decompose it differently".

When the orchestrator decides, after each attempt, for the task the attempt worked for:

- the class of the attempt's last check, when the attempt ended `invalid`;
- each `drift` node a guard recorded for the attempt whose action stopped the session or restarted
  the prover (`stopped_session`, `restarted`), with the node's id in `nodeId`. The findings a guard
  dealt with in place (`rejected_call`, `removed_text`, `dropped_section`, `noted`) are not signals
  for the task: nothing failed, and the node holds them;
- each part of a decomposition of the task's claim that is `refuted` and was not routed for the task
  before.

An attempt that is valid, aborted, out of budget, an error or without a check has no decision.

The orchestrator only records. `retry_fresh` is what the prover's loop does next in any case, so its
decision explains the next session. `reset_upstream` and `branch` are for the lines that plan work
(M12; M7 and M14 plug in at `branch`): they read the decisions through `TaskApi.routings`
([lines.md](lines.md#tasks)) and propose the tasks that follow, with the task the decision was about
as their parent. A line that proposes work never changes the decision, and the decision never
changes a status.

## Charges and carry

An attempt's cost is in its `attempt.finished`. A session that is cut never writes it, so each model
response of a session also writes `attempt.charged` (`attemptId`, `usd`, `inputTokens`,
`outputTokens`), and the projection counts an unfinished attempt at the sum of its charges. A
resumed run starts its budgets from this. A session that does not finish is written at that sum
too, never at zero: the resumption closes a cut session as `aborted`, and a session that the
harness fails in (an error thrown out of it) ends `error`, at the cost it had been charged
(`chargedTotals`), because a finished attempt is counted at its own totals and not at its charges.

`attempt.finished` may carry `carry`: the blobs of what the prover hands to its next session (its
regions, the text of its last check, its notes). A resumed prover starts from the carry of its last
finished session.

## Sites

Every model call has a site, a short dotted name that says where in the harness it is made
(`prover.session`, `graph.attempt`, `conjecture.relevance`...). A one-shot call's
`model_call.finished` carries it, and an attempt's `attempt.started` may carry one (a prover's
session is `prover.session` when it names none). `Projection.spendBySite()` adds the cost up by
site, the attempts under their own site and the one-shot calls under theirs; a call recorded
before the tags is `unknown`. The share of the budget that each site takes is what a cheaper
decision backend could save at most.

The report has the spend by site (`sites` in `report.json`, a line in `report.md`): for each site
its calls, cost, tokens and share of the total, the biggest first. `siteSpend(events)` computes it
from a journal's events, and `mergeSiteSpend` adds several runs' lists together; `harness ablate`,
when it exists, reads it from there for the table that compares the configs.

## Resume

A run whose process ended without finishing it (a kill, a crash, a usage limit, a power cut) is
continued by `harness run --resume RUN_DIR` (`resumeBench`, `packages/orchestrator/src/run.ts`).
The journal is the only source: the run is the one `run.started` recorded, and nothing a model or a
line held in memory is needed, because what a resumed run uses is in the journal and the blobs.
Everything the resumed process writes is written by the orchestrator, after `run.resumed`.

### What it refuses, before it writes anything

| Refused | Because |
|---|---|
| a directory without a journal, a journal that is corrupt (the hash chain is checked) or that never began | there is no run to continue |
| a run that is complete: every problem has an outcome and its last `run.finished` came after its last resumption | there is nothing to continue. A run killed after its last problem and before `run.finished` is not complete: resuming it writes `run.finished`. |
| another bench (its hash), or problems that are not the ones the journal hashed | it would be another run |
| other prompts (version and hash), validation policy or lines (ids, versions, options) than `run.started` recorded | the code that resumes is not the code that began the run |
| an enabled line that cannot be resumed ([lines](#lines)) | its state would be lost |
| the run's model, when this process cannot reach it (an unknown provider, no credentials) | the same refusal as `harness run` |
| another host, capability registry (catalog and host profile), tools or certifier than the run began with | it would be another run |

All but the last row are checked before the journal is opened. The last needs the registry, which
is built on a journal that is open, so the resume opens it with the repair of a cut last line
deferred (`deferRepair`, [the torn tail](#the-torn-tail)): the journal is read, nothing is written,
and a refusal at any of these checks leaves the directory's bytes exactly as the crash left them.
The repair is the first write of the resumption, made by `beginResumption` just before `run.resumed`
records it. No flag that describes a run is accepted with `--resume`: its configuration, the model
included, is read from `run.started`.

### What it writes first

`run.resumed` (`runId`, `resumption`, `tornTail?`, `spent`, `interrupted`, `codeRev?`) comes first.
The resumptions are numbered 1, 2... and the journal refuses a number out of order. Then, in this
order, the orchestrator closes what the process left open:

| Left open | Closed as |
|---|---|
| a tool run with no end | `tool_run.finished`, outcome `aborted` |
| an attempt (a session) with no end | `attempt.finished`, outcome `aborted`, `stoppedBy: "interrupted"`, at the cost of its charges, with no carry: a session that was cut hands nothing on |
| a task that was `running` | `ready`, with the reason "the process ended while the task ran; the run was resumed (resumption N)" |

The last row is the one way back from `running`, and the journal allows it only when a `run.resumed`
is newer than the task's start (`TaskLedger.interrupt`). The task then starts again as any other:
"prover p1 resumes after the interruption, at session 3". Tasks that had ended stay ended.

### The torn tail

A crash during an append can leave a last line that is not a whole event, and nothing else. Decided:

- a fragment is cut off (`dropped`): the events before it are a prefix of the journal, and the chain
  still verifies;
- a line that is a whole event whose hash and place in the chain verify, and lacks only its newline,
  is kept (`completed`): dropping it would lose a fact the chain vouches for.

`EventLog.recovered` says which (before the repair is made, when a resume defers it), and `run.resumed.tornTail` keeps the bytes' number and their sha256;
the report counts the cut lines. What a dropped fragment described is lost with it. The cost is at
most one event: a model response whose charge was the fragment is not billed in the journal, so the
resumed run's budget does not count it. Reading a run (`readRecordedRun`, `harness report`) never
writes: it reads the events before the cut.

### Budgets

The run's ledger and each problem's start from what the journal says was spent
(`Projection.totalSpend()` and `problemSpend()`: the charges of every session, finished or cut, and
the lines' one-shot calls). A ledger that starts over its limit says so at once, so a budget that
ran out stays out and a resumed run spends no more than what is left. The tests compare a resumed
run with one that was not cut: the same calls, the same cost. One response that was in flight when
the process ended was never billed to the journal, and the resumed run cannot count it.

Problems are taken in this order: first the ones the journal registered and did not end, whatever
is left of the run's budget (they end at once if none is), then the ones it had not begun, which a
spent run budget leaves unbegun, as it would have in a run that was not cut. A problem that has an
outcome keeps it, `aborted` too: it was stopped on purpose. A resumed process that is stopped before
it reaches a problem leaves it as it was, with no outcome, so that a later resumption takes it up;
one that is stopped in the middle of a problem ends it as `aborted`, as a run that was not cut would.

### A problem taken up

The problem keeps its claim, its registration and its prover tasks, which are the ones the journal
has; the reference file is checked again (a Lean call, no model). Then:

- **The candidate.** The first valid fast check that the problem's workbench made of its own claim
  is the candidate, read back from the journal and the blob of the file that was checked
  (`recoverCandidate`, `Workbench.adopt`). It is not found again, no prover runs, and the claim is
  made `computed` if the process ended between the validation and the change of status. The prover
  that found it is `done`, the others `cancelled`, as in a run that was not cut.
- **The provers.** A prover whose task is `ready` goes on at the session after the last it started,
  with what the last session that finished carried: its regions, its last check and its notes. A
  session that was cut counts as used and says nothing about the prover's health.
- **The lines.** `beforeProvers` is not called again once a prover of the problem had started; it
  is when none had, since the process may not have finished it.
- A journal that names a blob the run directory lost ends the problem as an `error`, with the blob.

### Certification

A candidate is certified once. What the resumed run does depends on what the journal holds:

| The journal holds | The resumed run |
|---|---|
| no candidate | the provers go on |
| a candidate, and a `kernel_replay` validation of its file (valid or invalid) | uses that answer, certifies nothing again, and makes the claim `proved` or `refuted` if the answer is valid and the change of status was cut |
| a candidate, and no `kernel_replay` validation | asks the certifier, once |

A certification cut in the middle of its call falls under the last row. The validation is written
when the answer arrives, before the claim's change of status, so a call that did not answer recorded
nothing: the claim is still `computed`, and a certifier that is a registry capability left a tool run
with no end, which the resumption closes as `aborted`. The kernel replay is made again from the
start. The certifier may therefore have been asked twice for one candidate, once by each process,
but the journal never holds two answers for it.

### Lines

A line says in `resume` whether a run with it can be resumed ([lines.md](lines.md#resuming-a-run-with-lines)):
`"stateless"` (what it keeps is in the journal and the memory, as M1's is), or `{refuse: reason}`,
and a line that says nothing is refused. The repository's lines: M1 is stateless; M2 (the truth
maintenance state of its graph), M6 (the detectors' counts) and the fleet (its width gate and
rotation) refuse, until they rebuild their state from the journal and the memory. A run with one of
them cannot be resumed, and the command says which line and why.

### What a resumed run does not restore

- A model response in flight at the interruption, and the routing decisions the process had not yet
  written: neither is made up.
- The sessions a line skipped (its `beforeSession` stopped them) are not recorded, so a resumed
  prover may be offered them again.
- A proof that a line submitted for another claim, or a refutation, and that waited for
  certification, is not certified by the resumed run (its validation is in the journal; the claim
  stays `computed`). Only the problem's own candidate is recovered.
- A claim an M0 run created and registered no problem for, when the process ended between the two
  events, stays in the journal as a claim no problem points at; the problem then gets a new one.
- `durationMs` of a taken-up problem measures the resumed process only. Its cost, attempts and
  outcome are the problem's whole.

The report says that the run was resumed, how many sessions, tool runs and tasks the interruptions
cut, and how many cut last lines it found.
