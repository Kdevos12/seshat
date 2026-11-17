# Plan change: long runs alone (a verified frontier that drives the run)

Status: **APPROVED by the owner on 2026-11-17 at 10:48 UTC** ("Oui exactement, tout me va. Go"), every
item LH1 to LH9, with the recommended answers to the questions of section 6 (recorded there). Nothing
built yet. Written by the research thread "Auditer
Seshat pour les très longs runs" after the owner asked whether, leaving performance aside, Seshat has the
tools, the autonomy, the memory and the loop to work alone on large open problems over very long runs.
The audit and its sources are in `research/longs-horizons.md` (French, outside the repository). Items are
named LH1 to LH9. This change is additive and builds on `plans/plan-change-research-agent.md` (RA1 to RA11,
direction approved on 2026-11-12, Tasks 46 to 48 not started); it does not need the research agent to be
built first.

Read against branch `claude/project-thread-h60gyw` at `4283ccf` (Ruling 40).

## 1. Why

What `harness solve` does on an open problem today, from the code:

- The probe (one session, at most 10% of the allowance) must make Lean progress, or the budget gate ends
  the problem (one extension in `v2`). Lean progress (`progressOf`) is a new proved subclaim or fewer
  open holes, which needs blueprints; an open problem rarely shows it in one session.
- A problem has at most `provers x sessions` = 4 x 8 sessions; when they are used it ends `unsolved`,
  whatever money is left.
- Consortium mode is always on in `solve`: a turn ends at half the allowance or at the `impasse`
  breakpoint (8 finished attempts without success: the posterior mean 1/(2+n) reaches 0.1), and then the
  run **waits for a person**. On an open problem the impasse fires within the first hour.
- Each prover carries its own file and notes from session to session: one trajectory, continued.
- The state card counts Lean failure classes; the lines that keep ideas, lemmas and alternatives (M2,
  M3, M5, M15, the consolidation pass) are off in `solve` or only in an arm; M16 (program search with a
  Lean-certified witness) sits on rung 2 of a ladder that `solve` does not turn on; the literature is
  read once, before the start.
- Nothing restarts the process after a crash, a reboot or a usage limit: `harness resume` is manual.

What is already right for long runs and stays at the centre: the hash-chained journal as the only truth,
a turn that is a clean kill (a run in three turns ends as one run), budgets read back from the journal,
fresh sessions, a state card built by code, off-peak pricing.

