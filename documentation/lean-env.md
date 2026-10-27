# Lean environments

A Lean environment is the Lean the harness runs against, written as data: a toolchain, the project
the bench is (formal-conjectures at its tag), and extra packages. The plan asks for it
(`plans/plan-change-lean-libraries.md`, LC1) for three reasons: a library is added by naming it, not
by editing a checkout; two packages that need different Mathlib commits are refused before anything
is built, not found as a build that fails after an hour; and a run says in its journal which
environment it ran in, so that results from different environments are never mixed up.

`@seshat/lean-env` holds the environment files, the resolver, the lock and its hash, and the build.
`harness lean-env` is its command line. The environment is not run against a real Lean yet: the
resolver is tested on fixture manifests, the build with a fake `lake` ([what has not run](#what-has-not-run)).

## The environment file

`lean/env/<name>.toml` is one environment. The repository has two:

| Environment | What it is |
|---|---|
| `base` | The bench: formal-conjectures at `bench-v1-lean4.27.0`, on Lean and Mathlib v4.27.0 ([bench.md](bench.md)). A test checks that it names the bench index's repository, tag and Lean. |
| `extended` | `base` plus Duper, LeanAPAP and PFR at their `v4.27.0` tags: the first candidate of line M17. |

```toml
description = "formal-conjectures at bench-v1-lean4.27.0, on Lean and Mathlib v4.27.0."
toolchain = "leanprover/lean4:v4.27.0"

[base]                       # the bench's project: git and a rev, required
name = "formal_conjectures"  # the package's name in Lake
git = "https://github.com/google-deepmind/formal-conjectures"
rev = "bench-v1-lean4.27.0"  # a tag or a commit
lean_libs = ["FormalConjectures"]   # the lean_libs to build and import

[[package]]                  # extra packages, any number
name = "Duper"
git = "https://github.com/leanprover-community/duper"
rev = "v4.27.0"
lean_libs = ["Duper"]

[[package]]                  # a local package: the harness's own Lean libraries
name = "SeshatMeta"
path = "../SeshatMeta"       # relative to this file
lean_libs = ["SeshatMeta"]
```

The name of the file is the name of the environment (lowercase letters, digits, `-`, `_`). A file
with an unknown key, a package with both or neither of `git` and `path`, a base project without a
rev, or a package listed twice is refused with every problem named. TOML is read by a small reader
in the package (`parseToml`), which takes what these files use (strings, integers, booleans, arrays,
inline tables, `[table]` and `[[array]]`) and refuses the rest with its line, because a TOML
library for three tables of strings does not pay for itself.

The harness's Lean libraries join an environment as local packages: `lean/SeshatMeta` for
`lean.meta` ([lean-meta.md](lean-meta.md#deployment)) and, later, `lean/SeshatLib`. `base` does not
include `SeshatMeta`, because `base` is exactly the bench's project and the library has never been
compiled; adding the `[[package]]` above makes another environment, with another hash.

## The resolver

```sh
pnpm harness lean-env resolve extended [--find]
```

For each package, the resolver reads two files at its `rev`: `lean-toolchain` and
`lake-manifest.json` (from `raw.githubusercontent.com`; a local package is read from its directory).
That is all it asks of the network. It then **refuses the environment**, with every problem named
and nothing written, unless:

1. every package uses the toolchain the file declares (and so the same as each other);
2. every dependency that two or more manifests list is the same repository at the same commit
   (`mathlib` at the commit the bench pins, `batteries`, `aesop`...). A repository is the same
   however its URL is written (`.git`, case of the host, `http`);
3. a package of the environment that another one also depends on is at the revision the other wants.
   A commit is compared with the other manifest's commit; a tag only with the other manifest's
   `inputRev`; a tag that cannot be compared without a network call is refused with the request to
   give that package by commit;
4. each manifest names the package as the file does, can be read, and lists only git dependencies.

A local package is the harness's own Lean library: only its toolchain is checked, its files go into
the hash, and what it requires follows the environment's pins (Lake keeps the root's, as
[lean-meta.md](lean-meta.md#deployment) says).

`--find` is for a package whose file gives no `rev`: the resolver tries the tag `v<toolchain>`
(`v4.27.0`) and says so in a note; the lock records the rev it used, and the note asks to copy it
into the file, because a later `resolve` without `--find` refuses a package with no rev.

When everything agrees, it writes the environment's project into `lean/env/<name>/`
(`lean/env/*/` is ignored by git: it is the output of a step that needs the network, and the lock
rebuilds from the file):

| File | Content |
|---|---|
| `lakefile.toml` | A root package `seshat_env` that requires each package (git and rev, or `path`), and, pinned at the commit the manifests agree on, each dependency that two or more of them list. Lake keeps the root's choice over a dependency's, so the agreement the resolver checked is the one the build uses. A dependency only one package lists follows that package's manifest. |
| `lean-toolchain` | The toolchain. |
| `lean-env.lock.json` | The lock: the packages as resolved (rev, libraries, toolchain, hash of the manifest read), the merged dependencies with who lists them, the hash of the environment file it was made from, and the environment hash. |

A lock with another hash than the one before it deletes `lake-manifest.json` and the build stamp in
the directory, so that Lake resolves again.

## The environment hash

The environment hash is the SHA-256 of the canonical JSON of: the toolchain; each package's name,
repository, rev, libraries (or, for a local package, the hash of its files, `.lake` and `build`
excluded); and each dependency's name, repository and commit. The description, the name of the
environment, the order of the packages in the file, the date and the machine are not in it. Two
environments with the same hash have the same Lean, the same packages and the same Mathlib.

A package's rev is the one the file gives, so a tag that someone moves is not seen by the hash unless
a manifest changes with it. Give packages by commit when that matters.

The lock records the hash of the environment file as well (`specHash`). `lookupEnvironment(name)`
says where an environment stands without throwing:

| Status | When | Hash |
|---|---|---|
| `resolved` | The project directory holds a lock of this environment, made from the file as it is now. | the hash |
| `unresolved` | There is no lock. | none |
| `stale` | The lock is damaged, was edited, belongs to another environment, or the file changed since. | none |
| `unknown` | There is no file of that name, or it is wrong. | none |

A hash is only ever the lock's: never one guessed from the file. `harness lean-env show [NAME]` prints
the status, the hash, whether it is built, the packages and the dependencies.

### For other tasks

```ts
import { leanEnvironmentHash, leanEnvOfConfig, sameLeanEnvironment, type LeanEnvRecord } from "@seshat/lean-env";

leanEnvironmentHash("base");                    // the hash of this machine's resolved environment, or undefined
leanEnvOfConfig(runStartedConfig);              // what a run recorded: {name, hash | null}, or undefined for an older run
sameLeanEnvironment(recordedA, recordedB);      // true only when both have a hash and it is the same
```

"The same Lean environment" is `sameLeanEnvironment`: two environments whose hash is unknown are not
the same, themselves included. The memory that outlives a run (Ruling 28) compares a run's record
with the current one with it.

## Building

```sh
pnpm harness lean-env build extended
```

For a resolved environment it runs, in the project directory: `lake update` (when Lake has not
resolved the project yet), `lake exe cache get` (when Mathlib is among the dependencies), then
`lake build <package>/<lib>` for each library of each package, the base project first. It prints the
time of each package and stops at the first command that fails, with the end of what the command
printed. A build that succeeds writes `lean-env.build.json` with the hash, and `show` then says
`built`. The `lake` program is `LAKE` or `lake`.

Then the Lean server is pointed at the project: `LEAN_SERVER_PROJECT_DIR=$PWD/lean/env/<name>`
([lean.md](lean.md#deployment-for-the-bench)).

## In a run

The host profiles name the environment: `"leanEnv": "${env:LEAN_ENV:-base}"` in both
`config/hosts/*.json`, so `LEAN_ENV=extended pnpm harness run ...` runs in `extended`, and a host
without the key names none. `openRegistry` looks the environment up when it builds the registry:

- **The project.** The lock is read from the project directory the Lean tools use: `LEAN_PROJECT_DIR`
  when it is set (a plain checkout of the bench has no lock, so its environment is unresolved), and
  otherwise `lean/env/<name>/`, which becomes the default `LEAN_PROJECT_DIR` once `build` has built
  it (before that, Lake would fetch packages, so the certifier stays unavailable as it was). The hash
  therefore names the project the harness's own tools run in; the project of a Lean server is
  whatever it was started with (`LEAN_SERVER_PROJECT_DIR`), which the harness cannot see.
- **The version of every Lean tool run.** For an implementation whose manifest `environment` has a
  `lean` entry (`lean.check`, `lean.meta`, `lean.goals`, `lean.lsp`, `lean.certify`), the version in
  `tool_run.started`, in the registry's answers, in `harness health` and in the certifier's record
  is the manifest's pinned version followed by `+env:NAME@` and the first 12 digits of the hash:
  `fb2393de+lean-v4.27.0+fc-bench-v1+env:base@3f2a9c04d7be`. The manifest's own `environment.project`
  is the bench's project, which `base` is.
- **One environment per run.** The registry reads the pin once. `run.started` records
  `leanEnv: {name, hash}` (in `config.json` and the report too), and a resumed run is refused unless
  its registry names the same name and hash. A run whose journal recorded no environment (from before
  this existed) has none to keep.

| Status of the environment | The run |
|---|---|
| `resolved` | Records the name and the hash. |
| `unresolved` | Starts, records the name with a null hash, and says so in its log: its results cannot be matched to an environment. |
| `stale`, `unknown` | Does not start, and says why: the file changed since the lock was made, the lock is another environment's or was edited, or there is no such environment. |

## Line M17: a run in an extended environment

M17 (plan change LC3) is the line that tests whether more packages help: M0, or the best line, in
`base` against the same run with M17 in `extended`, at equal budget (Task 14 measures it). It is an
ordinary line (`--lines M17`, `config.lines`) with one option and no hook:

| Option | Default | Meaning |
|---|---|---|
| `env` | `extended` | The environment (`lean/env/<env>.toml`) the run is in, in place of the host's `LEAN_ENV`. |

A line gives the environment through the optional `Line.leanEnv(options)` ([lines.md](lines.md#a-line)),
and at most one enabled line may. The orchestrator then does the following, before any problem:

1. **Builds the registry for that environment**: `RunOptions.registry(journal, blobs, {leanEnv})`; the
   command line passes it to `openRegistry({leanEnv})`, which wins over `LEAN_ENV`. The environment is
   pinned and recorded exactly as in [In a run](#in-a-run).
2. **Refuses to start**, writing nothing, when the registry was built for another environment, or when
   the environment has no hash (`unresolved`, as well as `stale` and `unknown`). A run with M17 in an
   environment that cannot be named in the journal would be a comparison that cannot be checked, so the
   leniency of an unresolved host environment does not apply.
3. **Adds the extra packages' imports to every file of the run.** `environmentImports(lock)` is the
   `lean_libs` of each package of the lock except the base project's, in the order of the file, without
   repeats (`Duper`, then `LeanAPAP`, then `PFR`). `loadProblem` puts one `import <module>` line for
   each after the file's own imports (`withEnvironmentImports`), so that the sketch, the reference file
   and the files the provers and the certifier see all have them. A module the file imports already is
   not added again.
4. **Probes the server.** The Lean server of the host is started on a project the harness cannot see
   (`LEAN_SERVER_PROJECT_DIR`). If it was started on the bench's, every file would fail with `unknown
   module prefix`, and the run would count that against the provers. So the run first checks, as a
   `lean.check` tool run in the journal, a file that is only the imports. If Lean answers with an error
   or a hole, the run stops with the reason `lean_environment` before any problem is worked on, and its
   log says which libraries the server could not import and to start it on the environment's project.
   A server that does not answer, or times out, does not stop the run here: its problems report that.

Resuming is safe: the environment's name and hash are in `run.started`, and a resumed run is refused
in another one. The imports come from the lock, which the registry's hash has checked.

## What has not run

Nothing here ran against Lean, Lake or GitHub. The tests use fixture manifests, a fixture fetcher and
a fake `lake`. To verify on a host that reaches them:

1. That the package names, repositories and `lean_lib` names in `extended.toml` are right (they are
   from memory of the packages' lakefiles; `resolve` checks the names against the manifests, `build`
   the libraries), and that `Duper`, `LeanAPAP` and `PFR` have the `v4.27.0` tags the plan change
   found on 2026-10-20 and agree with the bench's Mathlib.
2. That `lake build <package>/<lib>` is the way to name a library of a dependency in this Lake
   version, and that `lake exe cache get` works from a root package that only requires Mathlib.
3. That Lake keeps the root's pin for a dependency that the lakefile repeats at the commit the
   manifests agree on, and does not rewrite it.
4. Whether Lake's artifact cache serves the packages other than Mathlib from Reservoir (the plan
   change asks): `build` prints the time of each package, which says.
5. That `import FormalConjectures...` works in a project that requires formal-conjectures as a
   dependency, as the bench's files do in the checkout itself.
6. For M17: that the libraries of `extended` (`Duper`, `LeanAPAP`, `PFR`) import together in one file
   without a clash of names, that the probe's error from a real server is the one the run reports, and that
   a problem file with the extra imports checks as it does without them (an import adds notation and
   instances; the bench's solved problems must still elaborate). The test of the line uses a simulated
   Lean that rejects the probe by its text.
