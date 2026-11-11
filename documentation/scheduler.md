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

## Blueprints (plan change CA9)

Task 37. The option `blueprints` (off by default; `--line-option M12.blueprints=true`) reads a sketch as a **blueprint**: a sketch whose holes may
depend on each other. Without it nothing in this section applies, a `-- uses:` line is a comment, and M12 reads a sketch as described above.

A hole declares what it may use with a comment line **directly above it** (no blank line between them):

```lean
lemma aux_left (n : ℕ) : 0 + n = n := by
  sorry

-- uses: aux_left
lemma aux_right (n : ℕ) : n + 0 = 0 + n := by
  sorry
```

No `uses` line means no dependency. The **target is the sink**: it uses the holes its main proof names. A blueprint is accepted when

1. Lean checks the file with no error (`sorry` warnings allowed), as for any sketch (the record's `healthy`);
2. every name in a `uses` line is a hole of the same blueprint;
3. no hole restates the target (the statement id of the hole is the target's: the refusal's class is `restates_target`, `SketchRecord.failureClass`);
4. the dependency graph has no cycle;
5. every hole reaches the target: it is named by the main proof, or used, directly or through other holes, by a hole that is.

A hole's **statement** still may not name a hole, as before (a statement that depends on an unproved lemma's name cannot be lifted out of the file), and
no other aux command may rest on a hole. What the option changes is that the holes may use each other in their proofs, as declared. A blueprint that fails a rule is
refused as a sketch that cannot be split is: the `m12_sketch` node holds `healthy: false` and the reason in `problem` (`the dependency graph has a cycle:
aux_a -> aux_b -> aux_a`), and no claim, edge or task is made. A blueprint's record also holds `blueprint: true` and `uses`, the declared names of each hole.

**The link lemma and the dependency edges.** The target keeps its edge and its link lemma as before: `decomposes_into` from the problem's claim to all the holes, whose
link lemma `(T1) -> ... -> (Tn) -> (F)` Lean proves from the sketch's main proof. A hole that declares dependencies gets a `decomposes_into` edge of its own, from its claim
to the claims of the holes it uses, and its link lemma takes the dependencies as hypotheses: `(D1) -> ... -> (Dk) -> (H)`, proved by the hole's own proof with the dependencies
introduced as `h_aux_j` under their names (the same `intro ...; refine fun <binders> => ?_; have aux_a := h_aux_1; <proof>` as the target's). That lemma is checked when the
hole's work is done ([Hole sessions](#hole-sessions-plan-change-ca10)). The rule is the one of every edge: **only a `lean_checked` edge propagates**. So a hole is derived
from its dependencies only once its link lemma passed Lean and every dependency is `computed` (or better): the graph composes the hole's proof from the link lemma and the
dependencies' own proofs, in dependency order, and the composed proof goes through `validate` like any derivation (`realize`). A dependency that is refuted or
never accepted derives nothing, and the hole is not validated.

**Trust is unchanged.** Nothing here sets a status. The problem is settled only when the assembled file, the holes replaced by their accepted proofs in dependency order,
goes through `validate` (the composition of the target's link lemma and the holes' proofs) and the certifier.

## Hole sessions (plan change CA10)

With `blueprints` on, a hole's inner work is a real session with tools instead of one model call. It runs through the orchestrator's service
`ProblemContext.holeSession` (`hole-session.ts`: `runSession` on the hole's own workbench; the scheduler package does not import the orchestrator). The session
has `lean_check`, `lean_edit` and `hole_verdict`, a prompt that is its only context, and a **small file**: the claim's header, the hole's declared dependencies as
**stubs** (`lemma aux_a <statement> := by sorry`, in the aux region), and the hole. Nothing else is in the file or the prompt: no outer notes, no other holes, no sketch.
Its length is the option `holeTurns` (12 by default); a hole's task has `holeSessions` sessions (2 by default, since a session is a whole tool loop). Its responses are
`model_call.finished` events of `line:M12` at the site `scheduler.hole`, charged to the problem's ledger, so the report counts them.

**When the work is done (CA10).** `readWork` (`hole-work.ts`) is the line's rule on the last check: Lean reports no error, nothing changed outside the regions, a stub that is in the
file is exactly the dependency's statement with the proof `sorry`, and the rest of the file (helper lemmas, the hole's proof) has no `sorry` or `admit`; so every `sorry` Lean reports lies
in a dependency stub. A check that satisfies it ends the session (`afterCheck`). Work done is **recorded, not a status**: the `m12_session` node holds `workDone`, the proof and its helper
lemmas as a blob (`work`) and their sha256 (`workHash`). A hole without dependencies has no stub: its check is the workbench's, and a proof Lean accepts makes the claim `computed` as before.

**When the claim becomes `computed`.** Only when its proof, with its dependencies' accepted proofs in place of the stubs, passes `validate`. The line checks the link lemma `(dependencies) -> (hole)` with the
hole's proof ([Blueprints](#blueprints-plan-change-ca9)); the graph then derives the hole by `realize` from the link lemma and the dependencies' proofs, and the composed proof goes through `validate`. So a hole whose dependencies
are not accepted yet **waits** (its task ends with the reason "the work is done on stubs...", and `ensureTasks` makes no new task for it) and is validated, in dependency order, at the step after its dependency is accepted
(every step propagates). A hole whose dependency is refuted, or never accepted, is not validated.

**Waves, bounds and the gate.** All open holes whose pre-flight passed are eligible at once (their dependencies are stubs, so they do not wait for each other); the task order is the given-clause loop's, and `maxInnerTasks`,
`rounds` and `stepTasks` bound the work as before. A hole's task is proposed with the budget `{sessions: holeSessions, turns: holeTurns}`; the budget gate prices it as a task (`taskUsd(sessions, turns)`: sessions times the cost of a session, scaled by `turns / 12`,
12 being the length the mean or the first guess of $0.05 stands for) and may skip it, as it does any task ("the budget gate skipped it"). `TaskBudget.turns` is an optional field ([journal.md](journal.md)).

