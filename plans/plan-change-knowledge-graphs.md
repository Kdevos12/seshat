# Plan change: knowledge graphs for research, after six papers (KG1 to KG4)

Status: PROPOSED 2026-11-12 by the thread "Revoir l'usage des graphes de connaissances" (read-only
on the repository and the plan). KG1 APPROVED in a reduced form by the owner 2026-11-12 22:01 UTC
("Faisons un KG1 réduit, avec moins de problèmes, je suis sur un budget en ce moment"): the arm on 4 to
5 of the Task 50 replay's problems, reusing that replay's v2 results, hard ceiling $1; a smoke test,
not a win-rate measure. KG2 to KG4 await the owner. Findings in French in
`research/graphes-connaissances-revue.md`.

## Evidence in one paragraph

Seshat's graph core is built but has never run against a real model: the three arms of the third
real run enabled M1 and M10 (plus M6, and M12 in the blueprints arm), never M2 (graph, propagation on
`lean_checked` edges) or M4 (context compiler, `graph_query`, neighbourhood widened by one hop after
each failed session). Six papers were read: KG-RAR (arXiv 2503.01642), KG-Prover (2503.11657),
AutoMathKG (Computational Intelligence e70096, arXiv 2505.13406), Numina-Lean-Agent (2601.14027,
reviewed in `plan-change-numina.md`), KGA-ECoT (2508.04072) and DuoFlow-KG (Sci. Rep. 16:31005,
abstract only). None retrieves over verified edges. Gains of graph retrieval in context shrink as the
model gets stronger: KG-RAR is negative under 1.5 B parameters and +3% relative at 7 B; KG-Prover adds
6 to 11 points on miniF2F for general models but 2 to 4.5 for Lean provers; KGA-ECoT's graph ablation
is better without the graph in 5 cells of 12, while code execution carries the gain. AutoMathKG fine-tunes
its Math LLM and merges entities by LLM judgment, both excluded here. The proven levers are an informal
proof first and tools that are actually called; a graph helps when it feeds those steps.

## Changes

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| KG1 | MOD | A `solve-defaults` arm `solve-v2-graph` = `v2` + M2 + M4, run against `v2` on the bench of the Task 50 replay, same cap per problem. The report adds M4's counts (packet tokens, `expand` and `graph_query` calls, facts shown, depth widenings) and M2's (variants, `lean_checked` edges, derived proposals accepted by `validate`). | Test with the faux provider that the arm enables both lines and the counts appear. Real run only with the owner's yes and a dollar cap (about $1.35 for 20 problems at $0.50), after Task 50. |
| KG2 | NEW | A capability `kb.informal`: first backend a local, offline index of NaturalProofs (Zenodo, about 30,000 theorems with proofs and 15,000 definitions from ProofWiki, the Stacks project and textbooks, with their reference links; pinned version, licences per source), searched lexically and by symbol, no model call; second backend TheoremGraph (REST or MCP `theorem_search`) for research-level statements, its edges marked unverified. Task 39's informal step receives the top neighbourhood of the problem's concepts, widened by one link after each rejected informal proof (as KG-Prover). Text from it is a hint, journaled with its source page; it never changes a claim's status and passes the strict screen. | Manifest, contract test on a fixture dump, `harness doctor` line; an arm of Task 39 with and without it once Task 39 runs for real. |
| KG3 | ADD | The compute tool of `v2` gains a function index of Sage and SymPy (name, signature, one-line doc, from the installed version's own documentation), returned by a `compute.lookup` call or attached when a compute call fails on an unknown name. | Contract test on a recorded index; the report counts compute calls and lookups; measured after PA1. |
| KG4 | MOD | M4 tuning, only if KG1 shows M4 helps: filter facts by the bench's domain tags before scoring (KG-RAR's hierarchy), an MMR diversity pass over the facts shown (DuoFlow-KG's sampling, without its learned part), and facts queried from the current hole of the sketch rather than the session's goal (KG-RAR's step retrieval, LemmaHead's re-query). Both off by default, line options. | Unit tests on near-duplicate facts; an ablation arm. |

## Not adopted

- Building a knowledge graph with a model (AutoMathKG, KG-RAR's construction): unverified edges, the
  MathKG caution; Seshat's edges are proposed and only `lean_checked` ones propagate.
- Any learned component: AutoMathKG's LoRA-tuned Math LLM, DuoFlow-KG's weakly supervised sampler.
- A model as a step judge (KG-RAR's PRP-RM): Lean judges.
- Merging statements by model judgment: identity stays M1's canonical hash.

## Order

After Task 50 and Task 39 (PA13, NL2): KG1 first (it costs no code beyond an arm), then KG2 with Task
39's real run, then KG3; KG4 only on KG1's evidence. Small agents, one or two at a time.
