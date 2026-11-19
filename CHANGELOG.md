# Changelog

Each version of Seshat, newest first. A version is archived on Zenodo when it is released
([10.5281/zenodo.24354662](https://doi.org/10.5281/zenodo.24354662) points to the latest).

## 1.0.0-beta.2 (unreleased: pull request #8)

Long proofs as chains of short ones that Lean checks one at a time, and a cheap Lean-only first draft. Every new
behaviour is an option, off by default: `v1` and `v2` run as in 1.0.0-beta.1.

- Proof lengths in `harness audit` (a "Length" section and `length.json`), and the output tokens of each role split
  into thinking, text and tool-call arguments.
- `RunConfig.longProof`: a `have` sketch written from the accepted informal proof, its holes lifted by Lean's
  `extract_goal` into `aux_` lemmas, several drafts ranked by the holes left, proved links frozen into a locked prefix
  that Lean still checks whole, a `long` triage class with a gate that follows the frontier's growth, verdict reasons
  for holes, one continuation for a hole cut by its turns, and hole sessions with the battery, search, library and
  their informal step.
- `RunConfig.leanDraft` (experimental): before a problem's probe, one completion in Lean only, checked by Lean, cut at
  its first error, resumed once, then the battery.
- The fleet's `bucketPrior` (session modes and thinking levels learned across similar problems, as the heuristic cards
  are) and `switchOnStall` (the next session leaves out the mode and level of a session Lean showed stuck).
- Hole sessions save their transcripts.
- New arms of `solve-defaults`: `solve-v2-long`, `solve-v2-long-draft`, `solve-v2-fleet-modes`.
- Plan changes: `plans/plan-change-long-proofs.md`, `plans/plan-change-decomposition-provers.md`,
  `plans/plan-change-chain-of-lean.md` (Rulings 43 to 45).

Not yet run against a real Lean or model at the time of writing; the first measurements are in the ledger.

## 1.0.0-beta.1 (2026-11-18)

The first public release: the core loop (`harness solve` with a real model and Lean 4.27.0, the fast check, the
certifier's kernel replay, the budget gate, the tactic battery, Lean's language server and search) and the research
lines built and tested against a simulated Lean and model. [10.5281/zenodo.24354663](https://doi.org/10.5281/zenodo.24354663).
