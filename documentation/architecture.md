# Architecture

## Shape

- **Worker agents** are [pi](https://github.com/earendil-works/pi) sessions (TypeScript, MIT). Each
  attempt gets a fresh session with the tools the orchestrator chooses.
- **A thin orchestrator** decides what to attempt and with what budget, and records every fact in
  the journal.
- **The journal** (JSONL with a hash chain) is the only source of truth. The SQLite projection, the
  indexes and the future knowledge graph are derived from it and can be rebuilt from it.
- **Lean decides** what is proved. A model's output is a candidate until Lean checks it, and a
  claim is `proved` only after certification ([trust.md](trust.md)).
- **Capabilities** (Lean checking, automated provers, SAT/SMT, computer algebra, search) sit behind
  a registry with manifests and an MCP boundary, so that any tool can be updated or replaced
  without touching the core.

## Packages

| Package | Role | Depends on |
|---|---|---|
| `@math-harness/core` | Ids, canonical JSON, statuses, events, journal, projection, Lean source scanning, sketches, validator, checker and certifier interfaces | Node built-ins only |
| `@math-harness/registry` | Capability manifests, schemas, host profiles, in-process and MCP (stdio, HTTP) implementations, tool runs, contract tests, `lean.check` adapters | core, [`@earendil-works/pi-mcp`](https://github.com/earendil-works/pi) |
| `@math-harness/lean-kimina` | `LeanChecker` over Kimina Lean Server, and its registry factory | core, registry |
| `@math-harness/bench` | formal-conjectures scanner, filters, bench index, CLI | core |
| `@math-harness/orchestrator` | Composition root (every implementation), the `harness` command; the M0 loop next | all of the above |

Data that is versioned with the code:

| Directory | Content |
|---|---|
| `capabilities/` | One manifest and one contract per capability ([capabilities.md](capabilities.md)). |
| `config/hosts/` | Host profiles: what each machine uses, and where. |
| `bench/` | Bench indexes ([bench.md](bench.md)). |

## An attempt, end to end (M0)

1. The bench index names a problem: a file of the pinned formal-conjectures snapshot and a theorem
   ([bench.md](bench.md)).
2. The file is put in plain-header form and cut into a sketch: fixed parts and two editable regions
   ([validator.md](validator.md)).
3. The orchestrator records `problem.registered` and `claim.created` (status `open`), then starts
   the provers.
4. A prover (a pi session) edits the two regions and calls a `lean_check` tool, which runs the
   fast check and answers with Lean's messages at the prover's own line numbers. Lean is reached
   through the capability `lean.check`, so each check is a tool run of the attempt.
5. A proof that passes the fast check makes the claim `computed` (a candidate). Certification
   makes it `proved`.
6. Each attempt ends with `attempt.finished` (outcome, tokens, cost) and a short lesson for the
   next attempt.

## Design rules

- **Modular.** Every tool sits behind an interface (`LeanChecker`, `LeanCertifier`, capabilities).
  Implementations live outside the core and are chosen by configuration, and so is the execution
  host (a workstation for development, a dedicated server for the full bench).
- **APIs only.** Models are called through their APIs and nothing in the harness trains one. Small
  non-LLM components used as they are (an online k-NN over our own proofs, LeanHammer's premise
  selector) are allowed, and each must beat MePo alone in an ablation.
- **Measured.** Each mechanism is an ablation line (M0 to M14 in the plan), run at equal budget on
  the dedicated server. A line that does not beat the previous one is removed.
- **Reproducible.** A run is determined by its journal, the bench index (pinned by its hash) and
  the code revision recorded in `run.started`.
