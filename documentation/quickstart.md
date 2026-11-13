# Quickstart: a problem of your own

This page is for someone who has a problem and wants Seshat to work on it at the lowest cost, without
learning the flag list: a student, a researcher with an afternoon. It covers `harness solve` (a problem of
your own), `harness doctor` (what is missing on this machine), `RESULT.md` (what a run leaves, whatever
stopped it) and `harness view` (one HTML page of a run). The harness itself is described in
[m0-loop.md](m0-loop.md); this page is the shortest road through it.

Nothing here changes what counts as a result. Lean is the judge: a claim is `proved` or `refuted` only when
the certifier's kernel replay says so ([trust.md](trust.md)), and a run without a certifier says plainly
that its results stay `computed`.

## The shortest road

```sh
pnpm install
pnpm harness ui                           # or the same in a page: documentation/ui.md
pnpm harness doctor                       # what is missing here, and how to fix it
pnpm harness solve "Every even number above two is the sum of two primes." --max-usd 2
pnpm harness solve "(n : ℕ) : n + 0 = n"  # the same, from a Lean statement
pnpm harness solve my-problem.lean
```

`solve` prints the model it chose, the allowance, and the statement it will prove; a prose statement waits
for your signature. When the run ends it prints where `RESULT.md` is. `harness view RUN_DIR` makes the
picture.

## harness solve

`harness solve STATEMENT [--max-usd X] [--model PROVIDER/ID] [--out DIR] [--as NAME] [--yes]` takes one
statement and works on it. Nothing here is a new mechanism of a run: `solve` prepares the inputs of
`harness run` and calls it (`packages/orchestrator/src/solve.ts`, `student.ts`, `solve-command.ts`).