**Resuming.** Everything is read from the memory's nodes and the ledger. A session cut after its record was written resumes exactly (the verdict node is made again from the record: `repairVerdicts`); **a session cut while it was running is lost and is asked again and paid again** (the model's
responses of the cut session were charged and are not replayed). Resumption is tested with cuts at every record of a blueprint run except inside a session.

## Pre-flight (plan change CA11)

Before a hole's first paid session, once (an `m12_preflight` evidence node, so a resumed run does not repeat it), at no model cost, through the service `ProblemContext.holePreflight` (`hole-preflight.ts`):

1. the hole is type-checked: part of the blueprint's acceptance (Lean checked the file) and of its reference file;
2. the **battery** of line M10 (its core tactics, 30 Lean seconds, `validate` for a win) on the hole: a hole it proves is `computed` with no session, verdict `proved`. M10 itself runs only at `beforeProvers`, on the holes that exist then; the pre-flight is how a hole registered later is tried. A battery proof of a hole
   needs no dependency as hypothesis: the hole's statement stands alone (a statement may not name a hole), so its proof is a proof of the claim itself, which is stronger than a proof from the dependencies;
3. `plausible` through Task 36's `plausibleTest` (recorded as a `hygiene` node of the claim). A counterexample is a `suspect_false` node (source `plausible`) and stops nothing;
4. a short attempt of the battery on the hole's **negation** (no model call). A proof of the negation goes through `validate` with the negation flag; if it passes, the verdict is `statement_wrong` with a Lean-checked negation and the hole gets no session.

M11's small models are **not** asked: the line cannot reach M11's check through a service without a new dependency, and this is a marked extension point (`holePreflight` is where it would go). Not run against a real Lean: the
tactics' behaviour on real holes.

## Verdicts (plan change CA11)

Each hole session ends with one verdict, a memory node of kind `hole_verdict` (`HOLE_VERDICT_KIND` of `@seshat/core`, re-exported by `loop-telemetry.ts`) with `data.verdict`, `claimId`, `sessionId` (`<task>:<n>`, or `<task>:preflight`), `taskId`, `problemId`:

- `proved`: the work is done (above) on a hole with dependencies, or `validate` accepted the proof of a hole with none, or the battery proved the hole. A hole with no dependency whose file is done but which `validate` refused (a forbidden tactic, an axiom) is `too_hard`, with the validator's reasons in the session record;
- `statement_wrong`: the prover says so through `hole_verdict`. If it gives a Lean proof of the negation (`negation_proof`), the line sends it through `validate` with the negation flag; only when it passes is the node marked `negationValidated` and the claim's negation `computed` (a valid negation validation; the certifier alone makes it `refuted`);
  the hole then gets no more sessions. If it gives only an argument, a tool's counterexample, or a proof Lean refuses, the verdict is still recorded, with a **`suspect_false` evidence node** on the claim (`checked: false`), and **no status changes**;
