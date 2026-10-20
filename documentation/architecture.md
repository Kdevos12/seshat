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
| `@seshat/core` | Ids, canonical JSON, statuses, events, journal, projection, Lean source scanning, sketches, validator, checker and certifier interfaces | Node built-ins only |
| `@seshat/memory` | The memory store: claims (one per statement id), edges, nodes, queries, the reference file of any claim ([memory.md](memory.md)); M1's strategy and failure classifiers, "already tried" and redundancy ([m1-identity-memory.md](m1-identity-memory.md)); how far a check got, the measure of Lean progress that M6 and the fleet share (`progress.ts`) | core |
| `@seshat/lines` | The line API: line ids and their order, cumulative configs, hooks and their contexts, the checks of a run's lines ([lines.md](lines.md)) | core, memory, registry |
| `@seshat/graph` | Variants, edges checked by their link lemma, propagation with provenance and revocation, composed proofs, the prove/refute twin, ATMS labels, PageRank, graph queries; the line M2 ([graph.md](graph.md)) | core, lines, memory, registry |
| `@seshat/guards` | Line M6: neutral framing, resolved citations, no raw error text, anchored revisions, the drift detectors and the `drift` nodes ([guards.md](guards.md)) | core, lines, memory, registry |
| `@seshat/fleet` | The fleet line: posteriors per strategy and model, Thompson sampling, adaptive width, escalation and the `allocation` nodes ([fleet.md](fleet.md)) | core, lines, memory, registry |
| `@seshat/registry` | Capability manifests, schemas, host profiles, in-process and MCP (stdio, HTTP) implementations, tool runs, contract tests, `lean.check` adapters | core, [`@earendil-works/pi-mcp`](https://github.com/earendil-works/pi) |
| `@seshat/lean-kimina` | `LeanChecker` over Kimina Lean Server, and its registry factory | core, registry |
| `@seshat/lean-meta` | The Lean meta tool's client (`lean.meta`), the Lean-backed statement identity, its implementation over a `LeanChecker`, a simulated one; `lean.goals` over Pantograph's REPL | core, lines, memory, registry |
| `@seshat/lean-local` | Lean on the host: the certifier, a kernel replay in a fresh process of the bench's Lean project, and its registry factory (`lean.certify`, [certifier.md](certifier.md)) | core, lines, memory, registry |
| `@seshat/bench` | formal-conjectures scanner, filters, bench index, CLI | core |
| `@seshat/orchestrator` | Composition root (every implementation), the M0 loop on pi, the lines' runtime and registry (`lines.ts`: M1, M2, M6, fleet), the M1 line, the `harness` command | all of the above, [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi), [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) |

The packages of the planned mechanisms exist as skeletons (a `package.json` and an empty
`src/index.ts`), with their dependencies in the lockfile, so that the task that writes one adds
code without touching the lockfile:

| Package | Will hold | Depends on |
|---|---|---|
| `@seshat/classical` | The classical battery per subgoal, the domain router, ATP and SMT (M10) | core, lines, memory, registry |
| `@seshat/models` | Small models of the discrete domain, fingerprints, certified refutations, identification (M11) | core, lines, memory, registry |
| `@seshat/scheduler` | The saturation kernel and the subgoal scheduler (M12) | core, fleet, graph, lean-meta, lines, memory, registry |
| `@seshat/context` | The context compiler, `expand` and `graph_query` (M4) | core, graph, lessons, library, lines, memory, registry |
| `@seshat/library` | The growing lemma library (M3) | core, lines, memory, registry |
| `@seshat/lessons` | Lessons with counters (M5) | core, lines, memory, registry |
| `@seshat/abduction` | The abductive engine and its reranking (M7, M9), suspended and not built ([lines.md](lines.md#suspended-lines)) | core, graph, lean-meta, lines, memory, models, registry |
| `@seshat/induction` | The inductive engine and theory exploration (M8, M13) | classical, core, library, lines, memory, models, registry |
| `@seshat/repair` | Typed repairs, Lakatos-style repair (M14) | core, induction, lines, memory, registry |

Data that is versioned with the code:

| Directory | Content |
|---|---|
| `capabilities/` | One manifest and one contract per capability ([capabilities.md](capabilities.md)). |
| `config/hosts/` | Host profiles: what each machine uses, and where. |
| `bench/` | Bench indexes ([bench.md](bench.md)). |
| `lean/` | Lean libraries that run in the bench's project: SeshatMeta ([lean-meta.md](lean-meta.md)) and SeshatCertify ([certifier.md](certifier.md)). |

## A problem, end to end (M0)

1. The bench index names a problem: a file of the pinned formal-conjectures snapshot and a theorem
   ([bench.md](bench.md)).
2. The file is put in plain-header form, checked against the index, and cut into a sketch: fixed
   parts and two editable regions ([validator.md](validator.md)).
3. The orchestrator records `claim.created` (status `open`) and `problem.registered`, checks the
   original file once for the statement's reference type, then starts the provers in parallel.
4. Each prover works in sessions, each a fresh pi agent and an attempt in the journal. The agent
   edits the two regions and calls its `lean_check` tool, which runs the fast check and answers
   with Lean's messages and the goals of the `sorry`s at the prover's own line numbers. Lean is
   reached through the capability `lean.check`, so each check is a tool run of the attempt. A run
   can give the agent other tools, such as SageMath (`compute_sage`), whose calls are tool runs
   of the attempt too ([compute.md](compute.md)).
5. A session ends when the model stops, at a limit of turns or context, or when the budget runs
   out. The model's last message becomes the prover's notes (`lesson.recorded`); the next session
   starts afresh from the file as the prover left it, its notes, and what Lean said last.
6. The first proof that passes the fast check makes the claim `computed` (a candidate) and stops
   the other provers. Certification makes it `proved`.
7. The problem ends with `problem.finished` (outcome, attempts, cost), and the run with a report
   built from the journal.

[m0-loop.md](m0-loop.md) describes the loop in full. The plan's mechanisms come as lines that a run
switches on: their hooks run at fixed points of this loop (before the provers, around each
session and check, after each attempt and problem), and with no line the loop is M0
([lines.md](lines.md)).

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
