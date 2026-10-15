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
| Line API: hooks, contexts, cumulative configs, `harness run --lines` | `@seshat/lines`, `@seshat/orchestrator` | Done, tested with fake lines; no line implemented yet |
| Problem sketches and proof validator (fast check) | `@seshat/core` | Done, tested with a simulated Lean |
| Kimina Lean Server client | `@seshat/lean-kimina` | Done, tested with a simulated server |
| Bench built from formal-conjectures | `@seshat/bench` | Done: 575 problems, index committed |
| Capability registry, MCP boundary, `lean.check` and its contract | `@seshat/registry` | Done, tested with simulated servers |
| `harness` command (capabilities, health, contract tests, models, runs, reports) | `@seshat/orchestrator` | Done |
| M0 loop on pi: provers in sessions, notes, budgets, report | `@seshat/orchestrator` | Done, tested with a simulated model and Lean |
| Computer algebra for the provers: SageMath (`compute.sage`), `harness run --tool` | `capabilities/compute.sage`, `@seshat/orchestrator` | Done; contract passed against a local SageMath, Docker image not tried |
| Lean meta tool: statement ids, `isDefEq`, premises, profiles, instances (`lean.meta`); `LeanIdentity`; goals one tactic at a time (`lean.goals`, Pantograph) | `@seshat/lean-meta`, `lean/SeshatMeta` | TypeScript done, tested with a simulated Lean and a fake Pantograph; the Lean library never compiled |
| Certifier (kernel replay) | Lean code | Needs a Lean environment |

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
- [memory.md](memory.md): the memory store: claims, statement identities, edges, nodes and their
  kinds, queries, reference files.
- [lines.md](lines.md): the line API: the plan's mechanisms as lines a run switches on, their
  hooks and when they run, their contexts, the cumulative configs, how a task adds a line.
- [validator.md](validator.md): problem sketches, the editable regions, the checks.
- [m0-loop.md](m0-loop.md): the M0 loop: runs, problems, provers, sessions, budgets, the run
  directory, `harness run` and `harness report`.
- [lean.md](lean.md): Lean checkers, the Kimina client, the certifier, deployment.
- [lean-meta.md](lean-meta.md): the Lean meta tool: SeshatMeta's commands, the canonical form and
  `st1_` ids, `lean.meta`, `LeanIdentity`, `lean.goals` over Pantograph, deployment.
- [capabilities.md](capabilities.md): the capability registry, manifests, host profiles, MCP,
  scopes, contract tests, the `harness` command.
- [compute.md](compute.md): SageMath for the provers: installing it, its settings and resources,
  what it offers and refuses.
- [bench.md](bench.md): the formal-conjectures bench and its index.
- [development.md](development.md): conventions, tests, commits.
