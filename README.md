# Seshat

A harness for autonomous mathematical research with LLMs: models through their APIs, Lean as the
judge, classical tools first.

Status: early development (phase P0a). The event journal, the memory store, the line API, the proof
validator, the certifier (a kernel replay in a fresh Lean process), a client for Kimina Lean Server,
the capability registry (manifests, host profiles, MCP boundary, contract tests), a first bench of
575 problems from
[formal-conjectures](https://github.com/google-deepmind/formal-conjectures), the M0 loop
(independent provers on pi, in sessions that pass on their notes) and seventeen lines (M1: shared claims
and negative memory; M2: the variant graph and its logical propagation; M11: small models and
counter-models; M6: guards and drift detectors; M12: the scheduler and its ladder; M18: a curriculum of variants on its first rung; M15: an archive of alternative decompositions and the schemas of the closed ones, on its second rung, documented in [documentation/archive.md](documentation/archive.md); M17: a run in an extended Lean environment; the fleet policy, with sampled session settings, informal-first sessions and a soft failure memory; M8: data tables, hypotheses as programs run in a sandbox and a pool of conjectures; M13: theory exploration; M3: the lemma library, promoted auxiliary lemmas with BM25 and hybrid search, documented in [documentation/library.md](documentation/library.md); M4: the context compiler, a packet in place of the history, documented in [documentation/context.md](documentation/context.md); M5: lessons from accepted proofs and from failures that recur, judged by their effect, documented in [documentation/lessons.md](documentation/lessons.md); M14: typed repairs and Lakatos-style repair; M16: program search for scored subgoals; M10: a classical battery, a domain router, z3 and Vampire with reconstruction in Lean, before any model; documented in [documentation/induction.md](documentation/induction.md), [documentation/repair.md](documentation/repair.md) and [documentation/classical.md](documentation/classical.md)) are written and tested with a
simulated model and a simulated Lean, and all of them work in one run (M7 and M9 are suspended). `harness ablate` runs the cumulative configurations, M0 and then each line in turn, or one experiment, on the same problems at the same budget and writes the comparison table; it reads everything from the journals, together with the reliability of the typed decisions, the cost-to-first-success curves and an entrenchment probe of the memory ([documentation/ablate.md](documentation/ablate.md)). `harness optimize-prompts` rewrites the prover's prompt (a file) GEPA-style on a dev split and proposes patches that beat the merged prompt on a held-out split and a temporal holdout; a person merges them ([documentation/prompts.md](documentation/prompts.md)). The graded bench (`bench/graded-v1.json`, built by `harness-bench graded` from local checkouts of formal-conjectures and PutnamBench, never vendored: grade A exercises, B competition problems, C research problems with a formal proof elsewhere, each admitted only if its statement compiles under the base Lean environment) is the yardstick of the capability work; `harness ablate` reads it through `--bench` and `--grade`, prints the paired protocol (Wilson intervals, an exact McNemar test, dollars per solved problem, problems solved per dollar against a baseline arm and the target line), and every run report gains a Loop section (checks and their seconds, output tokens per check, dollars by cache hit, miss and output, end context, repeated failures, open holes over time) ([documentation/bench.md](documentation/bench.md), [documentation/ablate.md](documentation/ablate.md)); the builder is tested on fixture checkouts and no index is committed, and no real Lean admission or paired run has been made. The bench also holds sequences of related problems and analogy and induction tags, and `bench-ext` converts the equational-theories data from a local cache ([documentation/bench.md](documentation/bench.md)). The work of a run is recorded as tasks in a ledger, and a run
whose process ended is continued from its journal ([documentation/ledger.md](documentation/ledger.md)). A run can also stop by itself at a
token, dollar or time limit or at a breakpoint, write an account of where it stands and wait for the research team, whose hints, signatures and
steers go into the journal and change no claim's status ([documentation/human.md](documentation/human.md)). The Lean the harness runs against is written
as data, an environment (`lean/env/NAME.toml`), which `harness lean-env resolve` checks for
consistency before anything is built ([documentation/lean-env.md](documentation/lean-env.md)); line M17 puts a run in
one with more packages than the bench's. An optional library builder (off by default) can ask a coding agent for new Lean under `lean/SeshatLib`, behind a gate of Seshat's own; what it writes is `unreviewed` and cannot appear in a claim statement until a person or two checkers review it ([documentation/library-builder.md](documentation/library-builder.md)).
The provers can also be given SageMath, an external program installed with Docker or pip
([documentation/compute.md](documentation/compute.md)). Tools and skills can also be installed as packs (`harness add`), which add tools at level 2, human-written skills and heuristic cards and can never write a claim's status ([documentation/packs.md](documentation/packs.md)). With the fleet's option `heuristics`, each session can be given one heuristic card, a method of reasoning written by a person ("vary one parameter at a time"), drawn by family and card against a control share of sessions that get none, and `harness heuristics stats` counts what each family did against that control ([documentation/heuristics.md](documentation/heuristics.md)). A run can start on the memory of an earlier
one (`--memory-from`), its learned records are stamped with where they come from, and the memory store can
draw the unverified items a briefing shows at random and measure their effect, which lines M3 and M5 use
([documentation/memory.md](documentation/memory.md)). `harness solve` takes a problem of one's own, in Lean or in prose, with the defaults of a student: a mandatory small dollar allowance, the budget gate and probe first, the classical lines M1 and M10, the cheapest model that has a price, and a stop with an account at half the allowance; its defaults set `v2` (`--defaults v1` keeps the older one) also gives the provers an edit tool in place of a rewritten file, masks old check results and bounds the Lean checks (not yet run against a real Kimina or model). An option, `--lean-search`, makes the harness search Lean declarations after a check that did not accept the file (an unknown identifier, a hole's goal; a remote service, a local index or a pattern search, as the host sets them up), check every hit with Lean in the run's environment and append the names and signatures Lean printed to the check's answer; it is off by default, off with a private run, and not run against a real Lean or search service ([documentation/lean.md](documentation/lean.md#search-pushed-by-the-harness)). A prose statement is formalized, shown with test lemmas on its first cases and signed by the person before any spend (a `statement.signed` event); `harness doctor` says what the machine lacks (Lean, the Kimina server, credentials, prices, network) and the Kimina settings that fit its memory and writes the host profile that isolates the certifier when bubblewrap or Docker works, and without isolation a run says plainly that its results stay `computed`. Before any paid session a run can take an intake step ([documentation/literature.md](documentation/literature.md)): the literature is searched (`lit.search`: OpenAlex, arXiv, Semantic Scholar, zbMATH, a bench checkout's metadata), one judge call under a cap of $0.05 says whether a hit proves, refutes or restricts the exact statement, a quote counts only when it is in the fetched text, and the statement itself is tested (vacuity, `plausible`, the first cases); a settled hit or a vacuous statement is a breakpoint in a run with a person, and `--private` turns the literature search off; none of it has run against a real site, model or Lean. Every run leaves `RESULT.md` beside its journal (built from the journal by code, rewritten after every certified result and every stop, rebuilt by `harness report`), and `harness view` writes one static HTML page of it ([documentation/quickstart.md](documentation/quickstart.md)); `harness ui` is a local web page (a loopback server with a per-session token, Host and Origin checks and a content security policy, a journal reader, provider settings with each key in a 0600 file outside the repository, and screens to start a problem, sign its statement, watch the spend and stop, read the result, continue, hint or steer, and see the read-only graph) that starts the same commands as subprocesses and cannot change a claim's status ([documentation/ui.md](documentation/ui.md); tested with a fake subprocess, the faux provider and one headless-browser smoke test, never with a real browser session by a person); none of it has run against a real model, Lean, bubblewrap or Docker. Nothing has run against a real
Lean or a real model yet.

## How research flows

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
  leanenv["Lean environment<br/>lean/env files, resolver,<br/>environment hash"]:::built
  libbuilder["LibraryBuilder (off by default)<br/>coding agent in a sandbox,<br/>files added to lean/SeshatLib"]:::wait
  libgate["Seshat's gate<br/>diff, fresh lake build, no sorry,<br/>certifier, test lemmas"]:::wait
  defreview["Definition review<br/>new definitions unreviewed:<br/>not in claim statements"]:::built
  envbuild["lean-env build<br/>cache get, lake build,<br/>time per package"]:::wait
  m12["Line M12: scheduler<br/>given-clause loop, proof numbers,<br/>subsumption, owners"]:::built
  holes["Named holes of a sketch<br/>claims, a decomposes_into edge<br/>checked by Lean, inner provers"]:::wait
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
  hotloop["Cheaper hot loop (solve defaults v2)<br/>lean_edit in place of a rewritten file, old check results<br/>masked in batches, bounded Lean checks"]:::wait
  leanpush["Premises pushed (CA22, option leanSearch)<br/>after a check: a name search on each unknown identifier,<br/>a goal search on each hole; each hit checked with Lean"]:::wait
  signature["Signature of a prose statement<br/>formalized, shown with test lemmas,<br/>statement.signed before any spend"]:::wait
  doctor["harness doctor<br/>Lean, Kimina, credentials, prices, network,<br/>isolation; writes the sandboxed host profile"]:::wait
  resultmd["RESULT.md<br/>built from the journal, no model,<br/>after every certified result and every stop"]:::built
  viewhtml["harness view<br/>one static HTML page from the journal,<br/>no server, no network, all text escaped"]:::built
  intake["Intake, before any paid session<br/>three queries, one judge call under $0.05, a quote that must be<br/>in the fetched text; vacuity, plausible, test lemmas; off with --private"]:::wait
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
  hotloop -->|"edits, masked history,<br/>time-limited checks"| provers
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

Blue: built and tested with the simulated model and Lean. Orange: written and tested with simulations, but it
needs something real before it has run: a Lean server, a model, a service (Jev, the OEIS), a program (SageMath, Vampire, E) or data (the
equational-theories rows, the first real ablation). Grey and dashed: planned, not written (the further classical tools, such as SAT and counterexample search).

Today one loop runs, tested with a simulated model and a simulated Lean: each prover edits a Lean
sketch and checks it with `lean_check`, and the first file that passes the fast check makes the
statement `computed`, a candidate. SageMath is the only classical tool for computing that is plugged
in; the OEIS, the LMFDB and FindStat can be asked too ([documentation/models.md](documentation/models.md#the-services-as-capabilities)).
The provers can also be given Lean's language server, `lean_lsp` (the goals at a line, several
tactics tried at one line, Mathlib search): information that never changes a status, written and
waiting for a Lean like the fast check ([documentation/lean-lsp.md](documentation/lean-lsp.md)).
Every tool call goes through the capability registry, which writes it to the journal, with its inputs
and outputs as blobs. The orchestrator records the work as tasks in a ledger (one `prove` task per
prover, and a routing decision for each failed check), never copying a claim's status, and a run
whose process ended is continued from the journal alone: `harness run --resume` takes up each
problem where the journal left it, with the budgets that were left, and records one certification
per candidate ([documentation/ledger.md](documentation/ledger.md#resume)).
With `--human` or a turn limit (`--turn-tokens`, `--turn-usd`, `--turn-minutes`) the run ends a turn by itself, at the limit or at a breakpoint
(an impasse, a problem settled, two informal validators in disagreement): no session or model call starts after it, the account
`turns/N/report.md` is built from the journal alone, and the run waits until the team has answered with `harness hint`, `sign` and `steer`
and resumed it. Those answers are recorded under each person's name and change no claim's status
([documentation/human.md](documentation/human.md)).
Lean is the judge: no statement becomes `proved` without the certifier's kernel replay
([documentation/certifier.md](documentation/certifier.md)). A run certifies each candidate when the
host has a certifier, and the lines' proofs of other claims and of negations too: a certified proof
makes a claim `proved`, a certified proof of its negation `refuted`. The certifier is unavailable
until the host profile gives it a sandbox command or opts in to running candidates' code unsandboxed
(neither shipped profile does). It is tested with a fake `lake`, and has certified a one-line
Mathlib theorem against a real Lean v4.27.0, without a sandbox and through bubblewrap; no bench
problem has been certified yet.
The memory is what the plan counts on to beat existing systems: its store is
written (claims, the edges between them and records of every kind, all in the journal), and so are
the first lines that use it. M1: one claim per statement, each attempt labeled with its strategy
and how it failed, and an "already tried" section in every session
([documentation/memory.md](documentation/memory.md),
[documentation/m1-identity-memory.md](documentation/m1-identity-memory.md)). M2: a graph of variants
of a claim, joined by edges that become `lean_checked` only when Lean accepts their link lemma; logic
rules follow those edges and turn what they derive into composed proofs that go through the same
fast check; and a proof of the negation of a claim is tried alongside the provers, whichever side
loses being stopped ([documentation/graph.md](documentation/graph.md)). M2 waits for a Lean server
like the fast check. M11: a statement of magmas or of a number is tried on batteries of small
objects, a counter-model becomes a proof of the negation that Lean must check, and the verdicts
give candidate edges between claims and a lookup of the numbers where it holds as a sequence
([documentation/models.md](documentation/models.md)); it waits for a Lean server too. M6 adds the
guards against hallucination and the drift detectors: neutral framing, citations that must
resolve, no raw error text, anchored revisions, and sessions stopped when they loop
([documentation/guards.md](documentation/guards.md)). The fleet policy chooses what each session
works on by Thompson sampling on the verdicts the memory holds, puts more provers on a subgoal only
where one does badly, and sends hard decisions to a stronger model. It samples each session's settings
(temperature, thinking level, a diversity directive, standard or informal-first mode), discounts old failures per run and keeps
a floor of exploration, so that a failure of a weaker configuration does not close a door for good
([documentation/fleet.md](documentation/fleet.md)). Informal-first sessions and the multi-call `judge` helper
have only run against a simulated model. M12 schedules the work between sessions: a prover's sketch with named `sorry` holes becomes claims joined by a decomposition that Lean checks, each hole is a task for a short inner prover, chosen by a given-clause loop with weighted proof numbers, and a problem that spends its budget without Lean progress moves up a ladder of lines ([documentation/scheduler.md](documentation/scheduler.md)); M18, the first rung, solves easier variants of a hard problem with a capped share of its budget and feeds their proofs to later sessions ([documentation/curriculum.md](documentation/curriculum.md)); M15, the second rung, keeps several decompositions of a problem alive in cells, chooses by Thompson sampling the one a session extends, and shows the schemas of closed decompositions to the sessions of other problems through the randomized inclusion ([documentation/archive.md](documentation/archive.md)); all three have only run against a simulated model and Lean, and nothing says M18 or M15 pays.  `decide` puts a typed choice, score or yes/no to a decision-only model (Jev, optional, off by default,
with the run's own model as the default and the fallback) to order work, never to change a claim's status; with Jev on, short proof states go to a third party, and it has never run against the real service
([documentation/decide.md](documentation/decide.md)). The mechanisms are lines that a
run switches on (`harness run --lines M1,M10` or `--ablation M10`), so that each is measured against
the run without it ([documentation/lines.md](documentation/lines.md)); `harness ablate` does that comparison for all of them and the
table it writes is the plan's measure of what each line is worth. The tables have only been made with a simulated model and Lean: the first
real ablation waits for a model, a Lean server and, for the decisions and the equational-theories problems, Jev and the dataset.

This diagram changes with the code: a change to the research flow updates it in the same commit
([documentation/development.md](documentation/development.md#conventions)).

## Commands

```sh
pnpm install
pnpm check
pnpm harness capabilities
pnpm harness models
pnpm harness doctor    # what this machine lacks, and the isolated host profile when it can write one
pnpm harness solve "Every even number above two is a sum of two primes." --max-usd 2    # or Lean, or a file; RESULT.md in the run directory
pnpm harness view runs/RUN_ID    # runs/RUN_ID/view.html, static
pnpm harness ui [--port N] [--open]    # the local interface on 127.0.0.1 only; the address it prints carries a token
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --tool compute.sage
pnpm harness run --resume runs/RUN_ID --checkout ../google-deepmind/formal-conjectures-bench-v1
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --turn-usd 2
pnpm harness hint runs/RUN_ID --claim CLAIM_ID "text"    # then sign, steer, and: harness resume runs/RUN_ID --checkout ...
pnpm harness lean-env resolve base
pnpm harness ablate --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 20 --out runs/ablation    # the cumulative configurations
pnpm harness ablate --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 20 --experiment ladder
pnpm harness optimize-prompts --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 40 --cutoff 2026-01-01 --split dev --max-usd 300   # proposals/ID: candidates, evidence, patches; changes no prompt
pnpm harness chunks runs/RUN_ID    # cost to first success for K provers in parallel
pnpm harness probe runs/RUN_ID --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID
pnpm harness add ../some-pack --allow-programs    # then: pnpm harness packs, pnpm harness remove NAME
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --tool lean.lsp
```

The checkout is formal-conjectures at the bench's tag, `bench-v1-lean4.27.0`
([documentation/m0-loop.md](documentation/m0-loop.md#commands)); `pnpm harness models` lists the
models and says whether their credentials are set.

Documentation: [documentation/](documentation/README.md).

Working on Seshat, alone or with other agents: [CLAUDE.md](CLAUDE.md). The plan and the state of
its build: [plans/](plans/seshat-plan-ledger.md).
