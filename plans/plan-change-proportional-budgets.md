# Plan change (proposed): every paid action is proportionate to its budget

Status: approved by the owner on 2026-11-04 ("Oui"), together with the requirement of autonomous solving with the least friction (PB6, PB7). Adds Tasks 29 and 30.

## Where money is already bounded
Per problem (`--budget-usd`, default 5), per run, per turn, sessions, turns, context tokens; the escalation ladder (moves on spend without Lean progress); the fleet's width from the success posterior; M12's price per task; M18's capped share; the cache accounting of Task 28. What is missing is one place where a launch is compared with its expected value.

## PB1. A budget gate before every paid launch
Additive hook `problem.budget.ask({ site, estimateUsd, pSuccess, rung })`, called before a prover wave, a session, a line's task, a judge call. A deterministic rule answers `launch`, `probe`, `skip` or `widen`:
launch when `estimateUsd <= share(site) * remaining * value`, where `pSuccess` is the existing Beta posterior (Thompson) and the price is M12's pricing; an exploration floor still lets a fixed fraction through. Every answer is a journal event with its numbers, so avoided spend is measurable and the gate can be ablated.

## PB2. Probe first, widen on evidence
A problem starts with one prover, one session, at most 10% of its budget. The gate widens (more provers, sessions, stronger model) only after Lean progress, using the progress measure the ladder already uses. Replaces fixed defaults of 4 provers and 8 sessions as the starting shape. Successive halving, a standard technique.

## PB3. Where Jev fits (J-option)
The rule decides wherever numbers exist. `decide` (LLM by default, Jev optional) is consulted only where they do not: a cold start with no posterior, a tie within a margin, or whether a line's task is worth opening. New sites `budget.wave` and `budget.line`. Their state holds counts and dollars, no mathematical content, so sending it to a third party leaks no conjecture. They are not in the forbidden list. Jev's accuracy against an LLM is unmeasured on these questions, so the ablation arms are: no gate, rule, rule + LLM, rule + Jev, same problems, same budget, measured in cost to first success.

## PB4. Report
Spend per site, launches skipped with the dollars they would have cost (estimate, marked as such), widen and probe counts, and the ablation above.

## PB5. Repeat runs
Check, and test, that a run on `--memory-from` does not relaunch a claim certified earlier under the same environment, nor a strategy the failure memory already holds as exhausted. To verify first: I have not read how the loop treats a problem already `proved` in the chain.

## Cost if wrong
A gate that skips a launch that would have succeeded: bounded by the exploration floor and caught by the ablation. A probe that is too small makes easy problems slower by one round trip.

## Order
Task 29 follows Task 14 (it needs `harness ablate` to be judged) and precedes the first real run.

## PB6. Autonomous solving with the least friction (Task 30)
The owner's mission: open source, unbeatable in cost, usable by a student. Today a run can only start from a problem of a bench index (`--sample`, `--problem ID`), there is no command to give Seshat a problem of one's own, and the first run needs a flag list. Task 30 adds:
- `harness solve` takes a Lean statement (a file or an argument) or a prose statement (formalized by the existing induction/formalize path, with its test lemmas, and shown for the person's signature before any spend), builds a one-problem index and runs with student defaults.
- `harness doctor` checks Lean, the Kimina server, the model credentials, the price table and the network, and says in plain words what is missing and how to fix it.
- Student defaults: a mandatory `--max-usd` with a small default, the gate and probe-first of PB1 and PB2 on, the cheapest listed provider, the off-peak option, the classical battery and small models before any model call (already the line order), and a stop with the account of where it stands (consortium mode) instead of an open-ended run.
- Output: a plain `RESULT.md` next to the journal: solved or not, the Lean proof if certified, what it cost, what was tried.

## PB7. A user interface
There is none today (command line and Markdown reports only). Task 30 adds `harness view RUN_DIR`: one static HTML file built from the journal alone (no server, no model call, no network): the research graph with statuses, the account of each turn, spend per site and rung, and the proof. It reads only; the hints, signatures and steers stay commands. A live interface is later and waits for the first real runs.

## PB8. Everything consultable, and every stop leaves a deliverable (owner, 2026-11-04)
The journal already records the whole process; the owner's requirement is that it is readable at no token cost and that any stop, whether tokens, dollars, time, a crash or a killed process, leaves the intermediate results deliverable. Rules: (1) the run's account (`RESULT.md` and the turn report) is built from the journal alone, by code, with no model call, so it costs no tokens; (2) it is rewritten after every certified result and at every stop, including a stop caused by a budget or a failed model call, and by `harness view`/`harness report RUN_DIR` for a run whose process died without writing it; (3) it lists the claims by status, the Lean proofs certified so far, partial sketches with their open holes, counter-examples and indicative evidence marked as such, what was tried and failed, the spend per site, and the exact command that resumes the run; (4) a minimal always-on log line per event is the journal itself, nothing extra is generated by a model. Test: cut a run at every event with the faux provider and check that the account built from the journal alone holds every certified result up to the cut.
