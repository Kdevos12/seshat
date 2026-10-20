# Plan change: decisions from "Prompt & Thinking modes for MRsearch"

> Copied into the repository on 2026-10-20 from the project's shared files, with the French quotes
> translated and the model names of the cited papers left out (plan, Global Constraint 13). Task
> numbers are those of [seshat-plan.md](seshat-plan.md).

Written 2026-10-15 by the parallel thread on the user's research document, for the implementation
thread. It amends [seshat-plan.md](seshat-plan.md); where it
contradicts a ruling in [seshat-plan-rulings.md](seshat-plan-rulings.md), it says so. The decision
note behind it, one verdict per decision of the document with sources and numbers, is
`research/revue-thinking-modes.md` (French, in the project's shared files, outside the repository). Read against main at 9e76c43.

Status: **approved by the user on 2026-10-15 at 12:21 UTC** ("I approve, send it back to the implementer").
Written against main at 9e76c43; reconcile task numbers and statuses with main as it is now. Each change names the task it modifies, the
decision of the document behind it, and the adaptation where the original depends on another
architecture or on training. Global Constraints 1 to 15 apply unchanged; in particular nothing
here trains a model, and every new tool is a capability.

## Summary

| # | Change | Task | Kind | Priority |
|---|---|---|---|---|
| PC1 | Execution graph and task ledger, typed error routing, resume, schema-checked model outputs | new Task 15 (before 10 and 11) | infrastructure | high (user: "crucial") |
| PC2 | Optional human breakpoints and progress notes | new Task 17 | option, outside ablations | medium |
| PC3 | Cross-claim negative constraints and `obstruction` nodes | Task 9 (M5), Task 2 follow-up | extends lines | medium |
| PC4 | Inner/outer refinement on sketch lemmas; scored conjecture pool | Task 10 (M12), Task 13 (M8) | extends lines | high |
| PC5 | Retrieval: decomposed queries, accessibility filter, dependency seeds, hybrid fusion, path rendering, `expand` format, widening on failure | Tasks 5, 9, 11 | extends lines | high |
| PC6 | Stochastic diversity: sampled session hyperparameters, multi-cutoff ATP union, goal-level search tool | Tasks 6, 8 | extends lines | medium |
| PC7 | `lean.lsp` capability (lean-lsp-mcp) for provers | new Task 16 | new capability | high |
| PC8 | Program search for scored subgoals (FunSearch) | new line M16, in Task 13 | new line | medium |
| PC9 | Voting and cross-model checks for informal judgments | Tasks 8, 12 | extends lines | low |
| PC10 | Fixed anti-sycophancy instruction; no peer verdicts | Task 8 (M6) | extends line | low cost, do |
| PC11 | Natural-language-first session mode; proof DAG before formalization | Tasks 8, 13 | extends lines | medium |
| PC12 | Tactic mining from our proofs | Task 9 (M3) | extends line | low |
| PC13 | Diversity archive of partial proof DAGs and reusable schemas (ProofEvolve) | new line M15 (new Task 18, after Task 9 and 10) | new line | medium-high |

New lines: `M15` and `M16`. Proposed `LINE_ORDER` (plan §7 execution order) insertions: `M15`
after `M3`; `M16` after `M8`. Cumulative configs follow (Ruling 8).

---

## PC1. Execution graph and task ledger (new Task 15)

Source: MechMath Agent Team (arXiv 2607.04394, §2.1-2.2): a global execution DAG for scheduling
and reactive routing, and a task ledger (ID, Task, Owner, Status) written only by the
orchestrator under deterministic transition rules; errors as typed routing signals (localized
error: fresh copy of the subtask; architectural defect: reset to upstream planning nodes; local
deadlock: new exploratory branch under other constraints); resume from a checkpoint. MetaGPT:
schema-shaped outputs. MAST (arXiv 2503.13657): step repetition (15.7% of failures) and ignored
stopping conditions (12.4%) are the top system-design failures.

Adaptation: MMAT reports no ablation, so this is infrastructure, not an ablation line. Its DAG is
over *work*; Seshat already has a DAG over *mathematics* (claims, `decomposes_into`). The ledger
references claims and never duplicates their status: a task's acceptance criterion is stated in
terms of claim and edge statuses.

Deliverables (package `@seshat/ledger`, or `@seshat/scheduler` if the implementation thread
prefers one package; the events belong in core):

1. Events: `task.created` (`taskId`, `kind` one of `prove`, `refute`, `formalize`, `battery`,
   `search`, `compute`, `abduce`, `induce`, `repair`, `review`; `claimId?`, `edgeId?`,
   `dependsOn: taskId[]`, `owner` (a prover id or a line id), `acceptance` (a typed criterion,
   e.g. `{claim, minStatus: "computed"}` or `{edge, status: "lean_checked"}`), `budget`, `parentTaskId?`),
   `task.status_changed` (`pending` → `ready` → `running` → `done` | `failed` | `blocked` |
   `cancelled`, with `reason` and, for `blocked`, `blockedBy`). Projection table. Journal
   invariants: only the orchestrator appends task events (lines *propose* tasks through their
   context; the orchestrator commits them); a `running` task has an owner; a `blocked` task names
   what blocks it; `done` only when the acceptance criterion holds in the projection.
2. With no line enabled, M0 records one `prove` task per prover, so the ledger costs nothing and
   M0's behavior is unchanged (existing tests pass as they are).
3. Typed error routing: a table from M1 failure classes and M6 drift kinds to one of three
   actions: `retry_fresh` (new session on the same task: syntax, type mismatch, timeout),
   `reset_upstream` (re-decompose the parent: statement changed, aux lemma restating the target,
   a subgoal refuted), `branch` (create an alternative task under other constraints: strategy loop,
   stagnation; this is where M7 and M14 plug in). Each routing decision is an event with its reason.
4. Resume: `harness run --resume <runDir>` rebuilds the ledger, budgets and claim states from the
   journal and continues the `ready` and interrupted `running` tasks with the remaining budget.
   (Nothing resumes a run today. The account's usage limit makes interruptions routine.)
5. `Llm.completeJson({schema, ...})` in the line API: a schema-validated JSON answer with one
   retry on a validation error, for every line's one-shot model calls.
6. Task 10 (M12) selects among `ready` tasks instead of keeping its own queue; Task 8's fleet
   policy assigns owners. Both tasks are not started, so they take this in their briefs.
7. Docs: `documentation/ledger.md`; `lines.md` (`completeJson`, proposing tasks); `m0-loop.md`
   (`--resume`); README diagram: the ledger as a built node between the orchestrator and the
   provers.

Tests: transitions and invariants (a `done` with an unmet criterion is refused); M0 run records
one task per prover; routing table cases; a run killed mid-problem and resumed reaches the same
outcome with the faux model and simulated Lean, and spends no more than the remaining budget;
`completeJson` retry.

## PC2. Optional human breakpoints (new Task 17)

Source: MMAT augmentation plane (breakpoints after success and at impasse; a human-readable
progress note with milestones, blocking points, context; hints ingested and execution resumed
from the checkpoint). Tsaneva et al. 2025: sending only the items where validators disagree
(about 12%) to a human gives +5 F1; LLM-only validation was below the baseline. The user wants
semi-automatic use as an option.

Adaptation: off by default and never in an ablation run. Triggers are deterministic: every task
of a problem `blocked` or its posterior below a threshold (impasse), a problem settled (success),
or two informal validators disagreeing (PC9).

Deliverables: `--human` run option; at a breakpoint the run pauses (resumable through PC1) and
writes `progress/<problem>.md` generated from the journal only (proved subclaims with ids, open
leaves with their "already tried" summaries, obstructions, budget left). The human answers with
`harness hint <runDir> --claim C17 "text"` or `harness sign <edgeId>`; a hint is a `node.recorded`
of kind `hint` with provenance `human`, shown in the briefing of that claim's next sessions; a
signature uses the existing `human_signed` edge status. Docs: `documentation/human.md`.

Tests: the note's content from a scripted journal; pause and resume; a hint reaching the next
session's first message.

## PC3. Cross-claim negative constraints and obstructions (Task 9 and a Task 2 follow-up)

Source: MMAT stratified continual memory ("distills recurring reasoning errors into cross-session
negative constraints") and its `Obstruction` card type (dead ends, structural anomalies, logical
conflicts).

Adaptation: M1's negative memory is per claim; M5's lessons are scoped but come from prose.
Missing: constraints distilled from failures that recur across claims, and a typed record of why
an approach cannot work.

Deliverables:
1. Task 9 (M5): lessons gain `kind: "constraint"`. Trigger, deterministic: the same failure class
   with the same normalized detail on at least N attempts across at least 2 claims (N an option,
   default 3). Then one `completeJson` call distills a one-line constraint ("Nat subtraction
   truncates: state bounds before subtracting"), stored with its supporting attempt ids and the
   same counters and deactivation as other lessons.
2. Node kind `obstruction` (`claimId`, `strategy?`, `reason` typed: `counterexample`,
   `refuted_premise`, `nogood` (from ATMS), `statement_mismatch`), recorded by M2 when a lemma a
   strategy relies on is refuted and by M11 when a counter-model kills a subgoal; shown in M1's
   "already tried" section as one line.

Tests: trigger thresholds; a constraint's counters; obstruction lines in "already tried".

## PC4. Lemma-first refinement and a scored conjecture pool (Tasks 10 and 13)

Source: Seed-Prover (arXiv 2507.23726): lemma-style proving; light mode (8 to 16 refinements with
Lean errors and a self-summary, about the cost of whole-proof Pass@64-256); medium mode (an outer
loop on the theorem, an inner light loop with an 8×8 budget on each lemma the outer loop fails to
prove, proved lemmas fed back to the outer prompt); heavy mode (a conjecture pool, each conjecture
proved or disproved, a lemma pool scored by proof rate, LLM-judged relevance and proof length,
low-relevance or short-proof lemmas pruned).

Adaptation: Seed-Prover's prover is RL-trained to use exactly this context; with API models expect
less, so each part is measured. Our pools already exist as claims with statuses.

Deliverables:
1. Task 10 (M12): when a session ends with unproved `aux_` lemmas, each becomes a claim (already
   planned) *and* a `prove` task with a small inner budget (default 8 sessions); a lemma proved
   inside is fed to the outer prover's next briefing as a proved fact with its name. Options: inner
   budget, max inner tasks per outer session.
2. Task 13 (M8): a target-centred conjecture pool: a model call proposes 10 to 50 properties of the
   target's objects without committing to an approach; each is an `open` claim with a
   `derived_from` edge and goes through the twin; proved ones are scored by (proof rate, relevance
   judged by a model with PC9 voting, proof length) and the low ones pruned before they enter the
   briefing. Pool size is an option; the default is small (our budget is far below Seed-Prover's).

Tests: inner tasks created and their result reaching the outer briefing; pool scoring and pruning
with the faux model.

## PC5. Retrieval and rendering (Tasks 5, 9 and 11)

Sources: LemmaHead (raw-statement RAG hurt: 2.5% vs 9.0% without; extracted concept queries 27.6%;
iterative re-query from the draft 32.4%, miniF2F, a 2023 frontier model); DRIFT (decomposed sub-queries double
retrieval F1, but hurt low-dependency problems); LeanDojo (accessibility filter); Ataeva et al.
2026 (regex seeds and Mathlib dependency neighbours: hard-subset pass@1 3.56% → 10.42%, p = 0.001;
no gain on the full set); KG-Prover (widen neighbourhood on failure); GNN-RAG (shortest typed
paths, one chain per line, 150 to 500 tokens); Paths-over-Graph (code-side multi-anchor path
search, depth ≤ 3); Search-on-Graph (markdown table, half the tokens of JSON; hub nodes return
relation types first); KnowledgeNavigator (merging edges by (head, relation): +6.4 points);
SubgraphRAG (strong models gain from more triples, weak ones lose); ELMK (path diversity by
clustering); Bruch et al. (convex combination of normalized scores beats each channel on 9/9
datasets; RRF does not).

Deliverables:
1. Task 11 (M4), candidate premises: (a) query extraction: one `completeJson` call per session
   turns the goal (and, from the second session on, the current sketch) into concept queries and
   likely Lean names; retrieval runs per query, never on the raw statement alone; (b) an
   accessibility filter from the problem's header; (c) a pattern-seed channel: a table of goal
   features (operators, `Finset`, divisibility, `%`, etc.) to Mathlib seed declarations, then their
   dependency neighbours through `lean.meta premises` or TheoremGraph's LeanGraph, rendered as hints
   grouped by use (`apply`/`exact`, `rw`, `simp`, definitions); (d) after each failed session on a
   claim, neighbourhood depth +1 for the next one. (a) and (c) are switchable and measured, since
   both hurt easy problems in their papers.
2. Task 9 (M3) and Task 11: hybrid ranking of library and premise candidates by a convex
   combination of min-max normalized BM25, vector and PPR scores (weights an option); it must beat
   the best single channel on the bench or the single channel stays.
3. Task 5 (M2) `graphQuery` and Task 11 rendering: a `connect` mode returning the paths that link
   all given anchors (bidirectional BFS, depth ≤ 3); paths scored by PPR, clustered, top per
   cluster. Renderings added to the A/B set already planned (plan §13): arrow chains one per line,
   arrow chains merged by (head, relation), markdown table. Default graph budget per model: about
   100 edges for small models, 200 for frontier models, then tuned.
4. Task 11 `expand(id, kind?)`: markdown table; a node with more than 50 neighbours returns its
   relation kinds with counts, and the model calls again with `kind`.

Measured (added to Task 14's table): tokens and solve rate per rendering and per model; extracted
queries vs raw statement; pattern seeds on vs off, split by problem difficulty.

## PC6. Stochastic diversity against entrenchment (Tasks 6 and 8)

Sources: DeepHOL (arXiv 1905.10501: each prover run samples its own search hyperparameters;
premises mix learned and tf-idf streams; tf-idf alone still reaches 43%); DeepMath (union over
models and premise cutoffs 80.9% vs best single 67.9%); BFS-Prover (length-normalized best-first,
α varied across runs); Lean Copilot (LLM tactics inside aesop's search). The user's note: these
give "combinatorial and stochastic strength to a machine that tends to entrench in a context".

Adaptation: their learned rankers need training; the stochastic levers do not.

Deliverables:
1. Task 8 (fleet): each session samples its hyperparameters from configured distributions
   (temperature, thinking level, premise count, rendering, a random diversity directive as in
   Nexus, session mode of PC11) and records them in `attempt.started`; Thompson sampling learns
   over the discrete ones like over strategies.
2. Task 6 (M10): ATP and hammer calls run at several premise cutoffs (e.g. 16, 64, 256) with
   premises mixing the selector's choice and a BM25 stream, in parallel, and keep the union of
   successes; the cutoffs are an option.
3. Task 6: a capability `prove.search` (goal-level best-first search through `lean.goals`): per
   goal, one model call proposes k tactics (or aesop runs with them as rules); node score = rank
   score normalized by depth^α with α sampled per run from {0, 0.5, 1}; budget in nodes. Measured
   against whole-proof sessions at equal dollars; removed if it loses.

## PC7. `lean.lsp` capability for provers (new Task 16)

Source: Ax-Prover (arXiv 2510.12787): a general frontier model with lean-lsp-mcp tools and no training
goes from 5% to 51% on NuminaMath-LEAN, 8% to 64% on AbstractAlgebra; most used tools: edit,
diagnostics, goal, loogle, leansearch; about USD 4 per problem. Its loop (sketch, `have ... :=
sorry`, fill holes, a verifier that never edits) is our M0.

Deliverables: capability `lean.lsp` over lean-lsp-mcp (MCP stdio, pinned version), exposing to
provers: goal at a position, term goal, diagnostics, multi-attempt (several tactics at one
position), Loogle, LeanSearch, state search, hammer premises; manifest, contract cases for a Lean
host, host profile entries; `harness run --tool lean.lsp`. Not run against a real Lean here
(`:::wait`). Measured as a tool set against M0 with `lean_check` only. It also gives provers the
Loogle and LeanSearch tools that plan §13 and the tool library already name.

## PC8. Program search for scored subgoals: line M16 (in Task 13)

Source: FunSearch (Romera-Paredes et al., Nature 2024): an evaluator scores programs; a database
split into islands, programs clustered by score signature, sampling biased to high scores and
short programs, prompts with 2 programs sorted by score, periodic reset of the worse half of
islands. No training. Cap sets n = 8: 512 vs 496.

Adaptation: Lean gives pass/fail, not a score. M16 applies only to subgoals that carry a
computable score: constructions and witnesses (size of an object meeting constraints), bounds,
counterexample search (distance to violating the statement). The task declares a scoring program
(sandboxed JavaScript or Sage through `compute.sage`); a found witness becomes a claim settled by
`decide` or a Lean proof through `validate`, never by its score.

Deliverables: `@seshat/induction` (or a new package `@seshat/evolve`): the program database
(islands, signatures, length bias, resets; all parameters options, defaults small for our budget),
the prompt builder, sandboxed evaluation with time limits, events for programs and scores as
nodes; line `M16` triggered on tasks of kind `search` with a scoring program. Docs and README
diagram.

Tests: sampling and reset with a seeded random source; a faux-model run that improves a toy score
and submits the witness to the simulated Lean.

## PC9. Voting and cross-model checks for informal judgments (Tasks 8 and 12)

Sources: self-consistency; KnowledgeNavigator (weighted votes over question variants); MMAT
cross-model verification; Tsaneva et al. (escalate on disagreement).

Deliverables: a helper in `@seshat/lines`, `judge({prompt, k, models?})`: k independent calls
(different models when configured), majority or mean, and a `disagreement` flag. Used by the
abductive reranking (Task 12), the relevance score of PC4 and the statement-fidelity review; a
disagreement on fidelity triggers PC2's breakpoint when `--human` is on, otherwise the claim
stays unsigned. Never used for anything Lean can decide.

## PC10. Anti-sycophancy instruction (Task 8, M6)

Sources: arXiv 2604.00478 (a plain "be truthful, disagree when warranted" system instruction cuts
sycophancy from 9.6% to 2.1% on one frontier model and 46.0% to 8.5% on a smaller one; the
paper's dynamic gating did worse than the plain instruction on the smaller one); arXiv 2604.02668 (seeing
peers' answers propagates sycophancy).

Deliverables: M6's neutral framing adds one fixed instruction to every prompt that judges or
reranks (and to the prover's prompt for open conjectures): the statement may be false, a
counterexample is as valuable as a proof, do not defer to how the task is phrased. No prompt shows
a model another agent's verdict; where a reliability prior is needed, it is the Lean-verified
track record from the journal. Prompt version bump.

## PC11. Natural-language-first mode and proof DAGs (Tasks 8 and 13)

Sources: MathCoPilot (arXiv 2607.14582: NL-first 6-7/21 vs formal-first 3-4/21 on a FormalMATH
subset with frontier models); DSP (informal proofs +5.3 points, automated closer +9.0); ProofFlow
(arXiv 2510.15981: DAG of steps checked for cycles and forward references, each node a standalone
lemma with `sorry`; ProofScore 0.545 vs 0.123 for whole-proof formalization); MMAT's NL-prover ↔
FL-prover feedback loop.

Deliverables:
1. A session mode `nl_first` (Task 8 samples it as an arm, PC6): the session first writes an
   informal proof and a step DAG (`completeJson`: nodes with statements and dependencies), the
   orchestrator checks the DAG (acyclic, no forward reference, every node used), then the prover
   writes the sketch with one `aux_` lemma per node; the DAG is stored as a node and its steps as
   claims with `decomposes_into`, so PC4's inner loops and propagation apply. Lean errors on a node
   go back to that node only.
2. Task 13: hypotheses and repairs that arrive as informal text go through the same DAG step
   before formalization; ProofScore's dependency-match term is recorded as a fidelity measure.

## PC12. Tactic mining (Task 9, M3; low priority)

Source: TacMiner (OOPSLA 2025): tactics mined from a proof corpus by tactic dependence graphs;
corpus 26% shorter; with mined tactics in context Copra proves 30/50 vs 11/50, on 50 hand-picked
Coq theorems (weak evidence).

Adaptation: provers may not define macros (M0 forbids syntax extensions). Mined patterns (repeated
tactic subsequences in our proved proofs, by a simple frequent-subsequence count, no learned
grammar) go either into the library section as text patterns, or into `lean/HarnessLib/Tactics.lean`
as macros written by the library task (trusted, certified like other library code). Build only
after M3's measurements show library use.

## PC13. Diversity archive and schemas: line M15 (new Task 18)

Source: ProofEvolve (arXiv 2608.26334, no training, a frontier model): per problem, partial AND/OR
proof DAGs in a MAP-Elites archive keyed by (depth bin, dominant tactic family, schema region); a
challenger replaces a cell only with higher verified-closure fitness ρ (share of the DAG closed by
the kernel, monotone); the model proposes decompositions, repairs and recombinations, each checked;
closed sub-DAGs extracted as typed schemas into a cross-problem library, instantiated at matching
goals with leftover premises as subgoals. PutnamBench 71.2% vs LEAP 64.7%; schema library 49.5%
→ 53.4% on 744 held-out theorems, random retrieval from the same library 49.6%. Budget per target:
12 model calls, 60 Lean calls, 400K tokens.

Adaptation: our claims and `decomposes_into` edges already are the AND/OR DAG and ATMS labels give
ρ. What is new is keeping several alternative decompositions alive in diversity cells instead of
one best-first frontier, and reusing closed sub-DAG shapes.

Deliverables (`@seshat/scheduler` or a new package, after Tasks 9 and 10): the archive (cells,
fitness from labels, replacement rule); a `beforeSession` hook choosing which cell's DAG a session
extends (Thompson over cells); schema extraction from closed sub-DAGs (the statements' skeletons,
anti-unified with Task 12's code when available) into the library with their own index;
instantiation through `lean.meta` instances. Line `M15`. Measured: solved at equal budget,
diversity of proof mechanisms (plan §6), schema reuse rate against random retrieval.

---

## What this does not change

- Lean as the only judge, statuses and Global Constraint 8; no debate; orchestrator as the only
  writer; no model training (CPO, PRMs, GNN-RAG, RRP, GRIL, KG-Agent, GraphMind, Graph2Tac, TRAIL,
  BFS-Prover's DPO, Explore-on-Graph are rejected for that reason; see the decision note).
- Rulings 1 to 18 stand. PC1 asks Task 10 to use the ledger instead of its own queue (Task 10 is
  not started); no merged task needs rework.

## Suggested order

Wave 2 becomes: Task 15 (ledger, PC1) and Task 16 (`lean.lsp`, PC7) first, in parallel (disjoint
packages: core events + new package vs a capability); then Tasks 10 to 13 with PC3 to PC6 and PC8
to PC11 in their briefs; Task 17 (human) and Task 18 (M15) after; Task 14 last, with the added
measurements. Tasks 6 and 8 are in progress: PC6 and PC10 can ride them now or follow as a small change after they merge, at the implementation thread's choice.
