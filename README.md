# Seshat

A harness for autonomous mathematical research with LLMs: models through their APIs, Lean as the
judge, classical tools first.

Status: early development (phase P0a). The event journal, the memory store, the line API, the proof validator,
a client for Kimina Lean Server, the capability registry (manifests, host profiles, MCP boundary, contract tests), a
first bench of 575 problems from
[formal-conjectures](https://github.com/google-deepmind/formal-conjectures), and the M0 loop
(independent provers on pi, in sessions that pass on their notes) are written and tested with a
simulated model and a simulated Lean. The provers can also be given SageMath, an external program
installed with Docker or pip ([documentation/compute.md](documentation/compute.md)). Nothing has
run against a real Lean or a real model yet.

## How research flows

```mermaid
flowchart TB
  classDef built fill:#e8eefa,stroke:#1f4fa3,stroke-width:2px,color:#1b2230
  classDef wait fill:#fbf1e1,stroke:#a66300,stroke-width:2px,color:#1b2230
  classDef planned fill:#f1f3f6,stroke:#8a92a3,stroke-width:2px,stroke-dasharray:6 4,color:#1b2230

  bench["Bench<br/>575 Lean problems"]:::built
  fleet["Fleet policy<br/>Thompson sampling<br/>on verdicts"]:::planned
  llm["LLMs through their APIs<br/>any provider, no training"]:::built
  provers["Provers 1..N on pi<br/>fresh sessions that pass<br/>on their notes, in budgets<br/>of $, tokens and turns"]:::built

  subgraph TOOLS["Capability registry"]
    leancheck["lean_check<br/>Kimina Lean Server"]:::wait
    sage["compute_sage<br/>SageMath"]:::built
    leanmeta["lean_meta<br/>Lean meta tool"]:::wait
    moretools["ATPs, SAT/SMT, OEIS,<br/>Mathlib search,<br/>counterexample search"]:::planned
  end

  subgraph JUDGE["Judge: Lean"]
    fast["Fast check (REPL)<br/>errors, axioms,<br/>statement unchanged"]:::wait
    certifier["Certifier<br/>kernel replay"]:::planned
  end

  journal["Event journal<br/>the only source of truth<br/>JSONL, hash chain, blobs"]:::built
  projection["SQLite projection"]:::built

  subgraph MEMORY["Memory: the plan's edge"]
    kg["Facts and research graph<br/>verified implications,<br/>failures, lemmas,<br/>deduplication"]:::planned
    compiler["Context compiler<br/>context under<br/>a token budget"]:::planned
  end

  bench -->|problems| provers
  fleet -.->|"who works on what"| provers
  llm <-->|"prompts, tool calls"| provers
  provers --> leancheck & sage
  provers -.-> moretools
  leanmeta -.->|"statement ids"| kg
  leancheck -->|Lean file| fast
  fast -->|"open → computed"| journal
  fast -.->|candidate| certifier
  certifier -.->|"computed → proved"| journal
  TOOLS -->|"every call"| journal
  journal --> projection
  journal -.-> kg
  kg -.-> compiler
  compiler -.->|"context for each session"| provers
```

Blue: built and tested. Orange: written, waits for a Lean server. Grey and dashed: planned, not
written.

Today one loop runs, tested with a simulated model and a simulated Lean: each prover edits a Lean
sketch and checks it with `lean_check`, and the first file that passes the fast check makes the
statement `computed`, a candidate. SageMath is the only classical tool plugged in. Every tool call
goes through the capability registry, which writes it to the journal, with its inputs and outputs
as blobs.
Lean is the judge: no statement becomes `proved` without the certifier's kernel replay, which is
still to write. The memory is what the plan counts on to beat existing systems: its store is
written (claims, the edges between them and records of every kind, all in the journal), the
mechanisms that would use it are not ([documentation/memory.md](documentation/memory.md)). Each
mechanism will come as a line that a run switches on (`harness run --lines M1,M10` or
`--ablation M10`), so that it is measured against the run without it; no line is written yet
([documentation/lines.md](documentation/lines.md)).

This diagram changes with the code: a change to the research flow updates it in the same commit
([documentation/development.md](documentation/development.md#conventions)).

## Commands

```sh
pnpm install
pnpm check
pnpm harness capabilities
pnpm harness models
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --tool compute.sage
```

The checkout is formal-conjectures at the bench's tag, `bench-v1-lean4.27.0`
([documentation/m0-loop.md](documentation/m0-loop.md#commands)); `pnpm harness models` lists the
models and says whether their credentials are set.

Documentation: [documentation/](documentation/README.md).
