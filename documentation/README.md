# Seshat documentation

Seshat is a harness for autonomous mathematical research with LLMs. Models are used only
through their APIs, Lean decides what is proved, and classical tools (automated provers, SAT/SMT
solvers, computer algebra, decision procedures) are used wherever they can do the job.

This folder describes the code as it is. A change to the code updates the page that describes it,
in the same commit.

## Start here

- [quickstart.md](quickstart.md): a problem of your own with the least friction: `harness solve`, `harness doctor`, `RESULT.md`.
- [status.md](status.md): beta v1: what has run for real, what has only run with simulations.
- [parameters.md](parameters.md): every setting, flag and host profile key.
- [ui.md](ui.md): the local interface, `harness ui`, and its settings menu drawn from the parameter catalogue.

  ![The settings menu](images/ui-settings.png)

## Concepts

- [trust.md](trust.md): claim statuses, and what it takes for a claim to be proved. Lean is the judge.
- [journal.md](journal.md): the hash-chained journal, the only source of truth, and its projections.
- [runs.md](runs.md): the words for runs (series, run, turn, problem, child, session, step), the two axes `horizon` and `human`, and which command is for which purpose.
- [campaign.md](campaign.md): `harness campaign`, a run that continues alone: turns that do not wait, the digest, how it ends, and what has not run.
- [frontier.md](frontier.md): the verified frontier, what a run has established about a problem, computed from the journal with no model call, and where it is shown.
- [lines.md](lines.md): the plan's mechanisms as lines a run switches on, and how they are measured one by one.
- [scheduler.md](scheduler.md): the escalation ladder and the budget gate, which put a price against a chance of success before each paid launch.

## Figures

Each figure is drawn by code from the page it sits in ([figures.md](figures.md): how they are made, and how to read
their colours and borders). Solid border: has run for real; dashed: tested with simulations only.

![Seshat at a glance](images/overview.svg)

### The whole

- [architecture.md](architecture.md): the packages as layers, and Lean beside them as the judge.

  ![The architecture](images/architecture.svg)

- [quickstart.md](quickstart.md): the solve loop, from a statement to `RESULT.md`.

  ![The solve loop](images/solve-loop.svg)

### Trust and Lean

- [trust.md](trust.md): claim statuses, and who may cause each transition.

  ![Trust](images/trust.svg)

- [certifier.md](certifier.md): the fast check makes a candidate; the kernel replay in a fresh, sandboxed process makes a proof.

  ![Certification](images/certification.svg)

- [lean-env.md](lean-env.md): Lean environments as data, and the gate in front of new Lean ([library-builder.md](library-builder.md)).

  ![Lean environments](images/lean-env.svg)

### Truth and memory

- [journal.md](journal.md): a hash chain of events; everything else rebuilt from it.

  ![The journal](images/journal.svg)

- [memory.md](memory.md): the memory store, the one interface over the journal.

  ![Memory](images/memory.svg)

- [graph.md](graph.md): line M2 as a worked example: a result on one claim becomes a result on its neighbour.

  ![The graph](images/graph.svg)

- [context.md](context.md): line M4, a packet under a token budget instead of the whole history.

  ![Context](images/context.svg)

### Tools

- [capabilities.md](capabilities.md): every tool behind a capability; levels, packs, the one rule for third parties.

  ![Tools](images/tools.svg)

- [classical.md](classical.md): line M10, classical tools before any model.

  ![The classical battery](images/battery.svg)

### Provers and search

- [m0-loop.md](m0-loop.md): a prover in fresh sessions; what carries over, and what each request sends.

  ![Sessions](images/sessions.svg)