What the long-horizon literature says (sources in the research note): long runs fail by execution errors
and self-conditioning on their own mistakes, not by a full context (Sinha et al. 2025; Vending-Bench);
inherited state from a failed attempt hurts and the full history hurts most (Recovery-Bench); rolling
back while keeping the reflection pays (RIR 2026); a cold restart pays only when the interrupted work is
offered as an optional overlay (RestartSmart 2026); what keeps a long run coherent is an external
structured state and steps that only a test can mark done (Anthropic's long-running harness, Kosmos);
periodic fresh starts stay necessary (Cursor); a model that rewrites its accumulated context collapses it,
deltas merged by code do not (ACE); an agent that does not see its budget does not use it (BATS); with
heavy-tailed run times, restarts on a universal schedule are near optimal, and independent short runs are
the baseline to beat.

## 2. The principle

**Lean becomes the progress meter of the long run, not only its final judge.** A *verified frontier* is a
projection of the journal, computed by code with no model call, of everything the run has established
about the problem. It only grows. The long-run loop reads its growth per dollar to decide whether to
continue, restart, change mode or stop. A model's plan (RA2) proposes; the frontier records what Lean
accepted. Nothing in this change lets any model, tool or person change a claim's status.

## 3. The items

### LH1. The verified frontier

`frontier(store, claimId)` in `@seshat/memory`, beside `stateCard`, deterministic (the same journal gives
the same frontier, byte for byte), with typed entries, each with its cost, time and provenance:

- `subclaim`: a claim joined to the target by `decomposes_into` or proposed by a plan, `computed` or
  `proved`; an `aux_` lemma Lean accepted (`accepted_lemmas`);
- `case`: a specialization of the target proved by Lean (a parameter fixed, a range `n <= N`);
- `variant`: a variant proved (M18, M2), with its edge to the target;
- `reduction`: a `lean_checked` implication edge into the target or a subclaim;
- `dead_end`: an intermediate statement refuted by a Lean-checked counterexample or proof of negation;
- `evidence`: a bounded computation ("no counterexample up to N"), never a status, shown as evidence;
- `best`: the best score of an M16 search and its certified witness, if any.

A frontier **score** is a weighted count, the weights in configuration (default: every entry 1, a
`reduction` or a `subclaim` on the plan's critical path 3). The frontier is shown in the state card (its
top entries, within the card's bound), the turn's account, `RESULT.md` and the interface. Without the
option nothing changes.

### LH2. Campaign mode: a run that continues alone

`harness campaign` (or `solve --solo`): consortium turns that do not wait.

- At each turn end the supervisor runs the model-free consolidation (CA24, built) and LH1, applies the
  step-back policy (LH5) and resumes. With the research agent (Tasks 46 to 48) the step-back is RA7's
  choice; without it, the rules of LH5.
- A person is never waited on. `hint`, `steer`, `sign` stay available at any time; a question (RA5's
  `ask the team`) freezes only the branch it is about and goes into an asynchronous digest
  (`campaign/digest.md`, rebuilt by code after each turn; optionally the narrative, capped).
- A watchdog resumes after a crash, a reboot or a provider usage limit, with backoff; a lock file stops
  two supervisors on one run; a heartbeat file says the run is alive.
- Pacing: a dollar cap per day (`--usd-per-day`), off-peak by default, a wall-clock end (`--until`).
- Stops: the allowance, the claim settled, or a plateau after every mode of LH5 (LH6).
- The impasse breakpoint is read as "change mode" in campaign mode, not "stop and wait".

### LH3. Sessions bounded by money, restarts by schedule

In campaign mode the number of sessions is not a cap: money and the frontier bound the run.

- A prover's trajectory is restarted **cold** on a schedule: geometric session lengths (6, 12, 24, 40
  turns) or Luby's sequence, the choice an option measured in LH7; and early when the self-conditioning
  signal fires: the same failure class on the same goal in K consecutive checks, or the repeat rule.
- A cold restart carries only the frontier, the dead ends and the plan; the last file and notes are
  offered as an optional overlay the session may open with a tool (`previous_attempt`), never pasted
  into its context.
- The probe gate in campaign mode reads the frontier, so a first session that proves a useful lemma
  outside a blueprint counts as progress.

### LH4. The campaign dossier and the dead-end store

A bounded dossier in tiers, rebuilt by code at each session start, never rewritten by a model:

- L0, always shown: the signed statement and the frontier's top entries (Lean names and statements are
  their own summary, so this tier cannot collapse);
- L1: the plan and the top obstacles (RA2), when the research agent exists;
- L2: dead ends and failed approaches as items with metadata (approach, why it failed, the Lean evidence
  if any), merged by deltas, de-duplicated by `normalizeDetail` and statement identity;
- L3: unverified items (lessons, consolidation page) through the randomized inclusion that exists.

Each L2 item has an activity count (shown and followed by progress, shown and ignored, recalled by a
session). Periodically the least active half of the items past a size bound is retired (kept in the
journal, no longer shown), as a SAT solver reduces its learned clauses. The models only propose items
(a reflection call, capped); code merges them (ACE).

### LH5. Plateau modes, by rule

When the frontier score has not grown over a window (dollars, default 10% of the allowance), the
supervisor changes mode, in this order, skipping what does not apply to the statement:

