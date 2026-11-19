# Plan change: a path for long proofs (LP1 to LP6)

Status: APPROVED by the owner 2026-11-19 09:50 UTC (decision card "Approuver la proposition sur les preuves longues, et jusqu'où ?", option "Tout (LP1 à LP6, 3 $ max)": everything, in the order below, including the paid diagnostic LP6 at most $3.00). Proposed 2026-11-19. Written by the thread "Comprendre les échecs sur les preuves
longues" (read-only on the repository and the plan). The report it rests on, in French:
`research/echecs-preuves-longues.md` (in the project files, not in this repository). Read against `main` at `9de7a33`.

## Evidence in one paragraph

The claim "Seshat fails on long proofs" rests on one problem, Putnam 2025 B5 (1,495 Lean lines and 66 theorems for
AxiomProver, an estimated $3 to $8 at deepseek-flash prices), which Seshat never really attempted: the budget gate
stopped it after the probe in every arm of the third run and in the replay, after $0.06 to $0.11 (in `v2`, one
`lean_check` in a $0.057 session). The "analysis" part of the claim does not hold (1994 A1 failed only through the
certifier's `_unsafe_rec` defect and was solved in the other arm), and the "geometry" part is one Mathlib gap
(1967 A5). Of the ten failures of the corrected third run (`v1`, 4) and the replay (6), seven are stops by the gate
right after the probe. The architecture makes long proofs unlikely to succeed even with money: the probe judges on
Lean progress in a tenth of the allowance; PA14's triage classes an informal proof over 12 steps or 6,000 characters
as `skip` or `short`, never `invest`; by default (`solve` `v1` and `v2`) a proof is one file resent whole at each
check, with accepted `aux_` lemmas left in the editable region and in every turn's context (in the first real run 4 of
9 sessions on Graffiti 194 stopped on context as the auxiliary region grew); M12's decomposition is off by default,
its first blueprint is written by the prover rather than derived from the accepted informal proof, and a hole gets 2
sessions of 12 responses. When M12 ran (replay, run 4), 3 of 11 blueprints were healthy and 5 of 7 hole verdicts were
`too_hard`. The same model reaches 75.6% pass@1 on all of PutnamBench inside Goedel-Architect, whose measured gains
come from refined decomposition (+25 points at equal tokens) and an informal proof as the seed (+12): the model is
not the main limit. None of LH1 to LH8, the cards, the sorry battery or the submit guard has run on a real model
(the last real run is 2026-11-13).

## Principle

A long proof is a chain of short proofs that Lean checks one at a time. Seshat should (1) derive the chain from the
accepted informal proof before any prover session, (2) freeze each link once Lean accepts it, so the working file and
the context stay small, (3) measure progress in links closed per dollar, and (4) invest only where links keep
closing. Everything below is an option, off by default; `v1` and `v2` are unchanged, and a new arm measures it.

## Items

