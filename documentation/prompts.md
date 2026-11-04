# Prompts as files, and `harness optimize-prompts`

The prover's system prompt is a text file, `packages/orchestrator/prompts/prover.system.txt`, with two placeholders the program fills in:
`{{NOTES_CHARS}}` (the notes limit) and `{{TOOLS_SECTION}}` (the section on the tools besides `lean_check`, or nothing). `systemPrompt` in
`packages/orchestrator/src/prompt.ts` renders it. A prompt that is a file can be changed by a patch, and a patch is something a person reads and merges.

Prompt text changes only with a human merge (Global Constraint 16). Nothing in the harness writes a prompt in place.

## Measuring a candidate: `RunConfig.prompts`

`RunConfig.prompts.proverSystem` replaces the text of the system prompt for one run. It is how `harness ablate` measures a candidate prompt:
an ablation arm (`Arm.prompts`) is a configuration like another, run at the same budget on the same problems. The text

- passes the strict screen at the start of the run (below), and the run is refused before anything is spent when it does not;
- is recorded in `run.started` (`config.prompts`), so that the run can be reproduced and resumed with it;
- stamps what the run learns with a prompt version of its own, `PROMPT_VERSION+` and the first eight characters of the text's hash, so that
  nothing learned under a candidate is mistaken for something learned under the merged prompt (the prompts' major version opens an epoch,
  documentation/memory.md, "Provenance and epochs").

A run without it records what it always did.

## The strict screen of a rewritten prompt

A rewrite is model-derived text that reaches a prover, so it is screened before it is measured and again before it is written
(`screenPrompt`, `packages/orchestrator/src/prompt-screen.ts`). Each target (`PROMPT_TARGETS`) names its file, its placeholders and its anchors.
A text is refused when it

- is empty, or holds an invisible character (control, format, zero-width, bidirectional, Unicode tag, variation-selector, soft-hyphen, line and
  paragraph separator, private-use or unassigned characters), any non-ASCII character the merged prompt does not already use, a link or an address;
- names a Lean token the validator refuses that the merged prompt does not already name (the merged prompt lists them to say they are refused);
- adds a line that tells the model to ignore or override something, to skip the Lean check, not to call `lean_check`, to state a result, to count a timeout or error
  as success or to stop on its own judgement, or that names a token the validator refuses without saying it is refused (the phrase rules read the lines a rewrite
  adds to the merged prompt, so a future edit of the merged text cannot switch a rule off);
- does not hold each placeholder exactly once, or holds another one;
- drops an anchor: `lean_check`, the four `-- HARNESS:` region markers, "Lean decides", "Never allowed" and `sorry`. These tie the prompt to the trust
  rules and to the file format; a self-modifying agent that removes its own guard phrases is the failure the Darwin Gödel Machine showed;
- is more than one and a half times or less than half the merged prompt's length: a longer prompt is a larger bill, and the budget would no longer be equal.

The phrase rules are a blacklist, not a proof: they catch the wordings reviews have found, and a new wording gets past them. The human read of the patch is the real gate.
The screen is a floor, not a judgment: a text that passes it is still measured, and a person still reads it.

## `harness optimize-prompts`

```sh
harness optimize-prompts --checkout DIR --model PROVIDER/ID --cutoff 2026-01-01 --sample 40 --split dev --max-usd 300 \
  [--dates FILE] [--reflector-model PROVIDER/ID] [--iterations 8] [--minibatch 3] [--finalists 2] [--reflect-budget-usd 2] [--out DIR]
```

Off by default, outside every ablation run and never part of a research run. Prompts change only when a person merges what it proposes.

1. **Splits** (`optimizationSplits`). Problems dated after `--cutoff` are the temporal holdout. The older ones are cut into dev (60%) and held-out
   by `splitBench` with a problem kept together with its variants. A newer problem whose family is among the older ones is left out of the
   temporal split and listed. The splits are checked to be disjoint. A date comes from `--dates FILE` (problem id to ISO date) or from the first
   commit of the problem's file in the checkout; a problem with no date counts as older. `--split` takes `dev` only: the other splits are never searched.
"Solved" means certified: `proved` or `refuted` (kernel replay). A problem that passed the fast check only (`candidate`) is not an objective and is shown apart ("+N fast check only") in the report.

