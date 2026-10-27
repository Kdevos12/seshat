# Seshat: implementation plan for the rest of the research plan (P0a to M9)

Goal: implement every remaining step of the research plan's build order
(`plan-memoire-donnees.md` §7: P0a, P0b, M1, M10, M2, M11, M12, M4, M6, fleet policy, M3, M7, M8,
M13, M14, M5, M9) in the Seshat repository, each as a tested mechanism that a run can switch on as
an ablation line, with documentation and the README diagram kept up to date.

Spec: the research plan `plan-memoire-donnees.md` is the authority; its details live in
`graphe-donnees.md`, `outils-classiques.md`, `bibliotheque-outils.md`, `litterature-raisonnement.md`
and `critique-v2.md`. These research notes are in French, so they stay outside the repository
(the repository is English only), in the project's shared files under `research/`, which the main
team's agents read. Each task names the sections it implements; read those sections, not the whole
set. The collaborator's tasks carry English digests of the sections they need
([collaborator-tasks.md](collaborator-tasks.md)).

The state of the build is in the ledgers ([seshat-plan-ledger.md](seshat-plan-ledger.md) for the
main team, [collaborator-log.md](collaborator-log.md) for the collaborator) and the decisions taken
where this plan is silent are in [seshat-plan-rulings.md](seshat-plan-rulings.md). How the teams
work together: [CLAUDE.md](../CLAUDE.md).

Amendments. (1) 2026-10-15: the plan change [plan-change-thinking-modes.md](plan-change-thinking-modes.md)
(PC1 to PC13, drawn from the user's document "Prompt & Thinking modes for MRsearch"; decision note
`research/revue-thinking-modes.md`), approved by the user, is part of this plan. Tasks 15, 16, 18
and 19 are new, and Tasks 6 and 9 to 14 name the changes that amend them; an implementer reads the
named sections of the plan change, whose deliverables and tests then belong to the task.
(2) 2026-10-15: the user's turn-based "consortium" mode, merged with PC2, is Task 17. Later plan
changes from other threads arrive the same way, as `plans/plan-change-*.md` files approved by the
user. (3) 2026-10-20: the plan change [plan-change-jev.md](plan-change-jev.md) (J1 to J5: site tags
on model calls, an optional `decide` capability with a Jev backend, its call sites and line `D1`;
decision note `research/jev-decisions.md`), approved by the user: Task 20 is new and Tasks 6, 13,
14 and 15 name it. (4) 2026-10-20: the plan change
[plan-change-lean-libraries.md](plan-change-lean-libraries.md) (LC1 to LC5: the Lean environment
and its resolver, indexing of library packages, line `M17`, the `LibraryBuilder` and the review
status of definitions; decision note `research/bibliotheques-lean.md`), approved by the user: Tasks
21 and 22 are new and Tasks 9, 11 and 14 name it. (5) 2026-10-20: the user suspended homology
detection, so Task 12 (M7, M9) is not built (Ruling 20); see "Later" at the end of this plan.
(6) 2026-10-20: the user chose to build the whole plan before a first real run on their host
(Ruling 24), and a collaborator joined: Tasks 6, 9 and 11 are the collaborator's (Ruling 25), with
their brief in [collaborator-tasks.md](collaborator-tasks.md). The order of the remaining tasks is
Ruling 24 for the main team and Ruling 25 for the collaborator.
(7) 2026-10-21: the plan change [plan-change-memory-evolution.md](plan-change-memory-evolution.md)
(PE1 to PE9: provenance stamps, epochs and probation for learned artifacts; randomized inclusion of
unverified memory with causal counters; a soft failure memory; an escalation ladder by budget
spent; a session-frozen packet prefix; rules on skills and external text; line `M18`, a curriculum
of variants; offline prompt optimization; an entrenchment probe; decision note
`research/evolution-memoire-continue.md`), approved by the user: Tasks 23 to 26 are new, Tasks 9,
10, 11, 14, 18 and 19 name it, its rules are Global Constraint 16, and the memory that outlives a
run, which it assumes, is Ruling 28. The main team's order is Ruling 27's.

## Global Constraints

These bind every task. Copy them to reviewers verbatim.

1. Repository: `github.com/Kdevos12/seshat`, built by two teams, the main team and a collaborator,
   as `CLAUDE.md` says (who owns which task, who writes which file, how branches merge). A task
   works on its branch `task/t<N>`, in the directory its dispatch names (a checkout or a git
   worktree); run `pnpm install` there first. A worker does not push and does not touch other
   checkouts.
2. TypeScript runs through Node's type stripping: no build step, imports name `.ts` files, strict
   mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and only erasable syntax
   (`erasableSyntaxOnly`: no enums, no parameter properties, no namespaces). Packages live in
   `packages/*`, each with `src/` and `test/`, exporting `./src/index.ts`, linked by pnpm
   workspaces. `@seshat/core` has no runtime dependency. Another package adds an external
   dependency only when it clearly pays for itself, pinned to an exact version.
3. Tests use `node:test` and `node:assert/strict` and run without Lean, a model or a network: the
   simulated Lean (`packages/orchestrator/test/m0-helpers.ts`), the fake Kimina and MCP servers,
   and pi-ai's faux provider stand in. A test that needs a real program (a solver, Sage) runs only
   when that program is present, and says how to run it (the pattern of
   `documentation/development.md`, "Tests that use real data").
4. `pnpm check` (tsc --noEmit, then every test) passes before every commit.
5. Everything in the repository is in English: code, comments, documentation, commit messages.
6. Documentation is written with the code: a change updates the page of `documentation/` that
   describes it, in the same commit. A new package or mechanism gets its own page, linked from
   `documentation/README.md`. Pages are plain prose and tables in the existing style: short
   sentences, what it does, how to use it, what is measured, what is not done.
7. The README's diagram ("How research flows", a Mermaid flowchart) shows the steps a statement
   goes through and the tools a prover can call. Each node ends with `:::built` (built and tested
   here), `:::wait` (written, but waits for a Lean server or a program this environment does not
   have) or `:::planned`. A change to the research flow updates the diagram in the same commit;
   `packages/orchestrator/test/readme.test.ts` fails when a capability's tool is missing from it or
   a node has no mark. Keep node labels to lines of 26 characters or fewer, and the diagram narrow.
8. Trust: claim statuses are `open`, `computed`, `refuted`, `proved`, `proved_informal`,
   `retracted`. Only a Lean check makes a candidate (`computed`) and only the certifier's
   `kernel_replay` makes `proved` or `refuted`; tool output without a Lean certificate is
   `computed` at most and never propagates to `proved`. No mechanism changes a claim's status
   except by submitting a Lean proof through the validation path; nothing goes from research
   records to facts without a verifier. Edge statuses: `proposed`, `computed`, `lean_checked`,
   `informal_checked`, `human_signed`; only `lean_checked` edges propagate proofs.
9. The journal (JSONL with a hash chain) is the only source of truth: every fact a mechanism learns
   is an event; tables and indexes are projections that can be rebuilt from it.
10. Modularity: every external tool is a capability: a manifest in `capabilities/<id>/`, a
    `contract.json`, implementations behind the registry (MCP boundary for external programs),
    host profiles in `config/hosts/`. Any tool is replaceable without touching the rest.
11. Models are used through their APIs only; no training or fine-tuning. Small non-LLM learned
    components used as they are (an online k-NN, a published premise selector) are allowed.
12. Anything that needs a real Lean, a real model or a service this environment cannot reach is
    written against its interface, tested with simulations, and said to be so in its
    documentation ("not run against a real Lean yet") and in the README diagram (`:::wait`).
    The main team's cloud environment cannot reach Lean releases, the Mathlib cache,
    reservoir.lean-lang.org, arXiv, OEIS, zbMATH or LMFDB, and reaches registry.npmjs.org and PyPI
    through a proxy. Another environment may reach more: tests still run without any of it, and a
    run against a real Lean, model or program is reported in the team's ledger or log. Never
    disable TLS verification or unset `HTTPS_PROXY`.
13. No concrete model id in repository files (examples say `PROVIDER/ID`); no model identifier in
    commit messages except the attribution trailer.
14. Commits: one logical change per commit, with its code, tests and documentation together. Every
    commit message ends, after a blank line, with the attribution trailers of the session that
    made it (a `Co-Authored-By:` line and the session link); a dispatch gives its worker the exact
    lines.
15. Workers never dispatch subagents and never push. Each team's controller pushes, pulls and
    merges, as `CLAUDE.md` says.
