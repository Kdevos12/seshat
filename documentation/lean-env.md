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
