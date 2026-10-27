# Lines

The plan measures each mechanism as an ablation line (plan §6): a run with the line switched on
against a run without it, at equal budget, on the same problems. In the code, a mechanism is a
*line*: an object with an id, the lines it needs, and hooks that the orchestrator calls at fixed
points of a run. A run enables lines with `harness run --lines` or `--ablation`; with none, it is
exactly M0 ([m0-loop.md](m0-loop.md)).

The API is in `@seshat/lines`; the orchestrator runs it (`packages/orchestrator/src/line-runtime.ts`).
`packages/orchestrator/src/lines.ts` is the registry of the lines a run can enable. M1
([m1-identity-memory.md](m1-identity-memory.md)), M2 ([graph.md](graph.md)) and M11
([models.md](models.md#the-line)) are built; a run that enables a line that is only planned stops
before it starts and says so.

## The lines

`LINE_ORDER` lists the lines in the order the plan builds and measures them (§7), which is not the
order of their numbers. The hooks of the enabled lines run in this order.

| Id | Adds | Package | State |
|---|---|---|---|
| `M1` | canonical identity and shared negative memory | `@seshat/memory` (the line is `packages/orchestrator/src/m1.ts`); the Lean identity will come from `@seshat/lean-meta` | built, with the text identity |
| `M10` | classical battery per subgoal before any model, domain router, ATP and SMT | `@seshat/classical` | planned |
| `M2` | variant graph and logical propagation, the prove/refute twin ([graph.md](graph.md)) | `@seshat/graph` | built, not run against Lean |
| `M11` | small models and fingerprints: certified refutations, candidate equivalences ([models.md](models.md#the-line)) | `@seshat/models` | built, not run against Lean |
| `M12` | saturation kernel: given-clause loop, subsumption, proved-modulo labels | `@seshat/scheduler` | planned |
| `M4` | context compiler | `@seshat/context` | planned |
| `M6` | guards against hallucination, and drift detectors | `@seshat/guards` ([guards.md](guards.md)) | built; the near-equivalence and declaration predicates are injected until the Lean meta tool |
| `fleet` | fleet policy: Thompson sampling on verdicts | `@seshat/fleet` ([fleet.md](fleet.md)) | built; a subgoal is the claim until a line gives sessions another |
| `M3` | growing lemma library | `@seshat/library` | planned |
| `M7` | abductive engine, with direct reranking by a model | `@seshat/abduction` | suspended ([below](#suspended-lines)) |
| `M8` | inductive engine | `@seshat/induction` | planned |
| `M13` | theory exploration and classical conjecturing | `@seshat/induction` | planned |
| `M14` | typed repairs and Lakatos-style repair | `@seshat/repair` | planned |
| `M5` | lessons with counters | `@seshat/lessons` | planned |
| `M9` | reranking from our own labels, without training | `@seshat/abduction` | suspended ([below](#suspended-lines)) |
| `M17` | extended environment: the run's Lean has more packages than the bench's ([lean-env.md](lean-env.md#line-m17-a-run-in-an-extended-environment)) | `@seshat/lean-env` | built, not run against Lean |

The packages of the lines not built yet exist as skeletons, with their dependencies in the lockfile.
`@seshat/lean-local` (the certifier on the host) is no line, and it is written
([certifier.md](certifier.md)).

### Suspended lines

`SUSPENDED_LINES` holds M7 and M9, the abductive engine (homology detection) and the reranking of
its candidates. They were suspended on 2026-10-20: semantic jumps found by deriving an expression
through the variant graph ([graph.md](graph.md)) do the same structural work, and more accurately in
practice. Their design stays in the plan, but they are not built: a run that enables one stops
before it starts and says the line is suspended, and the cumulative configs leave them out. The
direction noted instead, for when the core is ready, is problem reformulation (a sub-problem or
sub-expression, a more general or analogous problem, a problem in a higher dimension), toward one
native tool per major method of Pólya's *How to Solve It*.

### Cumulative configs

The plan's ablations are cumulative: each config adds one line to the one before, in §7's order.
`ablationLines(name)` gives the lines of a config: none for `M0`, and for a line, that line and
every line before it in `LINE_ORDER` but the [suspended](#suspended-lines) ones. `M1` is M0 + M1;
`M2` is M0 + M1 + M10 + M2; `M8` is every line up to M8 but M7. A suspended line stays in its own
config, so `--ablation M7` and `--ablation M9` stop and say why. `harness run --ablation M2` runs
that config, once all its lines are written: today it stops and names M10 as planned, and
`--lines M1,M2` runs the two that are built.

## A line

```ts
interface Line {
  id: LineId;                 // "M1", "M10", ... "fleet"
  title: string;
  requires: readonly LineId[];
  options?: JsonObject;       // the options and their defaults
  version?: string;           // recorded in run.started: change it when the line's behavior changes
  identity?: (env: { registry: Registry }) => StatementIdentity;  // how the run's memory names statements
  leanEnv?: (options: JsonObject) => string;  // the Lean environment the line puts the run in (M17)
  strategies?: readonly string[];  // the labels the line classifies attempts with
  resume?: LineResume;        // "stateless", "rebuild" or {refuse: reason}: how a run with the line is resumed
  hooks: LineHooks;
}
```

`identity` is called once per run, before anything is written, and gives the `StatementIdentity`
the run's memory names statements with ([memory.md](memory.md)); without an enabled line that gives
one, it is the text identity. When an enabled line gives `strategies`, `lean_check` takes an
optional `strategy` argument, one of the labels (the union, when several lines give some): the
model declares what it is trying, and the call's `SessionCheck.strategy` and the attempt's
`FinishedAttempt.declaredStrategy` carry the declaration. A run without such a line offers the
tool exactly as M0 does.

`leanEnv` names the Lean environment the run is in ([lean-env.md](lean-env.md#line-m17-a-run-in-an-extended-environment)),
from the line's options, in place of the host's `LEAN_ENV`. The run builds its registry for it, refuses
to start unless it is resolved, adds its packages' imports to the problem files, and records its name and
hash. `lineLeanEnv(enabledLines)` gives it, with the line that does.

A run checks its lines before anything is written, and refuses to start, with every problem named,
when an id is unknown or listed twice, a line is planned but not implemented, a line it requires is
not enabled, two lines give the context packet, the statement identity or the Lean environment, or an option is given
for a line that is not enabled, that the line does not have, or with another type than its default
(`resolveLines`). An option whose default is `null` means "not set": it has no type, and takes any
JSON value.
`run.started` records the enabled lines in `LINE_ORDER`, each with its options and version; a run
without lines records no `lines` key at all, as M0 always did.

### Resuming a run with lines

A run that its process did not finish can be resumed (`harness run --resume DIR`,
[ledger.md](ledger.md#resume)). The resumed run is a new process: whatever a line kept in memory is
gone, and the journal gives back only what was written to it. So a line says what it does about that,
in `resume`:

- `"stateless"`: whatever the line knows when a hook runs, it reads from the journal, the memory or
  the ledger (`problem.memory`, `problem.tasks`), or it is its options, so that a hook called in the
  resumed process does what it would have done in the first. A problem that the interruption cut
  gets the line's `beforeProvers` again if the cut came before its provers started, and its
  `afterProblem` again if it had not ended; those two hooks must be safe to call twice for one
  problem. The hooks a session calls (`beforeSession`, `briefing`, `afterAttempt`...) run for the
  sessions the resumed prover starts, as they would have.
- `"rebuild"`: the line keeps state in the process, and has the hook `resumeProblem`, which rebuilds
  it for a problem from the journal and the memory. The state is written down as the line goes
  (typically as nodes of its own kind), and `resumeProblem(problem, held)` reads it back. In a
  resumed process the harness calls it where it would have called `beforeProvers`, for every problem
  the process works on: one that was begun, and one that was not, which the line then starts as
  `beforeProvers` would. `held` (`ResumedProblem`) is what the journal holds of the problem: whether
  it was `begun` (a prover had started), its `attempts` (id, prover, session, claim, and whether the
  interruption cut it), the provers that had `endedProvers`, the model calls charged by site
  (`modelCalls`), and the claims the problem `workedClaims`. A line with `rebuild` and no hook is
  refused, as is one that says nothing. `beforeProvers` is not called for it in a resumed process.
- `{refuse: reason}`: the line keeps state that the journal cannot give back. A run with the line is
  not resumed: `harness run --resume` stops before it writes anything, and names the line and the
  reason.
- Absent: the same as a refusal. The harness cannot tell what a line keeps, so a line that does not
  say is not resumed with.

A resume compares each line's `version` with the run's record and refuses another. Writing new kinds of
nodes is a change of version: M2 is `m2-2` and M6 `m6-2` (they began to write the nodes they rebuild from), M11 is
`2` (its `beforeProvers` became safe to run twice), the fleet stays `fleet-1`. A run begun before a bump cannot be
resumed after it.

Today M1 and M11 are `stateless` (everything they know they read from the memory; M11's `beforeProvers` skips what the
memory shows done), and M2, M6 and the fleet
rebuild: M2's work on a problem (the twin, its short names, the proofs tried, the refutation side
that runs alongside the provers), M6's detector counts and pending notices, and the fleet's width
gate and sticky strategies are read back from nodes the lines wrote as they went
([graph.md](graph.md#resuming), [guards.md](guards.md#resuming), [fleet.md](fleet.md#resuming)).
`LineResume`, `ResumedProblem` and the hook are additive to the line API: a line that declares
`"stateless"` or a refusal is unchanged.

## The hooks

Every hook is optional and async. They run in `LINE_ORDER`, at these points:

| Hook | When | What it may do |
|---|---|---|
| `beforeProvers(problem)` | Once per problem, after its reference type is known, before any prover starts. | Submit proofs or refutations through `validate`, add claims, edges and nodes, or settle the problem. Once a proof of the problem's claim passes, the remaining lines' `beforeProvers` and the provers do not run. |
| `beforeSession(session)` | Before each session, before its attempt is recorded. | Change the session's model, declare its strategy or subgoal (recorded on `attempt.started`), skip the session, or stop the prover. A later line's model, strategy or subgoal wins; the first `skip` or `stop` is taken. |
| `briefing(session)` | Before each session, after `beforeSession`. | Give a titled section for the session's opening message, after the notes, the file and the last check. |
| `tools(session)` | Before each session. | Give the prover extra tools, as neutral specs (name, description, JSON schema of the arguments, `run(args, signal)` returning text) that the orchestrator adapts to pi tools. A failing call goes back to the model as a tool error. Names are lowercase letters, digits and `_`, and may not clash. |
| `contextPacket(session, request)` | Before each model request of a session, the first one and the wrap-up included. | Return the whole context of the request (M4): it replaces every message after the system prompt and the tool declarations. Undefined leaves the request as it is. At most one enabled line may give this hook. |
| `beforeCheck(session, proposal)` | Before each `lean_check` runs. | Reject the call, with a reason the model reads as a tool error. The file is not sent to Lean, and the call is no check: no validation, not counted, its declared strategy not recorded. The first line in this order that rejects is taken. It guards the prover's calls only: certification is no `lean_check`, and no hook sees it ([m0-loop.md](m0-loop.md#certification)). |
| `afterCheck(session, check)` | After each `lean_check` of a session. | Stop the session with a reason (a drift detector). The attempt ends with `stoppedBy: "line:<id>"`, and the model is not asked for notes. A check that makes the candidate still ends the session as `solved`. |
| `reviewBriefing(session, sections)` | After the lines' `briefing`, before the session starts. | Drop or reword the sections the session gets (keep the title), never add, replace or reorder one: every title returned must be one it was given, in the same order, or the line has failed. Each line gets the list as the lines before it left it; undefined keeps it. |
| `afterAttempt(problem, attempt)` | After each session, before `attempt.finished`. | Return the attempt's classified strategy, the premises its proof uses, a typed summary of its failure, and the notes the prover's next session starts from: they go into `attempt.finished` (the notes into the prover), a later line's fields winning. The journal keeps the notes the model wrote; an empty string leaves the next session with none. Not called for a session the harness failed. |
| `afterProver(problem, end)` | After a prover has ended: its sessions are used, it solved the problem, it ran out of budget, was stopped, kept failing, or a line stopped it. | Learn how it ended (`end.stop`). Not called when the harness failed in the prover, which ends the problem. |
| `afterProblem(problem, end)` | After the provers, before `problem.finished`, for every problem whose `beforeProvers` point was reached. | Record what the problem taught. Its signal is the run's, not the problem's, which is aborted once the problem is solved. The problem's own candidate is certified before it, and what this problem's lines submitted ([`validate`](#validate)) is certified after it; so the `outcome` it is told is the problem's own so far: `proved` when its own candidate was certified, never `refuted` (a line's refutation is certified after the hook), and never `proved` because another problem proved a claim they share. |

A hook that throws is a failure of the harness, named after the line and the hook (`line M6 failed
in afterCheck: ...`). In `beforeProvers` or `afterProblem`, the problem ends as `error`, except that
a proof already found stays found (`candidate` or `proved`, with the failure in the reason, as when
certification fails). For `afterProblem` that includes a refutation of the problem's claim that its
lines submitted and that was certified after the hook failed: the problem ends `refuted`. In
`beforeSession`, `briefing`, `reviewBriefing`, `tools`, `afterAttempt` or `afterProver`, the prover
stops, the problem's other provers with it, and the problem ends as `error` unless a proof was
found. In `contextPacket`, `beforeCheck` or `afterCheck`, the session ends with an error, and the
prover goes on as after any failed session.

## What a hook gets

The problem's context (`ProblemContext`):

| Field | What it is |
|---|---|
| `line`, `runId`, `problemId`, `claimId` | Who and where. `claimId` is the problem's claim: in a run with lines it is the memory's claim for the problem's statement, which another problem with the same statement shares. |
| `target` | The theorem: its full name, its statement in signature form, the problem's file and its sketch. |
| `domain` | The problem's domains, such as `msc:11`. |
| `memory` | The run's `MemoryStore` ([memory.md](memory.md)), writing as `line:<id>`. A line never touches the journal: its store has no access to it. |
| `registry` | The run's capability registry. Calls through it are tool runs in the journal; pass `actor: "line:<id>"`, and the attempt inside a session. |
| `llm` | One-shot model calls, without tools: `complete({system?, prompt, maxTokens?, model?, site?})` returns the text, its cost, the model and the call's id; `completeJson(problem.llm, {..., schema})` returns an answer checked against a schema ([below](#llm)). |
| `validate` | Submits a Lean proof of a claim, or of its negation, through the validator. |
| `budget` | The problem's budget as it stands: its limit, what was spent, whether it is exhausted. |
| `tasks` | The problem's task ledger ([ledger.md](ledger.md)): its tasks, read-only, and a way to propose more ([below](#tasks)). |
| `log` | A line of the run's progress log, prefixed with the problem and the line. |
| `signal` | Aborted when the problem ends: solved, out of budget, or the run stopped. |
| `options` | The line's options: its defaults with the run's values over them. |

A session's context (`SessionContext`) adds the prover, the session's number and the most it may
have, its attempt id (recorded only after `beforeSession`; a skipped session's id is never
recorded), its model, the prover's regions as the session starts, and the strategy and subgoal
`beforeSession` declared. The model's own declaration, through `lean_check`'s `strategy` argument,
is on each `SessionCheck` and, for its last one, on the `FinishedAttempt`.

### Claims a line states

`memory.ensureClaim` takes a statement in signature form (the binders, then `:` and the type; a
bare proposition is refused, [memory.md](memory.md#statement-form)). A claim about the problem's
own definitions (a variant, a subgoal, a negation) takes the problem sketch's prefix as its
header, so that the names the problem defines resolve in its reference file
([memory.md](memory.md#claims-about-the-problems-own-definitions)):

```ts
problem.memory.ensureClaim({ statement: "(n : ℕ) : 2 ∣ n → P n", header: problem.target.sketch.prefix, parentId: problem.claimId, origin: "line:M2" })
```

### `llm`

Each call is charged to the problem's ledger, so a line spends the same budget as the provers,
and is recorded as `model_call.finished` from `line:<id>`, with the request and the response kept
as blobs (`requestHash`, `responseHash`) and the call's cost and tokens. A call fails when the
problem has ended, when its budget is spent, or when the model answers with an error (the failed
call is recorded too). The model defaults to the run's, with the run's thinking level.

**Site.** Give every call a `site`, a short dotted name for where in the harness it is made:
`graph.attempt`, `abduction.rerank`, `conjecture.relevance`, `fidelity.review`. It is recorded on
the call's `model_call.finished`, and the report adds the spend up by site, so that one can see
what share of the budget each place takes ([ledger.md](ledger.md#sites)). A call without a site is
recorded as `<line>.unlabeled` (`m2.unlabeled`); a site that is not made of dotted lowercase words
is refused before the call is paid for. The provers' sessions are the site `prover.session`.

**`completeJson`.** `completeJson<T>(problem.llm, {system?, prompt, schema, site?, ...})` is for every
one-shot call whose answer a program reads. `schema` is a `JsonSchema` of `@seshat/registry`, the subset
manifests use; the call adds it to the prompt, so the prompt describes the content and not the
format. The answer is read as JSON (bare, in a code fence, or the outermost object or array of a
text), and checked. When it is not JSON or does not match, the model is asked once more with its
refused answer and what was wrong. A second failure rejects with a `JsonAnswerError`: the problems
of each answer, the two calls' ids and the last text. The retry is a call like the first: it is
charged to the problem's budget and recorded as its own `model_call.finished`, with the same site.
A call that fails (the budget is spent, the model errs) is not retried. The result has the
checked `value`, the text, the cost of every call made, and the ids of the calls (`modelCallIds`).
`completeJson` is a function exported by `@seshat/lines`, not a method a line has to find on its
`Llm`: the member `Llm.completeJson` is optional, so that an `Llm` written before it existed (a test
double, a wrapper) is still an `Llm`. The function uses the member when the `Llm` has one and
`withJson(llm.complete)` when it has not, so the same single retry applies either way. The `Llm` of a
line's context has the member. `withJson(complete)` builds an `Llm` from a plain `complete`, for the
orchestrator and for tests.

### `tasks`

The ledger holds the work of a problem as tasks ([ledger.md](ledger.md)): the provers' own, and
the ones lines ask for. A line reads it and proposes; it never writes it. Only the orchestrator
appends task events, and the journal refuses them from anyone else.

| Method | What it gives |
|---|---|
| `list({statuses?, kinds?, claimId?, owner?})` | The problem's tasks, in the order they were made, as `TaskInfo`: id, kind, status, the reason of its last move, owner, claim or edge, dependencies, acceptance criterion, budget, parent, proposer, title, what it waits for. |
| `get(taskId)` | One task of the problem, or `undefined`. A task of another problem is not shown. |
| `ready()` | The tasks that may start now: `ready`, owned or not. |
| `routings(taskId?)` | The routing decisions about a task, or about the problem's tasks ([ledger.md](ledger.md#routing-decisions)). |
| `propose(task)` | Asks for a task. Returns `{accepted: true, taskId}` or `{accepted: false, reason}`. |

A proposal is `{kind, claimId?, edgeId?, dependsOn?, acceptance, budget?, parentTaskId?, title?}`.
It names neither a status nor an owner; if a line sends them, they are not read. The orchestrator
makes the task the problem's, `pending`, proposed by `line:<id>` and owned by it, and moves it to
`ready` when what it depends on is `done`. It refuses, with a reason and without writing
anything, a dependency or a parent that is not a task of the problem, a claim or an edge that does
not exist, a criterion of the wrong shape, a budget that is not made of non-negative numbers, and
the two hundred and first task a problem is proposed. A proposal that names no claim and no edge is
about the problem's claim. Running a proposed task, and choosing among the `ready` ones, belong to
the lines that schedule work (M12) and to the fleet; a task that nobody runs is `cancelled` when the
problem ends.

### `validate`

`validate({claimId, proof, aux?, negation?, attemptId?})` is the only way a line raises a claim's
status, and it goes through the same validator as the provers' checks. The rule holds by
construction: a line's store has no method that raises a status, and the journal makes a claim
`computed` only with a valid validation of that claim, and `proved` or `refuted` only with a
certified one ([trust.md](trust.md#the-journal-enforces-it)). `validate` itself reaches the fast
check at most: the certification of what it recorded comes when the problem ends
([m0-loop.md](m0-loop.md#certification)), so a result says `computed` and never `proved`.

A line has one other way to change a status, and it only lowers it: `memory.retractClaim(claimId,
{reason})` takes back a claim whose status rested on something that was withdrawn. It is the single
named exception, and its limits are in the store, not in the line's good conduct. It chooses the
lower status itself, among the revocation transitions of the status table
([trust.md](trust.md#claim-statuses)): a `computed` claim goes back to `open`, a `proved`, `refuted`
or `proved_informal` one becomes `retracted`, and an `open` or `retracted` one stays as it is, so it
raises none and does not reopen a retracted claim. It refuses a blank reason, and the journal
records the change as written by `line:<id>`. M2 is its only caller, to withdraw a claim that held
only through a composed proof whose premises are gone ([graph.md](graph.md#composed-proofs)).

- A proof of the problem's claim goes to the problem's workbench, as a prover's would: a valid one
  makes the claim `computed`, becomes the problem's candidate, and ends the problem's search.
- Any other claim, and any negation, gets a workbench of its own, built on first use from the
  claim's reference file (`MemoryStore.referenceFor`) and kept for the run. A valid proof makes
  that claim `computed`, and the certifier makes it `proved` when the problem's lines are done.
  The first valid proof of the claim is its candidate, whichever problem's line sent it, and that
  problem certifies it; a later valid proof from another problem is recorded as a validation and is
  nobody's candidate. A reference file that does not compile makes every submission for it invalid,
  with the reason; one Lean did not answer for is tried again next time. A line cannot change that file: the claim's reference
  is the problem's own file or the one rebuilt from its journaled statement and header
  ([memory.md](memory.md#reference-files)).
- A valid proof of the negation is recorded as a validation with `negation: true` and changes no
  status when it is submitted. When the problem's lines are done it is certified, and a certified
  one makes the claim `refuted` ([trust.md](trust.md)); for the problem's own claim that is also
  what ends the problem as `refuted`. The first valid proof of each claim, and of each negation,
  is the one certified in a run (the problem's own claim has the problem's workbench, and its first
  valid proof is the problem's candidate).
- A file with holes is not a validation, as for the provers. An informal claim cannot be
  validated.

The result gives the verdict, the `validation.finished` id when the check was recorded, the claim's
status after the check, the reasons, and the validator's report.

## Adding a line

A task that implements a line:

1. Writes it in the line's package (the table above), which already depends on `@seshat/core`,
   `@seshat/memory`, `@seshat/lines` and `@seshat/registry`. `@seshat/memory` cannot depend on
   `@seshat/lines`, which depends on it: M1 keeps its logic in the memory and its `Line` object in
   the orchestrator.
2. Registers it in `packages/orchestrator/src/lines.ts`.
3. Records what it learns as events through the `MemoryStore`: claims, edges, and nodes of its own
   kinds, whose `data` shape its package owns ([memory.md](memory.md#nodes)).
4. Says how a run with it is resumed (`resume`, [above](#resuming-a-run-with-lines)): `"stateless"`
   when everything it knows it reads from the journal, the memory or the ledger, `"rebuild"` with a
   `resumeProblem` hook when it keeps state in the process that it can write down as it goes, a
   refusal with the reason otherwise. A line that says nothing is refused.
5. Tests it with a run of the simulated model and Lean (`demoRun` in
   `packages/orchestrator/test/m0-helpers.ts` takes a line registry), and documents it on its own
   page, linked from [README.md](README.md).

A line needs a change to the API only when no hook fits; the change keeps the existing lines
working and updates this page in the same commit.

## Measured

The report lists the enabled lines, and the lines' model calls by outcome and by line; their cost
is in the run's total. With M1 it also gives the share of redundant attempts
([m1-identity-memory.md](m1-identity-memory.md#redundant-attempts)). `harness run --ablation NAME` runs one cumulative config; comparing two
configs on the same problems and budget is the plan's measure of a line.

## Tested, and not yet

`packages/lines/test/lines.test.ts` covers the order, the cumulative configs and the checks of a
run's lines. `packages/orchestrator/test/lines.test.ts` runs fake lines registered in the test
with the simulated model and Lean: the hooks called at their points in `LINE_ORDER`, with a
briefing, a line's tool called by the model, the strategy and the annotation merged into the
attempt; a run with no line that records nothing of the lines; a problem settled in
`beforeProvers` through `validate` (an invalid proof, a refutation that changes no status, a valid
proof of another claim and of the problem's), with the provers left idle; unknown, planned and
unmet lines refused before anything is written; a failing hook; sessions skipped and stopped; a
line's model call charged to the problem; the context packet of each request, and its failure.
`packages/orchestrator/test/line-gates.test.ts` covers `beforeCheck` (a rejected call is no check),
`reviewBriefing`, the notes a line gives and `afterProver`. `cli.test.ts` covers `--lines`, `--ablation` and `--line-option`. `packages/lines/test/lines.test.ts`
also checks that only one line gives the statement identity or the Lean environment, and
`packages/orchestrator/test/m17.test.ts` runs M17 in whole runs ([lean-env.md](lean-env.md#line-m17-a-run-in-an-extended-environment)), and
`packages/orchestrator/test/m1.test.ts` runs the real M1 ([m1-identity-memory.md](m1-identity-memory.md#tested-and-not-yet)).
`m6.test.ts` and `fleet.test.ts` there run M6 and the fleet in whole runs ([guards.md](guards.md#tests-and-what-is-not-done),
[fleet.md](fleet.md#tests-and-what-is-not-done)). `resumeRefusals` is tested in
`packages/lines/test/lines.test.ts`, and `packages/orchestrator/test/resume.test.ts` checks the
position each real line takes on resuming, and `resume-lines.test.ts` resumes whole runs of the fleet,
M6 and M2 at each boundary between sessions and at every event of their journals, and one run of
M1, M2, M6 and the fleet together at every event.

M1, M2, M11, M6 and the fleet are the lines built. M2 has its own tests
([graph.md](graph.md#tested-and-not-yet)). `packages/orchestrator/test/m11.test.ts` runs M11 in
`runBench` with the simulated model and Lean, a refutation through `validate` and a node and edge of
each kind it writes included ([models.md](models.md#the-line)). Nothing here has run against a real
model or Lean.
