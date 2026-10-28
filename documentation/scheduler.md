# Scheduler: the saturation kernel, subgoals and the escalation ladder

Line `M12` ([lines.md](lines.md)) is the plan's saturation kernel (§6, Task 10) and the part of the
harness that decides which piece of work comes next. It is `@seshat/scheduler` (`packages/scheduler`),
whose other half is the `TaskLedger` ([ledger.md](ledger.md)). A run enables it with
`harness run --lines M1,M12` (it requires no other line; it uses the graph's propagation and checked edges as a library, so M2 need not be on, and the fleet is optional). Nothing in it
is a model's decision: the rules are numbers and a seeded random source, and a claim changes status
only through `validate` and the certifier ([trust.md](trust.md)).

What it does, in the order it happens in a problem:

1. An outer prover's session ends with a **sketch**: a main proof and some lemmas `aux_<name>`
   whose proof is `sorry`. The line records the sketch (`afterAttempt`).
2. Between sessions the line **registers** the sketch: each named hole becomes a claim, the problem's
   claim gets a `decomposes_into` edge to the holes whose link lemma Lean checks, and each hole
   that is open gets a `prove` task with an inner budget.
3. The line **schedules**: the orchestrator asks it which `ready` task to work on, and it chooses
   with a given-clause loop and weighted proof numbers, and runs it with an inner prover.
4. A hole Lean accepts is a `computed` claim. When every hole of a checked decomposition is accepted,
   the graph's propagation derives the parent, the composed proof goes through `validate`, and the
   problem is settled by the certifier as for any other candidate.
5. The lemmas that were proved reach the outer prover's next briefing, with their names.
6. If the problem spends its budget without Lean progress it moves up the **escalation ladder**.

## The given-clause loop

`GivenClause` (`kernel.ts`) holds two sets, as a saturation prover does: the passive queue (work
waiting) and the active set (work given at least once). `select` moves one item from the first to
the second by an age/weight ratio (default 1 to 4, options `ageRatio`, `weightRatio`): on a cycle of
`age + weight` picks, the first `age` take the oldest item and the others the lightest. Picking only
the lightest starves the heavy ones; the age picks are the fairness guarantee (every item is given
within one cycle of its turn at the head of the age order). Ties go to the seeded random source.
The cycle position is a number the caller keeps, so a process that begins again continues the cycle
(the line counts the tasks it has started).

An item is a task on a claim. Its **weight** is `price / (1 + lemmaValue)`:

- the **price** (`pricing.ts`) is what the task is expected to cost in dollars: the mean cost of an
  inner session, times the sessions it is expected to need, which is one over the success rate
  drawn from the Beta posterior `Beta(1 + s, 1 + f)` of the problem's inner sessions (Thompson
  sampling, so a rate nobody has seen is tried), at most the task's `sessions` budget. A problem
  with no inner session yet uses a prior of $0.05 a session;
- the **lemma value** is Task 5's label of the claim in the assumption-based truth maintenance
  (`lemmaValue` of `@seshat/graph`): the more of the graph's open claims depend on it, the more it
  is worth, and the lighter its task.

All draws come from `seeded(hash32(seed:m12:problem:picks))`: the run's seed (`ProblemContext.seed`),
or the line's option `seed`. The same seed gives the same order of tasks; a resumed process draws
the same values because the pick count is read from the ledger.

## Weighted proof numbers

`ProofNumbers` (`proofnumbers.ts`) are Allis's proof numbers on the AND/OR graph of claims, weighted
by price instead of counting leaves. A claim can be reached by its own proof (a leaf) or by any of
its decompositions (OR); a decomposition needs all its parts (AND). `pn` is the least total price of
leaves that settles a claim, `dpn` the least that shows every known way to it fails. For options
`o1..ok`, `pn = min pn(o)` and `dpn = sum dpn(o)`; for a decomposition `pn = sum pn(part)` and
`dpn = min dpn(part)`. A settled claim has `pn = 0`; a refuted or dead one has `pn = Infinity`. A
claim shared by several parents counts in each parent's sum (an overestimate that is accepted) and a
cycle is cut where it closes. The scheduler asks `mostProving` for the leaf under the problem's claim that advances it most for its
price: at each claim it follows the cheapest option, and in a decomposition the unsettled part with
the least disproof number (the one that fails soonest). The task on that leaf is given **weight 0**,
so it wins every weight pick outright; the age picks still reach the other tasks, so none starves.
(The code does not compute how much `pn` falls if each task succeeds; `mostProving` stands for it.)
A node whose subtree cut a cycle is not memoized, so `of(x)` does not depend on the order of the queries.

## Simplify early, generate late

Each scheduling step follows the saturation provers' rule: it **simplifies before it generates**. It first
registers the sketches the sessions ended with, closes the new holes that a known fact covers (forward
subsumption), sweeps the open holes against the facts proved since (backward subsumption) and
propagates what that derives. Only then does it make tasks for the holes still open and choose among
them. A claim a known fact closes costs no inner session.

