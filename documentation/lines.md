# Lines

The plan measures each mechanism as an ablation line (plan §6): a run with the line switched on
against a run without it, at equal budget, on the same problems. In the code, a mechanism is a
*line*: an object with an id, the lines it needs, and hooks that the orchestrator calls at fixed
points of a run. A run enables lines with `harness run --lines` or `--ablation`; with none, it is
exactly M0 ([m0-loop.md](m0-loop.md)).

The API is in `@seshat/lines`; the orchestrator runs it (`packages/orchestrator/src/line-runtime.ts`).
No line is implemented yet: `packages/orchestrator/src/lines.ts`, the registry of the lines a run
can enable, is empty, and a run that enables a line stops before it starts and says that the line
is planned.

## The lines

`LINE_ORDER` lists the lines in the order the plan builds and measures them (§7), which is not the
order of their numbers. The hooks of the enabled lines run in this order.

| Id | Adds | Package |
|---|---|---|
| `M1` | canonical identity and shared negative memory | `@seshat/memory`, `@seshat/lean-meta` |
| `M10` | classical battery per subgoal before any model, domain router, ATP and SMT | `@seshat/classical` |
| `M2` | variant graph and logical propagation | `@seshat/graph` |
| `M11` | small models and fingerprints: certified refutations, candidate equivalences | `@seshat/models` |
| `M12` | saturation kernel: given-clause loop, subsumption, proved-modulo labels | `@seshat/scheduler` |
| `M4` | context compiler | `@seshat/context` |
| `M6` | guards against hallucination, and drift detectors | `@seshat/guards` |
| `fleet` | fleet policy: Thompson sampling on verdicts | `@seshat/fleet` |
| `M3` | growing lemma library | `@seshat/library` |
| `M7` | abductive engine, with direct reranking by a model | `@seshat/abduction` |
| `M8` | inductive engine | `@seshat/induction` |
| `M13` | theory exploration and classical conjecturing | `@seshat/induction` |
| `M14` | typed repairs and Lakatos-style repair | `@seshat/repair` |
| `M5` | lessons with counters | `@seshat/lessons` |
| `M9` | reranking from our own labels, without training | `@seshat/abduction` |

The packages exist as skeletons, with their dependencies in the lockfile; `@seshat/lean-local`
(the certifier on the host) is the fourteenth.

### Cumulative configs

The plan's ablations are cumulative: each config adds one line to the one before, in §7's order.
`ablationLines(name)` gives the lines of a config: none for `M0`, and for a line, that line and
every line before it in `LINE_ORDER`. `M1` is M0 + M1; `M2` is M0 + M1 + M10 + M2; `M9` enables
every line. `harness run --ablation M2` runs that config.

## A line

```ts
interface Line {
  id: LineId;                 // "M1", "M10", ... "fleet"
  title: string;
  requires: readonly LineId[];
  options?: JsonObject;       // the options and their defaults
  version?: string;           // recorded in run.started: change it when the line's behavior changes
  hooks: LineHooks;
}
```

A run checks its lines before anything is written, and refuses to start, with every problem named,
when an id is unknown or listed twice, a line is planned but not implemented, a line it requires is
not enabled, two lines give the context packet, or an option is given for a line that is not
enabled, that the line does not have, or with another type than its default (`resolveLines`).
`run.started` records the enabled lines in `LINE_ORDER`, each with its options and version; a run
without lines records no `lines` key at all, as M0 always did.

## The hooks

Every hook is optional and async. They run in `LINE_ORDER`, at these points:

| Hook | When | What it may do |
|---|---|---|
| `beforeProvers(problem)` | Once per problem, after its reference type is known, before any prover starts. | Submit proofs or refutations through `validate`, add claims, edges and nodes, or settle the problem. Once a proof of the problem's claim passes, the remaining lines' `beforeProvers` and the provers do not run. |
| `beforeSession(session)` | Before each session, before its attempt is recorded. | Change the session's model, declare its strategy or subgoal (recorded on `attempt.started`), skip the session, or stop the prover. A later line's model, strategy or subgoal wins; the first `skip` or `stop` is taken. |
| `briefing(session)` | Before each session, after `beforeSession`. | Give a titled section for the session's opening message, after the notes, the file and the last check. |
| `tools(session)` | Before each session. | Give the prover extra tools, as neutral specs (name, description, JSON schema of the arguments, `run(args, signal)` returning text) that the orchestrator adapts to pi tools. A failing call goes back to the model as a tool error. Names are lowercase letters, digits and `_`, and may not clash. |
| `contextPacket(session, request)` | Before each model request of a session, the first one and the wrap-up included. | Return the whole context of the request (M4): it replaces every message after the system prompt and the tool declarations. Undefined leaves the request as it is. At most one enabled line may give this hook. |
| `afterCheck(session, check)` | After each `lean_check` of a session. | Stop the session with a reason (a drift detector). The attempt ends with `stoppedBy: "line:<id>"`, and the model is not asked for notes. A check that makes the candidate still ends the session as `solved`. |
| `afterAttempt(problem, attempt)` | After each session, before `attempt.finished`. | Return the attempt's classified strategy, the premises its proof uses, and a typed summary of its failure: they go into `attempt.finished`, a later line's fields winning. Not called for a session the harness failed. |
| `afterProblem(problem, end)` | After the provers, before `problem.finished`, for every problem whose `beforeProvers` point was reached. | Record what the problem taught. Its signal is the run's, not the problem's, which is aborted once the problem is solved. |

