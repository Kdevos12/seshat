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
| `run.finished` | `runId`, `attempted`, `solved`, `candidates`, `usd`, `stopped?` |
| `problem.registered` | `problemId`, `claimId`, `target`, `source` (`repo`, `rev`, `path`, `line?`), `domain` |
| `problem.finished` | `problemId`, `claimId`, `outcome`, `reason?`, `attempts`, `usd`, `durationMs` |
| `claim.created` | `claimId`, `statementId`, `statement`, `origin`, `status` |
| `claim.status_changed` | `claimId`, `from`, `to`, `reason`, `attemptId?`, `validationId?` |
| `attempt.started` | `attemptId`, `claimId`, `prover`, `iteration`, `model` |
| `attempt.finished` | `attemptId`, `outcome`, `failureClass?`, `stoppedBy?`, `error?`, `durationMs`, `turns`, `usd`, `inputTokens`, `outputTokens` |
| `tool_run.started` | `toolRunId`, `capability`, `implementation`, `version`, `inputHash`, `timeoutMs?`, `attemptId?` |
| `tool_run.finished` | `toolRunId`, `outcome` (`ok`, `error`, `timeout`, `aborted`), `durationMs`, `outputHash?`, `summary?` |
| `lesson.recorded` | `attemptId`, `claimId`, `text` |
| `validation.finished` | `validationId`, `claimId`, `attemptId?`, `method` (`repl`, `kernel_replay`), `verdict`, `reasons`, `axioms`, `submissionHash` |

Attempt outcomes: `valid`, `invalid`, `no_submission`, `budget_exhausted`, `aborted`, `error`.
Problem outcomes: `proved`, `candidate`, `unsolved`, `skipped`, `aborted`, `error`. Why a session
ended (`stoppedBy`), why a run stopped early (`stopped`) and what each outcome means are in
[m0-loop.md](m0-loop.md).

Tool runs are written by the capability registry ([capabilities.md](capabilities.md#calls)). A
tool run is `aborted` when its caller gave up (a budget ran out, a run was stopped), which is not
a failure of the tool. Its `summary` holds the output paths the manifest names, or the error.

## Writing

`Journal.emit(type, data, actor)` is the only way to write. It checks the invariants against the
projection, appends the event, then updates the projection. Appends are synchronous, so their
order is the program's order. With `durable: true`, each append is followed by an fsync.

One process writes a journal at a time. The lock file holds the writer's pid; a lock left by a
process that no longer exists is taken over.

A crash during an append can leave a partial last line. Reading tolerates it, and opening for
writing cuts it, so the next append starts on a fresh line. A malformed line anywhere else is
corruption, and the journal refuses to open.

## Invariants

`emit` refuses an event, and writes nothing, when:

- a claim, attempt, tool run or validation id is created twice, or a problem is registered twice;
- an event names a claim or attempt that does not exist;
- an attempt, tool run or problem finishes twice, or finishes without having started (or been
  registered);
- a problem finishes with a claim other than its own;
- a status change's `from` is not the claim's current status, or the transition is not allowed
  ([trust.md](trust.md#claim-statuses));
- a claim becomes `proved` or `refuted` without a certified validation
  ([trust.md](trust.md#the-journal-enforces-it)).

## Projection

Tables: `problems` (with their outcome once finished), `claims` (indexed by statement id),
`attempts` (with `stopped_by` and `error`), `tool_runs`, `lessons`, `validations`, and `meta`,
which records the seq and hash of the last applied event.

Applying an event is idempotent: an event at or below the last applied seq is skipped, and each
event is applied in one transaction. When a journal is opened, a projection that lags is caught
up. A projection that is ahead of the journal, or whose last hash differs from the journal's
event at that seq, belongs to another journal: it is deleted and rebuilt. So is a projection
written by another version of the tables: `PROJECTION_VERSION` (now 2) is kept in SQLite's
`user_version`.

`runSummary()` gives the number of problems, `solved` (claim `proved`), `candidates` (claim
`computed`), attempts, cost in dollars and tokens.

## Blobs

`BlobStore(dir)` keeps texts by their sha256, in `dir/<first two hex digits>/<hash>`: `put(text)`
returns the hash, `putJson(value)` stores the canonical JSON and returns `hashJson(value)`, and
`get` checks that the content still matches its name. A blob is written to a temporary file and
then renamed, so no one ever reads half a blob.

The events carry hashes, and the blobs hold what they name: the files provers submitted
(`submissionHash`) and, when the registry is given the store, the input and output of every tool
run (`inputHash`, `outputHash`).

## Statement ids

`statementIdV0` hashes a statement's text with comments removed and whitespace collapsed
(`st0_` prefix). It catches textual duplicates only: two files can give the same text different
meanings through local notations. P0b replaces it with a hash of the elaborated, normalized Lean
term (`st1_` prefix); ids of different versions never compare equal.