- `too_hard`: the session ended (turns, budget, or the model stopping) with no proof, or the model said so. A session that ends without saying anything is `too_hard`. A `proved` that the model says without a last check that shows it is `too_hard`. A session that ends in an error (an exception, or the model or Lean could not be reached) is no verdict: its record has `stop: "error"` and no `hole_verdict` node is written; the session counts against the hole's limit.

A suspicion never stops work on the parent by itself and never propagates: the claim stays `open`, no edge changes, and the next outer session's briefing lists it under "Suspected false, UNVERIFIED". A hole with a Lean-checked negation is listed as a fact. Task 33's telemetry
(`loopTelemetry`) counts the `hole_verdict` nodes and reports the share whose verdict is `statement_wrong` **with a Lean-checked negation** (`negationValidated`) as "turned out false"; the verdicts that only a prover or a tool says are false are shown apart ("suspected false, unverified") and are not counted as false.

## Options of M12

| Option | Default | Meaning |
|---|---|---|
| `subgoals` | true | named holes as claims and tasks |
| `innerSessions` | 8 | one-call sessions of a hole's task (without blueprints) |
| `maxInnerTasks`, `rounds`, `stepTasks` | 8, 2, 2 | the bounds above |
| `ageRatio`, `weightRatio` | 1, 4 | the given-clause ratio |
| `subsumption`, `subsumeFacts` | true, 40 | closing claims by known facts |
| `ladder`, `fractions` | true, [0.3, 0.6] | the escalation ladder |
| `blueprints` | false | blueprints, hole sessions, pre-flight, verdicts (CA9 to CA11) |
| `holeTurns` | 12 | model responses in a hole session (blueprints only) |
| `holeSessions` | 2 | sessions of a hole's task (blueprints only) |
| `seed` | null | the scheduler's draws |

What M12 records: `m12_sketch` (a sketch; with blueprints also `blueprint`, `uses`, `failureClass`), `m12_session` (a session; with blueprints also `stop`, `turns`, `verdict`, `workDone`, `work`, `workHash`, `negationValidated`, `argument`),
`m12_subsumption`, `m12_preflight`, `hole_verdict`, `suspect_false`. All are facts, none a status, none learned.

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

Line `M18` ([curriculum.md](curriculum.md)) is the line of rung 1 and `M15` ([archive.md](archive.md)) a line of rung 2; `M16` (rung 2 in the plan) is not built. The ladder is tested
with a stand-in line of rung 1, with M18 and with M15. Dollars that a rung's line spends count in the problem's spend since its last Lean
progress, so M18's variants hasten the move to the next rung; a proved variant is not Lean progress (it is no subclaim of the target).

## The budget gate

Task 29 (PB1 to PB5 of `plans/plan-change-proportional-budgets.md`, Ruling 31). Before this, a problem spent its whole budget whatever its chance of success was: every prover started at once and every session ran until the budget stopped it. The gate puts a price against a chance before each paid launch. It is **off by default** (`harness run --gate`, `RunConfig.gate`); without it nothing here applies and the run is as it was. The rule and the probe live in `@seshat/scheduler` (`gate.ts`), the orchestrator applies them (`budget-gate.ts`), and the answer is journaled as `budget.gated` ([journal.md](journal.md)).

**The rule (PB1).** A launch has an estimate (dollars, from the mean cost of the sessions already paid on the problem, or a first guess when there are none) and the claim's chance of success, a Thompson draw from its success posterior ([fleet.md](fleet.md#posteriors)). The launch goes ahead when

```
estimate <= share(site) x remaining x pSuccess
```

where `remaining` is what is left of the problem's budget and `share` is the part of it one launch of that site may cost: `wave` and `session` 0.5, `task` 0.25, `judge` 0.1 (`--gate-share SITE=X`). The rule is a function of its numbers, so the same numbers give the same answer. The draws (the Thompson draw, the flat prior's, the floor's) are seeded by the run's seed and a key of the **request**: the problem, the site, and the prover and session, or the task, or the round of the wave. They do not depend on the row the answer lands on, so provers that ask at the same moment, in whatever order, draw what they would have drawn alone, and a resumed run asks the same question and gets the same answer. The posterior a draw is made from does depend on which attempts have finished; it is recorded in the row's reason. `budget.gated` carries the numbers (the estimate, what is left, the budget, the share, the chance, the threshold, the rung) and the reason in words, with the posterior ("Beta(a, b) from n attempts"); the journal recomputes the threshold and refuses an answer that does not follow from it.

