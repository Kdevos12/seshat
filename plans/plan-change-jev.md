# Plan change: an optional `decide` capability with a Jev backend

> Copied into the repository on 2026-10-20 from the project's shared files, with the French quotes
> translated and the model names of the cited papers left out (plan, Global Constraint 13). Task
> numbers are those of [seshat-plan.md](seshat-plan.md).

Written 2026-10-20 by the thread "Option Jev", for the implementation thread. It amends [seshat-plan.md](seshat-plan.md) and builds on the approved
[plan-change-thinking-modes.md](plan-change-thinking-modes.md) (PC1, PC4, PC6, PC9). The decision note
behind it, with the source checks, is `research/jev-decisions.md` (French, in the project's shared files, outside the repository). Read
against main at 9e76c43.

Status: **approved by the user on 2026-10-20 at 07:36 UTC** ("Agreement given."). Reconcile task
numbers and statuses with main as it is now.

User requirement (DE VOS, 2026-10-16): an option to delegate some decisions to Jev (TypeSafe AI's
decision-only model) to cut costs, set in config; by default the LLM makes the decisions.

Global Constraints apply unchanged: Lean is the only judge, nothing goes to a model while a
classical tool can decide, every external tool is a capability, nothing is trained by us, every
mechanism is an ablation line that must earn its place.

## Summary

| # | Change | Task | Priority |
|---|---|---|---|
| J1 | Tag every one-shot model call with a `site` | Task 15 (PC1) or Task 1 follow-up | high, do first |
| J2 | `decide` capability: typed Choice / Score / Noul, backends `llm` (default), `jev`, `faux` | new, with PC9's `judge` | medium |
| J3 | Three call sites behind `decide`; a forbidden list | Tasks 6 (PC6.3), 12, 13 (PC4.2); 8 optional | medium |
| J4 | Calibration from our own Lean outcomes; order only until then | with J2 | medium |
| J5 | Ablation line `D1`, per site | Task 14 | medium |

## J1. Site tags on model calls

Add `site: string` to `LlmRequest` (`@seshat/lines`) and to the `model_call.finished` event
(`packages/orchestrator/src/llm.ts`), e.g. `prover.session`, `graph.attempt`, `abduction.rerank`,
`conjecture.relevance`, `fidelity.review`. `harness ablate` reports spend per site. This tells us the
share of the budget that decisions take, which caps what any cheaper decision backend can save.
Useful without Jev.

Tests: the tag reaches the event; the ablation table splits cost by site.

## J2. The `decide` capability

A capability (registry manifest, contract tests) with one call:

```ts
decide({
  site: string,
  state: string,               // compact: goal + hypotheses, or a statement; never a whole packet
  question:
    | { type: "choice"; instructions: string; options: Record<string, string> }  // ≤ 255
    | { type: "score"; instructions: string; levels: string[] }                  // 2..10
    | { type: "noul"; instructions: string },
}): Promise<{ answer: string | number | boolean; probabilities: Record<string, number>;
              backend: "llm" | "jev" | "faux"; model: string; costUsd: number }>
```

Backends:
- `llm` (default): the line's model through `lineLlm`, schema-checked output (PC1), optionally
  `judge` voting (PC9) with the vote shares as `probabilities`.
- `jev`: OpenRouter's Decisions endpoint (`POST https://openrouter.ai/api/alpha/decisions`, model
  pinned, e.g. `typesafe/jev-1.14`, never the `latest` alias) or TypeSafe's API; its own small HTTP
  client, since pi-ai covers chat models, not this endpoint. Cost from `usage.cost`, charged to the
  problem's ledger. Requests over 32k tokens of state plus question are refused rather than sent in
  the slower, less accurate long-context mode.
- `faux`: scripted answers for tests.

Config: `decide.backend: llm | jev` (default `llm`), and `decide.sites.<site>: llm | jev | off` to
override per site. Missing key or unreachable host with `jev` selected: fall back to `llm` and
journal it, never fail the run.

Every decision is journaled (`decision.made`: site, backend, model snapshot, state hash, full
distribution, chosen answer) so it can be replayed and later labeled by outcome.

Docs: `documentation/decide.md`, including that proof states are sent to a third party when `jev`
is on.

Tests: contract tests for the three backends with the faux transport; fallback on a missing key;
the 32k refusal; ledger charging; journaling.

## J3. Call sites

Only these sites accept `decide`, each with the LLM as default:
1. **PC4.2 conjecture-pool relevance** (Task 13): a Score per conjecture on its statement alone,
   replacing the `judge` call when `jev` is on.
2. **Task 12 step 4, first-stage filter**: Jev cuts the candidate pool (e.g. 50 to 10) before the
   LLM rerank, which stays. Replacing the LLM rerank outright is a separate, later measurement.
3. **PC6.3 `prove.search`, non-LLM candidates only**: ordering candidates that come without a
   model call (battery tactics, mined tactics of PC12, library lemmas tried by `apply`, aesop rules).
   When a model already proposed the tactics, its rank is free and stays.
4. Optional, lower priority: **Task 8 cold start**, a Choice over strategy families turned into
   Beta pseudo-counts with a capped weight (default 2), so the journal dominates after a few
   attempts.

Forbidden for `decide` whatever the config (checked by the capability, not by convention): the
statement-fidelity review of PC9; anything Lean, a decision procedure or a tool can decide
(including "did this step make progress", which comes from `lean.goals`: open goals, closed
subgoals, term size); any status change; any generation.

## J4. Calibration

No threshold on raw probabilities from either backend until a reliability curve exists for that
site. Until then `decide` results are used only to order. The curve comes from the journal: a
decision is labeled by its Lean outcome (did the chosen or top-ranked candidate lead to a proved
subgoal within the problem). `harness ablate` prints the per-site reliability table and ECE.

## J5. Ablation line `D1`

`D1` = the cumulative config with `decide.backend: jev` on the J3 sites, compared with the same
config on `llm` at equal dollar budget. Per site: problems solved, dollars per solve, the site's
share of spend (J1), ranking quality against Lean outcomes (rank of the eventually successful
candidate), agreement between backends. A site keeps `jev` only if it solves at least as many
problems and costs less per solve; otherwise it reverts to `llm`. Marked "not run against real Jev"
until the environment allows `openrouter.ai` and a key is configured.

## Not adopted from the pasted analysis

- Jev "evaluating progress" of a step: computable from Lean, so no model at all.
- Trusting Jev's probabilities as calibrated (e.g. "92 % means trust it"): unsupported; RLCD is
  unpublished and independent ECEs range from 0.03 to 0.15.
- "Drastic" speed-up of the harness: savings are capped by the share of spend in decisions, which
  J1 measures first.
