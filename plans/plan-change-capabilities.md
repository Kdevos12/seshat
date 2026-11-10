# Plan change: capabilities (a graded bench, a cheaper hot loop, a blueprint spine, test before prove)

Status: **approved by the owner on 2026-11-10 at 11:04 UTC** ("Tout est approuvé. Go."), all of CA1
to CA26, with the amendment of Global Constraint 16 written in section 10, item 4, and the defaults
proposed for the other questions of section 10 (Ruling 33). Written 2026-11-10 by the thread
"Augmenter les capacités de Seshat de 50 %", at the owner's request (raise Seshat's capabilities by at
least 50%, later made precise as problem solving against cost). The analysis and the source notes
are in the project files (`research/augmentation-capacites.md`, in French, and
`research/sources-capacites/`), outside the repository. In the plan these are Tasks 33 to 44. The
bench of CA1 is called the graded bench here, since "ladder" already names M12's escalation ladder.

Items are named CA1 to CA26 (CA23 to CA26 were added later the same day: section 7). Each is an
option or an ablation arm, so each is measured against the run without it at equal budget and
removed if it does not pay (the plan's standing rule).

## 1. Why

What the first real runs showed (`plans/seshat-plan-ledger.md`, 2026-11-07 to 11-10; DeepSeek's small
model, Lean 4.27.0, a 4-core 13 GB machine):

- `n + 0 = n`: proved and certified for $0 by the battery. Two research-level bench problems: unsolved
  for $1.00 in 85 minutes. Graffiti WOWII conjecture 194: impasse after 9 attempts, $0.72, 90 minutes.
- What actually ran is the bare loop: `solve` enables lines M1 and M10 and gives the prover one tool,
  `lean_check`. Lines M12, M11, M2, M6, the fleet, and the tools `compute.sage`, `lean.lsp`,
  `prove.auto`, `small_models` exist and were off. None of the 17 lines has been measured on a real
  model.
- Dollars: with 98 to 99% of input tokens read from the cache at $0.006 per million, the bill is
  output tokens. From the run's totals and the host's price table, about 90% of conjecture 194's
  $0.72 was output (the model rewrites both regions in full at every check, plus its reasoning). This
  is computed from totals, not read from the journal, which this thread could not reach.
- Time: the machine spent $0.5 to $0.7 an hour. A $2 `solve` takes three to four hours. On a laptop
  with one Lean REPL, time binds before money does.
- 4 of 9 sessions ended on a full context; 25% of attempts failed the way an earlier one had; Lean
  checks ran into long timeouts; Kimina grew to 12 GB.

What the literature of 2026 shows (read on the sources; details and links in the research note):

- **The same model family does far more in another loop.** Goedel-Architect (arXiv 2606.06468, June
  2026) uses only DeepSeek's small model: a blueprint (a dependency graph of lemma statements), a
  tool-equipped prover per lemma that sees only that lemma and its declared dependencies, a verdict
  per failed lemma (`statement_wrong` or `proof_too_hard`), and a refinement of the whole blueprint
  that keeps proved lemmas. It reports 75.6% of PutnamBench at about $0.44 a problem ($0.21 per solved
  problem, $1.14 per unsolved one). On a 200-problem subset the same model scores 6.5% single-shot and
  54.5% as a single agent with tools. The first blueprint solves 29.8%; sixteen refinements bring it
  to 75.6%. A natural-language proof given to the planner adds 13 points.
- **Conjecture 194 was already refuted.** arXiv 2609.19195 (2026-09-15) gives a Lean-certified
  infinite family of counterexamples; the member it names has 18 vertices, beyond exhaustive search.
  Seshat spent $0.72 two months later with no way to know. On Erdős problems, 9 of the 13 meaningful
  results of DeepMind's Aletheia already existed in the literature, and 50 of 63 technically correct
  answers were vacuous readings of the statement (arXiv 2601.22401).
- Tools and feedback, not the model, carry general models in Lean: Ax-Prover 5% to 51% with tools;
  retrieval pushed by the harness beats tools the model must call (agents ignore them); a repair pass
  that cuts failing blocks to `sorry` and tries automation on each lifts a weak model from 7% to 47%
  (APOLLO); iteration with compiler feedback beats independent samples (Delta Prover 95.9% against
  49.1% at equal calls).

So the gap is the loop. Seshat already owns most of the parts the reference loop needs: canonical
claim identity (M1), holes as claims and a scheduler (M12), the battery per subgoal (M10),
counter-models (M11), the budget gate, the journal. They are not assembled into the default path,
and M12's inner prover is one model call with no tool.

## 2. The measure

"Capabilities up by 50%" needs a yardstick on which today's Seshat does not score zero. The bench of
575 research results cannot show it.

- **CA1. A graded bench.** `bench/graded-v1.json`, three grades, built by `harness-bench` from local
  checkouts (nothing vendored, as for `bench-ext`); a statement must compile under `lean/env/base`
  to be admitted, so a statement Lean cannot read is never an "unsolved" problem.
  Grade A (exercise level): the `textbook` and `test` theorems of formal-conjectures at the bench tag,
  discrete AMS codes. Grade B (competition level): a fixed, seeded sample of 100 PutnamBench problems.
  Grade C (research level): a sample of `fc-bench-v1-discrete`, the 70 problems with a formal proof
  elsewhere first. To verify when it is built: a PutnamBench commit that builds on Lean 4.27 (else its
  own environment through `lean/env/NAME.toml`, as M17 does); licences; grade A's size.
- **CA2. The protocol.** Same problems, same dollars per problem (default $0.50), paired arms through
  `harness ablate`; solved counts with Wilson intervals, an exact McNemar test on the pairs, dollars
  per solved problem, wall-clock time. The target of this plan change, in the owner's words "problem solving against
  cost" (2026-11-10): **at least 1.5 times the problems solved per dollar spent of `main` at
  `ae3b2a0` (`solve` defaults) on grade B, with the same cap per problem, no fewer problems solved on
  grades A and B.** Both parts are reported: problems solved at equal cap, and dollars spent. Two new kinds of result are counted apart:
  refutations of statements about finite structures, and statements found settled in the literature.
  Power: with 60 paired problems a gain from 30% to 45% is detectable when the gains are nested
  (about 11 discordant pairs against 2); a doubling shows with 40.
- **CA3. Loop telemetry in the report**, from the journal alone: per attempt, the number of checks,
  seconds per check (median and 95th centile), output tokens per check, the share of dollars by cache
  hit, cache miss and output, context size at the end, the stop reason; per problem, the rate of
  repeated failures, the open-hole count over time, and the share of proposed sub-lemmas that turned
  out false (no published system reports that number; we log it from the first run).

## 3. A cheaper and faster hot loop

- **CA4. Bounded Lean checks.** The provers' checks get a host setting `checkTimeoutSec` (default
  120; the validator's policy is 300 today, and published systems use 30 to 60); the registry's
  health limit becomes a setting (`HEALTH_TIMEOUT_MS` is 15 s, too short for a cold laptop).
  `harness doctor` prints the Kimina settings that fit the machine's memory (`MAX_REPLS`,
  `MAX_REPL_USES`, which defaults to never recycling a REPL, `MAX_REPL_MEM`) and warns when the
  server's memory passes a threshold. Optional: `harness lean-server start`, which starts Kimina with
  those settings under a memory cap.