A hook that throws is a failure of the harness, named after the line and the hook (`line M6 failed
in afterCheck: ...`). In `beforeProvers` or `afterProblem`, the problem ends as `error`, except that
a proof already found stays found (`candidate` or `proved`, with the failure in the reason, as when
certification fails). In `beforeSession`, `briefing`, `tools` or `afterAttempt`, the prover stops,
the problem's other provers with it, and the problem ends as `error` unless a proof was found. In
`contextPacket` or `afterCheck`, the session ends with an error, and the prover goes on as after any
failed session.

## What a hook gets

The problem's context (`ProblemContext`):

| Field | What it is |
|---|---|
| `line`, `runId`, `problemId`, `claimId` | Who and where. `claimId` is the problem's claim. |
| `target` | The theorem: its full name, its statement in signature form, the problem's file and its sketch. |
| `domain` | The problem's domains, such as `msc:11`. |
| `memory` | The run's `MemoryStore` ([memory.md](memory.md)), writing as `line:<id>`. |
| `registry` | The run's capability registry. Calls through it are tool runs in the journal; pass `actor: "line:<id>"`, and the attempt inside a session. |
| `llm` | One-shot model calls, without tools: `complete({system?, prompt, maxTokens?, model?})` returns the text, its cost, the model and the call's id. |
| `validate` | Submits a Lean proof of a claim, or of its negation, through the validator. |
| `budget` | The problem's budget as it stands: its limit, what was spent, whether it is exhausted. |
| `log` | A line of the run's progress log, prefixed with the problem and the line. |
| `signal` | Aborted when the problem ends: solved, out of budget, or the run stopped. |
| `options` | The line's options: its defaults with the run's values over them. |

A session's context (`SessionContext`) adds the prover, the session's number and the most it may
have, its attempt id (recorded only after `beforeSession`; a skipped session's id is never
recorded), its model, the prover's regions as the session starts, and the declared strategy and
subgoal.

### `llm`

Each call is charged to the problem's ledger, so a line spends the same budget as the provers,
and is recorded as `model_call.finished` from `line:<id>`, with the request and the response kept
as blobs (`requestHash`, `responseHash`) and the call's cost and tokens. A call fails when the
problem has ended, when its budget is spent, or when the model answers with an error (the failed
call is recorded too). The model defaults to the run's, with the run's thinking level.

### `validate`

`validate({claimId, proof, aux?, negation?, attemptId?})` is the only way a line changes a claim's
status, and it goes through the same validator as the provers' checks:

- A proof of the problem's claim goes to the problem's workbench, as a prover's would: a valid one
  makes the claim `computed`, becomes the problem's candidate, and ends the problem's search.
- Any other claim, and any negation, gets a workbench of its own, built on first use from the
  claim's reference file (`MemoryStore.referenceFor`) and kept for the run. A valid proof makes
  that claim `computed`. A reference file that does not compile makes every submission for it
  invalid, with the reason; one Lean did not answer for is tried again next time.
- A valid proof of the negation is recorded as a validation with `negation: true` and changes no
  status: only certification makes a claim `refuted` ([trust.md](trust.md)), and it is not wired
  for refutations yet.
- A file with holes is not a validation, as for the provers. An informal claim cannot be
  validated.

The result gives the verdict, the `validation.finished` id when the check was recorded, the claim's
status after the check, the reasons, and the validator's report.

## Adding a line

A task that implements a line:

1. Writes it in the line's package (the table above), which already depends on `@seshat/core`,
   `@seshat/memory`, `@seshat/lines` and `@seshat/registry`.
2. Registers it in `packages/orchestrator/src/lines.ts`.
3. Records what it learns as events through the `MemoryStore`: claims, edges, and nodes of its own
   kinds, whose `data` shape its package owns ([memory.md](memory.md#nodes)).
4. Tests it with a run of the simulated model and Lean (`demoRun` in
   `packages/orchestrator/test/m0-helpers.ts` takes a line registry), and documents it on its own
   page, linked from [README.md](README.md).

A line needs a change to the API only when no hook fits; the change keeps the existing lines
working and updates this page in the same commit.

## Measured

The report lists the enabled lines, and the lines' model calls by outcome and by line; their cost
is in the run's total. `harness run --ablation NAME` runs one cumulative config; comparing two
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
`cli.test.ts` covers `--lines`, `--ablation` and `--line-option`.

No real line exists yet, and nothing here has run against a real model or Lean.
