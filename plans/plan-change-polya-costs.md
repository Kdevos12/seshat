# Plan change: provider-aware cost levers, cheap exact tools, an external bench, installable packs

Written 2026-10-28 by the thread "Trier méthodes Polya et leviers de coût", for the implementation
thread ("Brainstorm et revue critique"). It amends [seshat-plan.md](seshat-plan.md) and builds on the
approved [plan-change-memory-evolution.md](plan-change-memory-evolution.md) (PE5, Task 24) and
[plan-change-thinking-modes.md](plan-change-thinking-modes.md) (PC6). The decision matrix behind it,
with the sources and what was dropped, is `/mnt/project-files/research/matrice-polya-couts.md`
(French). Read against main at 68b098c.

Status: **approved by the user on 2026-10-28** ("intègre les points qui nous bénéficient au plan",
message cmsg_01Jryd7vSFN5UXiBr35Aon5E824vXtvZL8Ep8nUmX9eZbR, relayed by the coordinator). Reconcile
task numbers and statuses with main as it is now. The user also asks that Seshat stay modular (skills
and tools installable) and lean toward a lean, cache-friendly harness in the spirit of DeepSeek's.

Global Constraints apply unchanged: Lean is the only judge, a tool's output is `computed` at most
(Ruling 13), nothing is trained by us, every external tool is a capability, every mechanism that
spends is an ablation line that must earn its place, no model name or id in repository files (prices
and model ids live in host configuration, which is data).

## Summary

| # | Change | Task | Priority |
|---|---|---|---|
| PD1 | Price table and calendar in the host profile; cache accounting; `reasoning_content` safety; thinking settings that apply | Tasks 19, 24; shared `config/hosts` | high, before the first real run |
| PD2 | Append-only transcript as a packet mode, measured against the prefix + recompiled tail | Task 24 option, Task 14 | high (measure) |
| PD3 | Off-peak option for turns and runs | Task 17 follow-up | low, small |
| PD4 | Algebra tools: `grind` first, `GroebnerTactic` as an optional Lean package, no `polyrith` assumption | Tasks 6, 21 | medium |
| PD5 | CEGIS rule: the counterexample set goes back to the proposer | Task 13 (M8, M14), M16 | medium |
| PD6 | An external bench: the equational-theories data and judge from SAIR | Task 14 (after Tasks 6, 7) | low |
| PD7 | Installable packs: tools and skills with a manifest, `harness add` | new Task 27 | medium |
| PD8 | A k-NN over goal features for the battery order, only if data show a gap | Task 14 | conditional |

## PD1. Provider-aware cost: prices, cache accounting, reasoning content, thinking settings

