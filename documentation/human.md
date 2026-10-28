# The research team: turns, breakpoints and the account

A run can stop by itself, say where it stands, and wait for the people who follow the research. This is
consortium mode. It is for a team that reads an account, answers, and lets the run go on: the run does not
ask anyone anything while it works, and it spends nothing while it waits.

The mode is off unless it is asked for (`--human`, or any turn limit). A run that does not ask for it
records and does exactly what it always did: no `turn.*` event, no `turns/` directory, no change to a
prompt.

```sh
pnpm harness run --checkout DIR --model PROVIDER/ID --sample 5 --turn-usd 2     # a turn ends at $2
pnpm harness run --checkout DIR --model PROVIDER/ID --sample 5 --human          # only breakpoints end a turn
# the run ends its turn, writes runs/RUN_ID/turns/1/report.md, and exits with 0
pnpm harness hint   runs/RUN_ID --claim clm_... "Try strong induction on n."
pnpm harness sign   runs/RUN_ID edg_...
pnpm harness steer  runs/RUN_ID --forbid automation --turn-usd 5
pnpm harness resume runs/RUN_ID --checkout DIR                                   # turn 2 begins
```

## Turns

A turn is the work between two stops. Turn 1 begins when the run starts, and each later turn when the run
is resumed. A turn ends once, with `turn.ended`: either because the run is over (`reason` is `finished`,
or the reason the run stopped), or because the turn has to wait for the team.

### Limits

`--turn-tokens N` (input and output tokens), `--turn-usd X` and `--turn-minutes N` (wall-clock minutes of
the process that works the turn). Any of them may be given, and the first to be reached ends the turn.
They are counted over every model response of the run: a prover's session, and a line's one-shot call
(`completeJson` included), whichever problem and prover made it. The run's ledger tells the turn of every
charge, so there is one count and no place that escapes it.

At the limit:

- no session starts, no model call is sent, and no problem starts. The check is made before each of them
  (the run's queue, the prover's loop, before and after the lines open a session), and once more at the
  point where a request is sent: the session's stream function reads the turn immediately before it calls
  the provider, and `lineLlm` reads it again after the model is resolved, with nothing that waits between
  the check and the call. So when two provers and the lines work at once, a response that ends the turn
  stops the request another prover was about to send, however long that prover waited in a line's
  `briefing` or in `openSession`. A request that is stopped there ends its session with `stoppedBy: "turn"`
  and counts as a cut, not as an error. The turn is only ever read;
- a response already in flight finishes, and is paid for and counted. At most one per prover and per line
  call is in flight, so the turn can pass its limit by that much (`--turn-usd 2` can spend a little more
  than $2);
