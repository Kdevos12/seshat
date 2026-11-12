# Plan change: what Numina-Lean-Agent (arXiv 2601.14027) suggests for Seshat (NL1 to NL7)

Status: PARTLY APPROVED by the owner 2026-11-12 21:10 UTC: NL1, NL2, NL3 and NL5 ("ça me va", on
the summary listing them). NL4 and NL6 were not asked about by name and stay proposed; NL7 is no
action. Proposed the same day by the thread "Étudier l'article arXiv 2601.14027" (read-only on the
repository and the plan). Findings in French in `research/numina-lean-agent.md`.

## Evidence in one paragraph

Numina-Lean-Agent (Project Numina, January 2026, MIT code, ICML 2026) is a harness, not a model: a
general coding agent on a frontier model with an MCP tool server (lean-lsp-mcp,
LeanDex semantic search, an informal prover, a `discuss_partner` that asks another model) and
skills. No training. Putnam 2025: 12/12, at a budget of about $50 per problem ($300 for B6, $1,000
for A5), about 65 hours for the twelve, run sequentially. Its ablation: 4/12 without the informal
prover, 11/12 with it, 12/12 with sub-agents per lemma; on B4, iterative generator/verifier
refinement finishes in 5 rounds where independent sampling fails in 10 at an equal call budget. No
PutnamBench or miniF2F numbers, no open base model. It does not explain the gap with Goedel-Architect
(different models, about 700 times Seshat's budget), but it independently confirms PA13 as the main
lever and says how to build it.

## Changes

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| NL1 | MOD | `solve-v2` gives `lean.lsp` (goal, diagnostics, `multi_attempt`) to the prover by default, behind the host's environment check; `--no-tool lean.lsp` turns it off. | An arm against v2-fixed; the report counts `lean.lsp` calls. |
| NL2 | MOD | PA13's informal step is a refinement loop: generator, then a verifier in a fresh context, then a revision that reads the previous proof and the verifier's findings; accepted after k independent verifier passes (default 3, as Numina), at most N rounds (default 4), each round priced by the gate. The accepted proof is a hint journaled as such: it never changes a claim's status. | Test with the faux provider: a rejected proof is revised, an accepted one needs k passes, the cap holds. |
| NL3 | ADD | A tool `consult` for the prover: one question to another configured model (a Task 39 role), capped per session and journaled; its answer is text in the prover's context only. | Test: the cap, the journal entry, no status change. |
| NL4 | ADD | Blueprints and PA11: a hole that fails twice gets an informal hint from the `consult` role before the next formalization attempt. | Test on a scripted blueprint with one stubborn hole. |
| NL5 | ADD | LeanDex as a `lean.search` backend, after a free real probe recorded as a fixture (as PA3 did). | Fixture and `harness doctor` line. |
| NL6 | NEW | An external baseline arm outside Seshat's code: the Numina agent run with the provider's small model through DeepSeek's Anthropic-compatible API, on the same problems and the same cap per problem, with Seshat (or the account balance) holding the cap. Its proofs go through Seshat's certifier before they count. | Owner's yes and a dollar cap first; a report beside the paired protocol. |
| NL7 | none | `code_golf` and the AXLE skills (`sorry2lemma`, `disprove`, `verify-proof`): out of scope or covered by Task 38's repair pass and "test before prove". | |

## Order

NL2 with PA13 and NL1 first (cheap, they strengthen what is approved), then NL3 and NL4 with PA11,
NL5 when `lean.search` is next touched, NL6 only on the owner's request.

## Open question for the owner

NL6: run the Numina agent on the provider's small model as an external baseline (a few dollars on a few
problems), or not.
