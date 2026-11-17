# `harness audit`: why a problem was not certified

`harness audit RUN_DIR [--reference DIR]` (plan change PA15, `plans/plan-change-putnam-audit.md`) writes `audit.md` into the run directory: one dossier
for each problem that was not certified. It is what a person does by hand after a run, built from the journal, the blobs and the transcripts of the
directory alone. It calls no model and no Lean, writes nothing into the journal, and a solving run never reads it.

A problem is certified when its claim is `proved` or `refuted` (the certifier's `kernel_replay`). Every other problem, `computed` candidates included,
has a dossier.

## The summary

At the top: the problems, how many were certified, the run's spend, the sessions, the sessions with no `lean_check` (a session that spent its turns
exploring), and the problems the budget gate stopped after their probe (no Lean progress; documentation/scheduler.md, "The budget gate").

## A dossier

- **Spend**, and its split by site (`prover.session`, the lines' sites, the judge): sessions by their attempt totals, a line's one-shot calls by their
  `site`. A model call made inside a session is in the session's total and is not counted twice.
- **Sessions**: for each, its turns, its `lean_check` count (the session's own count, or the calls found in its transcript; "not recorded" when the
  journal is older than the field), its tool calls by name (from `transcripts/ATTEMPT.json`; when that is missing, the capabilities of the attempt's tool
  runs, said so), its stop reason and outcome.
- **Budget gate**: every answer for the problem, with its site, action, who decided and its words.
- **Last Lean errors**: the reasons of the last three invalid validations of the problem's claims (the hole claims of its sketch included), the first 300
  characters of each.
- **Last sketch or blueprint**: the first 1500 characters of the newest `m12_sketch` record's text, and M12's records: whether it was healthy, the
  problem that kept it from being split, the holes dropped, the planner's refinement rounds, the repairs, the hole verdicts of the inner sessions and
  why the refinement stopped.
- **Informal proof**: the `informal_proof` node: accepted or not, its verifier verdicts and its models.
- **Hygiene** (`plausible`, vacuity, test lemmas) and the **literature hits kept**. Text from third parties is shown clipped and escaped, as data.

A number the journal does not hold is said to be "not recorded", never guessed. Lean's errors and a sketch are shown in fenced blocks that third-party
text cannot close.

## An ablation directory

Given an ablation directory (one with `arms/NAME/measure/journal.jsonl`), the command writes one `audit.md` into it with a section for each arm, in
alphabetical order, each with its summary and dossiers.

## A reference solution

`--reference DIR` shows `DIR/PROBLEM_ID.md`, when there is one, at the end of that problem's dossier, marked "supplied by a person; never read by a
solving run". The files are the person's: the harness gives them to no prompt, no line and no model. A problem that was certified has no dossier, so its
reference is not shown.

## Tests

`packages/orchestrator/test/audit.test.ts`: a scripted run with a certified and an uncertified problem; an ablation directory with two arms; a reference
directory. Not run against a real run.