16. Learned memory (plan change PE1 and PE6). An artifact a mechanism learns from outcomes rather
    than from Lean (a lesson, an attempt record that "already tried" reads, a posterior, a schema,
    a channel statistic, a prompt) is unverified: it carries the provenance stamp of Task 23 and
    never becomes a fact. No mechanism writes free-form procedural skills from the agent's own
    experience: procedure enters only through verified channels (library lemmas, Lean macros,
    schemas) or counted lessons. Human-written skills are allowed; at most 3 are loaded in full in a
    session (an option), and the others are listed by name and description. Text from an external
    source (a paper, a web page, a database entry, a tool's output) keeps its provenance and never
    becomes a lesson or part of a system prompt: a lesson's text comes only from our own journaled
    outcomes.

## Interfaces every task shares

Task 1 defines the line API in `@seshat/lines` and the memory store in `@seshat/memory`, documented
in `documentation/lines.md` and `documentation/memory.md`. Every later task reads those two pages
first and builds on them; a task that needs a change to them makes it, keeps the existing callers
working, and updates the pages in the same commit.

A mechanism of the plan is a *line* (an ablation line, plan §6): an object with an id (`M1`, `M10`,
... `fleet`), the lines it requires, and hooks the orchestrator calls at fixed points of a run. A run
enables lines with `--lines` (or a config file); with no line it is exactly M0. The orchestrator
calls the hooks of the enabled lines in the order of plan §7. Each later task implements its
line(s) in its own package and registers them in `packages/orchestrator/src/lines.ts`.

Learned memory (Task 23, documented in `documentation/memory.md`): the provenance stamp, the epoch
with its probation, and the randomized inclusion of unverified items with their effect posteriors
are calls of the memory store. A task that builds a learned artifact (Tasks 9, 11, 18, 19 and 26)
uses them; until Task 23 merges, it builds against the interface Task 23's section gives, and the
second of the two to merge wires them (Ruling 25).

---

### Task 1: Memory foundation: events, projection, memory store, line API, package skeletons

Where it fits: the foundation every later task builds on. Read first: plan §1, §2 and §5 of
`plan-memoire-donnees.md`; `documentation/architecture.md`, `journal.md`, `trust.md`,
`m0-loop.md`; `packages/core/src/{events,projection,journal,status,ids}.ts`;
`packages/orchestrator/src/{run,prover,session,problem,budget,tools}.ts`.

Deliverables:

1. **Journal events for the memory** (`packages/core/src/events.ts`, projection in
   `projection.ts`, invariants wherever the journal enforces them today):
   - `edge.added`: `edgeId`, `kind` (one of `implies`, `equiv`, `special_case_of`, `strengthens`,
     `negation_of`, `decomposes_into`, `uses`, `refuted_by`, `derived_from`, `cites`,
     `instance_of`), `from` (a claim or node id), `to` (one or more ids; `decomposes_into` has
     several), `status` (an edge status), provenance (`attemptId?`, `toolRunId?`,
     `validationId?`, `note?`), and `link?` (`{name, statement}`: the Lean lemma that makes the
     edge true, for the kinds a lemma can check).
   - `edge.status_changed`: `edgeId`, `from`, `to`, `reason`, `validationId?`. An edge becomes
     `lean_checked` only with the id of a valid validation of its link lemma.
   - `node.recorded` and `node.updated`: generic records for the plan's other node types (§2:
     Lemma, Analogy, Lesson, Source, Group, Inspiration, Hypothesis, DataTable, Drift, Battery,
     fingerprints, repairs...). `node.recorded` has `nodeId`, `kind` (a short lowercase string),
     `claimId?`, `data` (JSON); `node.updated` has `nodeId`, `patch` (a JSON merge patch) and
     `reason`. Mechanism packages own the shape of their kinds' `data`; core only stores them. This
     keeps later tasks from editing core.
   - Extend `claim.created` with optional `gloss`, `domain`, `kind` (`formal` | `informal`),
     `parentId`, and `header` (the Lean imports and `open`s the statement needs), so that any claim,
     not only a problem's target, can be turned into a reference file
     (`theorem <name> : <statement> := by sorry`) for the validator.
   - Extend `attempt.started` with optional `role` (`prove` | `refute` | `explore`), `strategy`
     (declared) and `subgoal`; `attempt.finished` with optional `strategy` (classified), `premises`
     (names the final proof text uses) and `failureDetail` (a short typed summary).
   - Projection tables for edges (with their targets), nodes, and the new columns; bump the
     projection version so old projections rebuild. Rebuilding from the journal gives the same
     tables.
2. **`@seshat/memory`** (new package): a `MemoryStore` over a run's journal, blob store and
   projection, the one way mechanisms read and write the memory:
   - `ensureClaim({statement, header?, origin, gloss?, domain?, kind?, parentId?})`: one claim per
     statement id (plan §3.1, "same hash, same claim"); returns the claim id and whether it was
     created. The statement id comes from a `StatementIdentity` (`{version, id(statement)}`);
     `TextIdentity` wraps today's `statementIdV0`. A Lean-backed identity (`st1_`) arrives in
     Task 3; the store must accept it without change.
   - `addEdge`, `setEdgeStatus`, `recordNode`, `updateNode`, each appending one event.
   - Queries: `claim(id)`, `claimByStatement(statementId)`, `edges({from?, to?, kinds?,
     minStatus?})`, `equivalents(claimId)` (the closure over `lean_checked` `equiv` edges, and the
     claim itself), `attempts(claimId, {includeEquivalents?})`, `nodes(kind, {claimId?})`,
     `node(id)` (data with its patches applied).
   - `referenceFor(claimId)`: the reference file a validation of that claim compares against.
