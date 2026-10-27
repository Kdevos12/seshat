# CLAUDE.md

Every agent that works on Seshat reads this at the start of each session. It is how agents driven
by different people stay in sync. Repository: `github.com/Kdevos12/seshat` (private).

Seshat is a harness for autonomous mathematical research with language models: models through
their APIs, Lean as the judge, classical tools first ([README.md](README.md)). It is built by
following one plan, [plans/seshat-plan.md](plans/seshat-plan.md), by two teams at once:

| Team | Whose agents | Owns |
|---|---|---|
| Main team | the project owner's (Kdevos12) | the plan, its rulings, and every task the collaborator does not own |
| Collaborator | a collaborator's, since 2026-10-20 | Tasks 6 (line M10), 9 (M3, M5) and 11 (M4), in that order: [plans/collaborator-tasks.md](plans/collaborator-tasks.md) |

The repository is the only channel between the teams. What is not pushed does not exist for the
other team.

## Every session

1. Sync first: `git fetch origin --prune`, then `git pull --ff-only` on `main`, and on your task
   branch if another session of your team may have pushed to it.
2. Read, in this order: [plans/seshat-plan-ledger.md](plans/seshat-plan-ledger.md) (the state of
   every task, and the main team's notes for the collaborator);
   [plans/collaborator-log.md](plans/collaborator-log.md) (the collaborator's state and notes for
   the main team); the newest rulings at the end of
   [plans/seshat-plan-rulings.md](plans/seshat-plan-rulings.md); then your task's section of the
   plan (and, for the collaborator, [plans/collaborator-tasks.md](plans/collaborator-tasks.md)).
3. `pnpm install`, then `pnpm check` on `main` before you build on it.
4. Work on your task branch; commit small and push after each commit. Before you stop, push, and
   write where you stand in your team's ledger or log. Usage limits cut sessions without warning:
   what is pushed survives, what is only on disk may not.

## Who writes what

| File or area | Written by | The other team |
|---|---|---|
| `plans/seshat-plan.md` (the plan) | main team, when the owner approves a change | reads it; a gap in it is a decision you record, not an edit |
| `plans/seshat-plan-rulings.md` | main team | reads it; the collaborator records its own decisions in its log |
| `plans/seshat-plan-ledger.md` | main team | reads it |
| `plans/collaborator-log.md` | collaborator | reads it |
| `plans/collaborator-tasks.md` | main team, in step with the plan | reads it |
| `plans/plan-change-*.md` | nobody: records of approved changes | reads them |
| `packages/classical`, `library`, `lessons`, `context`; `lean/SeshatLib/`; the capabilities Task 6 adds | collaborator | changes them only after asking in its ledger |
| every other package, capability and Lean directory | main team | changes only the call sites its task names (plans/collaborator-tasks.md, "Between the teams") |
| shared files (below) | both, additively | |

Shared files: `packages/core` (events, invariants, projection), `packages/memory`,
`packages/lines`, `packages/registry`, `packages/orchestrator` (`run.ts`, the `lines.ts` registry,
the report, the CLI), `config/hosts/*.json`, `README.md` (its status paragraph and diagram),
`documentation/README.md`, `documentation/lines.md`, `documentation/architecture.md`,
`pnpm-lock.yaml`. A change there is additive: new events, optional fields, new hooks or options,
with the existing callers still working and the documentation page updated in the same commit
(plan, "Interfaces every task shares"). Name each such change, with its commit, under "Interface
changes" in your team's ledger or log.

## Branches, commits, merges

- One branch per task, `task/t<N>` (for example `task/t6`), from the latest `main`. Push it with
  its first commit (`git push -u origin task/t<N>`) and after every commit after that. Only the
  owning team pushes to a task branch.
- `main` stays green: every commit pushed to it passes `pnpm check`.
- Commits: in English; one logical change each, with its code, tests and documentation together;
  the message ends, after a blank line, with the attribution trailers your session's harness gives
  you (a `Co-Authored-By:` line and the session link). No other model name or id anywhere in the
  repository (plan, Global Constraint 13).
- Merging a finished task (see "Done"): `git fetch origin`; bring `main` into the task branch
  (`git rebase origin/main` or `git merge origin/main`) and resolve the conflicts; `pnpm check`;
  push the task branch; then on `main`, `git pull --ff-only`, `git merge --no-ff task/t<N>` (or
  `--ff-only`), `pnpm check` again, `git push origin main`. If the push is refused because `main`
  moved, start again from the fetch.
- Never force-push `main` or rewrite its history. Rewrite only your own task branch, with
  `git push --force-with-lease`, never a branch the other team owns.
- Conflicts in shared files are nearly always both sides adding something: keep both, then check
  that the result reads well (one README status paragraph, one diagram, no duplicated table row)
  and run `pnpm check`. `documentation/README.md` merges as a union (`.gitattributes`). On a
  `pnpm-lock.yaml` conflict, take `main`'s lockfile and run `pnpm install` to add yours again.
- A worker (an agent that another agent dispatched, as its prompt says) commits on its branch only:
  it does not push, merge or dispatch agents. The agent that dispatched it, its team's controller,
  pushes, pulls and merges.

## Done

A task is done when:

1. every deliverable and test of its section of the plan, and of the plan-change sections that
   section names, is in, and `pnpm check` passes;
2. its documentation page and the README diagram changed in the same commits as the code;
3. an agent that did not write the code has reviewed it against that section and the Global
   Constraints, trust rules first, and its findings are fixed or recorded with a reason;
4. it is merged into `main` and pushed, and its row in your team's ledger or log says so, with what
   is simulated or has not run against a real Lean, model or program.

## Rules that bind every line of code

The plan's Global Constraints are the full list. The ones most easily broken:

- Lean is the judge. Claim statuses are `open`, `computed`, `refuted`, `proved`, `proved_informal`
  and `retracted`. Only a Lean check makes `computed`, and only the certifier's `kernel_replay`
  makes `proved` or `refuted`. A line changes a claim's status only by submitting a Lean proof
  through `validate`. Tool output (SMT, an ATP without reconstruction, computer algebra, a
  fingerprint) is a `computed` edge or an evidence node, never a claim's status (Ruling 13).
- The journal (JSONL with a hash chain) is the only source of truth; tables and indexes are
  projections rebuilt from it.
- Every external tool is a capability behind the registry (manifest, contract, host profiles), and
  can be replaced without touching the rest.
- Models through their APIs only: no training, no fine-tuning. Small non-LLM learned components
  used as they are (an online k-NN, a published premise selector) are allowed.
- Tests run without Lean, a model or a network: a simulated Lean, fake servers and pi-ai's faux
  provider stand in. Whatever needs a real Lean or model is written against its interface, tested
  with simulations, and documented and drawn (`:::wait`) as not run.
- Everything in the repository is in English. `documentation/` changes in the same commit as the
  code it describes, and the README's diagram changes with the research flow (a test checks it).

## Commands

```sh
pnpm install
pnpm check          # tsc --noEmit, then every test
pnpm harness --help # the command line (README.md, "Commands")
```

Node 22.19 or later and pnpm 10; more in [documentation/development.md](documentation/development.md).

## When you are unsure

Pick the reasonable option that fits the plan, write it down as a decision (what, why, the cost if
it is wrong) in your team's ledger or log, and continue (Ruling 5). A question that would change
the plan's goals, a trust rule or an approved plan change is the owner's: write it in your log
under "For the main team" (or in the ledger under "For the collaborator"), and continue with your
default until it is answered.