**The floor (PB2).** A fixed fraction of the launches the rule would skip go ahead anyway (`--gate-floor`, default 0.1; a draw under the fraction). Without it a posterior that is wrong would never be corrected, since a skipped launch produces no evidence. A launch the floor let through says so (`by: "floor"`, `exploration: true`) and the report counts them and their estimated price. The row carries the draw and the fraction (`floorDraw`, `floorFraction`), and the journal refuses a floor row whose draw is not under its fraction, or whose estimate is not over the threshold (the floor lets through only what the rule skipped; a widening for want of Lean progress has no threshold to check). A floor of 0 turns it off.

**Where `decide` is asked (PB3).** The rule has no numbers at a cold start (no attempt counted on the claim) and is near its threshold at a tie (the estimate within the margin, `--gate-margin`, default 0.1, of it). Only there is the question put to `decide` at `budget.wave` (a wave of provers, or a session of one) or `budget.line` (a line's task, or a judge call), as a choice between `launch` and `skip` ([decide.md](decide.md)). The state of the question holds counts and dollars and no mathematics. A decision that is off, fails, or is not made leaves the rule's own answer, which at a cold start is the rule on the flat prior's draw. The answer is booked in the journal with `by: "decide"` and its decision id, and the journal checks that the decision is in it, is about this problem, was asked at `budget.wave` (a wave or a session) or `budget.line` (a task or a judge call), and answered what the row does. The model calls cost money, are booked to the pseudo-line `gate`, and the report adds them up.

**Probe first (PB4).** A problem does not start with its whole fleet. The first prover runs one session under a child ledger of at most a tenth of the problem's budget (`--gate-probe`, default 0.1); its stop is `probe`, a pause, not an end. The gate then answers once for the wave: it **widens** (the other provers start and the first one resumes) when the probe made Lean progress (the measure of the ladder above: a subclaim proved, or fewer open holes, or an attempt that failed deep enough to count as progress), or when the floor lets it through, and otherwise **skips** (`by: "progress"`: the first prover ends with the stop `gate` and the other provers never start). A widening after progress is still under the rule: it can be refused for its price. Sessions after the first `minSessions` (default 2, `--gate-min-sessions`) of a prover that goes on are gated at the site `session`: one low draw cannot end a widened prover after its first session, and the tasks of a line and its judge calls at `task` and `judge`: a task the gate skips is cancelled with the reason "the budget gate skipped it".

**A problem the gate stopped.** Without a team the stop ends the problem: it is `unsolved`, its first prover has the stop `gate`, the others are cancelled, and a resume of an interrupted run keeps it stopped. In a run with turns (`--human` or a turn limit, [human.md](human.md)) the stop does not end the problem: the turn ends at an impasse (`breakpoint.kind` `impasse`, the problem named), the probe's prover stays paused and the others ready, and the problem waits for the team. The next turn, after a hint, a steer or a new budget, asks the gate again, with the draws of a new round (the floor has another chance), and the probe is not run again. A stop is final only within the turn, the ladder rung and the budget it was given at (`turn` is a field of `budget.gated`); if nobody changes anything the gate may stop the problem again, and the team may drop it (`harness steer --drop`).

**The price of a task.** A line's task is priced at its sessions times what a session costs (`taskUsd`): the chance of success is in the rule's threshold and is not counted in the price too. A line that gives its own `pSuccess` to `budget.ask` must give a number from 0 to 1; anything else is refused before it is journaled.

**A claim certified earlier (PB5).** With the gate on, a problem whose chain already holds the claim proved or refuted (a run on `--memory-from`, under the same Lean environment, where the memory carries the status over) is not launched again: the problem ends `skipped`, the journal holds a `budget.gated` row `by: "memory"` and no model or Lean call is made. The estimate of that row is the price of one session, and the report counts it as avoided spend. Without the gate the loop launches the problem again, as it always did. The soft failure memory ([fleet.md](fleet.md#soft-failure-memory)) has no state in which a claim is exhausted for good: what it records of past failures lowers the chance, and the gate prices that.

**In the report and the table.** The report adds a paragraph and a table of the gate by site (launched, skipped, let through by the floor, decided by `decide`, avoided dollars) read from the journal alone, with no model call (PB8). The avoided dollars are **an estimate** at the moment of the skip, not money that was spent or measured, and they are marked as such wherever they appear. What the gate is worth is measured by `harness ablate --experiment gate` ([ablate.md](ablate.md#experiments)): four arms, no gate, the rule, the rule with `decide` asked of the model, the rule with `decide` asked of Jev, on the same problems and budget, compared by cost to first success.

**Resuming.** The settings are written into `run.started` and a resumed run reads them back; the answers already journaled are not asked again.

**Not run.** The gate is tested with a simulated Lean and the faux provider: the rule and its arithmetic, determinism, the floor's rate over many draws, the probe cap, widening and skipping, `--memory-from`, the report, resume. Whether it pays on real problems, whether its defaults (shares, floor, probe fraction, margin, `minSessions`) are right, and whether Jev answers its two sites better than the model, have not run.

## The budget in rounds

Task 35 (plan change CA8). In the first real runs the first problem took 92% of a run's budget. With `RunConfig.budgetRounds` and a run budget `runUsd` for K problems, the problems are worked round-robin, a slice at a time. It is **off in `harness run`** (and with one problem, or without `runUsd`, it changes nothing) and **on in `harness solve`'s defaults set `v2`**. The rotation is `rounds.ts` of the orchestrator; it only decides which problem gets the next slice and how large it is, and nothing inside a slice differs from a problem worked alone (the gate, the probe, the ladder and the lines act as before).

- **The cap.** In round r (from 0) a problem may have spent at most `runUsd / (4K) x 2^r` **in all** (`roundCap`). Its slice is that cap less what it has already spent, and never more than the problem allowance `problemUsd`, which still binds. The slice is a child ledger of the problem's: when it is spent the provers pause with the stop `slice` (their tasks stay running, nothing ends), as the probe's provers do, and the problem asks the rotation for its next slice. The provers then go on from where the journal says they stopped (the file, the last check, the notes), a session the cap cut being counted as a session used, as in a resumed run.
- **Parking.** At the end of a round, every problem whose slice ended and that is not solved is measured. It has **Lean progress** when the ladder's measure improved since the round began (a subclaim proved, or fewer open holes, `progressOf`), or, as the budget gate's probe reads it, a check typed every step and left only goals (depth `PROGRESS_DEPTH`) where none had. A session that the slice cut is no failure: its `failureClass` stays absent, and the class of its last check is kept apart in `lastCheckClass` of `attempt.finished` (only when the option is on), which only this measure reads, so that its progress is seen. A problem without progress is **parked**: `problem.parked` is journaled, and what it did not spend stays in the run's budget for the others.
- **Taking up again.** The next round is made of the problems that went on. When every problem is solved or parked and budget remains, the parked problems are taken up again, in a round of their own with the next, larger cap (`budget.round` with `resumed`). A solved problem, or one that ended for any reason, leaves the rotation.
- **Order.** Slices are given in the order of the round (the run's problem list), at most `concurrency` at a time; the same journal and outcomes give the same rotation.
- **The warning.** A run with the option warns once, in its log, when `problemUsd` is above `runUsd / K`: one problem can then take more than its fair share, up to the round's cap.
- **Journal and resume.** Every round is a `budget.round` event (its number, cap, problems, and the marks the round's end is compared with) and every parking a `problem.parked` event ([journal.md](journal.md)). A resumed run reads them (`recordedRounds`): it takes up the last round where it stands, a slice being over when the problem spent the cap, and ends the round, parks and begins the next as the run that was not cut would have; a problem that had a candidate when the process ended needs no slice, only its end. `packages/orchestrator/test/rounds.test.ts` cuts a run at every round, parking and problem end and holds that the rounds, their caps and the parked problems are the ones of the run that was not cut.
- **In the report.** A paragraph gives the rounds, the last cap and each parking.

**Not run.** Tested with the simulated Lean and the faux model: the arithmetic, the measure, three problems whose first would have taken the whole budget (without the option it does; with it all three are solved), one problem, the warning, and resumption. Whether the quarter of the budget of round 0 and the doubling are right on real problems, and how often a session cut by a small slice loses work that a longer one would have kept, have not run.

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
rung 2 do not exist yet.

**Blueprints, not run.** `hole-session.test.ts` and `blueprint.test.ts` run a blueprint of three holes (one depending on another: worked on stubs, waiting, validated after its dependency, the assembled proof through `validate` and the certifier), a cycle, an unreachable hole, an unknown name, a hole restating the target, the three verdicts, a wrong hole whose negation the simulated Lean accepts (and one with only an argument),
the gate's price and refusal, the session's file, and a resumption cut at every record of the wave, all with the simulated Lean and the faux model. **Not run** against a real Lean or model: the hole session's prompt and tools with a real model, the link lemma of a hole with dependencies, the battery and `plausible` on real holes, the price scale by turns.
