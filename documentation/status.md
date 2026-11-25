# Status: beta

Seshat is in beta (version 1.0.0-beta.2): its core loop runs for real and is used, and many of its research lines
are built and tested but have not yet run against a real Lean and a real model. This page says which is which. A
part that runs for real for the first time moves from the second list to the first, and its figure and its node in
the README's diagram change with it ([figures.md](figures.md)).

## What runs for real

With Lean 4.27.0, a model through its API and the certifier in a sandbox:

- `harness solve`, from a statement in prose or in Lean to `RESULT.md`, on competition problems;
- the fast check in a Kimina Lean server, and the certifier's kernel replay, the only way to `proved`;
- the classical tactic battery before any model (line M10), the failure memory and the escalation of sessions
  (lines M1 and M6), and blueprints with refinement rounds, the repair pass and the informal proof first (line M12);
- the variant graph and the context compiler (lines M2 and M4), in a first short run;
- long proofs (`RunConfig.longProof`, the arm `solve-v2-long`), in a first short run; the lifting of a `have` sketch
  into lemmas by Lean's `extract_goal` was then checked on that run's real drafts, not yet inside a run;
- the budget gate and the probe, Lean's language server (`lean.lsp`) and Mathlib search (`lean.search`);
- the intake's literature search, and the graded bench, admitted by Lean;
- `harness ablate`, which compares configurations on the same problems at the same budget.

## What is built and tested with simulations only

Written against its interface and tested with a simulated model, a simulated Lean, fake servers and pi-ai's faux
provider: lines M3, M5, M8, M11 and M13 to M18, the consortium turns and the consolidation pass, the heuristic card
bank and its measurement, the fleet's mode banks (`bucketPrior`, `switchOnStall`), the Lean-only first draft
(`leanDraft`, experimental), `consult`, ATP and SMT with reconstruction, the LibraryBuilder, and campaigns. The
README's diagram marks each node: run for real (green), built (blue), waiting for something real (orange), or
planned (grey).

## Known limits

- The measurements so far are small, and Putnam problems have public Lean proofs that a model may have seen: they
  show that the loop works and what it costs, not how it compares with other systems.
- A `partial def` in a candidate proof is refused by the certifier.
- The Kimina server's memory grows with use; `harness doctor` advises settings for the machine, and
  `scripts/kimina.sh` applies them ([install.md](install.md#3-the-kimina-lean-server)).
