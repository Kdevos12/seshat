# Plan change: a Lean-only draft, checked by Lean, as a cheap first try, and modes learned like heuristics (CL0 to CL6)

Status: APPROVED by the owner 2026-11-19 16:39 UTC, all of CL0 to CL6 ("Ça me va, va pour A et B, mais ça doit être
très solide et très bien implémenté. Rappel : codebase propre, modulaire, on doit pouvoir comprendre ce qu'il se passe
rien qu'en regardant les fichiers, pas d'empilement, philosophie bien compartimenté/lego inspiré"), after the
recommended order CL0, then B (CL5, CL6), then A (CL1 to CL4). The owner's conditions are binding: see "Design: one
piece, one place" below. At 16:40 UTC the owner added: "On met A en option, il ne coûte rien mais c'est experimental,
par défaut ce n'est jamais utilisé": part A (CL1 to CL4) is an option, marked `experimental` in
`documentation/parameters.md`, in no defaults set (`v1`, `v2`) and never on unless a settings file or an ablation arm
turns it on. Proposed 2026-11-19. Written by the thread "Étudier une « chain of Lean » économe" (read-only on
the repository and the plan) after the owner asked whether a Chain of Draft made only of Lean or mathematical notation,
checked live by Lean, could be a fast and cheap mode for minor tasks. The owner allowed comments of a few words and left
the choice of targets and of step-wise versus whole-draft checking to this thread. The report it rests on, in French:
`research/chain-of-lean.md` (in the project files); sources: `research/chain-of-lean-sources.md` (in the project files).
The owner then asked whether a reasoning mode fixed for a whole run is counter-productive, and whether
there is literature on choosing the mode dynamically inside an agent, a mode being "a macro version of a heuristic";
CL5 and CL6 answer that (report section 7, sources `research/mode-selection-sources.md` (in the project files)).
Read against `main` at `9de7a33` and the branch of Tasks 64 to 67 (`claude/project-thread-h60gyw`, PR #8), which this
change assumes merged.

## Evidence in one paragraph

Chain of Draft (arXiv 2502.18600) keeps about 91% on GSM8K against 95% for CoT with about a fifth of the output tokens
and a quarter of the latency, but only with hand-written few-shot examples (zero-shot, Claude falls to 65.5%) and only
on the visible text: a model that thinks still pays for its thinking. The closest measurement of "Lean only" is
DeepSeek-Prover-V2 (arXiv 2504.21801, 671B): Lean alone against a plan then Lean, 59.5% against 61.9% at pass@1 on
miniF2F-test with 762 against 6,752 output tokens, but 16 against 49 PutnamBench problems at pass@1024. Lean alone is
nearly free accuracy on easy work and a large loss on hard work; that model was trained for the format, a general model
is unmeasured. Step-wise provers that call the model once per tactic are all trained and spend thousands of CPU days;
the untrained one (COPRA) trails whole-proof systems. The cheap pattern that works without training is draft, Lean,
local repair: DeepSeek-Prover-V1.5's truncate-and-resume and APOLLO (arXiv 2505.05758; o4-mini from about 3-7% to over
40% on miniF2F). Latency: with a warm REPL Kimina checks a short proof in 0.05 to 0.27 s amortized (arXiv 2504.21230),
re-importing Mathlib costs about 60 s a branch (arXiv 2605.25556), and a model call writing 500 to 1,000 tokens takes
10 to 30 s: the model is the bottleneck on any host, not Lean. Finally, the arm `solve-v2-long` (DP6) already runs hole
sessions at thinking `off` with Lean after every check, so a hole session there is already close to a live chain of
Lean; what a Lean-only style would save on holes depends on the share of prose in their output, which no one has measured.

## Principle

One cheap rung before the expensive ones, built from what exists: a draft prompt, the existing check, the existing
`sorry` goals, the existing gate ledger. No new line, mode, package or capability. Whole draft, not one model call per
step: Lean checks the whole draft once and the first broken step is located by Lean. Off by default until an arm shows
it pays per dollar.

## Items

**CL0. Measure the prose share first (free, any host).** `harness audit` gains, per role (prover, planner, hole), the
split of output tokens of a run's responses into thinking, text outside tool calls, and tool-call arguments, read from
the response blobs the journal already keeps. This decides CL3 and is useful beyond it. Cost if wrong: none; it is a
report.

**CL1. The draft prompt.** A prompt file next to `prover.system.txt` (`lean-draft.system.txt`, prompts are files, Global
Constraint 16 holds: a human merges its text): "write only Lean 4; each step a `have h_k : T := by ...` or a `calc`
line; at most one comment of five words or fewer above a step; no prose", with two or three short worked examples
(Chain of Draft fails without them). The output form is the have-sketch of DP1, so `liftHaves` and the battery read it
unchanged.

**CL2. A draft before the probe (`gate.draft`, off by default).** Where the budget gate starts a problem's probe
(`budget-gate.ts`), and under the probe's own ledger (no new budget path), one completion without tools at thinking
`off`, capped at `maxOutputTokens` (default 1,024), on the problem's statement and the briefing the probe would get.
The harness checks it with `lean.check` as a tool run. If Lean reports an error, the harness cuts the draft at the
first error, replaces the rest by `sorry`, checks again to read that `sorry`'s goal (the `LeanSorry.goal` the checker
already returns), and asks for one continuation from the verified prefix (truncate-and-resume, `resumes` default 1).
The battery runs on any `sorry` left, as `sorryBattery` does. A draft with no error and no `sorry` is a candidate and
goes through `validate`; the certifier settles the problem as for any other proof. Otherwise the draft is an attempt
like any other (M1's "already tried" and negative memory see it) and the probe runs as today. The curriculum's variants
(M18) take the same path. One event field: the attempt's `settings.mode: "lean_draft"`.

**CL3. The same style in hole sessions, only if CL0 shows prose worth cutting.** A setting of the hole role
(`roles.hole.settings.style: "lean_draft"` and `maxOutputTokens`), which adds CL1's rules and examples to
`HOLE_SYSTEM` and caps each response. No other change to the hole session. Threshold proposed: prose (text outside tool
calls) above 20% of hole output tokens in the journals of the real runs made so far, and of the first `solve-v2-long`
run; below it, CL3 is dropped.

**CL4. Measure.** An arm `solve-v2-long-draft` of `solve-defaults`: `solve-v2-long` plus `gate.draft` (plus CL3 if it
passed CL0), against `solve-v2-long` at the same cap per problem. Read: problems closed by the draft and their cost,
problems solved per dollar, wall time per problem, and for CL3 holes closed per dollar. Kill rule: if problems solved
per dollar do not rise and no problem is closed by the draft on rung A of the ladder, the setting stays off and the
prompt file is removed.

**CL5. Modes and thinking levels learned like heuristic cards.** Today the fleet learns a session's `mode`
(`standard`, `nl_first`) and `thinking` level per claim only, while a problem has few sessions; the heuristic bank
already learns cards per bucket across problems and runs (`bucketOf`: the domain and two statement features), against a
control, with an effect and a deactivation rule (`effectOf`, `shouldDeactivate`, `cardMinObservations`). Fold the two:
the sampled discrete settings (`mode`, `thinking`, `directive`) get the bank's bucket posteriors as their prior, with
the same pseudo-session weight as a card family (`familyPriorWeight`), and the same deactivation rule in a bucket. No
new sampler and no new statistic: the code that weighs cards weighs these values. `lean_draft` (CL2's form, as a
session mode) becomes a third value of `mode` only after CL4 shows that it closes something. Evidence: per-instance
algorithm selection (SATzilla: 97.8% against 67.4% for the best single solver on RANDOM; MaLeS: +8.7% for E), training-
free routing by a bandit outside the model (MixLLM, Meta-Reasoner); the thinking-length routers (AdaptThink, Thinkless,
AdaCoT, Self-Route) all need training or hidden states and are out. Cost if wrong: the prior pulls a claim toward its
bucket's habit; the per-claim posterior still dominates after a few sessions, and the exploration floor stays.

**CL6. Switch on Lean, between sessions, cheapest first.** The switch triggers are Lean's and the harness's numbers,
never the model's view of its own difficulty (the best partial correlation between a model's correctness and its
choice to delegate is about 0.3 over 17 models, arXiv 2509.21545; frequent switching goes with wrong answers, arXiv
2501.18585). Concretely, inside what exists: (a) when M6's repeat rule ends a session or the fleet's `stagnating` holds
on the claim, the next session's draw excludes the current `mode` and `thinking` value (a restart in another mode,
journaled in the allocation's `settingDraws`); (b) the order of first tries follows cost, as the training-free cascades
do (Adaptive-Solver, arXiv 2310.01446; Yue et al., arXiv 2310.03094: 36 to 60% of cost saved): battery, CL2's draft,
then the sampled session. No switch inside a session. An arm `solve-v2-fleet-modes` (`solve-v2` plus the fleet with
`mode` and `thinking` sampled, CL5 and CL6) against `solve-v2` measures it; the fleet line has never run on a real model,
so this arm is also its first measurement. Not in any defaults set until it wins.

