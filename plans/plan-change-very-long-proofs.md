# Plan change: very long proofs (VL1 to VL10)

Status: **APPROVED by the owner 2026-11-24 at 19:49 UTC** (decision card "Approuver la proposition VL1 à VL10, et jusqu'où ?",
option "Tout, dans l'ordre proposé": VL1 and VL2 free first, then VL3 to VL6 and VL9; VL7 and VL8 only on a measured need;
the B5 run of VL10, at most $5, still needs the owner's go). Proposed 2026-11-24. Written by the thread "Lever les murs des très longues preuves"
(read-only on the repository and the plan), after the owner asked for a reflection on what keeps Seshat from producing
very long Lean proofs for long-horizon campaigns. The report it rests on, in French:
`research/preuves-tres-longues.md` (in the project files). Read against `main` at `b5aa04d`, the ledger's
entries of 2026-11-20 and 2026-11-24, and the plan changes LH, LP, DP and CL. DP7 (local recursion on `too_hard` holes,
depth configurable, default 1) is being built and is assumed here.

## Evidence in one paragraph

A long proof runs at about 23 Lean lines per declaration (AxiomProver on Putnam 2025 B5: 1,495 lines, 66 theorems;
Math Inc's strong PNT: about 25,000 lines, about 1,100 declarations), so at constant yield its cost is linear in length.
At Seshat's scale the binding constraint is the yield of holes, not any of the three walls the build thread named: in
run 7 (`solve-v2-long`, $0.45) 4 of 26 holes were proved and 22 ended `too_hard` by `turns`, although a hole is a short
proof and short proofs are where Seshat succeeds (13 to 16 of 20 level-B Putnam problems in run 3). The three walls are
real later: decomposition errors cost money, never correctness, because Lean checks the link lemma and the certifier
replays everything; single-module certification (`SeshatCertify` replays one module and refuses extra imports) does not
bite before about 10,000 lines; the library wall is real from T2 on, because M3 promotes only general lemmas (imports
only, no local definition) and the `have` draft (DP1) cannot declare a definition. A fourth wall the build thread did
not name may bite at T1: every `lean_check` re-elaborates the whole file, frozen prefix included (LP3), under a 120 s
bound (`checkTimeoutSec`), so Lean time grows with the square of the number of frozen lemmas; it is not measured yet.
The prompt has the same shape: the locked prefix is shown by statement, but all of it, in every request. Every large
AI formalization found (strong PNT, sphere packing in dimensions 8 and 24, about 200,000 lines) started from a blueprint
and definitions written by people. Million-line proofs are computational certificates; one was recently produced
without `native_decide` by splitting the computation into 3,524 chunks reduced by `decide +kernel` (Erdős-Mollin-Walsh
below 10^14, about 46 CPU hours, standard axioms only).

## Principle

Measure before building, fold into what exists, and aim at the scale the mission can pay for. T1 (300 to 3,000 lines)
in a campaign for a few dollars is the target now; T2 (3,000 to 30,000 lines) comes with a blueprint given by a person
or a paper; T3 is a computational certificate or a human project. Each item modifies an existing module or option, sits
behind `RunConfig.longProof` or the campaign, leaves `v1` and `v2` byte-identical, and two items (VL7, VL8) are built
only when a measured number calls for them.

## Items

Kinds: measurement (MEASURE), modify a module (MOD), add within a module (ADD), settings only (SET), conditional
(COND).

| Id | Kind | Change | Acceptance |
|---|---|---|---|
| VL1 | MEASURE, free | **Why 22 of 26 holes failed.** On run 7's journal (`run7-lift-B3`), classify each `too_hard` hole: A false or suspect (`suspect_false` from the pre-flight's `plausible`, `statement_wrong`), B true and cut while progressing (Lean error count falling across its checks, inner `have`s closed), C no progress (error count and failure class flat), D ill-posed (statement size, hypothesis count, `⋯` or coercion noise from `extract_goal`). Journal-only first (any machine with the run directory, or a copy uploaded to the project files for a cloud `harness audit`); then a Lean pass with no model ($0): the battery with a 120 s limit and `plausible` on every hole. Code: the hole rows of LP1's length section in `harness audit` gain these columns (ADD, `length.ts`). | A table of the 26 holes with class and evidence, in the ledger; the decision it supports: VL3 if B dominates, DP7's depth if C dominates, VL4 if A dominates, an extraction fix if D dominates. |
| VL2 | ADD (`harness audit`) | **Three slopes.** The length section fits, per run: Lean seconds per check against the lines of the locked prefix; input tokens per request against the number of frozen links; dollars spent on holes that end false, suspect or abandoned by a refinement round, as a share of the problem's spend. Read only from the journal and the `tool_run` pairs that LP1 already reads. | On run 6 and run 7, the three numbers in the ledger; on a simulated journal, the fits recover the planted slopes. |
| VL3 | MOD (LP5's `holeContinuation`) | **A hole's budget follows its Lean progress.** Under `longProof`, the one continuation of LP5 becomes: a hole session cut by its turns is continued while its last session made Lean progress (fewer errors at its last check than at its first, or an inner `have` closed), under LP4's `dryChecks` rule applied to the hole and the gate's ledger; it stops at the first session without progress, then refinement or DP7 as today. The option keeps its name, gains `holeContinuation: "progress"`, and `true` stays one continuation. | Simulated: a hole whose errors fall by one per session is continued until proved or the allowance; one whose errors are flat gets no continuation; `true` and `false` byte-identical to today. |
| VL4 | MOD (M12 hole scheduling, `proofnumbers.ts`) | **Suspicion has a price.** Under `longProof`, a hole's `suspect_false` node (pre-flight `plausible`, or a session's unproved `statement_wrong`) sets its disproof price low in the weighted proof numbers M12 already uses, and a hole with one goes to DP7's local redraft before any further paid session on it. `suspect_false` still sets no status. | Simulated: of two sibling holes, the suspect one is redrafted first and its sibling's sessions wait for the redraft; without `longProof` the order is today's. |
| VL5 | MOD (DP1 draft, LP3 view, M3 index) | **A local theory.** (a) The draft prompt allows a DEFS region before the `have` steps (`def`, `abbrev`, `structure`, with their simp lemmas proved or in `sorry`); the lifter keeps it as the blueprint's context, which task 51's `contextFor` already gives each hole that names it, and LP3 freezes it once checked. (b) Past `freeze.showAll` frozen links (default 40), the view shows the k most relevant statements for the current goal (M3's BM25 over the frozen statements, k default 20) and says how many are hidden; M3's `library_search` searches the frozen links as a second corpus, marked "proved in this problem". No new store: the corpus is LP3's `accepted_lemmas` nodes (DP5). | Simulated: a draft with a `def` gives holes that type-check with it; with 60 frozen links the prompt holds 20 and the count, and grows no further with more links; a search by a hole's statement finds a frozen link; below the threshold the view is today's. |
| VL6 | ADD (`--sketch`, M12 `readSketch`) | **A person's or a paper's blueprint in Lean.** `harness solve` and `harness campaign` accept `--sketch FILE.lean`: a Lean file of `sorry`'d declarations in signature form ending in the target, for instance written from a leanblueprint dependency graph. It is screened by the validator, read by `readSketch`, its link lemma checked by Lean, and registered as the first M12 blueprint (journaled `m12_sketch` with `human: true`, the file as a blob under the person's name). A text `--sketch` keeps today's meaning. The target statement stays the signed one. | Simulated: a 5-declaration Lean sketch is registered as a healthy blueprint with 5 holes; a sketch whose last declaration is not the signed target is refused before any spend; a text sketch is unchanged. |
| VL7 | COND (capability contract `lean.check`) | **Elaborate the frozen prefix once.** Built only if VL2 shows a check on the frozen prefix above 25% of `checkTimeoutSec` at the target size (by default 66 links, B5's count). The contract gains an optional `prelude: {id, hash, text}`: the implementation elaborates it once and checks later bodies in the resulting environment (REPL environment continuation, a pickled environment, or a module compiled to `.olean` in a directory the checker sees, as each implementation can); an implementation that cannot answers as today, with the prelude inlined. The certifier is unchanged: it still replays the whole file. | Fake server: the prelude is sent once and later checks send only the body; a server without the option gets the inlined file; the messages' line numbers are those of the full file; registry hash changes only when the option is used. |
| VL8 | COND, trust-critical (certifier) | **Certification by modules, all constants replayed.** Built only if a real whole-file certification exceeds half its limit, and with the owner's approval and a review. Run-local modules are compiled separately; `SeshatCertify` accepts, beyond the reference's imports, run-local modules listed in the request with their content hash journaled, and **replays every constant of every listed module** through the kernel in the same process (lean4checker's rule: nothing imported from the run is trusted on its signature). Allowed axioms are collected over all of them. | Fake `lake` plus a real-Lean case when built: a two-module proof certifies; a module whose hash differs from the journal's is refused; a forbidden axiom in an imported run module is refused. |
| VL9 | ADD (battery, validator), owner question | **Computational certificates, kernel only.** (a) `decide +kernel` joins M10's battery tactics, after checking on Lean 4.27.0 that it exists under that name, adds no axiom, and passes the validator's token screen. (b) A finite claim over a range can be split by M16 or the person into chunk lemmas (`∀ n ∈ [a, b), P n`), each a hole the battery closes with `decide +kernel` and no model call; the hole session is never started for a chunk the battery closes. (c) `native_decide` stays refused; whether a campaign may one day let a native proof reach `computed` (marked native, never `proved`) is the owner's question, not built. | (a) A battery test with the simulated Lean; one real-Lean check of the three conditions. (b) Simulated: a range of 10 chunks is closed with 0 model calls; a chunk the battery does not close becomes an ordinary hole. |
| VL10 | SET (campaign), then one paid run | **A long-proof campaign preset and its first test.** `harness campaign --long` sets `longProof` (drafts 3), DP7's depth 3, `holeContinuation: "progress"` (VL3), `frontier.show`, the sorry battery; no code beyond the preset. First test, the owner's decision and after VL1 and VL3: Putnam 2025 B5 (reference 1,495 lines, 66 theorems), a cap of $5, off-peak, DeepSeek flash, with `--watch` and a detached command. | The preset in `documentation/campaign.md` and `parameters.md`; the run's report: holes proved by depth, dollars per proved hole, VL2's three slopes, and whether B5 is certified. |

## What this changes in approved work

- **LP5**: `holeContinuation` gains the value `"progress"` (VL3); `true` keeps its meaning.
- **DP1**: the draft may declare definitions (VL5a); steps stay `have ... := by sorry`.
- **LP3 and DP5**: the view of the locked prefix is bounded past a threshold (VL5b); the record stays `accepted_lemmas`.
- **DP7**: VL4 decides which hole is redrafted first; VL10 sets its depth for a long campaign; the default stays 1.
- **M3**: its index gains a second corpus (frozen links), its promotion rules do not change (general lemmas only).
- **CA14 (`--sketch`)**: accepts a Lean file (VL6).
- **LH7.2 (the $10 marathon)**: unchanged; VL10's B5 run is a separate, smaller test of the long-proof path.

## Design: one piece, one place

| Item | Where | New file |
|---|---|---|
| VL1, VL2 | `packages/orchestrator` audit, `length.ts` | none |
| VL3 | M12's hole task (`hole-work.ts`), LP4's `dryChecks` | none |
| VL4 | `proofnumbers.ts` inputs in M12 (`line.ts`) | none |
| VL5 | DP1's draft prompt and `lift.ts`; `sketch.ts` view; `@seshat/library` index | none |
| VL6 | `--sketch` parsing in the CLI; M12 `readSketch` | none |
| VL7 | `lean.check` contract and its implementations | none |
| VL8 | `lean/SeshatCertify/Main.lean`, `packages/lean-local/src/certifier.ts` | none |
| VL9 | M10 battery list, validator screen, M16 split | none |
| VL10 | campaign presets | none |

## Trust rules, unchanged

- Only Lean decides. A hole from a person's Lean sketch (VL6), a local definition (VL5) or a chunk (VL9) is `open`
  until `validate` accepts its proof; the target is the signed statement, compared by the certifier as today.
- `suspect_false` and every pre-flight result stay evidence: VL4 changes the order of work, never a status.
- VL7 changes how the fast check is computed, not what makes `proved`: the certifier replays the whole file.
- VL8 is the only item that touches the certifier; it replays every constant of every run module, so nothing from the
  run is trusted on its signature; it is built only with the owner's approval and a review.
- `native_decide`, `Lean.ofReduceBool` and `Lean.trustCompiler` stay refused (VL9c).
- The journal stays the only source of truth: sketches, frozen links, chunks and module hashes are nodes or blobs.

## Dropped, with the reason

Aiming at millions of lines of reasoning (about $5,000 at run 7's yield, and the yield does not stay constant);
a full multi-file Lean project inside a run before T2 (no measured need at T1); accepting `native_decide` for
`proved` (trust); training or fine-tuning (Global Constraint); a new library store for local theory (LP3's record
suffices).

## Order and cost

1. VL1 and VL2: free. VL1 needs run 7's journal on any machine that has it (or uploaded), and a Lean for its second
   pass; no model.
2. VL3, VL4, VL5: model-free code, simulated, behind `longProof`; the order set by VL1's classes.
3. VL6, VL9 (a, b): model-free code; VL9 (a) needs one real-Lean check.
4. VL10: the preset, then the B5 run at most $5, with the owner's yes and a topped-up balance (about $2.13 left).
5. VL7, VL8: only when VL2 or a real certification gives the number that calls for them.

The only paid run proposed is VL10's, at most $5.

## Questions for the owner

1. Run VL1 and VL2 first, free, and let VL1's classes order VL3 to VL5? Recommended: yes.
2. Build VL3, VL4 and VL5 behind `longProof`? Recommended: yes.
3. Accept a Lean blueprint as `--sketch` (VL6), as the path to T2? Recommended: yes.
4. Kernel-only certificates (`decide +kernel`, chunks) and `native_decide` kept refused (VL9)? Recommended: yes, and
   the `computed (native)` question left open until a campaign needs it.
5. VL7 and VL8 only on a measured need, VL8 with your approval then? Recommended: yes.
6. The B5 campaign at most $5 after VL1 and VL3 (VL10)? Recommended: yes, when the balance allows.

## What is not verified

- The elaboration cost of a frozen lemma on real files (VL2 measures it); the T1 risk of the check bound is a hypothesis.
- VL1's classes: run 7's journal was not read here; the run died after one hour, so some holes may have had fewer
  sessions than their budget.
- That `decide +kernel` exists under that name in Lean 4.27.0, adds no axiom and passes the validator's screen.
- Whether the Lean server in use exposes environment continuation; otherwise VL7 needs a compiled module the checker
  can see.
- The 23 lines per declaration rests on two data points; the strong PNT and sphere packing figures are Math Inc's own
  pages; the FLT figure quoted in the report is from another paper's introduction, not checked.
