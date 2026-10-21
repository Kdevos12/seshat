# Task ledger

The ledger is the record of the work of a run: what has to be done, who does it, what it may spend,
and when it is done. It is a graph of tasks over the *work*. The mathematics is another graph, the
claims and their edges ([memory.md](memory.md)), and the ledger never copies it: a task points at
claims and edges, and states what it must achieve in terms of their statuses. A claim has one
status, in the journal, and a task never holds one for it.

The ledger is infrastructure, not an ablation line: with no line enabled, a run of M0 records one
`prove` task per prover and behaves as it did before.

This page describes the part in `@seshat/core`: the events, the transitions and the rules the
journal enforces.

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

## Routing decisions

`task.routed` (`taskId`, `action`, `signal`, `reason`, `attemptId?`, `nodeId?`) is a decision about
a task that met a typed signal. The action is `retry_fresh`, `reset_upstream` or `branch`; the
signal is a failure class of a check, a kind of drift, or a refuted subgoal. The event is the
decision and nothing more: it changes no task status and no claim status.

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