## Design: one piece, one place

The owner's condition: one can tell what happens by looking at the files; no stacking; compartments that fit together
like bricks. Each item therefore lands in one named place, reuses what is there, and adds no second path for anything
that exists. Paths are those of `main` and of PR #8; the build thread renames them where the code says otherwise and
records why.

| Item | The one place it lives | What it reuses, unchanged | What it must not add |
|---|---|---|---|
| CL0 | `packages/orchestrator/src/audit.ts`: one table "output tokens by role and kind" | the response blobs and `model_call.finished` events the journal holds | a second reader of the journal or a new event |
| CL1 | `packages/orchestrator/prompts/lean-draft.system.txt` and its version file, rendered like `prover.system.txt` | the prompt files' rules (Global Constraint 16, the strict screen) | prompt text in code |
| CL2 | one module `packages/orchestrator/src/lean-draft.ts`, exporting one function (draft, check, cut at the first error, read the `sorry` goal, resume, battery, candidate); the gate calls it at the probe's start in `budget-gate.ts`; the setting is a field `draft` of `GateSettings` (`packages/scheduler/src/gate.ts`) | `lean.check` through the workbench, `LeanSorry.goal`, `sessionSorryBattery`, `validate`, the probe's ledger, M1's attempt record | a new budget path, a new line, a new capability, a second battery or a second submission path |
| CL3 | `hole-session.ts` reads a `style` field of the hole role's settings and adds CL1's section | the same prompt file as CL2 | a second hole session |
| CL4 | one arm in `experiments.ts` (`solve-v2-long-draft`) | `solveArm` | a new experiment |
| CL5 | `packages/fleet/src/settings.ts` (`sampleSettings` takes a bucket prior); the bucket posterior and the deactivation come from one function moved out of `heuristics.ts` and called by both cards and settings | `bucketOf`, `cardEffect`'s rule (`effectOf`, `shouldDeactivate`), `familyPriorWeight` | a second sampler, a copy of the bucket code, a mode router |
| CL6 | `packages/fleet/src/fleet.ts` (`beforeSession`): the exclusion after a repeat-rule stop or `stagnating`; one arm `solve-v2-fleet-modes` in `experiments.ts` | M6's `lineCause`, `stagnating`, the allocation's `settingDraws` | a switch inside a session, a model call that picks a mode |

