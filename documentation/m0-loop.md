# The M0 loop

M0 is the baseline that every later mechanism has to beat at equal budget: agent (A) of
AlphaProof Nexus, rebuilt on pi. For each problem, independent provers work on a Lean sketch of
the theorem, each in a Ralph loop: a session is a fresh model context, and only the file as the
prover left it and its notes go from one session to the next. Provers share nothing else. The
first proof that passes the fast check makes the claim a candidate and stops the problem's other
provers; the certifier then decides whether the claim is `proved` ([certifier.md](certifier.md)).

The code is in `packages/orchestrator/src`:

| Module | Role |
|---|---|
| `run.ts` | `runBench`: a run over a list of bench problems, its configuration and the problems' outcomes; `resumeBench`: the continuation of a run whose process ended. |
| `resume.ts` | What a resumed run reads from its journal and takes up: the recorded run and its compatibility checks, the problems that were cut, the candidate and the provers' carry ([ledger.md](ledger.md#resume)). |
| `problem.ts` | `loadProblem`, and the `Workbench`: the sketch, the checks, the candidate and its certification, for one claim or its negation. |
| `prover.ts` | `runProver`: one prover's loop of sessions. |
| `prover-tasks.ts` | The ledger's tasks of M0: one `prove` task per prover, and how each ends ([ledger.md](ledger.md#what-m0-records)). |
| `session.ts` | `runSession`: one pi agent with the `lean_check` tool and the run's other tools, and its limits. |
| `tools.ts` | The other tools: `direct` capabilities as tools of a session, and their bindings (`lean.lsp`). |
| `prompt.ts` | The prompts, versioned. |
| `feedback.ts` | What a check says to the prover, and the failure class of a check. |
| `budget.ts` | Ledgers of dollars and tokens. |
| `report.ts` | The report of a run, built from its journal alone. |
| `cli.ts` | `harness models`, `harness run` (and `harness run --resume`), `harness report`, with the other commands. |
| `lines.ts` | The lines a run can enable, by id; none is implemented yet ([lines.md](lines.md)). |
| `line-runtime.ts` | The enabled lines of a run: their contexts, and their hooks at each point of a problem, a prover and a session. |
| `llm.ts` | The lines' one-shot model calls, charged and recorded. |
| `validate.ts` | The lines' `validate`: proofs of any claim, or of its negation, through the validator; and the certification of what they submitted. |

## A run

`runBench(options)`:

