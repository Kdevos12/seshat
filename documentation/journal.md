# Journal

Every fact the harness learns is an event appended to a run's journal. The journal is the only
source of truth; the SQLite projection is a view of it and can be deleted at any time.

A run directory holds:

| File | Content |
|---|---|
| `journal.jsonl` | One event per line, in canonical JSON. |
| `journal.jsonl.lock` | The pid of the process that writes the journal. |
| `projection.sqlite` | Queryable view, rebuilt from the journal when it does not match. |
| `blobs/` | The content-addressed store of the run ([Blobs](#blobs)). |

A run of the M0 loop adds its configuration, transcripts, proofs and report
([m0-loop.md](m0-loop.md#the-run-directory)).

## Events

Each line is an envelope (`packages/core/src/events.ts`):

| Field | Meaning |
|---|---|
| `v` | Format version, 1. |
| `seq` | Position in the journal, from 0. |
| `id` | Event id, `evt_` plus a ULID. |
| `ts` | ISO 8601 time of the append. |
| `run` | Run id. |
| `actor` | Who produced the fact: `orchestrator`, `prover:<id>`, `validator`, a capability id. |
| `type`, `data` | The fact. |
| `prev` | Hash of the previous event, empty for the first. |
| `hash` | sha256 of the canonical JSON of the envelope without `hash`. |

Canonical JSON sorts object keys and drops undefined values, so equal values always hash the same.
Changing, removing or reordering an event breaks the chain, and the journal refuses to open.

Event types:

| Type | Data |
|---|---|
| `run.started` | `runId`, `benchId`, `problems`, `host`, `config`, `codeRev?` |
| `run.finished` | `runId`, `attempted`, `solved`, `refuted?`, `candidates`, `usd`, `stopped?` |
| `run.resumed` | `runId`, `resumption` (1, 2...), `tornTail?` (`action`, `bytes`, `sha256`), `spent` (`usd`, `inputTokens`, `outputTokens`), `interrupted` (`attempts`, `toolRuns`, `tasks`), `codeRev?` |
| `turn.started` | `runId`, `turn` (1, 2...), `limit` (`tokens?`, `usd?`, `minutes?`), `source`, `startSpend` (`usd`, `inputTokens`, `outputTokens`): a turn of a consortium run begins ([human.md](human.md)) |
| `turn.ended` | `runId`, `turn`, `reason` (`tokens`, `usd`, `minutes`, `impasse`, `settled`, `disagreement`, `interrupted`, `finished` or why the run stopped), `detail`, `spent` (`turn` and `run`: `usd`, `inputTokens`, `outputTokens`), `minutes`, `waiting` (problem ids), `breakpoint?` (`kind`, `problemId?`, `nodeId?`), `narrative?` (`hash?`, `rejected?`) |
| `problem.registered` | `problemId`, `claimId`, `target`, `source` (`repo`, `rev`, `path`, `line?`), `domain` |
| `problem.finished` | `problemId`, `claimId`, `outcome`, `reason?`, `attempts`, `usd`, `durationMs` |
| `claim.created` | `claimId`, `statementId`, `statement`, `origin`, `status`, `gloss?`, `domain?`, `kind?` (`formal`, `informal`), `parentId?`, `header?` |
| `claim.status_changed` | `claimId`, `from`, `to`, `reason`, `attemptId?`, `validationId?` |
| `attempt.started` | `attemptId`, `claimId`, `prover`, `iteration`, `model`, `role?` (`prove`, `refute`, `explore`), `strategy?`, `subgoal?`, `taskId?`, `site?`, `provenance?`, `included?`, `withheld?` |
| `attempt.charged` | `attemptId`, `usd`, `inputTokens`, `outputTokens`, `cachedInputTokens?` (the part of `inputTokens` read from the provider's prompt cache): one model response of a session |
| `attempt.finished` | `attemptId`, `outcome`, `failureClass?`, `stoppedBy?`, `error?`, `durationMs`, `turns`, `usd`, `inputTokens`, `outputTokens`, `cachedInputTokens?`, `strategy?`, `declaredStrategy?`, `premises?`, `failureDetail?`, `carry?` (`regions`, `lastCheck?`, `notes?`: blob hashes) |
| `tool_run.started` | `toolRunId`, `capability`, `implementation`, `version` (for a Lean tool in a resolved environment, followed by `+env:NAME@` and the first 12 digits of the environment hash), `inputHash`, `timeoutMs?`, `attemptId?`, `scope?` |
| `tool_run.finished` | `toolRunId`, `outcome` (`ok`, `error`, `timeout`, `aborted`), `durationMs`, `outputHash?`, `summary?` |
| `lesson.recorded` | `attemptId`, `claimId`, `text`, `provenance?` |
| `validation.finished` | `validationId`, `claimId`, `attemptId?`, `method` (`repl`, `kernel_replay`), `verdict`, `reasons`, `axioms`, `submissionHash`, `negation?`, `problemId?` |
| `edge.added` | `edgeId`, `kind`, `from`, `to` (a list), `status`, `attemptId?`, `toolRunId?`, `validationId?`, `note?`, `link?` (`name`, `statement`) |
| `edge.status_changed` | `edgeId`, `from`, `to`, `reason`, `validationId?` |
| `node.recorded` | `nodeId`, `kind`, `claimId?`, `data` (JSON), `provenance?` |
| `node.updated` | `nodeId`, `patch` (a JSON merge patch), `reason` |
| `model_call.finished` | `modelCallId`, `line`, `problemId?`, `attemptId?`, `model`, `outcome` (`ok`, `error`, `aborted`), `site?`, `requestHash`, `responseHash?`, `error?`, `durationMs`, `usd`, `inputTokens`, `outputTokens`, `cachedInputTokens?` |
| `task.created` | `taskId`, `kind`, `problemId?`, `claimId?`, `edgeId?`, `dependsOn`, `owner?`, `acceptance`, `budget`, `parentTaskId?`, `proposedBy?`, `title?` |
| `task.assigned` | `taskId`, `owner`, `reason` |
| `task.status_changed` | `taskId`, `from`, `to`, `reason`, `blockedBy?` |
| `task.routed` | `taskId`, `action`, `signal` (`type`, `value`), `reason`, `attemptId?`, `nodeId?` |
| `memory.epoch_opened` | `epoch`, `reason`, `changes` (`field`, `from`, `to`), `provenance` |

A claim's `statement` is in signature form: the binders, then `:` and the type, as between a
theorem's name and its `:=` (`(n : ℕ) : n + 0 = n`). Its `header` holds the imports, `open`s and
definitions the statement needs, so that any claim, not only a problem's target, can be written as
a file for the validator. An `informal` claim's statement is prose. `parentId` names the claim it
was derived from (a variant, a subgoal, a part).

An attempt's `role` says what it is for: prove the claim (the default), refute it (prove its
negation), or explore it. `strategy` on `attempt.started` is the strategy it was given or declared;
on `attempt.finished`, the strategy classified from what it submitted, with the `premises` (the
names the final proof uses) and a short `failureDetail`. `declaredStrategy` on `attempt.finished` is
the strategy the model declared in its last `lean_check` that gave one; it replaces, in the
projection, the one given at the start. A validation with `negation: true` checked
a proof of the claim's negation: a refutation.

Edges and nodes are the memory's other records. An edge goes from a claim or node to one target, or
to several for `decomposes_into`; its kinds are `implies`, `equiv`, `special_case_of`,
`strengthens`, `negation_of`, `decomposes_into`, `uses`, `refuted_by`, `derived_from`, `cites`,
`instance_of`. Its `link` names the Lean lemma that makes it true, for the kinds a lemma can check
(all but `uses`, `derived_from` and `cites`). A node is a record of any other kind (a lemma, a
lesson, a fingerprint...): its `kind` is a short lowercase word, its `data` belongs to the package
that owns the kind, and each `node.updated` applies a JSON merge patch (RFC 7386) to it.

A `model_call.finished` records a one-shot model call a mechanism made outside a prover session
(a line's `llm`, [lines.md](lines.md#llm)), with its cost; its request and response are blobs. Its
`site` says where the call was made ([ledger.md](ledger.md#sites)).

`turn.started` and `turn.ended` bracket the turns of a consortium run ([human.md](human.md#turns)): the
orchestrator alone writes them, one turn is open at a time, and a turn that was cut without its end is
closed by the next process (`reason: "interrupted"`). A run that is paused after `turn.ended` has no
`run.finished`: the report reads it as paused, not finished. The research team's answers are
`node.recorded` (kinds `hint` and `steer`) and `edge.status_changed` (`human_signed`) events whose actor
is `human:NAME`.

The task events (`task.*`) are the ledger's ([ledger.md](ledger.md)): the work of a run, as tasks
that point at claims and edges. Only the orchestrator writes them. `attempt.charged` is one model
response of a session, so that the cost of a session that was cut is not lost; `run.resumed` marks
the run's continuation after a crash, and is followed by the orchestrator's closing of what the
process left open: the sessions with no end (`attempt.finished`, `aborted`, `stoppedBy: "interrupted"`),
the tool runs with no end (`aborted`) and the tasks that were `running` (back to `ready`)
([ledger.md](ledger.md#resume)). A validation's `problemId` is
the problem whose workbench made the check, which is the problem that certifies what it made a
candidate.

The learned, unverified records carry a `provenance` stamp (`modelId`, `promptVersion`, `mathlibRev`,
`harnessVersion`, `budgetClass`, `createdAt`): an attempt, a lesson and a node a mechanism learned
from outcomes. `included` and `withheld` on an attempt are the unverified memory items a line drew into
the session and the ones the draw left out ([memory.md](memory.md#randomized-inclusion)).
`memory.epoch_opened` opens the memory's next epoch, with the reason and what changed
([memory.md](memory.md#provenance-and-epochs)); only the orchestrator writes it.

`run.started` may carry `memoryFrom` (`path`, `relative?`, `runId`, `lastHash`, `events`): the earlier run
this one starts on. `relative` is its directory relative to the new run's, tried first so that a lineage
whose directories moved together still reads; `path` is the absolute one it falls back to. The projection replays that journal before this one, and the run is refused when the
journal no longer ends at `lastHash` ([memory.md](memory.md#memory-across-runs)).

Mechanisms write claims, edges and nodes through the memory store ([memory.md](memory.md)).

Attempt outcomes: `valid`, `invalid`, `no_submission`, `budget_exhausted`, `aborted`, `error`.
Problem outcomes: `proved`, `refuted`, `candidate`, `unsolved`, `skipped`, `aborted`, `error`. Why a session
ended (`stoppedBy`), why a run stopped early (`stopped`) and what each outcome means are in
[m0-loop.md](m0-loop.md).

Tool runs are written by the capability registry ([capabilities.md](capabilities.md#calls)). A
tool run is `aborted` when its caller gave up (a budget ran out, a run was stopped), which is not
a failure of the tool. Its `summary` holds the output paths the manifest names, or the error. The
tool runs of a stateful capability carry their `scope`: the calls with the same scope share state
(the variables of a SageMath session), in the journal's order.

## Writing

`Journal.emit(type, data, actor)` is the only way to write. It checks the invariants against the
projection, appends the event, then updates the projection. Appends are synchronous, so their
order is the program's order. With `durable: true`, each append is followed by an fsync.

One process writes a journal at a time. The lock file holds the writer's pid; a lock left by a
process that no longer exists is taken over.

A crash during an append can leave a last line that is not a whole event. Reading tolerates it,
and opening for writing deals with it, so the next append starts on a fresh line: a fragment is cut
off, and the events before it, a prefix of the journal, still verify; a line that is a whole event
whose hash and place in the chain verify, and lacks only its newline, is kept. `EventLog.recovered`
says which, with the number of bytes and the sha256 of those bytes as they were on disk, and a resumed run writes it into
`run.resumed`. A caller that may still refuse to go on opens with `deferRepair: true`: the open reads
the journal and reports in `recovered` what the repair will do, writes nothing, and `append` refuses
until `repair()` has made the repair (a resume does that as its first write). A malformed line
anywhere else is corruption, and the journal refuses to open.

## Invariants

`emit` refuses an event, and writes nothing, when:

- a claim, attempt, tool run, validation, edge, node or model call id is created twice, or a
  problem is registered twice; claims and nodes share one space of ids, since edges name both;
- an event names a claim, attempt, tool run, validation, edge, node or problem that does not exist
  (a claim's parent, an edge's ends and provenance, a node's claim, a model call's problem);
- an attempt, tool run or problem finishes twice, or finishes without having started (or been
  registered);
- a problem finishes with a claim other than its own;
- a claim is created in a status other than `open`;
- a status change's `from` is not the claim's current status, or the transition is not allowed
  ([trust.md](trust.md#claim-statuses));
- a claim becomes `computed` without a valid validation of that claim (a proof of the claim, not of
  its negation), `proved` without a certified validation of that claim, or `refuted` without a
  certified validation of its negation ([trust.md](trust.md#the-journal-enforces-it));
- an edge has an unknown kind or status, no target, several targets when it is not a
  `decomposes_into`, a target twice, itself as a target, or a `link` on a kind no lemma checks;
- an edge status change's `from` is not the edge's current status, or `to` is the same;
- an edge becomes `lean_checked` (when it is added or later) without a link lemma and a valid
  validation of a claim whose statement is the link's ([trust.md](trust.md#edges));
- a node kind is not a lowercase word (`[a-z][a-z0-9_]*`, at most 32 characters), or is `hint` or `steer`
  and its actor is not `human:NAME` (the research team's answers are a person's, [human.md](human.md));
- a site is not made of dot-separated lowercase words (`graph.attempt`);
- an attempt is charged after it finished, or for an amount that is not a non-negative number;
- a task event comes from another actor than the orchestrator, or breaks a rule of the ledger
  ([ledger.md](ledger.md#what-the-journal-enforces)): transitions, dependencies, owner, blockers, the
  acceptance criterion of a `done` task, the way back from `running`, an attempt for a task that is
  not running;
- a resumption is not the next number;
- a turn event comes from another actor than the orchestrator, a turn begins while the one before is open or with a number that is not the next, a turn ends that is not the open one or with no reason, or a turn limit is not a positive number ([human.md](human.md#turns));
- a provenance is not a stamp of six non-empty fields; an attempt's `included` and `withheld` are not lists
  of item ids, or name an id twice;
- `memory.epoch_opened` comes from another actor than the orchestrator, is not the epoch after the
  current one, or has no reason, no change that opens an epoch, or no provenance;
- a claim status or an edge cites a validation of an earlier run recorded in another Lean environment:
  such a validation counts for nothing here ([memory.md](memory.md#memory-across-runs)).

## Projection

Tables: `epochs` and `attempt_items` (which memory items each attempt was shown or denied), `problems` (with their outcome once finished), `claims` (indexed by statement id and by
parent), `attempts` (with `stopped_by` and `error`, the strategies, premises and failure detail),
`tool_runs`, `lessons`, `validations`, `edges` with `edge_targets` (one row per target, in order,
indexed by target), `nodes` (their data with every patch applied), `model_calls`, `tasks`,
`task_routes`, `resumptions`, and `meta`, which records the seq and hash of the last applied event.
An attempt row also holds its task, its site, the sum of its charges and its carry. JSON columns hold canonical JSON, so rebuilding
from the journal gives the same rows.

Queries: `claim`, `claimsByStatement`, `problem(s)`, `attempt(s)`, `toolRun(s)`, `lessons`,
`validation(s)`, `edge`, `edges({from?, to?, kinds?, statuses?})`, `node`, `nodes(kind, claimId?)`,
`modelCall`, `task`, `tasks({problemId?, claimId?, owner?, statuses?, kinds?})`, `taskRoutes`,
`resumptions`, `attemptsOfTask`, `openAttempts`, `openToolRuns`, `validationsOfProblem`, `modelCallsOfProblem`, `claimsWithAttempts`, and the
spend: `taskSpend`, `problemSpend`, `totalSpend` and `spendBySite`. `edges({to})` looks the edges up in `edge_targets_by_to` and then by key, and never
scans the edges (a test reads the query plan): `equivalents` and the graph queries call it.

Applying an event is idempotent: an event at or below the last applied seq is skipped, and each
event is applied in one transaction. When a journal is opened, a projection that lags is caught
up. A projection that is ahead of the journal, or whose last hash differs from the journal's
event at that seq, belongs to another journal: it is deleted and rebuilt. So is a projection
written by another version of the tables: `PROJECTION_VERSION` (now 6) is kept in SQLite's
`user_version`.

A run that starts on earlier journals (`Journal.open(dir, run, {memory})`, which a journal that has
events reads from its own `run.started`) has its projection built on them: `attachChain` replays them
before the run's own events, with negative seqs (the last is -1), so the run's own seqs are what they
would be without a chain. Of an earlier journal the projection keeps the claims, attempts, tool runs,
lessons, validations, edges, nodes and epochs; its problems, tasks, resumptions and model calls are that
run's own and are left out, so its spend, its open attempts and its problem outcomes are not this run's
(`totalSpend`, `openAttempts`, `claimsWithAttempts` and `runSummary` count rows with a seq of 0 or more).
A journal recorded in another Lean environment keeps no status: its claims stay `open` and its edges
`proposed`, with the status it recorded in `earlier_status`, and its validations have `carried = 0`
(`validation` and `validations` do not return them; `earlierValidation(s)` do). `memorySummary()` counts
what came from the chain. A projection built on another chain (`chainHash`) is rebuilt. `runSummary()`
counts a claim that carried `proved` for a problem only when that problem's own certification is in this
journal.

`runSummary()` gives the number of problems, `solved` (claim `proved`), `refuted` (claim
`refuted`), `candidates` (claim `computed`), attempts, cost in dollars and tokens: the attempts'
and the model calls'. An attempt that never finished counts at the sum of its charges. The three counts are the claims': a problem is counted when its claim has the
status, whoever settled it, so two problems that share a claim count twice, and a claim whose proof
the kernel rejected is a candidate while its problem is `unsolved`. They are not the problems'
outcomes (`problem.finished`, and the report, which counts those).

## Blobs

`BlobStore(dir, readFrom?)` keeps texts by their sha256, in `dir/<first two hex digits>/<hash>`: `put(text)`
returns the hash, `putJson(value)` stores the canonical JSON and returns `hashJson(value)`, and
`get` checks that the content still matches its name. A blob is written to a temporary file and
then renamed, so no one ever reads half a blob. `readFrom` lists the blob directories of the earlier runs a run
starts on: `get` and `has` look in `dir` first and then in those, and nothing is ever written to them.

The events carry hashes, and the blobs hold what they name: the files provers submitted
(`submissionHash`) and, when the registry is given the store, the input and output of every tool
run (`inputHash`, `outputHash`).

## Statement ids

`statementIdV0` hashes a statement's text with comments removed and whitespace collapsed
(`st0_` prefix). Given the header the statement is read under (the imports, `open`s and definitions
before it), it hashes the header, normalized the same way, with the statement: the same text under
another header has another id, and a header with nothing in it counts as none. A statement with no
header has the hash of its text alone, which is the id the bench gives each problem. It catches
textual duplicates only: statements that differ in the name of a bound variable, in notation or by
an unfolding get different ids. P0b replaces it with a hash of the elaborated, normalized Lean
term (`st1_` prefix); ids of different versions never compare equal.
