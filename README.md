# Seshat

A harness for autonomous mathematical research with language models: models through their APIs, Lean as the judge, classical tools first.

Seshat takes a mathematical statement, in Lean or in prose, and works on it under a dollar allowance: it tries classical tools before any model, lets models propose Lean proofs in fresh sessions, and calls a statement proved only when Lean's kernel has replayed the proof. Its principles:

- **Models through their APIs only.** No training and no fine-tuning; small learned components (an online k-NN, a published premise selector) are used as they are.
- **Lean is the judge.** A claim is `proved` or `refuted` only after the certifier's kernel replay; a model's word, a tool's output, an informal proof or a heuristic is evidence or a hint, never a status ([trust](documentation/trust.md)).
- **Classical tools first.** Decision procedures, a tactic battery, computer algebra, SMT and ATPs run before a model is asked, and what they find still goes through Lean.
- **The journal is the only source of truth.** Every fact is an event in a hash-chained JSONL journal; tables, indexes and reports are projections rebuilt from it, and a run whose process ended resumes from it ([journal](documentation/journal.md)).
- **Every action is proportionate to a budget.** A probe and a budget gate put a price against a chance of success before each paid launch, and a run stops with an account of why ([scheduler](documentation/scheduler.md#the-budget-gate)).

## Status: beta v1

Version 1.0.0-beta.1. The core runs for real: on the owner's machine, with Lean 4.27.0 and a real model through its API, `harness solve` has certified Putnam problems of competition level through the kernel replay, and the graded bench was admitted by the real Lean. Most of the research lines (lemma library, lessons, small models, curriculum, archive, program search, repairs), the heuristic card bank, ATP and SMT with reconstruction, the consortium turns and the consolidation pass have only been tested with a simulated model and a simulated Lean; they are written against their interfaces and drawn in orange in the diagram below. The measured runs are small (at most 20 problems and a few dollars each) and their comparisons are not statistically conclusive. [documentation/status.md](documentation/status.md) has the full account.

## Results so far

All numbers are from the task ledger ([plans/seshat-plan-ledger.md](plans/seshat-plan-ledger.md)), on grade B problems (Putnam competition problems) of the graded bench, on the owner's machine, with a real Lean and a real model.

| Run | Date | What it measured | Result |
|---|---|---|---|
| Pilot | 2026-11-11 | 6 problems, cap $0.50 each, `solve` with the baseline defaults `v1` | 6 of 6 certified by kernel replay for $0.126 in all; the other two arms were not valid (the provider's balance ran out) |
| Second run | 2026-11-12 | the same 6 problems | `v1` 4 of 6 for $0.205: the baseline varies from run to run; two defects found and fixed |
| Third run | 2026-11-12 to 13 | 20 problems, cap $0.50 each, three arms: `v1`, `v2` and `v2` with blueprints | after the certifier fix: `v1` 16 of 20, `v2` 14, blueprints 15; $4.02 in all with a one-problem trial; no arm beats another |
| Replay | 2026-11-13 | the 6 problems left unsolved, the arm with blueprints, refinement rounds, repair and the informal proof first | 0 of 6 certified for $1.41 |
| Graph smoke run | 2026-11-13 | lines M2 and M4 on 4 of those problems | 0 of 4 for $0.67; they ran without error and added nothing in a single fresh run |

What the runs taught, and what was fixed because of them:

- The third run's first scores (13, 13, 13) were wrong: the certifier refused `X._unsafe_rec`, a constant that Lean 4.27.0 adds for every recursive definition, and rejected six good proofs. After the fix, checked on a real Lean on 2026-11-13, the same candidates certify (`v1` 16, `v2` 14, blueprints 15 of 20). A `partial def` is still refused.
- The blueprints of the third run were all judged unhealthy because the blueprint format was in no prompt; it is now in the briefing, and the check answer says how a blueprint is read.
- The replay (0 of 6) showed that four of the six problems were stopped by the budget gate after the probe, that the verifier of the informal proof (the same model) was too lenient, and that a hole's file did not carry its context; the fixes are in the ledger. These six are the hard end of the set: no claim is made that blueprints help.
- A yardstick caveat: every PutnamBench problem has a public Lean proof, which a model may have seen.

## Quick start

Node 22.19 or later and pnpm 10 ([documentation/development.md](documentation/development.md)). Tests run without Lean, a model or a network.

```sh
pnpm install
pnpm check                  # type-check, then every test
pnpm harness doctor         # what this machine lacks (Lean, Kimina, credentials, isolation), and how to fix it
pnpm harness solve "Every even number above two is a sum of two primes." --max-usd 2
pnpm harness ui             # the local interface, on 127.0.0.1 only
```

`solve` takes a statement in prose, in Lean (`"(n : ℕ) : n + 0 = n"`) or a `.lean` file; prose is formalized and shown for your signature before anything is spent. It always runs under a dollar allowance, and leaves `RESULT.md` in the run directory whatever stopped it. A real run needs Lean 4.27.0 and a model key ([models setup](documentation/models-setup.md), [Lean](documentation/lean.md)); [documentation/quickstart.md](documentation/quickstart.md) is the shortest road.

## How it works

![harness solve from a statement to RESULT.md](documentation/images/solve-loop.svg)

![How a run flows through the packages](documentation/images/architecture.svg)

Each compartment has a page and a picture:

- [Architecture](documentation/architecture.md): the packages and how a run flows through them.
- [The solve loop](documentation/quickstart.md): `harness solve`, `harness doctor`, `RESULT.md`.
- [Blueprints](documentation/scheduler.md#blueprints-plan-change-ca9): a hard problem split into holes (line M12).
- [Trust](documentation/trust.md): who may change a claim's status.
- [Tools](documentation/capabilities.md): the capability registry, host profiles and the tools behind it.
- [Heuristic cards](documentation/heuristics.md): methods of reasoning, and how their effect is measured.
- [Memory](documentation/memory.md): the journal, its projections and the lines that read them.

## The research flow

Blue: built and tested with the simulated model and Lean. Orange: written and tested with simulations, but it
needs something real before it has run: a Lean server, a model, a service (Jev, the OEIS), a program (SageMath, Vampire, E) or data (the
equational-theories rows, the first real ablation). Grey and dashed: planned, not written (the further classical tools, such as SAT and counterexample search).

Some orange nodes (the Lean server, the certifier, `lean.lsp`, `lean.search`) have since run for real: [documentation/status.md](documentation/status.md) says which.

```mermaid
flowchart TB
  classDef built fill:#e8eefa,stroke:#1f4fa3,stroke-width:2px,color:#1b2230
  classDef wait fill:#fbf1e1,stroke:#a66300,stroke-width:2px,color:#1b2230
  classDef planned fill:#f1f3f6,stroke:#8a92a3,stroke-width:2px,stroke-dasharray:6 4,color:#1b2230

  bench["Bench<br/>575 Lean problems"]:::built
  benchseq["Bench sequences and tags<br/>variants, shared files,<br/>analogy and induction"]:::built
  benchext["bench-ext<br/>equational-theories rows from a<br/>local cache, never vendored"]:::wait
  protocol["Paired protocol<br/>Wilson intervals, exact McNemar,<br/>solved per dollar, target line"]:::built
  graded["Graded bench<br/>A exercises, B competition, C research,<br/>admitted by Lean, from local checkouts"]:::wait
  ablate["harness ablate<br/>M0 then each line, or one experiment:<br/>same problems, same budget"]:::built
  measures["Measures from the journals<br/>spend per site, reliability and ECE,<br/>cache per rung and line, curves"]:::built
  probe["Entrenchment probe<br/>memory on against verified facts<br/>only, alarm in the report"]:::built
  optprompts["harness optimize-prompts<br/>GEPA-style rewrite on a dev split,<br/>gate: held-out and temporal,<br/>patches a person merges"]:::built
  realopt["First real prompt optimization<br/>needs a model, Lean<br/>and the dataset"]:::wait
  realablate["First real ablation<br/>needs a model, Lean, Jev<br/>and the dataset"]:::wait
  fleet["Fleet policy<br/>Thompson sampling on verdicts,<br/>sampled settings, exploration<br/>floor, discount per run"]:::built
  heurbank["Heuristic card bank<br/>methods of reasoning, not tools:<br/>built-in and pack cards,<br/>a control arm per bucket"]:::built
  dag["nl_first sessions<br/>step DAG, checked,<br/>one lemma per step"]:::wait
  judge["judge: k calls,<br/>majority, disagreement,<br/>anti-sycophancy"]:::wait
  guards["M6 guards<br/>resolved citations,<br/>drift detectors"]:::built
  llm["LLMs through their APIs<br/>any provider, no training"]:::built
  budgetgate["Budget gate (off by default)<br/>price against chance before each launch,<br/>probe first, widen on Lean progress,<br/>exploration floor, skips kept in the journal"]:::wait
  provers["Provers 1..N on pi<br/>fresh sessions that pass<br/>on their notes, in budgets<br/>of $, tokens and turns"]:::built
  orchestrator["Orchestrator<br/>budgets, stops,<br/>resume from the journal"]:::built
  ledger["Task ledger<br/>one task per prover,<br/>typed routing of failures"]:::built
  m11["Line M11: small models<br/>counter-models,<br/>fingerprints, sequences"]:::wait
  graphhunt["Graph counterexamples (M11.graphs, off)<br/>model-written predicate, batteries to 8 vertices,<br/>local search, families, Lean templates<br/>lean/SeshatLib/Finite"]:::wait
  leanenv["Lean environment<br/>lean/env files, resolver,<br/>environment hash"]:::built
  libbuilder["LibraryBuilder (off by default)<br/>coding agent in a sandbox,<br/>files added to lean/SeshatLib"]:::wait
  libgate["Seshat's gate<br/>diff, fresh lake build, no sorry,<br/>certifier, test lemmas"]:::wait
  defreview["Definition review<br/>new definitions unreviewed:<br/>not in claim statements"]:::built
  envbuild["lean-env build<br/>cache get, lake build,<br/>time per package"]:::wait
  m12["Line M12: scheduler<br/>given-clause loop, proof numbers,<br/>subsumption, owners"]:::built
  holes["Named holes of a sketch<br/>claims, a decomposes_into edge<br/>checked by Lean, inner provers<br/>blueprint: holes that use holes,<br/>hole sessions with tools, verdicts,<br/>refinement rounds: a planner call<br/>rewrites the blueprint (CA12)"]:::wait
  ladder["Escalation ladder<br/>rungs move up when budget<br/>is spent without Lean progress"]:::built
  m18["Line M18: variant curriculum<br/>rung 1: special cases of a hard<br/>problem, a capped share of budget"]:::wait
  m15["Line M15: archive of decompositions<br/>cells, a Thompson pick of the one to extend,<br/>schemas from closed sub-DAGs"]:::wait
  m17["Line M17: extended environment<br/>the run's Lean has more<br/>packages than the bench's"]:::wait
  m8["Line M8: inductive engine<br/>data tables, hypotheses as<br/>programs, conjecture pool"]:::wait
  m3["Line M3: lemma library<br/>promoted aux lemmas, BM25 search,<br/>library_search"]:::built
  m13["Line M13: theory exploration<br/>minimal laws, integer relations,<br/>candidates for the library"]:::wait
  m16["Line M16: program search<br/>islands of scored programs,<br/>rung 2 of the ladder"]:::wait
  m4["Line M4: context compiler<br/>frozen prefix, tail, premises,<br/>expand, graph_query"]:::wait
  m5["Line M5: lessons<br/>from accepted proofs and recurring<br/>failures, deactivated by effect"]:::built
  m14["Line M14: repairs<br/>typed critics, Lakatos repair<br/>of refuted conjectures"]:::wait
  sandbox["Sandbox for programs<br/>time and memory limits,<br/>no network, scratch directory"]:::built
  team["Research team<br/>reads the account,<br/>answers with hints,<br/>signatures, steers"]:::built
  account["Account of a turn<br/>turns/N/report.md,<br/>built from the journal"]:::built
  narrative["Turn narrative<br/>written by a model,<br/>every id checked"]:::wait
  solve["harness solve<br/>a statement in Lean or prose, one-problem bench,<br/>student defaults v1 or v2: small cap, gate, M1 and M10"]:::built
  consolidate["Consolidation pass (CA24, harness consolidate)<br/>cards, duplicate and unsupported lessons, a page whose<br/>every sentence cites journal events; a new run on the old one"]:::wait
  hotloop["Cheaper hot loop (solve defaults v2)<br/>lean_edit in place of a rewritten file, old check results<br/>masked in batches, bounded Lean checks, a state card<br/>from the journal, the run budget in rounds"]:::wait
  leanpush["Premises pushed (CA22, option leanSearch)<br/>after a check: a name search on each unknown identifier,<br/>a goal search on each hole; each hit checked with Lean"]:::wait
  signature["Signature of a prose statement<br/>formalized, shown with test lemmas,<br/>statement.signed before any spend"]:::wait
  doctor["harness doctor<br/>Lean, Kimina, credentials, prices, network,<br/>isolation; writes the sandboxed host profile"]:::wait
  resultmd["RESULT.md<br/>built from the journal, no model,<br/>after every certified result and every stop"]:::built
  viewhtml["harness view<br/>one static HTML page from the journal,<br/>no server, no network, all text escaped"]:::built
  intake["Intake, before any paid session<br/>three queries, one judge call under $0.05, a quote that must be<br/>in the fetched text; vacuity, plausible, test lemmas; off with --private"]:::wait
  informal["Informal proof first (PA13, option informalFirst)<br/>a proof in natural language, a verifier reads the final text:<br/>correct x3 in a row, or revised, or regenerated; a hint,<br/>never a status; shown as not checked by Lean"]:::wait
  uipage["harness ui<br/>local page on 127.0.0.1: token, Host and Origin checks,<br/>escaped text, keys in a 0600 file, starts the commands"]:::built

  subgraph TOOLS["Capability registry"]
    leancheck["lean_check<br/>Kimina Lean Server"]:::wait
    sage["compute_sage<br/>SageMath"]:::built
    leanmeta["lean_meta<br/>Lean meta tool"]:::wait
    leangoals["lean_goals<br/>Pantograph"]:::wait
    leanlsp["lean_lsp<br/>Lean language server"]:::wait
    leansearch["lean_search<br/>premise search: remote service,<br/>local index, pattern"]:::wait
    oeis["oeis_search<br/>OEIS"]:::wait
    lmfdb["lmfdb_query<br/>LMFDB"]:::wait
    findstat["findstat_identify<br/>FindStat"]:::wait
    litsearch["lit_search<br/>OpenAlex, arXiv, Semantic Scholar,<br/>zbMATH, bench metadata"]:::wait
    decide["decide_ask<br/>Jev, a decision-only<br/>model, only to order"]:::wait
    smtz3["smt_z3<br/>z3 on SMT-LIB, unsat core"]:::built
    vampire["atp_vampire<br/>Vampire on TPTP, SZS status"]:::wait
    eprover["atp_eprover<br/>E on TPTP, SZS status"]:::wait
    proveauto["prove_auto<br/>the battery on one goal"]:::wait
    provesearch["prove_search<br/>goal-level best-first search"]:::wait
    moretools["SAT, counterexample<br/>search"]:::planned
    packs["Installed packs<br/>tools at level 2 and skills,<br/>harness add, never a status"]:::built
  end

  m10["Line M10: classical battery<br/>per subgoal, before any model:<br/>domain router, Beta posteriors"]:::wait
  battery["Tactics in parallel<br/>decide, omega, norm_num, simp,<br/>linarith, grind, aesop, hammer..."]:::wait

  subgraph JUDGE["Judge: Lean"]
    fast["Fast check (REPL)<br/>errors, axioms,<br/>statement unchanged"]:::wait
    certifier["Certifier (lean_certify)<br/>fresh process, kernel<br/>replay, axioms and<br/>statement compared"]:::wait
  end

  journal["Event journal<br/>the only source of truth<br/>JSONL, hash chain, blobs"]:::built
  projection["SQLite projection"]:::built

  subgraph MEMORY["Memory: the plan's edge"]
    identity["M1 canonical identity<br/>one claim per statement,<br/>shared by equal problems"]:::built
    tried["M1 negative memory<br/>strategies tried and<br/>how each one failed"]:::built
    kg["Facts and research graph<br/>claims, edges and records<br/>in the journal"]:::built
    prop["Propagation and twin (M2)<br/>variants, checked edges,<br/>composed proofs"]:::wait
    compiler["Context compiler (M4)<br/>context under<br/>a token budget"]:::wait
    earlier["Memory carried over<br/>from an earlier run,<br/>pinned by its last hash"]:::built
    learned["Stamps, epochs and draw<br/>of unverified records<br/>(lines M3 and M5 draw)"]:::built
  end

  bench -->|problems| orchestrator
  orchestrator -->|"tasks, budgets"| ledger
  ledger -->|"one task per prover"| provers
  budgetgate -->|"launch, probe,<br/>widen or skip"| provers
  fleet -->|"posterior<br/>of the claim"| budgetgate
  ledger -->|"task events,<br/>routing decisions"| journal
  journal -->|"resume after<br/>a crash"| orchestrator
  orchestrator -->|"a turn ends: limit,<br/>breakpoint"| account
  journal -->|"read, no model"| account
  account --> team
  team -->|"hints, signatures,<br/>steers, as human"| journal
  team -->|"harness resume"| orchestrator
  llm -.->|"if asked"| narrative
  narrative -.->|"marked model-written"| account
  solve -->|"one-problem index,<br/>student config"| orchestrator
  solve -->|"prose"| signature
  solve -->|"defaults v2"| hotloop
  journal -->|"a finished run"| consolidate
  llm -.->|"one call per open problem, capped"| consolidate
  consolidate -->|"stamped cards and pages, as a new run<br/>(--memory-from)"| journal
  hotloop -->|"edits, masked history,<br/>time-limited checks, state card,<br/>budget in rounds"| provers
  llm -.->|"formalizes prose"| signature
  signature -->|"statement.signed, as human"| journal
  doctor -->|"checks; writes the isolated<br/>host profile when it can"| certifier
  orchestrator -->|"rewritten at each result,<br/>each stop"| resultmd
  journal -->|"read, no model"| resultmd
  journal -->|"read, no model"| viewhtml
  journal -->|"read, no model"| uipage
  uipage -->|"starts solve, run, resume,<br/>hint, steer, sign as subprocesses"| orchestrator
  bench -->|statements| identity
  identity -->|claims| journal
  fleet -->|"who works on what,<br/>with which settings"| provers
  heurbank -->|"one card per session,<br/>or none: the control"| fleet
  packs -->|"cards written<br/>by people"| heurbank
  fleet -->|"mode nl_first"| dag
  dag -->|"step plan"| provers
  dag -->|"informal step claims,<br/>decomposes_into proposals"| journal
  llm <-->|"k calls, never<br/>a verdict"| judge
  ledger -->|"retry_stronger<br/>before branch"| fleet
  guards -->|"reject a call,<br/>stop a session"| provers
  guards -->|"drift nodes"| journal
  bench -->|"problems, when<br/>M11 is on"| m11
  m11 -->|"briefing, or stops<br/>the provers"| provers
  m11 -->|"decide files"| leancheck
  m11 -->|"sequences"| oeis
  m11 -->|"negation proofs"| fast
  m11 -->|"nodes, computed edges"| journal
  m11 -->|"statements about graphs,<br/>option M11.graphs"| graphhunt
  graphhunt -->|"nauty graphs to 10 vertices"| sage
  graphhunt -->|"negation from the witness"| fast
  bench -->|"problems, when<br/>M8 is on"| m8
  llm -->|"hypotheses as programs,<br/>step DAGs, programs"| m8
  m8 -->|"columns and hypotheses<br/>run in"| sandbox
  m8 -.->|"Sage columns"| sage
  m8 -->|"test lemmas, triviality"| leancheck
  m8 -->|"open conjectures derived<br/>from the target, tables"| journal
  m8 -->|"pool in the briefing"| provers
  provers -->|"valid attempts:<br/>aux lemmas"| m3
  provers -->|"outcomes:<br/>strategy, failure class"| m5
  m4 -->|"packet in place<br/>of the history"| provers
  provers -->|"expand, graph_query"| m4
  m4 -->|"queries: one model call"| llm
  m3 -.->|"library lemmas"| m4
  m5 -.->|"lessons"| m4
  m4 -->|"packet records"| journal
  m5 -->|"lessons, counters,<br/>deactivations"| journal
  m5 -->|"drawn lessons<br/>in the briefing"| provers
  m5 -->|"distil a recurring<br/>failure: one model call"| llm
  m3 -->|"triviality probes,<br/>lemma alone"| leancheck
  m3 -->|"lemma claims,<br/>library nodes"| journal
  m3 -->|"briefing, library_search"| provers
  m13 -->|"open laws, library<br/>candidates"| journal
  m13 -->|"laws in the briefing"| provers
  ladder -->|"rung 2"| m16
  m16 -->|"programs and the<br/>scoring program run in"| sandbox
  m16 -->|"witness proof,<br/>never the score"| fast
  m16 -->|"programs and scores<br/>as nodes"| journal
  m8 -->|"refuted hypotheses<br/>and their tables"| m14
  m14 -->|"repaired claims,<br/>open, with their concept"| journal
  m14 -->|"repair suggestions<br/>for the next session"| provers
  llm <-->|"prompts, tool calls"| provers
  provers --> leancheck & sage
  provers -->|"sketches ending in<br/>named sorry holes"| m12
  m12 -->|"holes as claims,<br/>one prove task each"| holes
  holes -->|"link lemma, hole proofs"| leancheck
  holes -->|"claims, edges, tasks"| journal
  m12 -->|"lemmas proved,<br/>with their names"| provers
  journal -->|"spend since the<br/>last Lean progress"| ladder
  ladder -->|"ladder.escalated:<br/>starts the lines of the rung"| journal
  ladder -->|"rung 1"| m18
  m18 -->|"variants as claims,<br/>special_case_of edges, tasks"| journal
  m18 -->|"proved special cases<br/>and proofs in the briefing"| provers
  ladder -->|"rung 2"| m15
  holes -->|"checked decompositions,<br/>their labels"| m15
  m15 -->|"cell to extend, schema hints<br/>(drawn: some sessions are denied them)"| provers
  m15 -->|"picks, hints, schemas<br/>(stamped, outcomes)"| journal
  m15 -.->|"is the goal an instance<br/>of the schema?"| leanmeta
  provers -.-> moretools
  provers -.->|"tool search"| packs
  bench -->|"problems and open<br/>subgoals, when M10 is on"| m10
  m10 -->|"cheapest tactics first,<br/>stop at the first success"| battery
  battery -->|"Lean files"| leancheck
  battery -->|"a success is submitted<br/>through validate"| fast
  m10 -->|"SMT-LIB, TPTP"| smtz3 & vampire & eprover
  smtz3 & vampire & eprover -->|"unsat is evidence,<br/>premises go to grind,<br/>aesop, hammer"| battery
  m10 -->|"tries, evidence,<br/>posteriors from the journal"| journal
  m10 -->|"briefing: what was tried"| provers
  proveauto -->|"the same battery"| battery
  provesearch -->|"goal states"| leangoals
  provers --> proveauto & provesearch
  leanmeta -.->|"statement ids"| kg
  provers --> leangoals
  provers --> leanlsp
  provers --> oeis & lmfdb & findstat
  bench -->|"each problem, when intake is on"| intake
  bench -->|"each problem, when informalFirst is on"| informal
  informal -->|"an informal_proof node<br/>of the claim, never a status"| journal
  informal -.->|"an accepted proof, marked,<br/>in the first briefing and the planner's prompt"| provers
  intake -->|"queries, hits as data"| litsearch
  intake -->|"literature and hygiene nodes,<br/>never a status"| journal
  intake -.->|"a settled hit or a vacuous statement:<br/>a breakpoint"| team
  fast -->|"unknown identifiers,<br/>holes' goals"| leanpush
  leanpush -->|"at most 3 queries,<br/>5 hits each; never private"| leansearch
  leanpush -->|"#check of the names,<br/>one Lean call"| leancheck
  leanpush -->|"verified names and Lean's<br/>signatures, appended to the answer"| provers
  fleet -.->|"cold start:<br/>capped pseudo-counts"| decide
  libbuilder -->|"every file it wrote"| libgate
  libgate -->|"new theorems"| certifier
  libgate -->|"accepted: build record,<br/>definitions unreviewed"| journal
  libgate -->|"between runs:<br/>a new environment hash"| leanenv
  journal -->|"unreviewed definitions"| defreview
  defreview -->|"refuses claim statements<br/>that use them"| identity
  leanenv -->|"lakefile, lock"| envbuild
  leanenv -->|"hash in the version<br/>of every Lean tool run"| journal
  envbuild -->|"the project<br/>Lean runs in"| leancheck
  m17 -->|"names the run's<br/>environment"| leanenv
  m17 -->|"extra imports in every file,<br/>a probe before the problems"| leancheck
  leancheck -->|Lean file| fast
  fast -->|"open → computed"| journal
  fast -->|candidate| certifier
  certifier -->|"computed → proved<br/>or refuted"| journal
  TOOLS -->|"every call"| journal
  provers -->|"attempts: strategy,<br/>failure class, detail"| journal
  journal --> projection
  earlier -->|"replayed before<br/>the run's journal"| projection
  projection --> learned
  learned -.->|"lines draw: M3, M5,<br/>Tasks 11 and 18"| provers
  projection --> tried
  tried -->|"already tried,<br/>in every session"| provers
  tried -->|"verdicts"| fleet
  journal --> kg
  kg --> prop
  prop -->|"composed proofs"| fast
  prop -->|"briefing, graph tool,<br/>stop on refutation"| provers
  kg -.-> compiler
  compiler -.->|"context for each session"| provers
  bench -->|"sequences, tags"| benchseq
  benchseq -->|"ordered runs, for M3"| orchestrator
  benchext -->|"implication problems"| m10
  ablate -->|"one run per configuration,<br/>equal budget"| orchestrator
  journal -->|"read, no model"| measures
  measures -->|"the comparison table"| ablate
  journal -->|"memory on, and<br/>verified facts only"| probe
  probe -->|"alarm, probe.json"| account
  ablate -->|"each candidate is an arm"| optprompts
  optprompts -.->|"real runs"| realopt
  ablate -.->|"real runs"| realablate
  benchext -.-> realablate
  graded -->|"problems of one grade"| orchestrator
  ablate -->|"same problems, same dollars"| protocol
  graded -.-> realablate
```
This diagram changes with the code: a change to the research flow updates it in the same commit
([documentation/development.md](documentation/development.md#conventions)).

## Commands

```sh
pnpm harness --help       # the full command line
pnpm harness doctor       # what this machine lacks
pnpm harness models       # the models, and whether their credentials are set
pnpm harness capabilities # the capability registry
pnpm harness solve "STATEMENT" --max-usd 2    # a statement in Lean or prose, or a file; RESULT.md in the run directory
pnpm harness view runs/RUN_ID                  # one static HTML page of a run
pnpm harness ui [--port N] [--open]            # the local interface
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5
pnpm harness run --resume runs/RUN_ID --checkout ../google-deepmind/formal-conjectures-bench-v1
pnpm harness ablate --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 20 --out runs/ablation
pnpm harness audit runs/RUN_ID                 # one dossier per problem that was not certified
pnpm harness frontier runs/RUN_ID              # what a run has established, from its journal alone
pnpm harness campaign "STATEMENT" --max-usd 20 # a run that continues alone, in turns, under a dollar allowance
pnpm harness consolidate runs/RUN_ID           # the pass between runs: state cards, duplicate lessons
pnpm harness add PATH|GIT_URL                  # install a pack of tools, skills or heuristic cards (also: packs, remove)
pnpm harness heuristics list                   # the heuristic card bank (also: stats RUN_DIR, mine RUN_DIR)
```

The checkout is formal-conjectures at the bench's tag, `bench-v1-lean4.27.0` ([documentation/m0-loop.md](documentation/m0-loop.md#commands)). The full command reference is in [documentation/capabilities.md](documentation/capabilities.md#the-harness-command) and every flag and run setting is audited in [documentation/parameters.md](documentation/parameters.md).

## Documentation

[documentation/](documentation/README.md) is the home page of the wiki: concepts, one page per compartment, the reference and the development notes. Working on Seshat, alone or with other agents: [CLAUDE.md](CLAUDE.md). The plan and the state of its build: [plans/](plans/seshat-plan-ledger.md).

## Author and citation

Seshat is designed and engineered by Kyllian de Vos (GitHub [@Kdevos12](https://github.com/Kdevos12)), built with Claude Code as coding agents.

If you use Seshat in your work, please cite it (see `CITATION.cff`).

## License

Seshat is licensed under the [Apache License 2.0](LICENSE), copyright 2026 Kyllian de Vos. A redistribution, modified or not, must keep the [NOTICE](NOTICE) file with its attribution. If you use Seshat in your work, please cite it ([CITATION.cff](CITATION.cff)).