1. Checks the configuration and the lines it enables ([lines.md](lines.md)), finds the model and
   its provider's credentials, and refuses a run directory that already holds a journal. It builds the host's registry, then checks the tools
   given with `--tool` and pins each to an implementation that answers
   ([other tools](#other-tools)). A failure here is a `RunSetupError`: no event is written, and a
   directory created for the run is removed.
2. Opens the journal and the blob store, writes `config.json` and records `run.started`. The
   configuration recorded there fixes what the run does: how the problems were chosen and the hash
   of their list, the model and its thinking level, the provers, sessions, limits, notes length,
   budgets and concurrency, the other tools with their implementations and versions, the bench's
   hash and source, the registry's hash (manifests and host profile), the prompts' version and
   hash, the validation policy, the certifier (`RunOptions.certifier`, or else the host's
   `lean.certify`, if its profile lists one; the run logs which, or that there is none, and when the
   host's cannot be made at all, such as without a sandbox command, logs that it is unavailable and
   records the reason as `certifierUnavailable`), the code
   revision, and the enabled lines with their
   options (only when there are some, so that an M0 run records what it always did).
3. Works on the problems in order, `concurrency` at a time.
4. Records `run.finished`, then writes `report.md` and `report.json`.

The run stops before its last problem when it is aborted (`aborted`), when its budget runs out
(`budget_exhausted`), when Lean cannot be reached (`lean_unavailable`), or after three problems in
a row ended with a harness error (`errors`). The reason is in `run.finished`.

A run whose process ended without a `run.finished` (a kill, a crash, a usage limit) is continued by
`resumeBench`, from its journal and the run directory alone: it checks that what resumes is what
began the run, writes `run.resumed`, closes the sessions, tool runs and tasks that the process left
open, starts its budgets from what the journal says was spent, takes up the problems that were cut
where they stood (the candidate they had found, a certification that was recorded, each prover's
file, last check and notes), and then runs the problems that had not begun. What it refuses, what
it does with a certification that was cut, and what it does not restore are in
[ledger.md](ledger.md#resume).

## A problem

1. Records `claim.created` (status `open`) and `problem.registered`.
2. Reads the file from the checkout in plain-header form, checks it against the bench index, and
   cuts it into a sketch ([validator.md](validator.md#sketches)).
3. Checks the original file once, for the reference type of the statement.
4. Makes one `prove` task per prover in the task ledger ([ledger.md](ledger.md#what-m0-records)), then starts the provers in parallel, each starting its task. They share the problem's `Workbench` and its budget. A prover's task ends with the prover.
5. When a prover finds a candidate, writes its file to `proofs/` and, if there is a certifier,
   certifies it ([below](#certification)).
6. With lines, runs their `afterProblem`, then certifies what they submitted for other claims or
   for negations ([below](#certification)).
7. Cancels the tasks of the problem that have not ended, and records `problem.finished`: outcome, reason, attempts, cost and time.

| Outcome | When |
|---|---|
| `proved` | A certified proof settled the claim, which is `proved`: the problem's own candidate (a prover's, or a line's proof of the problem's claim). A claim that another problem proved does not make a problem `proved`, even when the two share the claim: the problem needs a certification of its own. |
| `refuted` | A certified proof of the negation, submitted by the problem's own lines, settled the claim, which is `refuted`. A prover never does this, since it works on the statement; a line that proves negations can (M2's twin, [graph.md](graph.md#the-twin)). A claim that another problem refuted does not make a problem `refuted`. |
| `candidate` | A proof passed the fast check, and the claim is not settled: there is no certifier, or it gave no answer (the time limit, a stop, no Lean project to run in, a Lean environment in which not even the reference compiles, a host profile with no sandbox for the certifier). The claim is `computed`, and the reason says why the certifier gave none. |
| `unsolved` | The budget ran out, every prover used its sessions, or the certifier rejected the candidate: the kernel refused a proof that the fast check accepted, so the problem has none. The claim stays `computed` and the reasons are in the `kernel_replay` validation. |
| `skipped` | The problem could not be set up: its file differs from the index, it cannot be cut into a sketch, or the original does not compile. |
| `aborted` | The run was stopped. |
| `error` | Lean could not be reached for the reference check, every prover kept failing, the harness failed, or a certified proof or refutation of the problem's claim contradicted the claim's status (a proof of a refuted claim, a refutation of a proved one). |

### Certification

A certifier answers a call with `certified` or `rejected`, or with no answer at all
([certifier.md](certifier.md#what-it-answers)). The run records the answer as a `kernel_replay`
validation of the claim, with `negation: true` for a refutation, and acts on it:

- `certified`: the claim becomes `proved` (a proof) or `refuted` (a proof of the negation), if it
  is still `open`, `computed` or `proved_informal`. A claim that another problem with the same
  statement has settled the same way keeps its status: the validation is recorded and nothing
  changes. A claim that was settled the other way is a contradiction (a proof of a refuted claim, or
  a refutation of a proved one): the validation stays as evidence and the status does not move. The
  problem that submitted it ends as `error` when the claim is its own, whether it was its provers'
  candidate or a refutation of its claim that its lines submitted, and the reason says so. When the
  claim is another one that its lines submitted a proof or a refutation for, the problem's outcome
  stands, the run's log says so and the reason notes it.
- `rejected`: nothing changes. The claim stays `computed` and the validation, which is `invalid`,
  holds the reasons. Nothing in the harness lowers a claim's status but `retractClaim`
  ([memory.md](memory.md#claims)), so a rejection does not send it back to `open`.
- no answer: no validation is recorded (it would say nothing about the proof) and the claim stays
  `computed`. The failure is the problem's reason when it was the problem's own candidate, and a
  line of the run's log otherwise. The registry's tool run of `lean.certify` records the call and
  how it ended.

A candidate is certified once in a run, whatever came of it, and a workbench keeps its first
candidate: the problem's own, and one for each other claim and each negation that lines submit
proofs for. If the certifier rejects a line's proof of a claim, its later proofs of that claim are
not certified in the run, so a line cannot make the run pay for one certification after another.
In a run that was resumed, the journal records one certification per candidate: the answer of one
that was recorded is used, and a call the interruption cut is made again ([ledger.md](ledger.md#certification)).
The problem whose submission made a candidate is the one that certifies it, when its own lines are
done: a problem's end does not certify what the lines of another problem, still working, have
submitted, and the time it takes is charged to the problem that submitted it.

What is certified, and when, for a problem:

1. The problem's own candidate, as soon as the provers are done, so that the lines'
   `afterProblem` see the claim `proved`.
2. After `afterProblem`, the candidates this problem's lines submitted through `validate` ([lines.md](lines.md#validate)):
   proofs of other claims, which become `proved`; proofs of negations, which make their claim
   `refuted`; and a proof of the problem's own claim found late. M2's composed proofs and its
   twin's proof and refutations are among them: they reach the certifier by the same path as a
   prover's candidate. One after the other, in the order their claims were first submitted for,
   and not once the run is stopped. Each is compared with the claim's reference file
   (`MemoryStore.referenceFor`): the problem's file for a problem's claim, and the file rebuilt
   from the claim's journaled statement and header for any other; a line cannot give a claim a
   file of its own ([memory.md](memory.md#reference-files)).

A problem's outcome comes from its own results only. It is `proved` when its own candidate was
certified. It is `refuted` when a refutation of its claim that its own lines submitted was
certified, after `afterProblem`, and the same holds for a proof of its claim that a line found late:
a problem that ended `unsolved` or `candidate` ends as `proved` or `refuted` then. The certification
of another problem's proof or refutation, even of a problem that shares its claim, does not move a
problem's outcome: it stays `unsolved` (or `candidate`) until its own provers or lines find
something, and the claim's status is the other problem's doing. `run.finished` counts the claims
instead ([journal.md](journal.md#projection)): a problem counts as solved, refuted or a
candidate when its claim has that status, so two problems that share a claim count twice, and a
claim whose proof the kernel refused stays `computed` and counts as a candidate while its problem
is `unsolved`. The report counts the outcomes.

A line that fails in `afterProblem` makes the problem an `error`, except that a proof, a refutation
or a candidate found stays found: the outcome is decided after the lines' submissions are certified,
and the failure goes into the reason.

Each problem has its own abort signal, aborted with a reason: `solved` (a prover found the
candidate), `budget` (the problem's or the run's budget ran out) or `stopped` (the run was stopped,
or a prover crashed). Aborting it ends every session of the problem at once, with the model
requests and the Lean checks in flight.

## A prover

A prover runs at most `sessions` sessions. Each session is an attempt in the journal
(`attempt.started` with its iteration, then `attempt.finished`), and its first message gives:

- the theorem's full name, and the session's number out of the maximum;
- the prover's notes from the previous session;
- the file with the regions of the prover's last check (at first, an empty AUX region and the
  original proof, usually `sorry`);
- what Lean said in that check.

Every model response of a session is also written as it is charged (`attempt.charged`), so that the
journal keeps what a session that never ended cost; and `attempt.finished` carries, as blob hashes,
what the next session starts from: the prover's regions, the text of its last check, its notes
(`carry`). A resumed run starts its budgets and its provers from these ([ledger.md](ledger.md#charges-and-carry)).

After each attempt the orchestrator takes the routing decisions about the prover's task: one for the
class of the attempt's failed check, one for each drift finding that stopped the session
([ledger.md](ledger.md#routing-decisions)). They are `task.routed` events, they change no status,
and the prover's next session starts as it always did.

The model's final message in a session becomes the prover's notes, cut at `notesChars`
characters, and is recorded as `lesson.recorded`. New notes replace the old ones; the system
prompt asks the prover to rewrite them in full and keep what still helps.

A prover stops when it finds the candidate, when it has used its sessions, when the budget runs
out, when the problem is aborted, after two sessions in a row ended with an error (the model or
Lean could not be reached), or when a line's `beforeSession` stops it (`line`).

## A session

A session is a fresh pi `Agent` with the tool `lean_check(aux, proof)`, and the run's
[other tools](#other-tools) if it has any. When an enabled line classifies strategies (M1), the
tool also takes an optional `strategy`, one of the line's labels ([lines.md](lines.md#a-line)); M0
has no such argument. A check puts the two
regions into the file, keeps the file in the blob store, and runs the fast check under
`SKETCH_POLICY`, which lets `sorry` and `admit` reach Lean so that the goals of the holes come back
([validator.md](validator.md#holes)). Regions that contain marker lines are refused before Lean.

A check of a file without holes that Lean answered is a validation, recorded as
`validation.finished` (method `repl`). The first valid one makes the claim `computed`, ends the
session and aborts the problem's other provers. A check with holes, a check that could not reach
Lean, and a check that was stopped say nothing about the proof and are not validations; their tool
runs are in the journal all the same.

A session ends for one of these reasons, recorded as `stoppedBy` in `attempt.finished`:

| `stoppedBy` | When | Attempt outcome |
|---|---|---|
| `model` | The model answered without calling a tool. | `invalid`, or `no_submission` if the session made no check |
| `turns` | The session reached `turns` model responses. | the same |
| `context` | The prompt of the last request reached `contextTokens` tokens. | the same |
| `budget` | The problem's or the run's budget ran out. | `budget_exhausted` |
| `solved` | One of its checks made the candidate. | `valid` |
| `aborted` | Another prover found the candidate, or the run was stopped. | `aborted` |
| `error` | A model request failed, Lean could not be reached three times in a row, or the harness failed during a check (or a line's hook in the session). | `error` |
| `line:<id>` | An enabled line's `afterCheck` stopped it ([lines.md](lines.md#the-hooks)); no notes are asked for. | `invalid` |
| `interrupted` | The process ended in the middle of the session. Written by the orchestrator when the run is resumed, at the cost of the session's charges, with no carry ([ledger.md](ledger.md#resume)). | `aborted` |

When `turns` or `context` ends a session that is not the prover's last, one more request asks the
model for its notes (`WRAP_UP`). The tools stay declared, because providers need the definitions
of the tools that the history calls, but a `beforeToolCall` hook blocks any call.

For an `invalid` attempt, `failureClass` classifies its last check from Lean's messages: `refused`
(before Lean), `lean_unavailable`, `timeout`, `syntax`, `unknown_identifier`, `type_mismatch`,
`tactic_failed`, `unsolved_goals`, `restates_target` (an auxiliary lemma states the target again),
`holes`, `axioms` (an axiom outside the allowed ones), `statement_changed` or `other`
([the table](m1-identity-memory.md#failure-classes)). The classes are the same with or without
lines; the class `lean_error`, which stood for every error Lean reported, is gone. Only a run with M1 records
the typed `failureDetail` besides the class.

## What the prover sees

The answer to a check lists Lean's errors, the holes with their goals, and the other messages (such
as the suggestions of `exact?`), each located by region and line of the prover's file, with the
text of that line. The `declaration uses 'sorry'` warnings are left out. At most 8 items of each
kind are shown, and a message is cut at 1500 characters.

```
Checked the sketch: 1 error(s), 1 hole(s).
Errors (1):
1. PROOF line 1, `intro m`:
   no additional binders
Holes, with their goals (1):
1. PROOF line 3, `sorry`:
   n : ℕ
   ⊢ n + 0 = n
Other messages (1):
1. info, PROOF line 2, `exact?`:
   Try this: exact Nat.add_zero n
```

The other answers say that the file was refused before Lean ran and why, that Lean ran out of
time, or that Lean could not be reached.

## Other tools

`--tool CAPABILITY` gives the provers a capability besides `lean_check`, such as `compute.sage`
(SageMath, [compute.md](compute.md)). It must be a `direct` capability that the host offers, and
not `lean.check` itself.

Before `run.started`, the run pins each tool to the first implementation of the host profile that
answers a health check, so that all the tool's calls in the run go to that implementation, and none
goes first to one that is down. It writes on the standard error which ones it passed over and why,
such as `compute.sage uses local, because docker: ...`. A tool none of whose implementations answers
stops the run before it starts. `run.started` records each tool with the implementation and the
version it was pinned to.

In a session, the capability is a pi tool named after its id, with `_` for `.` (`compute_sage`).
Its description is the manifest's: the title, the description, when to use it and when not, and the
examples with their outputs as the model will read them. Its parameters are the manifest's input
schema. Each call is a tool run of the attempt. A stateful capability's calls take the attempt's id
as their scope, so a prover's SageMath session lasts one attempt: the prover releases the scope
when the attempt ends, and its next session starts with an empty one, with only the notes to carry
what was found.

The model reads an output as one line per field, without the empty ones, with text of several
lines indented below its field, and numbers to four significant digits:

```
result_type: expression
result: 120
stdout: 3
elapsed_ms: 306.4
```

An answer longer than 8000 characters is cut, with a note that asks to print less. Errors come back
as tool errors: the tool's own message when the call failed on its input (`Error: (no message)` when
the tool gave none), and a sentence of the harness for a timeout, an input the schema refuses, or an
output the harness does not accept. When the tool cannot be reached, the model is told to go on
without it, and the tool is not called again in that session.

A capability can have a binding (`ToolBinding` in `tools.ts`), for the inputs that belong to the
run and not to the model: they are left out of the tool's parameters, whatever the model puts there
is dropped, and the run sets them for each call; the binding can also write the answer for the
model in place of the field-per-line form. `lean.lsp` ([lean-lsp.md](lean-lsp.md)) is the one that
has it: the problem's sketch is set by the run, `aux` and `proof` default to the regions of the
attempt's last `lean_check` (`Workbench.lastSubmission`, or the regions the session started with),
and the answers read as goals, messages and lists of lemmas. `toolBinding(id, ...)` gives it to
`lean.lsp` alone, so every other tool is as before.

## Prompts

`prompt.ts` holds the system prompt, the first message of a session and the wrap-up message. The
system prompt explains the two regions, the check, the sessions and the notes, and a method: work
out the mathematics first; write the proof as a sketch, with `aux_` lemmas or `have`s proved by
`sorry`; check the sketch, then fill the holes one at a time; a hole as hard as the theorem is not
progress; use the automation and the tactics that search Mathlib; say in the notes when the
statement seems false.

When the run has other tools, the system prompt names them and says that what they return is
evidence, not proof, since only `lean_check` decides; it asks the prover to use them to test small
cases, compute examples and search for counterexamples before writing Lean, and to find the values
and witnesses a proof needs.

`PROMPT_VERSION` (now `m0-2`) changes with any change of the prompts, and `run.started` records it
with a hash of the prompts, tools' names included. Version `m0-2` added the section on other tools;
without tools, its system prompt is that of `m0-1`. The tools' descriptions are in their manifests,
covered by the registry's hash.

## Budgets

Spending is tracked by ledgers: one for the run, and one per problem below it. Every model response
is charged to its problem and to the run, at the cost the provider reports, or at the cost computed
from the model's prices when it reports none. Input tokens include cache reads and writes, and the
cache reads are also given apart (`cachedInputTokens` in `attempt.charged` and `attempt.finished`,
and in `model_call.finished`; absent when there were none), priced at the model's cache-read rate. The report reads an attempt's cached tokens as the larger of its
`attempt.finished` value and the sum of its `attempt.charged` values: a session the harness failed in
and a session a resumption cut have an `attempt.finished` written from the charges, which carries no
cached sum (the projection keeps none), and a finished total, when there is one, is the sum of the same
charges, so the larger of the two is never too small or counted twice.
An aborted response is charged for the usage that pi kept.

`--cache-retention none|short|long` (`cacheRetention` in the run's configuration, recorded in
`run.started` only when given) is passed to pi-ai with every request of a session. pi-ai puts the
option on the request options of every provider and a provider that does not use it ignores it, so
the harness does not filter by provider; the providers that read it (Anthropic, the OpenAI
completions and responses APIs, Bedrock, Mistral among them) turn it into their own cache control.
Absent, the provider's own default holds, which for pi-ai is `short`. A session's id is passed as
the cache session as well. With a line packet that answers a prefix and a tail ([lines.md](lines.md#the-context-packet)),
every request of a session starts with the same bytes after the system prompt, which is what
automatic prefix caches need. Anthropic's API caches up to a marked block, and pi-ai marks the last
block of the last message, the system prompt and the tools: the tail. The prefix is then cached
only as far as an earlier request marked its end, so the saving there rests on pi-ai marking the
end of the prefix too, which it does not do at present and which has not been measured.

When a problem's budget runs out, its sessions end at once (`budget`) and the problem is
`unsolved`. When the run's budget runs out, the problems in progress end in the same way and no new
problem starts. Budgets are checked as responses arrive, so the responses in flight, at most one
per prover, can take a ledger past its limit.

## The run directory

| Path | Content |
|---|---|
| `journal.jsonl` | The events: the record of the run ([journal.md](journal.md)). |
| `projection.sqlite` | The queryable view of the journal. |
| `config.json` | The configuration recorded in `run.started`, the problem ids and the code revision. |
| `blobs/` | Every file a prover submitted, by its `submissionHash`, and every tool run's input and output, by its `inputHash` and `outputHash` ([journal.md](journal.md#blobs)). |
| `transcripts/ATTEMPT_ID.json` | The messages of each session, as pi keeps them. |
| `proofs/NAME-HASH.lean` | The file of each candidate proof. |
| `report.md`, `report.json` | The report. |

## Commands

```sh
git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git ../google-deepmind/formal-conjectures-bench-v1
pnpm harness health                    # the Lean server and the other tools answer
pnpm harness models                    # the providers, and whether their credentials are set
pnpm harness models PROVIDER           # the models of a provider, with their prices
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --tool compute.sage
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --ablation M2
pnpm harness run --resume runs/RUN_ID --checkout ../google-deepmind/formal-conjectures-bench-v1   # continue a run whose process ended
pnpm harness report runs/RUN_ID        # add --json for the JSON report
```

A model's credentials come from the environment, in the variable its provider uses; `harness
models` says which variable it found. Credentials are never written in a file of the repository.

Options of `harness run`:

| Option | Default | Meaning |
|---|---|---|
| `--checkout DIR` | required | A checkout of formal-conjectures at the bench's revision ([bench.md](bench.md)). |
| `--model PROVIDER/ID` | required | A model, as pi-ai names it. |
| `--sample N [--seed S]`, `--problem ID...`, `--all` | one of them | The problems. A sample is deterministic: the `N` problems whose hash with the seed (default `m0`) is smallest. |
| `--bench FILE` | `bench/fc-bench-v1-discrete.json` | The bench index. |
| `--host HOST` | `HARNESS_HOST`, then `local` | The host profile ([capabilities.md](capabilities.md#host-profiles)). |
| `--provers N` | 4 | Provers per problem. |
| `--sessions N` | 8 | Sessions per prover. |
| `--turns N` | 40 | Model responses per session. |
| `--context-tokens N` | 120000 | Prompt size that ends a session. |
| `--notes-chars N` | 4000 | Length limit of the notes. |
| `--cache-retention R` | the provider's | `none`, `short` or `long`: the prompt cache retention asked of the provider with every request ([budgets](#budgets)). |
| `--thinking LEVEL` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `--budget-usd X` | 5 | Dollars per problem. |
| `--run-budget-usd X` | none | Dollars for the whole run. |
| `--concurrency N` | 1 | Problems worked on at the same time. |
| `--tool CAPABILITY` | none | A `direct` capability given to the provers besides `lean_check`, such as `compute.sage`; repeat it for several ([other tools](#other-tools)). |
| `--lines ID,...` | none | The lines to enable, such as `M1,M6,fleet`; repeatable. None: M0 ([lines.md](lines.md)). M1, M2, M6 and `fleet` are the lines built ([m1-identity-memory.md](m1-identity-memory.md), [graph.md](graph.md), [guards.md](guards.md), [fleet.md](fleet.md)); a run that enables a line not built yet refuses to start. |
| `--ablation NAME` | `M0` | The cumulative config that ends with line `NAME`: that line and every line before it in the plan's order ([lines.md](lines.md#cumulative-configs)). Not with `--lines`. |
| `--line-option ID.KEY=VALUE` | none | An option of an enabled line; `VALUE` is read as JSON when it parses, as a string otherwise. Repeatable. |
| `--out DIR` | `runs/RUN_ID` | The run directory. |

`harness run --resume RUN_DIR --checkout DIR [--bench FILE] [--host HOST]` continues a run whose
process ended without finishing it ([ledger.md](ledger.md#resume)). The run keeps the configuration
it began with, which is read from its journal, so no option that describes a run is given with it
(`--model`, `--sessions`, `--lines`...); the bench, the host's capability registry, the tools, the
certifier and the lines have to be the ones it began with. A run with a line that does not say how it
is resumed, or refuses, cannot be resumed, and a run that is complete has nothing to resume: both
are refused before anything is written, with the reason. M1, M2, M6 and the fleet can be resumed.

Progress goes to the standard error, one line per problem, and the report goes to the standard
output at the end. A first Ctrl-C stops the run: the problems in progress end as `aborted`, and the
journal and the report are still written. A second Ctrl-C quits at once.

Exit codes: 0 when the run is complete or its budget ran out; 1 when it stopped on errors, or on a
bug (printed with its stack); 2 for a mistake in the command or its inputs, found before anything
is written; 130 when it was interrupted.

`harness report` builds the report from the journal alone, so it also works on a run that was
interrupted or killed.

## The report

The report counts the problems by outcome, with those that have none (not started, or cut off
when the run was killed). It gives the Q5 metrics that a run can measure: validity (problems
proved or refuted, and candidates that passed the fast check only), the cost in total and per
problem with a proof or a refutation (the dollars per solve), tokens with the share that was read
from the provider's prompt cache (`cachedInputTokens`, shown when there is any), attempts
by outcome, how the sessions ended, the failure classes of the invalid attempts, and the Lean
checks with their median and 90th percentile times (the count includes one reference check per
problem). For each other tool, it gives the provers' calls by outcome, the attempts that made them,
and how many of those attempts found a proof. It gives the spend by site (`prover.session` for the
provers' sessions, the sites of the lines' one-shot calls), each with its share of the total
([ledger.md](ledger.md#sites)). It also says what it does not measure: the fidelity of the formal statements, taken as
given by the bench, and novelty, since the bench's problems are solved ones.

A run that was resumed says so: how many times, how many sessions, tool runs and tasks the
interruptions cut, and how many times the journal's last line was cut (`resumed` in `report.json`).

## Tested, and not yet

The tests in `packages/orchestrator/test/m0.test.ts` run the loop with pi-ai's faux provider as the
model and a simulated Lean (`DemoLean`, in `m0-helpers.ts`). They cover a candidate found and
recorded; the file and the notes carried from one session to the next; forbidden code refused
before Lean; the turn limit, with the wrap-up; the problem's budget; the other provers stopped when
one succeeds; a problem whose original file does not compile; a run stopped when Lean cannot be
reached; certification, accepted and rejected; and a run aborted between problems.
`packet.test.ts` covers the cache in the cost: the cached input tokens in the journal and the report, the retention asked of
the provider (and kept when a run is resumed), and the dollars per solve of a frozen packet prefix against a packet compiled again,
as pi-ai's faux provider simulates the cache, and the cache reads of a session the harness failed in or a resumption cut ([lines.md](lines.md#the-context-packet)). What a real provider's cache does with it has not run.
`certify.test.ts` runs certification through the loop with a fake certifier and with the registry's
`lean.certify`: a claim `proved` only after the certificate, a certifier that gives no answer, the
refutations of a line (certified, rejected, and against a claim already refuted), the proofs a line
submits for other claims (certified after `afterProblem`, rejected, not started once the run is
stopped), the reference file the certifier is given, a host whose certifier cannot be made (said at
the start, recorded in `run.started`), and runs with M1, M6 and the fleet on (the
hooks of the sessions and provers all run before the certifier is asked and `afterProblem` after
it, a veto of M6 leaves nothing to certify, and the call belongs to no attempt).
`tools.test.ts` gives the provers a simulated SageMath server (`test/fixtures/fake-sage.ts`, over
an in-memory transport): one Sage session per attempt, ended with the attempt; the outputs and
errors as the model reads them; the tool's description and the prompt's section; the run's
refusals of tools it cannot give; and the pinning to the first implementation that answers.
`lean-lsp.test.ts` gives them a simulated lean-lsp-mcp (the stand-in of `packages/lean-lsp`): the
file each call reads, the sketch the model cannot set, the journal, no change of status, a search
site down, the server dying, and the budget.
`resume-run.test.ts` and `resume-kill.test.ts` resume runs: a copy of a run's journal cut at an
event stands for the process that ended there (`killedAt`, in `m0-helpers.ts`), at every event of a
short run, with and without a cut last line, with a fake certifier and with the registry's; the
budgets of the problem and of the run are compared with a run that was not cut; and a child process
that is killed with SIGKILL in the middle of a check, with one and two provers, is resumed. The rest
of `cli.test.ts` covers the argument and setup errors of `harness run` (its lines' options and
`--resume` too), and `harness report` and `harness models`. `lines.test.ts` runs fake lines through the loop
([lines.md](lines.md#tested-and-not-yet)); with no line enabled, the loop is the one the tests above
cover, unchanged.

A run with the real SageMath (the `local` implementation), the faux model and the simulated Lean was
done by hand on 2026-10-13: the outputs, the per-attempt sessions, a timeout and the report came out
as the tests expect. It is not part of `pnpm test`, which needs no SageMath.

Not done yet:

- No run against a real model or a real Lean server. The development environment cannot download
  the Lean toolchain, so the first real run will be on the workstation or the dedicated server,
  once `pnpm harness contract lean.check` passes there.
- No run has gone through a real certifier. The harness side is tested with a fake `lake` and fake
  certifiers; the Lean program `lean/SeshatCertify` has never been compiled
  ([certifier.md](certifier.md#to-verify-against-lean)). Until it has run, a real run's best
  outcome is `candidate` in practice, though the code paths to `proved` and `refuted` are there.
- No run has been resumed against a real model or a real Lean: the tests stand a faux model and a
  simulated Lean in for them, and the process that ends is a copy of a journal cut at an event or a
  child process killed with SIGKILL. `harness run --resume` has not been run from the command line
  on a run that a real process left behind.
- The prompts have not been tuned on real attempts.
