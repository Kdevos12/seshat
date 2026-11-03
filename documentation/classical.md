# Line M10: the classical battery, the domain router, ATP and SMT

Plan §7 step 4, "the cheapest gain": before any model works on a goal, classical tools try it. The
package is `@seshat/classical`. This page describes what is built; the end of it says what has not run.

For a goal (the problem's target, or a subgoal that is a claim of the memory), in the order of plan §15:

1. the **domain router** reads the statement and names its decidable fragment;
2. the **Lean battery** runs the tactics the host's Lean has, in the order of their posteriors, a few
   at a time, under a CPU budget, and stops at the first success;
3. a success is **submitted through `validate`**: it makes the claim `computed` at most, and only the
   certifier's kernel replay makes it `proved` ([lines.md](lines.md#validate));
4. ATP and SMT with reconstruction ([below](#atp-and-smt-with-reconstruction)) and only then a model, whose briefing
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

## Translation to SMT-LIB and TPTP

`lower(goal, premises)` (`translate.ts`) turns a goal, and lemma statements given as premises, into a
typed problem; `toSmtLib` and `toTptp` write it. The fragment:

- variables of `ℕ` (an integer with a sign assertion `d_n`), `ℤ`, `ℝ` and `ℚ` (both read as reals),
  `Prop` variables, abstract types `(M : Type*)` with the operations of their instance binders
  (`[Mul M]` becomes `mul_M`), and function or predicate variables between those sorts;
- `+ - * / % ^ neg`: `^` only by a numeral up to 8, real `/` only by a nonzero numeral, integer `/` and
  `%` only by numerals (Euclidean, as Lean's `Int`), truncated subtraction on `ℕ`, `∣` only by a
  numeral;
- `= ≠ < ≤ > ≥`, `∧ ∨ ¬ → ↔`, `True`, `False`, `∀` and `∃` over typed variables;
- hypotheses as assumptions; each premise `(x : T) (h : P) : Q` as `∀ x, P → Q`.

Anything else (sets, `Finset`, sums, casts, bounded quantifiers, a lemma named inside a term) throws
`Outside` with the reason, and the goal is left to the Lean battery. Each assertion is named
(`h_1`, `p_2`, `d_n`, `goal`), so that an unsat core or a proof says which hypotheses and premises it
used. The SMT-LIB script asserts the hypotheses and premises and the negation of the goal, with
`(get-unsat-core)`; the TPTP problem is TFF with the hypotheses and premises as axioms and the goal as
the conjecture (`$ite` for truncated subtraction, which Vampire reads). A translation is a candidate:
`unsat` or `Theorem` means the goal follows in the encoded theory, which is Lean's only up to the
approximations above.

`smt.z3` and `atp.vampire` ([capabilities.md](capabilities.md#smtz3-and-atpvampire)) run the two
problems. z3 comes from PyPI's `z3-solver`; its tests run when `z3` is on the PATH and say how to
install it otherwise. Vampire is untested here (no binary): its answer parser is tested on SZS text
written from the TPTP documentation, and the process wrapper on scripts that print it.

## ATP and SMT with reconstruction

`solveFirstOrder` (`firstorder.ts`) is plan §15 step 5. For a goal it:

1. translates it at each premise cutoff (option `cutoffs`, default 16, 64 and 256), the premises being
   the selector's choice mixed with a BM25 stream (`mixSelectors`; Task 11's MePo and SInE plug in as
   a `PremiseSelector`), taken from an index of declarations with their statements (the library's, or
   the `lean.meta` export of Task 21: none by default, and then one call with the hypotheses only).
   A premise outside the fragment is dropped alone. Several short tries beat one long one, and an
   even mix of two selectors gains, which is why the cutoffs run in parallel;
2. runs z3 and Vampire on every translation, in parallel, and keeps the **union of the successes**:
   each `unsat` or `Theorem` answer becomes an `Evidence` (tool, cutoff, answer, the hypotheses and
   premises of the unsat core or of the proof's `file(...)` annotations) in a node `first_order_run`;
3. hands the premises of each success (smallest first), then of the union, to `grind [p, ...]`,
   `aesop (add safe p) ...` and, if the host has it, `hammer [p, ...]`, as a battery over Lean;
4. submits through `validate` only a Lean proof so built.

The answer of a solver is `computed` evidence at most: it changes no claim's status, no edge is
raised because of it, and a run where Lean accepts no reconstruction ends with the evidence and the
claim as it was. A proof that uses no premise beyond the goal's hypotheses is not reconstructed: the
battery tried `grind` and `aesop` on exactly that. A tool the host does not have is recorded in
`missing` and the other goes on. Nothing in this path has run against a real Lean or Vampire;
z3 ran on the translated scripts only.

## The line

`M10` (`createM10(services)`; `M10` is the one a run gets) has a `beforeProvers` hook and a briefing,
and no state of its own: it reads what it did from the memory (`resume: "stateless"`), so a resumed
run skips every goal that has a `battery_run` or `first_order_run` node and a second run of the hook
makes no Lean call.

`beforeProvers` works the problem's target and then each open subgoal (a claim joined to the target by a
`decomposes_into` edge, at most `maxSubgoals`): the battery, then ATP and SMT if the battery failed. A goal
the battery closes ends the line for that goal, and for the target ends the hook. Every Lean try is a
`lean.check` tool run of the actor `line:M10`, so the journal has it. With `search` on and the target still
open, the goal-level search runs last.

Options (`--line-option M10.<name>=<value>`): `parallel` 4, `cpuBudgetSec` 60, `maxSubmissions` 3,
`order` thompson|mean, `hammerCutoffs` "16,64,256", `packages` "" (the optional tactics the profile
promises, not probed), `probe` true, `subgoals` true, `maxSubgoals` 8, `firstOrder` true,
`atpTimeoutSec` 20, `premiseCutoffs` "16,64,256", `reconstructBudgetSec` 60, `search` false,
`searchNodes` 60, `orderer` posterior|decide. A bad value stops the hook with the option's name.

The **briefing** (`describeTried`) says, from the nodes, what was tried: the router's domain as a guess,
the tactics that failed and the Lean time they took ("do not repeat them on the goal as stated"), the
tactic that closed the goal and whether `validate` accepted its proof, what z3 and Vampire answered and
whether Lean accepted a reconstruction, and the search. A goal M10 did nothing on has no briefing.

The services (`M10Services`) replace the registry's `lean.check`, the solvers, the premise index and
the selector, for tests and for Tasks 9 and 11.

## `prove.search`

The goal-level search (`searchGoal`, capability `prove.search`, plan change PC6) opens the goal with
`lean.goals`, and expands states best first. A node's score is the sum over its path of
`log(1/(rank+1))`, divided by `depth^alpha`; alpha is drawn once per run from {0, 0.5, 1} with the
run's seed and recorded. The budget is in nodes (tactics tried). The candidates at a state are the
model's proposals, which keep their rank, and the battery's tactics for the goal's domain, which come
without a model call and are ordered by an injectable `CandidateOrderer`: the posteriors by default, or
`decide` (plan change J3 item 3, `--line-option M10.orderer=decide`, with the model's own order as the
fallback). A closed search returns the tactics, one per line; the line submits them through `validate`
like any other proof. It is off in the line by default, because whether it beats whole-proof sessions
at equal dollars is to be measured, and it has not run against Pantograph.

## Tests, and what has not run

`packages/classical/test`: the reader and the router on a table of goals; snippet generation; the
posteriors rebuilt from nodes and their order; the first-success stop, the parallel limit, the CPU
budget and abort; the host probe; the non-triviality test; `solveGoal` against a scripted Lean (a
refused proof, the allowed refusals, a failed run recorded). The scripted Lean (`test/fake-lean.ts`)
answers by tactic name and reads the layout of the file, not Lean's syntax. Also: the translation (checked against z3 when it is installed), the process wrapper and the solver readers on shell-script fake binaries, the first-order stage with cutoffs and reconstruction, the search against a scripted goal machine, the line against a fake problem context (options, probe, subgoals, resume, learning across problems, briefing), and a whole run with the simulated Lean (`orchestrator/test/m10.test.ts`).

The `grind` tactic carries a commutative-ring (Gröbner) module, so the router sends polynomial identities to `ring`, then `grind`; no `polyrith` is assumed, the tactic list is read from the host (plan change PD4 item 1).

Nothing has run against a real Lean: whether each tactic closes what the router sends it, whether
`Try this:` messages come as the code reads them, and the hammer's configuration syntax are open.
