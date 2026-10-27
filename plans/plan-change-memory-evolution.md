# Plan change: long-term memory, evolution, and entrenchment guards

> Copied into the repository on 2026-10-27 from the project's shared files, with the French quotes
> translated. Where the plan places each item (Ruling 27): PE1, with the mechanism of PE2 and the
> memory that outlives a run which PE1, PE3 and PE9 assume (Ruling 28), is the new Task 23 of
> [seshat-plan.md](seshat-plan.md); PE5 is the new Task 24; PE7 (line `M18`) is the new Task 25;
> PE8 is the new Task 26 (this change called it Task 19, a number the plan had already given to the
> Task 8 follow-up). The uses of PE2, PE3, PE4, PE6 item 4 and PE9 amend Tasks 9, 10, 11, 14, 18
> and 19, which name them; the rules of PE6 are the plan's Global Constraint 16. Other task numbers
> below are those of the plan.

Written 2026-10-20 by the parallel thread on AlphaProof's evolutionary approach and Hermes Agent's
memory, for the implementation thread. It amends
[seshat-plan.md](seshat-plan.md) and builds on [plan-change-thinking-modes.md](plan-change-thinking-modes.md)
(PC1 to PC13). The decision note behind it, with sources and numbers, is
`research/evolution-memoire-continue.md` (French, in the project's shared files, outside the
repository). Read against main at 9e76c43; reconcile task numbers and statuses with main as it is
now.

Status: **approved by the user on 2026-10-21 at 12:17 UTC** ("Send everything": all of PE1 to PE9
go to the implementation thread). Earlier, on 2026-10-21 at 08:28 UTC, the user confirmed that the
outcome counters of PE2 and PE3 and the offline prompt optimization of PE8 stay ("these points are
relevant and we can keep them"), after checking that neither trains a model. Relayed to the
implementation thread on 2026-10-21 at 16:03 UTC.

Global Constraints apply unchanged: nothing here trains a model, Lean stays the only judge, the
orchestrator stays the only writer, every mechanism that claims a gain is an ablation line or a
measured option.

## Why

- Evolution does not lower long-term cost by itself. Nexus agent D is about 2x less efficient than
  agent A on 4 of 6 Erdős problems and 2x to 5x more efficient on the 2 hardest. What lowers the
  cost of the next problem is what survives the current one (goal cache, library, schemas, identity,
  propagation). So evolution is gated by difficulty (PE4) and feeds those stores (M15 already does).
- AlphaProof's own evolution is training (AlphaZero RL, test-time RL for 2 to 3 days per IMO
  problem). Its training-free remnant is a curriculum of easier variants (PE7), unmeasured.
- Hermes Agent publishes no measurement of its memory or skills. SkillsBench (arXiv 2602.12670, 84
  tasks, 7 model-harness configurations): self-generated skills -1.3 points on average, human
  curated skills +16.2, 2 to 3 skills per task +18.6 vs 4 or more +5.9. Hermes's useful parts are
  engineering: a session-frozen memory snapshot that keeps the provider's prompt cache valid (PE5)
  and staged writes for review (PE6).
- Entrenchment is measured elsewhere: agents copy retrieved experience (input/output similarity
  correlation near 1), stored errors propagate, and adding every record does worse than a fixed
  memory on all 4 tasks of Xiong et al. (arXiv 2505.16067; e.g. 67.5% to 55.5%), while strict
  selective addition does better (70.9%). Our verified stores are protected by Lean; the unverified
  ones (lessons, failure memory, strategy posteriors, schemas, channel statistics, prompts) are not.

## Summary

| # | Change | Task | Kind | Priority |
|---|---|---|---|---|
| PE1 | Provenance stamp and expiry on every learned artifact | Task 1 follow-up (core events), Tasks 2, 8, 9, 12, 18 | infrastructure | high |
| PE2 | Randomized inclusion of unverified memory items; causal counters | Task 9 (M5), Task 11 (M4), Task 18 (M15) | changes a line | high |
| PE3 | Soft failure memory: per-config scope, discounting, exploration floor, stronger-model retry route | Task 2 follow-up, Task 8, Task 15 (PC1 routing) | changes lines | high |
| PE4 | Escalation ladder by budget spent | Task 8 (fleet), Task 10 (scheduler) | policy, measured | high |
| PE5 | Session-frozen packet prefix for prompt caching | Task 11 (M4), orchestrator | cost, measured | high, cheap |
| PE6 | No free-form self-generated skills; cap on loaded skills; external text never in lessons | Task 9, registry skills | rule | do |
| PE7 | Variant curriculum on hard problems (AlphaProof TTRL without training) | Task 5 follow-up or Task 13, rung of PE4 | new line `M18` | medium-low |
| PE8 | Offline prompt optimization (GEPA) outside runs, gated | new task (Task 26 of the plan), after Task 14 | tool, outside ablations | low |
| PE9 | Entrenchment probe and diversity metrics in the report | Task 14 | measurement | high |

