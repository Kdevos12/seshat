# Repairs (line M14)

`@seshat/repair` mends what failed in two ways. A proof that failed is read by a table of typed repairs; a
conjecture that a data table refuted is mended by a Lakatos-style repair. Neither proves anything: a repair is a
suggestion in a briefing, or an `open` claim, and Lean judges what comes of it. The line is `M14`
(`createM14()`; `M14` is the instance the orchestrator registers); it declares `resume: "rebuild"`.

## The table of typed repairs

After Ireland and Bundy's proof critics. A `Situation` is what a failed attempt shows: the failure class of line M1
(`unsolved_goals`, `tactic_failed`, ...), its short typed detail (`unsolved goals at case succ`), the first
error or goal text Lean printed, the strategy of the submission and the proof. `situationOf(attempt, statement)`
builds it from a finished attempt. `REPAIR_TABLE` has four critics, in the order of preference; each reads some
classes of failure, says why it applies (or not) and what to do:

| Critic | Reads | Applies when | Directive |
|---|---|---|---|
| `induction_revision` | unsolved goals, a failed tactic, a type mismatch | an induction ends in its step case and the induction hypothesis is not what is stuck | induct on another variable, use strong induction, revert the hypotheses first |
| `generalization` | unsolved goals, a failed tactic | an induction whose hypothesis is in the goal and does not apply | replace the constant by a variable, prove the general lemma as an `aux_` lemma, take the statement as an instance |
| `lemma_speculation` | unsolved goals, a failed tactic, an unknown identifier | the proof is stuck on an equation or inequality outside an induction, or a lemma name was guessed | state the stuck step as an `aux_` lemma, prove the main result from it first |
| `case_split` | unsolved goals, a failed tactic | the goal has a disjunction, a conditional, a match or a parity | split the cases first (`rcases`, `by_cases`, `Nat.even_or_odd`) |

`CRITICS_BY_CLASS` places every class of failure (typed over `FailureClass`: a class added to M1 does not compile
until it is placed). The classes about the check, not the proof (`refused`, `lean_unavailable`, `timeout`,
`syntax`, `holes`, `axioms`, `statement_changed`, `restates_target`, `other`) have no critic: a fresh session fixes
a local error, and `restates_target` and `statement_changed` are routed up by the ledger, not repaired here.
`selectRepairs(situation, max)` returns the repairs that fit, in the table's order.

In the line, `afterAttempt` reads each failed attempt (valid ones are left alone), selects at most
`maxSuggestions` repairs, caps the total per problem at `maxRepairs`, and puts the directives in the next session's
briefing ("Repair suggested by the last failure"). The attempt's annotation is left alone. With `refine`, the top
repair is first written as a step DAG by a model (`induction.dag`, checked by `checkStepDag`; the steps are
informal claims with `decomposes_into` edges, plan change PC11 item 2), and when the next attempt submits `aux_`
lemmas their dependencies are measured against the DAG with ProofScore's dependency match, recorded as a
`repair_fidelity` node: a measure of how faithfully the formalization follows the plan, not a verdict.

## Lakatos-style repair

`lakatosRepair({table, verdicts, informal, statement, variable})` takes a data table and, for a conjecture, one
character per object (`1` it held, `0` it failed, `.` it says nothing there: the objects outside its premise). It
looks for a concept, a conjunction of at most two tests on the table's columns (a boolean column, a column equal to a
value, a threshold), that holds of every counterexample. Two repairs come out, and each makes the conjecture
hold only where the concept does not:

- exception-barring: a concept that holds of no object where the conjecture held (the exceptions, stated exactly),
  the simplest (fewest tests) first. Nothing that held is lost.
- monster-barring: when no concept separates exactly, the single test that holds of every counterexample and of
  the fewest objects where the conjecture held: the counterexamples are monsters, not instances of the redefined
  notion, at the price of the objects the test also bars. It is offered only if it keeps at least `minRetained`
  (half) of what held.

(Lakatos's two strategies are about a conjecture and its concepts, not about a table; this is the form they take
when the only material is a table. The distinction kept is the one that matters for what follows: whether the
repair costs anything that held.)

The repaired statement is the old one with the premise `¬ (concept)` added after its binders (`withPremise`), in
Lean when every column in the concept has a Lean form (`lean` on the column), the object's name taken from the
statement. Otherwise the repair is informal: an informal claim, whose argument goes through the step DAG first.

The line reads the hypotheses that line M8 recorded as refuted (`refuted_hypothesis` nodes, with the verdict on
every object of the table) and, for up to `maxLakatos` of them, makes the repaired conjecture a claim of its own:
`open`, origin `line:M14`, the problem's claim as parent and a `derived_from` edge to it, and a `lakatos_repair`
node with the concept, whether it is exact, what it keeps and loses, and some counterexamples. The refuted
hypothesis itself becomes no claim. The provers' briefing says which hypothesis was refuted, how it was mended,
and what the repair costs.

Options (`--line-option M14.<name>=<value>`): `lakatos` true, `maxLakatos` 3, `minRetained` 0.5, `critics` true,
`maxSuggestions` 2, `maxRepairs` 6, `refine` false.

## Tests, and what has not run

`packages/repair/test` has `critics.test.ts` (the table, each critic on a failure of its shape, the classes
placed), `lakatos.test.ts` (an exact exception-barring on the odd numbers with at most two divisors, a
monster-barring where no test separates, the cases with no repair, the statement with its premise, the Lean
form left out when a column has none) and `m14.test.ts` (a whole problem after line M8: the repaired claim, its
edge and node, resuming; an informal repair through the step DAG; the suggestions after a failed attempt and their
cap; the fidelity node). No test needs Lean, a model or a network: the model is the faux provider, and Lean a
simulated `decide`. Neither the critics nor the repairs have run against a real Lean or model, so the shapes the
critics look for in Lean's messages are those of the classifier of line M1, not measured on real failures.
