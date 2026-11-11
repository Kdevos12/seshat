# Seshat documentation

Seshat is a harness for autonomous mathematical research with LLMs. Models are used only
through their APIs, Lean decides what is proved, and classical tools (automated provers, SAT/SMT
solvers, computer algebra, decision procedures) are used wherever they can do the job.

This folder describes the code as it is. A change to the code updates the page that describes it,
in the same commit.

## Status

Phase P0a builds the parts that need neither Lean nor a model, and the M0 loop, tested with a
simulated model and a simulated Lean.

| Part | Package | State |
|---|---|---|
| Event journal, claim statuses, SQLite projection | `@seshat/core` | Done, tested |
| Memory store: claims, edges, nodes, reference files | `@seshat/memory` | Done, tested; reference files not run against Lean |
| Line API: hooks, contexts, cumulative configs, `harness run --lines` | `@seshat/lines`, `@seshat/orchestrator` | Done, tested with fake lines, M1, M2, M6 and the fleet |
| M1: shared claims by statement identity, strategy and failure classes, "already tried", redundant attempts | `@seshat/memory`, `@seshat/orchestrator` | Done with the text identity, tested with a simulated model and Lean; the Lean identity is not built |
| Variant graph and logical propagation (line M2): variants, checked edges, propagation rules, composed proofs, the prove/refute twin, proved-modulo labels, PageRank, graph queries | `@seshat/graph` | Done, tested with a simulated Lean; not run against Lean |
| Line API: hooks, contexts, cumulative configs, `harness run --lines` | `@seshat/lines`, `@seshat/orchestrator` | Done, tested with fake lines and with M11 |
| M6: neutral framing, resolved citations, no raw error text, anchored revisions, drift detectors | `@seshat/guards`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean; the thresholds are untuned and the Lean meta tool's predicates are injected, not plugged in |
| Fleet policy: Thompson sampling on strategy and model verdicts, adaptive width, escalation | `@seshat/fleet`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean; the thresholds are untuned and subgoals are the claims for now |
| Problem sketches and proof validator (fast check) | `@seshat/core` | Done, tested with a simulated Lean |
| Kimina Lean Server client | `@seshat/lean-kimina` | Done, tested with a simulated server |
| Bench built from formal-conjectures | `@seshat/bench` | Done: 575 problems, index committed |
| The graded bench, the paired protocol and loop telemetry (Task 33, CA1 to CA3): `harness-bench graded`, `--grade`, the protocol section of `harness ablate`, the Loop section of the report | `@seshat/bench`, `@seshat/orchestrator` | Done, tested on fixture checkouts, a fake `lake` and scripted journals; no index committed, no real Lean admission, no paired run |
| Capability registry, MCP boundary, `lean.check` and its contract | `@seshat/registry` | Done, tested with simulated servers |
| `harness` command (capabilities, health, contract tests, models, runs, reports) | `@seshat/orchestrator` | Done |
| M0 loop on pi: provers in sessions, notes, budgets, report | `@seshat/orchestrator` | Done, tested with a simulated model and Lean |
| Computer algebra for the provers: SageMath (`compute.sage`), `harness run --tool` | `capabilities/compute.sage`, `@seshat/orchestrator` | Done; contract passed against a local SageMath, Docker image not tried |
| Lean meta tool: statement ids, `isDefEq`, premises, profiles, instances (`lean.meta`); `LeanIdentity`; goals one tactic at a time (`lean.goals`, Pantograph) | `@seshat/lean-meta`, `lean/SeshatMeta` | TypeScript done, tested with a simulated Lean and a fake Pantograph; the Lean library never compiled |
| Lean's language server for the provers: goals at a line, tactics tried at a line, Mathlib search (`lean.lsp`, lean-lsp-mcp 0.31.0), `harness run --tool lean.lsp` | `@seshat/lean-lsp`, `capabilities/lean.lsp`, `@seshat/orchestrator` | TypeScript done, tested with a stand-in server whose shapes were taken from the real release, and (opt-in, `LEAN_LSP_MCP_PYTHON`) against the real server with canned back-ends; not run against a real Lean |
| `lean.search`, pushed by the harness (Task 40, CA22): a capability with three backends (a remote service, a local BM25 index, a pattern search), the harness's search on each unknown identifier and each hole's goal after a check, every hit checked with Lean before it is shown, `RunConfig.leanSearch` | `@seshat/lean-search`, `capabilities/lean.search`, `@seshat/orchestrator` | TypeScript done, tested with a simulated Lean and fake services; not run against a real Lean, service or Mathlib index |
| Line M11: batteries of small models, fingerprints, certified refutations, identification of sequences; the OEIS, LMFDB and FindStat as capabilities (`oeis.search`, `lmfdb.query`, `findstat.identify`) | `@seshat/models`, `capabilities/` | Done, tested with a simulated Lean and a local stand-in for the sites; not run against a real Lean, SageMath, or the OEIS, FindStat and LMFDB |
| Task 41: counterexamples on finite structures: statements about graphs in M11 (option `graphs`), the Lean templates `lean/SeshatLib/Finite`, a local search and families (CA18 to CA20) ([models.md](models.md#statements-about-graphs), [finite-lean.md](finite-lean.md)) | `@seshat/models`, `@seshat/induction`, `lean/SeshatLib/Finite` | Done, tested with a simulated Lean, the faux model and a stand-in for SageMath; the Lean templates never compiled, nauty through SageMath and a real model not run |
| Task 36: intake: literature search (`lit.search`), the judge call, the `literature` node, statement hygiene, `harness solve --tool` ([literature.md](literature.md)) | `@seshat/lit`, `@seshat/orchestrator`, `capabilities/` | Done, tested with a fake literature server, the faux model and a simulated Lean; not run against any site, real model or real Lean |
| Consortium mode: turns that end at a token, dollar or time limit or at a breakpoint (impasse, a problem settled, two informal validators in disagreement), the account of each turn built from the journal, the team's hints, signatures and steers, `harness hint`, `sign`, `steer` and `resume` | `@seshat/core`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean (a run in three turns reaches the outcome of one that is not interrupted, on a sampled matrix of cuts); the optional narrative of a turn needs a model and has run only with the faux one; the account is not sent to chat |
| Line M12: given-clause loop with age/weight selection, weighted proof numbers, subsumption through Lean-checked instances, named holes of a sketch as claims worked by inner provers, the escalation ladder and its report, owners chosen by the fleet | `@seshat/scheduler`, `@seshat/fleet`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean (a run cut at every event of its journal resumes to the outcome and cost of one that is not cut); the link lemma, the instance closers, `lean.meta` and the rungs above 0 have not run against Lean or exist |
| Line M18: a curriculum of variants, rung 1 of the ladder: special cases and weakenings of a hard problem as claims with `special_case_of` edges and tasks, solved with a capped share of the budget, their proofs in later briefings; the `runTask` hook | `@seshat/scheduler`, `@seshat/lines`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean (a run cut at every event of its journal resumes to the claims and tasks of one that is not cut); no real model or Lean has run it, and nothing says it pays |
| Line M15: an archive of alternative decompositions in diversity cells (fitness from the labels, replacement by strictly higher fitness), a Thompson pick of the cell a session extends, schemas extracted from closed sub-DAGs with anti-unification and instantiation through `lean.meta`, schema hints through the randomized inclusion and their measured effect, the report | `@seshat/scheduler`, `@seshat/library`, `@seshat/orchestrator` | Done, tested with a simulated model, Lean and `lean.meta` (a run cut at every event of its journal resumes with at most one snapshot and schema); no real model, Lean or `lean.meta` has run it, the statement sent to `lean.meta` was never elaborated, and nothing says it pays |
| Line M3: promotion of proved auxiliary lemmas (non-trivial, general, deduplicated by statement id) as claims and `library_lemma` nodes, the BM25 index, `library_search`, a drawn briefing section, compiled again when the Mathlib revision changes, `lean/SeshatLib` files by `harness library export`, the report of the share of proofs that use it | `@seshat/library`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean; the non-triviality test is a stand-in for Task 6's battery, the export of declarations is an interface with a fixture; not run against a real Lean or model |
| Line M5: lessons from accepted proofs and from failures that recur, a drawn briefing section, counters, deactivation by effect, global promotion staged under `--human`, `harness lessons pending\|approve\|reject`, the report | `@seshat/lessons`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean; not run against a real model, and no measure that lessons help |
| Line M4: the context compiler: a frozen prefix and a tail per request (goal, facts with badges, premises by MePo, SInE and k-NN, already tried, lessons, last raw Lean feedback), citable ids, `expand` and `graph_query`, the naive arm | `@seshat/context`, `@seshat/graph` | Done, tested with a simulated Lean and the faux model; the Mathlib export is a fixture; not run against a real Lean or model, and no measure that it beats the history |
| Certifier (kernel replay) | Lean code | Needs a Lean environment |
| The LibraryBuilder (off by default, outside ablations): `none`, or a coding agent in a sandboxed clone with only the environment variables the config names; Seshat's gate (a diff that only adds files under `lean/SeshatLib/<Domain>/` or the ported package, the validator's token screen, a fresh `lake build`, the certifier on every new theorem, the spec's test lemmas against the spec's own statements), a journaled record, `adoptBuild` between runs; definitions `unreviewed` until a person or two checkers review them, and never in claim statements before that; gap triggers; `harness library build`, `gaps`, `definitions`, `review` and `deprecate` | `@seshat/library-builder`, `@seshat/memory`, `@seshat/orchestrator` | Done, tested with a fake agent script, a fake `lake` and a fake certifier; no real coding agent, Lake, Lean or certifier has run it; the triggers are not wired into a run |
| Lean environments as data: `lean/env/NAME.toml`, the resolver that refuses disagreeing toolchains and shared dependencies, the lock with the environment hash, `harness lean-env resolve`, `build` and `show` | `@seshat/lean-env`, `@seshat/orchestrator` | Resolver and lock done, tested on fixture manifests; `build` written against Lake, tested with a fake `lake`; nothing run against Lean, Lake or GitHub |
| Line M17: the run's Lean environment is the line's (`extended` by default): registry built for it, the extra packages' imports in every file, a probe of the server, the run refused unless the environment is resolved | `@seshat/lean-env`, `@seshat/lines`, `@seshat/orchestrator` | Done, tested with a simulated Lean; not run against a real Lean, Lake or server |
| Certifier: kernel replay in a fresh process, the capability `lean.certify`, and its use in a run (`proved`, `refuted`) | `@seshat/lean-local`, `lean/SeshatCertify`, `capabilities/lean.certify`, `@seshat/orchestrator` | TypeScript done, tested with a fake `lake` and fake certifiers; the Lean program never compiled |
| Typed decisions that order work (`decide`): the run's model by default, Jev by configuration, the forbidden list, the 32k refusal, `decision.made`, the interface for `prove.search`'s orderer, the fleet's cold start (`decide.ask`) | `@seshat/decide`, `capabilities/decide.ask`, `@seshat/core`, `@seshat/orchestrator` | Done, tested with a fake Jev server, the faux backend and a simulated model; never run against a real Jev, OpenRouter or TypeSafe; Task 6's orderer has no caller yet |
| The bank of heuristic cards: the card format, 22 closed families, context features computed without a model, 29 built-in cards (the six directives and 23 starter cards from nine traditions), the overlap check, cards in packs, the fleet's draw with a control arm, the statistics in the report and `harness heuristics list\|stats` | `@seshat/heuristics`, `@seshat/fleet`, `@seshat/registry`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean; no measure of whether a card helps a real model |
| Installable packs: `pack.json`, tools at level 2, skills and heuristic cards, `harness add\|packs\|remove`, the `pack.installed` journal, the content hash a run records, the three-skill rule | `@seshat/registry`, `@seshat/core`, `@seshat/orchestrator` | Done, tested with temporary directories, a local git repository and the test MCP server; no third-party pack, no contract case run on a host, and no tool-search tool or skill caller reads the index yet |
| Task ledger: tasks and their transitions, typed routing of failures and drift, model-call sites, `harness run --resume` | `@seshat/core`, `@seshat/scheduler`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean and with a process killed by SIGKILL; a run with M1, M2, M6, M11 or the fleet can be resumed, tested by cutting runs at every event of their journals; never run with a real model or Lean |
| Integration (Task 14): every line in one run, `harness ablate` (the cumulative configurations and ten experiments: ladder, packet modes, renderings, queries, seeds, lessons, counterexample set, `lean.lsp`, Jev per site, M17), the measures of the amendments (spend per site, reliability and ECE, cache per rung and line, tool-definition tokens), cost-to-first-success curves (`harness chunks`), the entrenchment probe (`harness probe`, `run --probe-every`), the `packetMode` option, the bench's sequences and tags, `bench-ext` | `@seshat/orchestrator`, `@seshat/bench` | Done, tested with a simulated model and Lean and with scripted journals; nothing here ran against a real model, Lean, Jev or the equational-theories data |

None of this has run against a real Lean or a real model yet, because the development environment
blocks the Lean toolchain downloads and has no model credentials.
[lean.md](lean.md#to-verify-against-lean) lists what depends on Lean's exact output;
`pnpm harness contract lean.check` checks it against a server
([capabilities.md](capabilities.md#leancheck)). The first real run is then
`pnpm harness run` ([m0-loop.md](m0-loop.md#commands)).

## Pages

- [architecture.md](architecture.md): packages, data flow, design rules.
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
- [ablate.md](ablate.md): `harness ablate`: the cumulative configurations and the experiments, what each column of the table measures,
  the reliability of decisions, the cost-to-first-success curves, the entrenchment probe, the bench's sequences and `bench-ext`; the paired protocol (Task 33): Wilson intervals, the exact McNemar test, problems solved per dollar and the target line.
- [prompts.md](prompts.md): the prover's system prompt as a file, the strict screen a rewritten prompt passes, and `harness optimize-prompts`:
  GEPA-style rewriting on a dev split, the held-out and temporal gate, and the proposals a person merges.
- [development.md](development.md): conventions, tests, commits.