- [scheduler.md](scheduler.md#blueprints-plan-change-ca9): blueprints, a hard problem as a graph of named holes (line M12; [repair.md](repair.md)).

  ![Blueprints](images/blueprints.svg)

- [fleet.md](fleet.md): Thompson draws before every session, one heuristic card or none ([heuristics.md](heuristics.md)).

  ![The fleet and the heuristic cards](images/fleet.svg)

### Budgets

- [scheduler.md](scheduler.md#the-budget-gate): the budget gate, a price against a chance, the probe first, rounds.

  ![The budget gate](images/budget.svg)

- [scheduler.md](scheduler.md#the-escalation-ladder-pe4-of-the-memory-evolution-plan-change): the escalation ladder ([curriculum.md](curriculum.md), [archive.md](archive.md)).

  ![The escalation ladder](images/ladder.svg)

### Runs, people and campaigns

- [runs.md](runs.md): the two axes of a run, and the seven nested words.

  ![Runs](images/runs.svg)

- [human.md](human.md): consortium mode, turns that stop and wait for the team.

  ![Consortium mode](images/consortium.svg)

- [campaign.md](campaign.md): a run that continues alone, judged by the verified frontier ([frontier.md](frontier.md)).

  ![Campaigns](images/campaign.svg)

### Measurement

- [ablate.md](ablate.md): one line at a time, same problems, same dollars, paired ([bench.md](bench.md)).

  ![Ablation](images/ablation.svg)

## Reference

- The command line: `pnpm harness --help`, and [capabilities.md](capabilities.md#the-harness-command) for the `harness` command.
- [parameters.md](parameters.md): the audit of every setting.
- [schemas.md](schemas.md): the schemas of line M15 (the capabilities' schemas are in [capabilities.md](capabilities.md#schemas)).
- [capabilities.md](capabilities.md): manifests, host profiles, contract tests, one section per capability.

## Development

- [development.md](development.md): conventions, tests, commits.
- [CLAUDE.md](../CLAUDE.md): what every agent that works on Seshat reads first.
- [plans/](../plans/seshat-plan-ledger.md): the plan, its rulings and the ledger of the build.

The full list of pages is at the end of this page.

## Status

Seshat is at beta v1. [status.md](status.md) says what has run for real (the graded bench, `harness solve` and
`harness ablate` on a real Lean and a real model, the fast check, the certifier, `lean.lsp`, `lean.search`, the
budget gate, lines M1, M6, M10 and M12) and what has only run against a simulated model and Lean. The measured runs
are in the task ledger ([plans/seshat-plan-ledger.md](../plans/seshat-plan-ledger.md)).

## Pages

- [status.md](status.md): beta v1: what has run for real, what has only run with simulations, and the status text the README used to carry.
- [figures.md](figures.md): how the figures are drawn by code (`pnpm figures`), and how to read their colours and borders.
- [architecture.md](architecture.md): packages, data flow, design rules.
- [runs.md](runs.md): the words for runs (series, run, turn, problem, child, session, step), the two axes `horizon` and `human`, and which command is for which purpose.
- [campaign.md](campaign.md): `harness campaign`: a run that continues alone, turns that do not wait, the digest, how it ends.
- [frontier.md](frontier.md): the verified frontier of a problem, computed from the journal with no model call, and where it is shown.
- [literature.md](literature.md): the intake: `lit.search` (OpenAlex, arXiv, Semantic Scholar, zbMATH, bench metadata), the judge call, the `literature` node, statement hygiene.
- [parameters.md](parameters.md): the audit of every setting: the run configuration's keys, the flags of every command, the host profile keys, and the findings (generated from `parameters.ts`).
- [trust.md](trust.md): claim statuses, and what it takes for a claim to be proved.
- [journal.md](journal.md): events, hash chain, projection, invariants.
- [ledger.md](ledger.md): the task ledger: tasks and their transitions, acceptance criteria, what
  the journal enforces, routing decisions, charges, sites, resume.
- [memory.md](memory.md): the memory store: claims, statement identities, edges, nodes and their
  kinds, queries, reference files, provenance and epochs, randomized inclusion, memory across runs.
- [lines.md](lines.md): the line API: the plan's mechanisms as lines a run switches on, their
  hooks and when they run, their contexts, the cumulative configs, how a task adds a line.
- [scheduler.md](scheduler.md): line M12: the given-clause loop, weighted proof numbers, subsumption,
  named holes as claims with inner provers, the escalation ladder, owners and resume.
- [curriculum.md](curriculum.md): line M18: the curriculum of variants, rung 1 of the ladder: variants of a hard
  problem, the capped share of the budget, the proofs in the briefing, the `runTask` hook, resume.
- [archive.md](archive.md): line M15: the archive of alternative decompositions in cells, fitness from the labels, the Thompson
  pick of the cell a session extends, schema hints through the randomized inclusion, their effect, the report, resume.
- [schemas.md](schemas.md): the schemas of line M15: token trees, anti-unification, matching, instantiation through
  `lean.meta`, the strict screen and reuse (the archive and the line are in archive.md).
- [graph.md](graph.md): the graph: variants and edges checked by Lean, the propagation rules and
  composed proofs, the prove/refute twin, labels and nogoods, PageRank and graph queries, the line M2.
- [library-builder.md](library-builder.md): the optional LibraryBuilder (a coding agent behind Seshat's gate), the review status of
  definitions, gap triggers, `harness library build`.
- [library.md](library.md): line M3: promotion of proved auxiliary lemmas, the library as nodes and Lean files, the BM25 search
  and its source order, the briefing section and `library_search`, `harness library export`.
- [context.md](context.md): line M4: the compiled packet (frozen prefix, tail), premise selection, `expand` and `graph_query`
- [lessons.md](lessons.md): line M5: lessons added from outcomes and never rewritten, the draw, counters and deactivation by effect,
  staged promotion to the global scope, `harness lessons`.
- [consolidation.md](consolidation.md): the consolidation pass between runs (CA24): `harness consolidate`, state cards of the open problems, duplicate and unsupported
  lessons, the page "what was tried and why it stopped" with its sentence rule, `--consolidation`, the turn-end section.
- [m1-identity-memory.md](m1-identity-memory.md): the M1 line: one claim per statement, strategy
  labels, failure classes, the "already tried" section, the redundant-attempts metric.
- [guards.md](guards.md): the M6 line: neutral framing, resolved citations, no raw error text,
  anchored revisions, the drift detectors, and the `drift` nodes they write.
- [fleet.md](fleet.md): the fleet line: posteriors per strategy and model, Thompson sampling, adaptive
  width, escalation, and the `allocation` nodes.
- [quickstart.md](quickstart.md): a problem of your own with the least friction: `harness solve` (a
  Lean or prose statement, the signature of prose, the student defaults), `harness doctor` (what the machine
  lacks, the isolated host profile), `RESULT.md` (what a run leaves, whatever stopped it) and `harness view`
  (one static HTML page of a run), and the local page `harness ui` ([ui.md](ui.md)).
- [informal.md](informal.md): the informal proof first (option `informalFirst`): a proof in natural language, read by a verifier until three passes in a row, a hint that Lean has not checked and that never changes a status.
- [models-setup.md](models-setup.md): the providers for a first real run: DeepSeek's own API as the run's model (its key, its
  prices and off-peak calendar in the host profiles, `SESHAT_MODEL`), Jev at OpenRouter or at TypeSafe for `decide`, the
  variables, and what has not run.
- [ui.md](ui.md): the local interface, `harness ui`: a journal reader, a loopback server with a token and a process manager for
  the commands, provider settings with keys kept outside the repository, and the screens.
- [human.md](human.md): consortium mode: turns that end at a limit or a breakpoint, the account of
  each turn, the team's hints, signatures and steers, and what an answer can and cannot change.
- [validator.md](validator.md): problem sketches, the editable regions, the checks.
- [m0-loop.md](m0-loop.md): the M0 loop: runs, problems, provers, sessions, certification and the
  outcomes, budgets, the run directory, `harness run` (and `--resume`) and `harness report`.
- [lean.md](lean.md): Lean checkers, the Kimina client, deployment.
- [lean-env.md](lean-env.md): Lean environments as data: the environment files, the resolver and
  what it refuses, the lock and the environment hash, the build, `harness lean-env`, and line M17.
- [certifier.md](certifier.md): the certifier: what it answers, the process, the Lean program, where
  untrusted code runs, its settings, deployment, what is still to verify against Lean.
- [lean-meta.md](lean-meta.md): the Lean meta tool: SeshatMeta's commands, the canonical form and
  `st1_` ids, `lean.meta`, `LeanIdentity`, `lean.goals` over Pantograph, deployment.
- [lean-lsp.md](lean-lsp.md): Lean's language server for the provers: `lean.lsp` over lean-lsp-mcp,
  its eight operations, what it never does, the pinned version, installing it, the network sites,
  the settings, the tests.
- [capabilities.md](capabilities.md): the capability registry, manifests, host profiles, MCP,
  scopes, contract tests, the `harness` command.
- [heuristics.md](heuristics.md): the bank of heuristic cards: a heuristic is a method of reasoning, not a tool; the card format,
  the families, the context a `when` reads, the built-in cards, overlaps, and what is the bank's and what is not.
- [packs.md](packs.md): installable packs of tools and skills: `pack.json`, what a pack may be, `harness add`,
  `packs` and `remove`, level 2, the three-skill rule, the content hash a run records.
- [compute.md](compute.md): SageMath for the provers: installing it, its settings and resources,
  what it offers and refuses.
- [bench.md](bench.md): the formal-conjectures bench and its index, and the graded bench (grades A, B, C; Task 33).
- [models.md](models.md): small models of the discrete domain: batteries of magmas, groups,
  graphs and integers, evaluators, fingerprints, certified refutations, identification of
  sequences, the OEIS, LMFDB and FindStat as capabilities (line M11).
- [finite-lean.md](finite-lean.md): the Lean templates for finite graph witnesses (`lean/SeshatLib/Finite`), the generator that renders a
  witness into a refutation, and what to verify on a real Lean.
- [induction.md](induction.md): the inductive engine and what a program may do: data tables, the classical
  conjecturing (recurrences, PSLQ, the Dalmatian heuristic), the sandbox for programs, and the lines M8,
  M13 and M16 as they are built.
- [repair.md](repair.md): typed repairs from failure classes (the critics of Ireland and Bundy) and the
  Lakatos-style repair of a refuted conjecture (line M14).
- [classical.md](classical.md): line M10: the domain router, the Lean tactic battery ordered by Beta
  posteriors, the hammer at several cutoffs, the non-triviality test.
- [decide.md](decide.md): typed decisions that order work: the sites and the forbidden list, the backends
  (the run's model, Jev, faux), the configuration, the fallback, the 32k refusal, what is journaled,
  resumption, calibration, and that proof states go to a third party when Jev is on.
- [audit.md](audit.md): `harness audit RUN_DIR`: one dossier per problem that was not certified (spend by site, sessions and their tool calls, the
  gate's answers, the last Lean errors, the last sketch, the informal proof), from the journal alone, optionally beside a person's reference solution.
- [ablate.md](ablate.md): `harness ablate`: the cumulative configurations and the experiments, what each column of the table measures,
  the reliability of decisions, the cost-to-first-success curves, the entrenchment probe, the bench's sequences and `bench-ext`; the paired protocol (Task 33): Wilson intervals, the exact McNemar test, problems solved per dollar and the target line.
- [prompts.md](prompts.md): the prover's system prompt as a file, the strict screen a rewritten prompt passes, and `harness optimize-prompts`:
  GEPA-style rewriting on a dev split, the held-out and temporal gate, and the proposals a person merges.
- [development.md](development.md): conventions, tests, commits.
