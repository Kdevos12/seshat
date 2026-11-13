# Plan change: what Aletheia (Google DeepMind, arXiv 2602.10177) suggests for Seshat (AL1 to AL7)

Status: PARTLY APPROVED by the owner 2026-11-13 00:25 UTC: AL1 to AL5 ("Va pour AL1 à 5"). AL3 keeps
the default of this proposal (an informal-only result stays `open`, shown as a labelled hint), since the
owner did not choose `proved_informal`. AL6 was not approved and stays proposed; AL7 is no action.
Proposed the same day by the thread "Analyser Aletheia de Google DeepMind" (read-only on the repository
and the plan). Findings in French in `research/aletheia.md`.

## Evidence in one paragraph

Aletheia is an agent on an internal frontier model of its authors: a generator, a natural-language
verifier and a reviser loop until the verifier accepts or an unpublished attempt limit is reached,
with Google Search, browsing and Python; no Lean. The verifier sees only the final write-up, not the
generator's reasoning, and (for FirstProof) labels each candidate CORRECT, FIXABLE (sent to the
reviser) or WRONG (dropped). Results: 93% on IMO-ProofBench Advanced; of 700 open Erdős problems,
13 meaningfully correct answers (2 autonomous new solutions, 2 partial, 4 rediscoveries, 5
literature identifications) and 50 technically correct but vacuous ones, from reading the statement
the easiest way; FirstProof 6 of 10 by best-of-2, with 4 deliberate "no solution". Cost is never
given in dollars and is described as not controllable. The one useful ablation: on the 13 Erdős
problems, the base model alone solved 8 at about twice the compute per problem. No
code or system prompts are released (only problem statements and outputs). Aletheia, Numina and
Goedel-Architect now agree independently that a verified informal proof loop is the main lever:
NL2, already approved in Task 51.

## Changes

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| AL1 | MOD of NL2 | The verifier returns `correct`, `fixable` or `wrong` with its findings. `fixable` goes to the revision; `wrong` starts a fresh generation (the rejected proof is not shown to it, only a one-line note that an approach failed and why); `correct` counts toward the k passes. The verifier's input is the final proof text only: no reasoning content, no earlier rounds. | Faux-provider tests: each verdict routes as stated; the verifier's request carries no reasoning content; the round cap holds. |
| AL2 | MOD of Task 39 roles | When the host configures a model of another family than the generator's, the NL2 verifier role defaults to it; otherwise the same model in a fresh context, as NL2 says. Priced by the gate like any role. | An arm against same-model verification at the same cap; the report counts verifier verdicts per model. |
| AL3 | ADD, no model call | `solve`'s RESULT and the run report show an NL2-accepted informal proof under "Not checked by Lean" when no Lean proof was certified, with its verifier passes and models. When NL2 accepted nothing, the RESULT says "no solution found" and shows no best attempt. The claim's status does not change (it stays `open`); the proof stays a journaled hint. | Tests: accepted proof shown with its label; rejected attempts never shown; the claim's status unchanged. |
| AL4 | ADD to Task 36 intake | When `solve` formalizes a statement given in natural language, the formalizer lists the readings it sees (quantifiers, conventions, ranges). With more than one non-vacuous reading: in a run with a person, a breakpoint asks once; otherwise the strongest non-vacuous reading is chosen and the RESULT names the others. Uses the call intake already makes. | Test with a scripted ambiguous statement: the readings are journaled, the breakpoint fires with a person, the RESULT names the reading chosen. |
| AL5 | ADD, no model call | An interaction card in the RESULT and the run report, built from the journal: who supplied what (the statement, a person's sketch, consortium answers, breakpoint answers, literature hits, each model and its cost), an autonomy level (A: nothing from a person but the statement; C: a person's mathematical input; H: the person proved and Seshat checked), and a literature outcome (a `settled` hit, "not found in the sources searched", or search off). Seshat never claims novelty or significance: those stay for a human expert. | Tests: each level from a scripted journal; a run with `--private` says "search off". |
| AL6 | ADD to the bench | A bench tag `erdos-aletheia` for those of Aletheia's 13 meaningful Erdős problems (333, 397, 591, 652, 654, 659, 705, 935, 992, 1040, 1051, 1089, 1105) whose statements the formal-conjectures checkout holds, found without a model call. Reported apart and marked contaminated (solutions public since January 2026): a probe of what Seshat certifies at a small cap, never a novelty claim. | The tag in the bench index with the list of ids found; one smoke run only on the owner's yes and a dollar cap. |
| AL7 | none | Not taken: compute at its scale and best-of-2 over model snapshots (budget); tool-use training (API-only constraint); accepting a proof on an LLM verifier's word (Lean is the judge); FirstProof as a bench (not formalized, graded by experts). | |

## Order

AL1 and AL2 with NL2 when Task 51 builds PA13 (they change its shape, not its cost). AL5 any time
(journal only, helps the paper). AL3 right after NL2. AL4 with the next change to intake. AL6 when
the bench index is next touched; its smoke run only on request.

## Open questions for the owner

1. Settled by default (2026-11-13): AL3 keeps `open`. Was: AL3: keep an informal-only result at `open` with a labelled hint (default here), or mark the
   claim `proved_informal` after k verifier passes. The second changes what a status means for a
   student reading the RESULT; it is a trust rule, so it is the owner's call.
2. AL6: one smoke run on the Aletheia Erdős subset (a few problems, $0.50 each), or not.