1. **specialise**: prove cases or a curriculum of variants (M18, on in campaign mode);
2. **test**: look for a counterexample to the target or to the plan's open lemmas (M11 and the
   classical battery on each `sorry`, Ruling 40), so a dead end is found before more is spent proving;
3. **construct**: for an existence, a construction or a bound, M16's program search, with two options
   from ShinkaEvolve: reject a candidate program too close to one already scored before running it, and
   balance parents between the best and the rest;
4. **read**: query the literature again with the terms the frontier added (needs the person's consent,
   as today; skipped with `--private`);
5. **reformulate**: a generalization or an analogous statement, as a variant claim (owner's direction of
   2026-10-20).

A mode that adds to the frontier keeps the run on it; one that does not passes to the next. Each change
is a journaled decision with its reason.

### LH6. Guards for long runs

- No "done" without Lean: a campaign ends `settled` only through the certifier; every other end is
  `stopped` with the frontier.
- Campaign-level spiral detector: spend without frontier growth across two full cycles of LH5, or the
  same plan revision three times, ends the campaign with an honest report ("out of reach at this budget,
  here is what is established").
- The signed statement is locked as today; every plan goal is a Lean statement or an evidence need
  (RA2), so no goal drifts into prose.

### LH7. The measure

Not "problems solved", but whether a long run is more than restarts.

1. **Simulated marathon in the test suite** (faux provider, simulated Lean): 30 simulated days, injected
   crashes, usage limits and reboots. Properties: no work lost, every turn resumed, the daily cap kept,
   the frontier monotone, the prompt size of a session flat over time, the dossier bounded.
2. **A real marathon**, with the owner's approval: one grade C problem (a research problem with a formal
   proof elsewhere), DeepSeek off-peak, $10 over about three days on the owner's machine; recorded: the
   frontier against dollars, restarts and why, mode changes, drift events, context size per session.
3. **The baseline**: the same $10 spent as ten independent `solve` runs of $1 on the same problem. A
   campaign that does not beat it (more certified, or a larger frontier at the end, by the paired
   protocol where the counts allow) stays an option or is removed.

### LH8. The budget and the frontier in each session

Each session's opening message says what remains (dollars for the session and the campaign) and the
frontier's size and last addition (BATS: an agent that does not see its budget does not use it). One
line, data in the user-role message.

### LH9. One vocabulary for runs: two axes and one kind of child

Asked by the owner on 2026-11-17 (10:41 UTC): distinguish long runs, short runs and short sub-runs
executed inside a long run, and check that the kinds of run are well organized. They are not: the code
has grown run shapes one by one (`run`, `solve` and its sets, consortium turns, `resume`, `ablate`,
`consolidate`, `optimize-prompts`, `library build`), and the words overlap. `--turns` counts a session's
model responses while `--turn-usd` limits a consortium turn; "consortium" reads as a kind of run though
it is a pausing policy that applies to any run.

Proposed vocabulary, from the outside in. A level contains the ones below it; only the run has a journal.

| Level | What it is | Bounded by |
|---|---|---|
| series | runs chained by `--memory-from`, with a consolidation pass between them | the person |
| run | one directory, one journal, one configuration: the unit of truth and of replay | its allowance |
| turn | the work between two stops of a run (consortium, a crash, a usage limit) | a turn limit |
| problem | one target claim inside a run | its allowance share |
| child | a delegated piece of work with a contract (today: probe, prover task, hole session, informal loop, planner round, M16 search, M18 variant; with RA: prove, explore, read, formalize) | a ledger carved from its parent |
| session | one fresh model context | `steps`, context size |
| step | one model response (today `turns`, renamed `steps`, the old flag kept as an alias) | |

Two axes set on the run, orthogonal, instead of more kinds of run:

- **horizon**: `episode` (today's `solve` and `run`: a bounded number of sessions, it ends when they are
  used) or `campaign` (LH2: money, time and the frontier bound it; cold restarts; a watchdog);
