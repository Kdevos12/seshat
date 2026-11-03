# The library builder

The library builder is an option that is off by default and outside the ablations (plan change LC4 and LC5 of
[plan-change-lean-libraries.md](../plans/plan-change-lean-libraries.md); `@seshat/library-builder`). When a run keeps meeting a
concept that neither Mathlib nor the harness library has, or a package has no tag for the pinned toolchain, a coding agent
can be asked to write the Lean for it. The agent is an external program, chosen in a config file. **Seshat decides whether
what it wrote is kept, never the agent**, and what it wrote enters the environment only between runs and without any claim status.

Nothing here has run against a real Lean, a real coding agent or a real Lake ([Not run](#not-run)): the gate and the builder
are tested with a fake agent script, a fake `lake` and a fake certifier.

## The interface

```ts
interface LibraryBuilder {
  readonly id: string;
  build(spec: LibrarySpec, options: { budget; timeoutSec; signal? }): Promise<LibraryBuildResult>;
}
```

| Builder | Does |
|---|---|
| `none` (default) | Builds nothing. The result is `skipped`, and the gap is only recorded. |
| `coding-agent` | Runs an external CLI agent in a clone of the environment's project, then applies the gate below. |

A **spec** (`LibrarySpec`, written by a person or by a later spec writer, never by the agent) has a job, a domain, a reason,
the imports the new files may use, the items to formalize (an informal statement, the expected name and `def` or `theorem`),
and the **test lemmas**: statements in Lean that the agent must prove under exactly those names. `fill` formalizes the items
under `lean/SeshatLib/<Domain>/`; `port` brings a package that has no tag for the pinned toolchain under `lean/ports/<Package>/`
(it names the git address, the rev and the libraries to build). A definition with no test lemma that states something about
it makes the spec invalid. `harness library build SPEC.json` reads it.

**Who wrote the spec.** A spec has an `author`. `human:NAME` is trusted as written (`harness library build` marks the file's spec `human:cli`:
whoever runs the command answers for it). Any other author's spec is unverified text on its way into a prompt and into Lean (Global Constraint 16), so
`specProblems` runs it through the strict screen first: the reason and each informal statement must pass `screenProse` (one line, no code, link or
instruction, at most 300 and 400 characters), and each test lemma's statement must pass the validator's scanner and token list. A spec that does not
is invalid, and the agent is not started.

## What runs

1. The project (`repo`, a git repository whose tree is a Lake project, with the Lean files under `libRoot`, default `lean`)
   is cloned (`git clone --local --no-hardlinks`, then checked out at the base commit). It is a clone, not a `git worktree`:
   a worktree shares the repository's git directory, and an agent that can write there can plant hooks that run in the harness's
   next `git`. The agent gets a home directory of its own with nothing in it.
2. The agent runs non-interactively with the prompt on standard input, in a process group that is killed at the time limit or
   on abort. Its command is the settings' `command` (an argv, or a string split on whitespace) or the default for its name:

   | `agent` | Default command | Note |
   |---|---|---|
   | `claude-code` | `claude -p --output-format stream-json --verbose [--model M] [--max-budget-usd N]` | |
   | `codex` | `codex exec [--model M]` | |
   | `opencode` | `opencode run [--model M]` | |
   | `agy` | `agy --output-format stream-json [--model M]` | |
   | `pi` | `pi -p [--model M]` | |

   A flag whose value is not set (`{model}`, `{budget_usd}`) is left out with its value. The defaults are the plan's names and the
   flags that those programs documented when this was written: **check each against the installed release** before the first
   real build. `sandbox` is a command put in front of the agent (`bwrap ...`); without one the builder is not made unless
   the settings say `unsandboxed: true`, the rule of the certifier ([certifier.md](certifier.md#where-untrusted-code-runs)).
3. **The environment of the agent is `PATH`, a `HOME` and `TMPDIR` of its own, and the variables the settings' `env` names, and nothing
   else.** The harness's own keys (the model providers', `JEV_API_KEY`, `LEAN_SERVER_API_KEY`) never reach it unless a person copies one
   into `env`. The config writes `${env:NAME}`, which fails when `NAME` is not set. The journal keeps the names of the keys, not
   their values.
4. The agent's exit code is not a verdict. What it left is judged by the files.

## The gate

All of it is Seshat's, in order; the first rule that fails ends the build, and each check is journaled.

| Rule | Checks |
|---|---|
| `diff` | The changes are read from the files in the agent's directory against the tree it started from, not from the clone's git directory (which the agent can rewrite). Only regular files are **added**, all under `<libRoot>/SeshatLib/<Domain>/` (or the ported package's directory), of a type the job allows (`.lean`; a port may add `lakefile.toml`, `lean-toolchain`, `lake-manifest.json`, `LICENSE`, `README.md`), no hidden segment, not executable, at most 40 files and 512 KiB each. A modified or deleted file, a link, a path outside the directory, or nothing at all is a rejection. |
| `content` | Valid UTF-8; the validator's own token screen ([validator.md](validator.md)): no `sorry`, `admit`, `axiom`, `native_decide`, `unsafe`; in a `fill` no `elab`, `macro`, `syntax`, `notation`, `#eval`, no `Lean` or `Meta` names, no strings or `«»` names; imports only from the spec's list and the agent's own module. A `port` may contain code that runs while Lean elaborates, but then the result is marked `needsApproval` and `adoptBuild` lands it only for a named person. |
| `spec` | Every expected item exists; every test lemma exists once, by name; at most 100 new theorems. |
| `build` | A **fresh** checkout of the base commit plus these files (the gate makes its own, from the bytes it read once) builds with `lake build <modules>` after the plan's `prepare` commands (`lake exe cache get`). The agent's own build products are not in it. A command that exits non-zero is a rejection; one that did not run to its end says nothing about the files and makes the build `failed`. |
| `build_output` | The build printed no `declaration uses 'sorry'`. |
| `certify` | **Every new theorem** goes through the certifier ([certifier.md](certifier.md)), with the axioms `propext`, `Classical.choice`, `Quot.sound`. The reference of an ordinary theorem is the file with its proof replaced by `sorry`. The reference of a **test lemma** is the file with that theorem replaced by the spec's statement and `sorry`, so the certifier compares the agent's theorem with a statement the agent did not write, as terms: a test lemma that was weakened is rejected. A theorem whose statement cannot be separated from its proof (no top-level `:=`) is rejected. A certifier that gives no verdict makes the build `failed`, not rejected. |

The result is `accepted`, `rejected`, `failed` (the agent did not run to its end, timed out or was aborted, or a rule could not be decided)
or `skipped` (`none`). `harness library build` exits 0 for the first and last and 1 for the others.

The certifier is made for the gate's fresh checkout (`certifierFor(projectDir)`), because a new file imports its sibling modules, which
exist only there. In `harness library build` that is a `LakeCertifier` with the config's `certifier` settings, with the same sandbox rule.

## What is journaled

`recordBuild` writes one `library_build` node ([memory.md](memory.md#nodes)) with: the agent, the model, the budget and time limit, the argv, the
keys of the agent's environment, the base commit, the prompt and the diff (as blobs, by hash), the end of the agent's output, the spec, every
gate check with its detail, the files with their hashes, the theorems, the definitions and the verdict. An accepted build also records each
new definition as a `lean_definition` node, `unreviewed` ([below](#review-status-of-definitions)). Gaps are `library_gap` nodes. A build
never creates a claim and never changes a claim's status: the only things that change a status are `validate` and the certifier
([trust.md](trust.md)). `harness library build` writes the record to a journal directory of its own (`--out`, default `runs/library-ID`); a run can
start on it with `--memory-from` like on any earlier journal.

## Gaps and the triggers

`GapTracker` is deterministic and uses no model. It raises a gap (once) when:

- the same `unknown identifier` or `unknown constant` appears in the failures of three distinct attempts (the threshold is an option);
- a prover asks for a lemma explicitly (`observeRequest`);
- a subgoal that looks standard, which the battery did not close, is open in two distinct problems (`observeSubgoal`; the caller decides what is standard);
- the resolver finds no tag for a package at the pinned toolchain (`observePackage`, a `port`).

`recordGap` journals it. With `none` that is all. A gap becomes a build only when a person or a spec writer supplies a spec for it
(`processGaps` asks `specFor(gap)`), and only **between runs**: `processGaps` and `adoptBuild` refuse while a run is going, since a run is pinned
to one environment hash from start to end ([lean-env.md](lean-env.md)). Nothing here is wired into a run's hooks yet: the trackers are fed by the
caller ([Not done](#not-done)).

## From a passing build to a new environment version

`adoptBuild` writes the accepted files into a checkout, adding files only (a file that exists with other content is an error). The hash of a local
package such as `lean/SeshatLib` is the hash of its files ([lean-env.md](lean-env.md#the-environment-hash)), so the next `harness lean-env resolve` of an environment that lists
it gives another hash, and a run started afterwards runs in that environment. A run that is going keeps its own. Results of earlier runs are
tied to the earlier hash and stay replayable (`--memory-from` carries verified facts only under the same hash).

## Review status of definitions

New definitions are `unreviewed` (plan change LC5). A proof may use one, because the kernel checks the proof. A **claim statement** may not:
`ensureClaim` refuses a formal statement or header that mentions an unreviewed or deprecated definition, so no line can state a conjecture about a
definition nobody checked ([memory.md](memory.md#definitions-and-their-review-status)). M3 settles a candidate lemma whose statement does as `unproved`.

- **Reviewed** needs the test lemmas proved (the gate did that) and a signature: a person (`reviewDefinition(name, {by: {kind: "human", name}})`, journaled as
  `human:NAME`) or a faithfulness check by two or more distinct checkers (`{kind: "faithfulness", checkers, verdict}`, journaled as `orchestrator`; PC9 of
  [plan-change-thinking-modes.md](../plans/plan-change-thinking-modes.md) is its other half and is not built, so nothing calls this yet). The root store does it; a view given to a line cannot.
- **Deprecated** is for a definition found wrong: `deprecateDefinition(name, {reason, envHash})`, recorded with the environment version that drops
  it. Nothing is edited in place: its text stays in the old version, results that used it replay there, and its replacement is a new definition.
- A name matches by its last component (three characters or more), outside comments and strings, so a Mathlib declaration with the same last component also blocks a statement. This fails closed, and the cost
  is a refused statement, not a wrong one.

## Config

`config/library-builder.json` selects the builder (`none` as shipped). For `coding-agent` it holds `agent` (`agent`, `command`, `model`, `env`,
`sandbox`, `unsandboxed`), `repo`, `build` (`cwd`, `libRoot`, `prepare`, `timeoutSec`), `certifier` (the `LakeCertifier` settings except `projectDir`),
`budget` and `timeoutSec`. Only the selected section is read and its `${env:NAME}` variables expanded. The model is the config's string, never
chosen by the harness.

```sh
pnpm harness library build SPEC.json [--config FILE] [--out DIR] [--adopt CHECKOUT [--approve NAME]]
pnpm harness library gaps RUN_DIR
```

Cost: published runs of this kind cost about 29 USD per PutnamBench problem and 0.46 USD per accepted folklore lemma (plan change LC4, at API rates).
Whole-domain libraries are out of budget; targeted fills and ports are not.

## Not run

- No real coding agent: the five default commands are not checked against the installed programs, and the stream-json output is not read at all (only the files count).
- No real `lake`, Lean or certifier: the gate's `build` is a fake `lake`, and the fake certifier compares statements by text where the real one compares terms.
  The real gate needs the project to be a git repository with a lakefile that requires the environment's packages and the library at `lean/SeshatLib`: that
  project is not made by `lean-env` yet (the environment's directory is generated and ignored by git), and `lean/SeshatLib` is not yet a package of any environment file.
- The fresh build starts from `lake exe cache get`; whether it serves the new modules is not known.
- The sandbox commands are the person's; none is shipped.

## Not done

- The trackers are not called from a run's hooks, and nothing turns a gap into a spec: a person writes the spec file.
- Nothing calls the faithfulness review. A person reviews, through the root store; there is no `harness` command for it yet.
- A `port` is certified theorem by theorem up to 100 theorems and refused above; a large package needs another gate (a sampled one, or Lean's own checker over the whole module).
- Bench problems whose statements mention a definition's last component would be refused as claims when that definition is unreviewed.
