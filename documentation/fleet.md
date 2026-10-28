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

Every posterior counts an attempt with a weight: the discount of the runs on the problem since it, and the
probation of its epoch after a model upgrade or a change of prompts ([soft failure memory](#soft-failure-memory),
[memory.md](memory.md#memory-across-runs)). In one run and one epoch every weight is 1.

## What it decides

Before each session of a prover, the `beforeSession` hook decides, in this order:

1. **Whether the prover starts now** (the width, below). A prover that does not fit waits.
2. **The strategy** the session works on, one of M1's labels: drawn from the posteriors, or, for a share
   `epsilon` of the sessions, uniformly (the exploration floor). It becomes the session's briefing
   section "Strategy for this session" and the strategy declared on the attempt.
3. **The model** of the session, among the models the run is given; the strongest configured when a
   routing decision asked for `retry_stronger`; or the stronger model of an escalation.
4. **The settings** of the session, sampled from the configured distributions: temperature, thinking
   level, a diversity directive, the session mode (standard or informal-first).

The decision is written as an `allocation` node of the claim, and the attempt that follows carries
the strategy, the model, the settings and whether the exploration floor drew the strategy. When a run gives
the line nothing to choose (`strategies` off, no `models`, no settings), no node is written and the session
is M0's.

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

## Soft failure memory

A failure is soft evidence (plan change PE3): it says something about the configuration that failed
(a model, a budget, a prompt, a moment), not about the claim. Four rules keep an old or foreign failure from
shutting a door for good. None deletes anything; the journal keeps every attempt.

**Discount per run.** Every attempt carries `runsAgo`: how many runs on the problem lie between it and the run
that reads it (0 for the current run; each earlier run of a `--memory-from` chain that made an attempt on
the claim adds 1; a run that did not work on the claim is not counted, and the current run counts as 0 even
before its first attempt). The weight of an attempt in every posterior is

    gamma ^ runsAgo  x  probation(epoch)

with `gamma` the option of the same name (0.8), and `probation(epoch)` the weight of its epoch
(`MemoryStore.weightOf`: 1 for the current epoch, `k = 0.25` for each epoch opened since: the shrink of
Task 23 for a model, prompt or Mathlib change). So an earlier run's counts are multiplied by 0.8 on each
new run and shrunk again when the model changed, while a new outcome counts in full. The weighted update is
`Beta(alpha + w r, beta + w (1 - r))` for an observation worth `r`; an attempt still counts once in
`attempts`, whatever its weight. Example: two failures of the last run give the success posterior
Beta(1, 1 + 2 x 0.8) = Beta(1, 2.6), a rate of 0.278 against 0.25 at full weight; with the model changed
since, each also weighs 0.25, giving Beta(1, 1.4).

**Exploration floor.** With probability `epsilon` (0.1) a session's strategy is drawn uniformly among the
allowed labels (those no other prover is on), whatever the posteriors say, so that a strategy that failed ten
times is still tried now and then. The session is recorded: `exploration: true` on its `attempt.started` and
`rule: "exploration"` in its allocation; a session drawn from the posteriors records `exploration: false`
while the floor is on. The floor has its own random stream (`key:exploration`), so a session it does not take
draws what it would have drawn without the floor. `epsilon: 0` turns it off.

**Grouping by configuration.** M1's "already tried" section groups the attempts by strategy and by
configuration class (the model family and the budget class of the attempt's provenance stamp), and a line from
another class says so: `induction: 3 attempts, unsolved goals (with a smaller model)`. A model is weaker or
stronger by its place in the run's ranking (the option `ranking`, weakest first; otherwise the run's model, then
`escalateTo`). The order of the option `models` is not read as a ranking: it lists what to choose among, and
only `ranking` says which is stronger. A model the run does not rank counts as weaker than any it does (a
model that is no longer configured is taken for an older one). That default is safe for trust (it only changes
the words of an advice and which model a `retry_stronger` goes to) and right for the usual case, a run on a
better model than the earlier one; it is wrong when a run moves to a weaker model or sideways to another one:
it then reads the earlier, larger model's failures as "(with a smaller model)" and invites trying again what
a larger model failed. Set `ranking` (all the models, weakest first) when a run moves to a weaker or different
model. In one family the smaller budget class is the weaker. The session's own configuration comes first. The same rule is `compareClass` of
`@seshat/memory`.

**`retry_stronger`.** When a guard's finding would route a claim to `branch` (open an alternative under other
constraints) and every failure of the claim (this attempt included) ran under a configuration weaker than
the strongest one configured, the router records `retry_stronger` instead ([ledger.md](ledger.md#routing-decisions)),
and the prover's next session is given the strongest model: the allocation says `routed: "retry_stronger"`.
A claim is thus tried with the model it has not been tried with before it is tried with other constraints.
A failure from the strongest configuration, or none, leaves the `branch`. A session that was cut is not a
failure of its configuration. The next session takes the decision only if it is about that prover's last
attempt, and the escalation, which has its own caps, overrides it.

## Sampled settings

A line that samples a session's settings records them, so that they can be learned and reproduced (plan change
PC6). The fleet samples, when the options are given:

| Setting | Option | Sampled |
|---|---|---|
| `temperature` | a number, a list of numbers, or `{"min", "max"}` | a fixed value is recorded; a range is drawn uniformly (rounded to 0.01); a list is learned |
| `thinking` | a list of levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) | learned |
| `directive` | `true` (the built-in six) or an object from label to sentence | learned; the sentence is a briefing section "Directive for this session" |
| `mode` | `["standard", "nl_first"]` | learned |

The built-in directives are `small_cases`, `more_general`, `other_tool`, `shortest`, `skeleton` and `doubt`. Each is
worded to ask for no demonstration (M6's framing check finds nothing in them).

A discrete setting (and a temperature given as a list) is learned like a strategy: for each value, a Beta
posterior over the attempts of the claim that were given it (the `choice` reward, weighted as above), and
Thompson sampling picks the value with the highest draw; a value nothing is known of has the flat posterior, so
it is tried. The draws are in the allocation (`settingDraws`). The settings come from their own stream
(`key:settings`).

The settings are in the `settings` of the session's `attempt.started`, and they act: the orchestrator sends the
temperature with each request of the session, and runs it at the thinking level (the run's own otherwise). Lines
that sample are merged key by key, in the order of the lines; a temperature outside 0 to 2 or an unknown thinking
level is a line failure in `beforeSession`.

## Informal-first sessions

With `modes` including `nl_first` (plan change PC11 item 1), a session drawn for that mode works from a step DAG:
the informal argument broken into steps, written before any Lean. This is the ProofFlow idea (an informal
argument made a graph, then formalized step by step), and it is a proposal throughout: nothing it records is
a verdict, and only Lean, through `validate`, ever changes a claim's status.

1. **The DAG.** The first informal-first session of a claim asks the model for the argument as a `completeJson`
   (site `fleet.dag`, the model of the session): `proof`, `steps` (`id`, `statement`, `dependsOn`), and a `doubt`
   when the model thinks the statement false. Provers that ask at once share the call.
2. **The check.** The harness checks the shape (`checkStepDag`): at most `dagSteps` steps, ids that are short
   lowercase names and unique, every dependency a step, **acyclic**, **no forward reference** (a step is listed
   after the ones it uses), and **every step but the last used** by a later one. A DAG that does not check is sent
   back once with what was wrong. Two tries that fail leave a `step_dag_failure` node and the session runs as a
   standard one; the allocation says why (`dagNote`). The attempt records `mode: standard`, the mode that ran,
   which is the arm its outcome counts for, and `drawnMode: nl_first`, the mode that was drawn. After
   `MAX_DAG_TRIES` (2) failed tries on a claim no more are paid for.
3. **The record.** A checked DAG is a `step_dag` node of the claim (learned, so stamped), each step is an
   `informal` claim of origin `line:fleet`, and the `decomposes_into` edges (each step from the steps it uses, the
   target from the last step) are proposals. The claims stay `open`. The node is written last, so a process that
   ends in the middle leaves no half-recorded DAG; the claims and edges are safe to write again.
4. **The session.** The briefing section "Step plan" gives the argument, the steps, and what Lean said of each
   after the session before (not the model's `doubt` about the statement: that is the verdict of another call,
   which no prompt shows a prover, PC10; it stays in the node for the report); the prover writes one lemma `aux_<id>` for each step, in its aux region, and closes
   the theorem from them. The allocation names the DAG node.
5. **Lean's errors go to the step they are in.** After the session, a `step_status` node records for each step
   `closed`, `error`, `hole` (a `sorry`) or `missing` (no lemma), from the position of Lean's messages in the last
   check: a message belongs to the lemma whose declaration contains its line; an error outside every lemma belongs
   to the main proof and to no step. Only states are kept, never Lean's text. The next session is told which steps
   are not closed and leaves the closed ones as they are. Nothing is written about the steps' claims: a lemma that
   Lean accepts is not a proof of the step's claim in the memory, and the claim stays open.

The mode competes like any other setting: if sessions in this mode prove more, Thompson sampling draws it more.

## One loop at a time per (subgoal, strategy)

A subgoal is the session's `subgoal`, or the claim when it has none. Two provers working at once on
a subgoal are never told the same strategy: the draw leaves out the strategies the others are on.
Provers on different subgoals are independent. The Ralph loop that runs a strategy on a subgoal is
then one at a time. The prover takes its place (its strategy) as soon as the strategy is drawn, before the
informal-first DAG is awaited, so a prover that decides while another waits for its DAG sees the strategy as taken.

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
waiting prover looks again when another prover starts a session, when a prover ends, and when the
problem ends (its signal then stops it). A session starts after the attempt before it was
journaled, so what a prover reads then holds every attempt that finished. The fleet does not wake
the others in `afterAttempt`: the orchestrator runs that hook before it journals the attempt as
finished, and a prover woken there would read a posterior one attempt old. A prover is alive until
its loop ends (`afterProver`).

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
| `strategy`, `rule` | the strategy, and `thompson`, `continued` or `exploration` |
| `model`, `escalated`, `routed` | the model, when the fleet chose one, whether it is the stronger one, and `retry_stronger` when a routing decision chose it |
| `width`, `waited` | the width of the subgoal when the prover was admitted, and whether it waited for a place |
| `successRate`, `attempts` | the single-agent rate of the claim and the attempts it is made of |
| `draws` | the draw of each candidate strategy, rounded (absent for an exploration draw) |
| `settings`, `settingDraws` | the settings sampled, and the draw of each value of the learned ones |
| `dag`, `dagNote` | the `step_dag` node an informal-first session works from, or why a session drawn for that mode ran as a standard one |

## Options

`harness run --lines M1,fleet --line-option fleet.maxWidth=2 --line-option 'fleet.models=["PROVIDER/ID","PROVIDER/ID"]'`.

| Option | Default | Meaning |
|---|---|---|
| `strategies` | true | tell each session a strategy |
| `stick` | true | keep a strategy while Lean gets further with it |
| `models` | `[]` | `PROVIDER/ID` models to choose among; empty: the run's model. The order says nothing about strength: `ranking` does |
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
| `gamma` | 0.8 | the discount of an earlier run's evidence, per run on the problem |
| `epsilon` | 0.1 | the share of sessions whose strategy is drawn uniformly (the exploration floor) |
| `ranking` | null | models weakest first, `PROVIDER/ID`, the only statement of which is stronger; null: the run's model, then `escalateTo` |
| `temperature` | null | a number, a list to learn over, or `{"min": 0.2, "max": 1}`; null: the run's own |
| `thinking` | null | thinking levels to learn over, such as `["low","high"]`; null: the run's own |
| `directives` | null | `true` for the built-in directives, or an object from label to sentence |
| `modes` | null | `["standard","nl_first"]`; null: every session is a standard one |
| `dagSteps` | 8 | the most steps in an informal-first session's DAG |

## Resuming

The fleet declares `resume: "rebuild"`. Its decisions are already `allocation` nodes, so
`resumeProblem` reads them: for each prover that is still alive, the strategy of its last
allocation whose session was not cut becomes the one it sticks to (`last`); the claims the problem
worked are added to the run's; and the gate learns of the provers that had ended (their task is
finished), so that no place is held for them and a prover that was waiting does not wait for them.
The Thompson draws come from the seeded source and the posterior of the journal, so a resumed run
draws what the run that was not cut drew; the tests compare the allocations, draws included. An
`allocation` node written for a session that never started stays, and is not counted as an attempt.

Everything the soft failure memory and the settings need is rebuilt from the journal and the seeded streams: the
weights come from the `runsAgo` and `epoch` of the attempts, the learned settings and the exploration flags from
the attempts' `settings` and `exploration`, the step DAG and its states from the `step_dag` and `step_status`
nodes, the pending `retry_stronger` from the routing decisions of the ledger. The one thing held in the process is
the promise that makes provers who ask for a DAG at once share a call; it is only a deduplication. A process that
ended after the DAG call was paid and before the DAG was recorded asks for it again on resuming, and pays for the
call twice (the same as any call of a line made between two sessions).

## The hooks it uses

`beforeSession` (the decision above), `briefing` (the section "Strategy for this session", worded to
ask for no demonstration: M6's framing check finds nothing in it), `briefingSections` (the directive and the
step plan), `afterAttempt` (the strategy the prover was on is free for the others, and the states of the
steps of an informal-first session are recorded), `afterProver` (the prover is no longer ahead of anyone, and the
waiting provers look again) and `afterProblem` (the policy's state of the problem is dropped). The
line API got `afterProver` for this and for M6 ([lines.md](lines.md)).

## Tests and what is not done

`packages/fleet/test` covers the pieces: the seeded source and the Beta and Gamma draws, the
posteriors on scripted attempts, Thompson choices with a seeded source (a strong arm wins most
draws, a flat one is explored), the width and its caps, the gate (order, caps, release when a prover
or the problem ends), the escalation, and the hooks on a real journal with stub contexts that run
`afterAttempt` before they journal the attempt, as the orchestrator does.
`packages/orchestrator/test/fleet.test.ts` runs the line in whole runs with the simulated Lean and a
faux model: the strategy told and journaled, the same seed drawing the same strategy, a strategy kept
while Lean gets further, the models chosen and escalated, a model that does not exist, the width
(provers let in when the attempts that made the posterior low are in the memory, before the first
prover's next session does any work; kept out while a single agent does well), the strategies of
provers that work at once, its section next to M6's question on an open conjecture, and, with two
provers over two sessions, that the second opening of each has its own notes and file and none of the
other's, beside the typed summaries of the memory.

- `packages/fleet/test/soft-memory.test.ts` covers the discount arithmetic (`gamma ^ runs x probation`, the runs
  that did not work on the claim, the weighted Beta update), the share of the exploration floor over a seeded run
  (and its off and all-on cases), the sampling of the settings and what is learned over them, the shape of a step
  DAG (cycle, forward reference, unused step, unknown dependency) and the states of the steps from Lean's
  messages. `packages/orchestrator/test/soft-memory.test.ts` runs them in whole runs: the temperature and the
  thinking level reach the model, the informal-first session end to end (the DAG call, the nodes, the claims and
  edges, the plan in the briefing, the states of the steps in the next session, the fallback to a standard
  session), `retry_stronger` against `branch`, and a chain of two runs for the discount and "(with a smaller
  model)". `packages/memory/test/classes.test.ts` covers the grouping by configuration class and the rule behind
  `retry_stronger`.
- `packages/orchestrator/test/resume-lines.test.ts` resumes runs of the fleet at each boundary between
  sessions (the same allocations and draws, the same prompts) and at every event of the journal,
  and checks that a prover does not wait for one that had ended; the same for sampled settings with the
  floor on, and for informal-first sessions, at a sample of the events.
- Nothing ran against a real model or a real Lean. The simulated sessions take no time, so the gate is
  tested for its order and its caps, not for how much it speeds a real run up. In particular the
  step DAGs are written by a faux model, so whether a real model writes DAGs that check, and whether the
  informal-first mode proves more than the standard one, is not known; the temperature and thinking levels
  are checked to reach the provider's request, not for what they do to its answers. Some providers reject or
  ignore a temperature when reasoning is on; a temperature together with a thinking level is untested here, and
  `settingsProblem` checks only the range.
- The numbers (the width thresholds, 2 attempts, 4 and 8 provers, the escalation after 3 attempts
  under 0.25, a partial credit of 0.5, gamma 0.8, epsilon 0.1) are a first guess to set on the bench.
- `retry_stronger` arises only from a guard's `branch` signal (M6's loops), the one route to a branch there is;
  without M6 nothing routes to it. The strength order is the run's own statement (the `ranking` option), not a
  property of the models. The settings posteriors are per claim, like the strategies'.
- Nothing gives a session a `subgoal` other than its claim yet; the saturation kernel (M12) will, and
  the width and the exclusion of strategies then apply per subgoal.
- A model's cost is not in its posterior: Thompson sampling chooses the model that gets further, not
  the cheapest one per result.
- The posterior of a strategy is per claim, and that of a model per run: nothing carries what
  worked on one problem to another.
- No effect on the success rate is measured: that is what an ablation of `fleet` against the run
  without it will say.
