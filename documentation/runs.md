# Runs: one vocabulary

A run has two orthogonal settings (plan change LH9). The rest of the vocabulary follows in the next commit of this task.

## The two axes

A run has two orthogonal settings instead of more kinds of run. Both are optional keys of the
configuration, and both are recorded in `run.started` (`horizon`, `human`), shown in the start log
(`shape: horizon episode, human consortium`) and in the header of the report.

- **`horizon`** (`--horizon`): `episode` is a bounded number of sessions; the run ends when they are used.
  Every run is an episode today. `campaign` (money, time and a verified frontier bound it) is the work of
  Task 59 and is refused at the start with "not built yet: Task 59".
- **`human`** (`--human`): `none` means nobody is asked; a measurement uses it, and `harness ablate` always
  does, because a turn boundary changes what the models see. `consortium` means a turn ends at a limit or a
  breakpoint and waits for the team ([human.md](human.md)); a bare `--human` is `--human consortium`.
  `digest` (it never waits, a question freezes only its branch) is Task 59 and refused the same way.

The value is derived from what the run has, in one function (`runShape` in `run-shape.ts`): `human` is
`consortium` when the run has consortium turns and `none` otherwise, `horizon` is `episode`. Giving a
value that contradicts the run (`--human none` with a turn limit, `--human consortium` with no turn
limit in a configuration that cannot supply one) is refused at the start. So `solve` is `episode` +
`consortium`, `run` without a turn limit is `episode` + `none`, and each arm of `ablate` is `episode` +
`none`. A journal written before the axes has neither field and reads as before.

## Which command for which purpose

| Purpose | Commands | What they have in common |
|---|---|---|
| working a problem | `run`, `solve` (and `resume`) | they certify claims through Lean; the axes above apply |
| measuring | `ablate` | it compares configurations on the same problems and refuses a person (`human` is `none`) |
| maintenance between runs | `consolidate`, `optimize-prompts`, `library build` | they never change a claim's status |

The commands differ because their rules differ; the axes are what changes inside the first purpose.
`harness parameters` and [parameters.md](parameters.md) list every flag and key.