**The statement.** It is read as Lean when it has a `theorem` or `lemma`, an `import` line, or the shape
`binders : proposition` (`(n : ℕ) : n + 0 = n`); anything else is prose. `--lean` and `--prose` force
the reading (a bare proposition such as `∀ n : ℕ, n + 0 = n` is Lean only with `--lean`). A parenthesis in prose
(`(Fermat) : the equation ...`) is not a binder, which has a colon inside, and `import` starts Lean only
before a module name (`import Mathlib`). A file is read whole: `.lean` is Lean, `.txt`, `.md` and `.tex` are prose. A Lean text with no `import` gets `import
Mathlib`; a signature or a proposition becomes `theorem solve_target ... := by sorry`; the target of a
file is its theorem whose proof is `sorry` (the last, when there are several; the lemmas above it are the
file's own). A text with nothing to prove is refused with the reason.

**The screen.** A Lean statement or file you wrote, or downloaded, reaches Kimina and the certifier as it stands, so it goes through
the strict screen that every model-written text goes through (`#eval`, `run_cmd`, `elab`, `macro`, `IO`, `import` after the header, any `#`...),
with comments kept (a file has docstrings) and the header apart. A text the screen refuses is not run; the message names the token.

**Prose is formalized, shown and signed before any spend.** The cheapest model with a price makes a Lean
statement of your words (the induction path: `formalizeHypothesis`, whose answer goes through the strict
screen that every model-written statement goes through). The harness then shows you your words next to the
Lean statement, tries the statement in Lean on its first ten numbers (a refuted case is said; the statement
probably does not mean what you meant) and asks whether cheap automation proves it (then it is trivial as
written). You answer `y`, or the run does not start (`--yes` answers for you; without a terminal and without
`--yes` the answer is no). The signature is a `statement.signed` event, written by `human:NAME`
(`--as NAME`, `SESHAT_USER`, then the login name), the first event after `run.started`, before any task,
claim or model call of the run. It holds your words, the signed statement and its id, the problem it is the
target of, the model, the request and response of the formalization call (blobs of the run), what the
first cases said and whether the statement was trivial. A statement you wrote in Lean is journaled the same
way (`source: "lean"`) with no prose, and is asked about too: what is proved is this text and no other, and a file you
downloaded is not a file you wrote. `RESULT.md` and the view show
the signature.

**What the formalization may cost.** The call is bounded before it is sent: the input is estimated, and the answer gets the
`maxTokens` that the rest of 20% of `--max-usd` can pay for at the model's output price (the retry of the JSON answer included); when
nothing worth paying for is left no call is made. Because no journal exists yet, what it cost is written to
`RUN_DIR/formalization.json` (`state`: `formalized`, `refused`, `failed` or `declined`, with dollars and tokens) whatever comes next.

The signature records that **you accepted the statement as your meaning**. It does not make anything true, and
no proof depends on it: the claim's status still comes from the certifier alone.

**The one-problem bench.** The problem becomes a checkout of one file and a bench index of one problem under
`RUN_DIR/problem` (`Solve.lean`, `index.json`; category `research open`, no AMS code, `benchId` `solve-HASH`).
The index has the shape and the hash check of the bench's, so the run, its memory and `harness resume` do not
know the difference. The exact command that resumes the run is in `RESULT.md` and printed when a turn stops:
`harness resume RUN_DIR --checkout RUN_DIR/problem --bench RUN_DIR/problem/index.json --host HOST`, with the host the run began with
(the isolated profile is not the default of `harness resume`) and every value quoted for a shell. A `resume.json` whose values cannot be
quoted (a newline, a backtick) gives the placeholder command instead.

**The student defaults.** Every one is the value of an existing option of `harness run`:

| Default | Value | Option it sets |
|---|---|---|
| Allowance | `--max-usd`, default $2, always there | `budget: { problemUsd, runUsd }`, both the allowance: nothing goes past it |
| Formalization | its cost comes off the allowance | the run's budget is `--max-usd` minus what the formalization cost |
| Budget gate and probe first | on, with the gate's own defaults | `--gate` ([scheduler.md](scheduler.md#the-budget-gate)) |
| Lines | M1 (shared claims) and M10 (the classical battery before any model call) | `--lines M1,M10`; `--lines` changes them |
| Model | `SESHAT_MODEL` when it is set ([models-setup.md](models-setup.md)), otherwise the cheapest model that has a price, among the providers with credentials | `--model`; the price is input plus output per million tokens, from the host's table when it has the model and from pi-ai otherwise; a model with no price is never chosen, because no dollar cap could see it |
| Consortium stop | a turn ends, with its account, when it has spent half the allowance (`--turn-usd`), at an impasse, or when the problem is settled | `--turn-usd`, the breakpoints ([human.md](human.md)); the run then waits, and `harness resume` spends the rest up to the allowance |
| Off-peak | not by default; `--offpeak` waits for the host's off-peak prices when its table has a calendar for the model | `--offpeak` |
| Host | the one named, `HARNESS_HOST`, `sandboxed` when `doctor` has written it, then `local` | `--host` |
| User | `--as`, `SESHAT_USER`, then the operating system's login name, which is then journaled (`user`, `human:NAME`) as it is; every event of the run carries it as `user` | the envelope's optional `user` ([journal.md](journal.md)) |

### Defaults sets

`harness solve --defaults v1|v2` picks a named set of defaults (`DEFAULTS_SETS` in `student.ts`; the default is `v2`). The set's name is
recorded in the run's configuration (`defaults` in `config.json` and in `run.started`), and a resumption reads it back.

| Set | What it is |
|---|---|
| `v1` | What `solve` did before the sets: the table above and nothing else. Kept so that a result can be compared with, or reproduced under, the older defaults. |
| `v2` (default) | `v1` plus five options of `harness run`, which are off in `harness run` itself, and one line: `editTool` (the prover edits its last file with `lean_edit` instead of rewriting it, [m0-loop.md](m0-loop.md#the-edit-tool)), `maskOldChecks` (check results older than the last four are sent as their one-line summary, in batches of four, [m0-loop.md](m0-loop.md#masked-old-checks)) and `checkTimeoutSec` (the provers' Lean checks are bounded at the host's `checkTimeoutSec`, default 120 s, [lean.md](lean.md#bounded-checks)), `stateCard` (each session opens with a card built from the journal, notes limited to 1500 characters, [m0-loop.md](m0-loop.md#the-state-card)) and `budgetRounds` (a run's budget shared in rounds among its problems, [scheduler.md](scheduler.md#the-budget-in-rounds); it acts only on a run of several problems and does nothing for `solve`'s one problem), and `budgetShare: 2` (a problem's cap is at most twice its even share of what the run budget has left, [scheduler.md](scheduler.md#the-budget-in-rounds)). `v2` also adds line M6 with its mechanical repeat rule only (no detector, no model call, [guards.md](guards.md)): the third occurrence of the same failure tells the prover to change approach and the fourth ends the session. It also lets a budget-gate probe that its own cap cut, with no Lean progress, run one extension before the gate judges it (`probeExtend`, [scheduler.md](scheduler.md#the-budget-gate)). Three more additions are `solve`'s own switches, not `RunConfig` fields of the set (`SOLVE_SWITCHES` in `student.ts`, beside `DEFAULTS_SETS`; `harness doctor` and the line `solve` prints at its start list them from that table): the **intake gate** (the statement's hygiene tests, and the literature only with your yes, [literature.md](literature.md)), **`compute.sage`** for a statement filed as finite, about a graph or about numbers (only when the host offers it), and **`lean.search`** (only when the host offers it; remote services only with your yes, [lean.md](lean.md#search-pushed-by-the-harness)). A host that offers neither the compute tool nor `lean.search` gets one line saying so and the run goes on without it. |

Why: in the first real runs about 90% of the dollars were output tokens (the model rewrote its whole Lean file at every check), 4 sessions
of 9 ended on a full context, and Lean checks ran into 900-second timeouts. `v2` makes each attempt cheaper and shorter; the certifier's
limits and the validator's policy are unchanged, and Lean still decides everything. `harness run` keeps its own defaults: each of the three is an
option there (`editTool`, `maskOldChecks`, `checkTimeoutSec`, `stateCard`, `budgetRounds` in the run configuration), so a recorded run replays as before. A later change of
`solve`'s defaults adds its option to `v2`.

In a plain `v2` solve the one question about third parties is therefore asked, once, after the signature, wherever a person can answer, because the
intake's literature and `lean.search` both want the answer (`--lit` is the yes; `--yes` or `--ask-stdin` without `--lit` is no; `--private` wins over
both; a resumed run reads the journaled answer). With a no the hygiene tests still run (they send nothing outside), the literature is skipped and
`lean.search` keeps to its local index and pattern search: nothing goes to a third party. Each addition can be turned off alone: `--no-intake`,
`--no-auto-tool`, `--no-lean-search` (they matter only with `v2`; a flag and its `--no-` cannot both be given). `--defaults v1` turns none of them on, and the
explicit flags `--intake`, `--lit`, `--auto-tool` and `--lean-search` still turn one on under `v1`.

`v2` also gives the prover `lean.lsp` (the tool `lean_lsp`: goals, diagnostics, several tactics at a line, Mathlib search; plan change NL1) beside
`lean_check`, when the host profile offers the capability (otherwise one note and the run goes on); `--no-tool lean.lsp` turns it off, and `v1` never
has it. The report's `tools` block counts its calls like those of any capability. It never judges a proof: only `lean_check` does.

The intake's judge call is proportionate to the allowance: when `--intake-usd` is not given, its cap is the smaller of the default ($0.05) and 5% of the
run's allowance (`--max-usd`), so a $0.40 run spends at most $0.02 on it. The test lemmas that `solve` runs to show them before the signature are the ones the intake
records: they are not run a second time. Not run on a real Lean, model, search service or literature site: the target of the plan change (at least 1.5 times the
problems solved per dollar of `v1`) has no number until `harness ablate --experiment solve-defaults` runs on real problems ([ablate.md](ablate.md)).

Options that are off unless you ask (they do not change the defaults above):

| Option | What it does |
|---|---|
| `--tool ID` (repeatable) | gives the provers that capability besides `lean_check`, as `harness run --tool` does (`--tool compute.sage`); a capability that is not `direct` or that the host does not offer stops the run before it spends |
| `--auto-tool` | adds the host's compute tool (`compute.sage`) when the router files the statement as finite, about a graph or about numbers ([literature.md](literature.md#solve-options)); said before the run; nothing is added when the host does not offer it |
| `--intake` | tests the statement before any paid session (vacuity, `plausible`, the first cases, now also for a Lean statement) and, if you agree, searches the literature ([literature.md](literature.md)) |
| `--lit` | your agreement to send the words of the statement to OpenAlex, arXiv, Semantic Scholar and zbMATH, and the hits to the model, in a call that cannot ask; implies `--intake`. Without it `solve` asks once and journals your answer (`intake.consented`); with `--yes` or `--ask-stdin` and no `--lit` the answer is no |
| `--private` | Nothing is sent to a third party: the registry refuses the OEIS, LMFDB and FindStat capabilities and keeps `lean.search` and the literature to their local forms ([trust.md](trust.md#third-parties)); `--tool` naming one stops the command before any spend. Wins over `--lit` and `--intake` (the literature step is skipped, journaled as private) and is refused with `--decide-backend jev` |
| `--intake-usd X` | the most the judge call may cost (default $0.05) |

The first stop is a look at where the run stands, not the end: nothing is lost by it, and the money you have
not spent stays yours.

Before it spends, `solve` runs the checks of `doctor` that a run cannot go without (Kimina, credentials,
prices, the network) and stops with the words of `doctor` when one is missing; `--no-check` skips them.

## harness doctor

`harness doctor [--host HOST] [--model PROVIDER/ID] [--no-write | --rewrite]` checks the machine, in the order
a person would fix it, and says for each thing what it found and what to do. It exits 1 when something a
run needs is missing.

| Check | Missing when | It says |
|---|---|---|
| Lean | there is no `lake` on the PATH, or no Lean project for the certifier (`LEAN_PROJECT_DIR`, or a built environment) | to install Lean with elan; to run `pnpm harness lean-env build` or set `LEAN_PROJECT_DIR` |
| Kimina Lean server | nothing answers at `LEAN_SERVER_API_URL` (default `http://localhost:8000`), it refuses the machine (401, 403), or it answers something else | to start one ([lean.md](lean.md)); to set `LEAN_SERVER_API_KEY` |
| Model credentials | no provider has credentials | to set one provider's key (`pnpm harness models` lists the providers) |
| Price table | the chosen model (`--model`, or the cheapest) has no price in the host profile or in pi-ai | to give it a `models` entry in the host profile ([m0-loop.md](m0-loop.md#prices)), or to choose a priced model |
| Lean server memory | (a warning, never a failure) the Lean server on this machine takes more than the host profile's `leanServerMemoryWarnMb` (default 8 GB) | the Kimina settings that fit this machine's memory (`MAX_REPLS`, `MAX_REPL_USES`, `MAX_REPL_MEM`), and to restart the server with them when it has grown ([lean.md](lean.md#memory-of-the-lean-server)) |
| Network | the chosen model's provider cannot be reached | to check the connection, a firewall or a proxy |
| Literature search | (a warning, never a failure) the host profile has no `lit.search`, or it enables no backend; no request is made ([literature.md](literature.md)) | to use a profile that lists it |
| Certifier isolation | (a warning, not a failure) the host profile has no sandbox for the certifier and this machine has none | that results stay `computed` |

**The isolation profile.** The certifier runs a candidate's Lean code, and it refuses to without a sandbox
([certifier.md](certifier.md#where-untrusted-code-runs); Ruling 22). When the host profile in use has no
sandbox and does not opt out, `doctor` looks for bubblewrap and then Docker, and **runs the real recipe** (the `prlimit` and
`bwrap` command, or `docker run` with the image) around a small test on scratch directories: the work directory must be writable,
a file outside it must not be, no network interface but loopback may be visible, and a connection out must fail. Only a recipe that passes is
used; one that fails is reported with what it did wrong (a `bwrap` that cannot make a user namespace, an image that is missing, a daemon
that is down, a sandbox that does not confine). A sandbox the host profile already names is tested the same way. The recipe leaves your files
readable (the root is bound read-only): it protects what is written and the network, not what is read. Docker needs the image of the Docker recipe, `seshat-lean:4.27.0` or
`SESHAT_LEAN_IMAGE`, which must be an image name and not an option. If one works it writes
`config/hosts/sandboxed.json`: the host profile in use (`local.json` by default) with `lean.certify` behind the recipe of certifier.md (bubblewrap
with `prlimit`, no network, the filesystem read-only except the work directory; or the Docker recipe, no
network, read-only, all capabilities dropped, as your user). The file is written once and never over an
existing one (`--rewrite` replaces it, `--no-write` only checks), it is git-ignored, and no profile `doctor`
writes sets `unsandboxed`: that stays a choice a person writes down. `solve` and `doctor` use
`sandboxed` by themselves when it exists. `harness doctor --rewrite`, run with that generated profile in use, does not replace it:
once its sandbox passes the test it adds the capabilities of `config/hosts/local.json` the file lacks (`lit.search` with its `cacheDir`
beside the profile), keeps every capability it has (above all `lean.certify` and its sandbox) as it is, and names what it added; when
nothing is missing the file is not rewritten. Without `--rewrite` the file is never touched.

**Without any isolation** `doctor` writes nothing and says so: *every proof that passes the fast check stays
`computed`, and no claim can become `proved` or `refuted`.* `solve` still works, and `RESULT.md` says the
same in its words. The fail-closed rule of the certifier is unchanged.

## RESULT.md

Every run leaves `RUN_DIR/RESULT.md` next to its journal. It is built from the journal alone, by code: no
model writes it, it costs no token, and the same journal always gives the same text (`buildResult` and
`renderResult` in `packages/orchestrator/src/result.ts`).

**When it is written.** After every certified result (a claim that becomes `proved` or `refuted`) while the
run goes on; at every stop (a turn that ends at its token, dollar or time limit or at a breakpoint, the end
of the run, a budget that runs out, Ctrl-C); and once more when the process ends, which covers a crash
that the run itself survives to report. A process killed outright (`kill -9`, a power cut) writes
nothing, and `harness report RUN_DIR` rebuilds the file from whatever the journal holds. The file is
written whole or not at all (a rename), so a reader never sees half of one.

**What it holds**, in this order:

1. The headline, one line for each problem: proved or refuted (certified), a candidate (fast check only),
   or not solved yet, with the journal's reason.
2. Where the run stands: how it ended, or that the journal has no end; dollars, tokens and time; the
   journal's length, last hash and whether its hash chain verifies (a chain that does not verify is
   said first, above the headline). When you signed a statement, the statement, your words and the
   test lemmas.
3. A note when no certifier ran, with the reason the run recorded.
4. The claims by status.
5. **Lean proofs certified so far**: each with the validation behind it and the whole Lean file as it was
   checked. A proof is listed here only when a valid `kernel_replay` validation of that claim is in the
   journal.
6. **Passed the fast check, not certified**: candidates. They are `computed`, not results.
7. **Partial sketches with open holes**: the provers' last files that still have `sorry`, and what Lean
   said of them. Not proofs.
8. **Counter-examples** and **indicative evidence**: what programs, small models, fingerprints and
   conjectures found, each line marked as a lead or as evidence. None of it changes a claim's status.
9. What was tried and failed, by strategy, and the model calls and tools that failed.
10. Spend per site, and per rung of the ladder when the run has one.
11. The exact command that resumes the run (`pnpm harness resume RUN_DIR --checkout ...`), or the
    sentence that there is nothing to resume. The command comes from `resume.json`, which the run
    writes beside its journal with the checkout, the bench file and the host it began with; without it
    the command has placeholders.

**Text from the journal is inert.** Whatever a model, a program or a person wrote (statements, evidence, failures, reasons) is put into
`RESULT.md` with its backticks, angle brackets, brackets, exclamation marks, pipes and newlines escaped, and a statement is shown in a code span that
no backtick in it can close, so a preview of the file cannot be made to load an image or follow a link by what the journal holds. The resume command
is built from `resume.json` with each value quoted for a shell; a headline says `Proved` only when a valid replay of the claim itself is in the journal, and
`Refuted` only when one of its negation is.

**What it never does.** It never states a status the journal does not hold: the headline reads the
claim's status from the projection, "certified" means a valid kernel replay of that claim, and a claim
`proved` in the memory a run started on (`--memory-from`) is listed apart as carried, not as this run's
result. It reads a prefix of a journal as well as a whole one, which is what makes a cut run readable:
a test cuts a run at every event and checks that the file built from the prefix holds every certified
result up to the cut.

`harness report RUN_DIR` writes `report.md` and `report.json` as before and rewrites `RESULT.md`, for a run
whose process died.

## The view

`harness view RUN_DIR [--out FILE]` writes `RUN_DIR/view.html`: one static page built from the journal and
its blobs. It has no script, no link, no address and no form, and a content security policy
(`default-src 'none'`) forbids the browser to fetch anything; open it from the disk. It changes nothing in
the run: hints, signatures and steers stay commands ([human.md](human.md)). Every text that came from the
journal, a model or a person is escaped, so a statement that is HTML is shown as text.

The page has: the headline and, when the run signed a statement, the statement; **the proof** (the certified
Lean files, then the candidates and partial sketches under a warning that they are not results); **the
research graph**, one box per claim coloured by the status the journal holds, with its edges (a Lean-checked
edge solid green, a person's signature blue, a proposed edge dashed), and the same facts as tables; **the
account of each turn** of a consortium run (why it ended, what it spent, each problem's state, what the team is
asked, the answers since); **spend per site and rung**; the leads and the evidence, marked; what failed; and
the command that resumes the run. A journal whose hash chain does not verify gets a banner at the top.

## The local interface

`harness ui [--port N] [--open]` starts a page on your own machine (`127.0.0.1` only) that does what this page does without the command line: you write the statement, set the spend ceiling, sign the Lean statement beside your words, watch the cost by site with a stop button, read the result and copy the certified proof, and continue, hint or steer. Open the address it prints; it carries a token for the session. Keys for model providers can be saved on its Providers page, in a file only you can read. It starts the same commands and changes no claim's status: [ui.md](ui.md).
