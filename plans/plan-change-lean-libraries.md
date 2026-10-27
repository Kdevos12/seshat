# Plan change: Lean library environments and optional delegated library building

> Copied into the repository on 2026-10-20 from the project's shared files, with the French quotes
> translated and the model names of the cited papers left out (plan, Global Constraint 13). Task
> numbers are those of [seshat-plan.md](seshat-plan.md).

Written 2026-10-20 by the thread on Lean 4 libraries and delegation, for the implementation
thread. It amends [seshat-plan.md](seshat-plan.md). The decision
note behind it, with sources and the checks made, is
`research/bibliotheques-lean.md` (French, in the project's shared files, outside the repository). Read against main at 9e76c43;
reconcile task numbers with main as it is now.

Status: **approved by the user on 2026-10-20 at 07:37 UTC** ("Agreement given"); relayed to the implementation thread at 10:03 UTC.

Global Constraints apply unchanged: nothing trains a model; every new tool is a capability; the
whole thing is replaceable; anything needing Lean is built and tested against fixtures and marked
"not run against a real Lean yet".

## Summary

| # | Change | Task | Kind | Priority |
|---|---|---|---|---|
| LC1 | Declarative Lean environment and a resolver (`harness lean-env`) | new task "Lean environment" | infrastructure | high |
| LC2 | Library packages indexed by the premise selector and `library_search` | Tasks 9, 11 | extends lines | high |
| LC3 | Line M17 "extended environment" | new line | ablation | medium |
| LC4 | `LibraryBuilder` interface, off by default, coding agent chosen in config | new task "LibraryBuilder" | option, outside ablations | low (after LC1) |
| LC5 | Definition review status: `unreviewed` definitions cannot appear in claim statements | Task 1 follow-up, Task 9 | trust | medium (with LC4) |

## LC1: Lean environment and resolver (new task "Lean environment")

Facts checked on 2026-10-20 (raw.githubusercontent.com): the bench project
(formal-conjectures `bench-v1-lean4.27.0`) pins Lean `v4.27.0` and Mathlib `a3a10db`. LeanHammer,
Duper, CanonicalLean, LeanAPAP, PFR and FLT each have a `v4.27.0` tag; where they depend on
Mathlib, Batteries or Aesop, the tag's manifest has the bench's exact revisions. cslib, compfiles
and Foundation have no such tag.

Deliverables:

1. `lean/env/<name>.toml`: the environment as data: toolchain, the base project (the bench tag),
   and extra packages, each with `git`, `rev` (a tag or commit) and the `lean_lib`s to import.
   The current bench project is environment `base`.
2. `harness lean-env resolve <name>`: fetches each package's `lean-toolchain` and
   `lake-manifest.json` at `rev` (or, with `--find`, tries the tag `v<toolchain>`), refuses the
   environment unless every package agrees on the toolchain and on the revision of every shared
   dependency, and writes `lakefile.toml` and a lock with an **environment hash**. No network
   beyond reading those two files per package; tests run on fixture manifests.
3. `harness lean-env build <name>`: `lake exe cache get` for Mathlib, then `lake build`; reports
   time per package. `:::wait` until a Lean host exists. Whether Lake's artifact cache serves
   non-Mathlib packages from Reservoir is to be verified there.
4. The environment hash goes into each tool run's recorded version (with the checker's
   implementation and version), and a run is pinned to one environment from start to end.
5. Host profiles name the environment (`LEAN_ENV`, default `base`); Kimina and Pantograph point at
   its built project.
6. Docs: `documentation/lean-env.md`, updates to `lean.md`; README diagram: the environment and
   the resolver.

Keep the bench at v4.27.0 for now. Moving the pin (formal-conjectures main is at v4.33.1) is a new
bench version with incomparable results, and the user's call.

## LC2: indexing library packages (Tasks 9 and 11)

A package helps only if retrieval finds its lemmas, and extra declarations are distractors
(LCS-Bench measured lower pass rates with distractors). So:

1. The declarations of the environment's extra packages are exported once per environment hash
   (through `lean.meta`), and indexed with the same BM25 / symbolic selector as Mathlib.
2. Ranking order: problem-local, then `HarnessLib`/`SeshatLib`, then extra packages, then Mathlib,
   with the source shown in the briefing so the prover knows what to import.
3. The report counts proofs that use a declaration from each package.

## LC3: line M17 "extended environment"

M0 (then the best line) with environment `base` against the same line with an extended
environment (first candidate: `base` + Duper + LeanAPAP + PFR), at equal budget on the bench.
Keep the extension only if it wins. Expected: small gain on formal-conjectures, mostly on additive
combinatorics problems.

## LC4: `LibraryBuilder` (new task "LibraryBuilder"), off by default

An interface with implementations chosen in config, like any capability:

```ts
interface LibraryBuilder {
  build(spec: LibrarySpec, options: { budget; timeoutSec; signal? }): Promise<LibraryBuildResult>;
}
```

- `none` (default): gaps are only recorded.
- `coding-agent`: runs an external CLI agent non-interactively in a sandboxed git worktree of the
  environment's project. Settings: `agent` (`claude-code` | `codex` | `opencode` | `agy` | `pi`),
  `command` template (defaults: `claude -p`, `codex exec`, `opencode run`, `agy` with the prompt
  on stdin and `--output-format stream-json`; check each at install), `model`, budget, timeout,
  environment variables passed explicitly (never the harness's own keys by default).
- Jobs: `port` (bring a package with no compatible tag to the pinned toolchain) and `fill`
  (formalize a spec: informal statements, expected names, test lemmas).
- Triggers for `fill`: repeated `unknown identifier` failures for the same concept, a lemma a
  prover asks for explicitly, or a standard-looking subgoal the battery does not close.

The gate belongs to Seshat, never to the agent:

1. `lake build` passes in a fresh checkout at the pinned toolchain and Mathlib;
2. the diff only adds files under `lean/SeshatLib/<domain>/` (or the ported package);
3. every new theorem passes the certifier (no `sorry`, axioms in the allowed list);
4. every new definition comes with the test lemmas of its spec, proved (the "lemmas as unit
   tests" method of Theo, arXiv 2606.31134), and is recorded `unreviewed` (LC5);
5. provenance in the journal: agent, model, budget, prompt, diff, gate results.

A passing build produces a new environment version used from the next run on, never during a
run. Tests: a fake agent (a script that writes files) for accepted and rejected builds, each gate
rule, the command templates.

Cost note for the user: published runs cost about 29 USD per PutnamBench problem (Theo, API
rates) and 0.46 USD per accepted folklore lemma (MathlibLemma). Whole-domain libraries are out of
budget; targeted fills and ports are not.

## LC5: review status of definitions

New definitions from `fill` are `unreviewed`. A proof may use them (the kernel checks it), but a
claim statement may not, until the definition is `reviewed` (test lemmas proved, plus a human
signature or a cross-model faithfulness check, see PC9 of plan-change-thinking-modes.md). A
definition found wrong is deprecated in a new environment version, never edited in place, so
earlier results stay replayable. This is the guard against entrenching a bad definition.