## Named holes become claims

`readSketch` (`holes.ts`) reads a submission. A **named hole** is a `lemma` or `theorem` named
`aux_...` whose whole proof is `sorry`. A sketch is split when it has at least one hole, its main
proof has no `sorry` of its own (an anonymous hole belongs to no subgoal), no hole's statement and
no other aux command names a hole (a lemma resting on a hole cannot be lifted out), and every hole
is in signature form. Otherwise the sketch's record says why it is not split and nothing is made.

A split sketch gives:

- one claim per hole (`ensureClaim`, so a hole equal to a claim the memory has is that claim,
  with its status), made by `line:M12`;
- a `decomposes_into` edge from the problem's claim to the holes. Its **link lemma** is
  `(T1) -> ... -> (Tn) -> (F)`, and Lean proves it from the sketch's own main proof
  (`intro h_aux_1 ...; refine fun <binders> => ?_; have aux_x := h_aux_1; <main proof>`). The edge
  is `lean_checked` only if that check passes (`checkEdge`), and only a `lean_checked` edge
  propagates. If the check fails the edge stays a candidate and the holes are still worked, but
  the parent is not derived from them.

## Inner provers and tasks (PC4 item 1)

Each unproved hole gets a `prove` task, proposed by `line:M12` through the task API: acceptance
"the hole's claim is at least `computed`", budget `{sessions: innerSessions}` (default 8), and
`parentTaskId` set to the previous task on the same hole when it is a retry. The options
`maxInnerTasks` (default 8: tasks for the holes of one sketch, that is per outer session, as PC4 item 1 asks; a later sketch's holes get their own), `rounds` (a hole's tasks in all, default 2) and
`stepTasks` (tasks worked between two outer sessions, default 2) bound the work. Tasks are
`ready` when proposed; the orchestrator moves them `running` when the line starts one and `done` or
`failed` when it ends, with the reason the line gives.

The **inner prover** is the line's own: each session is one model call (site `scheduler.inner`, so
the report counts its spend) that returns a proof of the hole, which goes through `validate` like any
prover's. Its prompt has the target, the hole, the header and the reasons of the last three failures. The hole's claim changes status only if Lean accepts the proof. Each session
is recorded as an `m12_session` node (ok, cost, reasons), from which the posterior is computed.

Where an outer prover is told, the briefing (`briefing` hook) has a section "Lemmas of your sketch":
the proved holes with their names and proofs, and the ones not proved (`Not proved: aux_right`). That
is how a proved lemma reaches the outer prover's next session, so that it can use it by name.

## Subsumption

A claim can be closed by a more general one that is already known. `forwardSubsume` takes a new
claim and asks `lean.meta` ([lean-meta.md](lean-meta.md)) for the known facts it is an instance of;
`backwardSubsume` takes a new fact and finds the open claims it covers. Both compare only claims under
the same header, at most `subsumeFacts` (default 40) at a time. A candidate pair is never trusted:

- `lean.meta` only proposes. The special case gets an `instance_of` edge to the general fact, and the
  edge is checked by Lean: its link lemma is the general statement applied to the case, closed by one
  of a short list of tactics (`INSTANCE_CLOSERS`: `exact h`, `apply h`, `simpa using h`, `aesop`...).
- The case closes through propagation only if that edge becomes `lean_checked`. A pair `lean.meta`
  proposes and Lean refuses is recorded as unchecked and changes nothing.
- A link lemma is not a fact (`isLinkLemma`): it is not compared with other claims.
- If `lean.meta` is down, the line counts the failures and stops asking after two.

Each pair tried is an `m12_subsumption` node (instance, general, edge, checked).

## The escalation ladder (PE4 of the memory-evolution plan change)

The ladder is a rule of the run, kept in the orchestrator and the journal; the scheduler supplies
the measure of progress. Rung 0 is the provers and the lines that work from the start. A line says
it belongs to a higher rung with `Line.rung` (1, 2, ...). A rung counts **only if its line is on**. Rung numbers are compressed: the rungs of a run are the sorted distinct `Line.rung` values of the enabled lines, as indexes 1, 2, ... (a line alone on `rung: 3` is rung 1), and `from` and `to` of `ladder.escalated` are these indexes, not `Line.rung`. A line on a rung above the problem's is idle: the
orchestrator gives it no `beforeProvers`, briefing, session or tool until the problem reaches the
rung, when it starts the line with `beforeProvers` (or `resumeProblem`). A cut between the event and the line's start leaves the line active and not started, so a resumed run calls the `beforeProvers` of every active rung line again, even though the provers had begun: it must be safe to call twice (a line that keeps state records it once).

