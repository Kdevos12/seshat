# Line M10: the classical battery, the domain router, ATP and SMT

Plan §7 step 4, "the cheapest gain": before any model works on a goal, classical tools try it. The
package is `@seshat/classical`. This page describes what is built; the end of it says what has not run.

For a goal (the problem's target, or a subgoal that is a claim of the memory), in the order of plan §15:

1. the **domain router** reads the statement and names its decidable fragment;
2. the **Lean battery** runs the tactics the host's Lean has, in the order of their posteriors, a few
   at a time, under a CPU budget, and stops at the first success;
3. a success is **submitted through `validate`**: it makes the claim `computed` at most, and only the
   certifier's kernel replay makes it `proved` ([lines.md](lines.md#validate));
4. ATP and SMT with reconstruction (below, as they are built) and only then a model, whose briefing
   says what was tried.

Nothing here raises a status. A tool's answer without a Lean proof is evidence or a `computed` edge,
never a status (Ruling 13).

## The statement reader

`parseStatement` (`parse.ts`) reads a statement in signature form: binders (`(x y : ℕ)`, `{x : ℤ}`,
instance binders `[Mul M]`, type variables `(M : Type*)`, hypotheses `(h : n < m)`) and a conclusion
over arithmetic (`+ - * / % ^`, numerals), relations (`= ≠ < ≤ > ≥ ∣`), connectives (`∧ ∨ ¬ → ↔`),
`∀`/`∃` over named variables, and function application. It is no Lean parser: a cast (`↑`), a big
operator, a bounded quantifier, a lambda or a tuple make it throw `Unreadable` with the reason. The
router then files the goal as `general` and the translators leave it out.

## The domain router

`routeStatement` computes features (the sorts of the variables, whether the goal is closed, whether
a product or a power is nonlinear, whether a division is by a numeral, uninterpreted functions) and
files the goal under domains, most specific first. The tactics of the domains come in the order
decision procedures first, then the search tactics.

| Domain | The goal | First tactics |
|---|---|---|
| `closed` | no variable, arithmetic and relations | `decide`, `norm_num`, `simp` |
| `presburger` | linear over `ℕ`/`ℤ`, `%` and `∣` by numerals | `omega`, `simp`, `norm_num` |
| `linear_real` | linear over `ℝ`/`ℚ` | `linarith`, `norm_num`, `positivity` |
| `finite` | a variable of `Fin n` (n ≤ 64) or `Bool` | `decide`, `simp`, `omega` |
| `polynomial_identity` | an equation over a commutative ring, nonlinear | `ring`, `grind`, `norm_num` |
| `nonlinear_arith` | an order over a ring, nonlinear | `nlinarith`, `positivity`, `linarith` |
| `bitvector` | reserved for `BitVec` goals | `bv_decide`, `omega` |
| `propositional` | `Prop`/`Bool` variables and connectives | `simp`, `aesop`, `grind` |
| `first_order` | uninterpreted functions, operations on an abstract type | `aesop`, `grind`, `hammer`, `canonical` |
| `general` | anything else, including what the reader cannot read | `simp`, `aesop`, `grind`, `exact?`, `hammer` |

`grind` carries a commutative-ring module that normalizes by a Gröbner basis (the Lean reference,
section on the algebraic solver), so polynomial identities with hypotheses are one of its jobs: the
router lists it right after `ring` for `polynomial_identity`. `polyrith` is a candidate only when the
host's Lean has it: whether it is still in the pinned Mathlib is read from the host, not assumed.

The router is a guess from syntax. A wrong guess costs one failed try, and the posteriors below
learn it. Its precision (the share of goals whose winning tactic is in the first three of its list)
is what the report will measure once there are runs.

## The tactics, and what the host has

`TACTICS` (`tactics.ts`): `decide`, `omega`, `norm_num`, `simp`, `ring`, `linarith`, `positivity`,
`nlinarith`, `aesop`, `grind`, `exact?`, and the ones that need something of the host: `bv_decide`,
`polyrith`, `canonical` and LeanHammer's `hammer`. A try is the file `example <statement> := by
<tactic>` after the claim's header, checked by `lean.check` as the battery's actor (`line:M10`), so
each try is a tool run in the journal. A tactic that prints `Try this: ...` (`exact?`, `hammer`,
`polyrith`) is submitted as that suggestion, since a search tactic is not what a proof file should
keep.

The list is read from the host: `probeHost` elaborates `example : 0 = 0 := by <tactic>` for each
optional tactic and reads a parse error ("unknown tactic", "expected ...") as "not there". The line
option `packages` names what the host profile says it has (`hammer,canonical`) and skips the probe for
those. Nothing is assumed: a Lean without LeanHammer never sees `hammer`.

## The battery

`runBattery` runs the tactics in the order of `orderByPosterior`, at most `parallel` Lean checks at a
time (default 4), each with the tactic's own time limit cut to what is left of the CPU budget
(`cpuBudgetSec`, default 60, summed over the parallel tries). The first success aborts the checks in
flight, which are recorded as `aborted` and tell the posteriors nothing; so does a Lean that did not
answer (`error`). A timeout counts as a failure.

**Posteriors.** Each `(domain, tactic)` has a Beta posterior over its rate of success, where the
domain is the router's most specific one. The prior is the router's list for the domain
(Beta(3,1), Beta(2.5,1), Beta(2,1) for its first three tactics, Beta(1.5,1.5) for the rest, Beta(1,2)
for a tactic the domain does not name, flat for `general`): a few pseudo-counts that a handful of
tries outweighs. The counts are rebuilt from the journal when a run starts: `Posteriors.from(memory)`
reads the nodes `battery_run`, and nothing is kept in a file outside the journal. The order is
Thompson sampling (`order: "thompson"`, the default, seeded by the run's seed so that it replays) or
the posterior mean (`"mean"`). This is the hammers' strategy scheduling, learned online by counting,
with no training.

**The hammer at several cutoffs** (plan change PC6 item 2). With `hammer` available, the battery also
tries `hammer@16`, `hammer@64` and `hammer@256`, which is `hammer {aesopPremises := N, autoPremises
:= N}`, in parallel with the rest; the option `hammerCutoffs` sets them. The first success wins, and
each cutoff has its own posterior. The configuration syntax is written from the LeanHammer README and
has not run.

## `solveGoal`

`solveGoal(ctx, {claimId, header, statement})` is the unit the line and the `prove_auto` tool use:
route, battery, then `validate({claimId, proof})` for the winner. A proof `validate` refuses (the
statement it checked is the claim's reference, not the snippet) puts that tactic out and the battery
goes on, up to `maxSubmissions` refusals. Every run, solved or not, is recorded as a node
`battery_run` on the claim:

```
data: { statement, domains, tries: [{tactic, domain, outcome, timeMs, suggestion?}],
        solved?: {tactic, proof}, submission?: {verdict, status, validationId, reasons}, cpuMs, budgetSec }
```

`outcome` is `success`, `failed`, `timeout`, `error` or `aborted`.

## The non-triviality test

`closesWithCheapTactics(checker, goal, {cpuBudgetSec})` answers "do the battery's cheapest tactics
(`decide`, `omega`, `norm_num`, `simp`, `ring`, `linarith`, `positivity`) close this goal within this
CPU budget?" with a Lean checker alone, no line on, nothing submitted or recorded. Task 9's library
uses it to decide that a lemma is not trivial, and Task 13 will.

## Tests, and what has not run

`packages/classical/test`: the reader and the router on a table of goals; snippet generation; the
posteriors rebuilt from nodes and their order; the first-success stop, the parallel limit, the CPU
budget and abort; the host probe; the non-triviality test; `solveGoal` against a scripted Lean (a
refused proof, the allowed refusals, a failed run recorded). The scripted Lean (`test/fake-lean.ts`)
answers by tactic name and reads the layout of the file, not Lean's syntax.

Nothing has run against a real Lean: whether each tactic closes what the router sends it, whether
`Try this:` messages come as the code reads them, and the hammer's configuration syntax are open.
