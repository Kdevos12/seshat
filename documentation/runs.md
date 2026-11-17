# Runs: one vocabulary

The words below are the ones every flag, key and page uses (plan change LH9). A level contains the ones
below it, and only the run has a journal: the journal is the one source of truth of a run
([journal.md](journal.md)), and a run is the unit of replay.

## The levels

| Level | What it is | Bounded by | Set by |
|---|---|---|---|
| series | runs chained by `--memory-from`, with a consolidation pass between them | the person | `--memory-from`, `harness consolidate` ([memory.md](memory.md)) |
| run | one directory, one journal, one configuration | its allowance | `--run-budget-usd` (`budget.runUsd`), `--max-usd` in `solve` |
| turn | the work between two stops of a run: a consortium limit or breakpoint, a crash, a usage limit | a turn limit | `--turn-usd`, `--turn-tokens`, `--turn-minutes` (`consortium.limit`) ([human.md](human.md)) |
| problem | one target claim inside a run | its share of the allowance | `--budget-usd` (`budget.problemUsd`), `budgetShare` |
| child | a delegated piece of work with its own contract: a probe, a prover task, a hole session, an informal loop, a planner round, a search, a variant | a ledger carved from its parent | the line or the loop that starts it |
| session | one fresh model context | steps, context size | `--sessions` (per prover), `--steps`, `--context-tokens` (`limits`) |
| step | one model response | the session's `steps` | `--steps` (`limits.steps`) |

A step used to be called a turn in `--turns` and `limits.turns`, which collided with the consortium turn.
`--steps` and `limits.steps` are the names now; `--turns` and `limits.turns` stay as aliases (give one, or
the same number: two different values are refused at the start). The journal still records `turns` in
`run.started`, so a journal written before the rename reads and resumes as it always did.

A child is not a run. It has no journal of its own: it writes to the journal of the run that started it,
so that the truth of the run is one chain and replay stays exact.

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