---

## PE1. Provenance stamp and expiry

Deliverables:
1. A `Provenance` record on every *learned, unverified* artifact: lessons, attempt records used by
   "already tried", strategy and cell posteriors (Task 8, M15), schemas, channel statistics (M9),
   evolved prompts (PE8). Fields: `modelId` (the run's prover model, as configured; repo files keep
   no concrete ids), `promptVersion`, `mathlibRev`, `harnessVersion`, `budgetClass`, `createdAt`.
   Lean-checked facts and edges do not need it to stay valid (they are model independent), but
   library lemmas carry `mathlibRev` and are recompiled on a Mathlib change.
2. An `epoch` in the projection: a change of prover model family, prompt major version or Mathlib
   revision opens a new epoch (event `memory.epoch_opened`, with the reason).
3. On a new epoch, unverified artifacts from older epochs enter `probation`: their counters are
   shrunk toward the prior (e.g. Beta(a, b) becomes Beta(1 + (a-1)·k, 1 + (b-1)·k) with k = 0.25, an
   option) and they are re-earned under PE2. Nothing is deleted; the journal keeps everything.
4. Docs: `documentation/memory.md` (or the existing memory doc) gets a section "Provenance and
   epochs".

Tests: stamp present on every learned artifact kind; epoch opened on each trigger; shrinkage
arithmetic; a probation lesson regains weight only through outcomes.

## PE2. Randomized inclusion (memory dropout) and causal counters

Problem: plan §3.4 credits a lesson present in a successful attempt even when it did not cause the
success, so frequently shown lessons accumulate points by presence and never leave.

Deliverables:
1. When the context compiler (Task 11) selects an unverified memory item (lesson, schema hint,
   inspiration example, library *hint section*; never a verified fact the proof needs, never the
   objective), it includes it with probability `p_new` (default 0.5) for its first N uses (default
   20), then `p` (default 0.9). The draw uses the run's seeded random source and is recorded in
   `attempt.started` (`included: id[]`, `withheld: id[]`).
2. Each item's effect is the difference between success rates of attempts with and without it,
   restricted to the same claim group and strategy label, as two Beta posteriors. M5's
   deactivation rule becomes: deactivate when P(effect < 0) > 0.9 after at least M observations on
   each side (options). This replaces the presence counter; the old counter stays in the report
   for comparison.
3. The same mechanism serves M15 schemas and M9 inspiration examples.

Measured: lesson set size and solve rate vs the presence-counter rule at equal budget.

Tests: inclusion draws reproducible from the seed; posterior updates on scripted outcomes;
deactivation thresholds; verified facts never withheld.

## PE3. Soft failure memory

Problem: "induction on n: 3 failures, goal not closed at n+1" usually means *this model with this
budget* failed. Beta posteriors by (claim, strategy) then starve the strategy forever, also after a
model upgrade.

Deliverables:
1. "Already tried" (Task 2) groups records by strategy *and* by config class (model family,
   budget class); a line from another config class says so ("2 failures with a smaller model").
2. Strategy posteriors (Task 8) are discounted: on each new run on a problem, counts are multiplied
   by γ (default 0.8, an option); a new epoch (PE1) applies the probation shrinkage.
