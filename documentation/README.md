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
| Capability registry, MCP boundary, `lean.check` and its contract | `@seshat/registry` | Done, tested with simulated servers |
| `harness` command (capabilities, health, contract tests, models, runs, reports) | `@seshat/orchestrator` | Done |
| M0 loop on pi: provers in sessions, notes, budgets, report | `@seshat/orchestrator` | Done, tested with a simulated model and Lean |
| Computer algebra for the provers: SageMath (`compute.sage`), `harness run --tool` | `capabilities/compute.sage`, `@seshat/orchestrator` | Done; contract passed against a local SageMath, Docker image not tried |
| Lean meta tool: statement ids, `isDefEq`, premises, profiles, instances (`lean.meta`); `LeanIdentity`; goals one tactic at a time (`lean.goals`, Pantograph) | `@seshat/lean-meta`, `lean/SeshatMeta` | TypeScript done, tested with a simulated Lean and a fake Pantograph; the Lean library never compiled |
| Lean's language server for the provers: goals at a line, tactics tried at a line, Mathlib search (`lean.lsp`, lean-lsp-mcp 0.31.0), `harness run --tool lean.lsp` | `@seshat/lean-lsp`, `capabilities/lean.lsp`, `@seshat/orchestrator` | TypeScript done, tested with a stand-in server whose shapes were taken from the real release, and (opt-in, `LEAN_LSP_MCP_PYTHON`) against the real server with canned back-ends; not run against a real Lean |
| Line M11: batteries of small models, fingerprints, certified refutations, identification of sequences; the OEIS, LMFDB and FindStat as capabilities (`oeis.search`, `lmfdb.query`, `findstat.identify`) | `@seshat/models`, `capabilities/` | Done, tested with a simulated Lean and a local stand-in for the sites; not run against a real Lean, SageMath, or the OEIS, FindStat and LMFDB |
| Certifier (kernel replay) | Lean code | Needs a Lean environment |
| Certifier: kernel replay in a fresh process, the capability `lean.certify`, and its use in a run (`proved`, `refuted`) | `@seshat/lean-local`, `lean/SeshatCertify`, `capabilities/lean.certify`, `@seshat/orchestrator` | TypeScript done, tested with a fake `lake` and fake certifiers; the Lean program never compiled |
| Task ledger: tasks and their transitions, typed routing of failures and drift, model-call sites, `harness run --resume` | `@seshat/core`, `@seshat/scheduler`, `@seshat/orchestrator` | Done, tested with a simulated model and Lean and with a process killed by SIGKILL; a run with M2, M6 or the fleet cannot be resumed yet; never run with a real model or Lean |

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
  kinds, queries, reference files.
- [lines.md](lines.md): the line API: the plan's mechanisms as lines a run switches on, their
  hooks and when they run, their contexts, the cumulative configs, how a task adds a line.
- [graph.md](graph.md): the graph: variants and edges checked by Lean, the propagation rules and
  composed proofs, the prove/refute twin, labels and nogoods, PageRank and graph queries, the line M2.
- [m1-identity-memory.md](m1-identity-memory.md): the M1 line: one claim per statement, strategy
  labels, failure classes, the "already tried" section, the redundant-attempts metric.
- [guards.md](guards.md): the M6 line: neutral framing, resolved citations, no raw error text,
  anchored revisions, the drift detectors, and the `drift` nodes they write.
- [fleet.md](fleet.md): the fleet line: posteriors per strategy and model, Thompson sampling, adaptive
  width, escalation, and the `allocation` nodes.
- [validator.md](validator.md): problem sketches, the editable regions, the checks.
- [m0-loop.md](m0-loop.md): the M0 loop: runs, problems, provers, sessions, certification and the
  outcomes, budgets, the run directory, `harness run` (and `--resume`) and `harness report`.
- [lean.md](lean.md): Lean checkers, the Kimina client, deployment.
- [certifier.md](certifier.md): the certifier: what it answers, the process, the Lean program, where
  untrusted code runs, its settings, deployment, what is still to verify against Lean.
- [lean-meta.md](lean-meta.md): the Lean meta tool: SeshatMeta's commands, the canonical form and
  `st1_` ids, `lean.meta`, `LeanIdentity`, `lean.goals` over Pantograph, deployment.
- [lean-lsp.md](lean-lsp.md): Lean's language server for the provers: `lean.lsp` over lean-lsp-mcp,
  its eight operations, what it never does, the pinned version, installing it, the network sites,
  the settings, the tests.
- [capabilities.md](capabilities.md): the capability registry, manifests, host profiles, MCP,
  scopes, contract tests, the `harness` command.
- [compute.md](compute.md): SageMath for the provers: installing it, its settings and resources,
  what it offers and refuses.
- [bench.md](bench.md): the formal-conjectures bench and its index.
- [models.md](models.md): small models of the discrete domain: batteries of magmas, groups,
  graphs and integers, evaluators, fingerprints, certified refutations, identification of
  sequences, the OEIS, LMFDB and FindStat as capabilities (line M11).
- [development.md](development.md): conventions, tests, commits.
