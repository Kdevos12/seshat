# Plan change: what the third real run's failures ask of Seshat (PA1 to PA15)

Status: APPROVED by the owner 2026-11-12 20:19 UTC (decision card "Approuver la proposition d'audit, et dans quel ordre ?", option "Tout, avec relance des 9 (≤4,50 $)": everything, in the order below, including the diagnostic replay of the 9 failures at most $4.50). Proposed 2026-11-12, by the thread "Auditer les échecs Putnam et remapper Seshat" (read-only on the repository and the plan). The findings behind it are in French in `research/audit-echecs-putnam.md`.

## Evidence in one paragraph

Third real run (`runs/run3-solve-defaults-B20`, code `313c423`, 20 grade B problems, deepseek-flash, cap $0.50 per problem, run budget $1.35 per arm, so about $0.07 per problem in practice): `solve-v1` and `solve-v2` 13/20 each. Nine problems failed in at least one arm. Four failures were proofs found and then refused for a `partial def` (1994 A1, 1997 B5 and 2000 A2 in v1; 1997 B5 in v2). Two problems are out of reach at this budget (1967 A5: the isodiametric inequality, likely absent from Mathlib; 2025 B5: AxiomProver's formal proof is 1,495 lines and about 18M tokens). Four were stopped by the gate after a $0.05 probe (1983 A4, 2003 B3 in both arms; 1999 A2 and 2004 B1 in v2 only, both solved by v1). 1983 A4 shows the missing step: computing the sum for k = 1 to 8 gives S = (-1)^(k+1)·3^(3k-1) + 1, so S ≡ 1 (mod 3), which Lucas's theorem proves. No session in the run called `compute_sage`. The measured arms ran lines M1 and M10 (plus M6's repeat rule in v2); the heuristic bank (drawn by the fleet), lessons, library, context compiler, M8's data tables and skills (which have no caller) did not run. External evidence with the same backbone model: Goedel-Architect (DeepSeek V4 Flash) reaches 75.6% pass@1 and 88.8% pass@4 on PutnamBench at about $1.65 per solved problem; on its 200-problem subset at equal tokens, a single tool-using agent plateaus near 55%, the blueprint refinement loop reaches about 80%, and natural-language proof seeding 92.5%.

## Changes

Each item names its kind: modify a module (MOD), add within a module (ADD), new module (NEW).

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| PA1 | MOD | Prover prompt (`packages/orchestrator/prompts/prover.system.txt`, new version): forbid `partial`, `unsafe`, `implemented_by`, and show structural recursion or `termination_by`; for a statement with an integer parameter, compute small cases with the compute tool before writing Lean; prefer, among known proofs, the one whose lemmas Mathlib has. | Prompt version bumped; prompt tests updated. |
| PA2 | none | Validator: already refuses `implemented_by`, `extern`, `unsafe` and (since `1eb4e82`) `partial`. No action. | |
| PA3 | MOD | Give `lean.search` a backend on the owner's host: `LEAN_SEARCH_URL` to a public LeanSearch service or a Loogle pattern URL, after a recorded probe of the real response shape (as Task 45 did for the literature sites); the local index otherwise. | A free real probe recorded as a fixture; `harness doctor` green on the host. |
| PA4 | MOD | Run budget sharing: a problem may spend at most a share of what remains (default 2 × remaining ÷ problems left), or a two-pass mode (every problem at a small budget, then the promising ones). | Test: one hopeless problem cannot starve the ones after it. |
| PA5 | MOD | Budget gate: the probe is at least the median cost of a solving session (read from earlier journals or a host setting), not 10% of the cap; an informal plan checked by computation counts as progress (needs PA13). | Measured as an arm against v2-fixed. |
| PA6 | MOD | Bench: tag grade B problems known to be out of reach at small budgets (a Mathlib gap, a published formal length), report them apart; measure on at least 60 paired problems with a run budget that does not cut the per-problem cap. | The tags in the graded bench; the report shows both tables. |
| PA7 | ADD | Heuristic cards without the fleet: `solve` draws one card from the statement's model-free features (`features.ts`), with a control arm, so the bank reaches the prover. | An arm in `solve-defaults`; card statistics in the report. |
| PA8 | ADD | Four cards: `invariant.mod_small_prime`, `represent.prime_by_prime`, `represent.lowest_terms`, `strategy.formalizable_route` (families invariant, represent, represent, strategy; overlap check passes). | Bank tests. |
| PA9 | ADD | A built-in pack of Mathlib skills by domain (number theory, polynomials, sums and limits, recursion without `partial`), and the caller: `selectSkills` gives at most three to the prover by the router's statement kind. Written by people (Global Constraint 16). | The prover's briefing carries them; the three-skill rule holds. |
| PA10 | ADD | Data tables pushed by the harness (M8 within `solve`): for a statement with an integer parameter, the harness computes the first cases (compute tool or an isolated evaluator), looks them up in the OEIS, and puts the table in the first briefing, as it pushes `lean.search`. | Test with a stand-in Sage: 1983 A4's table reaches the briefing. |
| PA11 | ADD | Task 38 (refinement rounds) brought forward for M12: each unproved hole returns a structured diagnosis (statement wrong, proof too hard, with an analysis); refinement splits hard holes, repairs false ones, keeps proved lemmas. | Arm `solve-v2-blueprints-refine` against `solve-v2-blueprints`. |
| PA12 | ADD | Lessons (M5) in `solve`, with a control arm. | An arm in `solve-defaults`. |
| PA13 | NEW | Task 39 (informal proof first) brought forward: one or more natural-language proofs (optionally a stronger model for this step only), checked by computation on small cases, the most formalizable route chosen from `lean.search` hits on its key lemmas, handed to the blueprint. Caveat: Putnam solutions are in the models' training data, so the gain measured on Putnam overstates the gain on open problems. | Arm against v2-fixed and against PA11. |
| PA14 | NEW | Formal-cost triage before spending: estimate the formalization's size (informal proof length, key lemmas missing from Mathlib) and classify the problem as invest, short try or skip; the gate reads it. | 1967 A5 and 2025 B5 classed skip or short try on a replay of their journals. |
| PA15 | NEW | `harness audit RUN`: one dossier per unsolved problem (spend, tool calls by name, gate verdict and words, last Lean errors, last sketch), optionally set beside a reference solution a person supplies; never read by a solving run. | Built from the journal alone; test on scripted journals. |

## Order

1. Free now: PA1, PA3, PA4, PA6.
2. With the owner's yes: a diagnostic replay of the 9 failures with v2 fixed and a real $0.50 cap (at most $4.50). It is not a measure of gain (regression to the mean); it shows whether causes F (format) and B (budget) are gone.
3. Build: PA10, PA9, PA7 with PA8, then PA13 and PA11.
4. Measure: paired protocol on at least 60 grade B problems, one arm per added piece against v2 fixed.
5. Then the lead agent (Tasks 46 to 48), which takes these pieces as its tools; then the open problem.

## Open questions for the owner

1. The diagnostic replay of the 9 failures, at most $4.50.
2. A stronger model (deepseek-v4-pro, about 4.4 times flash's price) for the informal proof step only.
3. Tasks 38 and 39 measured before the lead agent.
