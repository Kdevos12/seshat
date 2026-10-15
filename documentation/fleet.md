# Fleet policy

The fleet policy is an ablation line, `fleet` ([lines.md](lines.md)). A run enables it with
`harness run --lines M1,fleet` (the cumulative config `--ablation fleet` is M0 plus every line before
it in the plan's order, so it will run once those lines are built); without it the provers of a run
are the independent provers of M0 ([m0-loop.md](m0-loop.md)). It holds the plan's policy for a
fleet of provers (plan §11): what the next session of a prover works on, with which model, how many
provers work on a subgoal at once, and when a hard decision goes to a stronger model. The rules are
numbers and a random draw, never a model.

The line requires `M1`: its posteriors are made of the strategy labels and the failure classes that M1
gives each attempt when it finishes ([m1-identity-memory.md](m1-identity-memory.md)). The code is in
`@seshat/fleet`. The line is `createFleet(env)` in `fleet.ts`; `fleet` is `createFleet()`.

Provers never talk to each other. What one learns reaches the others only through the graph: the
attempts in the memory, and the typed lines of M1's "already tried" section. The fleet keeps, for the
length of a run, which prover works on which subgoal with which strategy and which provers wait for
a place. That is the policy's own state; nothing a prover wrote goes through it.

## What it decides

Before each session of a prover, the `beforeSession` hook decides three things, in this order:

1. **Whether the prover starts now** (the width, below). A prover that does not fit waits.
2. **The strategy** the session works on, one of M1's labels. It becomes the session's briefing
   section "Strategy for this session" and the strategy declared on the attempt.
3. **The model** of the session, among the models the run is given, or the stronger model of an
   escalation.

The decision is written as an `allocation` node of the claim, and the attempt that follows carries
the strategy and the model. When a run gives the line nothing to choose (`strategies` off and no
`models`), no node is written and the session is M0's.

## Posteriors

For each claim, the fleet reads its attempts (and those of the claims that M1 made equivalent) from
the memory store, which is the journal projected. For each (claim, strategy) and for each model it
keeps two Beta posteriors over the same attempts, both starting at Beta(1, 1) (nothing known):

| Posterior | A proof the fast check accepted counts | A failure counts | Used for |
|---|---|---|---|
| `choice` | 1 | `partialCredit` x depth / 7 | Thompson draws: which strategy, which model |
| `success` | 1 | 0 | the single-agent rate: width, escalation, stagnation |

The depth is how far the failed check got on the ladder of `@seshat/memory` ([the depth of a
check](m1-identity-memory.md#how-far-a-check-got)): 1 for a file that does not parse up to 7 for one
that is accepted but for axioms. So a strategy that leaves Lean with unsolved goals is worth more than
one that does not parse, and a model that gets further is preferred even before it proves anything.
An observation worth `r` adds `r` to the first count of the posterior and `1 - r` to the second. An
attempt that says nothing (no check was made, the session was cut short, the harness failed) is not
counted.

An attempt counts under the strategy M1 classified when it finished, not under the one it was asked
to work on: when the model followed another approach, the label that earns or loses is the one that
was used. `other` is never assigned.

`stagnating(posteriors, {below, minAttempts})` says whether every strategy tried on a claim has a
success rate under `below`, with `minAttempts` attempts counted. The fleet does not use it; the lines
that react to a stall (abduction, induction) read it.

## Thompson sampling

One draw from each candidate's posterior, and the highest draw wins. A strategy nothing is known of
has the flat posterior and so is tried; one that keeps failing is drawn lower and lower and is never
ruled out. For a strategy the candidates are the 12 labels, minus those a running prover has
(below); for a model they are the list `models`, with the posteriors of the run's claims so far. The
draws of the candidates are written in the `allocation` node, rounded.

The random source is seeded by the key `seed:problem:prover:session`, where `seed` is the option of
the same name (the run's id when it is null). The same seed and the same history make the same
draws, which is how a test or an ablation repeats a decision. `createFleet({random})` replaces the
source.

A prover keeps the strategy of its last session (`stick`, rule `continued` in the node) while Lean
went further in that session than in any earlier one of the prover and no other prover is on it;
otherwise it draws again (rule `thompson`). A strategy that gets Lean further is worth another
session.

## One loop at a time per (subgoal, strategy)

A subgoal is the session's `subgoal`, or the claim when it has none. Two provers working at once on
a subgoal are never told the same strategy: the draw leaves out the strategies the others are on.
Provers on different subgoals are independent. The Ralph loop that runs a strategy on a subgoal is
then one at a time.

## Width

Parallel work is where it pays: a subgoal gets more than one prover at a time only when the
single-agent posterior of the claim is low. `--provers N` is the largest fleet; the fleet lets as
many of them work as the width of each subgoal allows.

`widthFor` gives the width of a subgoal from its `success` posterior:

- 1 while fewer than `minAttempts` attempts counted (nothing is known), and while the rate is at
  least `widenBelow`;
- under `widenBelow`, `2 + floor(log2(widenBelow / rate))`, which with the defaults is 2 under 0.3,
  3 under 0.15, 4 under 0.075;
- never more than `maxWidth` (a subgoal) or `maxWidthProblem` (a problem).

The `Gate` applies it without the provers talking: prover `p3` may start a session when fewer than
`width` provers with a lower number are alive on its subgoal, and fewer than `maxWidthProblem` are
alive on the problem. The lowest prover alive is never kept waiting, so the gate cannot deadlock. A
waiting prover looks again after every attempt of the problem (the posterior has moved), when a
prover ends, and when the problem ends; its signal then stops it. A prover is alive until its loop
ends (`afterProver`).

With `widen` off every prover starts at once, as in M0; the strategies are still told, and still
differ among provers that work together.

## Escalation

With `escalateTo` set (`PROVIDER/ID`), a decision is hard when at least `escalateAfter` attempts
counted on the claim, the single-agent rate is under `escalateBelow`, and the claim has had fewer than
`maxEscalations` escalated sessions (counted from its `allocation` nodes, so a restarted run does not
forget them). The session then goes to the stronger model in place of the model drawn, and the node
says `escalated`. Escalation helps only when the main model is already strong (the plan cites
Cognition's measurements): it is capped for that reason and off by default.

A model name must be one the run's providers know. One that is not ends the problem as a harness
failure, before any session starts.

## `allocation` nodes

Recorded through the memory store as `line:fleet`; the package owns the shape of `data`
(`AllocationData`), and `allocations(memory, claimId)` reads them back.

| Field | Meaning |
|---|---|
| `attemptId`, `prover`, `session` | the session the decision is for |
| `strategy`, `rule` | the strategy, and `thompson` or `continued` |
| `model`, `escalated` | the model, when the fleet chose one, and whether it is the stronger one |
| `width`, `waited` | the width of the subgoal when the prover was admitted, and whether it waited for a place |
| `successRate`, `attempts` | the single-agent rate of the claim and the attempts it is made of |
| `draws` | the draw of each candidate strategy, rounded |

## Options

`harness run --lines M1,fleet --line-option fleet.maxWidth=2 --line-option 'fleet.models=["PROVIDER/ID","PROVIDER/ID"]'`.

| Option | Default | Meaning |
|---|---|---|
| `strategies` | true | tell each session a strategy |
| `stick` | true | keep a strategy while Lean gets further with it |
| `models` | `[]` | `PROVIDER/ID` models to choose among; empty: the run's model |
| `escalateTo` | null | the stronger model for hard decisions; null: no escalation |
| `seed` | null | seeds the draws; null: the run's id |
| `widen` | true | keep the provers at work on a subgoal to its width |
| `widenBelow` | 0.3 | the single-agent rate under which a subgoal is widened |
| `minAttempts` | 2 | attempts that must count before the rate is evidence |
| `maxWidth` | 4 | provers on one subgoal, at most |
| `maxWidthProblem` | 8 | provers on one problem, at most |
| `escalateAfter` | 3 | attempts on the claim before a decision is hard |
| `escalateBelow` | 0.25 | the rate under which a decision is hard |
| `maxEscalations` | 2 | escalated sessions per claim, at most |
| `partialCredit` | 0.5 | what the deepest failure is worth to a choice, against 1 for a proof |

## The hooks it uses

`beforeSession` (the decision above), `briefing` (the section "Strategy for this session", worded to
ask for no demonstration: M6's framing check finds nothing in it), `afterAttempt` (the prover's place is
free and the waiting provers look again), `afterProver` and `afterProblem` (the policy's state of the
prover and the problem is dropped). The line API got `afterProver` for this and for M6
([lines.md](lines.md)).

## Tests and what is not done

`packages/fleet/test` covers the pieces: the seeded source and the Beta and Gamma draws, the
posteriors on scripted attempts, Thompson choices with a seeded source (a strong arm wins most
draws, a flat one is explored), the width and its caps, the gate (order, caps, release when a prover
or the problem ends), the escalation, and the hooks on a real journal with stub contexts.
`packages/orchestrator/test/fleet.test.ts` runs the line in whole runs with the simulated Lean and a
faux model: the strategy told and journaled, the same seed drawing the same strategy, a strategy kept
while Lean gets further, the models chosen and escalated, a model that does not exist, the width
(provers let in as the posterior falls, kept out while a single agent does well), the strategies of
provers that work at once, its section next to M6's question on an open conjecture, and the notes of
one prover never reaching another.

- Nothing ran against a real model or a real Lean. The simulated sessions take no time, so the gate is
  tested for its order and its caps, not for how much it speeds a real run up.
- The numbers (the width thresholds, 2 attempts, 4 and 8 provers, the escalation after 3 attempts
  under 0.25, a partial credit of 0.5) are a first guess to set on the bench.
- Nothing gives a session a `subgoal` other than its claim yet; the saturation kernel (M12) will, and
  the width and the exclusion of strategies then apply per subgoal.
- A model's cost is not in its posterior: Thompson sampling chooses the model that gets further, not
  the cheapest one per result.
- The posterior of a strategy is per claim, and that of a model per run: nothing carries what
  worked on one problem to another.
- No effect on the success rate is measured: that is what an ablation of `fleet` against the run
  without it will say.
