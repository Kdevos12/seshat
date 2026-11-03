# Measuring the lines: `harness ablate`

Plan section 6 asks of every mechanism that it earn its place: a line that does not beat the one before it at equal budget leaves
the plan or gets simpler. `harness ablate` runs the configurations on the same problems at the same budget and puts the
measurements side by side. Everything it prints is read from the journals of the runs it makes (a pure function of events, so that
any tool that reads journals can print the same row): `measureRun` in `packages/orchestrator/src/measures.ts`.

Nothing here has run against a real Lean or model. The tests run the whole thing on the faux model and a simulated Lean; the numbers
a real run gives are the ones to read, and the first real run checks the ones this page marks as estimates.

## What is measured

One row per configuration. The columns of plan section 6:

| Column | Definition |
|---|---|
| Solved | Problems with a Lean-checked proof: certified (`proved`, `refuted`) or a candidate that passed the fast check. Certified ones are given apart. |
| Dollars and tokens per solve | The run's dollars, and input plus output tokens, over the problems solved. A configuration that solves nothing has none. |
| Redundant attempts | Of the attempts that carry a strategy label, the share that failed as an earlier attempt on the claim, or on an equivalent one, already had (`redundancy`, M1). |
| Mean context | Input tokens per model request of the provers' sessions, cached or not: the size of what the model was sent. |
| Tool definitions | Tokens of the tool declarations each session sent with every request (`attempt.finished.toolTokens`, `estimateTokens` of the names, descriptions and parameters of `lean_check`, the run's tools and the tools the lines opened; an upper bound). |
| Memory | The share of proofs that used an element of the memory, by kind. A proof is the problem's claim with a valid attempt; it used a `lesson` if the draw put unverified items in that session, a `library` lemma if the attempt's `library_use` node names one, a `schema` if M15 showed one to the session. A proof made by a line's submission, with no session, uses none. |
| Without a model | Of the subgoals (claims made by M12's sketches or joined by a `decomposes_into` edge) and of the conjectures (claims made by M8, M13, M14, M16), the number with a valid Lean check made by a line that calls no model (M10, M11), and the time of those lines' tool runs in milliseconds (the CPU cost). |
| Diversity | Distinct strategy labels and distinct sources (the provers, or the line that made the valid check) among the proofs, and the entropy in bits of the pairs. |
| Inductive hypothesis | The share of proofs whose chain of Lean-checked edges meets a settled claim that line M8 made. Inspirations are not measured: M7 and M9 are suspended (Ruling 20). |
| Spend by site | `siteSpend`: dollars, calls and share per site, the biggest first (J1), which caps what a cheaper decision backend can save. |
| Cache | The share of input read from the provider's cache and the dollars it saved, in all, per line and per ladder rung (PD1 item 2). It is checked on the first real run before any conclusion drawn from the packet modes is used. |
| Proofs per source | Proofs that use a declaration of the harness library, of each extra package, or of Mathlib (LC2). |
| Counterexample set | Candidates dropped by the set and the tokens saved against a baseline without it (`cegisCounter`, PD5), by line and by source. The tokens are an estimate. |

"Settled by a program" reads the actor of the validation (`line:M10`, `line:M11`); a claim closed by M12's subsumption is not counted
here. The shares are of the claims the run made, so a configuration without M12 has no subgoals and says so (`0/0`).

## The configurations and the runner

`cumulativeArms()` gives the configurations of plan section 6: M0 (no line), then each line in the order of section 7 added to the ones before it, without the suspended M7 and M9 (Ruling 20). `runAblation` runs every arm on the same problems, with the same seed, at the same budget (providers, sessions, dollars per problem), each into its own journal under `arms/<name>/measure`. When `buildProblems` is set, each arm first runs on those problems to build its memory and is measured on the others with `memoryFrom`, so the memory never saw the problems it is measured on. `ablationProblems` is called before anything is spent: it calls `ablationRefusal` (turns and breakpoints are refused), refuses off-peak scheduling and duplicate arm names, and checks the lines, the line options and the decide settings. The result is written as `ablation.json`, and `renderAblation` writes `ablation.md`.

An arm is also a point in an experiment: it can carry line options, a packet mode, decide settings, a model and a tool set, and name the arm it is compared against.

## Reliability of decisions (J4)

`labelDecisions` gives each decision the outcome Lean gave it: for `prove.search.order` the answer is right when it names a tactic that closed a goal, for `fleet.cold_start` when it names the strategy of a valid attempt, and for the other sites when the claim came to be settled. `reliability` bins the probability of the answer (ten bins) and gives the expected calibration error per site and backend, and the mean rank of the candidate that succeeded. `agreement` compares two backends on the questions both answered (J5). No threshold on a probability is allowed until its site has a curve.

## Chunk curves (PE4)

`chunkCurves` takes the attempts of each prover on each problem and gives, for K in 1, 3, 6 and 10, how many problems a Nexus that runs K provers in parallel would have solved and at what cost. A whole parallel round is paid for, so the cost of K provers is a multiple of K attempts. It reads the journal of a run: nothing is rerun.

## Experiments

An experiment is a short list of arms that differ by one option, run on the same problems at the same budget as the cumulative table (`harness ablate --experiment NAME`, with `--lines` for the lines the arms share, every line by default). Each one is data in `experiments.ts` and says what it cannot tell without a real run.

| Experiment | Amendment | Arms | Not run |
|---|---|---|---|
| `ladder` | PE4 | the ladder, every rung from the start (`M12.ladder=false`), rung 0 alone (the lines M18, M15 and M16 left out) | the budgets are simulated |
| `packet-mode` | PD2, PE5 | `prefix_tail`, `append_only`, `recompiled`, and M4's naive packet | the cache ratio is the faux provider's |
| `renderings` | PC5 | `list`, `merged`, `table` for each model of `--models` | only real models tell |
| `queries` | PC5 | extracted queries against the raw statement | the extraction is a model call |
| `seeds` | PC13 | pattern seeds on and off, split by difficulty in the table | the neighbours need a real Lean |
| `lessons` | PE2 | lessons deactivated by measured effect against by presence | needs enough problems |
| `cegis` | PD5 | the induction lines on or off: the counterexample set's counter | tokens saved are an estimate |
| `lsp` | PC7 | `lean.lsp` as a tool set against M0 | needs a language server |
| `decide` | J1, J4, J5 (line D1) | the model for every site, then one arm per J3 site asked of Jev | not run against real Jev |
| `m17` | LC3 | the base Lean environment against the one M17 extends | needs a pinned real environment |

Options are line options, so an experiment's lines must include the line whose option it sets (`packet-mode` needs M4 for the naive arm). The decide experiment's table adds the agreement between each Jev arm and the model arm on the questions both answered.

## The command line

```sh
harness ablate --checkout DIR --model PROVIDER/ID --sample 20 [--configs M0,M1,M10] [--split 8] --out DIR
harness ablate --checkout DIR --model PROVIDER/ID --sample 20 --experiment ladder --lines M1,M10,M12,M18,M15
harness chunks RUN_DIR... [--chunk-k 1,3,6,10] [--budget-usd X]
```

`--split N` builds each arm's memory on N problems of the sample and measures it on the others. A turn limit, `--human` and `--offpeak` are refused through `ablationRefusal`. `harness chunks` prints the cost-to-first-success curves of finished runs.

## The probe (PE9)

A memory that grows can start to hurt: agents copy what they retrieve, and a stored error propagates. The probe is the guard.

- **The set.** Frozen: the first probe of a memory chain draws it and writes `set.txt` beside its results, and every later probe of the chain reads that file, so the set does not move as the pool shrinks; it is refused if the memory has since been built on one of its problems. 20 problems by default (`--probe-size N`), drawn by a seed from the bench's problems that built nothing, or a fixed list in a file (`--probe-set FILE`, one id per line). The set is refused if it names a problem the memory was built on.
- **The two runs.** `harness probe RUN_DIR` (under the lines and options the run was started with, unless `--lines` or `--line-option` say otherwise) runs the set twice from the same seed and budget: with the memory of the run (and the journals it was started on), and with `verifiedOnlyMemory` of it. That memory is the journal re-emitted, with a new hash chain, holding the claims, the Lean validations and tool runs behind them, the edges Lean checked, and the nodes no mechanism learned from outcomes. It withholds the attempts, the lessons, every record that carries a provenance stamp (Global Constraint 16), the decisions, and a claim status Lean did not set. `harness run --probe-every K` does it after every K-th run of a memory chain.
- **The alarm.** Paired by problem: the memory rings when it solves fewer problems than none, or costs more on more problems and in total, and the gap passes a one-sided exact sign test (alpha 0.1). With 20 problems the test has little power: the alarm needs 4 problems lost to none, so it catches a loud entrenchment, not a quiet one. A missing alarm is not a clean bill.
- **The report.** `probe.json` in `RUN_DIR.probe`, a sibling of the run directory (a finished run, which other runs pin, is never added to), is shown by `harness report` under "Memory probe", the alarm first.
- **The split.** `harness ablate --split N` builds each configuration's memory on N problems and measures it on the others, which also corrects an optimistic measurement of M3.
- **Over time.** `overTime` gives, for a series of runs, the distinct strategies and sources among proofs, the share of the budget on strategies never tried on that claim group, and the share of proofs that reuse a library lemma or schema.

Nothing here has run against a real model: the sign test and the verified-only memory are tested on scripted journals.

## Reading the verdicts and the difficulty split

- **Paired, over the problems both arms finished.** An arm that stops early (the run budget, Lean down, Ctrl-C) has fewer problems; a verdict between arms that did not finish the same problems is `not comparable`, and the numbers given are over the problems in common. Otherwise the verdict is paired: the problems only this arm solved against the problems only the other solved, with the exact one-sided sign test. A difference whose p is above 0.1 is marked `indicative only`: with 20 problems a gap of one is not evidence.
- **The difficulty split has a basis outside the comparison.** Easy is what M0 solved (or a pilot run given with `--pilot RUN_DIR`), hard is the rest. Splitting by the outcome of an arm that is compared would make that arm solve every easy problem and no hard one by construction, and every other arm look worse on easy and better on hard, whatever the truth. M0's own row has no split for that reason; a table without M0 and without a pilot is not split.

## When an ablation is cut off

A full cumulative table is eighteen runs. Each arm writes `done.json` in its directory when its runs have finished, and `ablation.partial.json` lists the arms done and the arms left after each one. Giving the same `--out` again resumes: an arm that finished is measured again from its journal and nothing is spent on it; an arm that was cut off is set aside as `arms/NAME.partial-N` (never deleted) and runs again. A directory whose finished arms were made with other problems, another configuration or another bench is refused. `ablation.json` and `ablation.md` are written when the last arm is done, and a directory that holds them is finished.

## What a saved file says about itself

`ablation.md`, `ablation.json` (field `label`), `probe.json`, the probe's rendering in `harness report` and the chunk curves all carry a label: whether the model was the faux provider (`SIMULATED`: every number is the simulation's), the limit of the experiment that was run (the `Not run` column of the table above), and what every table is silent about otherwise: the cache ratio and the dollars saved are the provider's accounting as recorded and are checked against a real provider on the first real run (PD1 item 2), and a run on a simulated Lean looks like a real one in its journal. The label is computed from the model the run was configured with, so a table copied out of a terminal keeps it.