2. **Search** (`optimize`, GEPA). The merged prompt is scored on every dev problem (solved or not, and dollars). Each iteration draws a parent
   from the Pareto set, in proportion to the problems it leads on; shows the rewriting model the parent and, for a minibatch of dev problems,
   what happened (outcome, attempts, Lean's last complaints, as data); and takes the rewrite between `<prompt>` tags. The rewrite goes through the
   strict screen, and is run only if it passes. It is kept only if it does better than its parent on the minibatch, and is then scored on the rest of dev.
   The Pareto set (`paretoFront`) is, per problem, the candidates best on it (a certified problem beats the others, then cheaper wins), less the dominated ones.
3. **Gate** (`gate`). The best finalists of the Pareto set that beat the merged prompt on dev are run, with the merged prompt, on the held-out split and
   on the temporal holdout, under the same configuration and budget. On each split a candidate *beats* the merged prompt if it certifies more problems, or as
   many for at least 5% less money, over the same finished problems (`compareArms`; splits not finished alike are not comparable). It is *accepted* only if
   it also passes the exact one-sided sign test of the problems only one side certified, at `--alpha` (default 0.1) divided by the number of finalists measured
   (Bonferroni), on both splits. A saving at a tie has no test, so it never gets past `needs review`. A candidate that beats the merged prompt on both
   splits without passing the test is `needs review`: its patch is written as `prover.system.needs-review.patch`, and the report says to measure on more
   problems. A split with fewer than `--min-gate-problems` (default 8) problems is refused before anything is spent, because no gain on it could be significant.
   **The gate is spent.** A ledger (`--ledger`, default `proposals/gate-ledger.json`) records the problems of the held-out and temporal splits of every optimization
   that reached its gate; a run whose gate splits share a problem with an earlier one is refused unless `--reuse-gates` is given, and then the report names it.
4. **Output.** Into `--out` (default `proposals/ID`, git-ignored): `report.md`, `optimization.json`, and for each Pareto member `candidates/ID/prompt.txt`
   and `evidence.json` (provenance stamp, lineage, dev scores, gate results). Only an accepted or needs-review candidate gets `candidates/ID/prover.system.patch` (or `.needs-review.patch`), a
   unified diff `git apply` reads. The measurement runs, with their journals and ablation tables, are under `work/`.

Every measurement is one `harness ablate` arm: `Arm.prompts` with the baseline configuration (M0 and the `--tool` capabilities), so the numbers are read from the journals like any ablation's.

### Resuming

A model call and a measurement are money, so a cut-off optimization (a crash, a kill, Ctrl-C, the cap) is not thrown away. Every answer of the rewriting model is
written to `optimization.partial.json` as it arrives, and each finished measurement keeps its `done.json` under `work/`. Run the same command again with the
same `--out` and the same arguments: the search is seeded, so it replays the recorded rewrites without asking the model again and without running a finished
measurement again, and goes on from the first thing that did not finish (a measurement that was cut off is set aside as `NAME.partial-N`, never deleted). A
directory made with other problems, seed, cutoff, models or plan is refused. The ledger entry of the gate is one per directory.

### What it can spend

`--max-usd` is required: a cap in dollars on the whole optimization, the measurements as their journals count them plus the rewriting model. At the start the
command prints the plan's worst case (every problem of every measurement spending its whole `--budget-usd`, plus `--reflect-budget-usd`) and refuses to start if
even the first measurements (the merged prompt on dev and one rewrite on it) could cost more than the cap. If the worst case of the full plan is above the cap,
that is said, and the run stops at the cap: before each measurement it checks that the measurement could still end inside the cap, the gate measures as many
finalists as fit, and the report is still written, with what was spent. The last rewriting call may overshoot `--reflect-budget-usd`, which is checked before the
call. A model with no price in pi-ai (its dollars would be charged as $0) is refused, for the prover and the rewriting model, unless `--allow-unpriced`.

### What it cannot write

All writes go through `ProposalWriter`: only text, json, markdown and patch files, only below the proposals directory. The directory is refused
when it is inside `packages` (the validator, guards, journal code and the tests), `lean`, `bench` (the indexes), `capabilities`, `config`, `plans`,
`documentation`, `.git` or `node_modules`, or holds one of them. A patch is made only for a registered prompt file (`packages/NAME/prompts/FILE.txt`),
from a text that passes the screen again, against the file as the checkout holds it. The command never edits a prompt file, and never runs a model for training: the
rewriting is a model call by API.

### Provenance

Each candidate carries the stamp of Task 23 (rewriting model, prompt version it derives from with its own hash, Mathlib revision, harness revision, budget class, time), in
`evidence.json`. A run that measures a candidate stamps what it learns with `PROMPT_VERSION+HASH`, an epoch of its own. The prompt's version lives with its text, in `prompts/prover.system.version.json` (`promptVersion` and the hash of the text); `PROMPT_VERSION` reads it, and a test fails when the text and the record disagree, so a prompt cannot change without its version. A candidate is stamped with `PROMPT_VERSION+HASH8`, as a run measuring it is, and its patch changes both files (the text, and a minor bump of the version with the new hash, which does not open an epoch).

### Not run

Nothing here has run against a real model or Lean: the tests use the faux provider, scripted runs and a simulated bench. Targets: only the prover's system
prompt is a prompt file with a candidate seam; the lines' prompts live in their packages and join by becoming a file and a registered target. The date of a problem is
the date of its file. With few problems the gate is weak (a difference of one is noise); read the sign test and the text before merging.