3. Exploration floor: a share ε of sessions (default 0.1) picks its strategy uniformly among
   allowed labels, ignoring negative memory for that choice (the session still sees "already
   tried", so it avoids exact repeats). Recorded as `exploration: true` on the attempt.
4. Routing (PC1, Task 15): a new action `retry_stronger` when a claim's failures all come from a
   weaker config class than the strongest configured, before `branch`.

Tests: grouping by config class; discount arithmetic; floor share over a seeded run; the routing
case.

## PE4. Escalation ladder by budget spent

Problem: Nexus D pays only on the hardest problems; a population everywhere raises the mean cost.

Deliverables:
1. A per-problem ladder in the scheduler (Task 10) with rungs, each enabled only if its line is on:
   (0) M0-style provers with the cheap stack (battery M10, goal cache, propagation); (1) PE7 variant
   curriculum; (2) M15 archive and M16 program search. A problem moves up a rung when a fraction
   `f_k` of its budget is spent without Lean progress (progress = a new proved subclaim or fewer
   open holes in the best healthy sketch). Defaults f = 0.3 then 0.6, options.
2. The fractions are tuned from the cost-to-first-success curves of the Nexus 100-attempt chunking
   protocol (`research/nexus-ingenierie.md` §4 item 2, French, outside the repository: 100
   attempts of one prover grouped into chunks of 100/K attempts for K in {1, 3, 6, 10}, a chunk
   succeeding when one of its attempts does, the cost summed up to the first success), not guessed
   per run.
3. Events `ladder.escalated` with the reason; report shows per problem the rung that solved it and
   the dollars spent per rung.

Measured: ladder vs "all rungs from the start" vs "rung 0 only", at equal budget, split by problem
difficulty (Nexus's lesson).

## PE5. Session-frozen packet prefix (prompt caching)

Observation (from the code, not measured): with a line packet, `transformContext` replaces every
message after the system messages with one user message recompiled on every request
(`packages/orchestrator/src/session.ts`, the `transformContext` block). The provider's cache then
covers only the system prompt and tools; the packet is billed at the full input price each turn.
Hermes freezes its memory into the prompt once per session for this reason.

Deliverables:
1. The packet API returns `{ prefix, tail }`. `prefix` (objective, useful facts, candidate premises,
   already tried, active lessons, PE2 draws) is computed once at session start and reused verbatim
   on every request of the session; `tail` (sketch state, the last raw Lean feedback, budget left)
   is recomputed per request and placed after it. Facts learned mid-session reach the next session
   (or, as an option, the tail as a short "new since session start" list).
2. Cache hints passed through pi-ai where the provider supports them; the report shows cached input
   tokens (`cacheRead`, already counted in `budget.ts`) and dollars per solve.

Measured: dollars per solve and solve rate, frozen prefix vs per-request recompilation.

Tests: prefix byte-identical across requests of a session; tail changes; the "new since start" list.

## PE6. Rules on skills and external text

1. No mechanism writes free-form procedural "skills" from the agent's own experience. Procedural
   knowledge enters only through verified channels (library lemmas M3, Lean macros of PC12, M15
   schemas) or counted lessons (M5 with PE2).
2. Human-written skills (registry skills, e.g. Lean skill packs) stay allowed; at most 3 are loaded
   in full per session (option), the rest listed by name and description only.
3. Text from an external source (paper, web page, TheoremGraph entry, tool output) carries its
   provenance and never becomes a lesson or part of a system prompt; a lesson's text comes only from
   the distillation of our own journaled outcomes.
4. With `--human` (PC2), promoting a lesson to the global scope is staged for approval
   (`harness lessons pending|approve|reject`), as Hermes's `write_approval`.

## PE7. Variant curriculum: line `M18` (rung 1 of PE4)

Source: AlphaProof's test-time RL (variants of the target, curriculum, RL). Without training, the
remnant: on a hard problem, generate special cases and weakenings through M2's variant generator
(small n, prime case, extra hypothesis), solve them first with a capped share of the budget
(default 20%), and feed their proofs to later sessions as proved facts (`special_case_of` edges)
and as one or two in-context proof examples.

No published evidence that this pays without weight updates; the line is removed if it does not
beat the ladder without it.

Tests: variant tasks created on escalation; budget cap; proofs reaching the next briefing.

## PE8. Offline prompt optimization (new task, Task 26 of the plan, after Task 14)

Source: GEPA (arXiv 2507.19457: reported +6% on average over GRPO with up to 35x fewer rollouts,
over 10% above MIPROv2), used by Hermes Agent Self-Evolution on skills (no published results there).
DGM (Sakana) shows the risk: a self-modifying agent faked a test log and removed its hallucination
markers.

Deliverables: `harness optimize-prompts --split dev` runs GEPA-style reflective mutation over the
prover and line prompts on a dev split of the bench, keeping a Pareto set per problem; a candidate is
accepted only if it beats the current prompt on a held-out split and on the temporal holdout at
equal budget. It writes a branch and a report; a human merges. It has no write access to the
validator, guards, journal code, tests or bench indexes, and its prompts are stamped (PE1).
Outside ablation runs.

## PE9. Entrenchment probe and diversity metrics (Task 14)

Deliverables in the report and the ablation runner:
1. A fixed probe set (default 20 bench problems, never used to build the library) rerun on a
   schedule (every K runs, option) twice: memory on and memory off (all learned unverified
   artifacts withheld; verified facts kept). Alarm in the report when memory-on solves fewer or
   costs more than memory-off beyond noise.
2. Library and schemas built on one part of the bench and measured on another (also fixes an
   optimistic M3 measurement).
3. Over time: number of distinct strategy labels and sources among proofs, share of budget on
   strategies never tried on that claim group, share of proofs that reuse a library lemma or schema.

---

## What this does not change

- Lean as the only judge; nothing unverified reaches the fact store; no training; no debate.
- PC1 to PC13 stand. PE2 changes M5's counter rule (plan §3.4); PE3 changes how Task 8's posteriors
  are updated; PE5 changes the packet API of Task 11 before it is built.

## Suggested order

PE1 and PE5 first (small, and every later measurement depends on them); PE2 and PE3 in the briefs
of Tasks 9, 8 and 11; PE6 as rules in the same briefs; PE4 with Task 10; PE9 with Task 14; PE7 after
M2 and the ladder exist; PE8 last.
