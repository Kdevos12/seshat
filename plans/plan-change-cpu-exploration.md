# Plan change: CPU tools for non-linear exploration (CX1 to CX10)

Status: **APPROVED by the owner 2026-11-25 at 08:49 UTC** (decision card "Approuver la proposition CX1 à CX10 sur les outils CPU, et jusqu'où ?",
option "Tout, dans l'ordre proposé": CX1 and CX2 first, then CX3 and CX4, then CX5 to CX8 and CX10; CX9 only on a measured
need; the paid comparison run, at most $1, still needs the owner's go). Proposed 2026-11-25. Written by the thread "Étendre les outils CPU
d'exploration non linéaire" (read-only on the repository and the plan), after the owner asked to break mathematical
reasoning across domains (algorithms and linear algebra included) into recurring sub-steps that explore spaces with no
useful derivative, and to find CPU tools that strengthen each step. Read against `main` at `b5aa04d`. The report it
rests on, in French: `research/outils-cpu-exploration.md` (in the project's shared files, not in this repository).

## Evidence in one paragraph

Twelve exploration moves recur in every domain (E1 to E12 below); the frequent ones are witness or counterexample
search (E2, E3), certificate search (E6) and pattern guessing (E4), which are where a model is weakest and a CPU tool
strongest. Seshat already has most engines but not the bridges: Z3 runs in-process as WASM (`smt.z3`, whose Spacer and
Optimize engines are unused), CaDiCaL ships with every Lean toolchain, and `compute.sage` holds PARI, GAP, FLINT,
Singular, fplll and nauty, at 4 to 6 GB, too heavy for the mission's student machine. M8, M13 and M16 have never run
for real. External evidence:
- **IneqAgent** (arXiv 2610.20681): Lean plus three symbolic backends (SOS/Putinar via SDP with exact rational
  recovery, Bernstein subdivision, successive difference substitution) and DeepSeek-V4-Flash solve 175 of 186
  inequality problems. Under a 5-cent cap they solve 88% against 67% for the direct agent.
- **PatternBoost** (arXiv 2411.00566): its global phase alone reaches 48 edges on triangle-free graphs, while its local
  search does most of the work.
- **"Simple Baselines are Competitive with Code Evolution"** (arXiv 2602.16805): IID sampling matches or beats
  ShinkaEvolve on 4 of 9 AlphaEvolve problems at an equal $20 budget, and conditioned sampling on 6 of 9, in 1 to 3 h
  instead of about 10 h.
- **CPU flip-graph walks** found about thirty new matrix-multiplication rank bounds (arXiv 2510.19787).
- **OR-Tools CP-SAT** won gold in every category of the MiniZinc Challenge 2025.
- **Newclid's DDARN** solves 15 of 30 IMO-AG-30 problems without a model.
- **Pyodide** already ships numpy, scipy, sympy, networkx, mpmath, python-sat, highspy, clarabel and gmpy2 as WASM.

## Principle

Tools find, Lean judges, and the orchestrator calls the tools: the model sees their results, not their definitions
(the November runs: sessions with extra tools spent their turns looking, `m0-loop.md`). Every item folds into an
existing line, router or capability, sits behind an option that is off by default unless stated, and leaves `v1` and
`v2` byte-identical. Every tool output is a witness or a certificate that Lean rechecks through `validate`, or a
`computed` edge or evidence node (Ruling 13). Three install tiers:
- tier 0, nothing to install: Z3, CaDiCaL, JS local search;
- tier 1, an npm package: Pyodide;
- tier 2, optional native packs, built only on a measured need.

## The twelve moves

| Id | Move | Lean outcome |
|---|---|---|
| E1 | Generate small cases up to isomorphism | data |
| E2 | Find a witness or construction (∃) | `decide` on the witness |
| E3 | Find a counterexample (refute ∀) | `decide` on the counterexample |
| E4 | Guess a closed form, recurrence or relation | an `open` conjecture |
| E5 | Find an invariant, monovariant or potential | an induction proof |
| E6 | Find a certificate of a bound or an impossibility (SOS, Farkas, Gröbner cofactors, modulus) | an identity closed by `ring`, `linear_combination`, `nlinarith` or `decide` |
| E7 | Change representation (normal forms, substitutions) | an equivalence proof |
| E8 | Split into cases (cubes, cells, boxes) | one lemma per case |
| E9 | Optimize an extremal object (construction below, certificate above) | E2 plus E6 |
| E10 | Find a rewrite sequence or proof path | the proof |
| E11 | Find an intermediate lemma | an `open` lemma |
| E12 | Estimate growth or asymptotics | a precise conjecture |

## Items

Kinds: measurement (MEASURE), modify a module (MOD), add within a module (ADD), settings only (SET), conditional
(COND).

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| CX1 | MEASURE, free; ADD (M10 router) | **Tag goals with their moves.** `routeStatement` gains a `moves` field (E1 to E12), computed from syntax, alongside its domains: ∃ over a finite or bounded type gives E2; ∀ with small instances gives E3; a polynomial inequality gives E6 (SOS) and E3 (numeric); an integer equation gives E6 (modular); a sequence or `f : ℕ → ℤ` gives E4. It is journaled with the router's verdict, and `harness audit` counts the moves over a run's problems. | On 40 hand-labelled statements from the bench and Putnam, at least 80% of their labelled moves are found, written to the ledger; then the counts over the bench, which order CX4 to CX8. |
| CX2 | MEASURE, a few cents | **The first real M16 run, with its baseline.** As the build thread proposed: a Sidon-set construction (known optimum) with M16 as built, and the same budget spent by an `iid` arm (same prompt, no islands, no resets: a new `M16.strategy=iid` option, SET plus a few lines in `evolve.ts`). | Both best scores and the spend in the ledger; M16's islands are kept as the default only if they beat `iid` at equal spend. |
| CX3 | ADD (capability) | **`compute.python` on Pyodide (tier 1).** A stateful capability like `compute.sage` (one interpreter per attempt, the same scope rule), Pyodide pinned with the package set loaded from a local copy: numpy, scipy, sympy, networkx, mpmath, python-sat, highspy, clarabel, gmpy2. It runs in its own Node process with `--permission` and an empty environment, with the `js` and `pyodide.ffi` modules removed before user code runs, and without the network. The host profile `local` offers it by default when Sage is absent; CA17's "host's compute tool" resolves to it then. Documented as a guard against mistakes, not against code written to escape, like `runValues`. | Contract cases: arithmetic, a sympy Gröbner basis, a python-sat model, a clarabel SDP, a time limit, a memory limit, `import js` refused, no network, no file outside the scratch directory; health and contract run on Linux, macOS and Windows in CI. |
| CX4 | ADD (M10 battery: a certificate stage) | **Certificates that a plain Mathlib 4.27 checks, no model.** After the tactics and before the ATPs, for goals CX1 tags E6, the battery tries, under its CPU budget and in this order: (a) **modular obstruction**: for an integer equation, the moduli up to `maxModulus` (default 64) whose residues admit no solution, with a template proof (reduce mod m, then `decide`); (b) **local polyrith**: the Gröbner cofactors of an ideal-membership goal (sympy through `compute.python`, or Sage), written as `linear_combination e₁ * h₁ + …`; (c) **SOS/Putinar**: an SDP by clarabel, rounded to rationals, exact LDLᵀ, written as `nlinarith [sq_nonneg (…), mul_nonneg …]` hints or an explicit identity closed by `linear_combination`; (d) **Bernstein subdivision** on a box, one lemma per box closed by `nlinarith` or `norm_num`, joined by `fin_cases` or interval splitting. Each candidate is a Lean text screened by `screenLeanText` and submitted through `validate`, as a tactic success is today. | Simulated Lean plus a fake `compute.python`: each of (a) to (d) produces the expected Lean text on a planted goal and nothing on a goal outside its fragment; the stage spends no model call; its tries are `tool_run` events with posteriors like the tactics'. One real-Lean pass ($0) on 20 olympiad inequalities and 20 integer equations, with the count certified per method in the ledger. |
| CX5 | MOD (M16) | **Local search before the model.** A `SearchSpec` may name a `neighborhood`: one of `bits`, `intList`, `permutation`, `graph`, or a sandboxed JS move function. Between model rounds, the best program's output is improved by tabu or annealing in the sandbox (bounded steps and time, a seeded source), and the improved object is scored like a program's output; a model round runs only when the local search has not improved for `plateauSteps`. The graph local search of CA20 becomes the `graph` neighborhood (one code path, not two). A `flip` neighborhood for matrix-multiplication schemes is an example spec, not code. | Simulated: on a toy score, the local search reaches the target with fewer model rounds than without it; with no `neighborhood`, M16 is byte-identical; M11's graph search gives the same results as before on its tests. |
| CX6 | ADD (M11) | **SAT and MaxSAT encoders for finite counterexamples.** For the statements M11 already reads (magma laws, graph properties at bounded order), a template encoder writes CNF with lex-leader symmetry breaking, solved by python-sat in `compute.python`, or by the CaDiCaL that ships with the host's Lean when the host profile names it. A model may also write the encoder (site `encode.sat`, priced and capped like M11's predicate requests); its model is decoded and checked by Lean's `decide` like any M11 counterexample, so a wrong encoder costs a try, never a status. UNSAT is recorded as `computed` evidence ("no model of order ≤ n"), never as `refuted` or `proved`. | Simulated: a planted magma counterexample of order 5 and a graph of order 10 found by the template encoders; a wrong model-written encoder whose model Lean rejects leaves the claim unchanged; UNSAT writes an evidence node and no status. |
| CX7 | ADD (`smt.z3` recipes, M14 and M8 use) | **Invariants by Z3's existing engines.** No new capability: two recipes that write SMT-LIB for `smt.z3`. (a) CHC (`(set-logic HORN)`, Spacer) for a loop or process given as transitions, the invariant returned as a conjecture for E5; (b) `minimize`/`maximize` (Optimize) for small extremal questions with linear or bit constraints. The invariant is an `open` claim proved through Lean as usual. | Contract cases added to `smt.z3`: a counter loop's invariant, a small MaxSMT optimum; the recipe's output is an `open` claim with the evidence node. |
| CX8 | ADD (M8) | **Guessing and growth through `compute.python`.** M8's channel gains sympy `rsolve` and `nsimplify`, mpmath `identify`, and a log-log or Richardson fit for E12; each result is an `open` conjecture with its evidence, screened by the CEGIS set like M8's other candidates. | Simulated with a fake `compute.python`: Catalan's closed form and the growth exponent of a planted sequence become conjectures; without `compute.python` M8 is unchanged. |
| CX9 | COND (packs) | **Native tools, each one a pack, each one built only when CX1's counts and a failed run point to it.** In order of expected use: `cp.sat` (OR-Tools CP-SAT, Apache-2.0, pip), `graph.sms` (SAT modulo symmetries), `auto.walnut` (automatic sequences, Java; results `computed`), `algebra.msolve` (Gröbner, GPL), `fmf.mace4` (finite models), `geo.ddar` (Newclid's DDARN; informal evidence only, since geometry in Lean 4.27 is thin). Each pack carries a manifest, a contract, a skill and `writesClaimStatus: false` (`packs.md`); no core change. | Per pack when built: contract on the host, health, and one case where it closes or refutes what tiers 0 and 1 could not. |
| CX10 | ADD (heuristic bank) | **One card per move.** HB cards such as "integer equation: try a modular obstruction first", "∃ over a finite structure: encode as SAT with symmetry breaking", "polynomial inequality: SOS, then Bernstein on a box", "construction with a score: local search before model rounds", in the existing bank and bucket scheme, learned like the other cards. | The cards load and are selected by bucket in the simulated tests; no new store. |