- **human**: `none` (measurement: `ablate` forces it), `consortium` (a turn ends at a limit or a
  breakpoint and waits), `digest` (LH2: it never waits, questions freeze only their branch).

So "consortium short" is `episode` + `consortium`, "consortium long" is `campaign` + `consortium`, and
`solve` is `episode` + `consortium`. Purposes stay separate commands because their rules differ:
working a problem (`run`, `solve`, `campaign`), measuring (`ablate`, refuses a person), and maintenance
between runs (`consolidate`, `optimize-prompts`, `library build`), which never touch a claim's status.

**The owner's sub-run is a child, not a run.** A short run with its own journal inside a long one would
split the truth in two and break replay. A child keeps the run's journal and has one contract shape
whatever its kind: the goal (a claim or an evidence need), the kind, a ledger carved from its parent's
remainder, the tools it may use, the typed output it writes, how it resumes. Today the seven existing
children are started from separate code paths (`probe.ts`, `hole-session.ts`, `informal.ts`, the lines' own
hooks), each with its own handling of budget, prompt and resume (not audited one by one); LH9 gives them one interface
(`ChildSpec`, `runChild`) so that the campaign (LH2, LH5) and the research agent (RA3) start any of them
the same way. Behaviour unchanged; a refactor with the existing tests as its guard, plus one test per
kind that it starts, is charged and resumes through the common path.

Cost: small for the vocabulary and the two fields (`RunConfig.horizon`, `RunConfig.human`, the
existing flags mapped onto them, recorded in `run.started`); medium for `ChildSpec`, done before LH2
and RA3 so that both build on it.

## 4. Trust rules, unchanged

Lean is the judge: only a Lean check makes `computed`, only the certifier's kernel replay makes `proved`
or `refuted`. The frontier, the dossier, the digest and the dead-end store are projections of the journal.
`evidence` entries are never a status. Answers of a person change what agents are told and the order of
work, never a status. Fetched text is data. Models through their APIs only; no training. Tests run without
Lean, a model or a network.

## 5. Order and cost

1. LH9 (vocabulary, then `ChildSpec`), LH1, LH8, LH3: model-free code. LH7.1 alongside.
2. LH2 minimal, without the research agent: supervisor, watchdog, pacing, digest, impasse as a mode
   change. Then the real marathon (LH7.2, $10, owner's approval).
3. LH4, LH5, LH6, using the research agent (Tasks 46 to 48) if it is built by then; without it, by rule.

Interfaces touched (shared files, additive): new events `campaign.started`, `campaign.mode_changed`,
`campaign.stopped`, `frontier.snapshot` (optional, a cache of the projection); optional `RunConfig`
keys `campaign` and `frontier`; new commands `harness campaign` and `harness frontier RUN_DIR`.

## 6. Questions for the owner, and the answers (2026-11-17, 10:48 UTC: "tout me va")

1. The baseline: long runs are kept only if they beat the same money spent as independent `solve`
   runs. **Agreed.**
2. Solo means never blocking: a question freezes only its branch and goes to an asynchronous digest.
   **Agreed.**
3. The first real marathon: $10, about three days, off-peak, on pop-os, a grade C problem before a truly
   open one. **Agreed** (the spend itself still starts only when the build is ready and the machine is
   available; the owner keeps the DeepSeek balance in view).
4. Constructions: ShinkaEvolve's two ideas (novelty rejection, parent balance) added to M16, not a
   wrapped ShinkaEvolve. **Agreed.**
5. LH9 (asked by the owner at 10:41 UTC): the run vocabulary, the two axes `horizon` and `human`, and
   sub-runs as children of one journal with one contract, built first. **Agreed.**

## 7. What is not verified

Nothing here has run. Several sources were read through their abstract or a third-party summary
(marked in the research note); their figures were not recounted. That the frontier predicts a final
solution, and that a long run beats independent short runs at equal dollars with a cheap model on
research problems, are hypotheses that LH7 is there to test.