Each item names its kind: modify a module (MOD), add within a module (ADD), new module (NEW).

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| LP1 | ADD (`orchestrator` audit), then a free measurement | `harness audit` gains a "length" table: for each certified proof and each problem's last failed attempt, Lean lines, `aux_` lemmas, holes and their verdicts, checks, check durations against file size, stop reasons; a `--reference DIR` of public proofs (Goedel-Architect, AxiomProver, Seed-Prover, where published) adds the reference length. Then run it, free, on the owner's machine over `run3-solve-defaults-B20`, `run4-replay-B6` and `run5-graph-smoke`. | A table "success against reference length" for the problems of runs 3 to 5, in the ledger and in the report; whether the claim holds is stated from it. No model call. |
| LP2 | ADD (`informal`, M12) | Draft blueprint from the informal proof: with `RunConfig.longProof` and an accepted `informal_proof`, one planner call (role `planner`, fresh context) turns its numbered steps into a first blueprint, one `aux_` hole per step with its `-- uses:` lines and a complete main proof from the holes, read by `readSketch` and checked by Lean through `ProblemContext.checkSketch` before the first outer session. A refused draft goes to the refinement rounds (case a) as any refused blueprint does. | Simulated: an accepted proof of N steps gives a healthy blueprint of N holes with the faux model; a refused draft enters round 1; journaled as `m12_sketch` with `planner: true` and a new optional `fromInformal: true`. |
| LP3 | ADD (M12, session, `lean-env` header) | Frozen links: a hole that is `proved`, or an `aux_` lemma of the outer file accepted by a check with no error and no `sorry`, moves into a locked prefix of the problem's file. Lean still checks the whole file, prefix included, at every check, and the certifier replays it whole, so no trust rule changes. The prover's context shows the prefix's statements only (names and types), not their proofs; an edit that touches the prefix is refused like an edit outside the regions. Hole headers (`HOLE_HEADER_CHARS`) show proved dependencies by statement, so the 2,500-character cut no longer drops them. | Test: the prompt size of a session no longer grows with the number of proved lemmas; a prefix lemma cannot be changed; a certified proof replays with its prefix. |
| LP4 | MOD (`scheduler` gate, `triage`) | A `long` triage class: an accepted informal proof over the `short` limits, with at least half its facts found by `lean.search`, and an allowance at or above a host setting (default $1), is `long`, not `skip`. Under `longProof`, the probe's Lean progress is the frontier's growth (LH3, already built, off by default): a hole closed or a healthy blueprint registered counts; the gate keeps widening while holes close, and stops honestly when K consecutive slices (default 3) close none. | Simulated: a long problem whose holes close one per slice is widened to its allowance; one whose holes stop closing is stopped after K slices; `v1` and `v2` unchanged byte for byte. |
| LP5 | MOD (M12 hole sessions) | Budget that follows size: a `too_hard` verdict records why (`turns`, `budget`, `model_said`); a hole cut by its turns gets one continuation session before a refinement round splits it; under `longProof`, the depth limit of `-- refines:` is 4 (3 today). | Simulated: a hole cut at 12 responses continues once, then splits; the reason is in `hole_verdict`; the report counts verdicts by reason. |
| LP6 | Paid diagnostic, owner's decision | After LP1 to LP5: arm `solve-v2-long` (v2 + informal first + M12 + LP2 to LP5 + `frontier.show`) on 3 problems of medium reference length chosen from LP1's table, two arms: deepseek-flash everywhere; the same with `deepseek-v4-pro` as the planner and verifier roles only (`--role`). At most $1.50 per arm, $3.00 in all. | A diagnostic, not a measure of gain: per problem, holes closed, verdicts by reason, frozen lemmas, spend; whether the stronger planner changes the share of healthy blueprints. |

## Trust rules, unchanged

- Only Lean decides: a frozen link is in the file Lean checks and the certifier replays; showing its statement only
  to the model changes what the model reads, not what Lean checks.
- An informal proof, accepted or not, never changes a claim's status (Ruling 13); LP2 only turns it into holes that
  are `open` until Lean proves them.
- The journal stays the only source of truth: the locked prefix, the triage class and the verdict reasons are
  journaled or rebuilt from it.

## Order and cost

1. LP1, free. Needs the owner's machine online (the journals are there). It may show the claim is false at the
   lengths that matter; then LP2 to LP5 still help long problems, but the priority drops.
2. LP2 and LP3 (the chain and the freezing): the core of the owner's hypothesis. No model cost to build; simulated.
3. LP4 and LP5 (gate and hole budget).
4. LP6, at most $3, only with the owner's yes and after a DeepSeek balance check.
5. Then a campaign on one long problem (Tasks 59 and 60 already built), which this path feeds.

## Questions for the owner

1. Run LP1 (free) on your machine as soon as it is online? Recommended: yes.
2. Build LP2 to LP5 behind the option `longProof` and the arm `solve-v2-long`? Recommended: yes, in that order.
3. LP6: $3 at most, with `deepseek-v4-pro` as planner and verifier in one arm? Recommended: yes, after LP1 to LP5.
4. Does the cellular-automata campaign pilot wait for this? Recommended: no for track B1 (short proofs, the comfort
   zone), yes for A1's general construction (a long proof).

## What is not verified

- The length of the proofs Seshat solved: not read (LP1).
- Whether the 5 `too_hard` hole verdicts of the replay were cut by their 12 responses or judged hard by the model.
- Whether a 120-second check bound bites on a long file on the owner's 4-core machine.
- Goedel-Architect's figures are as reported in the Putnam audit (section 5), not rechecked here.
