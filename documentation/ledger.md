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
resumed run starts its budgets from this.

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

`run.resumed` (`runId`, `resumption`, `tornTail?`, `spent`, `interrupted`, `codeRev?`) is written by
the orchestrator when a run continues after the process that ran it ended without finishing. The
resumptions are numbered 1, 2... and the journal refuses a number out of order.

A crash during an append can leave a last line that is not a whole event. Opening the journal
deals with it, and `EventLog.recovered` says how: a fragment is cut off (`dropped`) and the events
before it, which are a prefix of the journal, still verify; a line that is a whole event whose hash
and place in the chain verify, and lacks only its newline, is kept (`completed`) rather than lose a
fact the chain vouches for. `run.resumed.tornTail` keeps the number of bytes and their sha256.

A task that was `running` when the process ended goes back to `ready` after `run.resumed`, and
only then: that is the one way back from `running`, and the journal allows it only when a
resumption is more recent than the task's start.
