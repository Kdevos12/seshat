# References

The papers, books and tools Seshat draws on, and what it takes from each. Seshat trains no model, so
nothing here is a learned component: what it takes is a loop, a data structure, an algorithm, a
default, or a measurement that settled a design choice.

Each entry gives the work, then **Takes**: what Seshat uses from it, and **In**: where that lives in
the code, the documentation or the plan (plan-change items such as `PC6` or `CA9` are in
[plans/](plans/seshat-plan.md)). A few entries are marked **Evidence**: they are cited because one
of their measurements decided a default or ruled out a design, not because Seshat copies a
mechanism.

How the list was checked: every arXiv identifier below was looked up on arXiv on 2026-11-18, and
the title, first authors and date were compared with what is written here. Books, journal papers
and software were checked against their publisher or home page. An entry that could not be checked
says so. Several of the works are 2026 preprints that have not been peer reviewed; their numbers
are quoted as their authors report them.

This file is about sources. How to cite Seshat itself is in the [README](README.md#citing-seshat)
and [CITATION.cff](CITATION.cff).

Contents:
[1. The judge: Lean and its tooling](#1-the-judge-lean-and-its-tooling) ·
[2. Baselines and benchmarks](#2-baselines-and-benchmarks) ·
[3. The proving loop](#3-the-proving-loop) ·
[4. Agents, the fleet and trust between agents](#4-agents-the-fleet-and-trust-between-agents) ·
[5. Memory, the claim graph and context](#5-memory-the-claim-graph-and-context) ·
[6. Classical tools and algorithms](#6-classical-tools-and-algorithms) ·
[7. Conjecturing, search over programs, repair](#7-conjecturing-search-over-programs-repair) ·
[8. The heuristic card bank](#8-the-heuristic-card-bank) ·
[9. Budgets, long runs, prompts and decisions](#9-budgets-long-runs-prompts-and-decisions) ·
[10. Literature search](#10-literature-search) ·
[11. Read and not built](#11-read-and-not-built)

## 1. The judge: Lean and its tooling

- **Lean 4.** Leonardo de Moura and Sebastian Ullrich (2021). *The Lean 4 Theorem Prover and
  Programming Language.* CADE-28, LNCS 12699, pp. 625–635.
  **Takes:** the judge. Only a Lean check makes a claim `computed`, and only the certifier's kernel
  replay makes it `proved` or `refuted`. **In:** [documentation/trust.md](documentation/trust.md),
  [documentation/lean.md](documentation/lean.md); `grind`, `omega`, `decide` and `bv_decide` are tactics of the classical battery.
- **Mathlib.** The mathlib Community (2020). *The Lean Mathematical Library.* CPP 2020,
  doi:10.1145/3372885.3373824; arXiv:1910.09336.
  **Takes:** the library every problem imports, and its declarations as the premises the context
  compiler ranks. **In:** [documentation/lean-env.md](documentation/lean-env.md),
  [documentation/context.md](documentation/context.md).
- **lean4checker** (software, github.com/leanprover/lean4checker) and **SafeVerify** (software,
  github.com/GasStationManager/SafeVerify).
  **Takes:** the certifier replays the candidate's declarations through the kernel
  (`Lean.Environment.replay`) as lean4checker does, and compares the candidate with the reference
  statement, axioms and unsafe or partial constants as SafeVerify does. **In:**
  [documentation/certifier.md](documentation/certifier.md), `packages/core/src/lean.ts`.
- **Kimina Lean Server.** Marco Dos Santos, Hugues de Saxcé, Haiming Wang et al. (2025). *Kimina
  Lean Server: A High-Performance Lean Server for Large-Scale Verification.* arXiv:2504.21230.
  **Takes:** the fast check, `lean.check`: a pool of Lean REPLs with a cache of import headers,
  behind a REST call. **In:** [documentation/lean.md](documentation/lean.md),
  `capabilities/lean.check`.
- **Pantograph.** Leni Aniva, Chuyue Sun, Brando Miranda et al. (2024). *Pantograph: A
  Machine-to-Machine Interaction Interface for Advanced Theorem Proving, High Level Reasoning, and
  Data Extraction in Lean 4.* TACAS 2025; arXiv:2410.16429.
  **Takes:** goal states, tactics on one goal at a time, and the goals of a sketch with `sorry`
  holes. **In:** `lean.goals` and `lean.meta`,
  [documentation/lean-meta.md](documentation/lean-meta.md), the tactic search of
  `packages/classical/src/search.ts`.
- **lean-lsp-mcp** (software, github.com/oOo0oOo/lean-lsp-mcp).
  **Takes:** the shape of the `lean.lsp` capability (goals at a position, diagnostics, several
  tactics tried at once, search) that provers call during a session. **In:**
  [documentation/lean-lsp.md](documentation/lean-lsp.md), plan change PC7 (Task 16).
- **LeanSearch and Loogle** (services, leansearch.net and loogle.lean-lang.org).
  **Takes:** two of the backends of `lean.search`, beside a local BM25 index over exported
  declarations. **In:** [documentation/lean.md](documentation/lean.md), plan change CA22.
- **LeanDojo.** Kaiyu Yang, Aidan M. Swope, Alex Gu et al. (2023). *LeanDojo: Theorem Proving with
  Retrieval-Augmented Language Models.* NeurIPS 2023 Datasets and Benchmarks; arXiv:2306.15626.
  **Takes:** the accessibility filter: a premise the problem's file cannot import is never offered.
  **In:** `packages/context/src/access.ts`, plan change PC5.

## 2. Baselines and benchmarks

- **AlphaProof Nexus.** George Tsoukalas, Anton Kovsharov, Sergey Shirobokov, Anja Surina, Moritz
  Firsching, Gergely Bérczi et al. (2026). *Advancing Mathematics Research with AI-Driven Formal
  Proof Search.* arXiv:2605.22763.
  **Takes:** the baseline M0 is its basic agent (A), rebuilt on pi: independent provers in fresh
  sessions on a Lean sketch with editable regions and `sorry` holes, where only the file and notes
  cross sessions; the cost-to-first-success protocol in chunks of parallel provers; the random
  diversity directives given to sessions; the failure mode of an auxiliary lemma that restates the
  target (detected as `restates_target`). **In:** [documentation/m0-loop.md](documentation/m0-loop.md),
  [documentation/ablate.md](documentation/ablate.md) (`chunkCurves`),
  `packages/fleet/src/settings.ts` (PC6 directives), [documentation/bench.md](documentation/bench.md).
- **AlphaProof.** Thomas Hubert, Rishi Mehta, Laurent Sartran, Miklós Z. Horváth et al. (2025).
  *Olympiad-level formal mathematical reasoning with reinforcement learning.* Nature,
  doi:10.1038/s41586-025-09833-y.
  **Takes:** the idea of its test-time curriculum (variants of a hard target, easier first), without
  the reinforcement learning: Seshat proves variants and feeds what they prove back. **In:**
  [documentation/curriculum.md](documentation/curriculum.md), plan change PE7.
- **formal-conjectures** (dataset, github.com/google-deepmind/formal-conjectures).
  **Takes:** the research-level grade of the bench (Erdős problems, OEIS conjectures and others,
  stated in Lean). **In:** [documentation/bench.md](documentation/bench.md).
- **PutnamBench.** George Tsoukalas, Jasper Lee, John Jennings et al. (2024). *PutnamBench:
  Evaluating Neural Theorem-Provers on the Putnam Mathematical Competition.* NeurIPS 2024 Datasets
  and Benchmarks; arXiv:2407.11214.
  **Takes:** the competition grade of the bench (a fixed, seeded sample). **In:**
  [documentation/bench.md](documentation/bench.md), plan change CA1.
- **Erdős case study.** Tony Feng, Trieu Trinh, Garrett Bingham et al. (2026). *Semi-Autonomous
  Mathematics Discovery with Gemini: A Case Study on the Erdős Problems.* arXiv:2601.22401.
  **Evidence:** 9 of the 13 meaningful results already existed in the literature, and most
  technically correct answers solved a misread statement. This put literature search and statement
  hygiene before paid proving, and two heuristic cards cite it. **In:** plan changes CA16 and LW1,
  [documentation/literature.md](documentation/literature.md), `packages/heuristics/src/builtin.ts`.

## 3. The proving loop

- **Ax-Prover.** Benjamin Breen, Marco Del Tredici, Jacob McCarran et al. (2025). *Ax-Prover: A Deep
  Reasoning Agentic Framework for Theorem Proving in Mathematics and Quantum Physics.*
  arXiv:2510.12787.
  **Takes:** a general model with Lean tools and no training (sketch, `have ... := sorry`, fill the
  holes, a verifier that never edits) is the M0 loop; its jump from 5% to 51% with tools is why
  provers get `lean.lsp` by default. **In:** plan change PC7, NL1;
  [documentation/lean-lsp.md](documentation/lean-lsp.md).
- **A minimal agent.** Borja Requena, Austin Letson, Krystian Nowakowski et al. (2026). *A Minimal
  Agent for Automated Theorem Proving.* arXiv:2602.24273.
  **Takes:** premise search pushed by the harness before the model asks, since hallucinated names
  are a large share of cheap models' errors; an unknown name in a check triggers `lean.search`.
  **In:** plan change CA22, [documentation/lean.md](documentation/lean.md).
- **Goedel-Architect.** Jui-Hui Chung, Ziyang Cai, Zihao Li et al. (2026). *Goedel-Architect:
  Streamlining Formal Theorem Proving with Blueprint Generation and Refinement.* arXiv:2606.06468.
  **Takes:** the blueprint loop of line M12: a dependency graph of lemma statements, one prover per
  lemma that sees only that lemma and its dependencies, a verdict per failed lemma
  (`statement_wrong` or `proof_too_hard`), and a refinement that keeps what was proved. **In:**
  [documentation/scheduler.md](documentation/scheduler.md#blueprints-plan-change-ca9), plan changes
  CA9 to CA12.
- **Hilbert.** Sumanth Varambally, Thomas Voice, Yanchao Sun, Zhifeng Chen, Rose Yu, Ke Ye (2025).
  *Hilbert: Recursively Building Formal Proofs with Informal Reasoning.* arXiv:2509.22819.
  **Takes:** informal decomposition into Lean subgoals, and the cap on decomposition depth at 3
  (depth 2 and 3 score almost the same). **In:** plan change CA12.
- **APOLLO.** Azim Ospanov, Farzan Farnia, Roozbeh Yousefzadeh (2025). *APOLLO: Automated LLM and Lean
  Collaboration for Advanced Formal Reasoning.* arXiv:2505.05758.
  **Takes:** the repair pass: the blocks of a failing proof are cut to `sorry` and automation is
  tried on each hole before any model call. **In:**
  [documentation/scheduler.md](documentation/scheduler.md) (repair pass, Task 38), plan change CA13.
- **Delta Prover.** Yichi Zhou, Jianqiu Zhao, Yongxin Zhang et al. (2025). *Solving Formal Math
  Problems by Decomposition and Iterative Reflection.* arXiv:2507.15225.
  **Evidence:** iterating on compiler feedback beats independent samples at an equal number of
  calls; Seshat iterates within a session before it decomposes. **In:** the evidence section of
  plan change CA.
- **Seed-Prover.** Luoxin Chen, Jinming Gu, Liankai Huang et al. (2025). *Seed-Prover: Deep and Broad
  Reasoning for Automated Theorem Proving.* arXiv:2507.23726.
  **Takes:** lemma-first refinement (an outer loop on the theorem, an inner loop on each lemma it
  fails, proved lemmas fed back) and a scored conjecture pool, without the trained prover. **In:**
  plan change PC4 (Tasks 10 and 13), [documentation/induction.md](documentation/induction.md).
- **Draft, Sketch, and Prove.** Albert Q. Jiang, Sean Welleck, Jin Peng Zhou et al. (2022). *Draft,
  Sketch, and Prove: Guiding Formal Theorem Provers with Informal Proofs.* ICLR 2023;
  arXiv:2210.12283.
  **Takes:** an informal proof drafted before the formal sketch. **In:** plan change PC11,
  [documentation/informal.md](documentation/informal.md).
- **ProofFlow.** Rafael Cabral, Tuan Manh Do, Xuejun Yu et al. (2025). *ProofFlow: A Dependency Graph
  Approach to Faithful Proof Autoformalization.* arXiv:2510.15981.
  **Takes:** the informal argument as a DAG of steps, checked for cycles and forward references,
  each step a standalone lemma. **In:** `packages/fleet/src/dag.ts`,
  [documentation/fleet.md](documentation/fleet.md), plan change PC11.
- **MathCoPilot.** Junjie Zhang, Jiayu Liu, Wenbin Liu et al. (2026). *MathCoPilot: An Interactive
  System for Human-AI Symbiotic Paradigm of Mathematical Research.* arXiv:2607.14582.
  **Evidence:** natural language first did better than formal first on its subset; Seshat has an
  informal-first session mode that the fleet draws like any other setting. **In:** plan change PC11,
  [documentation/fleet.md](documentation/fleet.md).
- **Numina-Lean-Agent.** Junqi Liu, Zihao Zhou, Zekai Zhu et al. (2026). *Numina-Lean-Agent: An Open
  and General Agentic Reasoning System for Formal Mathematics.* arXiv:2601.14027.
  **Takes:** a verified informal proof before the Lean work, as a loop of generator and verifier
  rounds; Lean's language server for the prover by default; a `consult` tool; a LeanDex-style
  search backend. **In:** [documentation/informal.md](documentation/informal.md), plan change NL1,
  NL2, NL3 and NL5.
- **Aletheia.** Tony Feng, Trieu H. Trinh, Garrett Bingham et al. (2026). *Towards Autonomous
  Mathematics Research.* arXiv:2602.10177.
  **Takes:** the verifier reads only the final write-up and answers `correct`, `fixable` or
  `wrong`; a verifier from another model family when one is configured; abstention, with an informal
  result shown as not checked by Lean and the claim left `open`; the readings of a statement listed
  at intake. **In:** [documentation/informal.md](documentation/informal.md), plan change AL1 to AL5.
- **Observation masking.** Tobias Lindenbauer, Igor Slinko, Ludwig Felder et al. (2025). *The
  Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context
  Management.* arXiv:2508.21433.
  **Takes:** old check results are masked in a session's context instead of summarized by a model.
  **In:** the `solve-v2` defaults ([documentation/ablate.md](documentation/ablate.md)),
  [documentation/m0-loop.md](documentation/m0-loop.md), plan change CA6.
- **LEAP.** Po-Nien Kung, Linfeng Song, Dawsen Hwang et al. (2026). *LEAP: Supercharging LLMs for
  Formal Mathematics with Agentic Frameworks.* arXiv:2606.03303.
  **Evidence:** a shared graph memory of subgoals beats a tree; Seshat's canonical claim identity
  (line M1) is what lets sessions share one. **In:** the evidence section of plan change CA, line M1
  ([documentation/m1-identity-memory.md](documentation/m1-identity-memory.md)).

## 4. Agents, the fleet and trust between agents

- **pi** (software, the npm packages `@earendil-works/pi-ai`, `pi-agent-core` and `pi-mcp`; MIT).
  **Takes:** the model clients, the agent loop and MCP; Seshat is not a fork, it depends on these
  packages and builds its own orchestration on top. **In:** `packages/models`,
  [documentation/architecture.md](documentation/architecture.md).
- **Scaling agent systems.** Yubin Kim, Ken Gu, Chanwoo Park et al. (2025). *Towards a Science of
  Scaling Agent Systems.* arXiv:2512.08296.
  **Evidence:** independent agents amplify errors and centralized validation contains them; Seshat
  has independent provers and one judge (Lean), never agents that validate each other. **In:** plan
  §11 (fleet), [documentation/fleet.md](documentation/fleet.md).
- **Debate.** Andrea Wynn, Harsh Satija, Gillian Hadfield (2025). *Talk Isn't Always Cheap:
  Understanding Failure Modes in Multi-Agent Debate.* arXiv:2509.05396. And Andries Smit, Paul
  Duckworth, Nathan Grinsztajn et al. (2023). *Should we be going MAD? A Look at Multi-Agent Debate
  Strategies for LLMs.* ICML 2024; arXiv:2311.17371.
  **Evidence:** debate moves agents from right to wrong as often as the reverse and does not beat
  self-consistency at equal cost; Seshat has no debate, only independent opinions and a checker.
- **Self-correction.** Jie Huang, Xinyun Chen, Swaroop Mishra et al. (2023). *Large Language Models
  Cannot Self-Correct Reasoning Yet.* ICLR 2024; arXiv:2310.01798.
  **Takes:** every revision starts from external feedback (a Lean error, a computation, a
  counterexample), never from "check your work".
- **MAST.** Mert Cemri, Melissa Z. Pan, Shuyi Yang et al. (2025). *Why Do Multi-Agent LLM Systems
  Fail?* arXiv:2503.13657.
  **Takes:** its failure taxonomy; step repetition and ignored stopping conditions became the
  loop detectors that stop a session (`strategy_loop`) and the redundant-attempts metric. **In:**
  plan change PC1, [documentation/guards.md](documentation/guards.md),
  [documentation/m1-identity-memory.md](documentation/m1-identity-memory.md).
- **MechMath Agent Team.** Yichuan Cao, Ruichen Qiu, Junqi Liu et al. (2026). *MechMath Agent Team:
  LLM Driven Agents for Mathematical Research.* arXiv:2607.04394.
  **Takes:** a global execution DAG and a task ledger written only by the orchestrator under
  deterministic transitions, and errors as typed routing signals. **In:** plan change PC1
  (Task 15), [documentation/ledger.md](documentation/ledger.md).
- **Calibration.** Miao Xiong, Zhiyuan Hu, Xinyang Lu et al. (2023). *Can LLMs Express Their
  Uncertainty? An Empirical Evaluation of Confidence Elicitation in LLMs.* ICLR 2024;
  arXiv:2306.13063.
  **Evidence:** verbalized confidence is badly calibrated, so Seshat never asks a model how sure it
  is: its probabilities are Beta posteriors over outcomes it observed.
- **Thompson sampling.** William R. Thompson (1933). *On the likelihood that one unknown probability
  exceeds another in view of the evidence of two samples.* Biometrika 25(3/4), pp. 285–294.
  **Takes:** every allocation choice: which strategy, model, setting or heuristic card a session
  gets, which tactic the battery tries first, which archive cell is extended, the budget gate's
  chance of success. **In:** [documentation/fleet.md](documentation/fleet.md),
  [documentation/scheduler.md](documentation/scheduler.md), `packages/fleet/src/beta.ts`.
- **DeepHOL.** Kshitij Bansal, Christian Szegedy, Markus N. Rabe et al. (2019). *Learning to Reason in
  Large Theories without Imitation.* arXiv:1905.10501.
  **Takes:** each run samples its own search settings, for diversity against entrenchment (the
  owner's note: "combinatorial and stochastic strength"). **In:** plan change PC6,
  [documentation/fleet.md](documentation/fleet.md).
- **BFS-Prover.** Ran Xin, Chenguang Xi, Jie Yang et al. (2025). *BFS-Prover: Scalable Best-First Tree
  Search for LLM-based Automatic Theorem Proving.* arXiv:2502.03438.
  **Takes:** length-normalized best-first search (log scores over depth^α). **In:**
  `packages/classical/src/search.ts` (`prove.search`), plan change PC6.
- **Sycophancy.** Harshee Jignesh Shah (2026). *The Silicon Mirror: Dynamic Behavioral Gating for
  Anti-Sycophancy in LLM Agents.* arXiv:2604.00478. And Vira Kasprova, Amruta Parulekar,
  Abdulrahman AlRabah et al. (2026). *Too Polite to Disagree: Understanding Sycophancy Propagation
  in Multi-Agent Systems.* arXiv:2604.02668.
  **Takes:** one plain anti-sycophancy sentence in every prompt (the first paper found the plain
  instruction worked better than its own gating on the smaller model), and no prompt shows a model
  another agent's verdict (the second). **In:** plan change PC10,
  [documentation/lines.md](documentation/lines.md), [documentation/guards.md](documentation/guards.md).
- **BrokenMath.** Ivo Petrov, Jasper Dekoninck, Martin Vechev (2025). *BrokenMath: A Benchmark for
  Sycophancy in Theorem Proving with LLMs.* arXiv:2510.04721.
  **Takes:** a prover is never told to prove an open conjecture: the task is "determine whether",
  and every open claim has a prove and a refute twin. **In:**
  [documentation/guards.md](documentation/guards.md), [documentation/graph.md](documentation/graph.md).
- **Long-horizon errors.** Akshit Sinha, Arvindh Arun, Shashwat Goel et al. (2025). *The Illusion of
  Diminishing Returns: Measuring Long Horizon Execution in LLMs.* arXiv:2509.09677.
  **Takes:** a model errs more when its context holds its own past mistakes, so a failed attempt
  never stays in the context verbatim, and long runs restart sessions cold from a summary built by
  code. **In:** [documentation/m0-loop.md](documentation/m0-loop.md) (`restarts`),
  [documentation/campaign.md](documentation/campaign.md), plan change LH.

## 5. Memory, the claim graph and context

- **Graphs and language models.** Bahare Fatemi, Jonathan Halcrow, Bryan Perozzi (2023). *Talk like
  a Graph: Encoding Graphs for Large Language Models.* ICLR 2024; arXiv:2310.04560. And Linhao Luo,
  Yuan-Fang Li, Gholamreza Haffari et al. (2023). *Reasoning on Graphs: Faithful and Interpretable
  Large Language Model Reasoning.* ICLR 2024; arXiv:2310.01061.
  **Takes:** graph operations (paths, propagation, neighbourhoods) run in code, never in the model;
  the model states a typed path pattern and `graph_query` executes it; the rendering of the graph is
  chosen and measured. **In:** [documentation/graph.md](documentation/graph.md).
- **Graph-constrained reasoning.** Linhao Luo, Zicheng Zhao, Gholamreza Haffari, Yuan-Fang Li, Chen
  Gong, Shirui Pan (2025). *Graph-constrained Reasoning: Faithful Reasoning on Knowledge Graphs with
  Large Language Models.* ICML 2025, PMLR 267.
  **Takes:** the output, not the decoding, is constrained: every reference a model makes must
  resolve to an existing claim or source, or the proposal is rejected. **In:** the resolved-citation
  guard of line M6 ([documentation/guards.md](documentation/guards.md)).
- **Structured knowledge in provers.** Sareh Nabi, Roland Vogl, Marzieh Nabi (2026). *When Does
  Structured Knowledge Help Neural Theorem Proving?* arXiv:2609.34460.
  **Evidence:** a knowledge graph inferred by a model and pasted into the prompt gains little and
  hurts large models; Seshat's graph gains must come from algorithms over Lean-checked edges, not
  from showing the model more graph.
- **ATMS.** Johan de Kleer (1986). *An assumption-based TMS.* Artificial Intelligence 28(2),
  pp. 127–162.
  **Takes:** the "proved modulo" labels of claims (which sets of open lemmas would make a claim
  proved), and nogoods. **In:** [documentation/graph.md](documentation/graph.md),
  [documentation/archive.md](documentation/archive.md).
- **Personalized PageRank.** Lawrence Page, Sergey Brin, Rajeev Motwani, Terry Winograd (1999). *The
  PageRank Citation Ranking: Bringing Order to the Web.* Stanford InfoLab technical report. Its use
  for retrieval follows **HippoRAG**: Bernal Jiménez Gutiérrez, Yiheng Shu, Yu Gu et al. (2024).
  *HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models.* NeurIPS 2024;
  arXiv:2405.14831.
  **Takes:** facts for the context are ranked by a PageRank seeded at the target, mixed with symbol
  similarity. **In:** `packages/graph/src/pagerank.ts`, `packages/context/src/facts.ts`,
  [documentation/context.md](documentation/context.md).
- **MePo and SInE.** Jia Meng and Lawrence C. Paulson (2009). *Lightweight relevance filtering for
  machine-generated resolution problems.* Journal of Applied Logic 7(1), pp. 41–57. And Kryštof Hoder
  and Andrei Voronkov (2011). *Sine Qua Non for Large Theory Reasoning.* CADE-23.
  **Takes:** symbolic premise selection without training; every learned selector must beat MePo
  alone in an ablation. **In:** `packages/context/src/selectors.ts`,
  [documentation/context.md](documentation/context.md).
- **BM25.** Stephen Robertson and Hugo Zaragoza (2009). *The Probabilistic Relevance Framework: BM25
  and Beyond.* Foundations and Trends in Information Retrieval 3(4).
  **Takes:** the search of the lemma library, the schema index and the local declaration index.
  **In:** [documentation/library.md](documentation/library.md).
- **Fusion of retrieval scores.** Sebastian Bruch, Siyu Gai, Amir Ingber (2022). *An Analysis of
  Fusion Functions for Hybrid Retrieval.* ACM TOIS; arXiv:2210.11934.
  **Takes:** retrieval channels are combined by a convex combination of normalized scores, not by
  reciprocal rank fusion. **In:** [documentation/context.md](documentation/context.md), plan change
  PC5.
- **LemmaHead.** Tianbo Yang, Mingqi Yan, Hongyi Zhao, Tianshuo Yang (2025). *LemmaHead: RAG Assisted
  Proof Generation Using Large Language Models.* arXiv:2501.15797.
  **Takes:** retrieval queries are extracted concepts, not the raw statement (which hurt in its
  measurements). **In:** `packages/context/src/premises.ts`, plan change PC5.
- **Pattern seeds.** Ataeva et al. (2026), regex seeds and Mathlib dependency neighbours for premise
  retrieval, as cited in plan change PC5. **Not verified:** the paper could not be found again on
  2026-11-18. **Takes:** the pattern-seed channel of the context compiler. **In:**
  `packages/context/src/seeds.ts`.
- **KG-Prover.** Vincent Li, Tim Knappe, Yule Fu et al. (2025). *Scaling Natural-Language Graph-Based
  Test Time Compute for Automated Theorem Proving.* arXiv:2503.11657.
  **Takes:** the neighbourhood of facts is widened by one hop after a failure. **In:** line M4
  ([documentation/context.md](documentation/context.md)), plan change PC5.
- **Rendering paths.** Costas Mavromatis and George Karypis (2024). *GNN-RAG: Graph Neural Retrieval
  for Large Language Model Reasoning.* arXiv:2405.20139. And Tiezheng Guo, Qingwen Yang, Chen Wang et
  al. (2023). *KnowledgeNavigator: Leveraging Large Language Models for Enhanced Reasoning over
  Knowledge Graph.* arXiv:2312.15880.
  **Takes:** two renderings of graph context: one arrow chain per line (GNN-RAG), and edges merged by
  head and relation (KnowledgeNavigator). **In:** `packages/graph/src/connect.ts`.
- **TheoremGraph.** Simon Kurgan, Evan Wang, Eric Leonen et al. (2026). *TheoremGraph: Bridging
  Formal and Informal Mathematics.* arXiv:2606.25363.
  **Takes:** the library index is a BM25 over name, signature and gloss, as its own search is;
  its LeanGraph can feed the dependency neighbours of the pattern seeds. **In:**
  [documentation/library.md](documentation/library.md), `packages/context/src/seeds.ts`.
- **LEGO-Prover.** Haiming Wang, Huajian Xin, Chuanyang Zheng et al. (2023). *LEGO-Prover: Neural
  Theorem Proving with Growing Libraries.* ICLR 2024; arXiv:2310.00656.
  **Takes:** a library of proved lemmas that grows across problems (line M3). **In:**
  [documentation/library.md](documentation/library.md).
- **ACE.** Qizheng Zhang, Changran Hu, Shubhangi Upasani et al. (2025). *Agentic Context Engineering:
  Evolving Contexts for Self-Improving Language Models.* arXiv:2510.04618.
  **Takes:** lessons as an incremental playbook: entries added and merged by code, never rewritten
  whole, which avoids the loss of detail it calls context collapse. **In:**
  [documentation/lessons.md](documentation/lessons.md) (line M5), plan change LH.
- **Experience-following.** Zidi Xiong, Yuping Lin, Wenya Xie et al. (2025). *How Memory Management
  Impacts LLM Agents: An Empirical Study of Experience-Following Behavior.* arXiv:2505.16067.
  **Takes:** memory is added selectively, by measured outcome, never "add everything", since agents
  copy what they retrieve and stored errors spread. **In:** lesson counters
  ([documentation/lessons.md](documentation/lessons.md)), plan change PE.
- **SkillsBench.** Xiangyi Li, Yimin Liu, Wenbo Chen et al. (2026). *SkillsBench: Benchmarking How Well
  Agent Skills Work Across Diverse Tasks.* arXiv:2602.12670.
  **Evidence:** curated skills help and self-generated ones do not; two or three help more than four
  or more. Seshat shows at most three lessons and one heuristic card per session, and procedural
  memory written by a model is allowed only behind a gate and judged by its measured effect. **In:**
  [documentation/lessons.md](documentation/lessons.md),
  [documentation/heuristics.md](documentation/heuristics.md), Global Constraint 16.

## 6. Classical tools and algorithms

- **LeanHammer.** Thomas Zhu, Joshua Clune, Jeremy Avigad et al. (2025). *Premise Selection for a Lean
  Hammer.* arXiv:2506.07477. With **Lean-auto**: Yicheng Qian, Joshua Clune, Clark Barrett et al.
  (2025). *Lean-auto: An Interface between Lean 4 and Automated Theorem Provers.* arXiv:2505.14929.
  **Takes:** `hammer` in the classical battery, at several premise cutoffs, when the host has it;
  the call follows the LeanHammer README. **In:**
  [documentation/classical.md](documentation/classical.md) (line M10).
- **Aesop.** Jannis Limperg and Asta Halkjær From (2023). *Aesop: White-Box Best-First Proof Search
  for Lean.* CPP 2023.
  **Takes:** one of the battery's tactics, and a reconstruction route for premises an ATP used.
  **In:** [documentation/classical.md](documentation/classical.md).
- **Canonical.** Chase Norman and Jeremy Avigad (2025). *Canonical for Automated Theorem Proving in
  Lean.* arXiv:2504.06239.
  **Takes:** `canonical` in the battery for first-order goals, when the host has it. **In:**
  [documentation/classical.md](documentation/classical.md).
- **E.** Stephan Schulz, Simon Cruanes, Petar Vukmirović (2019). *Faster, Higher, Stronger: E 2.3.*
  CADE-27.
  **Takes:** `atp.eprover`: goals translated to TPTP; the axioms E used come back and are tried in
  Lean, so E's answer is never a status. **In:** `capabilities/atp.eprover`,
  [documentation/classical.md](documentation/classical.md).
- **Vampire.** Laura Kovács and Andrei Voronkov (2013). *First-Order Theorem Proving and Vampire.*
  CAV 2013.
  **Takes:** `atp.vampire`, used the same way. **In:**
  `capabilities/atp.vampire`.
- **Z3.** Leonardo de Moura and Nikolaj Bjørner (2008). *Z3: An Efficient SMT Solver.* TACAS 2008.
  **Takes:** `smt.z3`, with unsat cores giving the premises to try in Lean. **In:**
  `capabilities/smt.z3`.
- **SageMath** (software, The Sage Developers, sagemath.org).
  **Takes:** `compute.sage`, the computer algebra tool; its results are `computed` evidence, never a
  proof. **In:** [documentation/compute.md](documentation/compute.md).
- **nauty.** Brendan D. McKay and Adolfo Piperno (2014). *Practical graph isomorphism, II.* Journal
  of Symbolic Computation 60, pp. 94–112; arXiv:1301.1493.
  **Takes:** graphs up to isomorphism (`geng`, through SageMath) for counter-model hunts. **In:**
  [documentation/models.md](documentation/models.md).
- **OEIS, LMFDB and FindStat** (databases: oeis.org, lmfdb.org, findstat.org).
  **Takes:** `oeis.search`, `lmfdb.query` and `findstat.identify`, to name a sequence, an object or a
  statistic found by computation. **In:** [documentation/capabilities.md](documentation/capabilities.md).
- **Polynomial tactics.** Hao Shen, Junyu Guo, Junqi Liu, Lihong Zhi (2026). *Automated Tactics for
  Polynomial Reasoning in Lean 4.* arXiv:2604.13514.
  **Takes:** GroebnerTactic as an optional Lean library. **In:** plan change PD (Task 21's library
  set).
- **PSLQ.** Helaman R. P. Ferguson, David H. Bailey, Steve Arno (1999). *Analysis of PSLQ, an integer
  relation finding algorithm.* Mathematics of Computation 68(225), pp. 351–369.
  **Takes:** integer relations among computed constants, written for Seshat. **In:**
  [documentation/induction.md](documentation/induction.md) (line M13).
- **gfun.** Bruno Salvy and Paul Zimmermann (1994). *GFUN: a Maple package for the manipulation of
  generating and holonomic functions in one variable.* ACM Transactions on Mathematical Software
  20(2), pp. 163–177.
  **Takes:** guess a linear recurrence from an overdetermined system, then prove it. **In:**
  [documentation/induction.md](documentation/induction.md).

## 7. Conjecturing, search over programs, repair

- **Graffiti.** Siemion Fajtlowicz (1988). *On conjectures of Graffiti.* Discrete Mathematics 72,
  pp. 113–118.
  **Takes:** the Dalmatian heuristic for conjectures over a table of invariants. **In:**
  [documentation/induction.md](documentation/induction.md) (classical conjecturing, without a model).
- **QuickSpec.** Koen Claessen, Nicholas Smallbone, John Hughes (2010). *QuickSpec: Guessing Formal
  Specifications Using Testing.* TAP 2010.
  **Takes:** theory exploration on data: enumerate terms, group them by their values, keep the
  irreducible laws. **In:** [documentation/induction.md](documentation/induction.md) (line M13).
- **Inductive reasoning with models.** Ruocheng Wang, Eric Zelikman, Gabriel Poesia et al. (2023).
  *Hypothesis Search: Inductive Reasoning with Language Models.* ICLR 2024; arXiv:2309.05660. And
  Linlu Qiu, Liwei Jiang, Ximing Lu et al. (2023). *Phenomenal Yet Puzzling: Testing Inductive
  Reasoning Capabilities of Language Models with Hypothesis Refinement.* ICLR 2024;
  arXiv:2310.08559.
  **Takes:** the model proposes a hypothesis and code tests it on the data: every hypothesis is an
  executable program or a testable Lean statement. **In:** line M8
  ([documentation/induction.md](documentation/induction.md)).
- **LeanConjecturer.** Naoto Onda, Kazumi Kasaura, Yuta Oriike et al. (2025). *LeanConjecturer:
  Automatic Generation of Mathematical Conjectures for Theorem Proving.* arXiv:2506.22005.
  **Takes:** the triviality filter: a conjecture that cheap Lean automation closes is dropped. **In:**
  `TrivialityTest` ([documentation/induction.md](documentation/induction.md)).
- **FunSearch.** Bernardino Romera-Paredes, Mohammadamin Barekatain, Alexander Novikov et al. (2024).
  *Mathematical discoveries from program search with large language models.* Nature 625,
  pp. 468–475.
  **Takes:** program search for subgoals with a computable score: islands, sampling biased to high
  scores and short programs, periodic reset of the worse islands. **In:** line M16
  ([documentation/induction.md](documentation/induction.md#program-search-line-m16)), plan change PC8.
- **ShinkaEvolve.** Robert Tjarko Lange, Yuki Imajuku, Edoardo Cetin (2025). *ShinkaEvolve: Towards
  Open-Ended And Sample-Efficient Program Evolution.* arXiv:2509.19349.
  **Takes:** novelty rejection (a candidate too close to one already scored is not run) and parent
  balance, added to M16. **In:** [documentation/campaign.md](documentation/campaign.md), plan change
  LH.
- **MAP-Elites.** Jean-Baptiste Mouret and Jeff Clune (2015). *Illuminating search spaces by mapping
  elites.* arXiv:1504.04909.
  **Takes:** the archive of line M15 keeps one elite per cell of a behaviour grid. **In:**
  [documentation/archive.md](documentation/archive.md).
- **ProofEvolve.** Wenqian Ye, Ziwei Guan, Eric Xie et al. (2026). *ProofEvolve: Neuro-Symbolic
  Evolution for Formal Automated Theorem Proving.* arXiv:2608.26334.
  **Takes:** without its training: partial proof DAGs in a MAP-Elites archive keyed by depth,
  mechanism and region, a challenger replacing an elite only with a higher share closed by the
  kernel, and closed sub-DAGs extracted as schemas for other problems. **In:**
  [documentation/archive.md](documentation/archive.md),
  [documentation/schemas.md](documentation/schemas.md) (line M15), plan change PC13.
- **Anti-unification.** Gordon D. Plotkin (1970). *A note on inductive generalization.* Machine
  Intelligence 5, pp. 153–163.
  **Takes:** the least general generalization of two statements, which gives a schema's shared shape
  and its variables. **In:** [documentation/schemas.md](documentation/schemas.md).
- **Proofs and Refutations.** Imre Lakatos (1976). *Proofs and Refutations: The Logic of Mathematical
  Discovery.* Cambridge University Press.
  **Takes:** a conjecture refuted by a data table is mended (monster barring, exception barring) and
  the repaired conjecture becomes a claim of its own; also several heuristic cards. **In:** line M14
  ([documentation/repair.md](documentation/repair.md)).
- **Proof critics.** Andrew Ireland and Alan Bundy (1996). *Productive use of failure in inductive
  proof.* Journal of Automated Reasoning 16, pp. 79–111.
  **Takes:** typed repairs chosen from the failure class of an attempt. **In:**
  [documentation/repair.md](documentation/repair.md).

## 8. The heuristic card bank

The cards are written by people, in their own words, and each names its tradition and source
([documentation/heuristics.md](documentation/heuristics.md), line M19, plan change HB).

- **George Pólya (1945).** *How to Solve It.* Princeton University Press. Understand the problem,
  a related problem, a special case, working backwards, the inventor's paradox, looking back. Also
  the long-term direction of the plan: one native tool per major method of the book.
- **Alan H. Schoenfeld (1985).** *Mathematical Problem Solving.* Academic Press. Control: knowing
  when to change approach matters more than knowing heuristics; the harness carries the control
  (stagnation triggers, the escalation ladder), the cards carry the moves.
- **Arthur Engel (1998).** *Problem-Solving Strategies.* Springer. Invariants, the extremal
  principle, the box principle, divisibility, inequalities.
- **Paul Zeitz (1999).** *The Art and Craft of Problem Solving.* Wiley. Symmetry.
- **Terence Tao (2006).** *Solving Mathematical Problems: A Personal Perspective.* Oxford University
  Press; and Tao's blog posts on research strategy, toy models and partial results.
- **Gian-Carlo Rota (1997).** *Ten Lessons I Wish I Had Been Taught.* Notices of the AMS 44(1). First
  principles.
- **John R. Platt (1964).** *Strong Inference.* Science 146(3642), pp. 347–353. The crucial
  experiment.
- **Jonathan Borwein and David Bailey (2004).** *Mathematics by Experiment.* A K Peters. Experimental
  mathematics.
- **VOTAT (vary one thing at a time).** Judith E. Tschirgi (1980). *Sensible reasoning: a hypothesis
  about hypotheses.* Child Development 51, pp. 1–10. Regina Vollmeyer, Bruce D. Burns, Keith J.
  Holyoak (1996). *The impact of goal specificity on strategy use and the acquisition of problem
  structure.* Cognitive Science 20(1), pp. 75–100. Andreas Fischer, Samuel Greiff, Joachim Funke
  (2012). *The process of solving complex problems.* Journal of Problem Solving 4(1).
- **SHAPE.** Jonghyun Song, Sangjun Song, Minjae Oh et al. (2026). *SHAPE of Thinking: Mathematical
  Heuristics for Analyzing and Improving LLM Reasoning.* arXiv:2608.28600.
  **Takes:** the closed vocabulary of card families is aligned with its 11 families (drawn from
  Pólya, Schoenfeld and the didactics literature) and extended.
- **Skill shadowing.** Hongwen Song and Song Wei (2026). *More Skills, Worse Agents? Skill Shadowing
  Degrades Performance When Expanding Skill Libraries.* arXiv:2605.24050.
  **Evidence:** a large library loses through wrong selection; so the bank is small and a card is
  drawn by Thompson sampling on outcomes, not chosen by the model from descriptions.
- **Meta-reasoning.** Peizhong Gao, Ao Xie, Shaoguang Mao et al. (2024). *Meta Reasoning for Large
  Language Models.* arXiv:2406.11698.
  **Evidence:** a model choosing a method from descriptions does not beat the best fixed method;
  same consequence as above.
- **Approach diversity.** Sangmook Lee, Minbeom Kim, Jeonghye Kim et al. (2026). *Are We Measuring
  Strategy or Phrasing? The Gap Between Surface- and Approach-Level Diversity in LLM Math
  Reasoning.* arXiv:2606.29985.
  **Evidence:** covering more distinct approaches at a fixed budget gains points; this is why
  sessions get different cards and a control arm gets none.
- **Failure modes on research mathematics.** Arnesh Banerjee and Ayushi Bhattacharjee (2026).
  *Failure Modes of Large Language Models on Research-Level Mathematics: A Taxonomy and an Empirical
  Characterisation.* arXiv:2606.24902.
  **Takes:** premise smuggling, cited by the "looking back" card.

## 9. Budgets, long runs, prompts and decisions

- **Budget-aware tool use.** Tengxiao Liu, Zifeng Wang, Jin Miao et al. (2025). *Budget-Aware Tool Use
  Enables Effective Agent Scaling.* arXiv:2511.17006.
  **Takes:** an agent that does not see its budget does not use it, so sessions see what is left
  and the campaign's frontier shows its size and last addition. **In:**
  [documentation/campaign.md](documentation/campaign.md), plan change LH.
- **Vending-Bench.** Axel Backlund and Lukas Petersson (2025). *Vending-Bench: A Benchmark for
  Long-Term Coherence of Autonomous Agents.* arXiv:2502.15840.
  **Evidence:** long runs fail by derailing, not by a full context; with Sinha et al., this is why a
  campaign restarts sessions cold from a verified frontier. **In:** plan change LH.
- **Kosmos.** Ludovico Mitchener, Angela Yiu, Benjamin Chang et al. (2025). *Kosmos: An AI Scientist
  for Autonomous Discovery.* arXiv:2511.02824.
  **Evidence:** a structured shared state, not the conversation, keeps a long run coherent;
  together with Anthropic's engineering note on harnesses for long-running agents (2025), the
  campaign keeps its state in the journal and marks steps done only by a check. **In:** plan change
  LH, [documentation/campaign.md](documentation/campaign.md).
- **GEPA.** Lakshya A. Agrawal, Shangyin Tan, Dilara Soylu et al. (2025). *GEPA: Reflective Prompt
  Evolution Can Outperform Reinforcement Learning.* arXiv:2507.19457.
  **Takes:** prompt rewriting by reflection over a dev split, gated by held-out and temporal tests,
  with proposals a person merges. **In:** [documentation/prompts.md](documentation/prompts.md).
- **McNemar's test.** Quinn McNemar (1947). *Note on the sampling error of the difference between
  correlated proportions or percentages.* Psychometrika 12(2), pp. 153–157.
  **Takes:** the exact paired test on discordant problems when two arms are compared. **In:**
  [documentation/ablate.md](documentation/ablate.md).
- **Jev.** Boyuan Deng, Shuyi Fan, Hongyang Zhang, Xinhong Xie (2026). *Jev for Scientific Decisions:
  Evaluating Semantic Choices and Their Consequences.* arXiv:2609.24965.
  **Evidence:** read before adding the optional `decide` capability with a Jev backend; the paper
  supports "semantics to the model, arithmetic to the code" and the low cost, not calibration or
  mathematics, so `decide` is off by default and never used for statement equivalence. **In:**
  [documentation/decide.md](documentation/decide.md), plan change Jev (Task 20).

## 10. Literature search

- **Conjecture 194.** Cameron Beeley (2026). *Lean-Certified Infinite Counterexamples to Written on
  the Wall II Conjecture 194.* arXiv:2609.19195.
  **Evidence:** Seshat spent money on a conjecture this paper had already refuted two months before.
  This is why `lit.search` runs before paid proving. **In:** plan changes CA16 and LW1,
  [documentation/literature.md](documentation/literature.md).
- **OpenAlex, arXiv, Semantic Scholar and zbMATH Open** (services).
  **Takes:** the backends of `lit.search`, each behind the registry and replaceable. **In:**
  `capabilities/lit.search`, [documentation/literature.md](documentation/literature.md).

## 11. Read and not built

Read for the plan and not (yet) in the code; listed so that nobody reads them as sources of what
Seshat does.

| Work | Why it is not in Seshat |
|---|---|
| QuerySMT: Joshua Clune, Haniel Barbosa, Jeremy Avigad (2026). *Hint-Based SMT Proof Reconstruction.* arXiv:2601.14495. Lean-SMT: Abdalrhman Mohamed, Tomaz Mascarenhas, Harun Khan et al. (2025). arXiv:2505.15796. | SMT reconstruction in Lean goes through Z3's unsat cores and the battery instead; these tactics are not wired. |
| Agent Memory Distillation: Taeil Kim, Kangsan Kim, Sung Ju Hwang (2026). arXiv:2608.07169. | Teacher memory (plan change CA26) is approved behind a gate and not built. |
| DRIFT: Meiru Zhang, Philipp Borchert, Milan Gritta et al. (2025). *Decompose, Retrieve, Illustrate, then Formalize Theorems.* arXiv:2510.10815. | Read for PC5; decomposed queries hurt problems with few dependencies, so concept queries were kept instead. |
| Sound Agentic Science: Dionizije Fa and Marko Culjak (2026). *Sound Agentic Science Requires Adversarial Experiments.* arXiv:2604.22080. | Supports the prove/refute twin, which comes from BrokenMath above. |
| Abduction and analogy (line M7, the reranking line M9). | Suspended by the owner on 2026-10-20; the notes on analogical retrieval and inspiration retrieval stay in the research files, not in the code. |
| A research agent above the kernel (plan change RA, Tasks 46 to 48). | Direction approved, not built; its readings are not cited here. |
