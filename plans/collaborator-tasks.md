# Seshat: the collaborator's part of the plan

Tasks 6 (line M10), 9 (lines M3 and M5) and 11 (line M4). Written on 2026-10-20 by the main team for
the collaborator's agents (Ruling 25); updated on 2026-10-27 for the plan change
[plan-change-memory-evolution.md](plan-change-memory-evolution.md) (Rulings 27 and 28). The main team keeps this file in step with
[the plan](seshat-plan.md); where the two differ, the plan wins, and you say so in your log.

## 1. What you build

Seshat runs language-model provers on open problems stated in Lean. The base loop, M0, is the
AlphaProof Nexus baseline on pi: independent provers in sessions, each session editing a Lean file
and checking it with `lean_check`, passing its notes to the next. Everything else comes as a *line*,
a mechanism a run switches on (`harness run --lines M1,M10` or `--ablation M10`), so that each is
measured against the run without it at equal budget; a line that does not beat the previous one is
simplified or removed.

Your three tasks are four lines:

- **M10** (Task 6): classical tools before any model. For the target and each subgoal, a battery
  of Lean tactics run in parallel, a router that sends decidable fragments to their decision
  procedure, and ATP and SMT with reconstruction in Lean. The research notes call it the cheapest
  gain.
- **M3** and **M5** (Task 9): a lemma library that grows across problems (proved auxiliary lemmas,
  promoted, indexed, searched before Mathlib), and lessons with counters that outcomes update.
- **M4** (Task 11): the context compiler. Each model request gets a deterministic packet, compiled
  from the memory under a token budget, in place of the accumulated conversation.

The main team builds the other tasks at the same time ([the ledger](seshat-plan-ledger.md)). The
repository is the only channel between you: [CLAUDE.md](../CLAUDE.md).

## 2. Read first

Once, in this order:

1. [CLAUDE.md](../CLAUDE.md): branches, who writes what, when a task is done.
2. [README.md](../README.md) and [documentation/README.md](../documentation/README.md), then the
   pages architecture, trust, journal, memory, lines, m0-loop, capabilities, validator, lean,
   lean-meta, graph, m1-identity-memory, guards, fleet and development. `lines.md` (the line API
   and its hooks) and `memory.md` (the memory store) are the two interfaces you build on.
3. [The plan](seshat-plan.md): the goal, the Global Constraints (they bind you exactly as they bind
   the main team), "Interfaces every task shares", Tasks 6, 9 and 11, and the plan-change sections
   those tasks name (listed below for each task).
4. [The rulings](seshat-plan-rulings.md): all of them bind you. The ones you will meet most: 3, 5,
   8, 13 (amended), 14, 16, 20, 22, 23, 25, 26, 27 and 28.
5. This file. The research notes behind your tasks are in French and stay outside the repository;
   the digests below give you what they say, with their numbers and sources.

At the start of every later session: CLAUDE.md, "Every session".

## 3. How you work

- **Order.** Task 6, then Task 9, then Task 11. Task 9 uses Task 6's battery as its
  non-triviality test; Task 11 ranks Task 9's library lemmas and shows its lessons. You may start
  the next task on its own branch while the previous one is in review.
- **Branches.** `task/t6`, `task/t9`, `task/t11`, each from the latest `main` and pushed with
  every commit. You merge into `main` yourself when a task is done (CLAUDE.md, "Branches,
  commits, merges" and "Done").
- **Your log.** [collaborator-log.md](collaborator-log.md) is yours: the state of your tasks, your
  decisions (Decision C1, C2...), your interface changes, questions for the main team, and what
  ran for real. Update it whenever a task changes state. A commit that changes only your log may
  go straight to `main` (pull first), so that the main team sees the change before your merge.
- **Process.** How your agents work is your choice. The main team's practice, which works here:
  one implementer per task; then a review by a fresh agent that did not write the code (first
  "does it do what the task says, all of it and nothing else", then code quality, with the Global
  Constraints, trust rules first); a fix round; a re-review of the fixes; the merge. The review is
  required (CLAUDE.md, "Done").
- **Decide, do not wait.** Where the plan is silent, choose what fits it and record the decision
  in your log (Ruling 5). A question for the owner goes in your log under "For the main team", and
  you continue with your default meanwhile.
- **Real programs.** If your machine has Lean 4 v4.27.0 with the bench's Mathlib (the
  formal-conjectures tag `bench-v1-lean4.27.0`, documentation/lean.md), or z3, Vampire or cvc5,
  run what the contract tests and the `:::wait` parts allow (`pnpm harness contract <id>`) and
  write the results in your log under "Runs against real programs". `pnpm test` must still need
  none of them. Nothing has run against a real Lean yet: your results would be the first.

## 4. Rules you will meet in these tasks

