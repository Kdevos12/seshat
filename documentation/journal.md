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
| `claim.created` | `claimId`, `statementId`, `statement`, `origin`, `status`, `gloss?`, `domain?`, `kind?` (`formal`, `informal`), `parentId?`, `header?` |
| `claim.status_changed` | `claimId`, `from`, `to`, `reason`, `attemptId?`, `validationId?` |
| `attempt.started` | `attemptId`, `claimId`, `prover`, `iteration`, `model`, `role?` (`prove`, `refute`, `explore`), `strategy?`, `subgoal?` |
| `attempt.finished` | `attemptId`, `outcome`, `failureClass?`, `stoppedBy?`, `error?`, `durationMs`, `turns`, `usd`, `inputTokens`, `outputTokens`, `strategy?`, `premises?`, `failureDetail?` |
| `tool_run.started` | `toolRunId`, `capability`, `implementation`, `version`, `inputHash`, `timeoutMs?`, `attemptId?`, `scope?` |
| `tool_run.finished` | `toolRunId`, `outcome` (`ok`, `error`, `timeout`, `aborted`), `durationMs`, `outputHash?`, `summary?` |
| `lesson.recorded` | `attemptId`, `claimId`, `text` |
| `validation.finished` | `validationId`, `claimId`, `attemptId?`, `method` (`repl`, `kernel_replay`), `verdict`, `reasons`, `axioms`, `submissionHash`, `negation?` |
| `edge.added` | `edgeId`, `kind`, `from`, `to` (a list), `status`, `attemptId?`, `toolRunId?`, `validationId?`, `note?`, `link?` (`name`, `statement`) |
| `edge.status_changed` | `edgeId`, `from`, `to`, `reason`, `validationId?` |
| `node.recorded` | `nodeId`, `kind`, `claimId?`, `data` (JSON) |
| `node.updated` | `nodeId`, `patch` (a JSON merge patch), `reason` |
| `model_call.finished` | `modelCallId`, `line`, `problemId?`, `attemptId?`, `model`, `outcome` (`ok`, `error`, `aborted`), `requestHash`, `responseHash?`, `error?`, `durationMs`, `usd`, `inputTokens`, `outputTokens` |

A claim's `statement` is in signature form: the binders, then `:` and the type, as between a
theorem's name and its `:=` (`(n : ℕ) : n + 0 = n`). Its `header` holds the imports, `open`s and
definitions the statement needs, so that any claim, not only a problem's target, can be written as
a file for the validator. An `informal` claim's statement is prose. `parentId` names the claim it
was derived from (a variant, a subgoal, a part).

An attempt's `role` says what it is for: prove the claim (the default), refute it (prove its
negation), or explore it. `strategy` on `attempt.started` is the strategy it was given or declared;
on `attempt.finished`, the strategy classified from what it submitted, with the `premises` (the
names the final proof uses) and a short `failureDetail`. A validation with `negation: true` checked
a proof of the claim's negation: a refutation.

Edges and nodes are the memory's other records. An edge goes from a claim or node to one target, or
to several for `decomposes_into`; its kinds are `implies`, `equiv`, `special_case_of`,
`strengthens`, `negation_of`, `decomposes_into`, `uses`, `refuted_by`, `derived_from`, `cites`,
`instance_of`. Its `link` names the Lean lemma that makes it true, for the kinds a lemma can check
(all but `uses`, `derived_from` and `cites`). A node is a record of any other kind (a lemma, a
lesson, a fingerprint...): its `kind` is a short lowercase word, its `data` belongs to the package
that owns the kind, and each `node.updated` applies a JSON merge patch (RFC 7386) to it.

A `model_call.finished` records a one-shot model call a mechanism made outside a prover session
(a line's `llm`, [lines.md](lines.md#llm)), with its cost; its request and response are blobs.

Mechanisms write claims, edges and nodes through the memory store ([memory.md](memory.md)).

Attempt outcomes: `valid`, `invalid`, `no_submission`, `budget_exhausted`, `aborted`, `error`.
Problem outcomes: `proved`, `candidate`, `unsolved`, `skipped`, `aborted`, `error`. Why a session
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

A crash during an append can leave a partial last line. Reading tolerates it, and opening for
writing cuts it, so the next append starts on a fresh line. A malformed line anywhere else is
corruption, and the journal refuses to open.

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
- a node kind is not a lowercase word (`[a-z][a-z0-9_]*`, at most 32 characters).

## Projection

Tables: `problems` (with their outcome once finished), `claims` (indexed by statement id and by
parent), `attempts` (with `stopped_by` and `error`, the strategies, premises and failure detail),
`tool_runs`, `lessons`, `validations`, `edges` with `edge_targets` (one row per target, in order,
indexed by target), `nodes` (their data with every patch applied), `model_calls`, and `meta`, which
records the seq and hash of the last applied event. JSON columns hold canonical JSON, so rebuilding
from the journal gives the same rows.

Queries: `claim`, `claimsByStatement`, `problem(s)`, `attempt(s)`, `toolRun(s)`, `lessons`,
`validation(s)`, `edge`, `edges({from?, to?, kinds?, statuses?})`, `node`, `nodes(kind, claimId?)`,
`modelCall`.

Applying an event is idempotent: an event at or below the last applied seq is skipped, and each
event is applied in one transaction. When a journal is opened, a projection that lags is caught
up. A projection that is ahead of the journal, or whose last hash differs from the journal's
event at that seq, belongs to another journal: it is deleted and rebuilt. So is a projection
written by another version of the tables: `PROJECTION_VERSION` (now 3) is kept in SQLite's
`user_version`.

`runSummary()` gives the number of problems, `solved` (claim `proved`), `candidates` (claim
`computed`), attempts, cost in dollars and tokens: the attempts' and the model calls'.

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
