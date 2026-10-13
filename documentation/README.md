# math-harness documentation

math-harness is a harness for autonomous mathematical research with LLMs. Models are used only
through their APIs, Lean decides what is proved, and classical tools (automated provers, SAT/SMT
solvers, computer algebra, decision procedures) are used wherever they can do the job.

This folder describes the code as it is. A change to the code updates the page that describes it,
in the same commit.

## Status

Phase P0a builds the parts that need neither Lean nor a model.

| Part | Package | State |
|---|---|---|
| Event journal, claim statuses, SQLite projection | `@math-harness/core` | Done, tested |
| Problem sketches and proof validator (fast check) | `@math-harness/core` | Done, tested with a simulated Lean |
| Kimina Lean Server client | `@math-harness/lean-kimina` | Done, tested with a simulated server |
| Bench built from formal-conjectures | `@math-harness/bench` | Done: 575 problems, index committed |
| Capability registry, MCP boundary, `lean.check` and its contract | `@math-harness/registry` | Done, tested with simulated servers |
| `harness` command (capabilities, health, contract tests) | `@math-harness/orchestrator` | Done |
| M0 loop on pi | `@math-harness/orchestrator` | Next |
| Certifier (kernel replay) | Lean code | Needs a Lean environment |

None of this has run against a real Lean yet, because the development environment blocks the
Lean toolchain downloads. [lean.md](lean.md#to-verify-against-lean) lists what depends on Lean's
exact output; `pnpm harness contract lean.check` checks it against a server
([capabilities.md](capabilities.md#leancheck)).

## Pages

- [architecture.md](architecture.md): packages, data flow, design rules.
- [trust.md](trust.md): claim statuses, and what it takes for a claim to be proved.
- [journal.md](journal.md): events, hash chain, projection, invariants.
- [validator.md](validator.md): problem sketches, the editable regions, the checks.
- [lean.md](lean.md): Lean checkers, the Kimina client, the certifier, deployment.
- [capabilities.md](capabilities.md): the capability registry, manifests, host profiles, MCP,
  contract tests, the `harness` command.
- [bench.md](bench.md): the formal-conjectures bench and its index.
- [development.md](development.md): conventions, tests, commits.
