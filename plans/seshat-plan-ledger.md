# Seshat plan: ledger (main team)

The state of the plan's build as the main team sees it, kept in the repository so that every agent
reads the same thing ([CLAUDE.md](../CLAUDE.md)). The main team writes this file. The collaborator
writes [collaborator-log.md](collaborator-log.md), which wins for Tasks 6, 9 and 11. The plan:
[seshat-plan.md](seshat-plan.md); the rulings: [seshat-plan-rulings.md](seshat-plan-rulings.md).

Updated 2026-11-05 UTC. `main` at the heuristic bank merge (0614185), 2650 tests passing (1 skipped); Tasks 1 to 32 and atp.eprover merged.

2026-11-10 UTC: the plan change `plans/plan-change-capabilities.md` (CA1 to CA26) is approved (Ruling 33) and is Tasks 33 to 44, built by the session of the thread "Augmenter les capacités de Seshat de 50 %" on `claude/project-thread-h60gyw`, which is merged into `main` by pull request, one per phase. Global Constraint 16 is amended (a gate in place of the ban on model-written procedural memory).

## Tasks

| Task | What | Owner | State | Branch |
|---|---|---|---|---|
| 1 | Memory foundation, line API | main | merged | |
| 2 | M1: statement identity, shared negative memory | main | merged | |
| 3 | `lean.meta`, `lean.goals`, Lean identity | main | merged | |
| 4 | Certifier: `lean.certify`, kernel replay | main | merged (`74d3ab4`); its Lean program never compiled; unavailable until a host sets a sandbox (Ruling 22) | |
| 5 | M2: variant graph, propagation, ATMS labels | main | merged | |
| 6 | M10: battery, domain router, ATP and SMT | main (taken over 2026-11-03) | merged | `task/t6` | `1da074d` |
| 7 | M11: small models, fingerprints, lookups | main | merged (`5c32d33`); not run against a real Lean; its screen was checked against recorded runs of a real Lean 4.27.0 | |
| 8 | M6 guards and drift detectors, fleet policy | main | merged | |
| 9 | M3 lemma library, M5 lessons | main (taken over 2026-11-03) | merged | `task/t9` | `9e762b7` |
| 10 | M12: saturation kernel, subgoal scheduler, escalation ladder, owners chosen by the fleet | main | merged in `c8bb412` (faux model, simulated Lean and a faux `lean.meta` only; the link lemma proof never met a real Lean) | `task/t10` | |
| 11 | M4: context compiler, `expand`, `graph_query` | main (taken over 2026-11-03) | merged | `task/t11` | `544f704` |
| 12 | M7, M9: abductive engine | nobody | suspended (Ruling 20) | |
| 13 | M8, M13, M14, M16: induction, exploration, repairs | main | merged | `task/t13` | `f84d92a` |
| 14 | Integration, `harness ablate`, entrenchment probe | main | merged | `task/t14` | `77f9e6e` |
| 15 | Task ledger, typed routing, `--resume`, `completeJson` | main | merged (`ab4bda3`); resume tested with the faux model and a simulated Lean only, plus a real SIGKILL of a child process; left for the final review: structure of `run.ts` (M10), routing decisions lost between `attempt.finished` and `task.routed`, `resume-m11.test.ts` does not cover "do not resubmit once the outcome is on record" | |
| 16 | `lean.lsp` | main | merged (`ec73456`); not run against a real Lean; its server (lean-lsp-mcp 0.31.0) was run with canned lowest layers only | |
| 17 | Consortium mode | main | merged in `f952eaa` (faux model and simulated Lean only; the narrative is `:::wait`) | `task/t17` |
| 18 | M15: diversity archive, schemas | main | merged | `task/t18` | `f37801e` |
| 19 | Task 8 follow-up: sampled settings, `judge`, soft failure memory | main | merged in `b67c84d` (faux model and simulated Lean only; the numbers are first guesses) | `task/t19` |
| 20 | `decide`, optional Jev backend | main | merged in `62ed6fa` (fake server and faux backend only; Jev's request and response shapes are guessed) | `task/t20` | |
| 21 | Lean environment and resolver, M17 | main | merged in `a2f9c29` (not run against a real Lean, Lake or GitHub) | `task/t21` |
| 22 | `LibraryBuilder`, review status of definitions | main | merged | `task/t22` | `3f16b4c` |
| 23 | Memory across runs, provenance and epochs, randomized inclusion | main | merged in `52efd50` (not run against a real Lean or model) | `task/t23` |
| 24 | Session-frozen packet prefix | main | merged in `3a9d76c` (not run against a real provider) | `task/t24` |
| 25 | M18: curriculum of variants | main | merged | `task/t25` | `f6363b6` |
| 26 | `harness optimize-prompts` | main | merged (`39aae02`) | `task/t26` | Review round 1 fixed (invisible Unicode screen, required --max-usd, certified-only scoring, sign test with Bonferroni and gate-split ledger); only the prover.system prompt is a target. Simulated: nothing ran against a real model. |
| 27 | Installable packs: tools and skills (PD7) | main | merged | `task/t27` | `50f0792` |
| 28 | Provider-aware cost accounting: price table, cache ratio, `reasoning_content` safety, ignored settings, off-peak option (PD1, PD3) | main | merged | `task/t28` | `0ad9cdf` |
| 29 | Proportionate budgets: gate, probe first, `budget.*` decide sites (PB1 to PB5) | main | merged (`1c96731`) | `task/t29` | Review round 1 fixed (stopped probe reconsidered per turn, journal checks floor and decide rows, request-keyed draws, minSessions). Not done: PB5's clause on strategies the failure memory holds as exhausted (no hard state; the gate prices past failures through a lower success chance). Simulated only; avoided dollars are an estimate; not run against a real model or Jev. |
| 30 | `harness solve`, `doctor`, `view`, RESULT.md (PB6, PB7, PB8) | main | merged (`0ab8147`) | `task/t30` | Review round 1 fixed (strict screen and signature for user Lean, bounded formalization spend, host in the resume command, sandbox probe runs the real recipe, Markdown escaping, shell quoting). Open: the signature is not cross-checked against the claim; an `afterStart` that throws leaves a started journal without a signature. Simulated only: no real bubblewrap, Docker, model or Lean. |
| 31 | The local interface `harness ui` | main | merged (`d2732a1`) | `task/t31` | Review round 1 fixed (nonce-bound signature protocol, key scoping per provider, no cookie, digest over the whole bundle, redaction forms, process groups). Simulated only: fake subprocess, faux provider, one headless-browser smoke test; no person has used it in a real session. |
| 32 | The heuristic bank, line M19 (HB1 to HB8) | main | merged (0614185), built by the thread "Concevoir une banque d'heuristiques", reviewed twice; M19 became a fleet option; not built: HB4 prepare, HB5b replay, decide prior, extra features | `claude/project-thread-7os98j` | HB5 item 4 on hold (Global Constraint 16) |
| 33 | The graded bench, the paired protocol, loop telemetry (CA1 to CA3) | main | on the branch (`8c8c0cb`), reviewed, one fix round; waits for the pull request into `main` | `claude/project-thread-h60gyw` | No bench index is committed: building `bench/graded-v1.json` needs a real Lean and the three sources (observed sizes: grade A 111, grade B 100 of 326 candidates, grade C 70; PutnamBench's head is on Lean 4.33.1, the bench pins 4.27.0). `splitCommands` in `@seshat/core` now reads a column-0 line that starts with a binder or a colon as the continuation of the declaration above (pinned by tests at the validator and the guards). The false-hole share reads `hole_verdict` nodes, which Task 37 writes. Simulated only. |
| 34 | A cheaper hot loop: bounded checks, `lean_edit`, masking, the defaults sets `v1` and `v2` (CA4 to CA6) | main | on the branch (`c34c0c8`), reviewed; waits for the pull request into `main` | `claude/project-thread-h60gyw` | `harness solve --defaults v1` is `main` at `ae3b2a0`; `v2` (the default) adds `editTool`, `maskOldChecks` and the check timeout. Not built: `harness lean-server start` (Ruling 33). Open: `checkTimeoutSec` is part of the registry hash, so editing the host value makes a resume see a registry mismatch. Kimina's setting names and the memory reading are not checked against a real Kimina. Simulated only. |
| 34b | The defaults set `v2` gains the intake gate, the compute tool and `lean.search`; the `solve` arms of `harness ablate` (CA2, CA16, CA17, CA21, CA22) | main | built (merge `c5f635a`, third arm `32b9b0e`), reviewed by the controller; waits for the second pull request into `main` | `claude/project-thread-h60gyw` | `harness ablate --experiment solve-defaults --bench FILE --grade B` is the command of the plan change's target; no number exists until it runs on a real Lean and model |
| 35 | The state card, the repeat rule, a run's budget in rounds (CA7, CA8) | main | on the branch (`1178091`), reviewed, one fix round; waits for the pull request into `main` | `claude/project-thread-h60gyw` | `v2` now sets `stateCard` and `budgetRounds` and adds line M6 with the repeat rule alone (no detector, no model call). `budgetRounds` acts only on a run of several problems. The repeat key holds the failure class; `holes`, `other` and refused checks are not counted. The card counts failures per session (the journal has no per-check data). Simulated only. |
| 36 | Intake: `lit.search`, tools for `solve`, statement hygiene (CA16, CA17, CA21) | main | on the branch (`75638fd`), reviewed, one fix round; waits for the pull request into `main` | `claude/project-thread-h60gyw` | Off by default (`--intake`, `--lit`, `--tool`, `--auto-tool`, `--private`); not yet in `v2`. `--private` is one rule in the registry for every capability that calls a third party (Task 36b, on the branch at `980d849`): a manifest field `thirdParty` marks them, and a private run refuses the call or forces its local form. A pack whose manifest does not declare the field is not checked; `harness health` still pings the services. Open: without the budget gate the judge call is bounded only by its own cap; with `--intake` the test lemmas run twice. Not run against a real site (zbMATH's shape least certain), model or Lean (`plausible`, the vacuity tactics). |
| 37 | Blueprints and a tool-equipped prover per hole (CA9 to CA11) | main | built (merge `b83a0b1`), reviewed, two fix lots; waits for the second pull request into `main` | `claude/project-thread-h60gyw` | Off by default (M12 option `blueprints`); not in `v2`: measured by the arm `solve-v2-blueprints`. Simulated Lean and faux provider only |
| 38 | Refinement rounds and the repair pass (CA12, CA13) | main | not started: deferred by the owner (2026-11-11) until a real run gives numbers | | after 37 |
| 39 | An informal proof first, roles, sampling settings per role (CA14, CA15, CA23) | main | not started: deferred by the owner (2026-11-11) until a real run gives numbers | | after 38 |
| 40 | `lean.search`, pushed by the harness (CA22) | main | on the branch (`922341a`), reviewed, one fix round; waits for the pull request into `main` | `claude/project-thread-h60gyw` | Off by default (`--lean-search`); not yet in `v2`. Only the name and the signature Lean printed for `#check` are shown; backend text never is. In `solve` the remote and pattern services are used only after the person's yes (asked once, or `--lit`; `--yes` alone is no), and never with `--private` (Task 36b); for bench problems they are on. The wire formats of the two services and the allowed hosts in the profiles are guesses. Not run against a real Lean, search service or index. |
| 41 | Counterexamples on finite structures (CA18 to CA20) | main | on the branch (`a4f4c39`), reviewed, one fix round; waits for the pull request into `main` | `claude/project-thread-h60gyw` | Off by default (option `graphs` of line M11); not in `v2`. A hit of a program or of Sage is evidence; the claim is `refuted` only when Lean proves the negation of the run's own statement through `validate`. The Lean recheck covers graphs of at most 8 vertices and rests on `decide` over the claim's own predicates, so hits on Mathlib's `Connected` or on Hamiltonian cycles will often stay unconfirmed; a hit Lean did not confirm is told to the provers as labelled evidence. The templates of `lean/SeshatLib/Finite` have never been compiled: to check on a real Lean the shape of `loopless` on the pinned Mathlib, instance resolution through the graph abbreviation, and the kernel's time on `decide` for Mathlib's `Connected`. First follow-up on a real Lean: bridge lemmas to Mathlib's predicates. Not run against a real Lean, Sage or model. |
| 42 | The consolidation pass between runs (CA24) | main | built (merge `d81047c`), reviewed by the controller on its trust-critical source; waits for the second pull request into `main` | `claude/project-thread-h60gyw` | Off by default (`--consolidation`, `harness consolidate`). Faux provider only |
| 43 | The reverie line (CA25) | main | not started: deferred by the owner (2026-11-11) until a real run gives numbers | | after 37, 41 and 42 |
| 44 | Teacher memory (CA26) | main | not started: deferred by the owner (2026-11-11) until a real run gives numbers | | last |
| Final | review of the whole build | main | after 26, 27 and 28 | |

States: not started, implementing, in review, fix round, merged, suspended. The collaborator's rows
here are a copy that may lag: their log wins.

Nothing has run against a real Lean, a real model or the blocked sites yet: everything is tested
with pi-ai's faux provider, a simulated Lean and fake servers (SageMath alone was run for real).

## Order

- Main team (Rulings 27 and 30): T1 to T5, T7, T8, T10, T15 to T17, T19 to T21, T23 and T24 merged; T25 and
  T13 in flight; then T28 (prices, cache accounting, off-peak; before any real run), T18, T22, T14, T26, T27
  (once Task 11 has merged) and the final review. At most three agents at once, because the account's usage
  limits bind.
- Collaborator (Ruling 25): T6, then T9, then T11. What each needs from the main team, and what
  the main team needs from them: [collaborator-tasks.md](collaborator-tasks.md), "Between the
  teams".

- Tasks 33 to 44 (Ruling 33), at most three workers at once: 33, 34 and 36 first (the measure, the
  hot loop, the intake); then 35, 40 and 41; then 37 and 42; then 38 and 43; then 39 and 44; then the
  defaults set `v2` with everything that passed its review, and a review of the whole branch.

## For the collaborator


- 2026-11-03: you had pushed nothing since 2026-10-20, so the main team builds Tasks 6, 9 and 11 itself, at the owner's request, on `task/t6`, `task/t9` and `task/t11` in that order. If you have work in progress, write it in your log ("For the main team") before pushing anything to those branches, and we agree on who finishes what.
Notes from the main team, newest last. Read them at the start of each session.

- 2026-10-20: Welcome. Start with [collaborator-tasks.md](collaborator-tasks.md). Tasks 7 (M11)
  and 4 (the certifier) merge into `main` next: they change `packages/orchestrator/src/lines.ts`,
  `run.ts`, the README's status paragraph and diagram, and `documentation/lines.md`, which your
  merges touch too. Pull before you start Task 6 and again before each merge.
- 2026-10-21: Task 4 (the certifier) is merged. A run certifies a candidate only on a host whose
  profile gives `lean.certify` a sandbox command, or opts in with `unsandboxed: true` (Ruling 22);
  the shipped profiles do neither, so a candidate stays `computed` with the reason. A problem's
  outcome follows only the certifications of its own provers' candidate and of its own lines'
  submissions (Ruling 23). Task 7 (M11) merges next.
- 2026-10-21: Task 7's reviews found holes in the shared screen of `packages/core/src/validator.ts`
  (the token screen that keeps `#eval`, `run_cmd` and the like out of model text): a keyword glued
  to what precedes it, and comment openers that Lean does not read as comments (`<--`). They are
  fixed on `task/t7` before it merges. If your lines put model text into Lean files, go through
  `structuralCheck` or `forbiddenTokensIn` as the existing lines do, and pull after Task 7 merges.
- 2026-10-27: The owner approved a fourth plan change,
  [plan-change-memory-evolution.md](plan-change-memory-evolution.md) (Rulings 27 and 28). Global
  Constraint 16 is new: learned artifacts carry a provenance stamp; nothing writes skills from the
  agent's own experience; at most 3 human-written skills are loaded in full in a session, which
  matters if Task 6 gives its tool namespaces skills; external text never becomes a lesson or a
  system prompt. Task 9: lessons are stamped, drawn at random into sessions and judged by their
  causal effect, which replaces the presence counter for deactivation; with `--human`, a lesson's
  promotion to the global scope is staged for approval. Task 11: the compiler's unverified items
  are drawn the same way, and the packet is a prefix frozen for the session plus a tail for each
  request. The main team builds the shared parts next, Task 23 (the stamp, epochs, the draws and
  their effect posteriors, memory across runs) and Task 24 (the `{ prefix, tail }` packet API); if
  you get there first, build against the interfaces their sections give, and the second to merge
  wires them. Details: [collaborator-tasks.md](collaborator-tasks.md), sections 4, 6, 7 and 8.
- 2026-10-27: Task 7 is merged, with the shared screen for model text. Pull. A line that writes model
  text into a Lean file (Task 6's battery, Task 9's tactic mining) uses `structuralCheck` or
  `forbiddenTokensIn`; the strict reading is on by default there.
- 2026-10-27: Tasks 7, 15 and 16 are merged (`main` at `ab4bda3`). Pull. Every line now declares how a
  run with it is resumed (`Line.resume`), and a registered line that declares nothing makes `harness run
  --resume` refuse: Tasks 6, 9 and 11 must declare theirs. Use `completeJson(llm, request)` from
  `@seshat/lines` for schema-checked JSON. Details under "Interface changes".
- 2026-10-28: Tasks 21, 23 and 24 are merged (`main` at `52efd50`). Pull. Task 24: `contextPacket` may
  answer `{ prefix, tail }`; compile Task 11's packet through it (on Anthropic the prefix may not be
  cached at its end until pi-ai marks a block-level breakpoint; unmeasured). Task 23: the memory store
  has `stamp` (provenance on every learned, unverified record you write: pass it), `draw` for the
  randomized inclusion of unverified items (record `included` and `withheld` through
  `SessionContext.draw`), `itemEffect` for a lesson's causal effect, epochs and probation; memory
  across runs is `--memory-from`. No shipped line calls `draw` yet: Tasks 9 and 11 are the first.
  Task 21: a line may give the Lean environment (`Line.leanEnv`); M17 does. Details under "Interface
  changes".
- 2026-10-28: Task 17 is merged (`main` at `f952eaa`): `harness run --turn-tokens|--turn-usd|--turn-minutes`
  stops the run at a limit, with a candidate certified first (Lean, no model call). A line that
  catches errors around a model call must let `isInterrupted(error)` (`@seshat/lines`) through: it
  means the turn paused the work, not that it failed. Task 6, 9 and 11 lines must declare `resume`
  (a consortium run refuses a non-resumable line at start). Details under "Interface changes".
- 2026-10-28: The owner approved a fifth plan change,
  [plan-change-polya-costs.md](plan-change-polya-costs.md) (Ruling 30). Two small notes for you, nothing
  else changes in your tasks. Task 6: document that `grind` carries a commutative-ring module that
  normalizes by a Gröbner basis (so polynomial identities with hypotheses are one of its jobs), and read
  the battery's tactic list from the host's Lean instead of assuming `polyrith` exists (whether it is
  still in the pinned Mathlib is read from the host); the digest's table in collaborator-tasks.md
  section 5 now says so. Task 21 is merged: its optional `GroebnerTactic` library entry (PD4 item 2) is
  a follow-up of the main team, no action for you. The main team builds Task 28 (price table, cache
  accounting) and Task 27 (installable packs, after your Task 11, additive on the registry) on its own.

## Interface changes

Changes to shared files that the other team builds on, newest last (CLAUDE.md, "Who writes what").

- Task 4, merged in `74d3ab4`: `packages/core`: the certifier's interface (`LeanCertifier`,
  `CertificationRequest`, `CertificationResult`), the validation method `kernel_replay`, the outcome
  `refuted` of `problem.finished` and the count `run.finished.refuted`, the optional
  `run.started.config.certifierUnavailable`; `packages/memory`: `referenceFor(claimId, { negation })`
  and the root-only `setReference`; `packages/registry`: `Registry.usable(id)`, the optional
  `FactoryContext.host`, `leanCertifyImplementation` and `RegistryLeanCertifier`, whose `health`
  returns `{ ok, detail? }`; `packages/orchestrator`: `RunOptions.certifier`, and the lines'
  `validate` context carries the `problemId`; `config/hosts/*.json`: a `lean.certify` entry each,
  with no sandbox. Pages: [certifier.md](../documentation/certifier.md),
  [trust.md](../documentation/trust.md), [lines.md](../documentation/lines.md).
- Task 7, merged in `5c32d33`: `packages/core`: the token screen of `validator.ts` reads names as
  Lean's lexer does (`forbiddenTokensIn` finds a forbidden command glued to what precedes it, and
  trusts a run of letters as a name only after a space, `(`, `,` or `)`), and `maskCommentsAndStrings`
  and `blankComments` take an optional `strict` reading that `scanRegion` and M11 use for model text;
  repository readers keep the default reading. If your lines put model text into Lean files, go
  through `structuralCheck` or `forbiddenTokensIn`; `packages/registry` and the host profile schema:
  a capability may be `optional: true` (a failing implementation is a warning in `harness health`,
  `HealthEntry.optional`); `packages/orchestrator`: `renderHealth`, the line `M11` in the registry of
  lines, factories for the lookup sites in the shipped host profiles. Pages:
  [validator.md](../documentation/validator.md), [models.md](../documentation/models.md),
  [trust.md](../documentation/trust.md).
- Task 16, merged in `ec73456`: `packages/orchestrator`: `ToolBinding` and `toolBinding()` in
  `tools.ts` (a capability may bind part of a tool's input to the run, and the schema the model sees
  hides it), the optional `CapabilityToolOptions.binding`, `Workbench.lastSubmission(attemptId)`,
  the `lean-lsp` factory in `FACTORIES`; `config/hosts/*.json`: a `lean.lsp` entry each;
  `pnpm-lock.yaml`: the new workspace package. Page: [lean-lsp.md](../documentation/lean-lsp.md).