- **Status integrity.** A line raises a claim's status only through `validate`, which submits a
  Lean proof of the claim or of its negation: a battery success, an SMT answer reconstructed as a
  Lean proof and a library lemma applied all go through it. A tool's answer without a Lean proof
  is a `computed` edge or an evidence node (Ruling 13, amended), never a status. `proved` and
  `refuted` come only from the certifier's kernel replay (Task 4; Rulings 22 and 23 say how a
  problem's outcome follows). Lowering a status goes only through `memory.retractClaim` (Ruling
  16), which only M2 calls.
- **References come from the journal.** The file a validation is compared with is built from the
  claim's journaled statement and header (Ruling 14). Build your Lean snippets the same way
  (`memory.referenceFor(claimId)` and the claim's `header`), never from text a model wrote.
- **A problem's header is fixed.** A prover's file keeps the reference's imports, and `import` is a
  forbidden token in the editable regions; auxiliary lemmas go in the auxiliary region, named
  `aux_...` (documentation/validator.md). This shapes how a library lemma reaches a proof (Task 9).
- **Every tool through the registry.** Call capabilities through the context's `registry`, with
  `actor: "line:<id>"` (and the attempt, inside a session), so that every call is a tool run in
  the journal. An external program is a capability: a manifest in `capabilities/<id>/`, a
  `contract.json`, implementations behind the registry (MCP or process), entries in
  `config/hosts/*.json`, and a clear "unavailable" when it is absent (documentation/capabilities.md;
  `compute.sage` is the worked example, documentation/compute.md).
- **The journal is the truth.** Posteriors, indexes and counters are rebuilt from the journal
  (events, nodes, tool runs) when a run starts, never kept only in memory or in a file outside it.
  A node kind belongs to the package that writes it, which documents the shape of its `data` on its
  page (documentation/memory.md, "Nodes").
- **Tests without Lean, model or network.** The simulated Lean
  (`packages/orchestrator/test/m0-helpers.ts`), pi-ai's faux provider, the fake MCP server, offline
  fixtures. A test that needs a real program (z3) runs only when it is present and says how to run
  it (documentation/development.md, "Tests that use real data").
- **Lines and hooks.** `LINE_ORDER` (`packages/lines/src/ids.ts`) is M1, M10, M2, M11, M12, M4, M6,
  fleet, M3, M7, M8, M13, M14, M5, M9: hooks run in that order, and the cumulative ablation configs
  follow it (Ruling 8; M7 and M9 are suspended, Ruling 20); Tasks 18, 13 and 25 will insert `M15`
  after M3, `M16` after M8 and `M18` after M12. Register each line in
  `packages/orchestrator/src/lines.ts`. The hooks and when they run: documentation/lines.md.
- **The fleet runs before M3 and M5.** Do not skip or stop a session from their `beforeSession`:
  by then the fleet has allocated it, and a later skip leaves its allocation counted (an open
  finding of the Task 8 review, in the ledger's log; Task 14 composes the lines).
- **One packet.** At most one enabled line gives `contextPacket`, and that is M4. With Task 24, its
  answer is a prefix frozen for the session and a tail for each request.
- **Learned memory** (Global Constraint 16). A lesson, a posterior or any other artifact learned
  from outcomes rather than from Lean is unverified: it carries the provenance stamp of Task 23 and
  never becomes a fact. Nothing writes skills from the agent's own experience; at most 3
  human-written skills are loaded in full in a session (an option), the others listed by name and
  description. Text from an external source (a paper, a web page, a database entry, a tool's output)
  keeps its provenance and never becomes a lesson or part of a system prompt.
- **Prompts** you write are in English and neutral ("determine whether", not "prove that", for an
  open statement; documentation/guards.md), and every id a model may cite must resolve.
- **No concrete model id** in a repository file; examples say `PROVIDER/ID`.

## 5. Task 6: line M10, the classical battery, the domain router, ATP and SMT

**The plan:** [seshat-plan.md](seshat-plan.md), Task 6. Amended by PC6 items 2 and 3 of
[plan-change-thinking-modes.md](plan-change-thinking-modes.md) (ATP and hammer calls at several
premise cutoffs with a BM25 stream, keeping the union of successes; the `prove.search` capability,
measured against whole-proof sessions at equal dollars and removed if it loses) and J3 item 3 of
[plan-change-jev.md](plan-change-jev.md) (`prove.search` orders the candidates that come without a
model call through an injectable orderer). If the level-2 namespaces of the digest below come with
human-written skills, Global Constraint 16 (PE6 of
[plan-change-memory-evolution.md](plan-change-memory-evolution.md)) bounds them: at most 3 loaded in
full in a session, the others listed by name and description.

**What exists to build on.**

- `lean.check` (Kimina Lean Server: batches of snippets) and `lean.goals` (Pantograph: per-goal
  states, a sketch's goals), with the typed client `LeanGoals` in `@seshat/lean-meta` and its
  simulated implementation for tests (`packages/lean-meta/src/simulated.ts`).
- `@seshat/classical`: an empty package with its dependencies in place. Your code goes there.
- Beta posteriors and Thompson sampling in `@seshat/fleet` (`beta.ts`, `choose.ts`, and a seeded
  random source in `random.ts`): reuse them for the battery's order.
- The capability registry with process and MCP implementations (`packages/registry`).
- M1's typed negative memory: `memory.alreadyTried(claimId)` and its rendering
  (`packages/orchestrator/src/m1.ts`).

**Decisions made for you** (change one only with a recorded decision):

- A battery success is a submission through `validate`. A failure is recorded as typed tool runs,
  and the line's briefing tells the provers what was tried and how it ended ("already tried:
  omega, linarith, hammer, failed in 12 s").
- Tactics that need a package the host's Lean may lack (`canonical`, LeanHammer's `hammer`,
  Duper's reconstruction) are offered only when the host says it has them. Task 21 (main team)
  will describe each Lean environment's packages; until it merges, read their availability from a
  host-profile option that defaults to off.
- `smt.z3` and `atp.vampire` are capabilities with process implementations. z3 comes from PyPI's
  `z3-solver`, which can be installed for a real test; Vampire stays untested where it is absent.
  Read the SZS status and the exit code, never the prose of the output.
- `prove.auto` gives the provers the level-1 tool `prove_auto` (the battery on a goal they name).
- The orderer of `prove.search` is a plain function the line takes as an option, defaulting to the
  posterior order. Task 20 plugs `decide` into it: whichever of Tasks 6 and 20 merges second does
  the wiring.
- Export a non-triviality test, "do the battery's cheapest tactics close this goal within this
  CPU budget", usable without the line being on: Task 9 uses it, and so will Task 13.

**Research digest.** From `outils-classiques.md` §1 to §4, §10 and §12, `bibliotheque-outils.md`
§1 and §3, and plan §15 and §16.

*The rule: an untrusted oracle, a certificate, a trusted checker.* Who finds a proof does not
matter; only a small kernel checks it (the de Bruijn criterion, the LCF tradition). It works with
Lean today: `bv_decide` reduces a goal to a SAT instance that CaDiCaL (shipped with Lean) refutes,
checks the LRAT certificate in Lean and builds a proof by reflection; polynomial tactics let
SageMath or SymPy compute (Gröbner bases, ideal membership) and Lean check the result (Mathlib's
`polyrith` with `linear_combination`); flag algebras in Lean treat an SDP solver's output as
candidate data and recompute it exactly over the rationals. A real trap: in the Equational
Theories Project, a variable-naming subtlety of Prover9 led to a wrong announcement that the last
open implication was proved. So every ATP answer goes through reconstruction (Duper) or Lean
before it is a fact.

*The battery, per subgoal, before any model:*

| Tactic | What it closes | Numbers |
|---|---|---|
| `decide`, `norm_num`, `simp`, `ring`, `field_simp` | computation, normalization, ring identities | |
| `omega` | Presburger arithmetic over ℕ and ℤ | |
| `linarith`, `nlinarith`, `positivity`, `polyrith` with `linear_combination` | linear inequalities (Farkas certificate), products of hypotheses, positivity, polynomial identities through Sage | |
| `aesop`, `grind` | rule-based proof search; SMT-style reasoning on an e-graph | Aesop alone: 24.1% of Mathlib's test set |
| `exact?`, `apply?`, `rw??` | indexed search in the library | |
| `canonical` (arXiv 2504.06239) | exhaustive type inhabitation, no model | Natural Number Game: 62/74, against 27 for Aesop and 45 for Duper, in 51 s in all; Canonical-min (arXiv 2603.01463), complete, 185 lines, 31/31 on DTTBench |
| `hammer` (LeanHammer, arXiv 2506.07477) | Aesop, lean-auto, Zipperposition and Duper's reconstruction | 30.1% alone, 37.3% in combination |
| QuerySMT (arXiv 2601.14495), Lean-SMT (arXiv 2505.15796) | cvc5, with the solver's hints proved by `grind` and reconstruction by Duper | at 30 s: Int 840/2,058 against 541 for `grind`; Nat 892/3,270 against 812; List 749/4,576 |
| `bv_decide` | bit vectors, Booleans (checked LRAT) | |
| `plausible` | counterexamples by random testing: it refutes, never proves | |

What the hammers taught (Blanchet et al., "Hammering towards QED"): premise selection is the first
factor (raw E proves about 2% of large Mizar problems, 14% to 15% with SInE); ensembles and time
slicing pay (an even mix of two selectors gains about 10%, and hammer servers run 14 complementary
methods in parallel); superposition provers lose efficiency fast with time, so several short tries
beat one long one; and iterating "prove, then learn" adds about 16% more proofs.

The design: on each new subgoal the orchestrator runs the battery in parallel, with short time
limits, and stops at the first success. Every try is a tool run (goal class, tactic, version,
outcome, time). The battery's order and budget come from Beta posteriors per (goal class, tactic),
which is the hammers' strategy scheduling learned online by counting, with no training. The
prover sees what the battery tried and does not redo it. The cost is CPU: lean-auto takes about
0.8 to 1.1 s per solved problem against 0.09 s for Aesop, and LeanHammer's whole pipeline 6.6 s on
average, so with thousands of subgoals the posterior ordering is what keeps the battery
affordable. In lean-auto only Duper's results are reconstructed; the other backends are taken on
trust, so their answers stay `computed` until reconstructed.

*First-order provers and finite models.* Vampire won all eight CASC divisions in 2025 and 78 CASC
titles since 1999; version 5.0 (September 2025) is reported to prove every true implication of the
Equational Theories Project (over 8 million), 99.97% of them in under 500 instructions. Prover9
and Mace4 (McCune, unmaintained since 2009) still complement it: on about 770 TPTP problems, 60%
are solved by both, 20% only by Vampire and 20% only by Prover9, and Mace4 finds finite models
faster (on one ETP problem it exhausted size 8 in 1.5 s and found a size-9 model in 16 s, where
Vampire's model finder failed after 10 minutes). Usage advice from the same guide: run several
configurations, give enough memory and cores, and read the SZS status and exit codes, never the
output text. Others: E, iProver, Zipperposition (higher order, used by LeanHammer), cvc5 and Z3
(SMT). Use them on anything with a first-order encoding (algebra, equational laws, orders,
combinatorial definitions), translated from Lean (as lean-auto does) or written directly in TPTP.
Research problems rarely fit whole in first order, and translation loses (higher order, dependent
types), but subgoals and equational conjectures often do fit.

*SAT, SMT and decision procedures.* Cube-and-conquer (Heule) settled the Boolean Pythagorean
triples problem (35,000 CPU hours to solve and 16,000 to verify, on 800 cores); SAT+CAS (MathCheck)
did R(3,8) in 59 hours against over 7 days for SAT alone. Decision procedures: Presburger
(`omega`); linear arithmetic (simplex, Fourier-Motzkin, `linarith`); nonlinear real arithmetic
(cylindrical algebraic decomposition, doubly exponential, and NLSAT in Z3); Walnut, first-order
logic over automatic sequences (it re-proved Thue's 1912 results on Thue-Morse and corrected a
published formula; its results are not certified in Lean, so `computed` unless reproduced); and
for geometry Wu's method, Gröbner bases and the area method. The design is a domain router: it
recognizes that a goal lies in a decidable fragment and sends it to the right procedure (Presburger
to `omega`, linear real arithmetic to `linarith`, finite domains to `decide`, polynomial identities
to `ring` or Gröbner, real inequalities to NLSAT or sums of squares, finite combinatorics and bits
to SAT, automatic sequences to Walnut), with a certificate when one exists. Decidable fragments are
narrow, and a SAT encoding must itself be verified. Task 6 needs the Lean-side routes and z3; the
external procedures are optional.

*Verification infrastructure.* Kimina Lean Server keeps a pool of Lean REPLs and an LRU cache of
import headers behind a REST `check(snippets, timeout, infotree)`: 9,419 proofs in 7 min 56 s on 64
cores, against 12 min 56 s for LeanInteract and 18 min 01 s for leanclient, nearly 4 times faster
from 8 to 32 cores, and twice as slow per proof without the cache (0.099 s against 0.051 s).
Pantograph is a machine interface to Lean 4: goals handled independently, metavariable coupling,
resuming a proof with holes, states before and after each tactic. Kimina serves the batch checks
(the battery, recompilation after propagation, the validator) and Pantograph the per-goal work (the
battery per subgoal, a sketch's goals). Both exist in Seshat as `lean.check` and `lean.goals`.

*The order of operations for each new subgoal* (plan §15): (1) identity and subsumption: is it
known, or an instance of a known fact (Task 10, main team); (2) fingerprint: false on a small
model, refuted and certified by `decide` (Task 7, main team); (3) the domain router; (4) the Lean
battery in parallel, short time limits, ordered by posterior; (5) ATP and SMT with premise
selection, then reconstruction; (6) only then a model, whose context says what steps 1 to 5 tried.
Task 6 builds steps 3 to 5; Task 14 (main team) composes them all in this order. What to measure:
the share of subgoals each step closes and its CPU cost, the share of conjectures refuted without a
model, dollars per solved problem against M0, and the router's precision.

*Tool access in three levels* (`bibliotheque-outils.md` §1 and §3). Level 0, automatic: the
orchestrator triggers by rule everything a rule can decide (propagation, subsumption,
fingerprints, the battery, the router, identification, Lean checks, drift detectors); the prover
never calls these, it sees their results in its context. Level 1: about ten stable, high-level
tools always declared, grouped around tasks rather than programs (`lean_check`, `lean_goals`,
`graph_query`, `expand`, `search`, `compute`, `counterexample`, `prove_auto`, `tool_search`); the
prover does not need to know Mace4 exists to ask for a counterexample. Level 2: everything else on
demand, grouped by namespace (`atp`, `cas`, `sat`, `db`), each with a skill. Each capability has a
manifest saying when to use it and when not, its inputs and outputs, its implementations, its
certificate, the status it can produce, its cost (median and 95th percentile measured on the
bench), examples, contract tests (for instance 20 golden problems) and its health. The router
picks implementations by domain and goal class and orders them by Beta posteriors per
(capability, implementation, goal class): counting, not training. Each description is written for
the model: what the tool does, when to use it and when not, examples, namespaced names, concise or
detailed answers, and error messages that say what to fix.

**Tests, documentation, done.** The tests of the plan's Task 6, with those of PC6 items 2 and 3
and J3 item 3. `documentation/classical.md`, the capability pages, the README diagram (the battery,
the router, ATP and SMT: `:::wait` for what needs Lean, `:::built` for what ran here, z3 if you ran
it), `lines.md` and `architecture.md`.

## 6. Task 9: lines M3 and M5, the lemma library and the lessons

**The plan:** [seshat-plan.md](seshat-plan.md), Task 9. Amended by PC3 of
[plan-change-thinking-modes.md](plan-change-thinking-modes.md) (lessons of kind `constraint`
distilled from failures that recur across claims; `obstruction` records), PC5 item 2 (hybrid
ranking of library candidates, kept only if it beats the best single channel) and LC2 of
[plan-change-lean-libraries.md](plan-change-lean-libraries.md) (the extra packages of the Lean
environment indexed with the same selector, and the ranking order: problem-local, then the
harness's library, then extra packages, then Mathlib). PC12 (tactic mining) is not built until M3's
measurements show the library is used. Amended by PE1, PE2 and PE6 item 4 of
[plan-change-memory-evolution.md](plan-change-memory-evolution.md) (lessons and library lemmas carry
their provenance; a lesson is drawn at random into sessions and judged by its causal effect, which
replaces the presence counter for deactivation; with `--human`, a lesson's promotion to the global
scope is staged for the team's approval), and bound by Global Constraint 16.

**What exists to build on.** `@seshat/library` and `@seshat/lessons`, empty packages; the memory
store's nodes and `ensureClaim` (statement identity, so the library dedups by statement id);
attempts with their strategies, premises and failure classes (M1); the validator's auxiliary
region; M0's prose notes, which M5 replaces when it is on (documentation/m0-loop.md, "notes");
Task 6's battery for the non-triviality test (Ruling 25).

**Decisions made for you** (change one only with a recorded decision):

- The library's Lean files are `lean/SeshatLib/<Domain>.lean`, modules `SeshatLib.<Domain>`
  (Ruling 26), written from the journal, with each lemma's provenance. Nothing compiles them here:
  test the generated text, and give them a contract that a Lean host can run.
- A problem's file cannot import the library (its header is fixed). So a library lemma reaches a
  proof as text the prover pastes into the auxiliary region: the `library_search` tool and the
  briefing give each lemma as a ready `aux_...` lemma with its proof. Record this as your decision
  if you keep it; `lean/SeshatLib/` is then the compiled, reviewed copy, and a Lean environment can
  include it later (Task 21).
- "General" means the lemma does not depend on the problem's local context: no local definitions,
  no hypotheses of the target, only the reference header's imports.
- The `obstruction` record of PC3 is shared by M1's "already tried", M2, M11 and M5, so its writer
  goes into `@seshat/memory` (a shared package: an additive change), for example
  `memory.recordObstruction({claimId, strategy?, reason, detail})` and `memory.obstructions(claimId)`,
  with `alreadyTried` showing one line per obstruction. The call sites in M2 (`packages/graph`) and
  M11 (`packages/models`) are yours to add, as small additive changes listed in your log's
  "Interface changes". Task 7 (M11) merges before you get there; if it has not, leave its call site
  to the main team in a note.
- PC3's distillation and any other one-shot model call use `completeJson` and a `site` tag once
  Task 15 (main team, next in its order) has merged; until then, `llm.complete` with a JSON parse
  and one retry, switched over when Task 15 lands.
- LC2: the declarations of the environment's extra packages come from an export through
  `lean.meta`, one per environment hash, which Task 21 (main team) provides with the environments.
  Build the index against that interface with a fixture until Task 21 merges.
- PE1's stamp and epochs and PE2's draw and effect posteriors are calls of the memory store that
  Task 23 (main team, next after Task 15) adds; the plan's Task 23 gives their interface. The draw
  covers the lessons you put in a session's briefing (never a verified fact, never the goal) and is
  recorded on `attempt.started`; a lesson is deactivated when P(effect < 0) > 0.9 after at least M
  observations on each side (both options), and the presence counters of deliverable 2 stay in the
  report for comparison. If Task 23 has not merged when you build M5, keep the presence counter as
  the rule, record it, and the second of the two to merge switches to the effect.
- PE6 item 4: with `--human` (Task 17, main team), promoting a lesson to the global scope waits for
  the team's approval through `harness lessons pending|approve|reject`. If Task 17 has not merged,
  the second of the two to merge adds the staging.

**Research digest.** From plan §0, §3.4, §3.5, §4 and §6, and `critique-v2.md` Q2.

*Why a library.* The Nexus baseline throws away the auxiliary lemmas it proves; nothing passes from
one problem to the next. LEGO-Prover (ICLR 2024) showed that a growing library of proved lemmas,
reused by the prover, pays. The plan's version: every proved auxiliary lemma that is non-trivial
(the battery's cheapest automation does not close it) and general enough (the validator checks it
does not depend on the problem's local context) is promoted, deduplicated by its canonical
statement id. It is indexed by our own search, on name, signature and gloss, which is the method of
TheoremGraph, which matches LeanSearch v2 without a model reranker, and it is searched before
Mathlib. In the packet, candidate premises come from the library first, then Mathlib. Measures:
the share of proofs that use a library lemma, and the cost on a problem B after solving a
neighbouring problem A (so M3 is measured on sequences of related problems, which Task 14 adds to
the bench).

*Why lessons with counters, never rewritten.* A lesson is a short entry with a scope (global,
domain, claim) and two counters. It is never rewritten: entries are added, duplicates merged, and
an entry is deactivated when its "harmful" counter outweighs its "useful" one. Outcomes move the
counters, not a model's opinion: a lesson present in the context of a successful attempt gains a
point; one present in a failed attempt on the same strategy loses one. This is ACE's incremental
playbook (arXiv 2510.04618): updates by deltas, never by full rewrites, because a rewrite loses
detail; ACE calls it "context collapse" and measured it (one rewrite shrank an 18,282-token
context to 122 tokens and accuracy fell from 66.7% to 57.1%, below the 63.7% of no adaptation at
all). M0's provers already pass prose notes between sessions; M5 replaces them only when it is on.

*Constraints and obstructions* (PC3). M1's negative memory is per claim. PC3 adds constraints
distilled from failures that recur across claims (the same failure class with the same normalized
detail on at least N attempts across at least two claims, N an option defaulting to 3, distilled by
one model call into a one-line constraint such as "Nat subtraction truncates: state bounds before
subtracting", with its supporting attempts and the same counters as any lesson), and a typed record
of why an approach cannot work (`counterexample`, `refuted_premise`, `nogood`,
`statement_mismatch`), shown as one line in "already tried".

*Why judge a lesson by its effect* (PE2; [plan-change-memory-evolution.md](plan-change-memory-evolution.md)
"Why"). The presence counter credits a lesson shown in a successful attempt even when it did not
cause the success, so a lesson shown often gains points by presence and never leaves. Elsewhere,
agents copy retrieved experience (input and output similarity near 1), stored errors propagate,
and adding every record does worse than a fixed memory on all four tasks of Xiong et al. (arXiv
2505.16067; for example 67.5% down to 55.5%), while strict selective addition does better (70.9%).
Withholding an item at random from some sessions measures what it causes. On skills, SkillsBench
(arXiv 2602.12670, 84 tasks): self-generated skills lose 1.3 points on average, human-curated ones
gain 16.2, and 2 or 3 skills per task gain 18.6 against 5.9 for 4 or more; hence Global Constraint
16.

**Tests, documentation, done.** The tests of the plan's Task 9 and of PC3, PC5 item 2, LC2, and
PE2's deactivation rule.
`documentation/library.md` and `documentation/lessons.md`, `memory.md` for the obstruction records,
the README diagram, `lines.md`.

## 7. Task 11: line M4, the context compiler, `expand` and `graph_query`

**The plan:** [seshat-plan.md](seshat-plan.md), Task 11. Amended by PC5 items 1 to 4 of
[plan-change-thinking-modes.md](plan-change-thinking-modes.md) (query extraction, never retrieval
on the raw statement alone; the accessibility filter; pattern seeds with their dependency
neighbours; widening after a failure; hybrid ranking; the `connect` mode of `graphQuery` and the
path renderings; the `expand` table format) and LC2 of
[plan-change-lean-libraries.md](plan-change-lean-libraries.md) (the premise selector covers the
environment's extra packages, with the source shown) and PE2 and PE5 of
[plan-change-memory-evolution.md](plan-change-memory-evolution.md) (the unverified items you select
go through Task 23's draw; the packet is a prefix compiled once per session and a tail for each
request, through Task 24's API).

**What exists to build on.** The `contextPacket` hook (documentation/lines.md: its text replaces
every message of the request after the system prompt and the tool declarations); in
`@seshat/graph`, `graphQuery` with `ShortIds` and `renderSubgraph` (`query.ts`), and
`personalizedPageRank` and `nearbyClaims` (`pagerank.ts`); M2's prover tool is named
`graph_neighbors` so that M4's `graph_query` can run beside it; Task 5's ATMS labels; M1's
`alreadyTried`; Task 9's library index and active lessons; Task 6's record of what the battery
tried. `@seshat/context` is an empty package. Task 24 (main team, next after Task 15) lets
`contextPacket` answer `{ prefix, tail }`, and Task 23 adds the draw over unverified items.

**Decisions made for you** (change one only with a recorded decision):

- The `connect` mode goes into `@seshat/graph`'s `query.ts` as an additive change (a named call
  site: list it in your log's "Interface changes").
- A Mathlib premise selector needs an index of declarations with their constants. There is no
  Mathlib here: write MePo and SInE against a declaration-index interface, tested on a fixture;
  the real index is the `lean.meta` export of LC2 (Task 21, main team). The online k-NN learns from
  our own proofs, the premises M1 records on `attempt.finished`. LeanHammer's published selector,
  if you add it, is an optional capability, off by default and marked not run.
- Query extraction (PC5 item 1a) uses `completeJson` with a `site` tag once Task 15 has merged
  (see Task 9).
- The packet's premise count and rendering are options a session can set, so that Task 19 (main
  team, PC6 item 1) can sample them per session: whichever of Tasks 11 and 19 merges second wires
  the sampling.
- Count tokens with one documented approximation, the same for the budget and the report.
- The prefix holds the goal, the useful facts, the candidate premises, already tried and the active
  lessons as drawn; the tail holds the sketch's state, the last raw Lean feedback and the budget
  left. What is learned during a session reaches the next session, or, as an option, the tail as a
  short list of what is new since the session started. Each unverified item you select (a lesson, a
  schema hint, a library hint section; never a verified fact the proof needs, never the goal) goes
  through Task 23's draw. If Task 24 or Task 23 has not merged when you build M4, answer one string
  or show every selected item, record it, and the second to merge switches.
- The naive packet, the same content without selection, order or ids, is M4's comparison arm
  (plan §6: the complete compiler against a naive packet with the same content), selectable by an
  option.

**Research digest.** From plan §0, §4 and §13, and `graphe-donnees.md` §6.

*Why compile the context.* The same memory, badly presented, is useless: distractors and length
degrade even simple tasks (Chroma, "Context Rot"). And a warning read the week the plan was
written: injecting a model-inferred knowledge graph into a prover's context gains at most 3 points
and hurts large models (Nabi et al. 2026, arXiv 2609.34460). The gain must come from algorithms
working on the graph and from verified edges, not from the amount of graph shown to the model; the
amount shown is a setting, tuned per model, and a strong model gets little, and only verified
facts.

*The packet* (plan §4). Input: a role, a target claim, a token budget. Output: a deterministic,
reproducible packet, rebuilt for each model request. Fixed sections, in this order: the goal (Lean
statement and gloss); the sketch's state (open subgoals only); useful facts (proved ones, with a
status badge); candidate premises (the library, then Mathlib); already tried (the negative memory
summarized by strategy, including what the classical battery tried); active lessons; the last raw
Lean feedback (only the last). Selection by personalized PageRank from the target and by status,
then similarity; Mathlib premises filtered by a symbolic selector (MePo, SInE), plus an online
k-NN over our own proofs and LeanHammer's pre-trained selector used as it is (small non-LLM models
are allowed; we train nothing), each measured against MePo alone. Nothing under a relevance
threshold goes in, even with budget left. Short citable ids (`C17`, `L4`) and an `expand(id)` tool
let the prover load details just in time. Never accumulated raw tool output, never a summary of
history: for the prover there is no history, only the graph. The rendering is tested like an
interface, by A/B variants on the bench (Lean only or Lean with gloss, badges or not, the order of
sections).

*Reasoning on the graph* (plan §13). Graph operations (paths, propagation, neighbourhoods, dedup)
run in code: models are weak at them and sensitive to their encoding. The `graph_query` tool lets
the prover state a typed path pattern (in the style of Reasoning on Graphs); the engine runs it and
returns a small subgraph rendered with ids. It also accepts Loogle-style statement patterns
(constants, subexpressions with metavariables, the shape of the conclusion). The rendering (typed
edge list, sentences, table) is chosen by A/B on the bench. Outputs are constrained to the graph:
every id a model cites must exist (Graph-Constrained Reasoning, applied after the fact).

*Relevance* (`graphe-donnees.md` §6). Personalized PageRank (HippoRAG, NeurIPS 2024) from the
target and its symbols over the graph of claims, lemmas, sources and symbols: up to 20% better on
multi-hop questions, and its one-step retrieval matches iterative retrieval (IRCoT) at 10 to 30
times less cost and 6 to 13 times faster; it counts every path, not only the shortest, and takes
milliseconds at our size. Symbolic premise selection without training: MePo (Meng and Paulson,
iterative filtering by shared symbols) and SInE (Hoder and Voronkov, a trigger relation through the
rarest symbols). In LeanHammer's full pipeline on Mathlib's test set, MePo proves 26.3% of the
goals, against 16.9% with no premises, 30.1% with their neural selector, 12.0% with ReProver and
41.0% with the true proof's premises (the ceiling): a symbolic filter recovers about 70% of the
neural gain. Tree similarity (Tree-Based Premise Selection for Lean 4, NeurIPS 2025: a
Weisfeiler-Lehman kernel, tree edit distance, Jaccard on constants, over simplified `Expr`s, no
training described) is a further candidate channel. An online k-NN over our own proofs learns as
proofs arrive, with no gradient or GPU (Tactician in Coq: 1.72 times its offline version; with
Graph2Tac, 1.27 times each; an online random forest written in Lean runs in 0.28 s per theorem; in
hammers an IDF-weighted k-NN beats naive Bayes by about 30%). Mathlib's real graph has about
308,000 declarations and 8.4 million edges, and 50.9% of the couplings cross namespaces: names and
folders guide relevance poorly, the dependency graph guides it well. So: rank by PPR from the
target, filter Mathlib premises by MePo or SInE (with the k-NN and LeanHammer's selector, each
measured against MePo alone), then by tree similarity; everything deterministic and replayable.

*Why freeze the prefix* (PE5). With a packet compiled again for every request, the provider's
prompt cache covers only the system prompt and the tool declarations, and the packet is billed at
the full input price on every turn. Hermes Agent freezes its memory into the prompt once per session
for this reason. Task 14 measures dollars per solve with the frozen prefix against a packet compiled
for each request; nothing has run against a real provider yet.

**Tests, documentation, done.** The tests of the plan's Task 11 and of PC5 items 1 to 4, LC2, PE2's
draw and PE5's prefix.
`documentation/context.md`, `graph.md` for the `connect` mode, the README diagram (the context
compiler and its tools), `lines.md`.

## 8. Between the teams

What one team's task needs from the other's. "Second wires" means that whichever of the two tasks
merges later does the connecting work, against the interface the first one documented.

| Your task | Needs, or is needed by | Their task | Until it merges |
|---|---|---|---|
| 6 | `prove.search`'s orderer gets `decide` | 20 (main) | second wires |
| 6 | the host's Lean packages (`canonical`, LeanHammer, Duper) | 21 (main) | a host-profile option, off by default |
| 6, 9 | the battery as the non-triviality test | 9 (yours), 13 (main) | you wire Task 9 yourself; Task 13 uses the export |
| 9 | `obstruction` records written by M2 and M11 | 5 (merged), 7 (main, merging now) | you add both call sites; M11's after Task 7 merges |
| 9, 11 | `completeJson` and `site` tags | 15 (main, next) | `llm.complete` with a JSON parse and one retry |
| 9, 11 | the `lean.meta` declaration export per environment hash (LC2) | 21 (main) | a fixture behind the interface |
| 9 | M3's library feeds schemas (PC13) and the `LibraryBuilder` (LC4) | 18, 22 (main) | they build on your merged Task 9 |
| 11 | per-session premise count and rendering | 19 (main) | second wires |
| 9, 11 | the provenance stamp, epochs, the draw and the effect posteriors (PE1, PE2) | 23 (main, next) | second wires; the presence counter and every item shown until then |
| 11 | the `{ prefix, tail }` packet API (PE5) | 24 (main, next) | second wires; one string until then |
| 9 | a lesson's promotion to the global scope staged under `--human` (PE6 item 4) | 17 (main) | second wires |
| 11 | the `connect` mode in `@seshat/graph` | 5 (merged) | you add it |
| 6, 9, 11 | all lines composed in one run, ablation table | 14 (main, last) | Task 14 waits for your three merges |

Task 4 (the certifier) and Task 7 (M11) merge into `main` before you are far into Task 6: they
change `run.ts`, `lines.ts`, the README and `lines.md`. Pull often.

## 9. When a task is done

Merge it (CLAUDE.md, "Done" and "Branches, commits, merges"), then update your log: the task's
row (merged, the merge commit), the decisions you took, the interface changes with their commits,
what is simulated or has not run against a real Lean, model or program, and any concern the main
team should read. Then pull, read the ledger's notes "For the collaborator", and start the next
task.