Each module begins with a comment that says what it does, what calls it, and what it never does (no status, no
budget of its own). Each item has its tests next to its module and its documentation in the page that already
describes that module (`audit.md`, `prompts.md`, `scheduler.md` for the gate, `fleet.md`, `ablate.md`), in the same
commit. Code made dead by an item is removed in that item's commit.

## Trust rules, unchanged

A draft is model text. Only `lean.check` makes a candidate, only `validate` and the certifier's `kernel_replay` make
`proved`. The cut-and-`sorry` file is a working file, never submitted. The verified prefix is "no error so far", not a
status of any claim.

## Dropped, with the reason

- One model call per tactic (COPRA style): pays the model's latency at every step on every host, and no published
  untrained result beats whole drafts. Step-wise search without a model already exists (`prove.search` over
  `lean.goals`), off by default and not yet run against Pantograph; it is the place for step-wise work.
- Lean only for outer sessions by default: the PutnamBench gap (16 against 49) says the plan matters on hard problems.
- No natural language at all: Chain of Draft's zero-shot collapse; comments of five words or fewer stay, as the owner
  allowed.
- A Lean-only style with thinking on: the thinking is where the tokens are; the savings vanish.
- Using it for computations: `decide`, `norm_num`, `#eval` are in the battery and `compute.sage` with no model call.

## Order and cost

Order: CL0, then CL5 and CL6, then CL1 to CL4. CL5 and CL6 do not depend on CL0 to CL4: they touch only `@seshat/fleet`
and an arm.

After PR #8 (Tasks 64 to 67) merges. CL0 first (a report, small). CL1 and CL2 together (one prompt file, one branch of
the probe, about the size of the sorry battery's wiring). CL3 only on CL0's number. CL4 is a paid run: at about $0.002
a draft on deepseek-flash, the draft itself adds well under 1% to an arm whose cap is $0.50 a problem.

## Questions for the owner

1. (Answered 16:39 UTC: all of CL0 to CL6.)
2. Should CL2 also run on problems the triage calls `long`, where the gate follows the frontier? Default proposed: no,
   the draft is for problems that may be short.

## What is not verified

No general model has been measured writing Lean-only drafts at thinking `off`; the latency of one tactic in a warm REPL
has no primary source (Kimina gives per-proof averages over many cores); Chain of Draft has not been measured on a
thinking model; the share of prose in Seshat's outputs is unknown until CL0. For CL5 and CL6: the mode-selection
sources were read mostly from arXiv abstracts; no source gives the number of sessions a bandit needs to separate
reasoning modes in proving, and with about twenty problems a run, several runs (`--memory-from`) will be needed.