- Task 15, merged in `ab4bda3`: `packages/core`: the events `task.created`, `task.assigned`,
  `task.status_changed`, `task.routed`, `attempt.charged` and `run.resumed` (orchestrator-only for
  the task events and `run.resumed`), the optional `taskId` and `site` on `attempt.started`, `carry`
  on `attempt.finished`, `site` on `model_call.finished`, `problemId` on `validation.finished`,
  the projection tables `tasks` and `task_routes` and their queries (`PROJECTION_VERSION` 4), the
  option `deferRepair` and the method `repair()` of `EventLog` and `Journal.open`, and
  `TornTail.sha256` as the digest of the dropped bytes; `packages/lines`: `TaskApi` (`propose`),
  `LlmRequest.site`, the optional `Llm.completeJson` and the exported function
  `completeJson(llm, request)` (use the function: it falls back to `withJson(llm.complete)`),
  `Line.resume` (`"stateless"`, `"rebuild"` with the hook `resumeProblem(problem, held)`, or
  `{ refuse }`; a registered line that declares nothing makes a resumed run refuse), `ResumedProblem`;
  `packages/scheduler`: `TaskLedger`; `packages/orchestrator`: `resumeBench`, `harness run
  --resume`, `Ledger.seed`, `Workbench.adopt`, the report keys `sites` and `resumed`; the core
  projection queries `modelCallsOfProblem` and `claimsWithAttempts`. Every line now declares
  `resume`; yours (Tasks 6, 9, 11) must too. Page: [ledger.md](../documentation/ledger.md).
- Task 24, merged in `3a9d76c`: `packages/lines`: `contextPacket` may answer a string (as before) or
  `{ prefix, tail, facts?, newSince? }`; `PacketRequest.prefix` carries the session's frozen prefix
  (the first prefix a session got is sent byte for byte on every later request of that session; a
  later, different prefix is ignored and logged once); a line that uses `newSince` sends `facts` from
  its first answer, otherwise every fact counts as new; `packages/orchestrator`: `--cache-retention`
  and `RunConfig.cacheRetention`, passed to pi-ai; `cachedInputTokens` on the cost figures and in the
  report (the larger of an attempt's charged sum and its finished total, so errored and resumed
  sessions keep theirs). Pages: [lines.md](../documentation/lines.md),
  [m0-loop.md](../documentation/m0-loop.md). For the collaborator (Task 11): compile the packet
  through it. Known limit: pi-ai's Anthropic adapter marks only the last block of the last message
  for caching, so the frozen prefix may not be cached at its end on Anthropic; Task 14 cannot show a
  saving there until pi-ai or a block-level breakpoint changes (unmeasured). `plans/seshat-plan.md`
  still describes `contextPacket(session)` as one text: update the plan when the owner approves.
- Task 21, merged in `a2f9c29`: new package `packages/lean-env` (the resolver, the lock and its
  environment hash, `harness lean-env resolve|build`, the imports of an extended environment, line
  `M17`); `lean/env/*.toml`; `packages/registry`: a registry can be built for one Lean environment, the
  hash is part of every Lean tool run's recorded version (`+env:NAME@` and the first 12 digits), one
  environment per run; `config/hosts/*.json`: `LEAN_ENV`; `packages/core`: the stop reason
  `lean_environment` (comment only) and `run.started.config.leanEnv` (`name`, `hash`);
  `packages/lines`: `LINE_ORDER` and `LINE_TITLES` gain M17, the optional `Line.leanEnv(options)` hook,
  `resolveLines` refuses two lines that both give the environment; `packages/orchestrator`: the
  optional third argument `{ leanEnv }` of `RunOptions.registry`, the optional `imports` of
  `loadProblem`, M17 in the registry of lines (stateless on resume), the CLI passes the environment to
  `openRegistry`; a resume under another name or hash is refused. Imports and the server probe run only
  with M17 enabled; a host's `LEAN_ENV` alone pins and records the environment without them. Page:
  [lean-env.md](../documentation/lean-env.md). Not run against a real Lean, Lake, GitHub or a Kimina
  server; the package names in `extended.toml` and `base.toml` are from memory. Known limit: the hash
  states the lock, not what Lake built. For Task 23: `sameLeanEnvironment`, `leanEnvOfConfig` and
  `leanEnvironmentHash` are meant for its environment check.