- the sessions that were running stop after that response, with no request for notes. Each ends as an
  attempt `aborted` with `stoppedBy: "turn"` and a `carry` (the file as it stood, the last check, the
  notes with a line that says where the turn cut the session). The next turn's session starts from it, as
  after any cut session ([ledger.md](ledger.md#resume));
- a problem that holds a candidate (a proof the fast check accepted) is certified before the run exits:
  the certification is Lean, with no model call, so it is not held back by the limit. The run certifies the
  problem's own candidate and what the lines submitted for it (the same certification a run makes at the end
  of a problem), and runs nothing else for the problem: no session, no `afterProblem`, no request. The claim
  becomes `proved` or `refuted` through the normal validation, the account says so, and the problem keeps no
  outcome: the next turn closes it from the certification the journal holds, without certifying again. The
  `settled` breakpoint is not struck a second time by that close, so it does not cost a turn. A certifier that
  is down or too slow leaves the candidate as it was (the run says so in its log), and the next turn
  certifies it, as after a kill;
- the run writes `turn.ended` (the turn's number, the reason, what the turn spent and what the run has
  spent, the minutes, the problems that wait), then the account, and exits with 0. It does not write
  `run.finished`, because the run is not finished: `report.md` says it is paused.

A line that asks for a model call after the turn is over is not failing: the call raises
`TurnEndedError`, an `InterruptedError` ([lines.md](lines.md#interrupted-work)) which the run reads as
"this problem waits", and the line does the work again in the next turn from where it was
(`beforeProvers` runs again, `afterProblem` too). A line that catches errors from a model call must let
this one through, or record nothing as an end: M2's refutation side, which runs alongside the provers,
leaves its node `pending` when a call is refused, and the next turn asks only for the calls the journal
does not hold.

The limits bound model work, not the life of the process. `--turn-minutes` is read where a request would be
sent and after each response; a process overshoots it by the response in flight and by the time of the
certifications above (a kernel replay in a sandbox, up to the certifier's timeout for each candidate). The
narrative ([below](#the-narrative)) is one more model call, made after the limit, with a budget of its own.

`turn.started` records the limit and where it came from: the flag of the resumption, a steer, the turn
before's limit (it carries over), or the run's option, in that order.

### A turn is a clean kill

The pause leaves the journal exactly as a process that was killed leaves it, except that the sessions are
closed, with their carries: the prover tasks stay `running`, the problems have no outcome, and the next
turn is `harness resume`, which the ledger already has ([ledger.md](ledger.md#resume)). Nothing in the
resumption knows about turns, and so a run in three turns reaches the same outcome as one that is not
interrupted (the test says what was sampled). A process that ended in the middle of a turn without writing
`turn.ended` (a kill, a usage limit) is closed by the next one: `turn.ended` with the reason `interrupted`,
then the next turn.

Because every turn after the first is a resumption, a consortium run starts only with lines that can be
resumed ([lines.md](lines.md#resuming-a-run-with-lines)): `harness run --human` or `--turn-usd 2` with a
line that is `{refuse: ...}` or does not say how it resumes is refused before anything is spent, with the same
message `harness resume` would give, instead of spending a turn and then being unable to continue.

A turn costs a session per cut: a session cut by the turn is a session used (`--sessions`). A run meant to
take many turns should give its provers more sessions.

## Breakpoints

With `--human` (and with any turn limit) a turn also ends at a breakpoint, an event that the journal
decides and a model does not:

| Breakpoint | When |
|---|---|
| `impasse` | Every open task of a problem is blocked; or, after `--impasse-attempts` finished attempts (default 8), the mean of the problem's success posterior is below `--impasse-posterior` (default 0.1). The posterior is Beta(1 + accepted, 1 + failed) over the problem's attempts whose outcome is `valid` or `invalid`; the attempts that were cut, aborted or errored say nothing about the proof. Also when a problem ends `unsolved` |
| `settled` | A problem ends `proved` or `refuted`: a certified result is worth a person's eyes before the run goes on |
| `disagreement` | A `judgment` node with `data.disagreement: true` is recorded: two informal validators did not agree (plan change PC9). The node is the lines' to write; the harness only reads it |

A breakpoint fires once for what it saw. `turn.ended.breakpoint` records it and the next turn reads that
back: a problem reported at an impasse is not an impasse again until it has made as many new finished
attempts as an impasse needs (the posterior is counted from the report on), a settled problem is not
reported twice, and a disagreement is reported once. So a hint that does not help is not answered by an
endless chain of one-attempt turns.

The ablation (`harness run --ablation`) measures lines against each other, and a turn boundary changes what
the models see, so `--human` and the turn limits are refused with it (`ablationRefusal`, exit code 2). Any
tool that runs configurations to compare them, `harness ablate` included, must call it for every config.

## The account

When a turn ends the run writes `turns/N/report.md` and `turns/N/report.json`. They are built from the
journal alone, by `buildAccount`, with no model call: the same journal gives the same account, and the
account of turn N reads the journal only up to the end of turn N, so it does not change when the team
answers later. It has:

1. a summary: why the turn ended, its limit, the problems (proved, refuted, with a candidate, waiting),
   what the turn and the run spent and what is left of the run's budget, the next turn's limit, and what
   the team is asked to do;
2. one section for each problem:
   - its state (its outcome, or `waiting`), its claim's status, and how it got there: every status change of
     its claim and of the parts of its decomposition, with the validation behind it;
   - the claims proved, computed and refuted, with their ids and who checked them: the validation, its
     method (fast check or kernel replay), the actor that recorded it, the prover and the attempt; and the
     edges the team signed, with their names;
   - the decomposition tree and its open leaves;
   - for each open leaf, the strategies tried (by `strategy`, and by subgoal where an attempt named one),
     the outcomes, and how the last failed one failed (failure class and detail, or how the session ended);
   - the counterexamples (`counter_model` nodes) and the obstructions (`obstruction` nodes);
   - the conjectures (`conjecture` nodes) with their evidence;
   - what runs next: the problem's `ready` tasks (what the next turn would start), then the problem's other
     tasks that are not over by status (`running` ones are those a turn cut; they go on when the run
     resumes), and the fleet's leading strategies for the claim and its parts, read from the fleet's
     `allocation` nodes: how many sessions each strategy was given, how many on the stronger model, and the
     success rate the fleet last read. A problem whose claim was certified when the turn ended says `proved`
     or `refuted` and that it closes when the run resumes; the team is asked to read it as settled;
3. the team's answers so far, and those since the turn before (for a turn that a crash left open, since its
   start: an answer given after the crash is news to the turn that follows);
4. the kinds of record the account has no section for, with how many there are (`unknownKinds` in the
   JSON): fingerprints, identifications, drift findings and the lines' other records are counted here and
   are in the journal, and a kind that is added later appears here until the account learns it;
5. for a run that started on the memory of earlier runs (`--memory-from`), a section with counts of what it
   carried (claims and the statuses that carried, attempts, lessons, nodes, edges, validations that count). The
   account covers this run's own journal: the inherited claims are not listed as the run's, but a claim of
   this run that an earlier run proved is shown with the status it carries. If the earlier directory has
   moved, the section says it could not be read and the account is written without it.

Only what the journal holds is in it. A status is the claim's status as the journal has it; the account
never calls a claim proved because a model, a node or a person said so.

### The narrative

`--turn-narrative` (or `consortium.narrative`) asks a model for a short text about the turn, written from
the account and nothing else (at most about 250 words, with a budget of its own: $0.25, charged to the run).
It is marked "written by a model, not part of the record". Every id it names has to resolve: a
`[cite: ID]` marker, or a bare id of a claim, edge, node, problem, attempt, validation or task must exist
in the journal (the check of M6's citations, [guards.md](guards.md), against the journal's ids), and a
reference to the literature, or an appeal to a known result, is refused. The model gets one chance to
correct itself. A narrative that does not pass is not kept: `turn.ended.narrative.rejected` says why and the
account says so. The call is a `model_call.finished` of the orchestrator at the site `turn.narrative`,
written before `turn.ended`, so the turn counts what it cost. It needs a model, so it is written and
tested with the faux provider; it has not run with a real one.

## The team's answers

Each answer is written to the journal under the person's name as actor (`human:NAME`; `--as NAME`, else
`SESHAT_USER`, else the login name). Several people may answer before one resumes. The commands refuse
while a process holds the run (the journal's lock), for a directory with no run, and for a journal whose
last line a crash cut (resume first).

| Command | Writes | Effect |
|---|---|---|
| `harness hint RUN_DIR --claim ID "text"` | A `hint` node on the claim, `provenance: "human"` | The next sessions on that claim, and on its decomposition's parts, are shown it in their briefing under "Hints from the team", said to be a suggestion and not a fact or a proof |
| `harness sign RUN_DIR EDGE_ID [--note TEXT]` | `edge.status_changed` to `human_signed` | The edge's status. It is below `lean_checked`, so no rule follows it: nothing is derived from it and no claim moves. It never lowers a status, so an edge that is already `human_signed` or `lean_checked` is refused |
| `harness steer RUN_DIR --focus CLAIM` | A `steer` node | The problems whose claim is (or decomposes from) it go first when the run resumes, and its sessions are told it was asked |
| `harness steer RUN_DIR --drop CLAIM` | A `steer` node | When the run resumes, the problem of that claim ends `aborted` (reason `dropped by NAME after turn N`) and its tasks are cancelled. The claim's status is not touched: dropping is not a verdict |
| `harness steer RUN_DIR --forbid STRATEGY [--claim ID]` | A `steer` node | A check whose proof follows the strategy (the label the model declared, or the one `classifyStrategy` reads from the text) is not run and the session is told why. For one claim and its parts, or for all |
| `harness steer RUN_DIR --turn-tokens N` / `--turn-usd X` / `--turn-minutes N` | A `steer` node | The next turn's limit, unless the resumption gives a flag |
| `harness resume RUN_DIR --checkout DIR [--turn-... ] [--turn-narrative]` | `run.resumed`, `turn.started` | The next turn. The same as `harness run --resume`. A flag of the limit wins over a steer and over the turn before's |

A focus or a drop names a claim that exists: the claim of a problem the run has begun. A problem that has
not begun has no claim yet.

### What an answer can and cannot change

An answer changes what the models are told (a hint, a strategy ruled out), the order and the end of
the work (focus, drop), and the next turn's limit. It does not change a claim's status. Lean stays the
judge:

- a hint is a node of provenance `human`, in the briefing as a hint. A proof that follows it is checked
  like any other, and only the certifier's kernel replay makes a claim `proved` or `refuted`;
- a signature is a status of an edge, and `human_signed` does not propagate ([trust.md](trust.md#edges));
- a steer is a record. The one thing it does to a problem is to end it `aborted` (drop), which is an
  outcome of the problem and not a status of the claim.

The journal's invariants hold for these events like any others: `turn.*` is the orchestrator's alone, a
`hint` or `steer` node is accepted only from an actor `human:NAME` (so no line or model can write one in
the team's name), nobody can edit one afterwards (`node.updated` of a hint or a steer is refused for every
actor, `human:NAME` included: a person who changes their mind writes a new hint), an edge reaches
`human_signed` only through an event of `human:NAME`, and a status change still needs its validation. What a person writes is a hint or a steer: both are text and
numbers the harness reads back with a check, and an answer that does not parse is ignored.

### Whose answers they are

The names are self-asserted: `--as NAME`, `SESHAT_USER` or the login name, with nothing to prove who typed
them. The journal's hash chain makes an answer tamper-evident, not signed. The harness keeps the team's
answers to the run they were given to: a run that starts on an earlier run's memory (`--memory-from`)
inherits its claims, attempts, lessons and edges, and none of its hints and steers (they are left out when
the earlier journals are replayed), so an old drop or an old forbidden strategy never applies to a new run
that happens to reuse a claim's id, and old hints are not shown to the new run's sessions. The earlier
run's turns are not counted either: the new run's first turn is turn 1.

`harness steer` writes one node for each flag it is given, one after the other. It is not atomic: if the
second write is refused, the first stays; the command prints each steer as it writes it, so the lines it printed say which were written. A second person who answers
at the same moment finds the journal locked and runs the command again.

## The files

| File | Role |
|---|---|
| `packages/orchestrator/src/turns.ts` | `Turn` (the count and the gate), `ConsortiumConfig`, `nextLimit`, `ablationRefusal`, `TurnEndedError` |
| `packages/orchestrator/src/consortium.ts` | `beginTurn`, `closeTurn`, `closeOpenTurn`: the turn's events |
| `packages/orchestrator/src/breakpoints.ts` | `Breakpoints`: impasse, settled, disagreement |
| `packages/orchestrator/src/account.ts` | `buildAccount`, `renderAccount`, `writeAccount`, the narrative |
| `packages/orchestrator/src/team.ts`, `team-command.ts` | The answers: recording them, reading them back (briefings, vetoes, drops, focus), the commands |

## Tested, and not yet

Tested with the faux model and a simulated Lean: each kind of limit, with the model's call count after the
turn; the sessions in flight and their carries; a line's one-shot calls counted in the turn; each
breakpoint and its re-arming; the account from a scripted journal; a hint in the next session's prompt; a
signature that propagates nothing (against a Lean-checked edge that does); each steer; the narrative
accepted and refused; the command line; and a run in three turns against one that is not interrupted. For
that last test the cut matrix was sampled, not covered: 3 x 3 token limits for the first two turns
(1, 4,000 and 8,000 tokens, which fall after one, two and about four responses), the last turn unlimited,
on two problems with five responses in all; cuts by dollars, by time and by breakpoint are tested singly.

Not run: a real model (the narrative, and the effect of a hint on a model), a real Lean, a real wait
between turns. Not built: sending the account to a chat and taking answers from there (the account is a file
a person reads and the commands are run by hand), and `harness ablate`, which does not exist yet (the
refusal is `ablationRefusal`, called by `harness run --ablation`).
