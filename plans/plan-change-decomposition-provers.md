# Plan change: what DeepSeek-Prover-V2, Draft-Sketch-Prove and LEGO-Prover teach the long-proof path (DP1 to DP7)

Status: APPROVED by the owner 2026-11-19 10:18 UTC (decision card "Approuver la proposition DP1 à DP7, et jusqu'où ?",
option "Tout (DP7 seulement après LP6)": DP1 to DP6 built with LP, DP7 only after LP6's numbers). Proposed 2026-11-19. Written by the thread "Tirer les leçons des provers par
décomposition" (read-only on the repository and the plan), after the owner approved LP1 to LP6 and asked for a closer
audit of these three systems, with the instruction not to stack additions and to keep the codebase clean. The report it
rests on, in French: `research/lecons-provers-decomposition.md` (in the project files, not in this repository). Read
against `main` at `9de7a33` and [plan-change-long-proofs.md](plan-change-long-proofs.md) (Ruling 43, Tasks 64 to 67,
not built yet).

## Evidence in one paragraph

Without training, what DeepSeek-Prover-V2 leaves is a format and an extraction rule: a general model writes one proof
whose steps are `have h : T := by sorry`, and each `sorry` becomes a standalone lemma whose hypotheses are the local
context, earlier steps included (its figure 3), so no dependency is declared and every subgoal can be worked at once.
Seshat asks the model for the opposite (top-level `aux_` lemmas in signature form, `-- uses:` lines, a complete main
proof, no statement naming a hole), and that format failed in real runs: 0 of 5 blueprints healthy in run 3, 3 of 11
in the replay; LP2 as approved would generate the same format. Draft-Sketch-Prove measures three cheap levers: the
informal step as a comment above each formal step (+4.9 / +2.8 points on miniF2F valid / test), closing gaps by tactics
and a hammer before any model (without them −9.8 / −9.0), and several sketches per problem, since a sketch is one call
and checking it costs no model (1 to 100 attempts takes about 100 to about 200 solved). LEGO-Prover's library is
already Seshat's M3; what M3 lacks is LEGO's two defaults: lemmas Lean verified in a failed attempt are kept, and the
library is searched by each subgoal's statement. The audit also shows that Seshat's hole session, the unit of
decomposition, is its barest session: `hole-session.ts` gives `runSession` the verdict tool only, so no sorry battery,
no pushed `lean.search`, no library, and the prompt (`holePrompt`, `line.ts`) has no informal text. Caveat: DSPV2's
671B model solves 47 of 658 PutnamBench problems at pass@1024, Goedel-Architect 75.6% with DeepSeek V4 Flash and a
refinement loop: decomposition in one shot is a form, not a strategy, and CA12's refinement rounds stay.

## Principle

Fold, do not stack. The model writes the proof the way it naturally writes it; Lean, not the text, turns each gap into
a lemma; the cheap tools close what they can before any paid session; whatever Lean accepted is recorded once. Every
item modifies something LP already changes or replaces code that exists, sits behind `RunConfig.longProof`, and leaves
`v1` and `v2` byte-identical.

## Items

Kinds: amend an approved LP item (AMEND), modify a module (MOD), replace code (REPLACE), settings only (SET).

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| DP1 | AMEND LP2 | **The draft is a `have` sketch, lifted by Lean.** LP2's planner call answers one PROOF region: the target's proof as `have h_k : T_k := by sorry` steps, each preceded by `-- step k: <the informal step>`, ending in a complete closing tactic. The harness (1) checks it once through `ProblemContext.checkSketch`; (2) runs the existing sorry battery (`sorry-battery.ts`) once on it, so the steps the tactics close are closed in place; (3) lifts each remaining `sorry` with Mathlib's `extract_goal` at that point (one Lean check; the extracted `theorem` is renamed `lemma aux_h_k ... := by sorry`); (4) rewrites the step to `have h_k : T_k := by apply aux_h_k <;> assumption` (explicit arguments when that fails). The result is an ordinary M12 sketch in signature form with no `-- uses:` (each hole has the earlier steps as hypotheses), read by `readSketch` and registered with its link lemma checked by Lean as today. A lifted statement that does not compile fails the pre-flight's type check, and the draft goes to refinement case a. The lifter is one function in `@seshat/scheduler` (`liftHaves`). | Simulated: a 4-step draft whose battery closes 1 step gives a sketch of 3 holes, each with the earlier steps as hypotheses, healthy; a `have` inside a `cases` branch and one whose type mentions an `intro`'d variable are lifted; an extraction that does not compile enters round 1; journaled as LP2's `m12_sketch` with `fromInformal: true` and an optional `lifted: true`. Not run against a real Lean: `extract_goal`'s output on real goals. |
| DP2 | REPLACE (CA13 repair) | **One lifter.** The repair pass's text-based lifting of a top-level `have` (`cutFailures`, `repair.ts`) uses `liftHaves` instead, so a `have` whose type mentions a name bound earlier, or that is not top-level, is lifted rather than refused. The cutting of failing `aux_` proofs to `sorry` is unchanged. Net code: the conservative `have` parser of `repair.ts` goes. | `repair.test.ts`'s cases pass; the cases it lists as refused for a bound name or a nested `have` are now lifted; without `repair` nothing changes. |
| DP3 | AMEND LP2 | **A few drafts, ranked for free.** `longProof.drafts` (default 1; the arm sets 3): LP2 makes that many planner calls (each asked of the gate as a refinement round is) and keeps the draft with the fewest holes left after steps 1 to 3 of DP1, ties to the fewer steps; the others are recorded (`m12_sketch`, `healthy` as Lean said) and never registered. | Simulated: of 3 drafts, the one the battery leaves with fewest holes is registered; a gate skip stops at the drafts made; `drafts: 1` is LP2 as amended by DP1. |
| DP4 | MOD (hole session) | **A hole session is an ordinary session on a small file.** `hole-session.ts` passes `runSession` what `prover.ts` passes an outer session when the run has them: the sorry battery, the pushed `lean.search` (CA22), M3's `library_search` tool and its "Library" section searched by the hole's statement (LEGO's retrieval by request). `holePrompt` adds, when known, the informal step the hole formalizes, quoted as data and said to be unchecked (DSP's comments). Nothing new is built: the options exist. | Simulated: with `sorryBattery` and `leanSearch` on, a hole session's check answer carries them; the library section's query is the hole's statement; the prompt shows the step; without those options the hole session's requests are byte-identical. |
| DP5 | MOD (LP3, M3) | **One record of a lemma Lean accepted.** LP3's frozen links are written into the existing `accepted_lemmas` node (optional `lemmas: [{name, statementId, proofHash}]` next to `names`), not a new kind; under `longProof`, M3 reads its candidates from that node (`fromFailed` behaviour: LEGO keeps verified lemmas of failed attempts), and the state card and the frontier read the same node as now. | Simulated: a lemma frozen in a failed attempt is a `library_candidate` judged at `afterProblem`; one node per session, as today; without `longProof` the node's data is what it was. |
| DP6 | SET (LP6's arm) | **Settings of `solve-v2-long`, no code:** `longProof.drafts` 3 (DP3); the `hole` role's `thinking` at its lowest level (DSPV2: subgoals in non-CoT mode, about ten times fewer tokens); `informalFirst.passes` 1 (DSP: Lean already checks the skeleton through the link lemma and the pre-flight tests each step; the same-model verifier said `correct` 18 times of 18 in the replay). LP6's two arms keep their budget, $1.50 each, $3.00 in all. | The arm's definition in `experiments.ts`; `documentation/ablate.md` lists the settings. |
| DP7 | Conditional, after LP6 | **Local recursion on a hole that is too hard** (DSPV2's recursive solving): under `longProof`, a `too_hard` hole whose reason is not `budget` gets DP1's draft with the hole as the target, registered on the hole's claim, instead of a global refinement round (case b) for that hole; depth is the nesting of `decomposes_into` edges, at most LP5's limit. Built only if LP6 shows `too_hard` holes as the main stop; if built, it replaces LP5's change of the `-- refines:` depth, which is then not made. | Decided on LP6's numbers; acceptance written then. |

## What LP changes as a result

- **LP2** is amended by DP1 and DP3 before it is built: its output is a `have` sketch, not the blueprint format, and it
  does not need `blueprints`' dependency machinery (`-- uses:`, stubs, waiting, per-hole link lemmas). It keeps what
  `blueprints` brings: hole sessions, pre-flight, verdicts, refinement rounds.
- **LP3** writes into `accepted_lemmas` (DP5) instead of a new record.
- **LP5** keeps the `too_hard` reason and the continuation session; its depth change waits for LP6 and may be replaced
  by DP7.
- **CA13** loses its text lifter (DP2).
- **Later, after measurement, the owner's call:** if `have` sketches are healthy more often than blueprints in the
  arms, stop asking the model for `-- uses:` (keep reading it), so that one format remains.

## Trust rules, unchanged

- Only Lean decides. A lifted hole is `open` until `validate` accepts its proof; the sketch is assembled by the
  harness, its link lemma checked by Lean, and the problem settled by the certifier as today. `extract_goal` only
  writes a statement; a wrong one fails the pre-flight's type check or the link lemma.
- An informal step shown to a hole session is quoted data, never a status (Ruling 13), as the informal proof is.
- The journal stays the only source of truth: drafts, lifts, frozen lemmas and library candidates are nodes rebuilt
  from it.

## Dropped, with the reason

DSPV2's RL, expert iteration, consistency reward, specialised 7B prover and training curriculum (training); pass@1024
and DSP's 100 sketches (cost; 3 drafts are the test); LEGO's evolver and offline request solver (about $300 an
experiment, gain not isolated in the paper); embeddings (M3 has BM25 and a model-free vector channel). DSPV2's
plan-proof consistency problem does not exist here: the harness assembles the proof.

## Order and cost

1. LP1 first, as approved (free, the owner's machine).
2. DP1, DP2 and DP3 with LP2 (Task 65), DP5 with LP3 (same task): no model cost, simulated.
3. DP4 with Task 66 (it is wiring and two prompt sections).
4. DP6 when LP6's arm is defined; LP6 itself unchanged: at most $3.00, after LP1 to LP5 and a balance check.
5. DP7 only if LP6's numbers call for it.

No paid run is added by this proposal.

## Questions for the owner

1. Amend LP2 so the planner writes `have ... := by sorry` and Lean extracts the holes (DP1, DP2)? Recommended: yes,
   before Task 65 is built.
2. Several drafts ranked by Lean and the battery, 3 in the arm and 1 by default (DP3)? Recommended: yes.
3. Make the hole session an ordinary session with the run's battery, search and library, and its informal step
   (DP4)? Recommended: yes.
4. One record for accepted lemmas, read by LP3 and M3 (DP5)? Recommended: yes.
5. The arm's settings (DP6) and DP7 only after LP6? Recommended: yes.

## What is not verified

- Whether `extract_goal` (Mathlib, `Mathlib/Tactic/ExtractGoal.lean`) is available under that name in the pinned
  environment, and whether its output re-elaborates on real Putnam goals (instances, coercions, `⋯`, inaccessible
  names). The pre-flight's type check is the safety net; nothing has run on a real Lean.
- Whether `apply aux_h <;> assumption` closes the rewritten step on real goals (explicit arguments are the fallback).
- The papers' gains are on miniF2F, two of them in Isabelle, with other models; they predict nothing for Lean 4 with
  DeepSeek Flash. LP6 is a diagnostic on 3 problems, not a measure of gain.
- The planner call's price (a twelfth of a session is LP's guess) and the battery's CPU time for 3 drafts on a 4-core
  machine.