- **CA5. An edit tool.** `lean_edit(region, old, new)` replaces one unique occurrence in the region as
  last checked and runs the same check; `lean_check(aux, proof)` stays for the first draft. The
  journal still stores the full submission, so nothing downstream changes. A miss answers "not found"
  or "found N times" with the region.
- **CA6. Old check results masked.** In a session, check results older than the last four are replaced
  by their one-line summary (`summarizeCheck`), in batches so the cached prefix survives. The hook
  exists (`SessionOptions.rewriteHistory`). Evidence: masking old observations halves cost at equal
  solve rate on coding agents (arXiv 2508.21433); here the gain sought is useful turns before the
  context fills.
- **CA7. A state card in place of long notes.** The next session's opening message gets a card built
  by code from the journal: holes with their goals and status, lemmas Lean accepted with their names,
  failed approaches as (strategy, failure class, first error) with counts, timeouts. The model's own
  notes shrink to 1500 characters. M6's detectors gain a mechanical repeat rule: a (normalised first
  error, strategy) pair seen three times on a problem tells the prover to change approach, and ends
  the session if it recurs.
- **CA8. A run's budget shared in rounds.** With a run budget and K problems, problems are worked
  round-robin with a cap that doubles: round r allows a problem `runUsd / (4K) × 2^r` in total; a
  problem without Lean progress (the ladder's measure) at the end of its round is parked, and what it
  leaves goes on. A run warns when the problem allowance is above its fair share. Removes "the first
  problem took 92% of the run".

## 4. The blueprint spine

The default order of work on a problem becomes: intake gate (section 5), battery, one direct attempt
(today's probe), then the blueprint loop, then escalation. Built by extending line M12, not beside it.

- **CA9. A blueprint is a sketch whose holes may depend on each other.** Each `aux_` lemma with a
  `sorry` proof is a node; a node declares the nodes it may use (`-- uses: aux_a, aux_b`); the target
  is the sink. It is accepted when Lean checks the file with no error, the graph has no cycle and every
  node reaches the target. M12's rule that no hole may name another hole goes. Trust is unchanged: the
  problem is settled only when the assembled file, holes replaced by their accepted proofs, passes
  `validate` and the certifier.
- **CA10. A tool-equipped prover per hole.** M12's inner session is one model call today. It becomes a
  short session (12 turns by default, priced by the gate as a task) on a file that holds the header,
  the hole's declared dependencies as stubs, and the hole: small, so checks are fast and edits are
  short, and the context holds nothing else. A hole's work is done when Lean reports no error and
  every `sorry` left lies in a dependency stub; its claim becomes `computed` only when its proof, with
  its dependencies' accepted proofs above it, passes `validate`. The battery runs on the hole first
  (M10 already does this for subgoal claims).
- **CA11. A verdict per hole, and a pre-flight test.** Before any paid session a hole is type-checked,
  tried by the battery, and tested where it can be (`plausible` where instances exist, M11's small
  models where it reads the statement, a short attempt at the negation). A hole session ends
  `proved`, `statement_wrong` (with a Lean-checked negation, which makes the claim's negation
  `computed`; or with a tool's counterexample or only the prover's argument, recorded as a
  `suspect_false` evidence node, never a status), or `too_hard`.
- **CA12. Refinement rounds.** After each wave one planner call, in a fresh context, reads the target,
  the blueprint, and one line per node (verdict, last error) and rewrites the blueprint: split what is
  too hard, repair or drop what is wrong, rewire. A node is identified by its canonical statement id
  (M1), so a statement that did not change keeps its proof, and one proved in another branch, another
  problem or an earlier run is reused. Rounds are priced by the budget gate; at most 8 by default;
  depth at most 3 (Hilbert gets 98.4% at depth 2 against 98.7% at depth 3). A blueprint whose hole
  restates the target is refused (the failure class `restates_target` exists).
- **CA13. The repair pass.** When a session ends on a file with errors, the harness cuts each failing
  block to `sorry`, runs the battery on every hole, and gives the next step the smaller problem
  (APOLLO's sorrifier and auto-solver).
- **CA14. An informal proof first, the person's or the model's.** The planner writes an informal proof
  before the first blueprint (the fleet's informal-first mode has the step DAG). `harness solve
  --sketch FILE` takes a proof in prose from the person (a paper's argument, a hint) and journals it
  as a hint under their name. For `research solved` problems the proof exists in print: giving it
  changes the task from discovery to formalization.
- **CA15. Roles.** `RunConfig.roles` names the planner's, the provers' and the escalation model (all
  the run's model by default). Student default: after two refinement rounds without Lean progress the
  planner's calls go to the provider's stronger priced model, for at most a quarter of the allowance.

## 5. Test before prove

- **CA16. `lit.search`, a capability.** Backends behind the registry (OpenAlex, arXiv, Semantic
  Scholar, zbMATH, and the metadata of the local bench checkout: docstrings, `formal_proof`), each
  optional and replaceable, every query and answer journaled. At intake, before any paid session:
  three query forms, one judge call ("does a hit prove, refute or restrict this exact statement?"),
  under $0.05. A hit is a `literature` evidence node with its URL and a quoted sentence that must be
  in the fetched text (M6's rule for citations). It never changes a status (Ruling 13) and its text
  never enters a system prompt or a lesson (Global Constraint 16): the briefing shows the title, the
  link, the judge's answer and the screened quote. In a run with a person, a hit that says "settled"
  is a breakpoint. `--private` sends nothing outside.
- **CA17. Tools for `solve`.** `harness solve --tool ID`, and by default the compute tool the host
  has, when the router files the statement as finite, graph or number.
- **CA18. Counterexamples on finite structures.** M11 reads magmas and one natural number. It gains
  graphs: batteries from `graphsUpToIso` (to 8 vertices, built) and from SageMath's nauty (to 10); the
  predicate is a program the model writes, run in M8's sandbox, and a hit is rechecked by Lean before
  anything is recorded as more than evidence. "No counterexample among the connected graphs up to 10
  vertices" is an evidence node with its exact filters.
- **CA19. Lean templates for finite witnesses**, in `lean/SeshatLib/Finite`: a graph on `Fin n` from
  an edge list with its decidable instances, and lemmas that check a witness (an independent set, a
  path, the absence of a Hamiltonian path) by `decide`. The first real run failed exactly here, on
  typeclasses. `bv_decide` and `native_decide` stay refused: they add an axiom outside the three
  allowed. To verify on 4.27: that `decide +kernel` adds none.
- **CA20. Search beyond exhaustive reach.** A generic local search over graphs driven by a
  model-written score in the sandbox, and M16's program search for constructions in families.
  Conjecture 194's counterexample needed a family; no enumeration finds 18 vertices.
- **CA21. Statement hygiene at intake.** A vacuity test (one object that satisfies the hypotheses),
  `plausible`, and for every statement the test lemmas `solve` already makes for prose.

## 6. Premises pushed, not pulled

- **CA22. `lean.search`, called by the harness.** On an unknown identifier, and for each hole's goal,
  the harness asks a premise search (a replaceable capability: LeanSearch, LeanExplore run locally,
  Loogle) and appends the top hits to the check's answer, each one first checked against the run's
  Lean environment so that a name from another Mathlib never reaches the model. Evidence: agents
  ignore lookup tools they must call; retrieval is the best single configuration in the attribution
  study; hallucinated names are 33 to 56% of cheap models' errors (arXiv 2602.24273).

## 7. Peripheral modules: consolidation, reverie, teacher memory

Added 2026-11-10 after the owner's idea of a "hypnopompic" generator (source note
`research/sources-capacites/divergent-generation-memory.md`). The three modules below are peripheral:
each is a line or an option that is **off by default**, that the core never requires, and that is
removed by not naming it. CA23 is a small change to the core they need.

- **CA23. Sampling settings per role.** `RunConfig.roles.<role>.settings` gives each role (planner,
  hole prover, repair, translator, and the generator of CA25) its temperature, thinking level and
  `top_p`, sent with the role's requests, one-shot calls included, and recorded with the attempt. A
  setting the model's family ignores is not sent and is recorded as ignored, as the fleet does today.
  On the models of the real runs temperature acts only with thinking off, so the lever that acts there
  is the thinking level. Defaults: cold for anything that writes Lean, the run's own elsewhere. No
  schedule is claimed to help: the fleet learns over a list where the owner gives one.
- **CA24. A consolidation pass between runs** (`harness consolidate RUN_DIR`, and at the end of a
  consortium turn). It looks backward. Without a model: the state card of CA7 for each open problem
  (what is proved, each approach tried with its failure class and count, the open holes, the evidence),
  duplicates of lessons merged, lessons whose support the journal no longer backs flagged. With at most
  one model call per problem: a page "what was tried and why it stopped", every sentence of which cites
  journal events; a sentence that cites none is dropped. The pass writes learned artifacts, stamped
  (Global Constraint 16), in a new run started on the earlier one (`--memory-from`): the earlier journal
  is not written. One page per problem, one writer. The injected part stays under a fixed size.
- **CA25. The reverie line** (the owner's idea; working name, line id for the main team). After CA24,
  on a problem that ended at an impasse, a generator produces many ideas far from the mode, and a
  funnel discards most of them before the prover sees any.
  1. *Generation.* The cheapest model. Each call gets the state card, must return 20 distinct ideas,
     each typed, and is shaped by levers that the harness draws from a seeded stream and records, so
     that a reverie is reproducible and each lever is judged alone. The randomness is in the harness,
     not in the sampler: it works on a model that ignores temperature. The levers, by expected worth:
     - *Mutation of the statement*, done by the harness on the Lean term, not by the model: a
       hypothesis dropped, the conclusion strengthened or weakened, a constant made a variable, a
       small case fixed, the converse, the dual. The model is asked what follows.
     - *Collision*: two items of the memory that no edge links (a failed attempt and a library lemma,
       a heuristic card and an open hole, a reformulation move: sub-problem, generalization, analogue,
       higher dimension), to be related.
     - *Coverage*: a grid of idea type by stimulus by domain, kept as M15 keeps its archive; a call is
       sent to an empty cell, is shown a sample of the ideas already held, and may not repeat them or
       any approach the state card says failed.
     - *A lossy view*: the state card with parts masked or out of order, so that the model fills gaps
       instead of continuing the last attempt. No published evidence; an arm.
     - *Less control in the model*: thinking off, which is the switch that acts on the models of the
       real runs, and is also the cheapest.
     - *Another model* as generator, where the host has one: its mistakes are different ones.
     - *Sampler settings* last: temperature (CA23), `top_p`, the penalties.
     Which levers a call gets is learned as the fleet learns its settings, on one reward: ideas that
     survive the funnel per dollar.
  2. *Types, by how each is tested.* `lemma` (a statement that would help); `counterexample` (an object
     or a family); `reformulation` (another statement, with the link to the goal); `quantity`
     (something to compute on small cases); `approach` (a method, with no test).
  3. *The funnel, cheapest first.* Deduplication by M1's statement identity and against what the state
     card says failed; translation to Lean or to a sandbox program, cold; the statements of a batch
     elaborated in one Lean check; the counterexample search of CA11 and CA18 on each; `quantity`
     ideas run in the sandbox. The model does not judge ideas.
  4. *What survives.* A `lemma` or a `reformulation` that elaborates and resists the search joins the
     blueprint as a candidate hole; a `counterexample` that Lean confirms goes to the certifier like any
     refutation; a `quantity` is an evidence node. An `approach` is shown to at most one session in two,
     at most two at a time, in the tail of the packet, under the title "Speculative, unverified", and
     is drawn at random so that its effect is measured as a lesson's is.
  5. *Marking.* Every idea is a `speculation` node recorded `learned`, stamped with its origin
     (`reverie`), its stimulus and its settings. It is never a claim, never a status, never a lesson,
     never part of a system prompt, and it does not leave its problem.
  6. *Budget.* At most 10% of the problem's remaining allowance, generation and funnel together
     (about $0.03 for 200 raw ideas at the measured prices), and never before the gate allows a new
     turn.
  7. *Measure.* On the problems of grades B and C that end at an impasse: the share where the next turn
     proves a new hole or refutes, with and without the line, at equal budget. Inside the line, each
     lever of item 1 against the plain call (state card, 20 ideas, nothing else): ideas that survive
     the funnel per dollar, and how many of them a later proof or refutation uses.
- **CA26. Teacher memory** (arXiv 2608.07169; allowed by the amended Global Constraint 16). A stronger model solves a
  few problems of a grade; from its Lean-accepted trajectories only, three memories are built for the
  small model: the blueprint shapes that worked (per domain), worked holes (retrieved by goal), and,
  per Lean error class, the fix that worked (retrieved when that error comes back). All stamped, drawn
  and judged by effect. This is procedure written from experience: it passes the gate of the amended Global Constraint 16
  and stays a measured arm, off by default.

## 8. Order and cost

1. **Measure and stop the waste**: CA1 to CA8, CA16, CA17, CA21. Then a baseline on grades A and B.
2. **The spine**: CA9 to CA15, CA22. Then the paired comparison of CA2.
3. **Refutations**: CA18 to CA20.
4. **Peripheral modules**, each after the graded bench has a baseline: CA23 and CA24, then CA25 as an arm.
   CA26 last.

A baseline arm on 60 problems at $0.50 costs at most $30 in model calls and, at the measured rate of
$0.5 to $0.7 an hour on the owner's machine, two days of wall clock; CA4 comes first for that reason.
A cloud environment with Lean would cut it to hours.

## 9. Not proposed, and why

- Specialised prover models as the default hole filler: trained on Lean 4.9-era Mathlib (stale names
  under 4.27), one hosted provider with unclear billing, and beaten per dollar by the general small
  model in a blueprint loop. Kept as an optional experiment (one arm).
- A trained router or stopping model (arXiv 2606.04883 saves 29% with a logistic regression): the
  owner withdrew learned selectors (PD8). Its portable part, error diversity as a stop signal, is in
  CA7.
- A hosted Lean service as the judge: Lean stays local and the certifier stays the only road to
  `proved`.
- A local 8B prover on a 4-core CPU: a few tokens per second.
- Shared evolutionary state between provers (AlphaProof Nexus): pays on the hardest problems only;
  later.

## 10. Questions for the owner, and the answers

The owner approved the whole change on 2026-11-10 ("Tout est approuvé. Go."), so the default proposed
for each question stands until they say otherwise.

1. Literature search and remote premise search send the statement, or a goal, to third parties.
   Answer: on for bench problems, asked once for `solve`, off with `--private`.
2. PutnamBench as grade B: its problems are public and probably in the models' training data. It is a
   yardstick for the loop, not a claim about research. Accepted as such.
3. The cap on the stronger model's share of an allowance: 25%.
4. Global Constraint 16 is amended, from a ban to a gate (the owner first thought of withdrawing it;
   this thread advised the amendment, and the approval followed):
   - *Kept:* a learned artifact is unverified, carries its provenance stamp and is never a fact or a
     claim's status; text from an external source keeps its provenance and never becomes a lesson or
     part of a system prompt. These cost nothing at run time, they protect "Lean is the judge", and
     the stamp is what lets a run measure whether a memory helps.
   - *Changed:* "no mechanism writes free-form procedural skills from the agent's own experience"
     becomes: procedural memory written by a model (from Seshat's own outcomes, or from a stronger
     model's) is allowed behind a gate. Its source is Lean-accepted outcomes, or sentences that cite
     journal events. It is shown by random draw and judged by its measured effect, and it is switched
     off when the effect is negative. The injected part has a size cap. It is an option, off by
     default until it has beaten the run without it on the graded bench.
   - *Changed:* "at most 3 skills loaded in full" becomes the default of an option.
   Why not withdraw: the evidence splits by who writes and how it is checked (self-written free-form
   skills -1.3 points, curated +16.2, arXiv 2602.12670; a stronger model's memory for a smaller one
   +3 to +27, arXiv 2608.07169; notes checked against transcripts, large gains, Anthropic 2026-11-06),
   and no memory line has yet run on a real model here. The gate opens CA24's page, CA25's approach
   hints, CA26 and the heuristic cards a model proposes (HB5 item 4, open since 2026-11-05).
   First measure, already built: the memory on/off probe (PE9) on grades A and B.
5. The name of CA25's line in the repository: `reverie`.

## 11. What is not verified

The run journals (this thread could not reach the machine): every per-check figure above comes from
run totals. The PutnamBench commit for Lean 4.27. Whether Goedel-Architect's code is public and under
which licence. `decide +kernel`'s axioms on 4.27. The LeanHammer tag for 4.27. The share of false
sub-lemmas in any system. Sizes and licences of the other benchmarks named in the research note.

Added with section 7: whether the providers honour `temperature` with thinking off as the host profiles say, and whether any exposes min-p; any gain from
CA24 to CA26 on mathematics (the published gains are on tool use, text corpora and games).
