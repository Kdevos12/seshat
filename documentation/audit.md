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
- **Last sketch or blueprint**: the first 1500 characters of the newest `m12_sketch` record's text (of the problem's own sketches: a hole's local
  redraft, DP7, a record with `redraftOf`, is left out here and in the length section), and M12's records: whether it was healthy, the
  problem that kept it from being split, the holes dropped, the planner's refinement rounds, the repairs, the hole verdicts of the inner sessions and
  why the refinement stopped.
- **Informal proof**: the `informal_proof` node: accepted or not, its verifier verdicts and its models.
- **Formal-cost triage**: `invest`, `short` or `skip` with its reasons ([scheduler.md](scheduler.md#the-budget-gate)); the run's own `formal_triage` node when it has one, else computed from the journal now, with no model call, so an old run can be triaged.
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

## Length

Every problem of the run, certified ones included, has a row in the "Length" section (and a record in `length.json`, below); it comes before the
dossiers. Nothing is guessed: a number the journal does not hold is "not recorded". Columns and where each comes from:

- **Status**: certified (claim `proved` or `refuted`) or not.
- **File, lines, characters, theorems**: the file measured is, for a certified problem, the blob of the last valid `validation.finished` of the problem's own
  claim (the `kernel_replay` one first); for an uncertified one, the blob of its last invalid validation, else of its last validation, else the text of its
  last `m12_sketch` record. A validation is journaled only for a check that Lean answered and that left no `sorry`, so a problem that only ever submitted
  files with holes is measured by its last sketch, and one with neither shows "not recorded". The text counted is the prover's two regions (`aux` and `proof`)
  when the blob has the markers, else the whole text; the header the harness adds is not counted. **Lines** are Lean lines: neither blank nor only a
  comment (`--`, and `/- -/` blocks, nested; strings are not parsed). **Characters** count the same text.
- **`aux_`**: the `theorem` and `lemma` declarations of that text whose name starts with `aux_`.
- **Holes**: from the problem's last `m12_sketch` record: its holes, those dropped, whether it was healthy; and the verdicts (`proved`, `statement_wrong`,
  `too_hard`, shown as `too_hard (turns)` when the node says why), one per hole claim, the last winning, from `hole_verdict` nodes and `m12_session` records.
- **`lean_check`**: the sum of the problems' sessions' counts (`attempt.finished.checks`, or the calls in the transcript); when no session recorded one, the
  `lean.check` tool runs made inside its attempts, said so; else "not recorded".
- **Check time vs size**: the `lean.check` tool runs of the problem's attempts whose input blob (the code sent, characters) and `durationMs` are both in the
  run directory: how many, the median time, and the largest code with its time. A check made outside an attempt has no problem and is left out.
- **Stopped by**: the sessions' `stoppedBy` counts.
- **Reference lines (theorems)**: with `--reference DIR`, `DIR/PROBLEM_ID.lean`, else the Lean code blocks (fenced `lean`) of `DIR/PROBLEM_ID.md`, counted
  the same way (non-blank, non-comment lines), with its `theorem` and `lemma` count. A `.md` with no Lean block counts as no reference. The harness gives it
  to no prompt, no line and no model.

A second table, "success against reference length", buckets the problems by reference lines (`<30`, `30-99`, `100-299`, `>=300`, and `no reference`) and
gives certified over total for each bucket and the median Seshat lines of the certified ones with a recorded file.

**`length.json`** is written next to `audit.md`: `{ "records": [...] }`, one record per problem with the fields above, plus `arm` (`run`, or the arm's name
for an ablation directory) and `runId`, so that records of several runs can be concatenated and pooled. An ablation directory has one `### Length`
section per arm in `audit.md` and every arm's records in one `length.json`.

## Output tokens by role and kind

One table in `audit.md` for the run (plan change CL0, `packages/orchestrator/src/output-kinds.ts`), after "Length"; an ablation directory has one per arm.
It says what a role's output is made of, which decides whether cutting prose could save anything. One row for each role seen: the call's `role`, else the
role of its site (`prover.session`, `scheduler.planner`, `scheduler.hole`, `consult`), else the site (the Lean draft's attempt is `gate.draft`, its own row, not the prover's), else "other". Columns: calls and output tokens (as
the journal charged them: a prover session's `attempt.charged` events, a line's `model_call.finished` events), then **thinking**, **text** (outside tool
calls) and **tool-call arguments**, each as tokens and a share of the split tokens, **prose share** (text over the split tokens) and **split covers** (the
split tokens over the output tokens). Where the journal holds no split for a role, the cells say "not recorded".

Where the split comes from:

- **A session's transcript** (`transcripts/ID.json`, the prover sessions and, since plan change CL0, the hole sessions): each assistant message's
  `usage.output` is divided among its `thinking`, `text` and `toolCall` parts in proportion to their characters (a tool call's characters are those of its
  JSON arguments). A message with no usage counts characters / 4 tokens and is reported as "estimated from characters". The split is an estimate: the
  provider reports one output number, not one for each part.
- **A one-shot call's response blob** (the planner, the judge): the blob is the response text only, so text is the smaller of the call's output tokens and
  its characters / 4 (`CHARS_PER_TOKEN`), and the rest of the output is thinking that was not stored; the thinking cell says how much.
- **Nothing**: a hole session of a run made before hole sessions saved transcripts has no split. Its row keeps its calls and output tokens, and the split is
  "not recorded". A hole session's calls name its transcript through the `sessionId` in their request blob.

The table is markdown only; `length.json` holds per-problem records and this is per role.

## Exploration moves

One table in `audit.md` for the run (plan change CX1), after "Output tokens by role and kind"; an ablation directory has one per arm. It counts, for each
of the twelve exploration moves E1 to E12, the problems whose own statement the router tags with it, and the certified ones among them
([classical.md](classical.md#exploration-moves-plan-change-cx1)). A problem's moves are the ones its last `battery_run` node on its own claim journaled
(M10 ran on it), else the moves computed now from the statement of its claim (`claim.created`), so an older run, or one without M10, is counted too; the
line above the table says how many came from each. A problem has several moves or none, so the column does not sum to the problems. These counts order
the CPU tools of Tasks 78 to 80 (`plans/plan-change-cpu-exploration.md`, "Order and cost").

## Tests

`packages/orchestrator/test/audit.test.ts`: a scripted run with a certified and an uncertified problem; an ablation directory with two arms; a reference
directory; the exploration moves (a journaled and a computed problem, the table); the output-kinds table (`output-kinds.test.ts`: a transcript split by characters, an estimated message, a planner call's unstored thinking, a hole session with and without a transcript) and the hole session's transcript (`hole-session.test.ts`); the length table (a certified proof of known length, an uncertified file with `aux_` lemmas, holes and a timed check, a `.lean` and a `.md` reference, the buckets, `length.json`). Not run against a real run.