A problem moves up when the dollars spent **since its last Lean progress** reach a fraction of the
problem's budget: the option `fractions` (default `[0.3, 0.6]`, one for each move).
**Lean progress** is a new subclaim of the problem's claim that Lean accepted (`computed` or
`proved`), or fewer open holes in the best healthy sketch (the one with the fewest). The orchestrator
reads it with `progressOf` after each session, writes a `ladder_progress` node when it changes (the
mark of the spend at that moment), and when the spend since the mark reaches the fraction, appends
`ladder.escalated` (problem, from, to, lines, threshold, spend since progress, budget, reason). The
journal checks the event: the spend since the last progress must reach the threshold, and the rung
moves up. The marks are nodes, so a resumed run reads them back and decides the same.
The option `ladder: false` turns the rule off: every enabled line then starts at once, as without M12.

The report ([m0-loop.md](m0-loop.md)) adds a table **Problem / Solving rung / Dollars per rung**:
for each problem, the rung at which it was solved (only for a certified `proved` or `refuted`; none otherwise, a candidate included) and what each rung cost,
read from the journal alone. A session's cost is counted at the rung in force when it ended, and a
one-shot call at the rung of its own event; the dollars per rung add up to the problem's cost.

Lines on rungs 1 and above (`M18`, `M15`, `M16` in the plan) are not built. The ladder is tested with
a stand-in line of rung 1.

## Owners chosen by the fleet (Ruling 29)

`TaskApi.assign(taskId, owner, reason)` ([lines.md](lines.md#tasks)) gives a task of the problem that
has not started to a new owner. The orchestrator refuses an owner that is not an actor name
(`prover:p1`, `line:M12`), a task that has started or ended, and a task of another problem; the call
returns `{assigned: false, reason}` and writes nothing. When the fleet is enabled together with M12 it
implements the hook `assignOwners(problem, tasks)`: for each unowned `ready` task it chooses a
prover by least load, then by Thompson sampling on the provers' posteriors (`chooseOwner` in
`@seshat/fleet`), seeded by `seed:owner:problem:place`. The choice is accounting: the inner prover is
the line's, so the owner records who the work is attributed to, and the ledger can say that.

## Resuming

M12 declares `resume: "rebuild"` ([lines.md](lines.md#resuming-a-run-with-lines)). Everything it keeps is
in the memory's nodes (`m12_sketch`, `m12_session`, `m12_subsumption`) and the ledger's tasks, and
`resumeProblem` makes the process state again from them: the graph state, the pending registrations,
the tasks that a cut left undone. Model calls are replayable: `LlmRequest.reuse` asks the call
for the response a journaled call with the same request hash already holds, which is returned at no
charge, so an inner session that was paid for before the cut is not paid for again. A sketch node
is written when the session ends and registered in a second step (`registered: true`), so a cut
between the two loses nothing: the registration is idempotent (claims are `ensureClaim`ed, the edge is
looked up before it is made).

`packages/orchestrator/test/resume-m12.test.ts` also cuts a run across the ladder's move at every event with a stateful rung-1 line (it fails if the line is not started again) and runs M12 in turns of 1, 1500 and 3000 tokens (a sample), and `resume-adopted.test.ts` pins the recovery of a line's other claims when the problem's candidate was adopted. It cuts a whole M12 run (a sketch with two holes, both
proved, the parent settled) after **every event of its journal except the last** (every cut but the last: 69 cuts at the time of writing) and resumes
each: the run ends, the journal is sound, and for every cut at which no session was in flight the
problem has the outcome, the attempts, the cost and the claims, edges, tasks and statuses of the run
that was not cut. A cut inside the outer session loses the session's sketch, so it only has to end
soundly. This is one scenario with one outer prover, not a matrix of runs.

## Tests, and what has not run

`packages/scheduler/test` covers the pieces: the kernel (the ratio, fairness, ties by seed), proof
numbers (AND, OR, shared claims, cycles), the hole reader, the pricing, the ladder's measure,
and subsumption with a simulated `lean.meta`. `packages/orchestrator/test/m12.test.ts` runs the line
in whole runs: two holes proved and the parent settled through propagation, the briefing's feed
within the inner budget, `maxInnerTasks`, a sketch that cannot be split, the ladder (a rung-1 stand-in
starts when the problem moves up, no move on progress, the ladder off) and the report's rung table.
`packages/fleet/test/owners.test.ts` covers the owner choice.

Everything runs with a simulated Lean, a faux model and a faux `lean.meta`. **Not run** against a
real Lean or model: the link lemma's proof (`intro h_aux_k ...; refine fun ...`), the tactics that
close an `instance_of` link lemma, the `lean.meta` instances call, the inner prover's prompt, and the
price model (the prior of $0.05 a session and the 0.3 and 0.6 fractions are untuned). The lines of
rungs 1 and above do not exist yet.