## What this changes in approved work

- **M10 (Task 6):** a certificate stage (CX4) and a `moves` field (CX1) in the router; the tactic list is unchanged.
- **M11 (Task 7, CA18 to CA20):** the encoders of CX6; CA20's local search becomes CX5's `graph` neighborhood.
- **M16 (PC8):** CX2's `iid` strategy and CX5's neighborhoods; the islands stay the default unless CX2 says otherwise.
- **CA17 (`solve --tool`):** with no Sage, "the host's compute tool" means `compute.python`.
- **VL9:** unchanged. `decide +kernel` chunking is the path to `proved` for large finite checks; CX6's UNSAT stays
  `computed`.
- **M17 (Lean environments):** `leanprover/sos` (Lean ≥ 4.33.1) and LeanCert (Lean 4.35) become candidates when the
  toolchain moves; CX4 does their job on 4.27 meanwhile.

## Design: one piece, one place

| Item | Where | New package |
|---|---|---|
| CX1 | `packages/classical/src/router.ts`, the audit | none |
| CX2 | `packages/induction/src/evolve.ts`, `m16.ts` options | none |
| CX3 | `capabilities/compute.python/`, an implementation in `packages/registry` (as `smt.z3`'s in-process one), `config/hosts/local.json` | none (a dependency on `pyodide`) |
| CX4 | `packages/classical/src/` (a `certificates.ts` beside `battery.ts`) | none |
| CX5 | `packages/induction/src/evolve.ts`; `graph-search.ts` folded in | none |
| CX6 | `packages/models/src/` (encoders beside `refutation.ts`) | none |
| CX7 | `capabilities/smt.z3/contract.json`, recipes in `packages/classical` | none |
| CX8 | `packages/induction/src/` (M8's channel) | none |
| CX9 | packs under `packs/` or external repositories | none in the core |
| CX10 | heuristic bank cards | none |

## Trust rules, unchanged

- Only `validate` changes a status; only the certifier's `kernel_replay` gives `proved` or `refuted`.
- A SAT UNSAT, a CP-SAT optimality proof, a Walnut answer, an SDP value or a numeric minimum is `computed` evidence at
  most. `native_decide`, `bv_decide` and any proof that rests on `Lean.ofReduceBool` stay refused by the certifier.
- Every encoder, scorer, neighborhood and certificate generator is untrusted: its output reaches Lean only as a
  screened Lean text (`screenLeanText`) whose witness terms come from `leanTerm`-style writers (integers, rationals,
  booleans, lists), never as text a model wrote.
- `compute.python` and the packs run model-written code: a separate process, no network, an empty environment, and
  Docker for native packs where the host has it.

## Dropped, with the reason

- PatternBoost's transformer and Wagner's cross-entropy network: they train a network (Global Constraint: no training).
  Their local search is kept (CX5).
- PySR: needs Julia; no shown gain over the Dalmatian plus a model.
- MOSEK, Mathematica, Maple, Magma: not free. Clarabel replaces MOSEK, at a precision CX4's real pass will measure.
- QEPCAD and Redlog: old and hard to install; Z3's nlsat covers the common case.
- An agent-facing tool per solver: tools are called by the routers (level 0), per the November evidence.

## Order and cost

1. CX1 and CX2 first: free, plus a few cents of model for CX2. They decide what comes next.
2. CX3, then CX4: the largest expected gain (IneqAgent's evidence), with $0 of model spend, since the certificate stage
   runs before any model.
3. CX5 and CX6, then CX7, CX8 and CX10: no model spend beyond the existing caps.
4. CX9 only on a measured need.

Model spend for the whole plan change: CX2's few cents and CX4's real pass at $0. A paid comparison run (the arms with
and without the certificate stage, the same 20 problems, at most $1) only after the owner's go.

## Questions for the owner

1. Should `compute.python` (Pyodide, an npm package) be the default compute tool when Sage is absent, so that the
   student path needs no Docker and no Python? Recommended: yes.
2. Bump the Lean toolchain later, to get `leanprover/sos` and LeanCert as tactics? Recommended: not now. CX4 gives
   their certificates on 4.27, and a bump is its own plan change.
3. Approve CX1 to CX10 in the order above, with CX9 conditional and the paid comparison run still needing a go?

## What is not verified

- Pyodide's WASM speed against native solvers on our cases.
- Whether `import js` can be fully removed in the pinned Pyodide.
- SMS's license.
- Whether clarabel's precision is enough for SOS rounding on olympiad inequalities.
- Whether `nlinarith` closes rounded-SOS hints within the battery's time limit on Lean 4.27.0.

None of these has run here: the cloud environment has no Lean and blocks the package hosts. Each is an acceptance test
of its item.
