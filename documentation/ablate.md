# Measuring the lines: `harness ablate`

Plan section 6 asks of every mechanism that it earn its place: a line that does not beat the one before it at equal budget leaves
the plan or gets simpler. `harness ablate` runs the configurations on the same problems at the same budget and puts the
measurements side by side. Everything it prints is read from the journals of the runs it makes (a pure function of events, so that
any tool that reads journals can print the same row): `measureRun` in `packages/orchestrator/src/measures.ts`.

Nothing here has run against a real Lean or model. The tests run the whole thing on the faux model and a simulated Lean; the numbers
a real run gives are the ones to read, and the first real run checks the ones this page marks as estimates.

## What is measured

One row per configuration. The columns of plan section 6:

| Column | Definition |
|---|---|
| Solved | Problems with a Lean-checked proof: certified (`proved`, `refuted`) or a candidate that passed the fast check. Certified ones are given apart. |
| Dollars and tokens per solve | The run's dollars, and input plus output tokens, over the problems solved. A configuration that solves nothing has none. |
| Redundant attempts | Of the attempts that carry a strategy label, the share that failed as an earlier attempt on the claim, or on an equivalent one, already had (`redundancy`, M1). |
| Mean context | Input tokens per model request of the provers' sessions, cached or not: the size of what the model was sent. |
| Tool definitions | Tokens of the tool declarations each session sent with every request (`attempt.finished.toolTokens`, `estimateTokens` of the names, descriptions and parameters of `lean_check`, the run's tools and the tools the lines opened; an upper bound). |
| Memory | The share of proofs that used an element of the memory, by kind. A proof is the problem's claim with a valid attempt; it used a `lesson` if the draw put unverified items in that session, a `library` lemma if the attempt's `library_use` node names one, a `schema` if M15 showed one to the session. A proof made by a line's submission, with no session, uses none. |
| Without a model | Of the subgoals (claims made by M12's sketches or joined by a `decomposes_into` edge) and of the conjectures (claims made by M8, M13, M14, M16), the number with a valid Lean check made by a line that calls no model (M10, M11), and the time of those lines' tool runs in milliseconds (the CPU cost). |
| Diversity | Distinct strategy labels and distinct sources (the provers, or the line that made the valid check) among the proofs, and the entropy in bits of the pairs. |
| Inductive hypothesis | The share of proofs whose chain of Lean-checked edges meets a settled claim that line M8 made. Inspirations are not measured: M7 and M9 are suspended (Ruling 20). |
| Spend by site | `siteSpend`: dollars, calls and share per site, the biggest first (J1), which caps what a cheaper decision backend can save. |
| Cache | The share of input read from the provider's cache and the dollars it saved, in all, per line and per ladder rung (PD1 item 2). It is checked on the first real run before any conclusion drawn from the packet modes is used. |
| Proofs per source | Proofs that use a declaration of the harness library, of each extra package, or of Mathlib (LC2). |
| Counterexample set | Candidates dropped by the set and the tokens saved against a baseline without it (`cegisCounter`, PD5), by line and by source. The tokens are an estimate. |

"Settled by a program" reads the actor of the validation (`line:M10`, `line:M11`); a claim closed by M12's subsumption is not counted
here. The shares are of the claims the run made, so a configuration without M12 has no subgoals and says so (`0/0`).
