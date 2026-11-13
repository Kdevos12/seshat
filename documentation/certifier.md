# The certifier

The certifier is the second level of trust ([trust.md](trust.md#two-levels-of-checking)): the
check that makes a claim `proved` or `refuted`. The fast check reads messages from a Lean REPL,
and code that runs during elaboration could forge them. The certifier compiles the candidate in a
fresh process, replays every declaration of the compiled module through the kernel, collects the
target's axioms itself and compares the target with the reference's as terms. The design is that of
[lean4checker](https://github.com/leanprover/lean4checker) and
[SafeVerify](https://github.com/GasStationManager/SafeVerify).

**Status.** The TypeScript side is tested against a fake `lake`, and on 2026-11-08 the whole
certification ran for the first time against a real Lean v4.27.0, in the built project
`lean/env/base` ([what ran](#what-ran-against-a-real-lean)), without a sandbox and through the
bubblewrap recipe below: the version check and the probe, both compiles, the replay by
`lean/SeshatCertify` and the verdict. That first run found two faults, fixed since: Lean v4.27.0
refuses to compile with `-o` a source outside its root directory (the working directory, here the
project), so every certification failed at the probe; and the program did not compile (its `main`
returned a `0` that Lean elaborated as a `Nat`). Only a one-line theorem of Mathlib was certified:
[to verify against Lean](#to-verify-against-lean) lists what has not been run yet.

## What it answers

`LeanCertifier.certify(request, {timeoutSec?, signal?})` (`packages/core/src/lean.ts`) takes the
reference file (`original`), the `candidate` file, the `target`'s full name and the
`allowedAxioms`, and answers `{verdict, reasons, axioms, timeMs}`:

- `certified`: the module compiles, the kernel accepts every declaration in it, the target states
  what the reference states, and it depends only on the allowed axioms. `axioms` lists them,
  sorted.
- `rejected`, with `reasons`: the candidate does not compile, and the reference does in the same
  project (Lean's first five errors, at their lines in the candidate file); the program refused it
  (below).

A call that reaches no verdict throws `CertifyFailedError`, whose `reason` is `timeout`,
`aborted`, `unavailable` (no `lake`, another Lean than the pinned one, a project in which the
probe file does not compile) or `failed` (the reference does not compile, neither the candidate
nor the reference does, Lean or the program died, the program printed something that is not a
verdict). Such a failure says nothing about the candidate, so it is never turned into `rejected`:
the claim stays a candidate and the failure is recorded as a reason, not as an invalid validation.
Only a `rejected` verdict is the candidate's fault.

Lean ends with 1 for the errors of a file and for import errors alike: an unbuilt project, a
`LEAN_PROJECT_DIR` that is the wrong checkout, or `.olean` files of another toolchain fail every
file. So the certifier does not take a candidate's compile errors for the candidate's fault until
the reference has compiled in the same project (step 3 below), and `pnpm harness health
lean.certify` compiles a probe file before a run.

## The process

`LakeCertifier` (`packages/lean-local`) runs, for each certification and in the Lean project of the
bench (`projectDir`, the working directory of every call):

1. once per certifier, `lake env lean --version`, which must report the pinned version, and then,
   if the setting `probe` is not empty, `lake env lean --root=DIR -o DIR/probe.olean DIR/probe.lean`
   on a file that holds it, in a directory `DIR` of the check's own (the manifest sets `import FormalConjectures.Util.ProblemImports`, the prelude of the
   bench's files). A project that is not built, or is not the bench's checkout, fails here, and the
   certifier is unavailable with Lean's message. `pnpm harness health lean.certify` runs the same
   check. It is shared by the certifications that wait for it, and a failure is not kept: the next
   call looks again;
2. `lake env lean --root=DIR -o DIR/SeshatTarget.olean DIR/SeshatTarget.lean` on the candidate, in
   a directory `DIR` of its own;
3. the same on the reference, in another directory of its own, the reference compiled again for each
   certification, after the candidate's process has ended, whether or not the candidate compiled: a
   candidate is rejected for its errors only when the reference compiles, and when neither does the
   call fails (`failed`, "neither the candidate nor the reference compiles") instead of recording
   a rejection;
4. `lake env lean --run Main.lean request.json`, with the program's copy and the request in the
   directory of the replay, which prints one line of JSON.

**The module name.** With `-o`, Lean names the module it compiles from the source's path relative
to its root directory, which is the working directory unless `--root` gives another, and it refuses
a source outside it (`input file '…' must be contained in root directory (…)`, exit code 1). Every
call runs in the Lean project, where `lake env` finds the bench's modules, and every source is in
the call's own directory, outside the project: so each compile gives Lean that directory as its root,
and the module is named after the file alone. The candidate and the reference are both written as
`SeshatTarget.lean` (the module `SeshatTarget`, `TARGET_MODULE` in `certifier.ts`), so that their
private names (`_private.SeshatTarget.0.…`) and hygienic names are the same and the comparison of
the replay can match them; Lean's messages are given with the file called `candidate.lean` or
`reference.lean`. The replay (`--run`) writes no object file and needs no root.

Each call is a process group of its own, killed as a whole at the time limit or on abort (the
version check and the probe too: a certification that is aborted does not wait for them, and when no
certification waits for the check any more its process is killed), and killed if it leaves a process
holding its output open. Output is kept up to 1 MiB per stream.

**The environment** of every call is exactly this, and nothing else of the harness's environment
reaches it: `PATH` (and `SYSTEMROOT`, `WINDIR`, `COMSPEC` and `PATHEXT` where Windows has them);
`HOME` (`USERPROFILE`) unless the settings' `env` gives an `ELAN_HOME`, because elan looks for its
toolchains in `$HOME/.elan` then; `TMPDIR` (`TEMP`, `TMP` on Windows), set to the call's own
directory; and the settings' `env`, which the shipped profiles use for `ELAN_HOME`. In particular
there is no `XDG_RUNTIME_DIR`, no `DBUS_SESSION_BUS_ADDRESS`, no `DOCKER_*`, no `SSH_AUTH_SOCK`, no
key or token, and no `LD_PRELOAD`. A sandbox command that needs one of them (`systemd-run --user`
needs `XDG_RUNTIME_DIR`) gets it by naming it in `env`, which gives it to Lean as well unless the
sandbox clears the environment.

**The directories.** A certification works in a directory made for it (`mkdtemp` under `workDir`,
mode 0700, removed at the end) and every call has a directory of its own inside it, made empty just
before the call and the only thing a sandbox needs to leave writable (`{work}`): `candidate-…` for
the candidate's compile, `reference-…` for the reference's, `replay-…` for the program. The version
check and the probe use one outside it. So the candidate's compile cannot write where the reference's
directory or `request.json` are made later (a directory it plants, or a named pipe at `request.json`
that would make a write wait for ever), and the replay reads nothing but what the harness put in
its directory after the compiles had ended: a copy of the program, as it was read when the
certifier was made (a compile that rewrites `Main.lean` changes nothing for later replays), copies
of the two object files, and the request. An object file that is not a regular file (a link, a pipe)
is a failure of the call.

There is one time limit for the whole certification: the call's `timeoutSec` (1 to 3600), or the
implementation's setting `timeoutSec` (default 600). The registry allows the call that long plus 15
seconds, so that the certifier stops itself first and says why; a call that gives no `timeoutSec`
gets the manifest's 900 seconds, which a host profile can change with `timeoutMs`.

The exit code of a compile is Lean's: 1 means errors in the file (the reference's, so a failure of
the call; the candidate's, so `rejected` if the reference compiled and a failure of the call if it
did not), anything else, such as a signal, is a failure of the call. After the program, the certifier checks again what it can: a `certified` verdict with an axiom
outside `allowedAxioms` becomes `rejected`; a `certified` with reasons, a `rejected` without any,
and a line that is not a verdict are failures of the call.

## The Lean program

`lean/SeshatCertify/Main.lean` reads the request (`{"reference", "candidate", "target",
"allowedAxioms"}`: the two `.olean` files, and names as arrays of their components) and prints
`{"verdict", "reasons", "axioms"}` with exit code 0. The names are sent as components because Lean's
`String.toName` splits at every dot and does not read `«»`, so `Arxiv.«1609.08688».f` would be four
pieces: the harness reads the source form (`nameComponents`) and the program builds the `Name` from
the components. A verdict `rejected` is only for what the candidate did (its imports, an unsafe or
partial constant, a declaration the kernel refuses, a target that is missing or states something else,
an axiom that is not allowed); anything else that goes wrong (the request does not parse, an object
file cannot be read, the reference cannot be replayed, any other exception) prints nothing and exits
with another code, and the harness takes it for a failure of the call. It runs none of the
candidate's code: it reads the two object files as data, with the imports loaded without their
initializers (`importModules (loadExts := false)`, passed explicitly). It

1. refuses a candidate whose imports differ from the reference's, or that declares an unsafe or
   partial constant (`Environment.replay` skips those). One partial constant is not the candidate's:
   Lean v4.27.0 adds `X._unsafe_rec`, marked partial, for every recursive definition `X`, structural
   or well-founded, as the compiler's implementation of it; it is let through when `X` is declared in
   the same module as an ordinary safe definition (`compilerAux`: a `defnInfo` whose safety is `safe`).
   A `partial def X` stays refused: Lean v4.27.0 makes its `X` an opaque constant whose own `isPartial`
   is false, so the test is on the kind of `X`; a first version that tested `isPartial` let a
   `partial def` through (checked on a real Lean on 2026-11-13, and fixed the same day).
   Until 2026-11-13 it was refused too: in the third real run six candidates that the fast check had
   accepted (Putnam 1994 A1 twice, 1997 B5 three times, 2000 A2 once) were rejected for it, and 1997 B5,
   whose own statement defines `tetration` by structural recursion, could not be certified at all;
2. imports the imports once and sends every constant of the reference's module, then of the
   candidate's, through the kernel (`Lean.Environment.replay`, as lean4checker does; core's
   version in Lean v4.27.0 needs no separate package). A constant the kernel refuses is a reason;
3. requires the target to be a theorem the candidate declares itself, and compares it with the
   reference's, together with every constant of the reference's module that its statement depends
   on, followed through the types and the values of definitions (a theorem is followed by its type
   only): a theorem by name, universe parameters and type, never by proof; a definition also by value
   and safety; inductive types, constructors and recursors by their data. This is SafeVerify's
   comparison, restricted to what the statement rests on, so that a candidate cannot keep the type's
   text and change the definition behind it;
4. collects the target's axioms from the replayed environment (`CollectAxioms`) and refuses any
   outside `allowedAxioms`. The policy's list is the three standard axioms, so `sorryAx` and
   `Lean.ofReduceBool` (`native_decide`) are refused.

It does not replay the imports (the pinned project's object files are trusted, as in lean4checker's
default), compare the module's other declarations, or look at axioms of declarations the target does
not depend on.

## Where untrusted code runs

The compile of step 2 runs the candidate's code: a proof is elaborated by Lean, and a tactic block
can run any meta program. The structural checks of the validator refuse the usual ways to do so
([validator.md](validator.md#structural-checks)), but they read only the regions a prover edits,
not a claim's header or statement, and the certifier does not rely on them. The compile of step 3
runs the code of the reference, which for a claim that is not a problem's is built from a header a
model wrote. Both run in a fresh process, and their results are used only as data: the program
that decides runs afterwards, in a process that has loaded no code of theirs, and the kernel
refuses an object file that is not well typed. The one thing a compile can do that this does not
stop is change files and use what the user can reach: the program, the project, the toolchain, the
`.olean` files the replay trusts (the imports are not replayed), the user's own files, the network.
Without a sandbox, a candidate can therefore make later candidates `certified`.

`harness doctor` ([quickstart.md](quickstart.md#harness-doctor)) finds out whether this machine has bubblewrap or Docker that works and, when
the host profile in use has no sandbox, writes `config/hosts/sandboxed.json`: the local profile with the certifier behind the bubblewrap or Docker
recipe below. It runs the recipe on scratch directories first and writes the profile only if the work directory is writable, a file outside it is not, and the network is unreachable. It writes it once and never over an existing file, it is git-ignored, and it never sets `unsandboxed`; without isolation it writes
nothing and says that results stay `computed`. The rule that the certifier refuses to run without a sandbox is unchanged.

**So the certifier fails closed.** `lean.certify` is unavailable, with this reason, in `pnpm harness
health lean.certify` and in the run (below), unless the host profile gives the implementation
either:

- a `sandbox` command, put before every call of `lake`, with `{work}` (the directory of the call,
  which it may write) and `{project}` (the Lean project) replaced; or
- `"unsandboxed": true`, the user's explicit choice to run the code of the candidates as the
  harness's user, with that user's files and network, as Pantograph's does
  ([lean-meta.md](lean-meta.md#leangoals)). A host profile you write for your own machine may say
  so. The shipped ones do not: `local` is unavailable until you add one of the two, and `server`
  until you add a sandbox, since the host `server` refuses `unsandboxed` whatever its profile says.

**What the harness enforces, and what only a sandbox can.** The harness enforces: a time limit per
certification, with the process group killed; a cap of 1 MiB on each output stream; the minimal
environment above; a directory of its own for every call, and a program that a compile cannot
rewrite for later replays. It does not enforce, and without a sandbox nothing does: a limit on
memory, on disk or on processes (a compile that allocates without end takes the machine's memory
until the time limit, and the out-of-memory killer may choose another victim), which files the
process can read or write outside `{work}`, and which network it can reach. A sandbox command is
how a host limits them. With recipe 1, `lake env` works with the project read-only and finds the
toolchain ([what ran](#what-ran-against-a-real-lean)); the other recipes were not tried.

**Recipes**, of which only the first has run, with a real Lean
([what ran](#what-ran-against-a-real-lean)): all three put the project read-only, leave `{work}` as the only place to write, and have no
network. Check each with `pnpm harness health lean.certify`, which runs the version check and the
probe through it, then a certification of a known proof.

1. Bubblewrap, with a cap on address space by `prlimit`. `--as` counts the mapped `.olean` files too
   (Mathlib's are several GB), so give it room, lower it after measuring a certification, and treat
   it as a cap on a runaway allocation, not a precise memory limit:

   ```json
   "sandbox": ["prlimit", "--as=68719476736", "--cpu=1800", "--",
               "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
               "--bind", "{work}", "{work}", "--unshare-net", "--unshare-pid", "--die-with-parent", "--"]
   ```

   `--tmpfs /tmp` comes before `--bind {work} {work}` so that a `workDir` under `/tmp` stays
   reachable. There is no `--nproc`: that limit counts all the user's processes, not the sandbox's;
   the next two limit the number of tasks of the sandbox itself. The toolchain (`ELAN_HOME`, `~/.elan`) and the project are readable because the root is
   bound read-only; a host that keeps secrets under the home directory should bind only what Lean
   needs instead of `/`.

2. Bubblewrap under a cgroup, for a memory limit that counts what the process uses (the kernel
   reclaims the page cache of the object files first): `systemd-run --user` starts a scope with
   `MemoryMax`. It needs the user's systemd, so name `XDG_RUNTIME_DIR` in the settings' `env`:

   ```json
   "sandbox": ["systemd-run", "--user", "--scope", "--quiet",
               "-p", "MemoryMax=16G", "-p", "MemorySwapMax=0", "-p", "TasksMax=512", "--",
               "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
               "--bind", "{work}", "{work}", "--unshare-net", "--unshare-pid", "--die-with-parent", "--"]
   ```

3. A container with the project mounted read-only, a limit on memory and processes, no network and a
   read-only root. The image holds the toolchain (a Lean v4.27.0 installed by elan, with
   `ELAN_HOME` pointing at it); the harness's `PATH` is not the container's, so name `lake` by its
   path in `command`:

   ```json
   "command": "/opt/elan/bin/lake",
   "sandbox": ["docker", "run", "--rm", "--network", "none", "--memory", "16g", "--memory-swap", "16g",
               "--pids-limit", "512", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--user", "1000:1000",
               "-v", "{project}:{project}:ro", "-v", "{work}:{work}", "-w", "{project}",
               "-e", "ELAN_HOME=/opt/elan", "seshat-lean:4.27.0"]
   ```

   Set `--user` to the uid and gid of the harness's user: `{work}` is mode 0700. The harness starts
   `docker`, so a rootless Docker needs its `DOCKER_HOST` in the settings' `env`. The container does
   not inherit the environment of `docker`: `-e` names what Lean gets. `{work}` is all the replay
   needs besides the project, since it holds the program, the request and the object files.

Not covered by any of them: a disk quota for `{work}` (put it on a size-limited filesystem), and
the time the sandbox itself takes to start, which counts against the certification's time limit.

## The capability and its settings

`lean.certify` is `auto`: the orchestrator calls it, a model does not
([capabilities.md](capabilities.md#leancertify)). Its implementation `lake` (factory `lake-certify`,
version `0.1.0+lean-v4.27.0+fc-bench-v1`) has these settings, which a host profile overrides:

| Setting | Meaning | Default |
|---|---|---|
| `command`, `args` | `lake`, and arguments before `env lean ...` | `lake` |
| `projectDir` | the pinned Lean project, where the candidate's imports resolve; the host profiles take `LEAN_PROJECT_DIR`. Without it the implementation is unavailable | none |
| `program` | the Lean program | `lean/SeshatCertify/Main.lean` of this repository |
| `probe` | the Lean source the version check is followed by (empty: none) | `import FormalConjectures.Util.ProblemImports` |
| `sandbox` | the command before every call, with `{work}` and `{project}` replaced | none |
| `unsandboxed` | run the candidate's code as the harness's user when there is no `sandbox` (the host `server` refuses it) | `false` |
| `workDir` | where work directories are made | the system's temporary directory |
| `timeoutSec` | the limit of a certification that gives none | 600 |
| `env` | variables added to the child's minimal environment (`ELAN_HOME` from the host profiles) | none |

Without `projectDir`, and without a `sandbox` or `unsandboxed: true`, the implementation is
unavailable and says why ([above](#where-untrusted-code-runs)); an unreadable `program` makes it
unavailable too.

The Lean version it expects is the manifest's `environment.lean`. `pnpm harness health` runs the
version check and compiles the probe, and says whether the code runs in a sandbox. The registry
gives a health check 15 seconds, and loading the bench's modules on a cold disk cache can take
longer: the check is then stopped, and run again it finds the files in the cache.

The contract (`capabilities/lean.certify/contract.json`) has 9 cases: a proof without axioms, the
three standard axioms, `sorry`, an axiom of the candidate's own, `native_decide`, another statement
under the same name, a changed definition under the same statement, a file that does not compile,
and a time limit. A test runs it against the answers a certifier is expected to give, which only
shows that the expectations are well written.

## In a run

A run certifies when it has a certifier: the one `RunOptions.certifier` gives, or else the host's
`lean.certify`, if the profile lists it (`RegistryLeanCertifier.forHost(registry)`, which goes
through the registry, so that every certification is a tool run). `run.started` records which one
(`config.certifier`, `null` for none).

A host that lists the capability but cannot run it does not stop the run: each certification fails,
the candidates stay candidates, and each problem says why in its reason (`certification failed:
...`). Two kinds of reason are told at the start. If the registry cannot make the implementation at
all (`Registry.usable`, which calls nothing), because `LEAN_PROJECT_DIR` is not set, or there is no
sandbox command and no `unsandboxed: true` (which is what both shipped profiles come to until the
user configures one), the run logs `certifier ... is unavailable on host H (reason)` and records the
reason in `run.started` (`config.certifierUnavailable`). Whether Lean is the pinned version and the
project compiles the probe is found when the first certification starts, and by `pnpm harness
health lean.certify` before a run.

[m0-loop.md](m0-loop.md#certification) has what is certified, when, and what each answer does to the
claim and to the problem's outcome. In short:

- A problem's own candidate is certified when its provers are done. A certified proof makes the
  claim `proved`; a rejected one leaves it `computed`, with the reasons in the `kernel_replay`
  validation; no answer leaves it `computed` and records no verdict.
- The proofs and refutations that lines submit through `validate` take the same path. The ones for
  other claims, for negations (`negation: true`, which make a claim `refuted`), and any late proof of
  the problem's own claim are certified when the problem's `afterProblem` is over, one after the
  other. M2's composed proofs, its twin's proof and its composed refutations go through here:
  nothing distinguishes them from a prover's candidate. A problem certifies its own lines'
  submissions only: the problem whose submission made a workbench's candidate certifies it, and a
  problem that ends earlier leaves the others' to them.
- Each candidate is certified once per run, and a workbench keeps its first candidate: the
  problem's own, and one for each other claim and each negation a line submits proofs for. A line
  cannot make the run pay for certification after certification by submitting more proofs of one
  claim.
- The reference the certifier gets as `original` is never a file a line supplied: the problem's own
  file, or the claim's file rebuilt from its journaled statement and header
  ([memory.md](memory.md#reference-files)). For a refutation it is that file followed by the
  negation theorem, so that the target is compared with `¬ statement` as Lean elaborates it.
- A certified proof of a claim that is already settled the other way (a proof of a refuted claim, a
  refutation of a proved one) is a contradiction, not a status: the validation stays as evidence
  and the status does not move. The problem ends as `error` when the claim is its own (its
  candidate, or a refutation of it that its lines submitted); for another claim the run's log says
  so and the problem's reason notes it.
- Certification is no tool call of a prover, and no hook of a line sees it. M6's `beforeCheck` and
  `afterCheck` belong to the prover's `lean_check` calls and the fleet's hooks to its sessions and
  provers; the certifier is asked once the last prover has ended, and a line learns the result in
  `afterProblem` only. So a veto of M6 cannot block it, and the registry's tool run of
  `lean.certify`, which belongs to no attempt, is not among the provers' tools in the report.

## Tests

`packages/lean-local/test` runs `LakeCertifier` against a fake `lake`
(`fixtures/fake-lake.ts`, a script that prints what the real one would: the version, a copy of the
source as the object file, a verdict chosen by a marker in the candidate; like Lean v4.27.0, it
refuses to compile with `-o` a source outside `--root` or the working directory, and logs the module
name it gives the file) and a fake sandbox
(`fixtures/fake-sandbox.ts`, which tells the fake `lake` where it may write): certified and rejected
candidates, a kernel refusal, a type that differs from the reference's, axioms outside the allowed
set, a program that lies about them, a file that does not compile, a reference that does not, Lean
or the program dying, the time limit with the process group killed, an abort (also during the
version check, which the aborted call does not wait for, while another call that waits for it
keeps it), an unavailable or wrong `lake`, a project that compiles nothing (the candidate is not
rejected, and the probe says so before anything is compiled), the environment the child gets
(exactly the variables listed above, with the harness's credentials, sockets and `HOME`-like
variables set), a sandbox command with a directory of its own for each call, a compile that plants
a directory or a named pipe where the next steps would write, each compile given its own directory as
`--root` with the two modules named the same, a compile that rewrites the program,
an object file that is a link, and a certifier that is not made without a sandbox or `unsandboxed`.
`packages/lean-local/test/factory.test.ts` runs the factory through the registry with the
manifest's own settings: the probe, and the fail-closed rule (the shipped profiles `local` and
`server` are unavailable, with the reason; `server` refuses `unsandboxed`).
`packages/registry/test` runs the adapters (`leanCertifyImplementation`, `RegistryLeanCertifier`)
and the contract. `packages/orchestrator/test/certify.test.ts` runs the certification through the
loop with fake certifiers and with the registry, with M1, M6 and the fleet on among them
([m0-loop.md](m0-loop.md#tested-and-not-yet)), and
`packages/graph/test/line.test.ts` has M2's twin refute a claim with a certifier. None of them has a
Lean, a sandbox or a real `lake`: what ran with those is [above](#what-ran-against-a-real-lean).

## Deployment

The certifier needs the bench's Lean project built, as `lean.check` does
([lean.md](lean.md#deployment-for-the-bench)): Lean v4.27.0 through elan, and
`lake build` in the formal-conjectures checkout so that its object files exist.

```sh
export LEAN_PROJECT_DIR=/path/to/formal-conjectures
(cd lean/SeshatCertify && lake build)   # optional: the certifier interprets Main.lean with --run
# lean.certify is unavailable until the host profile has a sandbox (or unsandboxed: true): add one,
# in a copy of config/hosts/local.json, and pass it with --host
pnpm harness health lean.certify
pnpm harness contract lean.certify --out certify-contract.json
```

To run the program by hand on two files, from the project directory:

```sh
mkdir -p /tmp/ref /tmp/cand   # each holding SeshatTarget.lean, the reference's and the candidate's
lake env lean --root=/tmp/ref -o /tmp/ref/SeshatTarget.olean /tmp/ref/SeshatTarget.lean
lake env lean --root=/tmp/cand -o /tmp/cand/SeshatTarget.olean /tmp/cand/SeshatTarget.lean
echo '{"reference":"/tmp/ref/SeshatTarget.olean","candidate":"/tmp/cand/SeshatTarget.olean","target":["Ns","name"],"allowedAxioms":[["propext"],["Classical","choice"],["Quot","sound"]]}' > /tmp/request.json
lake env lean --run /path/to/seshat/lean/SeshatCertify/Main.lean /tmp/request.json
```

## What ran against a real Lean

On 2026-11-08, on a workstation with Lean v4.27.0 installed by elan (no `ELAN_HOME`, so `HOME` and
`PATH` only), the project `lean/env/base` built (formal-conjectures and Mathlib), and bubblewrap:

- `LakeCertifier` from a script, with `projectDir` that project, the probe
  `import FormalConjectures.Util.ProblemImports`, `lean: v4.27.0`, and the reference of the first
  real run (`problem/Solve.lean`, `theorem solve_target (n : ℕ) : n + 0 = n := by sorry` under
  `import Mathlib`), target `solve_target`, the three standard axioms. Without a sandbox
  (`unsandboxed: true`) and through recipe 1 below, the same answers:
  - the health check: ok, the version, "the probe file compiles" (7 to 26 s; 11 to 14 s through
    bubblewrap, depending on the disk cache);
  - the run's candidate (`simp`): `certified`, axioms `["propext"]` (19 s; 55 s through bubblewrap);
  - the reference itself as the candidate: `rejected`, "solve_target depends on axioms that are not
    allowed: [sorryAx]";
  - `0 + n = n` under the same name: `rejected`, "solve_target does not state what the reference
    states";
  - `exact foo`: `rejected`, "does not compile: candidate.lean:4:8:
    error(lean.unknownIdentifier): Unknown identifier `foo`" (the reference compiled).
- `pnpm harness health lean.certify --host sandboxed` (the profile `harness doctor` wrote, with
  recipe 1) with `LEAN_PROJECT_DIR` set: ok in 7.5 s once the disk cache was warm; the first three
  tries on a cold cache took longer than the registry's 15 seconds and were stopped, as
  [the capability](#the-capability-and-its-settings) says.

So, at v4.27.0: the program compiles under `lake env lean --run` (it was not built with `lake
build`) and its `readModuleData`, `importModules (loadExts := false)`, `Environment.replay`,
`CollectAxioms` and comparison work on these modules; `lean` ends with 1 for a file with errors;
`lake env` works from a read-only project, with no network and the toolchain under the read-only
root, and finds the built object files without fetching anything.

## To verify against Lean

1. The rest of the program's paths: a kernel refusal, an unsafe or partial constant, other imports,
   a changed definition under the same statement, a target the candidate does not declare, a
   reference that cannot be replayed; and a `lake build` of `lean/SeshatCertify`.
2. That `Environment.replay` of a module of a formal-conjectures file, and of a big proof, takes
   the time and memory one expects, and the time a bench problem's certification takes.
3. That a statement depending on a `private` definition of the file is certified: the two files now
   have the same module name (`SeshatTarget`, [above](#the-process)), so their private names should
   be the same, but no such file has been run.
4. That Lean ends with 1 and a message for a file whose imports are not built (the certifier takes
   that for the project's fault when the reference fails too).
5. The contract's nine cases, and the reasons' texts they match (`pnpm harness contract
   lean.certify`); four of the same kinds ran above, not the contract.
6. The sandbox's limits: that recipe 1 keeps a compile within its memory cap, and recipes 2 and 3 at
   all.
7. That a target built from its components (`Name.str` for each) is the name the file declares, for a bench
   name such as `Arxiv.«1609.08688».maximalLength_le` (the middle component a string, not a number),
   and for the negation theorem's name.
8. A run that ends with a claim `proved` through the certifier (the run that found the faults above
   ended before the fix).

## Not done yet

- A certification that gave no answer is not tried again in the run, and neither is a rejected
  candidate's claim with another proof. A transient failure of the certifier therefore costs the
  candidate its certificate in that run, and nothing certifies the candidates of a finished run
  afterwards, though every file that was checked is in its blob store (by `submissionHash`).
- The fleet counts a proof the fast check accepted as a success of its strategy and its model
  ([fleet.md](fleet.md#posteriors)), also when the certifier then rejects it. The rejection is a
  validation of the claim that no posterior reads yet.
- The reference is compiled for every certification. Caching it is safe only where nothing that ran
  untrusted code can write to the cache, so it waits for a sandbox that has been tried.
- The module is replayed whole, since `Environment.replay` takes a module's constants as a map.
  Replaying only what the target depends on would be faster for large candidates, with the care
  lean4checker takes over inductive types.
- A native implementation of the program as an executable (`lake build` makes one, which the
  harness does not use) would avoid interpreting it.
