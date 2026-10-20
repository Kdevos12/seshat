# The certifier

The certifier is the second level of trust ([trust.md](trust.md#two-levels-of-checking)): the
check that makes a claim `proved` or `refuted`. The fast check reads messages from a Lean REPL,
and code that runs during elaboration could forge them. The certifier compiles the candidate in a
fresh process, replays every declaration of the compiled module through the kernel, collects the
target's axioms itself and compares the target with the reference's as terms. The design is that of
[lean4checker](https://github.com/leanprover/lean4checker) and
[SafeVerify](https://github.com/GasStationManager/SafeVerify).

**Status.** The TypeScript side is written and tested against a fake `lake`. The Lean program,
`lean/SeshatCertify/Main.lean`, has never been compiled, and nothing here has run against a real
Lean: it was written in an environment without one, from the sources of Lean v4.27.0, lean4checker
and SafeVerify. [To verify against Lean](#to-verify-against-lean) lists what the first run must
check.

## What it answers

`LeanCertifier.certify(request, {timeoutSec?, signal?})` (`packages/core/src/lean.ts`) takes the
reference file (`original`), the `candidate` file, the `target`'s full name and the
`allowedAxioms`, and answers `{verdict, reasons, axioms, timeMs}`:

- `certified`: the module compiles, the kernel accepts every declaration in it, the target states
  what the reference states, and it depends only on the allowed axioms. `axioms` lists them,
  sorted.
- `rejected`, with `reasons`: the candidate does not compile (Lean's first five errors, at their
  lines in the candidate file); the program refused it (below).

A call that reaches no verdict throws `CertifyFailedError`, whose `reason` is `timeout`,
`aborted`, `unavailable` (no `lake`, another Lean than the pinned one) or `failed` (the reference
does not compile, Lean or the program died, the program printed something that is not a verdict).
Such a failure says nothing about the candidate, so it is never turned into `rejected`: the claim
stays a candidate and the failure is recorded as a reason, not as an invalid validation. Only a
`rejected` verdict is the candidate's fault.

## The process

`LakeCertifier` (`packages/lean-local`) runs, for each certification and in the Lean project of the
bench (`projectDir`, the working directory of every call):

1. once per certifier, `lake env lean --version`, which must report the pinned version;
2. `lake env lean -o candidate.olean candidate.lean`, in a work directory of its own;
3. `lake env lean -o reference.olean reference.lean`, the reference compiled again for each
   certification, after the candidate's process has ended;
4. `lake env lean --run lean/SeshatCertify/Main.lean request.json`, which prints one line of JSON.

Each call is a process group of its own, killed as a whole at the time limit or on abort, and killed
if it leaves a process holding its output open. The child's environment is `PATH`, `HOME` and the
few variables the registry passes to every server (`serverEnv`), plus the settings' `env`: no
secret of the harness reaches it. Output is kept up to 1 MiB per stream. The work directory is
removed when the certification ends.

There is one time limit for the whole certification: the call's `timeoutSec` (1 to 3600), or the
implementation's setting `timeoutSec` (default 600). The registry allows the call that long plus 15
seconds, so that the certifier stops itself first and says why; a call that gives no `timeoutSec`
gets the manifest's 900 seconds, which a host profile can change with `timeoutMs`.

The exit code of a compile is Lean's: 1 means errors in the file (the candidate's, so `rejected`;
the reference's, so a failure of the call), anything else, such as a signal, is a failure of the
call. After the program, the certifier checks again what it can: a `certified` verdict with an axiom
outside `allowedAxioms` becomes `rejected`; a `certified` with reasons, a `rejected` without any,
and a line that is not a verdict are failures of the call.

## The Lean program

`lean/SeshatCertify/Main.lean` reads the request (`{"reference", "candidate", "target",
"allowedAxioms"}`, the two `.olean` files and names) and prints `{"verdict", "reasons", "axioms"}`
with exit code 0; a failure that is not the candidate's (the reference cannot be replayed, the
request does not parse) prints nothing and exits with another code. It runs none of the candidate's
code: it reads the two object files as data, with the imports loaded without their initializers
(`importModules` with `loadExts := false`). It

1. refuses a candidate whose imports differ from the reference's, or that declares an unsafe or
   partial constant (`Environment.replay` skips those);
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
([validator.md](validator.md#structural-checks)), but the certifier does not rely on them. The
compile of step 3 runs the code of the reference, which for a claim that is not a problem's is
built from a header a model wrote. Both run in a fresh process, and their results are used only as
data: the program that decides runs afterwards, in a process that has loaded no code of theirs, and
the kernel refuses an object file that is not well typed. The one thing a compile can do that this
does not stop is change files: the program, the project, the toolchain, or the other object file.
A host that runs untrusted models therefore gives the certifier a `sandbox`.

`sandbox` is a command put before every call of `lake`, with `{work}` (the directory of the
certification, the only place the call may write) and `{project}` (the Lean project) replaced. An
example for bubblewrap, not tried here:

```json
"sandbox": ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--bind", "{work}", "{work}", "--unshare-net", "--unshare-pid", "--die-with-parent", "--"]
```

Without one, the code runs as the harness's user, with that user's files, as Pantograph's does
([lean-meta.md](lean-meta.md#leangoals)). The default host profiles give none.

## The capability and its settings

`lean.certify` is `auto`: the orchestrator calls it, a model does not
([capabilities.md](capabilities.md#leancertify)). Its implementation `lake` (factory `lake-certify`,
version `0.1.0+lean-v4.27.0+fc-bench-v1`) has these settings, which a host profile overrides:

| Setting | Meaning | Default |
|---|---|---|
| `command`, `args` | `lake`, and arguments before `env lean ...` | `lake` |
| `projectDir` | the pinned Lean project, where the candidate's imports resolve; the host profiles take `LEAN_PROJECT_DIR`. Without it the implementation is unavailable | none |
| `program` | the Lean program | `lean/SeshatCertify/Main.lean` of this repository |
| `sandbox` | the command before every call | none |
| `workDir` | where work directories are made | the system's temporary directory |
| `timeoutSec` | the limit of a certification that gives none | 600 |
| `env` | variables added to the child's (`ELAN_HOME` from the host profiles) | none |

The Lean version it expects is the manifest's `environment.lean`. `pnpm harness health` runs the
version check. The contract (`capabilities/lean.certify/contract.json`) has 9 cases: a proof
without axioms, the three standard axioms, `sorry`, an axiom of the candidate's own,
`native_decide`, another statement under the same name, a changed definition under the same
statement, a file that does not compile, and a time limit. A test runs it against the answers a
certifier is expected to give, which only shows that the expectations are well written.

## In a run

A run certifies when it has a certifier: the one `RunOptions.certifier` gives, or else the host's
`lean.certify`, if the profile lists it (`RegistryLeanCertifier.forHost(registry)`, which goes
through the registry, so that every certification is a tool run). `run.started` records which one
(`config.certifier`, `null` for none). A host that lists the capability but cannot run it, because
`LEAN_PROJECT_DIR` is not set or Lean is not the pinned version, does not stop the run: each
certification fails, the candidates stay candidates, and each problem says why in its reason
(`certification failed: ...`). `pnpm harness health lean.certify` tells before a run does.

[m0-loop.md](m0-loop.md#certification) has what is certified, when, and what each answer does to the
claim and to the problem's outcome. In short:

- A problem's own candidate is certified when its provers are done. A certified proof makes the
  claim `proved`; a rejected one leaves it `computed`, with the reasons in the `kernel_replay`
  validation; no answer leaves it `computed` and records no verdict.
- The proofs and refutations that lines submit through `validate` take the same path. The ones for
  other claims, for negations (`negation: true`, which make a claim `refuted`), and any late proof of
  the problem's own claim are certified when the problem's `afterProblem` is over, one after the
  other. M2's composed proofs, its twin's proof and its composed refutations go through here:
  nothing distinguishes them from a prover's candidate.
- Each candidate is certified once per run, and a workbench keeps its first candidate: the
  problem's own, and one for each other claim and each negation a line submits proofs for. A line
  cannot make the run pay for certification after certification by submitting more proofs of one
  claim.
- The reference the certifier gets as `original` is never a file a line supplied: the problem's own
  file, or the claim's file rebuilt from its journaled statement and header
  ([memory.md](memory.md#reference-files)). For a refutation it is that file followed by the
  negation theorem, so that the target is compared with `¬ statement` as Lean elaborates it.
- A certified proof of a claim that is already settled the other way is a contradiction, not a
  status: the validation stays as evidence and the status does not move. The problem ends as
  `error` when it was its own candidate, and the run's log says so otherwise.

## Tests

`packages/lean-local/test` runs `LakeCertifier` against a fake `lake`
(`fixtures/fake-lake.ts`, a script that prints what the real one would: the version, a copy of the
source as the object file, a verdict chosen by a marker in the candidate): certified and rejected
candidates, a kernel refusal, a type that differs from the reference's, axioms outside the allowed
set, a program that lies about them, a file that does not compile, a reference that does not, Lean
or the program dying, the time limit with the process group killed, an abort, an unavailable or
wrong `lake`, the environment the child gets, and a sandbox command. `packages/registry/test` runs the
adapters (`leanCertifyImplementation`, `RegistryLeanCertifier`) and the contract.
`packages/orchestrator/test/certify.test.ts` runs the certification through the loop with fake
certifiers and with the registry ([m0-loop.md](m0-loop.md#tested-and-not-yet)), and
`packages/graph/test/line.test.ts` has M2's twin refute a claim with a certifier. None of them has a
Lean: what a real `lake` does is the list below.

## Deployment

The certifier needs the bench's Lean project built, as `lean.check` does
([lean.md](lean.md#deployment-for-the-bench)): Lean v4.27.0 through elan, and
`lake build` in the formal-conjectures checkout so that its object files exist.

```sh
export LEAN_PROJECT_DIR=/path/to/formal-conjectures
(cd lean/SeshatCertify && lake build)   # the first compile of the program; fix what it reports
pnpm harness health lean.certify
pnpm harness contract lean.certify --out certify-contract.json
```

To run the program by hand on two files, from the project directory:

```sh
lake env lean -o /tmp/ref.olean /tmp/ref.lean
lake env lean -o /tmp/cand.olean /tmp/cand.lean
echo '{"reference":"/tmp/ref.olean","candidate":"/tmp/cand.olean","target":"Ns.name","allowedAxioms":["propext","Classical.choice","Quot.sound"]}' > /tmp/request.json
lake env lean --run /path/to/seshat/lean/SeshatCertify/Main.lean /tmp/request.json
```

## To verify against Lean

1. That `lean/SeshatCertify` builds at v4.27.0: `readModuleData`, `importModules`,
   `Environment.replay`, `CollectAxioms.collect`, `Expr.getUsedConstants`, `findSysroot` and the
   `Json` functions, and the `BEq` instances of the constant structures it compares with `==`, were
   read from Lean's sources, not run.
2. That `lake env lean --run` interprets the program in a time that does not matter next to the
   compile, and that `Environment.replay` of a module of a formal-conjectures file, and of a big
   proof, takes the time and memory one expects.
3. That `lean -o x.olean x.lean`, outside a package, gives the two files the same main module name,
   so that the private names of a definition are the same in both; if it does not, a statement
   that depends on a private definition is rejected by the comparison.
4. That `lean` ends with 1 when the file has errors and 0 otherwise, and prints its messages on
   stdout, as the certifier assumes.
5. That the object files of the bench's project are found by `lake env` from `LEAN_PROJECT_DIR`
   without trying to fetch or build anything, which a sandbox without network does not allow.
6. The contract's nine cases, and the reasons' texts they match.
7. The sandbox: that a command such as the example above lets Lean run in the project and write
   only to `{work}`.

## Not done yet

- A certification that gave no answer is not tried again in the run, and neither is a rejected
  candidate's claim with another proof. A transient failure of the certifier therefore costs the
  candidate its certificate in that run, and nothing certifies the candidates of a finished run
  afterwards, though every file that was checked is in its blob store (by `submissionHash`).
- The reference is compiled for every certification. Caching it is safe only where nothing that ran
  untrusted code can write to the cache, so it waits for a sandbox that has been tried.
- The module is replayed whole, since `Environment.replay` takes a module's constants as a map.
  Replaying only what the target depends on would be faster for large candidates, with the care
  lean4checker takes over inductive types.
- A native implementation of the program as an executable (`lake build` makes one, which the
  harness does not use) would avoid interpreting it.