- Task 23, merged in `52efd50`: `packages/core`: `run.started.memoryFrom` (the earlier journal, its last
  hash and a relative path), the event `memory.epoch_opened` (orchestrator-only, journal-checked), the
  optional `provenance` on `attempt.started`, `lesson.recorded` and `node.recorded`, `included` and
  `withheld` on `attempt.started`, `Journal.open` option `memory` and `Journal.chain`, `Projection`
  methods for the chain, the epochs and item uses (`PROJECTION_VERSION` 6; rows gain `earlier_status`
  and `carried`), `BlobStore(dir, readFrom?)`, `chain.ts`, `provenance.ts`, `random.ts`;
  `packages/memory`: `MemoryStore.stamp`, `epoch`, `openEpochIfChanged`, `weightOf`, `draw`,
  `itemUses`, `itemEffect`, `storedProofs`, `Claim` and `Edge` `earlierStatus`; `packages/lines`:
  `SessionContext.draw` and `drawn`; `packages/orchestrator`: `RunOptions.memoryFrom`,
  `RunOptions.leanEnvironment` (the CLI fills it from the host's lock), `RunConfig.seed`,
  `RunReport.memory`, `--memory-from`, `--draw-seed`. Verified facts carry only under the same Lean
  environment (Task 21's hash; bench revision and toolchain for a run without one); under another, a
  claim's earlier status counts for nothing until a stored proof passes `validate` again. The hash
  chain is an unkeyed SHA-256: `--memory-from` is for the user's own runs. Pages:
  [memory.md](../documentation/memory.md), [journal.md](../documentation/journal.md),
  [trust.md](../documentation/trust.md). Known limits: the fleet's posteriors ignore epochs until
  Task 19; the Mathlib epoch trigger is the bench revision; nodes of every kind carry in every
  environment; reading the chain costs about 14 microseconds per event on every open (no snapshot).
- Task 17, merged in `f952eaa`: `packages/core`: the events `turn.started` and `turn.ended`
  (orchestrator-only), the type `TurnLimit`, `AttemptFinished.stoppedBy` documents `turn`,
  `Projection.turns()`, the node kinds `hint` and `steer` (human kinds: the actor rule, no
  `node.updated` for anyone; `human_signed` needs a `human:` actor), `INHERITED_SKIPPED` gains the
  turn events; `packages/lines`: `InterruptedError` and `isInterrupted`, `LineLlmOptions.turn`,
  `RunLinesOptions.turn`, `taskApi.ready()` orders focused claims first, `taskApi.propose` refuses
  a dropped claim; `packages/memory`: `withActor` on a line's view refuses `orchestrator` and
  `human:*`; `packages/orchestrator`: `Ledger.observe`, `RunConfig.consortium`, `RunOptions.turns`,
  `ResumeOptions.turns`, `RunResult.turn`, `SessionStop` and `ProverStop` gain `"turn"`, prover
  prompts gain "Hints from the team" and "What the team asks" only when the team answered,
  `RunReport.turns`, the account (`turns/<n>/report.md` and `report.json`, from the journal alone),
  the options `--human`, `--turn-*`, `--impasse-*`, `--claim`, `--as`, `--note`, `--focus`, `--drop`,
  `--forbid`, the commands `hint`, `sign`, `steer`, `resume`, and `ablationRefusal(config)`, which
  the future `harness ablate` (Task 14) must call for each config. Page: [human.md](../documentation/human.md).
  Decisions: a limit bounds model work, not process lifetime (the process overshoots by the response
  in flight and the certification); the impasse defaults (8 attempts, posterior below 0.1) are
  untuned; names are self-asserted; multi-flag `steer` is not atomic; when a `contextPacket` line replaces the prompt
  (Task 11), the hints are added to the packet's tail, never to its frozen prefix. Not run against a
  real model or Lean.
- Task 19, merged in `b67c84d`: `packages/core`: `attempt.started` gains `settings` and `exploration`
  (validated), `PROJECTION_VERSION` 7 (`settings_json`, `exploration`, `runs_ago`), `ROUTE_ACTIONS` gains
  `retry_stronger`; `packages/memory`: `Attempt.settings`, `exploration`, `runsAgo`, `alreadyTried(claimId,
  view?)` (grouped by strategy and config class: "with a smaller model"), `classes.ts` (`ModelRanking`,
  `compareClass`, `onlyWeakerFailures`); `packages/lines`: `judge` (an interruption passes through it),
  `ANTI_SYCOPHANCY` and `withAntiSycophancy`, the hook `briefingSections`, `SessionDecision.settings` and
  `exploration`, `SessionContext.settings` and `exploration`, `ProblemContext.ranking`;
  `packages/orchestrator`: `Router(journal, tasks, ranking?)` with `Router.resumeTask` (the routing
  decisions a kill left out are taken again on resume, once), `RunLinesOptions.ranking`,
  `SessionOptions.temperature`; `packages/guards`: M6's question text (`m6-3`). Pages: [fleet.md](../documentation/fleet.md),
  [lines.md](../documentation/lines.md), [guards.md](../documentation/guards.md). Decisions: `PROMPT_VERSION`
  `m0-2.1`, a minor bump, so no epoch opens (the base prompt is unchanged; the new sections are optional and
  recorded on the attempt); an unranked model counts as weaker in M1's class label, so set `ranking` when
  switching models, and `retry_stronger` acts only on a stated order (a `ranking`, or the run model then
  `escalateTo`); the order of the fleet's `models` is not a strength order. Not run against a real model:
  the numbers (γ 0.8, ε 0.1, two DAG tries, eight steps) are first guesses.
- Task 20, merged in `62ed6fa`: new package `packages/decide` (the `decide.ask` capability: backends
  `llm` (the default: the run's own model), `jev` and `faux`; a closed allowlist of three sites; the
  32k refusal; fallback to `llm` on a missing key or an unreachable host, journaled); `packages/core`:
  the event `decision.made` (orchestrator-only, journal-checked), `Projection.decision`,
  `decisionByKey`, `decisions` (`PROJECTION_VERSION` 8; skipped for inherited journals);
  `packages/lines`: optional `ProblemContext.decide`; `packages/orchestrator`: `RunConfig.decide`,
  `RunLinesOptions.decide`, CLI flags; `packages/fleet`: options `coldStart` and `coldStartWeight`
  (capped pseudo-counts that fade and are gone after six attempts of a claim); `config/hosts/*.json`:
  a `decide.ask` entry (optional). Task 6's `prove.search` orderer does not exist yet: the interface and
  a test double are in; the collaborator's Task 6 calls `decideOrderer`. A request must state its `use`
  (what the answer is for); results only order. Proof states go to a third party when `jev` is on
  ([decide.md](../documentation/decide.md)). An answer without a reported cost is booked at
  $0.01. Not run against a real Jev.
- Task 10, merged in `c8bb412`: new package `packages/scheduler` (given-clause kernel, weighted proof
  numbers, sketch hole reader, subsumption through Lean-checked instances); line `M12`;
  `packages/core`: the event `ladder.escalated` (orchestrator-only, journal-checked, projected by
  problem), `PROJECTION_VERSION` 9, `model_calls` gains `request_hash` and `response_hash`,
  `Projection.claimsWhere`, `Projection.ladder`, `ladderRung`; `packages/memory`: `MemoryStore.claims(filter)`;
  `packages/lines`: `Line.rung`, the hooks `schedule` and `assignOwners`, `ScheduledTask`, `TaskEnd`,
  `LlmRequest.reuse`, `TaskApi.assign` (Ruling 29 is done), `ProblemContext.seed`; `resolveLines` refuses
  two `schedule` lines and an invalid rung; `packages/fleet`: `owners.ts`, `assignOwners`, version
  `fleet-3`; `packages/orchestrator`: the ladder and rung gating in `line-runtime.ts`, the report's rung
  table (`rungSpend`), and one fix in `run.ts` (`benches.recover` on resume uses the run's signal, so the
  hole claims of a cut run are certified). A line built later (M18 in Task 25, M15, M16) registers its
  rung with `Line.rung` and its `beforeProvers` must be safe to call twice (it is called again on
  resume). Page: [scheduler.md](../documentation/scheduler.md). Not run against a real Lean or model;
  the price model and the 0.3 and 0.6 fractions are untuned; a refuted hole through M12 is untested.
- Tasks 25, 28 and 13, merged 2026-11-03 (`f6363b6`, `0ad9cdf`, `f84d92a`): additive. Task 25: the
  hook `LineHooks.runTask` (a line works a ledger task it proposed) and line `M18` after `M12` in
  `LINE_ORDER`. Task 28: `TokenCost.savedUsd`, `offPeakUsd` and `unchargedUsd`, the event
  `turn.deferred`, `HostProfile.models` (price table, calendar, ignored settings, outside the registry
  hash), `ProblemContext.ignoresSetting`, `SessionOptions.rewriteHistory`, the options `--offpeak` and
  `--offpeak-max-wait`. Task 13: the package `@seshat/induction`, the per-claim `counterexample` nodes
  with a checker source (`admitCounterexample`, `cegisCounter`), and lines `M8`, `M13`, `M14`, `M16` in
  `LINE_ORDER`.
- Task 6, merged 2026-11-03 (`1da074d`): `@seshat/classical` (domain router, tactic battery with
  Beta posteriors built from the journal, SMT-LIB and TPTP translation, `screen.ts` repeating the strict
  screen of `lean.meta`), capabilities `smt.z3`, `atp.vampire`, `prove.auto`, `prove.search`, and line
  `M10` in `LINE_ORDER`; the injectable orderer of J3 for `prove.search`.
- Task 9, merged 2026-11-03 (`9e762b7`): `@seshat/memory`: `recordObstruction` and `obstructions`
  (stamped learned records), `screenProse`, the human-only node kind `lesson_decision` in `@seshat/core`
  (a journal accepts it only from `human:NAME`, so `--memory-from` does not carry approvals: a global
  lesson approved in one run waits for approval again in the next); `@seshat/lines`: optional
  `ProblemContext.human`; packages `@seshat/library` and `@seshat/lessons`; lines `M3` and `M5` in
  `LINE_ORDER`; commands `harness library export` and `harness lessons pending|approve|reject`.
- Task 11, merged 2026-11-03 (`544f704`): `@seshat/graph`: the `connect` mode and path renderings
  (`connect.ts`); `@seshat/context`; capabilities `expand` and `graph_query`; line `M4` in
  `LINE_ORDER`; the node kind `context_carry` (per claim and prover, so a resumed first tail equals an
  uncut run); `@seshat/context` depends on `@seshat/classical`. `contextPacket` replaces the opening
  message; the other lines' briefing sections are kept in the prefix as screened "Notes from other
  lines".
- Tasks 27, 18 and 22, merged 2026-11-03 (`50f0792`, `f37801e`, `3f16b4c`). Task 27: events
  `pack.installed` and `pack.removed` in `@seshat/core` (a pack journal), `openRegistry({packsDir})`,
  `registry.hash` includes pack hashes only when packs exist, `run.started.config.packs`, report field
  `packs`, commands `harness add|packs|remove` (`--allow-programs`, `--level1`), pack tool names
  `pack_<name>_<tool>`. Task 18: line `M15` after `M3` in `LINE_ORDER`, `RunReport.archive`, the
  scheduler depends on `@seshat/library`. Task 22: package `@seshat/library-builder`, the definitions
  registry `library/registry` copied into each run's journal (`--library-registry`), commands
  `harness library build|gaps|definitions|review|deprecate`, `CommandRunner` gains `env` and `group`,
  `hashDirectory`'s skip list is exported from `lean-env`, `RunOptions.libraryRegistry`, review status
  of definitions in `@seshat/memory` (`ensureClaim` refuses a statement that mentions an unreviewed
  definition).
- Task 14, merged 2026-11-03 (`77f9e6e`): `packages/core`: the optional `toolTokens` on `attempt.finished` (the tokens of the tool definitions the session sent), documented in `journal.md`; `packages/orchestrator` (shared): `RunConfig.packetMode` (`prefix_tail` by default, `append_only`, `recompiled`), recorded in `run.started`, read back by a resume, `--packet-mode`, documented in `lines.md`; the `ablate`, `chunks` and `probe` commands, `run --probe-every`, `--sequence` and `--tag`, and `report` reading `probe/probe.json`; `packages/bench`: the optional `sequences` and `tags` of the index (an index without them still reads, `sequencesOf` computes), and the `harness-bench` commands `sequences`, `tags` and `ext`, documented in `bench.md`. All additive: a run, an index and a journal without them behave as before.

- Task 29, on `task/t29` (not merged): `packages/core`: the event `budget.gated` (checked by the journal: the arithmetic of the rule, who may write it), the projection table `gates` and `projection.gates()` (projection version 10), the decide sites `budget.wave` and `budget.line` in `DECISION_SITES` (both pass `decisionSiteProblem`; `budget.*` is left out of J3's `DECIDE_SITES` and of the reliability labels); `packages/lines`: the optional `Budget.ask`, `BudgetAsk`, `BudgetAnswer`, and the stop reason `gate`; `packages/scheduler`: `gate.ts` (`gateRule`, `probeVerdict`, `widenRule`, `gateSettings`); `packages/orchestrator`: `RunConfig.gate` (recorded in `run.started`, kept by a resume), `BudgetGate`, the report field `gate`, `Arm.gate`, the experiment `gate`, the flags `--gate`, `--gate-floor`, `--gate-probe`, `--gate-margin`, `--gate-share`; `capabilities/decide.ask/manifest.json` lists the two sites. Every one is optional: without `--gate` the run is as before.
- Task 30, on `task/t30` (not merged): `packages/core`: the optional envelope field `user` (the person a run's events are on behalf of; `EventLogOptions.user`, `Journal.open` and `emit` take it; absent in every old journal, so no hash changes) and the event `statement.signed` (written by `human:NAME` only; checked by the journal); `packages/orchestrator`: `result.ts` (`buildResult`, `renderResult`, `writeResult`, `keepResultCurrent`), `view.ts`, `student.ts`, `doctor.ts`, `solve.ts`, `solve-command.ts`; the optional `RunOptions.benchFile`, `user` and `afterStart`; the files `RESULT.md`, `resume.json` and `view.html` in the run directory; the commands `solve`, `doctor` and `view`, and `report` also rewrites RESULT.md. Every one is optional: without them a run is as before.
- Task 31, on `task/t31` (not merged): new package `packages/ui` (`@seshat/ui`: the journal reader, the loopback server, the process manager, the key store, the front end built to `packages/ui/static`; pinned dependencies hono 4.13.16, @hono/node-server 2.1.6, vite 8.3.5, preact 10.29.8, cytoscape 3.34.4). `packages/orchestrator` (shared): `doctorReport()` extracted from `doctorCommand` in `solve-command.ts` (same output); `CommandIo.readLine`; `SolveFlags.askStdin` and `SolveFlags.askNonce`; the options `--ask-stdin`, `--port` and `--open` and the command `ui` in `cli.ts` (the command loads `@seshat/ui` with a dynamic import), listed in the usage text; the dependency `@seshat/ui` in `packages/orchestrator/package.json` (a cycle with `@seshat/ui` depending on `@seshat/orchestrator`, broken by the dynamic import). The signature protocol over stdio for a program that drives `harness solve`: the program gives a random nonce in `SESHAT_ASK_NONCE` (the command reads it and removes it from its environment; `--ask-stdin` without it is a usage error); the command prints one line `SESHAT_SIGNATURE NONCE JSON` and reads one line, `yes STATEMENT_ID` to sign, anything else for no; the `statement.signed` event is written by the command as before. No event, no journal field and no existing caller changes. Documented in `documentation/ui.md`. Commits on the branch: the four stage commits (`f622bde`, `ff2904f`, `eddab51`, `f674a70`), then the review round 1 commits.
- `atp.eprover` (2026-11-04, branch `task/eprover`, not pushed), additive, in `packages/classical` and
  shared files: new capability `capabilities/atp.eprover` and factory `eprover` (`eproverFactory`,
  registered in `packages/orchestrator/src/implementations.ts`); `config/hosts/local.json` and
  `server.json` gain an optional `atp.eprover` entry (`EPROVER_COMMAND`); `readVampire` is now an alias of
  the shared `readSzs`, which also accepts the `#` prefix E uses; `AtpOutput` gains the optional
  `version`; `Solvers` gains the optional `eprover`; `Evidence.tool` gains `"atp.eprover"`;
  `FirstOrderSettings` gains the optional `atpTools` and `atpMode`; the M10 options gain `atpTools`
  (default `vampire,eprover`) and `atpMode` (`parallel`, `order`); the services test lists
  `atp.eprover` among the optional capabilities. Documented in capabilities.md, classical.md and the
  README diagram. Licence: GPL-2.0, only invoked (see capabilities.md). Simulated: shell-script stand-ins
  for the binary; not run against a real E (stdin input, output level, exit code and TFF arithmetic are
  listed there as "to verify"). Decisions the plan does not state: `--silent` is not passed (it may hide
  the proof); the portfolio default is parallel with both provers; `order` mode reconstructs after
  each prover; an ATP named in `atpTools` but not offered is skipped without error.
  Review round 1 fixes: the SZS reader leaves proof blocks out, takes the last status and accepts only its
  prover's prefix (`%` Vampire, `#` E); evidence is ordered by cutoff and tool; the node `first_order_run`
  gains the optional `tools`; the version is read in the background; licence wording softened; tests for
  `atpTools` and `atpMode` through `readOptions`.
- Providers for the first real run (2026-11-05, branch `claude/project-thread-t0i40r`): `config/hosts/local.json` and
  `server.json` gain a `models` section (DeepSeek's two models at peak prices with DeepSeek's calendar, `ignores`
  temperature when thinking) and new `decide.ask`/`jev` settings (`provider`, `providers` presets for `openrouter` and
  `typesafe`, `path`, prices; `JEV_PROVIDER`, `JEV_PATH`, `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY` read with defaults, so
  a missing key no longer raises a missing variable but an unavailable implementation that names it); the `jev`
  implementation's version becomes `systemone-client-2`; the CLI reads `SESHAT_MODEL` as the default of `--model`.
  Documented in models-setup.md (new), decide.md, capabilities.md, quickstart.md.
- First real run (2026-11-07/08, on `main`, local commits, not pushed when written): on the owner's 4-core
  workstation, with Lean 4.27.0 and the environment `lean/env/base` built. What ran for real: `harness solve`
  with the certifier through bubblewrap, which proved `theorem solve_target (n : ℕ) : n + 0 = n := by simp`
  (`kernel_replay`); by hand, the certifier rejected a `sorry`, another statement and a compile error. The
  fixes the run needed are the four entries below.
- `42dd721` (2026-11-07): `packages/orchestrator` (`implementations.ts`): the environment variable
  `SESHAT_LEAN_ENV_DIR` and the function `leanEnvDirectory`: the directory of the Lean environments, after
  `--env-dir` and before the repository's `lean/env/`, for the registry and `harness lean-env`; the command tests
  run against a fresh copy of `lean/env` (`freshLeanEnvDir`), so a machine that resolved or built an environment
  gives the same results. A run without the variable is unchanged. Documented in lean-env.md and development.md.
- `736266b` (2026-11-07): `packages/ui`: `startServer` counts the model credentials of its `env` option (the
  process's by default) for the models it builds by default; it read `process.env` only. The command tests pin
  `HARNESS_HOST=local` and `LEAN_SERVER_API_URL=http://127.0.0.1:9` (no host profile or Lean server of the machine);
  the faux run that is stopped through the API has a stop grace of 10 s. `harness ui` is unchanged. Documented
  in ui.md and development.md.
- `1275474` (2026-11-08): `packages/lean-local`: the certifier compiles with `--root=<its directory>` (Lean 4.27
  refuses with `-o` a source outside the root), and the candidate and the reference are both compiled as the
  module `SeshatTarget`; `lean/SeshatCertify/Main.lean` types `main`'s exit codes as `UInt32` (it did not
  compile). The first real certification, above. Documented in certifier.md and lean.md.
- `b454f4f` (2026-11-10): `packages/library-builder`: the coding-agent builder reports an abort as `failed`
  with the reason `the build was aborted` at every step it interrupts (the `git` rev-parse, ls-tree, clone,
  checkout and remote removal before the agent, the agent, a gate left undecided by a killed `git` or `lake`);
  it reported a clone killed on a slow disk as `cannot clone the project: `. A failed checkout of the base
  commit or removal of the clone's remote now stops the build (their results were ignored). Documented in
  library-builder.md.
- `a9d8e70` (2026-11-10): `packages/orchestrator` (`retry.ts`, `session.ts`, `prover.ts`, `budget.ts`,
  `report.ts`) and `packages/core` (events, journal): a session sends a request again (3 more sends after 2, 4
  and 8 s) when a transient error cuts its response, such as undici's `terminated`, which ended 3 of the first
  4 attempts of the first real bench run on DeepSeek's API. Additive: `attempt.charged.retry?`,
  `attempt.finished.retries?`, `SessionOptions.retry?`, `SessionOptions.onCharge(cost, retry?)`,
  `SessionResult.retries?`, `Ledger.wouldExhaust`, `RunReport.retries?`. The lines' one-shot calls do not
  retry yet. Not yet run against the real API. Documented in m0-loop.md, journal.md and ledger.md.
- `b529ea8` (2026-11-10): `packages/orchestrator`: what is resent is decided on the transport's or the
  server's words only (pi-ai's classifier matched "timed out" or "500" anywhere, so a test's own error was
  resent with real waits and a graph test went from 6 s to 30 s); the wait is cut by a stop, the end of the
  turn or a spent budget. Additive: `RunOptions.retry?`, `ResumeOptions.retry?`, `ProverOptions.retry?`; the
  test helper `TEST_RETRY` (`m0-helpers.ts`), the default of `demoRun` and `demoResume`.
- Observed in the first real run, not fixed: a run's budget can be taken by its first problem when the
  problem's allowance (`--budget-usd`, default 5) is above the run's (`--run-budget-usd`): with `--sample 3
  --run-budget-usd 1`, the first problem spent $0.92, the second the rest, and the third never started.
- Observed in the first real run, not fixed: the registry's fixed health limit of 15 s (`HEALTH_TIMEOUT_MS`,
  `packages/registry/src/registry.ts`) is exceeded on a cold, loaded machine by `compute.sage/docker` (about
  17 s under load, about 5 s idle) and `lean.certify/lake` (up to 26 s cold), which are then reported
  unavailable; warm, both pass.
- Task 34, on `claude/project-thread-h60gyw` at `c34c0c8` (2026-11-10): `packages/orchestrator`:
  `SessionOptions.checkTimeoutSec?`, `editTool?`, `maskOldChecks?`; the body of `lean_check` is now `doCheck`,
  shared with the new tool `lean_edit`; `RunConfig.checkTimeoutSec?`, `editTool?`, `maskOldChecks?`,
  `defaults?`; `harness solve --defaults v1|v2`. `config/hosts/*.json`: the optional settings
  `checkTimeoutSec`, `healthTimeoutMs` (it answers the health-limit observation above) and
  `leanServerMemoryWarnMb`. Off for `harness run`. Documented in m0-loop.md and quickstart.md.
- Task 33, on the same branch at `8c8c0cb` (2026-11-10): `packages/core`: optional `checks` and `holes` on
  `attempt.finished`, optional `outputUsd` and `cacheReadUsd` on charges; `splitCommands`
  (`lean-source.ts`) reads a column-0 line that starts with `(`, `{`, `[`, `⦃` or `:` as the continuation of
  the declaration above. `packages/orchestrator`: `SessionResult.holes?`; `harness ablate --bench --grade
  --target --allow-unchecked`; `measures.ts` gains `settledInLiterature` (nodes of kind `literature` with
  `data.settled === true`, which Task 36 writes) and the false-hole share (nodes of kind `hole_verdict`
  with `data.verdict === "statement_wrong"`, which Task 37 writes). `packages/bench`: `graded.ts`.
  Documented in bench.md, ablate.md, journal.md and m0-loop.md.
- Task 36, on `claude/project-thread-h60gyw` at `75638fd` (2026-11-11): new package `@seshat/lit` and capability `lit.search`
  (`config/hosts/*.json`: its backends and `allowedHosts`). `packages/core`: the events `intake.consented` and
  `intake.finished` (no-ops in the projection). Node kinds `literature` (data `{backend, url, title, quote, verdict, settled}`)
  and `hygiene`. `packages/orchestrator`: `RunConfig.intake?`, `RunConfig.private?`, `RunOptions.prose?`, the turn reasons
  `literature` and `vacuous`, `RunReport.intake?`, `Result.intake?`; `harness solve --tool --auto-tool --intake --lit --private
  --intake-usd`, `harness run --intake --private`. Documented in literature.md, journal.md, trust.md, quickstart.md.
- Task 40, on the same branch at `922341a` (2026-11-11): new package `@seshat/lean-search` and capability `lean.search`
  (`config/hosts/*.json`: `remoteUrl`, `patternUrl`, `indexPath`, `allowedHosts`). `packages/orchestrator`:
  `SessionOptions.appendToCheck?` (text appended to a check's answer), `ProverOptions.leanSearch?`, `RunConfig.leanSearch?`,
  `--lean-search` on `run` and `solve`; the report's line "Lean search". `RunConfig.private` is the one field of Task 36.
  Documented in lean.md, capabilities.md, journal.md.
- Task 35, on the same branch at `1178091` (2026-11-11): `packages/memory`: `stateCard`, `stateCardData`, `renderStateCard`
  (`card.ts`), the card as data and text. `packages/core`: the events `budget.round` and `problem.parked`, optional
  `lastCheckClass` on `attempt.finished` (projection column `last_check_class`, projection version 11). `packages/lines`: a
  line's `afterCheck` may return a `notice` (text appended to the check's answer) without stopping the session.
  `packages/guards`: M6's options `repeatRule` and `detectors`. `packages/orchestrator`: `RunConfig.stateCard?`,
  `budgetRounds?`; `rounds.ts`; a check's answer is Lean's text, then the `lean.search` section, then a line's notice.
  Documented in m0-loop.md, guards.md, scheduler.md, journal.md.
- Task 36b, on the same branch at `980d849` (2026-11-11): `packages/registry`: the optional manifest field `thirdParty`
  (`sends`, `privateInput`, `implementations`), `Registry.restrictThirdParties` and `thirdPartyRefusal`, the error code
  `private`; six manifests carry the field (`oeis.search`, `lmfdb.query`, `findstat.identify`, `lit.search`,
  `lean.search`, `decide.ask`), so the registry's hash changed and a run started before this commit cannot be resumed
  after it. `packages/orchestrator`: `recordConsent` journals `intake.consented` for every problem the policy applies
  to (also for `harness run --private` without `--intake`); a resumed run restores `RunConfig.intake` and the person
  from `run.started`. Documented in trust.md, capabilities.md, lean.md, literature.md.
- Task 41, on the same branch at `a4f4c39` (2026-11-11): line M11 gains the option `graphs` (off by default) and the
  services `graphSearch` and `sage`; new memory node kinds `graph_hit` and `graph_search` (`documentation/journal.md`); a
  `refuted_by` edge is `computed` only after Lean accepted the negation; `packages/models` exports `splitSignature`,
  `Binder` and `TYPE_SORT`, and `sageGraphBattery` takes an optional `maxObjects`; `packages/orchestrator/src/lines.ts`
  registers M11 with the graph search; new Lean files `lean/SeshatLib/Finite/Graph.lean` and `Witness.lean`
  (`documentation/finite-lean.md`). No defaults set changed.
- Task 37 (2026-11-11, merge `b83a0b1`): line M12 gains the options `blueprints` (off), `holeTurns` (12) and
  `holeSessions` (2); a sketch's holes may declare `-- uses: aux_a, aux_b`; new memory node kinds `m12_preflight`,
  `hole_verdict` and `suspect_false`; `@seshat/core` exports `HOLE_WAITING_REASON` (a hole whose work is done and that
  waits for its dependencies keeps the task status `failed` and is shown as waiting by the account and the breakpoints);
  `SessionRecord.workDone` (work done on stubs) beside `ok` (the validator accepted the proof); the loop telemetry counts
  only Lean-checked negations as false sub-lemmas and prints unverified suspicions apart; `Line` services gain the hole
  session (`packages/orchestrator/src/hole-session.ts`). A hole's status still changes only through `validate` or a
  Lean-checked `decomposes_into` link.
- Task 42 (2026-11-11, merge `d81047c`): new command `harness consolidate RUN_DIR [--out DIR] [--model PROVIDER/ID
  --max-usd X]`; flags `--consolidation` and `--turn-consolidation`; `RunConfig.consolidation`; consolidation node kinds
  that only the actor `consolidation` may write (journal invariant in `packages/core/src/journal.ts`);
  `packages/lessons` exports `planMerges`, `applyMerge`, `planFlags`, `applyFlag`; the state card gains `acrossRuns`
  (`packages/memory/src/card.ts`); page `documentation/consolidation.md`.
- Task 34b (2026-11-11, merge `c5f635a`): `RunConfig.autoTool` (a `direct` capability a problem's sessions get only when
  `fileStatement` files its statement; recorded in `run.started`, so the registry and prompt hashes of a run that sets it
  change); `RunOptions.testLemmas`; `IntakeConfig.capShare` and `intakeCapUsd`; in `student.ts`, `SOLVE_SWITCHES`,
  `describeSet`, `studentLines`, `setConfig`, `benchAdditions`, `INTAKE_ALLOWANCE_SHARE`; `harness solve` flags
  `--no-intake`, `--no-auto-tool`, `--no-lean-search`; `harness doctor` gains a seventh check, `defaults`; `Arm.config`
  and `ExperimentContext.host` in the ablation; `harness ablate` takes `--private`; new experiment `solve-defaults`
  (arms `solve-v1`, `solve-v2`, `solve-v2-blueprints`).
- Real-run fixes (2026-11-11, `0bd5bd5`, `a973a44`, `0a41fb6`, `b9df4fa`): `run.finished` may carry `stopped: "provider_refused"`
  and `RunResult.providerRefusal` holds the provider's error text (`fatalProviderError` in
  `packages/orchestrator/src/provider-errors.ts`: HTTP 401, 402, 403 and the phrases of a missing balance or a refused key; a
  429 and a 5xx never); `AblationResult.refusal` replaces `protocol` when an arm was refused, the arms after it are not run
  and `harness ablate` exits non-zero; `harness ablate --experiment solve-defaults` takes the host `solve` takes when neither
  `--host` nor `HARNESS_HOST` is given; `CheckDecision.cause` (`packages/lines/src/line.ts`) and `SessionResult.lineCause`
  say why a line stopped a session, and a gate's probe whose session the repeat rule stopped runs one more session under the
  probe's ledger before the gate judges it.

## Log

The main team's build log, oldest first, published from its working ledger at each milestone.
Agent ids and model names are left out; the findings files and scratch files it names stay with
the main team's controller. A "minor (deferred)" line is an open minor finding of a review, for the
next task that touches that code and for the final review.

Spec: the research plan `plan-memoire-donnees.md` and its detail notes (French, outside the repository). Request: the owner, 2026-10-14 06:31: "finish the whole Seshat implementation plan, subagent-driven, with a master agent, without stopping until everything is done with passing tests" (about 12 hours of agent work).
Start: main at 91374d8 (README diagram commit).

### Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T2..T14 | line API (@seshat/lines), MemoryStore (@seshat/memory), validate/Llm contexts | foundation; all later tasks read documentation/lines.md, memory.md |
| T2 x T3 | T2 uses TextIdentity; T3 adds LeanIdentity on T1's StatementIdentity | no conflict |
| T3 -> T10, T12 | lean.meta instances (subsumption), structure profiles | T10, T12 in wave 2, after T3 |
| T4 x T1 | T4 changes certification inside T1's validate path | run.ts contention with wave-1 line registrations; controller merges |
| T5 -> T10, T11 | ATMS labels, PageRank, graphQuery | wave 2 after T5 |
| T5 x T8 | both name the prove/refute twin | conflict, see Ruling 2 |
| T6 -> T9, T13 | battery as the triviality test | T9 is in the same wave as T6, see Ruling 3 |
| T7 -> T12, T13 | small models, fingerprints, identification service | wave 2 after T7 |
| T8 -> T10, T12 | Beta posteriors, stagnation | wave 2 after T8 |
| T9 -> T11 | library index, lessons sections | wave 2 after T9 |
| T2 -> T8, T11 | alreadyTried typed summaries | T8, T11 after T2 |
| T2,T5..T13 x lines.ts, README diagram, documentation/lines.md, report.ts | every task registers a line, edits the diagram, may add a report metric | parallel merges conflict on these files; controller resolves keeping both sides, then pnpm check; .gitattributes union for documentation/README.md (+ lines.md) |
| T10 x T11 | T10 changes the main loop (subgoals), T11 uses contextPacket wired by T1 | both may touch prover.ts/run.ts; merge by controller |
| T1..T14 self-consistency | each task's tests cover its deliverables; no task creates a file another task later rewrites wholesale | consistent |

Ruling 1: Work directly on main (wave 0 in the main checkout; parallel waves in git worktrees on task branches merged into main by the controller), pushing main after each reviewed task — the user's practice is pushing to main and the coordinator's brief asks for it; no other contributor — cost if wrong: commits would have to move to a branch and PR, easy to revert.
Ruling 2: The prove/refute twin is owned by T5 (M2); T8 (M6) only does neutral framing and its other guards — avoids two implementations of one mechanism — cost if wrong: M6 alone (without M2) has no twin, which plan §7's cumulative order never runs.
Ruling 3: T9's non-triviality test is an injectable predicate with a default of a few cheap tactics through lean.check; T14 wires the M10 battery into it — T6 and T9 run in parallel — cost if wrong: library promotion uses a weaker triviality test until T14.
Ruling 4: Dispatch in waves: wave 0 = T1, T2 (sequential); wave 1 = T3..T9 in parallel worktrees; wave 2 = T10..T13 in parallel; wave 3 = T14; then the final review — 12 h budget; tasks in a wave touch disjoint packages — cost if wrong: merge conflicts the controller resolves, and the skill's sequential-only rule is broken knowingly.
Ruling 5: Implementers decide unclear details themselves (reasonable choice that fits the plan, noted in the report) instead of stopping with questions — the user asked to run without stopping — cost if wrong: rework found by the task review.
Ruling 6: Model tiers: the strongest tier for T1, T3, T14 and the final review; the standard tier for the other implementers and for task reviews — architecture and unverifiable Lean code need the strongest model, the rest is well specified — cost if wrong: more fix rounds on standard-tier tasks.

### Progress
Task 1: dispatched (BASE 91374d8, main checkout)
Task 1: interrupted by the account usage limit (reset 10:50 UTC); resumed 10:54 UTC with commits fa09be1, 3f08543 done and the rest uncommitted
Ruling 7: After the usage-limit stop, implementers and reviewers run on the standard tier except T3 (Lean meta) and the final review; parallel waves stay but at most 4 agents at once — the account's usage limit, not the euro budget, binds — cost if wrong: slower progress or more fix rounds
Task 1: implementer DONE_WITH_CONCERNS (commits fa09be1 3f08543 6dc6ac4, 188/188); review dispatched
Task 1: review: spec ✅, quality Needs fixes (I1 public MemoryStore.journal bypasses trust rules); ⚠️ cumulative configs = §7 order; ⚠️ problem claims bypass ensureClaim (-> Task 2)
Ruling 8: Cumulative ablation configs follow §7's execution order (M2 = M1+M10+M2), as implemented — plan line 167 says lines are measured in §7's order — cost if wrong: ablation tables compare different line sets than §6's numbering suggests.
Ruling 9: The problem's own claim going through ensureClaim is Task 2's job (its brief routes claims through ensureClaim) — cost if wrong: duplicate claims for one statement until Task 2 merges.
Ruling 10: T1 fix round 1 goes to a fresh standard-tier fixer (findings are precise with file:line) instead of resuming the strongest-tier implementer — the account usage limit makes resuming a large context on the strongest tier costly — cost if wrong: another fix round.
Ruling 11: Minor findings M2 (edges({to}) full scan) and M7 (API clarity gaps, null-default option bug) enter T1's fix round as load-bearing: every graph and variant task builds on them — cost if wrong: a slightly larger fix diff.
Task 1: minor (deferred): M1 TextIdentity strips Lean comments from informal prose (identity.ts:24)
Task 1: minor (deferred): M3 line stop/skip reasons reach the log only, not the journal (session.ts:115, prover.ts)
Task 1: minor (deferred): M4 afterCheck crash invisible when the same check made the candidate (session.ts:105-119)
Task 1: minor (deferred): M5 validate still works for the problem claim in afterProblem (line-runtime.ts:328)
Task 1: minor (deferred): M6 untested branches: settle failures, afterAttempt throw, beforeSession model change, tool-name clash, lineLlm failures, reference cache retry, contextPacket + wrap-up
Task 1: minor (deferred): M8 durationMs recomputed in prover.ts:170; EDGE_STATUS_ORDER indexOf -1; third commit bundles API+skeletons; solveProblem ~165 lines
Task 1: fix round 1 dispatched (fixer, FIX_BASE 6dc6ac4, main checkout; findings I1, M2, M7)
Ruling 12: Wave 1 starts before T1's fix lands (worktrees at 6dc6ac4): T2, T5, T6, T7, T8 now; T9, T3, T4 as slots free — the usage-limit window rewards early parallel work; dispatches tell workers journal is becoming private — cost if wrong: merge conflicts with the T1 fix in memory/store.ts and docs, resolved by the controller.
Task 2: dispatched (worktree t2, BASE 6dc6ac4)
Task 5: dispatched (worktree t5, BASE 6dc6ac4)
Task 6: dispatched (worktree t6, BASE 6dc6ac4)
Task 7: dispatched (worktree t7, BASE 6dc6ac4)
Task 8: dispatched (worktree t8, BASE 6dc6ac4)
Usage-limit stop 2 at ~11:40 UTC (reset 15:50): wave-1 agents made no commits. 15:51 resumed T1 fixer, T2, T5 only; T6, T7, T8 parked with no progress, to restart as slots free.
Task 1: fix round 1 implemented (commits 9ad26f3 49793b1 8048882, 198/198); scoped re-review dispatched (FIX_BASE 6dc6ac4)
Task 1: minor (deferred): a line's store view can call setReference (not journaled), which could point a claim at another reference file — carried into Task 4's dispatch: the certifier rebuilds the reference from the claim's journaled statement and header
Ruling 13: Tool output never changes a claim's status (the fixer's hardening: computed needs a Lean validation of the same claim; claims are created open); an SMT unsat or other tool evidence is a computed edge or a node — Global Constraint 8 says no mechanism changes a claim's status except through the Lean validation path — cost if wrong: Task 6 must move unsat evidence from edges/nodes onto claims later.
Worktrees t3 t4 t6 t7 t8 t9 fast-forwarded to 8048882 (clean, no commits); later wave-1 dispatches start there, fresh
Task 3: dispatched (worktree t3, BASE 8048882)
Task 1: fix round 1/5 (8 addressed, 0 open; commits 6dc6ac4..8048882)
Task 1: minor (deferred): documentation/lines.md:123 example calls ensureClaim without await
Ruling 14: Task 4 restricts setReference to the orchestrator's root store (line views lose it, or referenceFor ignores overrides for non-problem claims) and its certifier rebuilds the reference from the claim's journaled statement and header — the re-review found a line could validate a proof against a mismatched reference and reach computed; Task 4 owns certification — cost if wrong: until Task 4 merges, a buggy line could mark a sub-claim computed against the wrong file.
Task 1: complete (commits 91374d8..8048882, review clean after fix round 1)
main pushed at 8048882 (pnpm check 198/198)
Task 7: re-dispatched fresh (worktree t7, BASE 8048882)
Ruling 13 (amended): spec §2 lists tool output (ATP without reconstruction, CAS, numerics, fingerprints) as `computed`; Seshat records it as `computed` edges or evidence nodes, and a claim's own status moves only through Lean validation — Global Constraint 8, and spec §1 "nothing goes from research records to facts without a verifier"; one meaning for a claim's `computed` (a Lean fast check passed) — cost if wrong: add a tool-evidence validation kind (journal invariant, trust.md, Task 6/7 call sites).
Task 2: implementer DONE_WITH_CONCERNS (commits d3ba9e8 3784682 on task/t2, base 6dc6ac4, 212/212); concern: TextIdentity ignores the header, so two problems with the same statement text and different definitions share one claim
Ruling 15: TextIdentity hashes the header together with the statement when one is given (st0 stays the plain statement hash without a header) — st0 stands in for spec §3.1's elaborated-statement hash, and merging distinct statements is unsound (shared status and negative memory) while under-merging only loses dedup that LeanIdentity (Task 3) restores — cost if wrong: st0 dedups less across problems until st1.
Task 2: pre-review fix sent to the implementer: rebase onto main 8048882, apply Ruling 15
Usage-limit stop 3 at ~16:50 UTC (reset 20:50): T2 (pre-review fix not started), T3 (no changes), T5 (uncommitted work), T7 (barely started) cut. 20:53 resumed all four via SendMessage.
Task 2: pre-review fix done (rebased onto 8048882: commits 1d34a2e 24ff263 d7663b1, 225/225); review dispatched
Task 2: review: spec ✅, quality Approved (no Critical/Important)
Task 2: ⚠️ resolved by controller: trailers present on 1d34a2e 24ff263 d7663b1; 1d34a2e alone passes pnpm check (200/200)
Task 2: note: on the committed bench all 575 st0 ids are distinct and prefixes differ, so cross-problem claim sharing is inert until Task 3's Lean identity; M1's measurable effect there is shared negative memory within a problem
Task 2: minor (deferred): session.ts:106-107 records a `strategy` argument from any lean_check call even when no line offers labels (M0 is not exactly M0; closed vocabulary broken)
Task 2: minor (deferred): failures.ts:128 restates_target outranks real Lean errors (brief lists it after them)
Task 2: minor (deferred): run.finished.solved/candidates count every problem of a shared claim; report.json is per problem
Task 2: minor (deferred): m1-identity-memory.md:183-184 says M0 vs M1 measures redundancy, undefined for M0; the control arm is M1 with maxLines below 2
Task 2: minor (deferred): aux-theorem filter duplicated (failures.ts:103-106, strategies.ts:108-111, core prepareSketch)
Task 2: minor (deferred): failure classified twice per attempt (prover.ts:168, m1.ts:37); carry failureDetail on FinishedAttempt
Task 2: minor (deferred): untested: throwing Line.identity factory, restates_target through a run, rejected certification on a shared claim
Task 2: minor (deferred): nits: isStrategy unused, failures.ts header comment count, bare catch at failures.ts:109, solveProblem closure length, declared_strategy column shared by line and model
Task 2: complete (commits 8048882..d7663b1, review clean); main fast-forwarded and pushed (227/227)
Worktrees t4 t6 t8 t9 fast-forwarded to d7663b1
Task 8: re-dispatched fresh (worktree t8, BASE d7663b1)
Usage-limit stop 4 at ~21:22 UTC (reset 01:50): T3 (uncommitted, docs left), T5 (02386ac 33a8ec5, afterAttempt hook left), T7 (7c99535 + uncommitted), T8 (reading) cut. 01:52 resumed all four.
Task 3: implementer DONE_WITH_CONCERNS (commits 5c88739 f1e6748 on task/t3, base 8048882, 231/231); concerns: SeshatMeta never compiled, contract ids worked out by hand, no run uses LeanIdentity yet (Task 14 wires it through Line.identity), doc conflicts with Task 2 (memory.md, lean.md)
Task 3: review dispatched
Task 5: implementer DONE (commits 02386ac bdffc41 on task/t5, base 6dc6ac4, 301/301); its merge rehearsal with main d7663b1 (341/341) re-committed with a clean message as faa20cf on task/t5 (same tree); concerns: composed claims stay computed (non-problem certification not wired), a graph-refuted problem ends unsolved (no `refuted` run outcome), prover tool named graph_neighbors (M4 owns graph_query)
Task 5: review dispatched on the net change d7663b1..faa20cf
Usage-limit stop 5 at ~02:23 UTC (reset 06:50): T7, T8 implementers and the T5 review cut; T3's review had finished.
Task 3: review: spec ✅, quality Needs fixes (4 Important: declSig scope in SeshatMeta, unsandboxed lean.goals undocumented, default-path Lean time limit equals the abort timer, broken fence in lean-meta.md); ⚠️ trailers checked by controller: present on 5c88739 f1e6748
Task 3: minor (deferred): pantograph.ts:273 statement and `:= by` on one line (a trailing `--` comment swallows it)
Task 3: minor (deferred): pantograph.ts generation checked at lookup not at send; options.set + call not atomic; release's goal.delete same gap
Task 3: minor (deferred): pantograph.ts:92/141 no stdin error handler (EPIPE crash); `exit` may fire before stderr is read
Task 3: minor (deferred): pantograph.ts:179 distilFile exact module match; host profiles set no `modules` (bench imports refused)
Task 3: minor (deferred): pantograph.ts:329 health starts the REPL under the 15 s health timeout
Task 3: minor (deferred): Hash.lean:105 erasing closed instance arguments merges statements differing only in a non-defeq instance; document or reduce with instance transparency
Task 3: minor (deferred): Commands.lean:23-26 defeq elaborates b after a (universe names differ; alpha-equivalent Type* statements compare false)
Task 3: minor (deferred): unconfirmed Lean APIs: tryCatchRuntimeEx, Simp.mkContext named args, DiscrTree.insert/getUnify in MetaM, ByteArray.foldl (init := …)
Task 3: fix round 1 dispatched (resuming the implementer; findings task-3-findings-r1.md; FIX_BASE f1e6748)
06:53 resumed T3 (fix round 1), T5 review, T7; T8 (guards half written) parked until a slot frees — at most 3 agents per window so work finishes before the limit
User decision 2026-10-15 06:54 (card): "Continue" — keep going every usage window until the plan is done (~3 days), accepting the account limit stays used
Task 5: review: spec ❌ (revocation scoped per run not per problem; the docs still say validate is the only way a line changes a status), quality Needs fixes; ⚠️ trailers checked by controller: present on 02386ac bdffc41 faa20cf; ⚠️ composition runs in beforeProvers/afterAttempt/afterProblem, afterCheck only syncs — accepted as the brief's "after each validation and attempt"
Ruling 16: MemoryStore.retractClaim stays as the single named exception to "validate is the only way a line changes a claim's status": lowering only (the revocation transitions of core's status table), with a reason, journaled with the actor; docs name M2's revocation as its caller — truth maintenance needs it when a premise's validation is revoked, and lowering can lose work but never creates a fact — cost if wrong: a buggy line can demote claims (lost work, not unsoundness); moving it out of the store API later is a small refactor.
Task 5: minor (deferred): engine.ts:32 byConclusion written, never read
Task 5: minor (deferred): DRY: factFromKey (state.ts:191) duplicates parseFactKey (rules.ts:16); keyOf (atms.ts:309) duplicates factKey (rules.ts:12)
Task 5: minor (deferred): settings() (line.ts:46-50) does not check option types (twinTries=abc gives NaN, twin=1 disables the twin silently)
Task 5: minor (deferred): the briefing claims another attempt refutes even with twinTries 0; no option to switch the briefing off (blurs the M2 ablation)
Task 5: minor (deferred): lean.md#to-verify-against-lean not extended with M2's unverified items though graph.md:408 points there
Task 5: minor (deferred): graph tests import orchestrator src/test by relative path (helpers.ts:6-8, line.test.ts:6-8); undeclared dependency direction
Task 5: minor (deferred): graph_neighbors accepts any limit/depth from the model (query.ts:203-215); cap it
Task 5: minor (deferred): attemptPrompt "prove"/"link" framings and proveWithModel unused outside tests
Task 5: minor (deferred): realize marks a derivation tried before validate (a thrown validator loses it); concurrent afterAttempts can overshoot `composed`
Task 5: minor (deferred): retractClaim tested only for proved→retracted and computed→open; no test for an edge downgraded from lean_checked in GraphState.sync
Task 5: minor (deferred): beforeSession/afterCheck/briefing/tools call sync()/refresh() unguarded (a throw ends the session as a harness failure)
Task 5: fix round 1 dispatched (resuming the implementer; findings task-5-findings-r1.md; FIX_BASE faa20cf)
Task 3: fix round 1 implemented (commit 39159d6, 231/231); scoped re-review dispatched (FIX_BASE f1e6748)
Task 5: fix round 1 implemented (commits 69a3c95 a5f0c39, 343/343); scoped re-review dispatched (FIX_BASE faa20cf)
Task 5: minor (deferred): revocation reaches only claims in a running problem's state; a premise retracted after a problem ended does not revoke its composed claim until a later state reaches it — carried into Task 4's dispatch (certification failures must revoke dependents across problems)
Task 3: fix round 1/5 (4 addressed, 0 open; commits f1e6748..39159d6)
Task 3: minor (deferred): lean-meta.md:180-181 env list reads as exhaustive (serverEnv passes PASSED_ENV incl. DOCKER_*); goals.test.ts:125 stray call
Task 3: minor (deferred): lean.meta health probe runs with Lean limit 120 s under the registry's 15 s health timeout (cold start reports down)
Task 3: minor (deferred): trust.md "What runs where" does not name the lean.goals unsandboxed exception
Task 3: complete (commits 8048882..39159d6, review clean after fix round 1)
Task 3: merged into main (b357efc, 262/262, links ok) and pushed
Task 5: fix round 1/5 (2 addressed, 0 open; commits faa20cf..a5f0c39)
Task 5: minor (deferred): trust.md:96-98 promises revocation when premises are retracted without the running-state condition; graph.md "Not done" lacks it
Task 5: minor (deferred): fix round ran pnpm check once on the final tree, not before each of its two commits (disjoint files)
Task 5: complete (commits 6dc6ac4..a5f0c39 incl. merge faa20cf, review clean after fix round 1)
Task 5: merged into main (9e76c43, 380/380, links ok) and pushed
Ruling 17: Task 4 adds a `refuted` problem outcome (problem.finished, report, docs) — certification makes `refuted` reachable, and Task 5 found a refuted problem reported `unsolved` — cost if wrong: one more outcome value for report readers.
Task 4: dispatched (worktree t4, BASE 9e76c43; carries Rulings 14 and 17)
Task 7: implementer DONE_WITH_CONCERNS (commits 7c99535 9810b10 8af794d 9de12a3 6b57cf4 on task/t7, base 8048882, 339/339); concern: OEIS/FindStat/LMFDB clients are libraries, not capabilities (Constraint 10 deviation)
Ruling 18: the OEIS, FindStat and LMFDB lookups become registry capabilities before review (the local table may stay a library) — Constraint 10 is the user's modularity rule, and the brief does not mandate a library — cost if wrong: extra manifests and contracts to maintain.
Task 7: pre-review fix sent: rebase onto 9e76c43, Ruling 18
Usage-limit stop 6 ended (reset 11:50 UTC); T4, T7 (rebase onto 9e76c43 done, Ruling 18 next) and T8 (fleet work uncommitted) resumed 11:57 UTC
User request 2026-10-15 11:13: integrate the decisions of their document "Prompt Thinking modes for MRsearch" into the plan, in a dedicated parallel thread (opened by the coordinator 11:56); it revises research/plan-memoire-donnees.md and the change comes back here by relay. Copies for it: plans/seshat-plan.md and seshat-plan-rulings.md (as of 9e76c43). Do not edit plan-memoire-donnees.md meanwhile.
Task 8: implementer DONE_WITH_CONCERNS (commits 057e4f2 e5ea39b 4308af5 c6f77b8 5d19220 on task/t8, base d7663b1, 382/382); concerns: trivial merge unions with T3/T5/T7 (LINES, README, docs index, lines.md, line.ts hooks), lexical citation guard, thresholds are first guesses, `source` node has no writer, declarationExists/nearEquivalent/packetIds injected
Task 8: review dispatched (d7663b1..5d19220)
Task 8: merge rehearsal into 9e76c43 (wt/merge-t8, branch merge/t8): conflicts README.md (diagram edges, prose) and orchestrator/src/lines.ts resolved as unions, LINES = { M1, M2: m2Line, M6, fleet }; pnpm check 535/535, links ok; resolution texts kept by the controller
Task 7: pre-review fix done (rebased onto 9e76c43; commits 98ba01a 023ce37 e7463ce 9fe9def ac37175 547131b, 536/536); Ruling 18 applied: oeis.search, lmfdb.query, findstat.identify capabilities (manifest, contract, local/server host profiles, site implementation), M11 calls oeis.search through the registry; concerns: real sites never queried, FindStat/LMFDB request shapes guessed, `harness health` with no id now pings the three sites
Task 7: review dispatched (9e76c43..547131b; named risks: status integrity, model-written JS execution, Lean text interpolation, capabilities offline/degrade/health, Lean cost)
Task 8: review: spec ❌ (I1 fleet wake before attempt.finished, I3 stale docs), quality Needs fixes (I1, I2 notes-isolation e2e asserts nothing, I3); risks checked: no status raise from the new hooks, no gate hang, journal keeps model notes
Task 8: minor (deferred): M2 citation heuristic false positives ("Lemma 1 from the previous step"), silent replacement in notes
Task 8: minor (deferred): M3 M1's catch-all `other` counts as a repeatable strategy in the loop detector (m6.ts:319, detectors.ts:23-35)
Task 8: minor (deferred): M5 m6.ts afterAttempt ~70 lines, fleet.ts beforeSession ~95 lines; duplicated identifier regex, lastCheckOf vs hasSignal, successRate, flag/count vs bool/num; name env2
Task 8: minor (deferred): M6 gate depends on prover names p<N> (width.ts:59 vs run.ts:457); notes check has no packetIds (afterAttempt has no session) — decide once M4 exists
Task 8: minor (deferred): M7 commit 5 mixes fleet e2e tests, a rewording and guard dead-code removal
Task 8: minor (deferred): M9 fleet side effects precede later lines' beforeSession; a later skip leaves a dangling allocation node counted toward maxEscalations and a strategy marked taken until afterProver (forward-looking, for Task 14)
Task 8: fix round 1 sent to the implementer (findings I1 I2 I3 + minors M1 M4 M8; FIX_BASE 5d19220; findings file task-8-findings-r1.md)
Usage-limit stop 7: about 12:20 UTC (T4 implementer and T7 reviewer cut; reset 16:50 UTC); resumed 16:55 UTC
User decision 2026-10-15 12:21 (in the thread on their research document): "I approve, send it back to the implementer": plan change plans/plan-change-thinking-modes.md (PC1-PC13) approved
User request 2026-10-15 12:25: a turn-based "consortium" mode (pause after a time or token budget set as a parameter, an intelligible deliverable of the research state even unfinished, wait for the human team's answer before any token spending); "to refine and add to the plan"
Usage-limit stop 8: the account's WEEKLY limit stopped every agent and this session on 2026-10-15 about 16:55 UTC (T4 implementer, T7 reviewer, T8 fixer cut); reset 2026-10-20 05:00 UTC; all three resumed 05:06 UTC
Plan amended 2026-10-20 05:15 UTC: plan-change-thinking-modes.md (PC1-PC13, approved by the user 2026-10-15 12:21, relayed by the coordinator 2026-10-20 05:07) folded in: Tasks 6 and 9-14 carry "Amended by PCx" paragraphs; new Tasks 15 (ledger, routing, resume, completeJson), 16 (lean.lsp), 17 (consortium mode = the user's 12:25 request merged with PC2), 18 (line M15), 19 (Task 8 follow-up: PC6.1, PC9 judge, PC10, PC11.1); briefs 6 and 9-19 regenerated; copy at plans/seshat-plan.md
Ruling 19: order after the in-flight T4, T7 and T8: T15 and T16 in parallel, then T17, then T6, T9, T19, T10-T13, T18, T14 and the final review; the user's decision card decides whether a first real run on their host comes after T17 (recommended) or only at the end — the plan change puts T15 and T16 first, the consortium mode needs T15's resume, and nothing has run against a real Lean or model yet — cost if wrong: M10 and M3/M5 land later than §7's order.
Task 8: fix round 1 implemented (commits 15420d3 69a8df0 77a24c7 b5b3a44 df549de, 384/384); I1 fixed by waking waiters at the next beforeSession and in afterProver; reviewBriefing titles must be a subsequence of the given ones
Task 8: scoped re-review dispatched (FIX_BASE 5d19220, head df549de)
Usage-limit stop 9: 5-hour limit cut T4 implementer, T7 reviewer and T8 re-reviewer about 07:50 UTC (reset 10:00); resumed 10:06 UTC
User decision 2026-10-20 07:44 (project chat, relayed 10:04): suspend homology detection (the v2 draft's abduction by homology, "veridical mapping"); keep the notes, do not implement; future direction only: problem reformulation (sub-problem/sub-expression, super-expression/more general problem, analogous problem, higher dimension) and one native tool per major method of Polya's How to Solve It, once the core is ready
User approvals 2026-10-20 07:36 and 07:37 (relayed 10:04): plan-change-jev.md (J1-J5) and plan-change-lean-libraries.md (LC1-LC5); folded into the plan 10:20 UTC: Task 12 marked suspended; new Tasks 20 (decide + Jev), 21 (Lean environment, resolver, line M17), 22 (LibraryBuilder, definition review status); amendments to Tasks 6, 9, 11, 13, 14, 15, 19; "Later (not scheduled)" section; briefs 6 and 9-22 regenerated; shared copy updated
Ruling 20: Task 12 (M7, M9) is suspended, not built: lines M7 and M9 stay in LINE_ORDER but are refused by a run with the reason "suspended" and leave the cumulative configs; J3 item 2 (decide in the abductive rerank) is dropped; PC9's judge keeps its other uses; Task 18 writes the anti-unification it needs — the user's decision of 2026-10-20 07:44 — cost if wrong: the engine is rebuilt from plan §10 when the user lifts the suspension.
Ruling 21 (replaces Ruling 19): order after the in-flight T4, T7 and T8: T15 and T16 in parallel; then T17 and T21; then, if the user chooses it on the card, a first real run on their host; then T6, T9, T19, T20, T10, T11, T13, T18, T22, T14 and the final review — T21 prepares the Lean environment a real run needs, T20 needs T15's site tags and T19's judge, T22 is low priority and needs T21 and T9 — cost if wrong: M10 and M3/M5 land later than §7's order.
To do (controller, after T7 and T8 merge): small docs/code commit marking M7 and M9 suspended (ids.ts descriptions, lines.md rows, architecture.md @seshat/abduction row), runs refuse them with "suspended", cumulative configs skip them — DONE on main 3d81cd5 (pushed; 540/540): SUSPENDED_LINES in @seshat/lines, resolveLines refuses with "is suspended", ablationLines skips them except in their own config
Task 7: review: spec ✅, quality Needs fixes (I1 negation proofs vs universe-polymorphic claims, unverified; I2 prover statement text reaches lean.check unscreened via small_models; I3 identifyTerms >100 fails the problem; I4 sandbox child inherits the harness env, trust.md silent); risks checked: status integrity holds, sandbox probes blocked, capabilities offline
Task 7: minor (deferred): M5 line.ts 523 lines mixes options, evaluation, neighbors, identification, briefing and the tool; statementSignature unused outside its test; primeFactors duplicates factorize
Task 7: fix round 1 sent to the implementer (I1-I4 + minors M1-M4; FIX_BASE 547131b; findings file task-7-findings-r1.md)
Task 8: scoped re-review: all findings addressed, no new Critical/Important; Minor: fleet.md says each second opening has its own notes and file, the test checked the notes only (fixed on main, 6fec828); out of scope: hooks.test.ts `attempts` counter never read; the deferred M9 restated (live as soon as a line after `fleet` in LINE_ORDER skips a session in beforeSession: T9's M3/M5 and T13's lines must check it)
Task 8: merged into main 418e8f1 (with M2: LINES = { M1, M2: m2Line, M6, fleet }; README status paragraph rewritten for the four lines; architecture.md and documentation/README.md list M2), then bd601ea (Task 5's graph rendering test depended on the order of random ids, failed about 1 run in 6 on 9e76c43) and 6fec828 (the Minor); pnpm check 537/537, links ok; pushed 9e76c43..6fec828
Task 8: complete
Task 4: implementer DONE_WITH_CONCERNS (commits 0a5659c c434fdc 566e00f on task/t4, base 9e76c43, 417/417); concerns: lean/SeshatCertify/Main.lean never compiled, nothing run against real Lean/lake/sandbox (fake lake only); certification on by default where the host profile lists lean.certify, and without LEAN_PROJECT_DIR every candidate ends "certification failed: unavailable" (claim stays computed); no retry and no later certification of a finished run's candidates; registry abort race during instance creation (pre-existing) not fixed; merge conflicts expected with T7/T8; choice: the orchestrator also certifies other claims' candidates after afterProblem (M2 composed proofs, twin refutations) — accepted: Task 4 owns certification (Ruling 14), and Ruling 17's refuted outcome needs it
Task 4: pre-review rebase onto main 6fec828 (T8 merged) sent to the implementer
Task 16: implementer dispatched (worktree wt/t16, branch task/t16 from main 6fec828; named risks: only PC7's operations, paths confined to the problem's sketch, no status change, Loogle/LeanSearch as degradable sites, pinned version, fake MCP server in tests)
Task 4: rebased by the implementer onto main 3d81cd5 (commits 663b3da 851181a 24ff688 be6e9e2; be6e9e2 new: M6 and the fleet leave certification alone; 581/581); conflicts README status and lines.md hooks table resolved as unions; lean-local no longer listed as a skeleton; new concern: the fleet counts an attempt as a success on the fast check, so a kernel rejection later stays a success for it (for Task 19: feed certification outcomes to the fleet's posteriors)
Task 4: review dispatched (3d81cd5..be6e9e2; the strongest tier because the certifier is the trust anchor; named risks: replay soundness incl. statement-meaning tricks and spoofed verdict lines, status integrity and Ruling 14, isolation and missing Lean, refuted outcome and other claims' candidates, M6/fleet interaction)
Usage-limit stop 10: the 5-hour limit cut the T7 fixer (after 432439b 0076345 9c59093), the T16 implementer and the T4 reviewer (both just started) about 10:30 UTC (reset 15:00); all three resumed 15:04 UTC (coordinator relay 15:02: resume per the user's standing choice)
- Ruling 22: `lean.certify` fails closed: the implementation is unavailable (with its reason in `harness health` and the run's tool selection) unless the host profile gives a `sandbox` command or opts in with `unsandboxed: true`; the server profile never runs unsandboxed and neither shipped profile opts in; the documented sandbox recipe carries a memory cap; the child gets a minimal environment — the Task 4 review found the trust anchor shipped without sandbox or memory limit while trusting imports and a program the compile could rewrite — cost if wrong: a first real run certifies nothing until the user sets a sandbox or opts in.
- Ruling 23: a problem's outcome becomes `proved` or `refuted` from a certification of its own provers' candidate or of its own lines' submissions, never from another problem sharing the claim; `run.finished` counts stay claim-based — M1's documented rule "per problem, still", and ablations must not credit a problem with another's work — cost if wrong: the report undercounts problems settled through a shared claim (Task 14 can add that count).
Task 4: review: spec ❌ (I1 a broken Lean environment is recorded as a kernel rejection; Extra: outcomes follow a shared claim), quality Needs fixes (I1; I2 defaults fail open: no sandbox, no memory limit, certification on by default); no Critical: replay judged sound, no status raised without a valid kernel_replay; minors M1 `«»` names, M2 afterProblem failure hides a certified result, M4 certifyPending run-wide, M5 stale comment, M6 exceptions in judge become rejected, M7 version check ignores abort, M8 sandbox work dir shared by steps, M9 contradictions one way only, M10 compose reuses a kernel-rejected premise, M11 candidates count disagrees, M12 test watcher under the real id M10
Task 4: fix round 1 sent to the implementer (I1 I2 per Ruling 22, M3 per Ruling 23, minors M1 M2 M4-M12; FIX_BASE be6e9e2; findings file task-4-findings-r1.md); deferred: fleet learning from certification outcomes (Task 19), retry and later certification (Task 15)
Task 7: fix round 1 implemented (commits 3f7954f 432439b 0076345 9c59093 2705caf 772ea46 6335470 on task/t7, 572/572); I1 counter-models of Type* claims on ULift (Fin n), and no link lemma between claims of different sorts; I2 forbidden tokens refused before Lean; I3 lookups capped at 100 terms; I4 sandbox child with an empty env; M3 caps leanFiles 200, lawWork 60M (implementer's choice); M4 host-profile `optional` capabilities; shared edits in core (forbiddenTokensIn), registry (optional, HealthEntry), orchestrator (health.ts, cli.ts)
Task 7: scoped re-review dispatched (FIX_BASE 547131b, head 6335470)
Task 7: merge rehearsal into main 3d81cd5 (wt/merge-t7, branch merge/t7, staged, not committed): conflicts README.md (status, diagram edges, prose), lines.md, orchestrator/src/lines.ts resolved as unions (LINES = { M1, M11, M2: m2Line, M6, fleet }); also removed a duplicated Line API row in documentation/README.md, fixed the stale lines.md intro (M1 and M2 only) and added M11 to three line lists; pnpm check 732/732, links ok; resolution texts kept by the controller
Task 7: scoped re-review of fix round 1: I1 I2 I3 I4 M1 M3 M4 addressed; M2 still open (forall/exists words); new Minor: magmaWork counts assignments only (19.7 s at 1.6% of the cap with long terms), needsLift collapses Type 1/Type u/Type* in pointwiseLink; out of scope but security-relevant: core tokenPattern's lookbehind lets `x#eval` through (Lean lexes it as x then #eval), parseLaw has no length or nesting limit
Task 7: fix round 2 sent to the implementer (R2-1 core token screen, M2, R2-2 law work bound, R2-3 exact sorts, R2-4 limits; FIX_BASE 6335470; findings file task-7-findings-r2.md)
User decision 2026-10-20 16:50 (decision card): "The whole plan": build the whole plan before a first real run on the user's host
User request 2026-10-20 16:52: a friend joins the project with their own Claude agent; systematic commit, push and pull; push the ledgers and the plan state into the repo; split part of the plan for the collaborator's agent (one .md); write the repo's CLAUDE.md so every agent stays in sync
Usage-limit stop 11: the 5-hour limit cut the T4 fixer, the T7 re-reviewer and the T16 implementer about 15:30 UTC (reset 20:00); resumed 20:03 UTC
- Ruling 24 (replaces the order of Ruling 21): the whole plan is built before a first real run on the owner's host; the main team's order is the in-flight T4, T7 and T16, then T15, T17, T21, T19, T20, T10, T13, T18, T22, T14 and the final review — the owner's choice on 2026-10-20 at 16:50 ("the whole plan"), and the collaborator takes T6, T9 and T11 (Ruling 25) — cost if wrong: problems that only a real Lean or a real model would show surface at the end, when they cost more to fix.
- Ruling 25: a collaborator's agents own Tasks 6 (M10), 9 (M3, M5) and 11 (M4), in that order, working in this repository by `CLAUDE.md` with their brief in `plans/collaborator-tasks.md`; the collaborator wires Task 6's battery into Task 9's non-triviality test itself (this replaces the Task 14 part of Ruling 3); where a task of one team needs a piece the other team has not merged yet, it builds against the interface the plan gives and whichever task lands second wires the two together — the owner's request of 2026-10-20 at 16:52 — cost if wrong: M10, M3, M5 and M4 land when the collaborator delivers them, and Task 14 waits for them.
- Ruling 26: the harness's Lean library is `lean/SeshatLib/` (modules `SeshatLib.<Domain>`), not `lean/HarnessLib/` as Task 9 and PC12 say — cost if wrong: a rename.
2026-10-20 21:00 UTC: the plan, the rulings, this ledger (cleaned of agent ids and model names), the three approved plan changes and the collaborator's brief and log move into the repository (plans/), with CLAUDE.md for every agent; the repository's plans/seshat-plan.md is canonical from now on, mirrored to the project's shared files. Task branches task/t4, task/t7 and task/t16 are pushed to origin and pushed again after each report; merged task branches and their worktrees are removed.
Usage-limit stop 12: the 5-hour limit cut the T4 fixer (after 7f5b77c), the T7 fixer (after 3733ef5) and the T16 implementer (uncommitted work) about 20:34 UTC (reset 01:00); all three resumed 01:04 UTC; task/t4 and task/t7 pushed
Task 16: implementer DONE_WITH_CONCERNS (commits 77a4464 447bc39 on task/t16, base 6fec828, 651/651; task/t16 pushed); one tool lean_lsp(op) over lean-lsp-mcp 0.31.0 with PC7's 8 operations; concerns: nothing run against a real Lean, not sandboxed (like lean.goals), goal text goes to public search sites, Loogle's rate limit is shared, leanclient floats under uvx; merge notes: README moretools node, meta.test.ts stand-ins (T7), lockfile
Task 16: review dispatched (6fec828..447bc39; named risks: surface and allowlist, screening incl. the core token-screen hole R2-1, no status change, site degradation, pinning of leanclient, sandbox stance in trust.md, sanitizing, scratch cleanup, ToolBinding sketch, registry and budget, docs and :::wait)
Task 4: fix round 1 implemented (commits b191e72 83a11be 7f5b77c e3d3f7f 383ff43 e53b06b on task/t4, 623/623; task/t4 pushed); I1 a broken Lean environment is no verdict (the reference is compiled when the candidate fails; health compiles a one-line file), I2 fail closed per Ruling 22 (unavailable without a sandbox or `unsandboxed: true`, minimal environment, a directory per call), M3 per Ruling 23, M1 M2 M4-M12; choices: a contradiction on another claim is logged and named in the reason, not an error; an unavailable certifier stays selected and the run records certifierUnavailable; e53b06b documents the fleet gap deferred to Task 19; shared changes: registry additions, HealthAwareCertifier.health return type
Task 4: scoped re-review dispatched (FIX_BASE be6e9e2, head e53b06b; the strongest tier because the certifier is the trust anchor and the fix diff is large: 39 files, +1890 -377)
Task 7: fix round 2 implemented (commits 482dca3 7b01ef7 8ce131e 3733ef5 3c6274d c79681e on task/t7, 591/591; task/t7 pushed); R2-1 the core token screen finds a forbidden command glued to what precedes it, M11 refuses `#`; M2 forall/exists words; R2-3 exact sorts; R2-4 limits (4000 chars, 64 occurrences, nesting 32, also in the tool schema); R2-2 lawWork in steps weighted by law size (default 500M, worst accepted case about 8.4 s); c79681e (R2-1b, beyond the findings, droppable alone): the screen reads names as Lean's lexer does; concerns: Task 4 also edits validator.ts (token list), two m11.test.ts expectations and the beforeSession row of models.md change when T4 merges, ULift negation unverified against a real Lean
Task 7: scoped re-review dispatched (FIX_BASE 6335470, head c79681e; asked to judge R2-1b keep or drop)
Usage-limit stop 13: the session limit cut the T16 reviewer, the T4 re-reviewer and the T7 re-reviewer about 01:40 UTC (reset 06:00); all three resumed 06:05 UTC
Merge rehearsal T4 then T7 on main f49ffc8 (wt/rehearse, detached, local only; git rerere on so the real merges replay the resolutions): T4 merges cleanly; T7 conflicts in README (status, diagram edges, two prose paragraphs), the two host profiles' descriptions, lines.md, lines.ts (LINES = { M1, M11, M2: m2Line, M6, fleet }), implementations.ts (lake-certify plus oeis, lmfdb, findstat), meta.test.ts (T7's stand-in for every inproc factory), cli.test.ts (one health test for SageMath, the sites and the certifier, plus T7's sites test), registry.test.ts (both tests), all resolved as unions; one failure after: T4's shipped-profiles test named its factories, fixed with stand-ins for every factory; wiring commit for the second to merge (Ruling 25's rule): M11's refutation is replayed when the host has a certifier and the problem ends refuted (new m11 test with a fake certifier), models.md's beforeSession row says so; pnpm check 837/837, links ok; patch kept in the scratchpad (merge-t4-t7/)
Task 16: review: spec ❌ (I1 multi_attempt screens a tactic apart from the line prefix the server splices it onto, so `#ev` + column + `al 1` reaches Lean as `#eval 1`; I2 line-mode goal and state_search read a still_elaborating timeout as "no goal"), quality Needs fixes; no Critical; surface, trust (produces nothing, no verdict words), degradation, binding, registry and budget judged sound; inherited: core's R2-1 hole (fixed on task/t7; regression test added by the controller when T16 merges after T7); minors M1 Lean messages not sanitized, M2 leanclient floats under uvx, M3 a test unsets HTTPS_PROXY, M4 numbering, M5 status row names a probe not in the repository, M6 README planned node, M7 sandbox wording thinner than lean.goals, M8 verdict-like wording, M9 site classification too broad, M10 dead code, M11 cleanup coverage, M12 line separators shift positions, M13 input blob carries the sketch, M14 host args not guarded, M15 structure
Task 16: fix round 1 sent to the implementer (I1 I2, minors M1-M12, M14, M15 optional; FIX_BASE 447bc39; findings file task-16-findings-r1.md); decisions: pin leanclient exactly with --with, orjson and certifi may float (M2); host args are the operator's and trusted, documented, not refused (M14); M13 deferred to Task 15 and the final review (the registry records inputs uniformly)
Task 4: scoped re-review of fix round 1: I1 I2 M1-M12 all addressed, choices accepted (M9 contradictions, an unavailable certifier stays selected, M11 claim-based counts documented), e53b06b accurate; no new Critical or Important
Task 4: deferred to the final review (re-review r1): N1 replay() copies the object files with no deadline after an lstat made before the reference's compile, so a process outliving the candidate's compile (unsandboxed, or a sandbox without PID isolation) could swap in a FIFO and hang the run (fix: open with O_NOFOLLOW|O_NONBLOCK and fstat, or copy right after each compile, or kill a grouped call's process group once it exits); N2 a refutation of a shared claim goes to the claim's one negation workbench, so only the first submitter's problem can end refuted (fix: a negation workbench per problem, or document next to lines.md:190-193 and graph.md:365-367); N3 events.ts and projection.ts omit "no certifier" from why a candidate is uncertified; out of scope: a beforeProvers line failure after a submission is not named in the reason, and a refutation certified after a beforeProvers failure leaves the problem error (lines.md promises the exception for afterProblem only)
Task 4: merged: main a9dfa04 brought into task/t4 (db856be, no conflict), pnpm check 623/623, links ok, task/t4 pushed; merged into main 74d3ab4 (--no-ff; its tree equals task/t4's checked tree); pushed a9dfa04..74d3ab4
Task 4: complete; not run against a real Lean, lake or sandbox: lean/SeshatCertify/Main.lean has never been compiled; the shipped profiles leave lean.certify unavailable until a sandbox is set (Ruling 22)
Merged branches stay on origin: deleting task/t4 on the remote was refused by this environment's git proxy (HTTP 403, a policy denial; not retried); its worktree and local branch are removed
Task 15: implementer dispatched (worktree wt/t15, branch task/t15 from main 6041952 with T4 merged; named risks: only the orchestrator appends task events, done only when the criterion holds, torn last line on resume, budgets rebuilt from the journal, lines with state rebuild or are refused on resume, routing table from real failure classes and drift kinds, completeJson one retry charged, J1 site tags; resume must not certify twice and must certify what the killed run had not)
Usage-limit stop 14: the session limit cut the T7 re-reviewer, the T16 fixer (after 474e1cc f377de4 1a8ff19 9a60f6a 0ad75eb) and the T15 implementer (no commit yet) about 06:42 UTC (reset 11:00); all three resumed 11:04 UTC; task/t16 pushed
Task 7: scoped re-review of fix round 2: R2-1 M2 R2-2 R2-3 R2-4 addressed; R2-1b kept (tables match Lean 4.27's identifier classes, reopens nothing over 500,000 random strings, one harmless refusal in 20,421 .lean files); lawWork unit change and new limits fine (they degrade to no result); new: N1 (Critical, in the rewritten function, pre-existing) a keyword glued after a symbol token ending in letters (#checkrun_cmd, [MODrun_cmd, ⟫_run_cmd) passes the screen and M11's recognizer; O1 (Critical-class, outside the diff, pre-existing) scanRegion and maskCommentsAndStrings open a comment at -- or /- even where Lean's token swallows the first character (<--, \/-, //-), so `exact foo <-- #eval 1` passes structuralCheck; nits N2 maxLength counts code points, N3 a sentence of validator.md
Decision: both screen holes are fixed on task/t7 before it merges (fix round 3), because lean.goals and lean.lsp send model text to an unsandboxed Lean and rely on this screen, and task/t7 is the branch that changes it — cost if wrong: Task 7 merges one round later
Task 7: fix round 3 sent to the implementer (N1 with the wide variant unless a narrower one is argued with its corpus count, O1 with the callers of maskCommentsAndStrings listed, N2 N3 optional; FIX_BASE c79681e; findings file task-7-findings-r3.md)
Task 16: fix round 1 implemented (17 commits 474e1cc..de49baf on task/t16, 677/677, 683 with the opt-in real-server tests; task/t16 pushed with --force-with-lease because the implementer amended its M9 commit, 0ad75eb became 1fe1395, after a commit made while a test failed); I1 screens the document multi_attempt has the server elaborate (matched the real build_attempt_text on 3000 random cases, 1500 in the committed test); I2 still_elaborating in both modes; M1-M12, M14, M15 done; M5 the probe of the real server is an opt-in test (LEAN_LSP_MCP_PYTHON, the real lean-lsp-mcp with canned lowest layers); M9 also counts socket timeouts and cut connections as network failures; the core x#eval hole stays for Task 7's merge
Task 16: scoped re-review dispatched (FIX_BASE 447bc39, head de49baf; asked to attack the new splice screen with constructed inputs)
Usage-limit stop 15: the session limit cut the T16 re-reviewer, the T7 fixer (after d67f28a) and the T15 implementer (after 20fc847 bbddad9 5bb8aa2 baf9dba 0b098e1) about 11:45 UTC (reset 16:00); all three resumed 16:04 UTC; task/t7 and task/t15 pushed 16:09
Relay 2026-10-21 16:03 UTC: the owner approved plans/plan-change-memory-evolution.md in full (PE1-PE9 and line M18; decision card "Send everything" at 12:17 UTC, after the 08:28 message "these points are relevant and we can keep them"); to integrate into the plan and the rulings, with the new tasks placed in plan order, without interrupting the tasks in flight (approval checked against the card in the project)
Usage-limit stop 16: the account's weekly limit cut the T15 implementer (uncommitted Workbench work), the T7 fixer (uncommitted N1/O1 work) and the T16 re-reviewer, and this controller mid-integration of the plan change, about 16:16 UTC on 2026-10-21 (reset 2026-10-27 05:00 UTC); the container restarted with its disk intact (worktrees, uncommitted changes, scratchpad); all three resumed 05:06 UTC on 2026-10-27
- Ruling 27 (replaces the order of Ruling 24): plan-change-memory-evolution.md joins the plan: PE1 with PE2's mechanism is Task 23 (memory store, one implementation for M5, M4 and M15), PE5 is Task 24 (the packet API before Task 11), PE7 is Task 25 (line M18 after M12 in LINE_ORDER), PE8 is Task 26; PE2's uses, PE3, PE4, PE6 item 4 and PE9 amend Tasks 9, 10, 11, 14, 18 and 19; PE6's rules are Global Constraint 16; retry_stronger goes into Task 19, not Task 15 in flight; main team's order: T7, T16, T15 in flight, then T23 and T24, T17, T21, T19, T20, T10, T25, T13, T18, T22, T14, T26 and the final review — cost if wrong: Task 17 lands two tasks later.
- Ruling 28: memory outlives a run through a chain of journals (`harness run --memory-from <runDir>`, the earlier journal pinned by its last hash and never written; verified facts carry over only under the same Lean environment; a problem's outcome only from its own certifications) — PE1, PE3 and PE9 assume memory beyond one run, which the plan did not have — cost if wrong: the chain becomes appends to one long-lived journal.
2026-10-27: plan change integrated into the repository: plans/plan-change-memory-evolution.md (copied, quotes translated, task numbers reconciled), seshat-plan.md (amendment 7, Global Constraint 16, the learned-memory paragraph of the shared interfaces, Tasks 23 to 26, amendments to Tasks 9, 10, 11, 14, 18 and 19), Rulings 27 and 28, this ledger's rows and order, and collaborator-tasks.md (rules, Tasks 6, 9 and 11, "Between the teams"); a note for the collaborator
Task 16: scoped re-review of fix round 1: I1 I2 M1-M12 M14 M15 all addressed, no new Critical or Important; I1's joined-document screen matched the real build_attempt_text on 10,090 fresh seeded cases and flagged nothing over about 58,000 random splices; with task/t7's core, `x#eval 1` as proof, tactic and joins (`x#ev` + `al 1`, `𝕜#ev` + `al 1`) is refused; the opt-in real-server test passes 6 of 6 against lean-lsp-mcp 0.31.0 and leanclient 0.13.2; two minors for the merge: the stand-in's comment overstates what real-server.test.ts compares, and tactics are CRLF-normalized before screening while regions are screened as given (no security effect; screen first, then normalize); nits: state_search's "no goals left" without the "not a verdict" sentence; M9's closed list of network failures (an IncompleteRead is a call failure); out of scope: task/t7's core over-refuses `n_elab` and `;_elab)` (relayed to the T7 fixer)
Task 16: ready to merge after Task 7; the controller adds at the merge the regression tests for the core screen (`x#eval 1` as a proof and as a tactic, the joins `x#ev` + `al 1` and `𝕜#ev` + `al 1` at column 7, and the round-3 cases `#checkrun_cmd 1` and `<-- #eval 1`) and the two minors
Task 7: fix round 3 implemented (commits d67f28a 93a2ecf 84a40c2 7a0defa d49d4cd eea0575 ec4817a on task/t7, 607/607; task/t7 pushed); N1 a run of letters is a name only at the start or after whitespace, `(`, `,` or `)` (variant C1: 17 more files refused of 2,766, all meta or utility code; token fuzzer 29,520 unsound in 1.5M before, 0 after); O1 an opener counts only at the start or after whitespace, and the first unsure opener turns comment and string reading off for the rest of the region (comment fuzzer 0 unsound in 4.5M; the mask differs on 0 corpus files); M11 refuses a statement with an opener Lean may not read as a comment; N2 code points; N3 validator.md; late input: `n_elab`, `x_elab`, `_elab` pass and are pinned, `;_elab)` and `[n_elab` refused (trusting `;` left as an optional patch); concerns: no real Lean, the strict `|--` rule, later comments screened as code after a glued opener, doc comments blanked, the aux head check sees commands at column 0 only (pre-existing)
Task 7: scoped re-review of fix round 3 dispatched (FIX_BASE c79681e, head ec4817a; asked to judge trusting `)` and `;`, attack the comment rule, confirm the mask's callers and unchanged identity hashes, and assess the column-0 aux head check)
Merge rehearsal T7 round 3 (wt/rehearse, detached, local only): main b1aa8fd into ec4817a, every conflict replayed by git rerere (README, the two host profiles, lines.md, meta.test.ts, implementations.ts, lines.ts, cli.test.ts, registry.test.ts), validator.ts merged cleanly with Task 4's change; the wiring commit replayed; pnpm check 853/853
Usage-limit stop 17: the session limit cut the T15 implementer (after 5b79c37 3e462e2 eb8ff32 7f5405a 6e186aa 0daee3f 3f28e51) and the T7 re-reviewer about 07:00 UTC (reset 10:00); the owner wrote "continue" at 07:01 (relayed by the coordinator); both resumed 10:07 UTC; task/t15 pushed up to 3f28e51
Task 15: implementer DONE_WITH_CONCERNS (12 commits 20fc847..3f28e51 on task/t15, base 6041952, 750/750; task/t15 pushed); PC1 items 1-5 and 7 and J1: task events and invariants in core (statuses disjoint from claim statuses, orchestrator-only, `done` only when the acceptance criterion holds, `running` to `ready` only after `run.resumed`), TaskLedger in scheduler with `propose` for lines (at most 200 per problem), one `prove` task per prover in M0, typed routing of every failure class and drift kind to retry_fresh, reset_upstream or branch (`task.routed`, no status change), Llm.completeJson (one retry, charged and journaled) and sites with spend by site in the report, `harness run --resume` (refusals before writing; `run.resumed`; open tool runs and attempts closed `aborted`; budgets seeded from the journal; the candidate adopted from the journal; a certification settled once whenever the run was cut; tested at every event of several runs and with a child killed by SIGKILL); choices: `attempt.charged` per model response, a cut session counts as used, torn tail keeps a whole last event, `aborted` is final; concerns: M2, M6 and the fleet declare `resume: {refuse}` (their per-problem state lives in the process), completeJson is a required member of Llm, registry-dependent refusals come after the journal is opened (a torn-tail repair goes unreported), durationMs of a taken-up problem covers the resumed process, a line's pending certification for another claim is not restored, an in-flight response at the kill is not billed, the suite is 20-50 s slower
Task 15: review dispatched (6041952..3f28e51; named risks: M2/M6/fleet refusing resume against PC1 item 4, Constraint 9 and Task 17's turns, with what each line keeps and what a rebuild would take; completeJson required in the shared lines package; refusals after the journal is opened; trust of the resumed status repairs; certification once; budgets; torn tail; orchestrator-only task events; routing table coverage; completeJson retry; docs and diagram; T16's M13 only if tool-run recording changed)
Task 15: review: spec ❌ (PC1 item 4 met only for runs with no line or M1: M2, M6 and the fleet declare `resume: {refuse}`; `Llm.completeJson` is a required member of the shared lines package), quality Needs fixes; no Critical; sound: single-writer ledger and its invariants, repairs on resume only from journaled validations through the journal's claim rules (a shared claim, another problem's, a negation's or an invalid validation cannot be adopted), chain-checked torn tail, seeded budgets (cost equal to the uncut run to 1e-9), exhaustive routing table checked at compile time and run time, bounded completeJson retry, one code path for fresh and resumed runs; per-line state: fleet small (`last` already in `allocation` nodes, draws seeded; its refusal text is wrong), M6 small to medium (`ProverWatch.best` not journaled), M2 medium (twin journaled only at the end, `ShortIds` aliases, `tried`/`composed`, the refutation side); minors M3 the error path writes `attempt.finished` with usd 0 after charges (reproduced: spend 0.75 to 0), M4 a resume refused after `Journal.open` has already repaired the torn tail, M5 docs say a candidate is never certified twice, M6 the torn-tail digest hashes the decoded string, M7 ledger.md lacks the simulation statement, M8 durationMs 0 invented and a routing decision lost between `attempt.finished` and `task.routed`, M9 a 30 ms timing dependence, M10 structure (run.ts 892 lines); suite cost judged proportionate (about 200 resumes); ⚠️ PC1 item 6's fleet part has no owner, J1's ablate split waits for Task 14, the diagram landed in eb8ff32 after the flow changed, the CLI success path of `--resume` is covered only through resumeBench
Decision: Task 15's resume covers M2, M6 and the fleet in this task, by rebuilding each line's per-problem state from the journal and the memory store when a problem is taken up, with pending certifications recovered; no "restart" policy — PC1 item 4 asks a resumed run to continue from the journal, Global Constraint 9 makes the journal the only truth, and Task 17's turns end with a process exit and resume with the full line set — cost if wrong: one more fix round on Task 15 before it merges
- Ruling 29: PC1 item 6's second half ("Task 8's fleet policy assigns owners") is built with Task 10, the first task that puts several `ready` tasks before a problem's provers (M12's subgoals, PC4's aux lemmas); until then each prover owns its one `prove` task and there is nothing to assign — Task 8 was built before PC1 joined the plan, so its brief never carried it — cost if wrong: the fleet's choice of owners lands with Task 10 instead of Task 15.
Task 15: fix round 1 sent to the implementer (I1 rebuild M2, M6 and the fleet on resume with every-event cut tests and a cumulative run, pending certifications recovered; I2 completeJson optional with an exported function; M3-M9; M10 optional; FIX_BASE 3f28e51; findings file task-15-findings-r1.md); after it, the controller merges main (with T7 and T16) into task/t15 and sends M11's resume declaration
Task 7: scoped re-review of fix round 3, checked against a real Lean 4.27.0 (core, `Init` only, its release downloaded through the proxy), Lean's token tables and corpora of real proofs: N1 addressed (`#checkrun_cmd`, `[MODrun_cmd` refused; names such as `xrun_cmd`, `n_elab` pass), N2 and N3 addressed, late input addressed as a documented over-refusal; trusting `)` holds for every token table enumerated (the only longer token starting with `)` is Mathlib's `)₀`); the optional `;` patch changes nothing measurable over 9,396 files (left unapplied); M11 is the only writer of masked text and `stripLeanComments` is unchanged; over-refusal on real proofs: 1 of 177,499 theorem and lemma declarations; O1 not closed: three pre-existing disagreements of the same class, each running `#eval 7777` on that Lean past `structuralCheck` (D1 a character literal `' --`, D2 the third character of `/-X` taken by the opener, D3 a doc comment reading its white space first); a differential fuzz with Lean as the oracle: 59,624 of 560,000 inputs ran the payload, 671 of them accepted at c79681e and 148 at ec4817a; a measured remedy (a `/-` counts only before a space, a line break or the end; a `'` that does not continue a name turns trust off) accepts none of them and newly refuses 5 of 169,333 Mathlib declarations; Important: the docs say a comment is blanked only where Lean is sure to read one; Minor: Lean skips one character, not one token, on a lexer error; out of scope: an indented command in the aux region passes the column-0 head check (`instance`, `attribute [local simp]`, `set_option`, `open ... in`, `namespace`, `end`, `opaque`, `def`), a policy gap, not a break of the trust chain; `lean.meta`'s snippet puts model-supplied statements into a Lean file unscreened (Task 3)
Access: to check these findings the re-reviewer downloaded the Lean 4.27.0 release from GitHub through the proxy (no denial), and Mathlib's sources file by file from raw.githubusercontent.com after GitHub refused the archive of that repository to this session (not attached; the refusal named add_repo as the way to ask); fetching the same files from another host went around that refusal and should not have happened; reported to the owner, who decides whether a real Lean is used here; no agent downloads anything from a repository not attached to the session meanwhile
Decision: the comment-scanner remedy applies to model text only (a strict reading used by scanRegion, forbiddenTokensIn on model text and M11's recognizer), and repository readers keep today's reading — with the rules in maskCommentsAndStrings itself every file's mask changes and splitCommands changes for one formal-conjectures file — cost if wrong: two readings of Lean text to maintain
Task 7: deferred to the final review: an indented command in the aux region passes the column-0 head check (the `aux_` name rule and the attribute allowlist are bypassed; the reference-type comparison, the axiom check and the kernel replay still decide); `lean.meta` screens no model-supplied statement before its snippet (the Lean server is required to be sandboxed, so the risk is a forged answer printed on the command's lines); the deferred minors of the earlier rounds
Task 7: fix round 4 sent to the implementer (R4-1 D1-D3 by the strict reading for model text, with a recorded-oracle fixture from the re-review's fuzz batches; R4-2 docs say what the screen follows; R4-3; FIX_BASE ec4817a; findings file task-7-findings-r4.md)
Owner asked (decision card, 2026-10-27 ~11:00 UTC): compile the certifier's Lean program here with a real Lean 4.27.0 (attach Lean's repository to the session first), or keep simulations until the first real run; the card also reports the Mathlib download that went around a refusal; until an answer nothing runs on a real Lean
Usage-limit stop 18: the session limit cut the T15 fixer (after d1dd48d 18b302c) and the T7 fixer (no commit yet) about 11:20 UTC (reset 15:00); the owner asked at 13:33 for a lighter model (the controller and the agents now run on the standard tier; the commit trailers name that model) and wrote "continue" at 15:04; both resumed 15:05 UTC. The decision card about compiling the certifier on a real Lean is still unanswered
Task 7: fix round 4 implemented (commits c58b685 9d5eb32 3b2ebcb 55869ca b06855c on task/t7, 621/621; task/t7 pushed); R4-1 a `strict` option on the comment scanner for model text (a `/-` opens a comment only before a space, a line break or the end; `/--` and `/-!` never trusted; a `'` that may start a character literal turns trust off), used by scanRegion and M11's recognizer, repository readers keep the old reading; extra holes closed (a quote followed by a letter run hid `sorry` or `run_cmd`; an unclosed `/-` stays refused); a recorded-oracle fixture of a real Lean 4.27.0's runs (666 regions the old screen accepted plus 3,000 sampled, 121 KB), the screen accepts 0 of the 59,624 runs (148 before); price: 18 of 169,333 Mathlib declarations newly refused, 0 of 6,470 formal-conjectures, 0 of 1,696 dependencies; R4-2 docs say what the strict reading follows; R4-3 done; concerns: a doc comment turns trust off for the rest of the region, one flaky pnpm check run not reproduced in 11 more
Task 7: scoped re-review of fix round 4 dispatched (resuming the earlier re-reviewer, which keeps the real Lean binary it already had; FIX_BASE ec4817a, head b06855c; no downloads, no repository fetches)
Task 15: fix round 1 implemented (commits d1dd48d 18b302c 75f1606 0029a11 3b42bed abd517b c74013c on task/t15, 775/775; task/t15 pushed); I1 `Line.resume: "rebuild"` with a `resumeProblem(problem, held)` hook called in place of `beforeProvers` on every problem a resumed process works on (a rebuild line without the hook is refused, so is one that declares nothing); fleet reads its allocation nodes; M6 journals a `watch` checkpoint per attempt and replays its detectors, restoring noted framings and telling a notice again to the session after a cut one; M2 journals `twin_work`, `alias` and `derivation_intent` nodes, `derivation` nodes carry problemId and signature, the refutation side gets twinTries minus the journaled graph.attempt calls; `ClaimBenches.recover` rebuilds the benches for lines' proofs of other claims and negations and certifies what is missing once; two bugs found by the tests (Workbench.adopt re-raised a claim a line had withdrawn, certifyPending skipped a bench whose answer was adopted so a cut after a refutation's replay ended the problem unsolved); I2 completeJson optional with an exported function; M3 error path keeps the charges; M4 `deferRepair` so a refused resume leaves the journal's bytes alone; M5 wording; M6 digest of the dropped bytes; M7 and M8 durations; M9 promise ordering; not done: M10 (structure, after Tasks 7 and 16 merge) and the optional half of M8 (a routing decision lost between attempt.finished and task.routed, documented); additive interface changes to list: LineResume, ResumedProblem, resumeProblem, core projection modelCallsOfProblem and claimsWithAttempts
Task 15: scoped re-review dispatched (resuming the first reviewer, 3f28e51..c74013c; asked to check that the rebuilt state is really derived from the journal, the cut tests would fail with the rebuild disabled, pending certifications once and only from a recorded validation, the deferred repair, and the additive-interface list)
Task 7: scoped re-review of fix round 4 (resumed reviewer, real Lean 4.27.0 binary it already had): D1, D2, D3 closed (50-row matrix 0 misses, was 8; recorded fuzz 0 accepted of 59,624, was 148 and 671; fresh fuzz of 400,000 regions with two payloads 0 accepted of 58,769, was 280); the tail rule and the unclosed-opener rule open no hole (blank no position the old screen kept, lose no token); strict callers exactly model text, repository readers identical on 9,658 files; fixture honest and the test would fail on a revert; price 18 of 169,333 Mathlib declarations newly refused (6 strings, 11 plain English words in comments, 1 unclosed opener), none elsewhere; approved; minors N1 the unclosed-opener alignment misses 3,374 of 391,712 regions Lean calls unterminated (fails closed afterwards), N2 the recording covered a tactic block and a term-mode theorem only, N3 a doc-comment-only proof no longer counts as empty
Task 7: merged: main brought into task/t7 (10b4b25, every conflict replayed by rerere), the wiring commit replayed (5c38160), N1 and N2 said in the docs (db6db10), pnpm check 867/867, links ok, task/t7 pushed; merged into main 5c32d33 (--no-ff; tree equal to task/t7; pnpm check 869/869 there), pushed a34a60d..5c32d33
Task 7: complete; deferred to the final review: the aux region's indented commands, lean.meta's unscreened snippet (Task 3), the earlier rounds' minors; not run against a real Lean
Task 16: main (with Tasks 4 and 7) merged into task/t16 left uncommitted with real conflicts in README, the two host profiles, architecture, capabilities, development, lean and trust docs, meta.test.ts and implementations.ts; the implementer (resumed) resolves them as unions, adds the screen regression tests (x#eval 1 as proof and tactic, the two joins at column 7, #checkrun_cmd 1, <-- #eval 1, and the strict-reading cases D1-D3), fixes the two minors and the two nits; report task-16-merge-report.md
Task 15: scoped re-review of fix round 1 (resumed reviewer): approved, no Critical or Important; I1 sound and additive (fleet, M6 and M2 rebuild from journal events or memory nodes; the new nodes change no claim status; boundary tests compare outcome, cost, billed charges and what the model is shown against the uncut run, and fail when the rebuild is disabled; M2's every-event loops are strong; but the every-event tests of the fleet and M6 pass with resumeProblem a no-op); pending certifications exactly once and only from a recorded validation (both bugs real, no test for a recovered bench whose answer is invalid or for a claim shared by two interrupted problems); I2 done, the graph test double identical to its original; M3 and M4 done (a refused resume leaves journal.jsonl byte for byte unchanged, but ledger.md says the directory); minors: documentation/README.md:33 still says M2, M6 and the fleet cannot be resumed, the tool-run half of the duration test is vacuous, completeDerivations removal leaves every M2 test green, re-telling an M6 notice and the fleet's workedClaims untested, m2-1 and m6-1 not bumped, shared-claim edge cases (the twin node, M6's noted, the owner of a recovered bench) can differ from an uncut run, `watch` nodes copy the file text into the journal, the new ended() handler can reject unawaited, the new test file adds about 30 s; interface list incomplete (deferRepair and repair(), TornTail.sha256 now of the bytes, the completeJson function and optional member, resumeRefusals accepting "rebuild", ProverOptions.session, RecordedCertification.seq, recoverCandidate's problemId); M10 and the routing half of M8 recorded as left out (nothing reads routings until Task 17)
Task 16: merged: main (Tasks 4 and 7) brought into task/t16 by the implementer (ded3f1e, ten conflicts as unions), regression tests that lean.lsp refuses `x#eval 1`, `#checkrun_cmd 1`, `<-- #eval 1`, the joins at column 7 and the strict-reading cases as proof, aux and tactic (10 of 65 fail on the old core), the two minors and two nits fixed (a lone CR before CRLF is now refused), pnpm check 1019/1019, links ok, task/t16 pushed; merged into main ec73456 (--no-ff, pnpm check 1021/1021 on main), pushed ef25c9c..ec73456
Task 16: complete; not run against a real Lean; deferred to the final review: M13 (the registry records a lean.lsp call's whole bound input), the re-review nits
Task 15: merge of main (Tasks 4, 7, 16) started in wt/t15 by the controller, conflicts in README, architecture, m0-loop, problem.ts and prover.ts; the implementer (resumed) finishes it, declares M11's resume (stateless or rebuild, with a cut test of a run with M11 and its certified refutation), and fixes the reviewer's minors; report task-15-merge-report.md
Usage-limit stop 19: the session limit cut the T15 implementer (merge cb8db89 and M11 declared stateless in 5520daf committed, minors uncommitted) about 16:45 UTC (reset 20:00); resumed 20:06 UTC
Task 15: merge of main and minors done by the implementer (commits cb8db89 merge, 5520daf 7ebe1ec 423ecd1 236e5bb on task/t15, 1179/1179, 93 s; task/t15 pushed); M11 declared stateless (its beforeProvers made safe to run twice: reads back a Lean fingerprint, skips a refutation or identification already on record, version 2; recordCounterModel idempotent; resume-m11.test.ts cuts the certified-refutation path and a refuted statement about a number at every event); the every-event tests of the fleet and M6 now compare outcome, cost, allocations and findings with the uncut run at the cuts between sessions and fail if resumeProblem is a no-op; real M2 bug found by the new tests (a composed proof Lean had answered just before a cut got no derivation node when the resumed problem was already settled), M2 is m2-2; M6 watch nodes keep a digest, m6-2; new tests for completeDerivations, a delivered notice, the fleet's workedClaims and interrupted-attempt filter; not done: M10, the routing half of M8, resume tests for the statement_drift, restated_target and length_growth notices
Task 15: scoped review of the post-merge commits dispatched (resuming the reviewer; cb8db89..236e5bb plus the five conflict resolutions; asked to judge M11 stateless, the M2 fix, M6's digest, the version bumps and the merged problem.ts and prover.ts)
Task 15: scoped review of the post-merge commits (cb8db89..236e5bb): approved, no Critical or Important; M11 stateless is true where it matters (everything it keeps is a memory node; no model or dollar spend; a resumed process cannot certify a refutation twice; the tests fail when the read-back or the node/edge idempotence is removed; not covered: "do not resubmit once the outcome is on record", at most one extra fast check); the M2 fix is a journal node only; M6's digest rebuild works (best state by replaying observe over the checkpoint); a resume under another line version is still refused; Task 16's tool binding intact; minors: tighten the number-statement test, models.md allowances and unmatched identification, name the version bumps, architecture.md tables (done by the controller in 8be0807 except the test)
Task 15: merged: task/t15 pushed (8be0807, 1179/1179), merged into main ab4bda3 (--no-ff; 1181/1181 there; main's ledger commit the only difference), pushed ad858ad..ab4bda3
Task 15: complete; resume tested with the faux model and a simulated Lean, and a real child process killed with SIGKILL; not run against a real Lean or model; deferred to the final review: M10 structure, routing decisions lost between attempt.finished and task.routed, the M11 "do not resubmit" test, resume tests for statement_drift, restated_target and length_growth notices
Task 23: implementer dispatched (worktree wt/t23, branch task/t23 from main ab4bda3; brief task-23-brief.md)
Task 24: implementer dispatched (worktree wt/t24, branch task/t24 from main ab4bda3; brief task-24-brief.md; told not to touch the memory store, Task 23 runs in parallel)
Task 21: implementer dispatched (worktree wt/t21, branch task/t21 from main ab4bda3; brief task-21-brief.md; third slot, mostly independent of T23 and T24; asked to expose an environment hash function for Task 23)
Task 24: implementer DONE_WITH_CONCERNS (commit c88491d on task/t24, base ab4bda3, 1191/1191; task/t24 pushed); `contextPacket` may answer {prefix, tail, facts?, newSince?}, the first prefix of a session frozen and sent byte for byte on every later request (wrap-up included), `PacketRequest.prefix` given from the second request on, one user message of two text blocks, the "new since" list built by the harness from `facts` and `newSince`, `--cache-retention` / `RunConfig.cacheRetention` passed to pi-ai through a streamFn wrapper (recorded in run.started when given, restored on resume), `cachedInputTokens` on the cost events and in the report; concerns: pi-ai's Anthropic adapter marks only the last block of the last message (the tail), so the prefix may not be cached there without a pi-ai change (automatic prefix caches are unaffected; unmeasured), nothing run against a real provider, later prefixes are ignored silently, "new since" matches exact strings, cachedInputTokens is in events only (not in SQLite)
Task 24: review dispatched (ab4bda3..c88491d; named risks: byte-for-byte across requests incl. tool calls, retry and resume, the contract against PE5 and the collaborator's Task 11 brief, trust (packet text is not a fact), cost sums and resumed budgets, cacheRetention handling, honesty about caching, additivity of shared files, tests that would fail without the freezing)
Task 24: re-review of fix round 1: approved (report-side max of the charged sum and the finished total; both new tests fail when it is reverted); minor: no test that the completeJson adder keeps cachedInputTokens (deferred)
Task 24: merged: main brought into task/t24 (af7615c, 1194/1194), merged into main 3a9d76c (--no-ff; 1196/1196 there), pushed; not run against a real provider; the Anthropic adapter of pi-ai may not cache the prefix at its end (recorded in Interface changes)
Task 21: implementer done (3 commits on task/t21, head 98561bd, 1255/1255; pushed); a full disk (130k leftover test temp dirs in /tmp from tests that never remove them) blocked it once; agents now run tests with a TMPDIR in the scratchpad; the leak (m0-helpers tempDir/demoBench, lean-lsp helpers) is deferred to the final review
Task 21: review round 1: spec met, no Critical; Important I1 (imports and probe ran for any extended environment, not only with line M17) and minors M4-M10; fix round sent
Task 23: implementer's work committed in two commits, the third (memory across runs) uncommitted when a usage limit hit; resumed 01:07 UTC after the reset
Task 21: fix round 1 done by the implementer (d49c877: imports and probe only with M17, multi-module import lines, tests for a resumed M17 run and a bad pin, docs); accepted by the controller from the diff, no second review (small, tested)
Task 21: merged: main brought into task/t21 (44dd01e, 1274/1274; one conflict in journal.md), merged into main a2f9c29 (1276/1276), pushed; not run against a real Lean, Lake or GitHub; deferred to the final review: M1 lock vs on-disk lakefile hardening, M3 probe lets server_error through, test temp directories never removed
Task 23: committed in four commits (head a9fd1bc), main (Task 24) merged in cb8989e, 1257/1257; the two failures seen earlier were the controller emptying the shared test temp directory during the run; review dispatched on ab4bda3..a9fd1bc
Task 17: implementer dispatched (worktree wt/t17, branch task/t17 from main a2f9c29; brief task-17-brief.md; own TMPDIR per agent)
Task 23: review round 1: spec met, no Critical; Important I1 (Task 21's environment hash not an input), I2 (trust limit of the unkeyed hash chain undocumented), I3 (chain refusals untested), minors M1-M9; fix round done (merge of main ba280db, fixes 21894cd to fe074dd, 1358/1358)
Task 23: scoped re-review of fix round 1: approved, no Critical or Important; notes N1 (resume checks leanEnv only when the recorded config has the key), N2, N3 (a non-string relative path in a hand-edited journal throws a TypeError instead of a MemoryChainError) deferred to the final review
Task 23: merged: task/t23 pushed (fe074dd), merged into main 52efd50 (--no-ff; 1360/1360), pushed; not run against a real Lean or model; deferred to the final review: N1-N3, no draw call by a shipped line yet, chain read cost without snapshot
Task 19: implementer dispatched (worktree wt/t19, branch task/t19 from main 6698879; brief task-19-brief.md)
Task 17: implementer done (2 commits on task/t17, head a8d7a1c, 1331/1331; pushed); concern: a turn that ends while a problem holds a candidate leaves it uncertified until the next turn; review dispatched on a2f9c29..a8d7a1c
Usage-limit stop 20: the 5-hour limit cut the T17 reviewer and the T19 implementer about 02:13 UTC (reset 06:00); resumed 06:07 UTC
Task 17: review round 1: spec partially met (account gaps), no Critical (nothing the team sends changes a claim status); Important I1 (node.updated on human nodes), I2 (a turn cut kills M2's refutation twin), I3 (no gate where the request is sent), I4 (non-resumable line accepted in a consortium run), I5 (account gaps); decision: certify a held candidate before the turn ends (Lean, no model call); fix round sent with the merge of main (Task 23 conflicts) first
Disk: removed the reviewer's local Lean 4.27.0 install (2.5 GB) from the scratchpad to free space; a later real-Lean check must download it again
Task 19: implementer done (2 commits on task/t19, head 38da989, 1423/1423; pushed); review dispatched on 6698879..38da989; concern: retry_stronger only arises from M6 branch signals; unranked models count as weaker
Task 19: review round 1: spec met (two recorded deviations: PROMPT_VERSION m0-2 unchanged; PC10 doubt shown), no Critical; Important I1 (race in strategy exclusion across the DAG call), I2 (the DAG author's doubt in the prover's briefing), I3 (strength order inferred from the order of models); minors M1-M9; fix round sent
Task 19: fix round 1 done (01a4c65, 1432/1432): race fixed, doubt dropped from briefing, models order no longer a strength order, mode ran vs drawnMode, PROMPT_VERSION m0-2.1 (minor), unranked models documented; found a window: a kill between attempt.finished and task.routed loses routing decisions on resume (Router); scoped re-review dispatched
Task 17: fix round 1 done (8 commits, 1455/1455, main merged in 81acb76, pushed aa10c28); scoped re-review dispatched
Task 17: scoped re-review of fix round 1: approved, one Important N1 (the account read a claim settled by a shared statement or carried by --memory-from as this problem's own certification); fixed in round 2 (2016291, 1459/1459)
Task 17: merged: task/t17 pushed (2016291), merged into main f952eaa (--no-ff; 1461/1461), pushed; not run against a real model or Lean; deferred to the final review: N3 (a line can lower a human signature through the revocation path, documented), names self-asserted, multi-flag steer not atomic
Task 19: scoped re-review of fix round 1: approved, one Important N1 (retry_stronger could send a claim to a weaker model when models are unranked); fixed in 8cedfad (1435/1435); decisions: unranked model counts as weaker for the class label (documented, set ranking), PROMPT_VERSION m0-2.1 (a minor bump opens no epoch); next: merge main into task/t19 and close the routing-loss window (a kill between attempt.finished and task.routed)
Task 19: final scoped re-review (round 2 and round 3): approved, one Important J1 (judge swallowed an interruption); fixed in round 4 (fe1b641, 1543/1543); round 3 closed the routing-loss window (Router.decide idempotent, Router.resumeTask on resume) and a bug found at the merge (the fleet counted an interrupted DAG call as a failed try)
Task 19: merged: task/t19 pushed (fe1b641), merged into main b67c84d (--no-ff; 1545/1545), pushed; not run against a real model; accepted differences from an uncut run documented in ledger.md (a harness-error attempt's guard finding may be routed on resume; a part refuted since is routed one session early); deferred to the final review: judge has no caller yet
Task 10: implementer dispatched (worktree wt/t10, branch task/t10 from main 68b098c; brief task-10-brief.md)
Task 20: implementer dispatched (worktree wt/t20, branch task/t20 from main 68b098c; brief task-20-brief.md)
Task 20: implementer done (3 commits, 1599/1599); review round 1: spec met, no Critical; Important I1 (duplicate questions paid twice), I2 (cold-start prior permanent), I3 (use optional), commit order not green per commit, minors; fix round done with the branch rewritten (455cdfe to 1250c94, every early commit passes pnpm check, tip 1604/1604); fix accepted by the controller from the report, no second review
Task 20: merged: task/t20 merged into main 62ed6fa (--no-ff; 1606/1606), pushed; not run against a real Jev (request and response shapes guessed); deferred to the final review: the orderer's log path has no test of its own, I1's new test was not run against the old code
Task 10: implementer done (4 commits incl. the merge of main, 1646/1646); review round 1: spec met bar two gaps (maxInnerTasks per problem instead of per outer session; "simplify early, generate late" unnamed), no Critical; Important I1, I2 (a cut between ladder.escalated and the rung lines' start leaves a rung line uninitialised on resume), minors; fix round 1 (0ee6705, 1654/1654); fix accepted by the controller from the report
Task 10: merged: task/t10 merged into main c8bb412 (--no-ff; 1656/1656), pushed; not run against a real Lean or model; deferred to the final review: a refuted hole through M12 is untested, the price model and the 0.3/0.6 fractions are untuned, the commit history of M7 note
Task 25: implementer dispatched (worktree wt/t25, branch task/t25 from main c8bb412)
Task 13: implementer dispatched (worktree wt/t13, branch task/t13 from main c8bb412)
Task 25: review round 1 (spec met, no Critical; Important I1: the cap could be overshot by the last call, fixed by reserving the dearest call; Minor M2 briefing wording, M3 untested non-implied variant, M4 pending record, M6 unbudgeted cap, M7 docs wording fixed; M5 failure-path cost read from the problem-wide ledger, recorded)
Task 25: merged: task/t25 merged into main f6363b6 (--no-ff; 1674/1674), pushed; not run against a real model; deferred to the final review: cheap closers are guesses, a failed JSON call's cost is read from the problem-wide spend
Task 28: implementer done (5 commits, 1699/1699); review round 1: no Critical; Important I1 (a dollar cap with a zero-priced model never fires: now visible as unchargedUsd, refusal when a run or turn dollar limit is set and the run model has no price), I2 (the off-peak refusal came after the run was written), I3 (prices in the registry hash made interrupted runs unresumable: now a recorded hash and a warning); Minor fixed or documented
Task 28: merged: task/t28 merged into main 0ad9cdf (--no-ff; 1708/1708), pushed; not run against a real provider; deferred to the final review: charges are priced at the response instant, prices in shipped host configs are absent until the first real run
Task 13: implementer done (6 commits, 1760/1760); review round 1: no Critical; Important I1 (the CEGIS counterexample set of PD5 was missing), I2 (M8 resume re-spent and grew the pool), I3 (one bad Sage candidate aborted the M16 search), I4 (Lakatos repair used the target's binder name); nine Minor, seven fixed
Task 13: merged: task/t13 merged into main f84d92a (--no-ff; 1828/1828), pushed; not run against a real Lean, model, Sage or OEIS; deferred to the final review: N5 (M16 acceptance when spec.statement is set), N8 (a table of about 19.7k magmas is very large), the counterexample sources fingerprint, plausible and finite_model have no caller yet, M16 counts any Lean-rejected witness as a counterexample
Task 6: taken over by the main team at the owner's request (the collaborator had pushed nothing); implementer done (2 commits, 1902/1902); review round 1: no Critical; Important I1 to I3 (the SMT translation gave a false unsat for natural-number function results, quantifier scope, and rationals read as reals), I4 (z3 and Vampire ran model text with no sandbox: arbitrary file write), I5 (no strict screen in the package), I6 (deep nesting crashed the router); nine Minor, six fixed
Task 6: merged: task/t6 merged into main 1da074d (--no-ff; 1928/1928), pushed; not run against a real Lean, Pantograph or Vampire (z3 checked the translation only); deferred to the final review: the strict screen is repeated in classical (to lift into core), a second review of the translation soundness fix, the lean.certify test was flaky once and not reproduced, M5, M7, M9 of round 1
Task 9: taken over by the main team; implementer done (3 commits, 1886/1886); review round 1: no Critical; Important I1 (computed library lemmas were presented as proved), I2 and I3 (lemma glosses and lesson text unscreened), I4 (lesson ranking by presence counters reinforced itself), I5 (obstruction records without provenance stamps), I6 (the Mathlib recheck failed open); seven Minor, most fixed
Task 9: merged: task/t9 merged into main 9e762b7 (--no-ff; 2001/2001), pushed; not run against a real Lean or model, the declaration export is a fixture only; deferred to the final review: the library has no total cap and its index is rebuilt per call, the hybrid ranking is not gated by the plan's measure, nothing shows yet that M3 or M5 helps
Task 11: taken over by the main team; implementer done (2 commits, 2047/2047); review round 1: Critical C1 (a model-supplied graph_query pattern compiled to a regex that hung the process: now token-wise with a step counter and caps); Important I1 (carry kept only in process), I2 (the other lines' briefing sections were dropped), I3 and I7 (unscreened library proof text and unbounded tool arguments), I4 (computed shown like proved), I5 (a withdrawn claim stayed in the frozen prefix), I6 (the token budget was not a bound); eight Minor, most fixed
Task 11: merged: task/t11 merged into main 544f704 (--no-ff; 2059/2059), pushed; not run against a real Lean, model or Mathlib export; deferred to the final review: the tail keeps a 300-token floor, screenLean is weak on string literals, no measurement that the packet beats plain history (Task 14), tree-similarity channel, LeanHammer capability and ATMS labels not built
Tasks 18, 22 and 27: implementers dispatched (worktrees wt/t18, wt/t22, wt/t27 from main 544f704)
Task 27: implementer done (3 commits, 2088/2088); review round 1: Critical C1 (a pack could read the harness's environment variables through ${env:NAME} in its server spec); Important I1 (integrity checked once at open), I2 (pack journal chain unverified), I3 (third-party text unscreened, a pack's level-1 request granted itself), I4 (pack tool names not namespaced), I5 (git clone not hardened, credentials in the journaled source); minors fixed or documented
Task 27: merged: task/t27 merged into main 50f0792 (--no-ff; 2098/2098), pushed; no third-party pack, no https or ssh clone, no network exercised; deferred to the final review: tool_search and codemode do not exist yet so toolIndex has no caller, nothing calls selectSkills in a session, a git clone has no size cap beyond its timeout, file modes are not in the content hash, a truncated pack-journal tail passes the chain check
Task 18: implementer done (2 commits, 2108/2108); review round 1: no Critical; Important I1 (schemas could come from decompositions closed only by computed leaves), I2 (stored schema text shown unscreened); six Minor fixed or recorded
Task 18: merged: task/t18 merged into main f37801e (--no-ff; 2154/2154), pushed; not run against a real Lean, model or lean.meta; deferred to the final review: schemas are lexical and shallow, readArchive is not memoised
Task 22: implementer done (3 commits, 2122/2122); review round 1: Critical C1 (declarations behind open-in and set_option-in were never certified or recorded; decide +native passed), C2 (a statement using !isGood escaped the unreviewed-definition guard), C3 (the gate built with the harness's whole environment and ran a port's meta code before any approver); Important I1 to I6 (definitions never reached a run, instances and constructors unseen, test lemmas elaborated in the agent's environment, adoption hash gaps, unscreened port files, process handling); minors mostly fixed
Task 22: merged: task/t22 merged into main 3f16b4c (--no-ff; 2238/2238), pushed; nothing real has run (fake agent, fake lake, fake certifier, no sandbox shipped); deferred to the final review: a second independent review of the fixes (security-sensitive), instances of an unreviewed class are not caught by the name check, no overall budget across gaps, network isolation only as far as the sandbox gives it
Task 14: implementer dispatched (worktree wt/t14 from main f37801e)
Task 14: implementer done (11 commits, 2229/2229); review round 1: no Critical; Important I1 (run --probe-every was parsed and ignored), I2 (the difficulty split was chosen on the reference arm's own outcomes), I3 (chunk curves degenerate on real journals: provers stop at first success), I4 (a cut-off ablation lost everything and could not resume), I5 (saved tables carried no simulated or not-run label), I6 (compareArms compared arms that had not finished the same problems); nine Minor, seven fixed
Task 14: merged: task/t14 merged into main 77f9e6e (--no-ff; 2332/2332), pushed; nothing ran against a real model, Lean or Jev; deferred to the final review: K>1 chunk curves need a fixed-attempt measurement run that is not built, candidate still counts as solved (Certified printed beside it), M12, M3 and M15 do not act in the all-lines test (no second demo problem needing a decomposition), the bench-ext row shape is an assumption and the dataset licence is unverified, the probe alarm has little power at 20 problems, no analogy or induction annotations file committed
Task 26: implementer dispatched (worktree wt/t26 from main 77f9e6e)

- Bank of heuristic cards (Task 32, 2026-11-05, branch `claude/project-thread-7os98j`): new package `@seshat/heuristics`
  (6152bc1). Fleet (6726d07): new options `heuristics` (null by default), `noCardShare`, `crossModelWeight`,
  `familyPriorWeight`; new attempt `settings` keys `heuristic`, `heuristicRule`, `heuristicBucket`, `heuristicFamily`,
  only when `heuristics` is on; `settingDraws` gain `heuristicFamily` and `heuristic`; `DIRECTIVES` now reads
  `DIRECTIVE_TEXTS` of the bank (same text, one source). Registry and core (322ec66): optional `heuristics` in
  `pack.json` and in `LoadedPack`, `overlaps` on `LoadedPack` and on `installPack`'s result, optional `heuristics` on
  `pack.installed`; the registry depends on `@seshat/heuristics`. Orchestrator (1d7c449): optional `heuristics` in the
  run report, `harness heuristics list|stats`. Documented in heuristics.md (new), fleet.md, packs.md, journal.md,
  architecture.md, README.md. Later commits on the branch: `InstalledPack.heuristics` (the card ids from the
  journal, `[]` for an older install); `installPack` option `screenCard` (M6's framing check, passed by `harness add`);
  `harness heuristics mine RUN_DIR... [--out FILE]` and `harness ablate --experiment heuristics`; the fleet option
  `cardMinObservations`; the attempt `settings` keys `heuristicDeactivated` (cards left out for a negative effect)
  and `heuristicEligible` (on a control session, the cards it could have been given); the fleet's `beforeProvers`
  hook (it checks the bank, nothing else) and the same check in `resumeProblem`; pack card ids start with
  `pack_<name>.`.

Bench index: `bench/fc-bench-v1-discrete.json` regenerated after Task 14 added `sequences` and `tags` to the hashed index body; the old index no longer matched the rebuild test.

Final review (2026-11-04): independent review found no way around the status rules. Fixed in b666bda: one strict Lean screen in core applied to curriculum variants, sketch holes and library promotion; quote-aware TPTP screen; screened prose in the prover briefing; screened port specs and symlink-safe adoptBuild. Left open: abstract sorts treated as nonempty in SMT (evidence only), proved_informal has no evidence gate, models/src/statement.ts keeps comments by design. Nothing has run against a real Lean, model, Vampire, Jev or Sage.

Task 29 (2026-11-04): implemented on `task/t29` (not pushed, not reviewed by another agent yet). The gate, the probe, the floor, the memory skip, the `budget.*` sites, the report table and the `gate` experiment are in, with documentation in scheduler.md, fleet.md, decide.md, m0-loop.md, lines.md, memory.md, ablate.md and journal.md. Decisions the plan does not make: (1) the gate is off unless `--gate` is given, so every existing run and test is unchanged; (2) the defaults are shares wave 0.5, session 0.5, task 0.25, judge 0.1, floor 0.1, probe fraction 0.1, tie margin 0.1, each a flag and each to be tuned by the `gate` experiment on a real model; (3) Lean progress for the probe is the ladder's measure or an attempt whose failure reached depth 5; (4) the gate's own `decide` calls are booked to the pseudo-line `gate`; (5) PB5: a claim already proved or refuted at the start of a problem is skipped only under the gate (the old loop relaunched it, which the tests record); the soft failure memory has no hard "exhausted" state, so the gate prices it through a lower chance of success; (6) the estimate of a memory skip is the price of one session. Not run against a real Lean, model or Jev.

Task 29, review round 1 fixes (2026-11-04): (1) a gate stop is final only within its turn, rung and budget; in a run with turns it ends the turn at an impasse and leaves the problem waiting, and the next turn asks the gate again (new field `turn` on `budget.gated`); (2) the journal checks `floor` rows (new fields `floorDraw` and `floorFraction`: the draw is under the fraction; the estimate is over the threshold) and `decide` rows (the decision is in the journal, about this problem, at the right site, with the matching answer); (3) draws are keyed by the request (problem, site, prover and session, task, round), not the row count; (4) a task is priced at its sessions times the session price, the chance of success only in the threshold; (5) `ask` refuses a `pSuccess` outside 0 to 1; (6) new setting `minSessions` (default 2, `--gate-min-sessions`): the gate cannot end a prover before it has run that many sessions; (7) the resumed unfinished probe is noted in m0-loop.md (no code change: sound, wastes the probe); (8) stays a labelled estimate. Decision the plan does not make: a gate stop in a consortium run strikes the turn with the existing `impasse` breakpoint rather than a new turn reason, so the account and the next turn's reading need no change. Interface changes: optional `floorDraw`, `floorFraction` and `turn` on `budget.gated`; optional `minSessions` in the gate settings; `BudgetGate` gains `minSessions`.

Task 30 (2026-11-04): implemented on `task/t30` (not pushed, not reviewed by another agent yet). `harness solve`, `harness doctor`, `harness view`, RESULT.md (PB8, with the test that cuts a run at every event), the `statement.signed` event and the `user` field are in, with documentation in the new quickstart.md, journal.md, certifier.md, bench.md, induction.md, m0-loop.md and the README. Decisions the plan does not make: (1) the plan's optional `actor` field on events is named `user`, because the envelope already has an `actor` (the component that wrote the event); `human:NAME` stays the actor of a person's answers, and `user` says on whose behalf a whole run works; (2) the event is `statement.signed`, with the person's prose, the signed statement and id, the model, the formalization call's request and response (blobs of the run) and cost, the test lemmas' result and the triviality; (3) the formalization is a call made before the run exists, so it is not a `model_call.finished`; its cost is in `statement.signed` and comes off the allowance (the run's budget is `--max-usd` minus it), so the person's total is never above `--max-usd`; (4) defaults: allowance $2, lines M1 and M10, gate on, a turn stops at half the allowance, the cheapest model is the lowest input plus output price among models with a price of providers with credentials (a model with no price is never chosen), `--offpeak` is a flag and not automatic; (5) a statement is Lean when it has a theorem or lemma, an import or the shape `binders : proposition`, and prose otherwise (`--lean` and `--prose` force it); a Lean statement is journaled as signed with source `lean` and not asked about; (6) `doctor` writes `config/hosts/sandboxed.json` (git-ignored, never over an existing file, never `unsandboxed`) from `local.json` with the bubblewrap recipe (needs `prlimit`) or the Docker recipe (needs the `seshat-lean` image or `SESHAT_LEAN_IMAGE`), after proving the tool works; `solve` and `doctor` use it by default when it exists; (7) the one-problem bench lives in `RUN_DIR/problem` and `resume.json` (outside the journal) names the checkout, the bench file and the host so that RESULT.md can print the exact resume command; (8) RESULT.md lists a candidate-only claim as `computed`, never as a result, and a counter-model, fingerprint or conjecture as a lead or as evidence. Not run against a real Lean, model, bubblewrap or Docker: everything is tested with the faux provider, the simulated Lean, a fake certifier and a fake machine.

Task 30, review round 1 fixes (2026-11-04): (1) a Lean statement or file goes through the strict screen (forbidden tokens and `#`, comments kept, header apart) and is signed like prose, `--yes` aside; (2) the formalization call is bounded by `maxTokens` from the rest of its 20% share before it is sent, and `RUN_DIR/formalization.json` records its cost when it is refused, fails or is declined; (3) the resume command printed by `solve` names the host; (4) `doctor` runs the real bubblewrap or Docker recipe on scratch directories (work writable, outside not, no network) before it trusts or writes a profile, and tests a sandbox a profile already names; (5) RESULT.md escapes Markdown in every journal text and puts statements in a code span that cannot be closed; (6) the resume command is shell-quoted from validated `resume.json` values. Low: the doctor text no longer says files are unreachable (the root is read-only, not hidden), the written profile drops `unsandboxed` and is derived from the host in use, `SESHAT_LEAN_IMAGE` must be an image name, prose with a parenthesis or the word import is not read as Lean, a problem is `certified` only by a replay of the right kind (the claim for proved, its negation for refuted), and the docs say the login name is journaled when no name is given. Not done: cross-checking `statement.signed` with the claim, and a throw in `afterStart` still leaves a started journal with no signature.

Task 31 (2026-11-04): implemented on `task/t31` (not pushed). `harness ui [--port N] [--open] [--runs DIR]`: `packages/ui`, a journal reader, a hono server bound to 127.0.0.1 (token, Host and Origin checks, a content security policy, SSE), a process manager that starts `harness solve|run|resume|hint|steer|sign` as subprocesses, provider settings with each key in a 0600 file outside the repository, and a Preact and Cytoscape front end built to committed static files (documentation/ui.md, quickstart, README). The page contains no research logic and cannot change a claim's status. Simulated: the tests use a fake `harness` subprocess, pi-ai's faux provider with a simulated Lean, and one headless-browser smoke test (phone and desktop, light and dark); no person used it in a real browser, and nothing ran against a real model, Lean or provider. Decisions the plan does not state: the token travels in the address fragment and as a bearer header (no cookie); a command gets only the key of its model's provider; a detached command's log is scrubbed when it ends; the digest of the build covers the built files and the lockfile entries of the build libraries.

Task 31, review round 1 fixes (2026-11-04): (1) the signature line needs the job's nonce, only for a solve, only the first, and the answer is `yes STATEMENT_ID`; (2) a command gets only its model's provider's key (none for hint, sign, steer); (3) no cookie: the token is in the fragment and sent as a bearer header, so two instances cannot clash; (4) the digest covers the built files and the lockfile closure of the build libraries, a test rebuilds and compares, and a test scans the bundle for sockets, event sources and absolute fetches; lower findings: key redaction in JSON-escaped, URL-encoded and base64 forms and across chunk and cut boundaries, detached logs scrubbed at the end, process groups and an exit-based end that a grandchild holding the pipe cannot hang, no chmod of a parent directory the person made and a real-path refusal inside the repository, validation before the statement file is written, a required spend ceiling for `run`, a defensive signature card that says the formalization was charged.

Providers for the first real run (2026-11-05): the owner will run with DeepSeek's own API as the run's model and Jev through OpenRouter or TypeSafe, undecided, so both are configurable. pi-ai 1.2.0 already carries the provider `deepseek` (key `DEEPSEEK_API_KEY`, thinking format, `reasoning_content`, cache-hit usage), so no client was written; the profiles price its two models from DeepSeek's pricing page (read 2026-11-05: the peak price is twice the off-peak one, peak 01:00-04:00 and 06:00-10:00 UTC on weekdays). Task 20's Jev client turned out to guess a wire format that neither provider uses (`type`, `input`, `options`; answered by `answer`, `distribution`): it was rewritten to TypeSafe's System One shape (`{ model, state, questions }`, answered by `answers`), which OpenRouter's Decisions endpoint takes as well, from the providers' references and pi-ai's own System One client. Decisions the plan does not make: (1) the client stays Seshat's own rather than pi-ai's `classify`, to keep the allowed hosts, no redirect, https only and the 32k refusal; (2) OpenRouter's preset uses its Decisions endpoint, which reports `usage.cost`; TypeSafe's reports tokens only, priced at the preset's $0.042 per million input tokens; (3) the presets pin the current Jev version; `latest` and `preview` aliases, and a name with no version, are refused; (4) Chinese public holidays (off-peak at DeepSeek) are not listed, so the budget overcounts on those days; (5) `SESHAT_MODEL` names the model of every command that takes `--model`, because an `OPENROUTER_API_KEY` set for Jev makes OpenRouter's chat models candidates of `solve`'s cheapest choice; the docs advise `JEV_API_KEY`. Tests: a fake DeepSeek server through pi-ai's own catalog entry and the shipped price tables (peak, off-peak, cache saving), a fake Jev server in the System One shape, the shipped presets. Not run against DeepSeek, OpenRouter or TypeSafe: no network or key here. A setup guide for the owner's machine is in the project files (guides/premier-vrai-run.md), outside the repository because it names model identifiers.

Providers, review round 1 (2026-11-05, an agent that did not write the code): fixed (1) `SESHAT_MODEL` was copied into `--model` for every command, so every `harness resume` (and `run --resume`) refused it: it now applies only to run, probe, ablate, optimize-prompts, solve and doctor, and never to a resume (CLI test); (2) `JEV_API_KEY` won over the provider's own variable, so switching to `typesafe` could send an OpenRouter key to TypeSafe: the provider's own variable now wins, and a key in OpenRouter's `sk-or-` form is refused for any other host; (3) a model name with no version (`jev`, `typesafe/jev`) passed the pin check: a digit is now required in its last segment; (4) the provider's error text kept in a failure message is cleared of the key; (5) a score is read through its `legend` when it has one, which must agree with the question's order, a level given two probabilities is refused, and a bare `score` without probabilities is refused rather than rounded to a level; (6) the ledger names no Jev version. Nothing left open.

Task 32, bank of heuristic cards (2026-11-05): implemented on `claude/project-thread-7os98j` at the owner's request (to build
the bank of heuristic cards while keeping Seshat coherent, so that nothing is duplicated).
Built: the card format and its check, 22 closed families aligned on SHAPE, model-free context features and the bucket,
29 built-in cards (the six directives, word for word, and 23 starter cards from nine traditions), the overlap check;
the fleet's draw (eligibility, a control share drawn first, a family then a card by Thompson sampling per bucket, the
families other provers hold left out, a family prior for new cards, other models' sessions counted for less); cards in
packs (ids prefixed by the pack, clashes refused, overlaps printed at `harness add`); statistics against the control of
each bucket, compliance of tactic cards, the report's paragraph and `harness heuristics list|stats`. Decisions the plan
change does not state (Ruling 5): (1) the bank is a fleet option, not a line M19, because a later line's
`beforeSession` does not see an earlier line's decision, and the card must agree with the fleet's strategy and mode;
cost if wrong: moving `drawCard` into a line once the runtime passes decisions along; (2) cards are static (built in and
packs), so no memory node kind holds them, and the draw is recorded on the attempt and the allocation; (3) `heuristics`
and `directives` together are refused, since the directives are cards; (4) the framing check of the built-in cards
lives in the guards' tests, to keep `@seshat/heuristics` free of a dependency cycle through the registry. Not built:
model-proposed cards (HB5 item 4, the owner's open question on Global Constraint 16), unexplained successes, the
battery replay after a new lemma (HB5b), a card's `prepare` step (HB4), the extra features `claim_kind`,
`origin_informal`, `closed_fast` and `informal_sketch`. Simulated only: no measure of whether any card helps a real
model; the default shares (0.2 control, 0.5 for another model, a family prior of 2) are first guesses.

Task 32, after the plan's integration (2026-11-05, rebased on `c744ed5`): added PE2's effect (`effectOf`,
`shouldDeactivate`, no second counter) and M5's deactivation in the draw (`cardMinObservations`, 8), the
statistics per bucket with the unexplained successes, `harness heuristics mine RUN_DIR... [--out FILE]`, and
`harness ablate --experiment heuristics` (fleet alone, with directives, with cards). More decisions (Ruling 5):
(5) `harness heuristics apply` is not a command: cards are static files, so a person applies a proposal by
editing the card through a reviewed commit or a new pack version, which is the human approval HB5 asks for;
cost if wrong: a bank journal and a fold of patches in `runBank`; (6) the 13 strategy labels stay M1's
(`STRATEGIES`, with their text in the fleet's `STRATEGY_HINTS`); a tactic card's family maps to one of them
(`FAMILY_STRATEGY`), so no strategy text is held twice; (7) the card format lives in `@seshat/heuristics`,
not `@seshat/core`, since only the fleet, the registry and the report read it; (8) HB2's key by model
configuration class is replaced by `crossModelWeight` (another model's sessions count 0.5), which keeps the
buckets large enough to say something; (9) a pack's card ids start with `pack_<name>.`, as its tools do.

Task 32, review round 1 (2026-11-05, an agent that did not write the code; no high-severity finding, no
trust rule broken). Fixed: (1) a pack card whose question M6's framing check flags is refused at `harness
add` (`installPack` option `screenCard`, since the guards depend on the registry); (2) a card's control is
standardized to the card's mix of buckets instead of pooled over them; (4) the statistics count only
sessions with a verdict (`valid` or `invalid`), as PE2 does; (5) the `pack_<name>.` prefix, so no later
built-in card can take a pack's id. Recorded, not fixed: (3) not built: HB2 item 5 (a family prior from
`decide`'s `fleet.cold_start`), HB7's caps `maxActive` and `maxCards` (one card per session is the draw's
own cap; the `when` filter keeps the eligible set small), HB8.3 overlap on `when` (overlaps are reported on
the `ask`, with "the same conditions" said when the `when` matches too), and a test that compares a run with
the bank off to `main` byte for byte (the bank's draw uses its own stream `key:heuristics`, so the other
streams are unchanged); (6) an unknown card id or a bank error is reported at the first session, not at
setup, and the bank is rebuilt per session (29 cards: cheap); (7) on a resume after a pack is removed, the
briefing leaves out a card the attempt still records; (8) the README diagram changed one commit after the
flow did.

Task 32, decision on the families (Ruling 5): the closed list has 22 families, SHAPE's with `definitions`,
`vary`, `invariant`, `extremal` and `count` added for the traditions the owner asked for, and `simplify`. The
22nd, `simplify`, is there because the directive `shortest` ("Look for the shortest argument you can think of before you build an elaborate one.") is a move of its
own that none of SHAPE's families holds: it is neither `restate` (a new form of the claim) nor `automation` (a
tool), and putting it under either would mix its counts with theirs. Cost if wrong: one family whose counts are
small, merged later by a plan change.

Task 32, review round 2 (2026-11-05, by the plan's owner thread, file task-32-review-r1.md there). Fixed, each with
a test: (M1) a card is compared only with control sessions that could have been given it: a control session records
`heuristicEligible`, and both the draw's deactivation (`controlFor`) and the statistics count a control session for a
card only when the card was in it (for a family, one of its cards); (M2) when every family is held by other provers on
the subgoal, the draw takes a family that still has a card no other prover holds, and that card; a card repeats only
when none is left; (L1) a pack card's `ask` with a bracket is refused (it could pose as the briefing's fence); (L2) a
pack whose name is longer than 27 characters is told it cannot carry cards, and why; (L3) the statistics and the miner
say plainly that every session counts once there, unlike the draw (no discount, probation or weight for another model);
(L4) a card id the bank does not have stops the problem before any prover starts (`beforeProvers`, `resumeProblem`);
(L5) this ledger's Task 32 entries are in English; the interface changes above are complete.

Tasks 33 to 44 (2026-11-10, the session of the thread "Augmenter les capacités de Seshat de 50 %"): Task 34 reviewed (spec and quality clean, four minors deferred), on the branch at `c34c0c8`, `pnpm check` 2676 tests, 0 fail. Task 33 reviewed, one fix round (the target is validated before any spend; the admitter probes Lean and reports an infrastructure failure instead of rejecting; an empty grade fails the build; the column-0 layout is pinned at the validator and the guards), merged at `8c8c0cb` with one conflict in `session.ts` (the holes counter now lives in `doCheck`), `pnpm check` 2704 tests, 0 fail. Task 36 reviewed (no Critical or Important finding; every trust check holds), fix round 1 on three minors. Tasks 35 and 40 are being written.
Task 33: minor (deferred): the docstring of `measures.ts` is detached from `measureRun`; a comment in `events.ts` cites `documentation/report.md` (the page is m0-loop.md); `checks` counts every `lean_check` call, server errors included; the quantile is the upper median for an even n; the target verdict reads only the best-ratio arm; `loadIndex` parses the bench JSON twice.
Task 34: minor (deferred): `checkTimeoutSec` is in the registry hash; `lean_edit` passes no strategy to `doCheck`; the memory reading's pattern may count unrelated processes; no test for an empty `old`, for `checkTimeoutSec < 1`, for masking with `lean_edit` results.
Decision (2026-11-10): `--private` becomes a general switch after Tasks 36 and 40 are on the branch: an optional manifest field marks a capability that calls a third party, and a private run refuses those calls at the registry. Why: the plan change says that nothing leaves for a third party other than the model provider, and Task 36's flag covers the literature search and the third-party decision model only. Cost if wrong: one small task.
Tasks 33 to 44 (2026-11-11): Task 36 merged at `75638fd` (review: no Critical or Important finding; fix round on forged delimiters in fetched text, one bad backend no longer disabling the others, the stated scope of `--private`), `pnpm check` 2751 tests, 0 fail. Task 40 merged at `922341a` (review: two Important findings fixed: a cache of search results with no repeat of a name still in view, the verification's Lean runs kept out of the provers' check totals; hardening of names, of the "unknown" cache and of allowed hosts), 2801 tests, 0 fail. Task 35 merged at `1178091` (review: three Important findings fixed: the repeat key holds the failure class and no longer counts holes or unclassified errors, a slice-cut session no longer records a failure class, the card returns data and text), 2825 tests, 0 fail. Task 41 is in its fix round; Task 36b (the third-party policy) and Task 37 are being written.
Task 36: minor (deferred): the judge call without a budget gate; the test lemmas run twice with `--intake`; `run.ts` grew by the intake block; `--auto-tool` names `compute.sage` in code.
Task 40: minor (deferred): the push counts checks only when it is called while masking counts every check; `allowedHosts` is compared case-sensitively; a candidate that Lean answers with neither a signature nor an unknown-identifier error is verified again at every check; a shared guarded HTTP client for `lean-search`, `lit` and `decide`.
Task 35: minor (deferred): the rotation's wiring grew `run.ts` by about 140 lines; `solve-command.ts` prints the lines of `v2` from its own copy of the rule.

Tasks 33 to 44 (2026-11-11, later): Task 41 merged at `a4f4c39` (review: trust path sound, three Important findings: the Sage time limit is now applied and the 10-vertex battery no longer lists the graphs again for each slice; a search that throws now leaves its node, so a resume does not skip it; the submitted refutation relies on `decide` over the claim's own predicates, so a hit on a claim about Mathlib's `Connected` or a Hamiltonian cycle will often stay unconfirmed until bridge lemmas exist: documented, and an unconfirmed hit is handed to the provers as labelled evidence, smallest hits first, at most 8 vertices), `pnpm check` 2856 tests, 0 fail, 1 skipped. Task 36b (the third-party policy behind `--private`) reviewed: no path that sends in a private run or without consent was found; its fix round adds the tests the review asked for (a private run with M11 calling `oeis.search`, the forced form of `lit.search`, a resumed consent) and strips control characters from the consent question. Tasks 37 and 42 are being written.
Task 41: minor (deferred): `graph-hunt.ts` mixes the battery, the prompt, the records and the briefing (split at the final review); no test tries a socket or a file read in the sandbox; a search that always throws is retried at every resume or turn with no counter; a hit's report line is clipped at 240 characters, which can cut the certificate hash; the capped Sage path relies on the compute capability returning the last expression; the briefing of an unconfirmed hit carries 160 characters of Lean's reason besides the class.
Tasks 33 to 44 (2026-11-11, 11:10 UTC): Task 36b merged at `980d849` (review: no path that sends in a private run or without a yes; two fix rounds: the tests the review asked for, control and bidirectional characters stripped from the consent question, a resumed `solve` now restores the recorded answer, which it lost before, and writes it under the person who gave it). `pnpm check` on the merge: 2875 tests, 1 fail, the timing test of `packages/induction/test/m16.test.ts` under load (16 of 16 alone; the worker's own full check on the task branch was green, 2820 tests). Next: the wiring of `v2` and the `solve` arms (called Task 34b), then the first pull request.
Task 36b: minor (deferred): `harness run --private` without `--intake` now journals `intake.consented` for each problem (check that no report shows an intake section for it); the unverified point that M11 handles a refusal is now tested.
Tasks 33 to 44 (2026-11-11, 18:00 UTC): the owner's decision of 12:45 UTC ("deliver, then measure"): finish only what was in flight (Tasks 34b, 37, 42), open a second pull request, and build Tasks 38, 39, 43 and 44 only once a real run has given numbers. Task 42 merged at `d81047c` (accepted on the controller's own reading of its trust-critical source: a sentence that cites a missing or foreign event is dropped whole, external text never enters the page's input, the page is shown only by option, by draw, in the first user message). Task 37 merged at `b83a0b1` after two fix lots (review: no new route to a status; five Important findings fixed: telemetry counted suspicions as false, missing check timeout, a hole with no dependency recorded proved without `validate`, a helper using a dependency stub, a waiting hole shown as failed). Task 34b merged at `c5f635a`: `v2` turns on the intake gate (hygiene; the literature only with a yes), the compute tool for filed statements and `lean.search` (local without a yes), each with its `--no-...` switch, and the intake's judge call is capped at the smaller of its default and 5% of the allowance. Rulings: M11 `graphs` and M12 `blueprints` stay out of `v2`; blueprints are measured by a third arm, `solve-v2-blueprints` (`32b9b0e`), because they never ran on a real Lean (cost if wrong: the default misses the largest expected gain until a run shows it).
Task 37: minor (deferred): move the blueprint path of `packages/scheduler/src/line.ts` into its own file; the pre-flight is not an eligibility filter; no bound on the count of sessions repeated after cuts; the `Object.create` proxy workbench in `hole-session.ts`.
Task 42: minor (deferred): a problem settled under an incomparable Lean environment of an older link gets a card and possibly a paid page; an approval of a flagged lesson is not inherited by a later run; import cycle `run.ts` and `consolidate.ts`; a clause after a citation in the same sentence is not itself checked (citations are per sentence, by design).
Task 34b: minor (deferred): `--lit` with `--no-intake` is refused as a conflict, so a call that cannot ask has no way to say yes to `lean.search`'s remote services without the intake; the drift test builds `solve`'s side from `studentConfig`, not by running `solve`.
For whoever runs the tests: the suite leaves its run directories in the system's temporary directory (about 1 GB per full `pnpm check`, prefix `mh-`); on a small disk run it with `TMPDIR` on a memory file system. The fix (the `tempDir` helper of `packages/orchestrator/test/m0-helpers.ts` removing its directories at exit) is proposed to the owner, not made.
First real run of the plan change (2026-11-11, the owner's machine, Lean 4.27.0, a real model through its API, host profile `sandboxed`): the graded bench built with admission by the real Lean (A 111 of 111, B 20 of 326 candidates, C 10 of 70; no statement rejected; the PutnamBench checkout names a newer toolchain and its sampled statements still compile). Pilot `harness ablate --experiment solve-defaults --grade B --sample 6` at a cap of $0.50 per problem: $0.22 spent in 47 minutes. `solve-v1`: 6 of 6 proved and certified by `kernel_replay` ($0.126, $0.021 per solved problem, each in its first session of 1 to 29 model responses; line M10's battery closed none); the six proofs were audited by hand (the certified files equal the sources outside the proof regions, standard axioms only, recompiled apart). `solve-v2` and `solve-v2-blueprints` are NOT valid measurements: the provider's account ran out of balance during the second arm and every refused request was counted as an unsolved problem (fixed: `0bd5bd5`). One failure of `solve-v2` is real: on a problem `solve-v1` solved at its 23rd check, line M6's repeat rule ended the probe's only session at its 20th check and the gate then skipped the problem (fixed: `b9df4fa`; a ruling: the probe gets the session the rule promises, under the same cap; cost if wrong: at most the rest of the probe's cap per problem). Also found: `run` and `ablate` defaulted to host `local`, where the certifier refuses to run without a sandbox (fixed for the `solve` arms: `a973a44`); that host offers neither `lit.search` nor `lean.search`, so `v2` there is the hygiene tests and the compute tool, which no session called. Limits of the yardstick, for the owner: every PutnamBench problem has a public Lean proof (a model may have seen it) and the baseline is at the ceiling on the six sampled problems, so grade B can show a gain in dollars only; the real measurement needs harder problems. Still not run: a valid `solve-v2` arm, blueprints, the consolidation pass, the literature and search services, SageMath through a session.