Facts (the provider's pages, read 2026-10-28; they change, so they go in configuration, not code):
the latest DeepSeek API models are `deepseek-flash` and `deepseek-v4-pro`, 1M context; the cache is
automatic and prefix-based, a cache hit costs about 1/50 of a miss on Flash (about 1/30 on Pro) and
output costs more than a miss; prices halve off-peak (peak is 01:00 to 04:00 and 06:00 to 10:00 UTC on
weekdays, except Chinese public holidays). Usage reports `prompt_cache_hit_tokens` and
`prompt_cache_miss_tokens`. With tool calls, `reasoning_content` must be sent back in all later
requests or the API answers 400. In thinking mode, temperature and the penalties are ignored.

Changes:

1. A `pricing` section in `config/hosts/*.json` per model: dollars per million tokens for cache-hit
   input, cache-miss input, and output, plus an optional off-peak calendar (UTC windows, weekdays,
   multiplier). The orchestrator computes `attempt.charged` dollars from this table when it is
   present, and from pi-ai's own numbers otherwise. Reason: the cost fields shipped in the provider's
   own pi integration page are out of date against its pricing page, and `--turn-usd`, `problemUsd` and
   every ablation compare dollars. Additive: no table, today's behaviour.
2. Cache accounting: the report gives, per session, per line and per rung (PE4), the share
   `cacheRead / (cacheRead + miss)`, and the dollars saved against a no-cache price. Task 24 already
   reports cached input tokens; this adds the ratio and the money.
3. `reasoning_content` safety: any code that rewrites or compiles a session's message history (the
   Task 24 packet, a line's `transformContext`) keeps the reasoning field of assistant messages that
   belong to a tool-call loop and sends it back. Test against a fake OpenAI-compatible server that
   answers 400 when it is missing; the test fails today if a line rebuilds history without it.
4. Thinking settings: Task 19's sampled settings stay, but the adapter marks a setting as ignored by
   the model family (temperature in thinking mode), and the fleet does not spend a Thompson arm on
   an ignored setting. The settings that act are the thinking switch (on or off) and the effort level
   (the provider's `high` and `max`), both discrete, both learned as before. Where a family ignores
   temperature, diversity comes from the other levers PC6 already lists (premise count, rendering,
   diversity directive).

Tests: pricing from a host table, with the calendar at a peak and an off-peak instant (injected
clock); the ratio and savings in the report from a faux provider that reports cache tokens; the 400
test above; an ignored-setting case in the fleet.

## PD2. An append-only transcript mode, measured against the prefix and tail

Because the provider also creates cache units at the end of each model output, a session whose
messages are never rewritten gets cache hits on its whole history, not only on a frozen prefix. Task
24's packet is a prefix plus a tail recompiled for each request, which gives hits on the prefix only.

Add an option to Task 24's API: `packetMode: "prefix_tail"` (default, today's behaviour) or
`"append_only"` (the first request carries the compiled packet; later requests append the new tool
results and model output as they come; the packet is recompiled only at a session boundary, with the
"new since the session started" list going into the next session's prefix). Task 14 adds the
comparison to PE5's measurement: dollars per solve and solve rate, `prefix_tail` against
`append_only`, on the same seeds and budget, on a model family that caches output boundaries; the
context-rot side of the trade (a long append-only history) is read from the solve rate and the mean
context size, so the mode wins only if it does not lose on solves. Removed if it loses.

Tests: with a faux provider that reports cache hits by longest common prefix, the dollars and hit
ratio differ between the two modes on a scripted session; the history is byte-identical across
requests in `append_only`.

## PD3. Off-peak option

Consortium mode (Task 17) works in bounded turns, so a run that is not urgent can wait for cheap
hours. Option `--offpeak` (and `RunConfig.offpeak`): a turn or a session starts only when the host's
pricing calendar (PD1) says off-peak, otherwise it waits (a `turn.deferred` event with the next
start); `--offpeak-max-wait MINUTES` bounds the wait, after which it runs anyway. Default off. The
report says how much was run off-peak. Tests: with the injected clock, a turn started at a peak
instant is deferred to the next window; the wait bound; no pricing table, the option is rejected with
a message.

## PD4. Algebra tools without a `polyrith` assumption

1. Task 6's battery already lists `grind`; state in its documentation that `grind` carries a
   commutative-ring module that normalizes by a Gröbner basis (Lean reference, section on the
   algebraic solver), so polynomial identities with hypotheses are one of its jobs. The battery's
   tactic list is read from the host (what the host's Lean has), and `polyrith` is not assumed:
   whether it still exists in the pinned Mathlib is read from the host, not guessed.
2. Task 21's library set gets one optional entry, `GroebnerTactic` (github.com/WuProver/GroebnerTactic,
   Shen, Guo, Liu and Zhi, arXiv 2604.13514): tactics `gb_solve`, `idealeq` and `add_gb_hyp`, with
   SageMath or SymPy computing and Lean checking certificates in the kernel (remainder, ideal and radical
   membership, ideal equality). Its limits are recorded in the resolver's entry: lexicographic order
   only, polynomial rings over the rationals, an external CAS required, the Lean and Mathlib version it
   builds against to be pinned by the resolver. Offered to the battery only when the host has the
   package; its success is a `validate` submission like any tactic.

Tests: the battery omits a tactic the host lacks; the resolver entry resolves against a recorded
fixture; no Lean needed.

## PD5. The CEGIS rule

In M8 (hypotheses filtered by execution), M14 (Lakatos-style repair) and M16 (program search), the
counterexamples already found for a claim form a set that is part of the proposer's input, and a new
candidate is run against that whole set before anything else is spent on it (a candidate that fails a
known counterexample is dropped without a model-priced check). In M16 the set also goes into the
sampled prompt next to the scored programs. Every counterexample in the set is one a checker produced
(a fingerprint run, `plausible`, a finite model through Task 7), recorded with its source; a model's
claim of a counterexample is not in the set until a checker confirms it. No new line: it is a rule of
the three lines, with a counter (candidates dropped by the set, tokens saved against a baseline without
the set) in Task 14's table.

Tests: a scripted proposer that repeats a refuted candidate is stopped by the set; an unconfirmed
claim stays out of the set.

## PD6. An external bench from the equational-theories challenge

The SAIR Foundation (Terence Tao is a co-founder) runs an equational-theories challenge; it publishes
a benchmark dataset on Hugging Face (`SAIRfoundation/equational-theories-benchmark`), a Lean 4 judge
package (`stage2-judge`, Apache 2.0 on Reservoir: "true" needs a Lean proof, "false" a magma
countermodel), and a published solver (arXiv 2609.00706) that closes 1,889 rows of public sets with
a cheapest-first cascade and no model call. This is the thesis of lines M10 and M11, on an outside
set. Add to Task 14: a `bench-ext` source that reads this data and judge, to measure the battery, the
fingerprints and Mace4 and Vampire (Task 6) on implication problems and report the share closed
without a model, per step of plan §15's order. Conditions: after Tasks 6 and 7 merge; the dataset's
licence is not stated, so check it before copying any row into the repository (read it from a local
cache otherwise, never vendor it); no submission to the challenge is planned (its rules are unread).

Tests: a converter on three hand-written rows in the dataset's shape; nothing downloads in tests.

## PD7. Installable packs: tools and skills

The user's requirement: Seshat stays modular, with skills and tools that can be installed. The
registry already holds capabilities (manifest, contract, host profiles) and the tool library has three
access levels, with Global Constraint 16 bounding human-written skills (at most 3 loaded in full). What
is missing is the unit of installation. New Task 27 (after Task 11, owned by the main team; it touches
only the shared registry, additively):

1. A pack is a directory with `pack.json`: name, version, the capabilities it adds (each with its
   manifest), the skills it adds (name, description, file), the host requirements, and a declared
   trust class. A pack can never write a claim's status: a capability's output is `computed` at most
   (Ruling 13), and the manifest says so.
2. `harness add <path|git url>` validates the manifest and the contract tests the pack carries,
   writes it under the registry's pack directory, and records a `pack.installed` event (name,
   version, content hash) in the journal. `harness packs` lists them, `harness remove` removes one. A
   pack's tools join level 2 (`tool_search` or `codemode`) and never the level-1 declared set, because
   a changed declared set breaks the prompt cache; a pack that wants level 1 takes effect at the next
   session.
3. Skills from a pack count under Global Constraint 16 (at most 3 in full, others listed by name and
   description) and are human-written; nothing writes a skill from outcomes.
4. The pack's content hash is part of the run's recorded environment (like Task 21's lock hash), so a
   run is reproducible with the same packs.

Tests: a manifest with an invalid contract is refused; install, list and remove round-trip through the
journal; a pack's tool is not in the declared level-1 set; a pack that claims a status write is
refused; the 3-skill rule holds.

## PD8. A k-NN over goal features for the battery order (conditional)

Task 6 orders the battery by Beta posteriors per (domain, tactic). An online k-NN over cheap goal
features (head symbol, size, which domains the router fired) is allowed (no training by us), but it
adds nothing before there are real runs. After Task 14's real data: if the posteriors per domain leave
a gap against an oracle that picks the best tactic per goal in hindsight, add the k-NN as an orderer
(the injectable orderer of J3) and measure it at equal CPU. Otherwise it is not built.

## Not adopted (with the reason)

- Area method (no Lean port; the bench has no geometry), theory morphisms in MMT (a second
  ecosystem; homology detection is suspended, Ruling 20), VF2 (NP-complete; anti-unification and
  MAC/FAC already serve), lean-egg (deprecated by its authors in favour of `grind`).
- A learned model router, step-wise allocation by a trained policy, LLMLingua and a semantic cache:
  trained, or unsafe for exact mathematical statements. The exact goal cache (deep hash of the goal in
  its Lean context) is the cache we use.
- Sums of squares, Wu's method and structure transfer stay in "Later": they belong with the
  reformulation family of Polya tools the user asked for, after the core is ready.

## Measured later (all of it)

Nothing here has run against a real provider, Lean or model. The cache numbers are first estimates from
the provider's pages: they are checked on the first real run, with PD1's report, before any of PD2's
conclusions is used.