3. **`@seshat/lines`** (new package): the line API.
   - `LineId` and `LINE_ORDER` (plan §7: `M1`, `M10`, `M2`, `M11`, `M12`, `M4`, `M6`, `fleet`,
     `M3`, `M7`, `M8`, `M13`, `M14`, `M5`, `M9`), and the plan's cumulative ablation configs
     (`M1` = M0 + M1, `M2` = M1 + M2, ...: plan §6, in §7's order) as a function from a line id to
     the set of lines it enables.
   - `Line`: `id`, `title`, `requires`, `hooks`.
   - Hooks, all optional and async, each given a context: `beforeProvers(problem)` (may submit
     proofs or refutations for validation, add claims and edges, or settle the problem before any
     model works on it), `briefing(session)` (a titled text section for the session's opening
     message), `contextPacket(session)` (the whole context of each model request, for M4; at most
     one enabled line may give it), `tools(session)` (extra prover tools, as neutral specs:
     name, description, JSON schema, `run(args) -> text`, which the orchestrator adapts to pi
     tools), `beforeSession(session)` (may change the model, stop the prover, or skip),
     `afterCheck(session, check)` (sees each `lean_check` result; may stop the session with a
     reason, for drift detectors), `afterAttempt(problem, attempt)`, `afterProblem(problem,
     outcome)`.
   - The contexts give: run, problem and claim ids, the target, the domain, the `MemoryStore`, the
     registry (tools are called through it, so tool runs are journaled), an `Llm`
     (`complete({system?, prompt, maxTokens?}) -> {text, cost}`, charged to the problem's budget,
     so mechanisms make one-shot model calls without depending on pi), `validate(...)` (submits a
     Lean proof of a claim, or of its negation, through the validator; returns the verdict and the
     new status; this is the only way a line changes a status), the problem's budget, a log
     function, an abort signal, and the line's options.
4. **Orchestrator**: `RunConfig.lines` (default empty: M0, unchanged behavior), validated (unknown
   ids and missing `requires` are setup errors), recorded in `run.started`; `harness run --lines
   M1,M2` and `--ablation M2` (the cumulative config); a `packages/orchestrator/src/lines.ts`
   registry mapping each id to its `Line` (no line is implemented yet: an enabled line without an
   implementation is a setup error that names it as planned); the hooks called at their points of
   the run, in `LINE_ORDER`; the `Llm` and `validate` implementations. The report lists the lines.
5. **Skeletons**: empty packages (package.json, `src/index.ts`) for `@seshat/graph`,
   `@seshat/classical`, `@seshat/models`, `@seshat/scheduler`, `@seshat/context`,
   `@seshat/guards`, `@seshat/fleet`, `@seshat/library`, `@seshat/lessons`, `@seshat/abduction`,
   `@seshat/induction`, `@seshat/repair`, `@seshat/lean-meta`, `@seshat/lean-local`, each depending
   on `@seshat/core`, `@seshat/memory` and `@seshat/lines` (and `@seshat/registry`), with
   `pnpm-lock.yaml` updated once, so later tasks do not edit the lockfile.
6. `.gitattributes`: `documentation/README.md merge=union`.
7. Documentation: `documentation/memory.md` (the store, the events, the node kinds convention),
   `documentation/lines.md` (the line API, the hooks and when they run, how a task adds a line,
   the cumulative configs), updates to `journal.md`, `architecture.md`, `m0-loop.md` (the
   `--lines` option), `documentation/README.md`. README diagram: no node changes state (no line is
   implemented yet), but the caption says that the mechanisms come as lines a run switches on.

Tests: events and projection round-trip (rebuild gives the same rows); `ensureClaim` dedups by
statement id and accepts another identity; `equivalents` follows only `lean_checked` `equiv`
edges; `node` applies patches in order; an edge cannot become `lean_checked` without a valid
validation; a run with a fake line (registered in the test, not in `lines.ts`) calls its hooks in
order, a `beforeProvers` that settles the problem leaves the provers idle, `validate` records a
`validation.finished` and moves the status only on a valid verdict; unknown or unmet lines refuse
to start; a run without lines is unchanged (the existing M0 tests pass as they are).

### Task 2: M1: canonical identity, shared negative memory, "already tried"

Where it fits: the first ablation line (plan §7 step 3). Read first: `documentation/lines.md`,
`documentation/memory.md` (Task 1), plan §3.1 and §3.3, `graphe-donnees.md` §2.1, `outils-classiques.md`
§9 (failure classes only), `packages/orchestrator/src/feedback.ts`.

Deliverables in `@seshat/memory` (identity, attempts) and the orchestrator's `lines.ts` registration:

1. Identity: claims of a run go through `ensureClaim`, so two problems or subgoals with the same
   statement share one claim and its attempts. Text identity (v0) by default; the line takes any
   `StatementIdentity` (Task 3 brings the Lean one).
2. Strategy labels from a closed vocabulary (induction, cases, contradiction, computation
   (`decide`, `norm_num`, `native_decide`), automation (`simp`, `aesop`, `omega`, `linarith`,
   `grind`...), construction or witness, counterexample, strengthening or generalization,
   rewriting to a known lemma, algebraic manipulation, bounds and estimates, extremal or
   pigeonhole, other), **classified deterministically** from the submitted proof text (the tactics
   and terms it uses), never by a model. A prover may also declare one through an optional
   `strategy` argument of `lean_check`; the declared and the classified labels are both recorded.
3. Failure classes computed from Lean's messages (extend `failureClass`): syntax, type mismatch,
   unknown identifier or lemma, unsolved goals (with the goal's case name when Lean gives one),
   timeout, residual `sorry`, statement changed, forbidden axiom, auxiliary lemma restating the
   target (v0: the aux lemma's statement normalized equals the target's), other. Recorded on
   `attempt.finished` with a `failureDetail` such as "unsolved goals at case succ".
4. `alreadyTried(claimId)`: attempts on the claim and its equivalents, grouped by strategy, with
   counts, failure classes and the last detail, rendered as typed one-line summaries ("induction:
   3 attempts, unsolved goals at case succ"), never the text of a failed attempt (plan §9).
5. The `M1` line: records strategies, premises and failure details on attempts
   (`afterAttempt`/`afterCheck`), and gives every session of every prover, through `briefing`,
   the "already tried" section for its claim, so provers share their negative memory (M0 provers
   share nothing). Its options: the section's maximum lines.
6. Metric in the run report: the share of attempts on claims (or equivalents) that were already
   attempted with the same strategy and failed the same way (the plan's "redundant attempts").
7. Docs: `documentation/m1-identity-memory.md`; `lines.md` lists M1; README diagram: M1's
   pieces (identity and negative memory) as built nodes on the flow.

Tests: classification of strategy from proof texts (a table of cases), failure classes from
Lean messages (a table), dedup of two problems with the same statement, the "already tried" text,
the briefing reaching the second session's first message in a faux-model run, the redundancy
metric.

### Task 3: P0b: the Lean meta tool (`lean.meta`) and the Lean-backed identity

Where it fits: plan §7 step 2, the Lean brick M1–M3, M7 and M12 depend on. Read first:
plan §3.1 and §5 (the Lean meta tool), `graphe-donnees.md` §2.1 and §7 (structure profiles,
discrimination trees), `documentation/lean.md`, `documentation/capabilities.md`,
`capabilities/lean.check/`, `packages/lean-kimina/`.

Deliverables:

1. A Lean 4 library in `lean/SeshatMeta/` (a Lake package that requires Mathlib at the bench's
   pinned version `v4.27.0` toolchain, as documented in `documentation/lean.md`), with commands that
   print one JSON line each:
   - `#seshat_hash <term>`: elaborate a statement, instantiate metavariables, normalize
     (anonymize bound names, `instantiateMVars`, reduce instances, optional `simp only` set),
     hash the `Expr` (stable across runs and machines), print `{"id": "st1_..."}`.
   - `#seshat_defeq <a> <b>`: `isDefEq` with a heartbeat limit.
   - `#seshat_premises <decl>`: the constants a proof uses (`getUsedConstants`, filtered to
     theorems).
   - `#seshat_profile <term>`: the structure profile (type classes and instances the statement
     involves), for exact homologies.
   - `#seshat_instances <term>` against an index of the project's facts (a discrimination tree,
     `Lean.Meta.DiscrTree`), for subsumption: which known facts the statement is an instance of,
     and which open statements a new fact covers.
   This environment has no Lean: write it with care against Lean 4 and Mathlib's API of that
   version, keep it small, and say plainly in the docs that it has never been compiled.
2. Capability `lean.meta` (manifest, description for the model, `contract.json` with cases that
   will run on a Lean host; implementation through the Kimina Lean Server with a header that
   imports `SeshatMeta`), and the package `@seshat/lean-meta`: a typed client (`hash`, `defEq`,
   `premises`, `profile`, `instances`) over the registry, a `LeanIdentity` implementing
   `StatementIdentity` (`st1_` ids), and a simulated implementation for tests (deterministic
   answers from a table).
3. Capability `lean.goals` for per-goal operations through Pantograph (manifest, MCP or process
   implementation, contract cases), with the client's interface; simulated in tests.
4. Docs: `documentation/lean-meta.md`, updates to `lean.md`, `capabilities.md`. README diagram:
   the Lean meta tool and `lean_goals` as `:::wait` nodes.

Tests: the client parses the commands' JSON, maps errors, and `LeanIdentity` gives `st1_` ids;
the contract file loads; the registry offers both capabilities on a host profile that has them.

### Task 4: P0a: the certifier (`kernel_replay`)

Where it fits: closes P0a; without it nothing becomes `proved`. Read first:
`documentation/trust.md`, `validator.md`, `lean.md`; `packages/core/src/{lean,validator}.ts`
(the `LeanCertifier` interface); the design notes on lean4checker and SafeVerify in those pages.

Deliverables in `@seshat/lean-local` and the orchestrator:

1. A `LeanCertifier` that, in a fresh process of a pinned Lean project (`lake env lean`),
   compiles the candidate as a module, replays every declaration through the kernel
   (`Lean.Environment.replay`, as lean4checker does) in a small Lean program shipped in
   `lean/SeshatCertify/`, collects the target's axioms itself, and compares the target's type with
   the reference's as terms (the SafeVerify approach). It returns `certified` or `rejected` with
   reasons and axioms, and respects a time limit and an abort signal.
2. A capability `lean.certify` (manifest, contract, host profile entries) so the certifier is
   chosen and replaced like any tool.
3. The orchestrator certifies candidates when a certifier is available on the host: a candidate
   that certifies makes the claim `proved` through the existing validation path
   (`kernel_replay`), one that is rejected leaves it `computed` and records why. Refutations
   (`¬ statement`) go through the same path.
4. Docs: `trust.md`, `lean.md`, `validator.md`, `m0-loop.md`; README diagram: the certifier as
   `:::wait`.

Tests: with a fake `lake` (a script that prints what the real one would), certified and rejected
cases, a timeout, axioms outside the allowed set, a target whose type differs from the
reference's; the run makes a claim `proved` only after certification.

### Task 5: M2 and conditional statuses: variants, verified edges, propagation, ATMS labels

Where it fits: plan §7 step 5 (M2) and the "proved modulo" labels of M12 (§7 step 7). Read first:
plan §3.2 and §9 (the twin), `graphe-donnees.md` §3 and §4.

Deliverables in `@seshat/graph`:

1. Variants and edges: creating a variant claim (strengthening, special case, generalization,
   negation) with its edge as `proposed`; checking an edge by its link lemma
   (`theorem link : A → B` and the like) through `validate`, which makes it `lean_checked`.
2. A propagation engine: about twenty Datalog-style rules evaluated semi-naively after each new
   fact (plan §3.2: A proved and A implies B → B proved; all parts of a `decomposes_into` proved →
   parent proved; B refuted and A implies B → A refuted; ¬A proved → A refuted; equivalences;
   special cases), with provenance per derived fact (why it holds), statuses as a lattice, and
   incremental revocation when a fact is retracted. A derived `proved` is only *proposed*: the
   engine generates the composed proof (the link lemma applied to the proof of A), and the claim
   becomes `proved` only when that composed proof passes `validate`.
3. The prove/refute twin: for an open claim, a refutation attempt runs alongside the proof attempt
   (plan §9, neutral framing); when one side settles, the other stops (through the graph).
4. ATMS labels (`graphe-donnees.md` §3): for each claim, the minimal sets of open claims it
   depends on ("proved modulo"), nogoods, and the value of an open lemma (how many claims it
   would settle); recomputed incrementally and readable by the scheduler (Task 11) and the
   context compiler (Task 12).
5. Personalized PageRank from a claim over the graph (for Task 12), and `graphQuery`, a small
   typed path query (plan §13: edge kinds, statuses, depth) returning a subgraph with short ids.
6. Lines: `M2` (variants, edge checks, propagation and the twin, after each validation and
   attempt). Docs: `documentation/graph.md`; README diagram: facts and research graph, propagation.

Tests: each rule on small graphs, provenance and revocation, a composed proof submitted to the
simulated Lean before `proved`, the twin stopping, labels and nogoods on an AND/OR example,
PageRank on a fixed graph, graph queries.

### Task 6: M10: the classical battery per subgoal, the domain router, ATP and SMT

Owner: the collaborator (Ruling 25). Its brief, with English digests of the research it
implements and what it shares with the main team: [collaborator-tasks.md](collaborator-tasks.md).

Where it fits: plan §7 step 4, "the cheapest gain". Read first: plan §15, `outils-classiques.md`
§1 to §4, §10 and §12, `bibliotheque-outils.md` §1 and §3, `documentation/capabilities.md`.

Amended by PC6 items 2 and 3 of `plans/plan-change-thinking-modes.md`: ATP and hammer calls at several
premise cutoffs with a BM25 stream, keeping the union of successes; and the `prove.search`
capability (goal-level best-first search through `lean.goals`), measured against whole-proof
sessions at equal dollars and removed if it loses.

Amended by J3 item 3 of `plans/plan-change-jev.md`: `prove.search` orders candidates that come without a model
call (battery tactics, library lemmas tried by `apply`, aesop rules) through an injectable
orderer, so that Task 20 can plug `decide` in; a model's own ranking of the tactics it proposed
stays as it is.

Deliverables in `@seshat/classical` and new capabilities:

1. A Lean tactic battery: for a goal (the target, or each named `sorry` of a sketch), Lean snippets
   `example : goal := by <tactic>` for `decide`, `norm_num`, `simp`, `omega`, `linarith`,
   `nlinarith`, `positivity`, `ring`, `aesop`, `grind`, `exact?`, `canonical` and LeanHammer's
   `hammer` (each only if the host's Lean has it), checked through `lean.check` in parallel with a
   stop at the first success, ordered by Beta posteriors per (domain, tactic) learned from the
   journal, under a CPU-time budget. A success is a submission that goes through `validate`.
2. A domain router (decision procedures first): Presburger arithmetic to `omega`, linear real
   arithmetic to `linarith`, finite domains to `decide`, polynomial identities to `ring`, and so
   on, from a cheap syntactic analysis of the goal.
3. ATP and SMT with reconstruction: translation of first-order and arithmetic goals (a documented
   fragment) to TPTP and SMT-LIB; capabilities `smt.z3` (z3 from PyPI's `z3-solver`, which can be
   installed here for a real test) and `atp.vampire` (process implementation; untested here if
   the binary is absent); an unsat answer is `computed` until reconstructed in Lean (premises from
   the unsat core or proof handed to `grind`, `aesop` or `hammer`), and only the reconstructed proof
   is submitted.
4. A capability `prove.auto` that runs the battery as one tool a prover can call (plan §16 level 1).
5. Line `M10` (`beforeProvers`: the battery on the target and on each subgoal before any model;
   the briefing says what was tried). Docs: `documentation/classical.md`; README diagram: the
   battery, the router, ATP and SMT nodes (`:::wait` for what needs Lean, `:::built` for what ran).

Tests: snippet generation, routing table, first-success stop and posterior ordering, TPTP and
SMT-LIB translation on examples, the z3 test when z3 is installed, reconstruction submitting only
Lean proofs, the line settling a problem with the simulated Lean.

### Task 7: M11: small models, fingerprints, certified refutations, identification

Where it fits: plan §7 step 6. Read first: `graphe-donnees.md` §2.2 and §2.3, `outils-classiques.md`
§3, §5 and §6, plan §3.1 (fingerprints).

Deliverables in `@seshat/models`:

1. Batteries of small objects for the bench's discrete domain, each with the code that generates
   it: finite magmas up to isomorphism (sizes 1 to 3 at least, size 4 by sampling), small groups
   (cyclic, dihedral, symmetric and the small groups library through `compute.sage` when
   available), graphs up to isomorphism (a generator for up to 6 or 7 vertices in TypeScript,
   nauty's `geng` through Sage when available), integers up to N.
2. Evaluators of a statement on a battery: equational laws on magmas (parsed and evaluated in
   TypeScript), predicates given as executable programs (a sandboxed JavaScript function with a
   time limit), and a Lean evaluator that instantiates the statement on a concrete object and asks
   `decide` through `lean.check`.
3. Fingerprints (the vector of verdicts on a battery), stored as nodes; candidate equivalences
   (equal fingerprints) and implications (inclusion) as `computed` edges; a counter-model makes a
   refutation that is certified by `decide` in Lean through `validate`, never by the fingerprint
   alone.
4. Identification: a service that recognizes a sequence or a table (a local table of known
   sequences shipped with the package; OEIS, FindStat and LMFDB clients with offline fixtures in
   tests, since those sites are blocked here).
5. Line `M11`. Docs: `documentation/models.md`; README diagram: small models and fingerprints.

Tests: counts of magmas and graphs up to isomorphism against known values, fingerprints of known
laws, implication candidates, a refutation submitted to the simulated Lean, identification of a few
sequences from fixtures.

### Task 8: M6 guards and drift detectors, and the fleet policy

Where it fits: plan §7 steps 9 and 10. Read first: plan §9 and §11, `litterature-raisonnement.md`
(the parts §9 and §11 cite), `critique-v2.md` §4.

Deliverables in `@seshat/guards` and `@seshat/fleet`:

1. Guards (line `M6`), all deterministic, each journaled as a `drift` node: neutral framing (a
   prover gets "determine whether" on an open conjecture, and prove and refute run as a twin),
   resolved citations (any reference in a prover's output must be an id of its packet or graph,
   or resolve to a `source` node; an unresolved one rejects the proposal; a `sorry` presented as a
   known result blocks), no raw error text in context (negative memory as typed summaries only),
   anchored revisions (a revision only follows an external signal), and drift detectors that stop
   and restart a session: the same strategy N times without Lean progress, a proved statement that
   differs from the target, an auxiliary lemma nearly equivalent to the target, length growing
   without a closed subgoal.
2. Fleet policy (line `fleet`): Beta posteriors per (claim, strategy) and per model from the
   journal; Thompson sampling to choose what the next session works on and with which model;
   parallel work only where plan §11 allows it, one Ralph loop at a time per (subgoal, strategy);
   adaptive width (widen a subgoal only when its single-agent posterior is low, with caps per
   subgoal and per problem); escalation to a stronger model on hard decisions; no communication
   between workers except through the graph.
3. Docs: `documentation/guards.md`, `documentation/fleet.md`; README diagram: guards and fleet
   policy.

Tests: each detector on scripted sessions, citation resolution, the framing of prompts, posterior
updates and Thompson choices with a seeded random source, width caps, escalation.

### Task 9: M3 and M5: the growing lemma library, and lessons with counters

Owner: the collaborator (Ruling 25). Its brief, with English digests of the research it
implements and what it shares with the main team: [collaborator-tasks.md](collaborator-tasks.md).
Its non-triviality test uses Task 6's battery once Task 6 is merged (Ruling 25, which replaces the
Task 14 part of Ruling 3).

Where it fits: plan §7 steps 11 and 15. Read first: plan §3.4, §3.5, §4 (the library section of
the packet), plan §0 on LEGO-Prover and `critique-v2.md` Q2 on ACE.

Amended by PC3 of `plans/plan-change-thinking-modes.md` (lessons of kind
`constraint` distilled from failures that recur across claims; `obstruction` nodes, which M2 and
M11 also record) and PC5 item 2 (hybrid ranking of library candidates by a convex combination of
normalized BM25, vector and PPR scores, kept only if it beats the best single channel). PC12
(tactic mining) is not built until M3's measurements show library use.

Amended by LC2 of `plans/plan-change-lean-libraries.md`: the declarations of the Lean environment's
extra packages (Task 21) are indexed once per environment hash with the same selector as Mathlib;
the ranking order is problem-local, then the harness library, then extra packages, then Mathlib,
with the source shown so the prover knows what to import; the report counts proofs that use a
declaration from each package.

Amended by PE1, PE2 and PE6 item 4 of `plans/plan-change-memory-evolution.md`: lessons carry Task
23's provenance stamp, and library lemmas carry the Mathlib revision and are compiled again when it
changes (PE1). A lesson's standing is its causal effect, not its presence: Task 23's randomized
inclusion decides whether a session sees it, its effect is the difference between the success rates
of attempts with it and without it in one claim group and strategy label (two Beta posteriors), and
it is deactivated when P(effect < 0) > 0.9 after at least M observations on each side (both
options); the presence counters of deliverable 2 stay in the report for comparison (PE2). With
`--human` (Task 17), promoting a lesson to the global scope is staged for the team's approval:
`harness lessons pending|approve|reject` (PE6 item 4). Global Constraint 16 holds for lessons.

Deliverables in `@seshat/library` and `@seshat/lessons`:

1. Library (line `M3`): promotion of proved auxiliary lemmas that are non-trivial (not closed by
   the battery's cheapest tactics) and general (they do not depend on the problem's local
   context), deduplicated by statement id, written to `lean/SeshatLib/<Domain>.lean` (Ruling 26) with their
   provenance, indexed by name, signature and gloss (a BM25 index, rebuilt from the journal),
   searched before Mathlib through a `library_search` prover tool and a briefing section; the
   share of proofs that use a library lemma, in the report.
2. Lessons (line `M5`): ACE-style entries with a scope (global, domain, claim) and counters that
   outcomes update (a lesson present in a successful attempt's context gains, in a failed attempt
   on the same strategy loses), never rewritten: added, merged when duplicate, deactivated when
   harmful outweighs useful; the active ones in a briefing section; they replace M0's prose notes
   only when the line is on.
3. Docs: `documentation/library.md`, `documentation/lessons.md`; README diagram.

Tests: promotion criteria, dedup, the generated Lean file, BM25 ranking, counters and
deactivation, the briefing sections.

### Task 10: M12: the saturation kernel and the subgoal scheduler

Where it fits: plan §7 step 7. Read first: plan §3.3 (posteriors), `graphe-donnees.md` §1, §3 and
§5, `documentation/graph.md` (Task 5), `documentation/fleet.md` (Task 8).

Amended by PC1 item 6 of `plans/plan-change-thinking-modes.md` (the scheduler
selects among the ledger's `ready` tasks, Task 15, instead of keeping its own queue) and PC4 item 1
(each unproved `aux_` lemma also becomes a `prove` task with a small inner budget, and a lemma
proved inside reaches the outer prover's next briefing).

Amended by PE4 of `plans/plan-change-memory-evolution.md`: a per-problem escalation ladder in the
scheduler. Rung 0 is the provers with the cheap lines that are on (M10's battery, M2's
propagation); rung 1 is line `M18` (Task 25); rung 2 is lines `M15` and `M16` (Tasks 18 and 13). A
rung counts only if its line is on, and a line built after this task registers its rung when it
merges. A problem moves up a rung when a fraction f_k of its budget is spent without Lean progress
(a new proved subclaim, or fewer open holes in the best healthy sketch, one that checks with only
its named holes open); f = 0.3, then 0.6, by default (options, tuned on real runs from Task 14's
cost-to-first-success curves). Each move is a `ladder.escalated` event with its reason, and the
report gives per problem the rung that solved it and the dollars spent on each rung.

Deliverables in `@seshat/scheduler` and the orchestrator:

1. A given-clause loop over claims: a passive queue and an active set, selection by an age/weight
   ratio (fairness against starvation), forward and backward subsumption (a new claim that is an
   instance of a known fact is closed without a model, through `lean.meta`'s instances in Task 3,
   and a new general fact closes the tasks it covers), "simplify early, generate late".
2. Weighted proof numbers on the AND/OR graph (`decomposes_into` is AND, alternatives are OR),
   weighted by the Beta posteriors, to choose the next subgoal; with Task 5's labels, the value of
   an open lemma.
3. The orchestrator works on subgoals when the line is on: a sketch's named `sorry`s become
   claims with `decomposes_into` edges, provers work on the chosen subgoal, and the parent is
   settled by propagation. This may extend the line API with a scheduling hook; update
   `lines.md`.
4. Line `M12`. Docs: `documentation/scheduler.md`; README diagram.

Tests: selection fairness, subsumption closing claims, proof numbers on fixed AND/OR graphs, a
faux-model run that proves two subgoals and settles the parent through propagation.

### Task 11: M4: the context compiler, `expand` and `graph_query`

Owner: the collaborator (Ruling 25). Its brief, with English digests of the research it
implements and what it shares with the main team: [collaborator-tasks.md](collaborator-tasks.md).

Where it fits: plan §7 step 8. Read first: plan §4 and §13, `graphe-donnees.md` §6,
`documentation/graph.md`, `library.md`, `lessons.md`, `m1-identity-memory.md`.

Amended by PC5 items 1 to 4 of `plans/plan-change-thinking-modes.md`: query
extraction (never retrieval on the raw statement alone), the accessibility filter, pattern seeds
with their dependency neighbours, widening on failure; hybrid ranking; the `connect` mode of M2's
`graphQuery` (Task 5's code) and the path renderings; the `expand` table format with relation
kinds for hub nodes.

Amended by LC2 of `plans/plan-change-lean-libraries.md`: the premise selector covers the environment's
extra packages (Task 21) in the ranking order of LC2, the source shown in the briefing.

Amended by PE2 and PE5 of `plans/plan-change-memory-evolution.md`. Each unverified item the
compiler selects (a lesson, a schema hint, a library hint section; never a verified fact the proof
needs, never the goal) goes through Task 23's randomized inclusion, which records the draw on
`attempt.started` (PE2). The packet comes in two parts through Task 24's API: a prefix (goal,
useful facts, candidate premises, already tried, active lessons as drawn) compiled once when the
session starts and sent unchanged on every request of the session, then a tail (the sketch's
state, the last raw Lean feedback, the budget left) compiled for each request, so that a provider's
prompt cache covers the prefix (PE5). Facts learned during a session reach the next session or, as
an option, the tail, as a short list of what is new since the session started. Deliverable 1's
"rebuilt for each model request" now holds for the tail only.

Deliverables in `@seshat/context`:

1. A deterministic packet for (role, claim, token budget), rebuilt for each model request through
   the `contextPacket` hook (pi's `transformContext`), with fixed sections in order: goal (Lean
   statement and gloss), sketch state (open subgoals only), useful facts (proved, with status
   badges), candidate premises (library, then Mathlib through a symbolic selector, MePo or SInE,
   plus an online k-NN over our own proofs), already tried, active lessons, the last raw Lean
   feedback (only the last). Selection by personalized PageRank from the target and status, then
   similarity; nothing under a relevance threshold even with budget left; the amount of graph
   shown set per model.
2. Short citable ids (`C17`, `L4`) and an `expand(id)` prover tool; a `graph_query` prover tool
   over Task 5's query engine; outputs constrained to the graph (cited ids must exist).
3. Never raw tool output accumulated, never a summary of history: the packet replaces the
   history for each request.
4. Line `M4`, with a naive packet of the same content as its comparison (plan §6: "complete
   context compiler vs naive packet with the same content"). Docs: `documentation/context.md`;
   README diagram: the context compiler and its tools.

Tests: section order and budget, threshold, determinism (same inputs, same packet), ids and
`expand`, a faux-model run where the second request's context is the packet.

### Task 12: M7 and M9: the abductive engine and its reranking from our labels

Where it fits: plan §7 steps 12 and 16. Read first: plan §10, `graphe-donnees.md` §7,
`litterature-raisonnement.md` (Shen et al., TCA-SIR, MAC/FAC).

Suspended (the user's decision of 2026-10-20, Ruling 20): this task is not built. Semantic jumps
obtained by deriving an expression through the graph are, in the user's words, its structural
equivalent and more accurate in practice. The research notes stay (plan §10, `graphe-donnees.md`
§7); lines `M7` and `M9` stay refused by a run and leave the cumulative configs. The text below is
kept for the record only.

Amended by PC9 of `plans/plan-change-thinking-modes.md`: the reranking uses
Task 19's `judge` helper (k independent calls, a `disagreement` flag), never for anything Lean can
decide.

Deliverables in `@seshat/abduction`:

1. Trigger: a fixed budget quota and stagnation (low posterior on every branch of a subgoal).
2. The target's relational skeleton: computed (types, hypotheses, structure profile from
   `lean.meta`, blocking subgoal, observed failure classes) and extracted by a model call (key
   objects and relations, the obstacle in one sentence).
3. A multichannel candidate pool, each candidate keeping its channel: exact homologies (results
   stated for a structure the target is an instance of, dualities, tested by `apply` in Lean),
   computed homologies (shared invariants or fingerprints, structure profiles, property profiles
   weighted by rarity; content vectors then anti-unification, which computes f_O, f_R and Δ),
   distant domains proposed by a model with an explicit mapping, semantic search (a
   `search.theorems` capability with an offline fixture), past analogies that worked.
4. Reranking by a direct model ranking (no R/A interface in the prompt); M9 adds in-context
   examples of winning (target, inspiration) pairs from the journal and per-channel Beta
   posteriors whose Thompson sampling sets each channel's budget share. No training.
5. Analogy cards M = (f_O, f_R, Δ, Γ) as nodes; the transferred statement becomes a claim, each
   missing condition of Γ an auxiliary claim, with `derived_from` edges; mapping statuses
   `proposed`, `structurally_supported`, `verified_for_transfer`. Inspirations are labeled by
   outcome (did they lead to a proved subgoal) from day one.
6. Lines `M7` and `M9`. Docs: `documentation/abduction.md`; README diagram.

Tests: anti-unification on terms, channel bookkeeping, the trigger, reranking prompts and parsing
with the faux model, Beta updates and channel shares with a seeded random source, cards and
claims created.

### Task 13: M8, M13 and M14: induction, theory exploration and conjectures, repairs

Where it fits: plan §7 steps 13 and 14. Read first: plan §12, `outils-classiques.md` §5 to §9.

Amended by PC4 item 2 of `plans/plan-change-thinking-modes.md` (a scored
conjecture pool around the target), PC8 (line `M16`: program search for subgoals that carry a
computable score, inserted after `M8` in `LINE_ORDER`; a found witness is settled only by Lean) and
PC11 item 2 (informal hypotheses and repairs go through the step DAG before formalization).

Amended by J3 item 1 of `plans/plan-change-jev.md`: the conjecture pool's relevance score
(PC4 item 2) goes through Task 20's `decide` when that task is built (a Score per conjecture on its
statement alone), else through `judge`.

Deliverables in `@seshat/induction` and `@seshat/repair`:

1. Data (M8): small cases and invariant tables as `datatable` nodes with the code that produced
   them (JavaScript in a sandbox, or Sage through `compute.sage`), then identification (Task 7's
   service) and classical conjecturing without a model: the Dalmatian heuristic (true on all
   objects, strictly better on at least one), guessing linear recurrences (Berlekamp–Massey or
   Padé, gfun's guess-then-prove), integer relations for constants (PSLQ).
2. Hypotheses at several levels of abstraction proposed by a model, each as an executable program,
   filtered by execution on the data; dependencies between invariants; formalization in Lean,
   test lemmas on the first cases, a triviality filter (the battery's automation proves it, so it
   is not interesting), interestingness measures (non-vacuity, novelty against known facts,
   surprise, significance); proved theorems feed the next conjectures.
3. Theory exploration (M13): for a definition, enumerate terms over its signature up to a size,
   test equalities on small models (Task 7), keep a minimal set of laws (QuickSpec-style), pour
   them into the library as candidates.
4. Repairs (M14, `@seshat/repair`): a table of typed repairs from failure classes (Ireland and
   Bundy's proof critics: induction revision, generalization, lemma speculation, case split), and
   Lakatos-style repair of a refuted conjecture (monster-barring and exception-barring with a
   separating concept found in the data table).
5. Lines `M8`, `M13`, `M14`. Docs: `documentation/induction.md`, `documentation/repair.md`; README
   diagram.

Tests: recurrence guessing on known sequences, PSLQ on known relations, the Dalmatian filter,
sandboxed hypothesis programs with time limits, interestingness scores, theory exploration on a
small signature (e.g. monoid laws found from a free structure), the repair table, a Lakatos repair
on a scripted counterexample.

### Task 14: Integration: all lines in a run, the ablation runner, the bench's sequences

Where it fits: the last step: every line works in one run and the plan's measurements can be
made. Read first: all `documentation/` pages of the lines, plan §6 and §15.

Amended: the measurements named in PC5, PC7 and PC13 of `plans/plan-change-thinking-modes.md` join the
ablation table; lines `M15` and `M16` join the cumulative configs (Ruling 8); Task 17's turns and
breakpoints are refused in an ablation run.

Amended by `plans/plan-change-jev.md` (spend per call site, J1; the per-site reliability
table and ECE, J4; line `D1`, J5, marked "not run against real Jev" until the environment allows
`openrouter.ai` and a key is set) and by `plans/plan-change-lean-libraries.md` (line `M17`, LC3;
proofs per library package, LC2). Lines `M7` and `M9` are suspended (Ruling 20): they leave the
cumulative configs, and the plan §6 measurements that need them (inspirations in causal chains)
are dropped; the share of proofs through an inductive hypothesis (M8) stays.

Amended by `plans/plan-change-memory-evolution.md`. PE4: the ladder against all rungs from the
start and against rung 0 only, at equal budget and split by difficulty, and cost-to-first-success
curves by Nexus's chunking protocol (100 attempts of one prover grouped into chunks of 100/K
attempts, K in {1, 3, 6, 10}, a chunk succeeding when one of its attempts does, the cost summed up to
the first success), from which the ladder's fractions are tuned on real runs. PE2: the lesson set's
size and the solve rate against the presence counter. PE5: dollars per solve with the frozen prefix
against a prefix compiled for each request. PE9 in full: a fixed probe set (20 bench problems by
default, never used to build the library) rerun every K runs (an option) twice, with memory on and
with every learned unverified artifact withheld (verified facts kept), and an alarm in the report
when memory on solves fewer or costs more beyond noise; the library and the schemas built on one
part of the bench and measured on another; and, over time, the number of distinct strategy labels
and sources among proofs, the share of budget spent on strategies never tried on that claim group,
and the share of proofs that reuse a library lemma or a schema. Line `M18` (Task 25) joins the
cumulative configs after `M12`; Task 26 stays outside ablation runs.

Deliverables:

1. Every line composed in one run in plan order, with plan §15's order of operations per subgoal
   (subsumption, fingerprint, router, battery, ATP and SMT, then the model with the context of what
   was tried); conflicts between lines resolved and documented.
2. `harness ablate`: runs the cumulative configs (M0, then each line added in §7's order, or a
   chosen list) on the same problems at equal budget, and writes a comparison table with plan §6's
   measurements: problems solved, dollars and tokens per solve, redundant attempts, mean context
   size, share of proofs that use a memory element, share of subgoals and conjectures settled
   without a model and their CPU cost, tokens of tool definitions per request; for M7 to M9, the
   diversity of proof mechanisms and the share of proofs whose causal chain goes through an
   inspiration or an inductive hypothesis.
3. The bench: sequences of related problems (for M3) and problems tagged with a documented analogy
   or induction (for M7 and M8), in the bench index, built from the formal-conjectures checkout's
   structure (variants of one problem, shared files).
4. An end-to-end test with every line on, with the faux model, the simulated Lean and simulated
   tools; the README diagram and caption final; `documentation/README.md` complete.

Tests: the ablation table on a small simulated bench, the end-to-end run, the bench sequences.


### Task 15: Execution graph, task ledger, typed error routing and resume

Where it fits: PC1 of `plans/plan-change-thinking-modes.md`, infrastructure that Tasks 10, 13, 17 and 18 use; the
user called the ledger "crucial". It is not an ablation line: with no line enabled, M0 records one
`prove` task per prover and behaves as before. Read first: §PC1 of the plan change,
`documentation/memory.md`, `m0-loop.md` and `lines.md`.

Amended by J1 of `plans/plan-change-jev.md`: a `site` tag on `LlmRequest` and on
`model_call.finished` (for example `prover.session`, `graph.attempt`, `conjecture.relevance`,
`fidelity.review`), and `harness ablate` reports spend per site.

Deliverables and tests: those of §PC1, in full: `task.created` and `task.status_changed` events in
core with their projection and invariants (only the orchestrator appends them; `done` only when the
acceptance criterion holds), the routing table from M1 failure classes and M6 drift kinds to
`retry_fresh`, `reset_upstream` or `branch`, `harness run --resume <runDir>`, `Llm.completeJson`
with one retry on a schema error, `documentation/ledger.md` and the README diagram.

### Task 16: The `lean.lsp` capability

Where it fits: PC7 of `plans/plan-change-thinking-modes.md`; Ax-Prover's gain (5% to 51% with no training) comes
from these tools. Read first: §PC7, `documentation/capabilities.md` and `lean.md`.

Deliverables and tests: those of §PC7: a capability `lean.lsp` over a pinned lean-lsp-mcp (MCP
stdio), with manifest, contract cases for a Lean host and host profile entries, exposed to provers
by `harness run --tool lean.lsp`. Not run against a real Lean here (`:::wait` in the diagram);
Task 14 measures it as a tool set against M0 with `lean_check` only.

### Task 17: Consortium mode: turns, breakpoints and the team's answer

Where it fits: the user's request of 2026-10-15: a turn-based "consortium" mode in which Seshat
stops on its own after a working time or a token budget set as a parameter, writes an intelligible
account of where its research stands, even unfinished, and spends no token until the human team
has answered. It is merged with PC2 of `plans/plan-change-thinking-modes.md` (optional human breakpoints). It needs Task 15's
resume. Off by default and never in an ablation run, since a turn boundary changes what the models
see. Read first: §PC1 item 4 and §PC2 of the plan change, `documentation/m0-loop.md` (budgets,
report) and `trust.md`.

Deliverables:

1. Turns. `harness run --turn-tokens N`, `--turn-usd N` or `--turn-minutes N`: a limit counted over
   every prover and line of the run, one-shot calls included. When it is reached, no session starts
   and no model call is sent; calls already in flight finish, since their tokens are spent, and
   their sessions stop there with notes and sketch journaled like any interrupted session. The run
   then appends `turn.ended` (turn number, reason, spend in the turn and in the run) and exits:
   nothing waits in memory and nothing is spent until the team resumes it.
2. Breakpoints (PC2): the same stop, earlier, on deterministic events when `--human` is on: an
   impasse (every task of a problem `blocked`, or its posterior below a threshold), a problem
   settled, or two informal validators disagreeing (PC9). A turn limit implies `--human`.
3. The account, `turns/<n>/report.md` and `report.json`, generated from the journal alone with no
   model call, so it costs nothing and says only what the journal holds. A summary first, then one
   section per problem, written for a mathematician who did not follow the run: the problem's status
   and how it got there; claims proved, computed and refuted, with their ids and whether Lean or only
   a tool checked them; the decomposition tree and its open leaves; for each open leaf, the
   strategies tried and how each one failed (M1); counterexamples and obstructions (M11, PC3);
   conjectures with their evidence (M13, M14, when built); what would run next (the ledger's `ready`
   tasks and the fleet's leading strategies); the spend of the turn and of the run, and what is
   left. Records of kinds the report does not know are listed by count. An optional narrative
   written by a model (`--turn-narrative`, off by default) has its own small budget counted in the
   turn, is marked as model-written, and every id it cites must resolve (M6's citation check).
4. The team's answer, journaled with each person's name as actor: `harness hint <runDir> --claim
   ID "text"` (a `hint` node with provenance `human`, shown in that claim's next briefings as a hint
   from the team, never as a fact); `harness sign <runDir> <edgeId>` (the existing `human_signed`
   status, which does not propagate since only `lean_checked` edges do); `harness steer <runDir>`
   (focus on or drop a claim or subgoal, forbid a strategy, set the next turn's limit); and
   `harness resume <runDir>`, which starts the next turn from the journal. Several people may
   answer before one of them resumes.
5. Trust: nothing the team sends changes a claim's status; Lean stays the judge (Global
   Constraint 8).
6. Docs: `documentation/human.md` (the mode, the account, the commands, what an answer can and
   cannot change), `m0-loop.md` (turns and resume), the README diagram (the team as a node, account
   out and answers in) and its caption.

Tests: a turn stops at each kind of limit with no model call after it (the faux model counts
calls); in-flight sessions' notes are journaled; the account built from a scripted journal (ids,
statuses, open leaves, strategies tried); a hint reaching the next session's briefing; a signature
recorded without propagation; a run in three turns reaching the same outcome as an uninterrupted
run with the faux model and the simulated Lean; a turn limit refused by `harness ablate`.

Not in this task: sending the account to the team's chat and taking their answers from it.

### Task 18: Line M15: diversity archive and schemas

Where it fits: PC13 of `plans/plan-change-thinking-modes.md` (ProofEvolve, no training), after Tasks 9 and 10. Read
first: §PC13, `documentation/graph.md`, `library.md` and the scheduler's page (Task 10).

Deliverables and tests: those of §PC13: the archive of alternative decompositions in diversity
cells with fitness from ATMS labels, a `beforeSession` hook choosing the cell a session extends,
schema extraction from closed sub-DAGs into the library, instantiation through `lean.meta`; line
`M15`, inserted after `M3` in `LINE_ORDER`; measured on solves at equal budget, diversity of proof
mechanisms and schema reuse against random retrieval.

Amended by PE1 and PE2 of `plans/plan-change-memory-evolution.md`: schemas and the archive's cell
posteriors carry Task 23's provenance stamp, with its probation on a new epoch; a schema hint shown
to a session goes through Task 23's randomized inclusion, and its effect posteriors, not its
presence, decide whether it stays in use.

### Task 19: Task 8 follow-up: sampled session settings, judgments, anti-sycophancy, informal-first sessions

Where it fits: the parts of `plans/plan-change-thinking-modes.md` that amend Task 8, built after Task 8 merges
and after Task 15 (`completeJson`), before Tasks 13 and 20, which use `judge`. Read first: §PC6, §PC9,
§PC10 and §PC11 of the plan change, `documentation/guards.md` and `fleet.md`.

Deliverables and tests: §PC6 item 1 (each session samples its settings from configured
distributions and records them in `attempt.started`; Thompson sampling learns over the discrete
ones; premise count and rendering join once Task 11 exists); §PC9 (the `judge` helper in
`@seshat/lines`); §PC10 (one fixed anti-sycophancy instruction in M6's framing, no prompt that
shows another agent's verdict, prompt version bump); §PC11 item 1 (the `nl_first` session mode with
its checked step DAG, sampled by the fleet as an arm).

Amended by PE3 of `plans/plan-change-memory-evolution.md`, the soft failure memory, which needs Task
23's config classes (so this task follows Task 23). M1's "already tried" groups attempts by strategy
and by config class (model family, budget class) and says so when a line comes from another class
("2 failures with a smaller model"). The fleet's strategy posteriors are discounted by γ (0.8 by
default, an option) on each new run on a problem (Ruling 28) and shrunk on a new epoch (Task 23).
An exploration floor: a share ε of sessions (0.1 by default) chooses its strategy uniformly among
the allowed labels, ignoring negative memory for that choice only (the session still sees "already
tried"), recorded as `exploration: true` on the attempt. A routing action `retry_stronger` joins
Task 15's table, taken before `branch` when every failure of a claim comes from a config class
weaker than the strongest one configured. Tests: grouping by config class, the discount
arithmetic, the floor's share over a seeded run, the routing case.

### Task 20: The `decide` capability, with an optional Jev backend

Where it fits: J2 to J4 of `plans/plan-change-jev.md`, the user's requirement of 2026-10-16
(delegate some decisions to Jev, TypeSafe AI's decision-only model, set in config; by default the
LLM decides). After Task 15 (site tags, `completeJson`) and Task 19 (`judge`). Read first: the
plan change in full, `documentation/capabilities.md` and `trust.md`.

Deliverables and tests: J2 (the capability with its `llm` default, `jev` and `faux` backends, the
config keys, fallback to `llm` on a missing key or an unreachable host, the 32k refusal,
`decision.made` events, `documentation/decide.md`, which says that proof states go to a third party
when `jev` is on); J3's forbidden list, checked by the capability; the call sites that exist when
this task is built: J3 item 3 (Task 6's `prove.search` orderer) and, at lower priority, J3 item 4
(the fleet's cold start as capped Beta pseudo-counts); J4 (results used only to order until a
site's reliability curve exists). J3 item 2 (the abductive rerank) is dropped with Task 12. Not
run against a real Jev here.

### Task 21: The Lean environment and its resolver, and line M17

Where it fits: LC1 and LC3 of `plans/plan-change-lean-libraries.md`. It also prepares the user's own
Lean host for a real run. Read first: the plan change, `documentation/lean.md` and
`capabilities.md` (host profiles).

Deliverables and tests: LC1 in full (`lean/env/<name>.toml` with the bench project as environment
`base`, `harness lean-env resolve <name>` refusing toolchain or shared-dependency disagreements and
writing `lakefile.toml` and a lock with the environment hash, tested on fixture manifests;
`harness lean-env build <name>`, `:::wait` until a Lean host exists; the environment hash in every
tool run's recorded version, one environment per run; `LEAN_ENV` in host profiles;
`documentation/lean-env.md` and the README diagram); line `M17` (LC3), the same line with an
extended environment against `base` at equal budget, measured in Task 14. The bench stays at
v4.27.0: moving it is the user's call.

### Task 22: The `LibraryBuilder` and the review status of definitions

Where it fits: LC4 and LC5 of `plans/plan-change-lean-libraries.md`; off by default and outside ablations;
low priority, after Tasks 21 and 9. Read first: the plan change, `documentation/library.md`
(Task 9) and `trust.md`.

Deliverables and tests: LC4 (the interface; `none` by default; `coding-agent` running an external
CLI agent non-interactively in a sandboxed worktree of the environment's project, with no harness
key passed by default; jobs `port` and `fill` and their triggers; Seshat's gate: fresh `lake build`,
diff confined to `lean/SeshatLib/<domain>/` or the ported package, the certifier on every new
theorem, the spec's test lemmas proved, provenance journaled; a passing build gives a new
environment version for the next run, never during one; tests with a fake agent script); LC5 (new
definitions are `unreviewed` and may appear in proofs but not in claim statements until
`reviewed`; a wrong definition is deprecated in a new environment version, never edited in place).

### Task 23: Memory across runs, provenance and epochs, randomized inclusion

Where it fits: PE1 and the mechanism of PE2 of `plans/plan-change-memory-evolution.md`, with the
memory that outlives a run which they assume (Ruling 28). Main team; after Task 15, whose resume it
builds on; infrastructure that Tasks 9, 11, 18, 19 and 26 use. Not an ablation line: with no line
enabled and no earlier memory, a run behaves as before. Read first: the plan change in full,
`documentation/memory.md`, `journal.md`, `lines.md`, `fleet.md` and `m0-loop.md`.

Deliverables:

1. Memory across runs (Ruling 28): `harness run --memory-from <runDir>` starts a run on the memory
   of an earlier run, and a chain of runs works the same way. The new run's `run.started` names the
   earlier journal and its last hash; the projection replays the earlier journal, checked against
   that hash, before the new one; nothing writes the earlier journal, and its tool runs and blobs
   stay readable. Verified facts carry over only under the same Lean environment (the bench's
   revision and the Lean toolchain, then Task 21's environment hash); under another, a claim's
   earlier status counts for nothing until a stored proof passes `validate` again in the new run. A
   problem's outcome still comes only from its own certifications in the run (Ruling 23), and the
   report counts what came from the earlier memory.
2. Provenance (PE1 item 1): a `Provenance` record (`modelId` as configured, `promptVersion`,
   `mathlibRev`, `harnessVersion`, `budgetClass`, `createdAt`) on every learned, unverified
   artifact that exists when this task is built (the attempt records that M1's "already tried"
   reads, and the fleet's posteriors through their attempts), the helper that later artifacts use
   (lessons in Task 9, schemas and cells in Task 18, prompts in Task 26), and the config class
   (model family, budget class) that Task 19 groups by. `mathlibRev` is the bench's Mathlib
   revision until Task 21's environment hash stands in for it.
3. Epochs and probation (PE1 items 2 and 3): the projection's current epoch; a new epoch, the event
   `memory.epoch_opened` with its reason, when the prover model family, the prompts' major version
   or the Mathlib revision differs from the memory's previous run; the counters of older epochs
   shrunk toward the prior (Beta(a, b) becomes Beta(1 + (a − 1)k, 1 + (b − 1)k), k = 0.25 by
   default, an option) and earned again under item 4; nothing deleted.
4. Randomized inclusion and effect posteriors (PE2 items 1 and 2, the mechanism): a memory-store
   call that takes the unverified items a line selected for a session and draws each with
   probability `p_new` (0.5) for its first N uses (20), then `p` (0.9), from the run's seeded random
   source, recording `included` and `withheld` on `attempt.started`; and a query that gives an
   item's effect as two Beta posteriors (successes of attempts with it and without it, within one
   claim group and strategy label) and P(effect < 0). A verified fact and the goal are never drawn.
   Tasks 9, 11 and 18 call these.
5. Docs: `documentation/memory.md` (sections "Memory across runs", "Provenance and epochs" and
   "Randomized inclusion"), `journal.md` (the new event and fields), `m0-loop.md` (`--memory-from`)
   and the README diagram (memory carried over from an earlier run).

Tests: a run started from an earlier one sees its claims, nodes, attempts and posteriors, refuses an
earlier journal whose last hash differs, and leaves it unchanged; under another environment, a claim
proved earlier is open until a stored proof validates; a problem's outcome is not credited from the
earlier run; the stamp on each artifact kind; an epoch on each trigger; the shrinkage arithmetic; an
item in probation regains weight only through outcomes; draws reproducible from the seed; posteriors
on scripted outcomes; verified facts never withheld.

### Task 24: The session-frozen packet prefix

Where it fits: PE5 of `plans/plan-change-memory-evolution.md`. Main team; small; before Task 11
(M4, the collaborator's), which compiles its packet through it. Read first: §PE5,
`documentation/lines.md` (`contextPacket`) and `m0-loop.md` (spend and the report).

Deliverables and tests: those of §PE5. `contextPacket` may answer `{ prefix, tail }` (a string keeps
today's behaviour); the prefix of a session's first request is sent unchanged, byte for byte, on
every later request of the session, followed by that request's tail; an option adds to the tail a
short list of what is new since the session started; cache hints go through pi-ai (`cacheRetention`)
where the provider supports them; the report gives cached input tokens (`cacheRead`, already counted
in `budget.ts`) and dollars per solve. Tests, with a test line that gives a packet and pi-ai's faux
provider: the prefix identical across a session's requests, the tail changing, the "new since" list,
the cached tokens in the report. Docs: `lines.md` and `m0-loop.md`. Measured in Task 14 once M4
exists; not run against a real provider here.

### Task 25: Line M18: a curriculum of variants

Where it fits: PE7 of `plans/plan-change-memory-evolution.md`, rung 1 of Task 10's ladder (PE4):
AlphaProof's test-time curriculum without its training. Main team; after Task 10. Read first: §PE7
and §PE4, `documentation/graph.md` (M2's variants, Task 5) and the scheduler's page (Task 10).

Deliverables and tests: those of §PE7. When a problem reaches rung 1, special cases and weakenings of
its target from M2's variant generator (small n, a prime case, an extra hypothesis) become tasks with
a capped share of the problem's budget (20% by default, an option); their proofs, validated and
certified like any other, reach later sessions as proved facts with `special_case_of` edges and as
one or two proof examples in the briefing. Line `M18`, inserted after `M12` in `LINE_ORDER` (Ruling
27). Docs: `documentation/curriculum.md`, `lines.md` and the README diagram. No published evidence
says this pays without updating weights: the line is removed if it does not beat the ladder without
it at equal budget (Task 14). Tests: variant tasks created on escalation, the budget cap, proofs
reaching the next briefing.

### Task 26: Offline prompt optimization (`harness optimize-prompts`)

Where it fits: PE8 of `plans/plan-change-memory-evolution.md`; low priority; after Task 14 and
before the final review; off by default and outside ablation runs. Main team. Read first: §PE8,
`documentation/bench.md` and `trust.md`.

Deliverables and tests: those of §PE8. `harness optimize-prompts --split dev` runs GEPA-style
reflective mutation over the prover's and the lines' prompts on a dev split of the bench, keeping a
Pareto set per problem; a candidate is accepted only if it beats the current prompt at equal budget
on a held-out split and on a temporal holdout (problems newer than a cutoff date). It writes a
branch and a report, and a human merges. It has no write access to the validator, the guards, the
journal's code, the tests or the bench's indexes, and its prompts carry the provenance stamp (Task
23). The splits are part of this task if Task 14 has not made them. Tests with the faux model on a
small simulated bench: the Pareto set, the acceptance rule, the refusal to write anything but prompt
files. Docs: `documentation/prompts.md`. Not run against a real model here.

## Later (not scheduled)

- Problem reformulation as a family of tools (the user, 2026-10-20): turning a problem into a
  sub-problem or a sub-expression, a super-expression or a more general problem, an analogous
  problem, or a problem in higher dimension, since a reformulation can give access to tools that
  solve it. The components that already reformulate are M2's variants with their
  `special_case_of`, `strengthens`, `instance_of` and `derived_from` edges (Task 5), and Task 13's
  conjectures and theory exploration. Not expanded until the core is ready.
- One native tool per major method of Polya's "How to Solve It" (the user, 2026-10-20): the
  long-term target of the tool library. New tools wait until the core is ready.
- Homology detection and the abductive engine (Task 12, lines `M7` and `M9`): suspended by the user
  on 2026-10-20 (Ruling 20). The notes stay; nothing is built.
