# M1: identity and shared negative memory

M1 is the first ablation line ([lines.md](lines.md)). A run enables it with `harness run --lines M1`
or `--ablation M1`; without it the run is M0 and none of this exists. It does four things:

- the run's claims are named by their statement, so two problems with one statement share one
  claim and its attempts ([identity](#one-claim-per-statement));
- every attempt is labeled with a strategy from a closed vocabulary, classified from the proof
  text ([strategies](#strategies)), and a failed one with the class of its failure and a typed
  detail ([failure classes](#failure-classes));
- every session of every prover opens with the "already tried" section for its claim: what the
  provers tried and how it failed, never the text of an attempt ([already tried](#already-tried));
- the run report gives the share of redundant attempts ([below](#redundant-attempts)).

The code is in `@seshat/memory` (`strategies.ts`, `failures.ts`, `progress.ts`, `tried.ts`,
`redundancy.ts`, `MemoryStore.alreadyTried`) and the line itself is `packages/orchestrator/src/m1.ts`. Everything is
computed from the journal and the proof text, never by a model.

## One claim per statement

With any line enabled, the orchestrator makes each problem's claim through
`MemoryStore.ensureClaim` ([memory.md](memory.md#claims)) instead of a `claim.created` of its own:
the statement is the problem's signature, the `origin` is `bench:<id>`, the `domain` the problem's,
and the `header` the prefix of the problem's file (what precedes the AUX region: the imports and
the definitions the statement reads under). The file is read before the claim is made. A line that
makes a claim about the problem's own definitions passes the same prefix as its header.

The identity that names the statements is the one an enabled line gives (`Line.identity`, called
once per run with the registry, so that an identity that needs Lean can use it). M1 gives
`TextIdentity`: the hash of the text without comments and with whitespace collapsed, together with
the header, normalized the same way (`st0_`). Another identity replaces it without change to the
store, and at most one enabled line may give one. The Lean identity (`st1_`) is not built.

So two problems with one statement under one prefix have one claim, in the order the run reaches
them: the second problem's `problem.registered` carries the first one's `claimId`, and no second
`claim.created` exists. What this changes:

- **Attempts are shared.** The second problem's provers are told what failed on the first, and the
  report's redundancy counts the repeats between them.
- **Per problem, still:** the attempts a problem reports (`problem.finished.attempts` counts the
  problem's own provers' attempts, not the claim's), its budget, and its candidate. Each problem
  goes on until a proof of its own passes the check.
- **The claim is settled once.** The first valid check makes it `computed`, and a certified
  candidate makes it `proved` if it is still `computed` (or `open`); a later problem's valid check
  or certification of an already settled claim is recorded as a validation and leaves the status
  alone.
- `run.finished.solved` and `candidates` count the problems whose claim has that status, so both
  problems of a shared claim count; the report's outcomes are per problem.
- **Sharing needs the same prefix.** `TextIdentity` reads the header, so the same signature under
  another prefix (other imports, `open`s or definitions) is another claim, and no two distinct
  statements share one. The prefix is everything in the file before the problem's docstring,
  earlier theorems included, so problems of one file never share a claim, and the sharing is
  between files that repeat a problem under one prefix. This merges fewer claims than the
  elaborated statement will.

## Strategies

`classifyStrategy({aux, proof})` gives a proof the first label of this table whose test it meets,
reading the tactics and terms in the two regions without their comments and strings; it never asks
a model, and the same text always gets the same label. A label says how a proof goes about the
statement, not how it ends: an `induction ... with` closed by `simp` and `omega` is an induction.

| Label | The proof... |
|---|---|
| `induction` | uses `induction`, `induction'` or `induct`, an eliminator such as `Nat.le_induction` or `Nat.rec`, or an auxiliary lemma that calls itself. |
| `extremal` | uses pigeonhole, `Nat.find`, `exists_min` or `exists_max`, well-foundedness, `sInf`, `sSup`, `IsLeast`, `IsGreatest`, `argmin`... |
| `counterexample` | uses `not_forall`, or `push_neg` with a witness (`use`, `exists`, `⟨..⟩`). |
| `contradiction` | uses `by_contra`, `contradiction`, `exfalso` or `absurd`. |
| `cases` | uses `cases`, `rcases`, `by_cases`, `match`, `interval_cases`, `fin_cases`, `split_ifs`, `split`, an `obtain` of a disjunction, or `Or.elim`. |
| `generalization` | uses `generalize`, `generalizing` or `revert`. |
| `construction` | gives a witness: `use`, `exists`, `refine ⟨..⟩`, `exact ⟨..⟩`, `Exists.intro`. |
| `bounds` | uses `nlinarith`, `positivity`, `gcongr`, `bound`, a `calc` with an inequality, or applies a lemma named with `le`, `lt`, `ge`, `gt`, `nonneg`, `pos`, `abs` or `trans`. |
| `algebra` | uses `ring`, `ring_nf`, `field_simp`, `linear_combination`, `abel`, `group`, `module`, `polyrith` or `calc`. |
| `rewriting` | uses `rw`, `rwa`, `simp only`, `simp_rw`, `unfold`, `subst`, `conv`, or applies a lemma (`exact`, `apply`, `refine`, `convert`). |
| `computation` | uses `decide`, `native_decide`, `norm_num` or `rfl`. |
| `automation` | uses `simp`, `simpa`, `omega`, `linarith`, `aesop`, `grind`, `tauto`, `exact?`... |
| `other` | meets none of the above. |

`premisesOf` lists the lemmas a proof names (`Nat.add_comm`, `mul_pos`), once, in order, leaving out
hypotheses it introduces, tactics and its own `aux_` lemmas; at most 24 go on the attempt.

Both readings are lexical: they do not follow what a tactic does, a lemma used through notation is
missed, and a definition can be listed as a premise. The Lean meta tool will give the exact
premises.

### Declaring a strategy

When M1 is enabled `lean_check` takes an optional `strategy` argument, one of the labels above (a
closed enumeration: pi refuses another value as a tool error, and the call is not a check). The
model says what it means to try; the harness records the last declaration of the session as
`declaredStrategy` on `attempt.finished`, next to `strategy`, the label classified from what it
submitted. The memory groups attempts by the classified label, so a mislabeled declaration changes
nothing in the section; the pair is the data for asking how well provers know their own strategy.
Without M1 the tool is M0's: `aux` and `proof` only.

## Failure classes

`classifyFailure(report, {aux, statement})` reads the check's report. `failureClass` on
`attempt.finished` is its class for every run, M0 included; the typed `failureDetail` is recorded
by M1.

| Class | Lean said, or the check found | Detail, for example |
|---|---|---|
| `refused` | the submission never reached Lean (a forbidden token, a marker line) | `refused before Lean: proof: 'native_decide' is not allowed` |
| `lean_unavailable` | Lean could not be reached | `Lean could not be reached` |
| `timeout` | Lean's time limit, heartbeat limit or recursion depth | `Lean time limit`, `heartbeat limit` |
| `syntax` | a parse error | `syntax error` |
| `unknown_identifier` | an identifier, constant, namespace or field that does not exist | `unknown identifier Nat.foo_bar` |
| `type_mismatch` | a type mismatch, a missing instance, a function expected | `type mismatch`, `failed to synthesize an instance` |
| `tactic_failed` | a tactic failed | `linarith failed`, `simp made no progress`, `no goals left` |
| `unsolved_goals` | goals left, with the cases' names when Lean gives them | `unsolved goals at case succ`, `unsolved goals at cases zero, succ` |
| `holes` | no error, a `sorry` left | `1 sorry left` |
| `axioms` | the theorem depends on an axiom outside the allowed ones | `depends on Lean.ofReduceBool` |
| `statement_changed` | the statement no longer elaborates to the original type | `statement changed` |
| `restates_target` | an auxiliary lemma states the target again (up to spacing and comments) | `auxiliary lemma aux_main restates the target` |
| `other` | anything else | `unclassified Lean error` |

When Lean reports several errors, the most basic is the cause: a timeout, then a syntax error, an
unknown identifier, a type error, a failed tactic, unsolved goals. A restated target comes first of
all, and errors come before holes. A detail is made of the class's words and names (a lemma, a case,
a tactic), never of a piece of the proof. Lean's wording is matched by its first words
([lean.md](lean.md#to-verify-against-lean) lists this among what is unverified); a message not
matched is `other`.

### How far a check got

`leanState(report, context)` reads a check as `{depth, errors, holes}`, with the same `context` as
`classifyFailure`, and `improves(now, best)` says whether a state is progress over the best one so
far: deeper, or at the same depth with fewer errors, or with as many errors and fewer holes (a
closed subgoal). The depth follows the class of the failure:

| Depth | Failure class |
|---|---|
| 0 | `refused`, `lean_unavailable`, `timeout`, `other`, `restates_target`, `statement_changed`: the check says nothing about the proof |
| 1 | `syntax` |
| 2 | `unknown_identifier` |
| 3 | `type_mismatch` |
| 4 | `tactic_failed` |
| 5 | `unsolved_goals` |
| 6 | `holes` |
| 7 | `axioms` |
| 8 | a valid check |

`attemptDepth(attempt)` gives the same number for a finished attempt (undefined when it checked
nothing). Like the classes, the measure is as good as the match of Lean's wording: a message worded
differently is `other`, depth 0.

## Already tried

`MemoryStore.alreadyTried(claimId)` gives the finished attempts on the claim and on its
`lean_checked` equivalents that were accepted or failed, grouped by their classified strategy: the
count, how many were accepted, the failures by class, and the last failure's class and detail. A
session that checked nothing, or that was cut (aborted, out of budget, a harness error), says
nothing about its strategy and is left out. Most attempts first, then the most recent.

The `briefing` of M1 renders it as a section of the session's opening message, after the notes,
the file and the last check:

```
# Already tried
Typed summaries of the attempts on this statement or an equivalent one, by you and the other provers (their text is not kept):
induction: 3 attempts, unsolved goals at case succ
automation: 3 attempts, 1 accepted, 1 tactic failed, 1 timeout; last: omega failed
cases: 1 attempt, unknown identifier Nat.foo_bar
```

A strategy with one failure class shows that failure's last detail; with several, the counts by
class, then the last detail. There is no section when nothing was tried. The option `maxLines`
(default 12, `--line-option M1.maxLines=6`) is the most lines the section has, its sentence and
a closing `... and N more strategies` included; below 2 there is no section, which is how the
sections are ablated while the attempts are still labeled. The sections are made when a session
starts: provers that run at the same time see only the attempts that had finished by then.

An accepted attempt shows as a count, never as its proof. On a claim another problem proved, the
section tells the second problem's provers that a strategy worked, and they still prove it
themselves.

## Redundant attempts

The plan's measure of wasted work (§6). Of the finished attempts that were accepted or failed and
carry a strategy label, the share that failed as an earlier finished attempt on the same claim, or
on a claim that was `lean_checked` equivalent by then, had already failed: the same strategy, the
same failure class and the same failure detail. `redundancy(events)` computes it from the run's
events alone; the report has it as `redundancy: {attempts, redundant, share}` in `report.json` and
as a line of `report.md`. A run with no labeled attempt, which is every run without M1, has neither.

## Tested, and not yet

Tested with the simulated model and Lean (`packages/orchestrator/test/m1.test.ts`) and on the
memory alone (`packages/memory/test`): the strategy table and the failure-class table, the
depth of each class and what counts as progress; two problems
with one statement and one prefix sharing one claim, each counting its own attempts, a shared claim
settled once, the same statement under two prefixes kept as two claims, and a statement the
identity cannot name ending its own problem as an error; the "already tried" lines, and the briefing reaching the first message of the next problem's
session and of a prover's second session; the declared and the classified labels, premises and
details on `attempt.finished`; a label outside the vocabulary refused; the option; the redundancy
metric; M0 unchanged without a line; an identity given by a line, and the registry it is handed.

Not done, and not measured:

- The Lean identity: statements equal up to renaming, binder style or definitional unfolding are
  different claims, and so is one problem repeated under two prefixes; near-equal statements are
  not deduplicated.
- The classifiers are lexical rules written from Mathlib habits, tested on a table of cases, not on
  real provers' output. The failure classes depend on Lean's exact wording
  ([lean.md](lean.md#to-verify-against-lean)).
- Whether the section reduces redundant attempts or raises the solved rate is what the `M0` against
  `M1` ablation measures. Nothing has run against a real model or Lean.
- No proof is reused between problems that share a claim, and the attempts' text is deliberately
  never shown.
