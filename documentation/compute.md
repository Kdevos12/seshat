# Computer algebra: SageMath and Python

Two stateful capabilities run the code a model writes: `compute.sage` (SageMath, below) and
`compute.python` (Python with numpy, scipy, sympy and solvers, on Pyodide,
[below](#python-on-pyodide-computepython)). "The host's compute tool" of `harness solve` is the
first of them the host offers and that answers: Sage where it runs, Python without it
([its rule](#the-hosts-compute-tool)).

The capability `compute.sage` gives the provers a computer algebra system:
[SageMath](https://www.sagemath.org), the open-source counterpart of Mathematica and of the
computing side of Wolfram Alpha. It is reached through
[sagemath-mcp](https://github.com/XBP-Europe/sagemath-mcp) (MIT), an MCP server that runs Sage code
in worker processes behind an allowlist. Sage is an external program: each host installs it, in a
container or with pip, and the harness talks to it over stdio.

What Wolfram Alpha adds to the computing, questions in plain language and curated data, is not
part of it. The model writes Sage code itself, and data sources such as the OEIS or the LMFDB are
capabilities of their own (`oeis.search`, `lmfdb.query`, [models.md](models.md#the-services-as-capabilities)).

## What a prover gets

With `harness run --tool compute.sage` ([m0-loop.md](m0-loop.md#other-tools)), each session has a
tool `compute_sage(code, timeout?)`. It returns the value of the code's last line, what the code
printed, and the time Sage took.

- Each attempt has its own Sage session. Its variables last from one call to the next within the
  attempt, and the session is stopped when the attempt ends (`stop_sage_session`). Provers share
  nothing, and the next session of a prover starts empty.
- A call stops after 60 seconds unless its `timeout` says otherwise, up to 300. When it stops,
  Sage restarts the worker and the session's variables are lost. The registry waits for the call's
  own limit plus 15 seconds, so Sage's message about the timeout reaches the model first.
- What the model reads about the tool is in `capabilities/compute.sage/`: `description.md`, and the
  manifest's `when`, `whenNot` and examples. `pnpm harness describe compute.sage` prints it.

Of the server's 40 tools, the harness uses two: `evaluate_sage` for the calls and
`stop_sage_session` to end a session.

## Installing it

### With Docker (preferred)

```sh
docker pull ghcr.io/xbp-europe/sagemath-mcp:0.9.5-passagemath@sha256:28f8bbb72a18da0b73fd22039a270c3e2e4441c05df02d28865545b28caf305e
pnpm harness health compute.sage
pnpm harness contract compute.sage --implementation docker
```

Pull the image first: a health check gives an implementation 15 seconds, and a first `docker run`
that downloads an image of several gigabytes takes longer.

The image is the passagemath variant of the server's release 0.9.5, pinned by its digest. It is
published for amd64 and arm64 (the default variant, on SageMath 10.10, is for amd64 only), and it
has the Sage that the contract ran against with the `local` implementation.

The `docker` implementation starts it with the hardening the server's documentation asks for, and
more:

| Flag | Why |
|---|---|
| `--network none` | stdio needs no network, and the model's code gets none. |
| `--read-only`, `--tmpfs /tmp` (512 MB), `--tmpfs /home/sage/.sage` (256 MB) | Nothing written outlives the container. |
| `--cap-drop ALL`, `--security-opt no-new-privileges` | No privileges inside the container. |
| `--pids-limit 512`, `--memory 6g` | Room for 24 sessions (one worker process each), and no more. |
| `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1` | Parallel provers do not each take every core. |

Not verified yet: the development environment has no Docker daemon and could not read the image's
configuration, so no container of this image has been started from the harness. The manifest sets
the entrypoint to `sagemath-mcp` with `--transport stdio`. `pnpm harness health compute.sage` on a
host with Docker settles it; if it fails there, a host profile can replace the implementation's
`args` ([capabilities.md](capabilities.md#host-profiles)).

### With pip (no Docker)

```sh
python3 -m venv ~/.venvs/sagemath-mcp       # Python 3.12 or later, on Linux or macOS
~/.venvs/sagemath-mcp/bin/pip install "sagemath-mcp[passagemath]==0.9.5"
export SAGEMATH_MCP_COMMAND=~/.venvs/sagemath-mcp/bin/sagemath-mcp
pnpm harness contract compute.sage --implementation local
```

The `[passagemath]` extra brings a pip-built SageMath (passagemath 10.8.12); the environment took
4.2 GB here, with Python 3.13. The server's documentation also gives conda-forge, next to its
SageMath 10.9 (`conda install -c conda-forge "sagemath-mcp>=0.9.4" sage`). The manifest pins the
server's version 0.9.5, and the contract says whether that Sage answers the same.

The `local` implementation starts `sagemath-mcp` as a child process, so the model's code runs as
your user, with the server's own checks (its allowlist of names, no imports, no file access) as
the only barrier. The `local` host profile uses it when Docker cannot be reached; the `server`
profile does not use it.

### Settings

| Setting | Where | Value |
|---|---|---|
| `SAGEMATH_MCP_COMMAND` | environment, read by the `local` host profile | The `sagemath-mcp` command; default `sagemath-mcp` on the `PATH`. |
| `SAGEMATH_MCP_EVAL_TIMEOUT` | the manifest, for both implementations | 60: seconds per call when the call gives no `timeout`. |
| `SAGEMATH_MCP_MAX_STDOUT` | the manifest | 20000: characters of printed output kept per call. |
| `SAGEMATH_MCP_MAX_SESSIONS` | the manifest | 24: sessions open at the same time. |

The server's process receives no variable of the harness's environment besides those that
programs need to start ([capabilities.md](capabilities.md#implementations)), so the model
providers' keys never reach the process that runs the model's code.

### Resources

Measured with the `local` implementation:

- Each session is a worker process of about 220 MB. Four open sessions took about 1.3 GB with the
  server, and releasing them brought it back to 0.4 GB. A run has one session per prover at work:
  `provers × concurrency`.
- The server keeps one worker ready. A new session's first call answers at once when it gets that
  worker, and otherwise waits 1.3 to 3.5 seconds for one to start. Later calls take the time of the
  computation, 10 to 50 ms for small ones.

## What it offers, and what it refuses

Measured with sagemath-mcp 0.9.5 and passagemath 10.8.12; the contract checks most of it.

| Area | Works |
|---|---|
| Number theory | PARI and FLINT through Sage: `factor`, `prime_pi` (not `primepi`), `euler_phi`, `bernoulli`, number fields (`K.<a> = NumberField(x^3 - 2)`, `K.class_number()`), finite fields. |
| Groups | GAP's groups and its small groups library through Sage's constructors: `SmallPermutationGroup(n, k)`, `SymmetricGroup(5)`. |
| Graphs and orders | nauty (`graphs(n)`, `graphs.nauty_geng("6 -c")`), named graphs (`graphs.PetersenGraph()`), `Posets(n)`. |
| Sequences | `sloane.A000045(10)`: Sage's own code for some OEIS sequences, offline. |
| Calculus | Maxima through Sage: `sum`, `integrate`, `limit`, `solve`. |
| Solvers | `SAT()`, `MixedIntegerLinearProgram`. |
| Linear algebra | Exact matrices over `ZZ`, `QQ`, finite fields and number fields. |

Refused, each with a message that says what to use instead: imports (an `import` whose name is
used; one that is never used is dropped without a word), `open` and so the files, the interfaces that
start other programs (`gap(...)`, `libgap`, `pari(...)`, `maxima(...)`), `show` and the OEIS
(`oeis`). `plot(...)` runs but comes back as one line of text.

Names in a session:

- `x`, `y`, `z` and `t` are symbolic variables from the start.
- Any other letter with an optional index (`w`, `k1`, `x_2`), or the name of a Greek letter, that
  the session has not assigned becomes a symbolic variable when the code uses it. So in a new
  session `G.order()` calls a method of a symbol and fails, sometimes with an empty message.
- Any other name the session has not assigned is refused: "'petersen' is not a name this server
  offers". The description asks the model for names of two letters or more, so that a name lost
  with an earlier session shows as this refusal.

Errors come back with Python's message, without the exception's type.

## The contract

`capabilities/compute.sage/contract.json` has 16 cases: exact arithmetic, the value of the last
line and the printed output, statements, variables within a scope, a new scope that starts empty,
the symbols that unassigned letters become, graph enumeration, the small groups library, number
theory, symbolic sums, exact linear algebra, a SAT solver, error messages, refused imports and
files, and the call's own time limit. They passed on 2026-10-13 with the `local` implementation
(sagemath-mcp 0.9.5, passagemath 10.8.12, Python 3.13, Linux x86-64), against which the
expectations were written. The `docker` implementation has not run them yet.

One run, the first of a morning after the machine sat idle for the night, had two failing cases
whose messages were not kept. The 15 runs after it passed, one of them with a cold file cache and
two under load, and so did 40 sessions opened and ended in a row. The cause is not known. When a
case fails, run the contract again with `--out FILE` to keep every output.

## Python on Pyodide (`compute.python`)

Plan change CX3 (Ruling 47): a compute tool for the machine that has neither Docker nor a 4 GB
SageMath, such as a student's laptop. `compute.python` runs Python 3.14 code in
[Pyodide](https://pyodide.org) (MPL-2.0), CPython compiled to WebAssembly, with the packages
Pyodide ships for it: numpy, scipy, sympy, networkx, mpmath, python-sat, highspy, clarabel and gmpy2.
It is the same kind of tool as `compute.sage`: `direct`, stateful, the input `code` and an optional
`timeout` (60 seconds by default, at most 300), and the output `result_type`, `result` (Python's
`repr` of the last line's value), `stdout` and `elapsed_ms`. Its implementation `pyodide` (factory
`pyodide`, in `@seshat/registry`, `python.ts` and `python-child.ts`) needs no program besides the
Node that runs the harness, and no Python on the machine.

### What a prover gets

- Each scope has its own interpreter, in a Node process of its own: an attempt's calls share their
  variables, and the interpreter is stopped when the attempt ends, by the same scope rule as Sage's
  (`capabilityTool` passes the attempt as the scope, the prover releases it). Each contract case and
  each health check has a scope of its own too.
- A module the code imports from the package set is loaded on that call, from the local copy; a
  module outside the set is an `ImportError`. The time a package takes to load counts in the call's
  time limit (scipy and clarabel take a few seconds on a first import).
- A call past its `timeout` cannot be interrupted inside WebAssembly, so its process is killed: the
  call fails with "timed out after N s: the interpreter was stopped, and this session's variables
  were discarded", and the next call of the scope starts a new, empty interpreter. A process that
  dies (its JavaScript heap full) fails the call the same way, with "it ran out of memory".
- At most `maxSessions` interpreters are open at once (8 by default); a call in a new scope beyond
  them fails at once, it does not wait, until one is released. The limit is the registry's, so it is
  shared by everything of one run that calls `compute.python`: the provers' attempts that have it
  (CA17), the certificate stage of line M10 (one scope per goal, released when the goal is done) and
  the first cases of a statement. A run whose `concurrency` times the provers of a problem can
  exceed 8 at once raises it in the host profile
  (`capabilities.compute.python.settings.pyodide.maxSessions`); each interpreter holds up to
  `memoryMb` plus `heapMb` of memory, so the machine's memory bounds it.
- An interpreter whose harness died ends itself: idle, when its standard input closes; busy in
  Python code, when Pyodide next reads its interrupt buffer (every few bytecodes), which checks at
  most once a second that its parent process is still the one that started it. A loop inside a
  compiled library (numpy, a solver) reads no buffer until it returns, so such a call can outlive
  the harness by its own length.

### What isolates it

Each interpreter is a Node process started with:

| What | How |
|---|---|
| Files | `--permission`, with `--allow-fs-read` on the child script, Pyodide's directory and the scratch directory only, and `--allow-fs-write` on the scratch directory only. Python itself sees its own in-memory file system, with the scratch directory mounted at `/scratch` as its working directory; the host's files are not there. |
| Processes and workers | refused by `--permission` (no `--allow-child-process`, no `--allow-worker`); `process.kill`, `process.execve` and `process.dlopen` throw once the process is sealed. |
| Environment | empty (Windows keeps `SystemRoot`): none of the harness's keys reaches the process that runs the model's code. Python's `HOME` is `/scratch`. |
| JavaScript | Pyodide is given an empty object as its `js` module, and `js` and `pyodide_js` are unregistered. Every module that reaches JavaScript is refused to the call's code by prefix: `pyodide` and its submodules (`pyodide.ffi`, `pyodide._core`, `pyodide.http`, ...), `_pyodide` and its submodules, `_pyodide_core` (which holds `to_js` and `create_proxy`), `js` and `pyodide_js`. Pyodide's own modules are imported first, so that what Pyodide runs later to load a package has its names; then they are removed from `sys.modules` (again before each call), and the attributes of other modules that hold one of them or one of their functions or classes are deleted. The refusal is an import hook (`builtins.__import__` and a finder first on `sys.meta_path`) that lets an import through only when the code asking for it is itself one of Pyodide's modules. |
| Network | the process is sealed once Pyodide is loaded and before any Python runs (`seal` in `python-child.ts`), because Node 22's permission model does not restrict the network and JavaScript that Python reaches past the import guard could otherwise import `node:net`: a module loader hook refuses `net`, `tls`, `dgram`, `dns`, `http`, `https`, `http2`, `child_process`, `cluster`, `worker_threads`, `inspector` and `module` (dynamic `import()` included); `process.getBuiltinModule`, `process.binding` and `process._linkedBinding` throw and cannot be put back (before Pyodide loads, `process.binding`, which the permission model refuses outright, answers only `"constants"` with `node:fs`'s open flags, the one call Pyodide's Emscripten file system makes while it loads); the globals that reach the network (`fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, and `fetch`'s dispatcher) are deleted. Pyodide's socket file system is not turned on; packages are read from the local copy, never downloaded (`packageBaseUrl` is the local directory). |
| Memory | Python's memory is WebAssembly memory, capped at `memoryMb` (2048 MB): a growth past it is refused, which Python sees as a `MemoryError`, and the session lives on. The JavaScript heap is capped by `--max-old-space-size` at `heapMb` (1024 MB); past it the process dies and the call fails. |
| Time | the call's `timeout`, then the process is killed. |

This guards against the mistakes of code a model wrote (a loop, a large allocation, a stray `open`
or `import js`), not against code written to escape, like the JavaScript sandbox of `runValues`
([induction.md](induction.md#the-sandbox-for-programs)): the import guard is Python code that Python code could
undo (Pyodide's modules stay reachable through the live objects, `gc.get_objects()`, which is why the
process is sealed as well), the seal closes the routes to a socket that Node 22 has but cannot stop
JavaScript from writing to the process's own standard output, and WebAssembly is not a security
boundary that this project has audited. `--disallow-code-generation-from-strings`, which would refuse
`Function("...")` itself, is not set: whether Pyodide's loader and its packages run without
generating code from strings has to be checked on a real Pyodide first (see "Not done yet"). Nothing a call
returns changes a claim: its output is `computed` evidence at most, as Sage's is.

### Installing Pyodide

Pyodide is not a dependency of the harness: no package of the repository installs it. The host
profile points at a local copy of the pinned release with its packages, and without one
`compute.python` is unavailable, and `harness health` says how to install it:

```sh
# Pyodide 314.0.7 (Python 3.14.2), the release the manifest pins, with its package wheels.
curl -LO https://github.com/pyodide/pyodide/releases/download/314.0.7/pyodide-314.0.7.tar.bz2
tar -xjf pyodide-314.0.7.tar.bz2              # a directory pyodide/ with pyodide.mjs and the wheels
export PYODIDE_DIR=$PWD/pyodide
pnpm harness health compute.python
pnpm harness contract compute.python
```

The directory must hold `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`,
`python_stdlib.zip`, `pyodide-lock.json` and the wheels of the package set and of their
dependencies. The npm package `pyodide@314.0.7` has only the first five, so it is not enough on its
own; the wheels can be added next to them from the release's `full/` directory
(`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`), by the file names `pyodide-lock.json` gives. The package set, with the versions of that release's lock file:

| Package | Version | For |
|---|---|---|
| numpy | 2.4.6 | arrays, linear algebra |
| scipy | 1.18.0 | sparse matrices, optimization (clarabel needs it) |
| sympy | 1.14.0 | exact and symbolic algebra, Gröbner bases (`groebner`), `rsolve`, `nsimplify` |
| networkx | 3.6.1 | graphs |
| mpmath | 1.4.1 | arbitrary precision, `identify` |
| python-sat | 1.8.dev26 | SAT solvers (`pysat.solvers`) |
| highspy | 1.13.1 | linear and mixed-integer programming (HiGHS) |
| clarabel | 0.11.1 | conic and semidefinite programming |
| gmpy2 | 2.3.0 | fast big integers and rationals |

Not verified: the archive's name and its layout are those of Pyodide's earlier releases; the
versions above were read from the lock file of the npm package `pyodide@314.0.7`. No interpreter
of this release has been started from the harness (see "Not done yet").

### Settings

Settings of the implementation `pyodide`, in the host profile (`capabilities.compute.python.settings.pyodide`):

| Setting | Default | Value |
|---|---|---|
| `pyodideDir` | `""` (the `local` profile: `PYODIDE_DIR`) | The directory of the local Pyodide copy. Empty or without `pyodide.mjs`: the implementation is unavailable. |
| `versionCheck` | `true` | Refuse a Pyodide whose version is not the manifest's (314.0.7), as the MCP implementations refuse another server version. |
| `memoryMb` | 2048 | Python's WebAssembly memory. |
| `heapMb` | 1024 | The process's JavaScript heap (`--max-old-space-size`). |
| `maxSessions` | 8 | Interpreters open at once. |
| `timeoutSec` | 60 | Seconds per call when the call gives no `timeout`. |
| `startSec` | 60 | Seconds an interpreter may take to start. |
| `maxStdout` | 20000 | Characters of printed output kept per call. |

### The host's compute tool

The `local` profile offers both tools: `compute.sage` (Docker, then a local install) and
`compute.python`, marked `optional` so that `harness health` shows a missing Pyodide as a warning.
The `server` profile offers Sage in Docker only: the dedicated server has Docker and the full Sage,
and the plan names `local` alone for Pyodide; a server that wants it adds the same entry.

`harness solve --auto-tool` (and the `v2` defaults, and the bench arms of `harness ablate`) give a
problem "the host's compute tool" (CA17, `RunConfig.autoTool`): the first of `COMPUTE_TOOLS`
(`compute.sage`, then `compute.python`, in `@seshat/classical`'s `compute.ts`, which the orchestrator's
`tools.ts` re-exports) that the host offers. The same file orders the tools for a caller that needs a
package only one of them has (`computeOrder(["clarabel"])` puts `compute.python` first, for line M10's
certificate stage; `computeOrder(["pysat"])` does the same for line M11's SAT encoders, plan change CX6,
[models.md](models.md#sat-encoders)), and its `registryCompute` passes to the next tool when a call finds one unavailable.
A call's code may be one text, or a text per capability (`ComputeCode`, such as `{ "compute.python": ..., "compute.sage":
... }`) when the code differs between the two: Sage refuses every `import`, so Python code that imports a module
cannot run there. The tool then runs the text written for the capability that answers, passes over one the code has none
for (without marking it unavailable), and throws `ComputeUnsuited`, with nothing sent, when the only tools left have
none: line M10's sums of squares, whose program needs clarabel, is skipped that way on Sage alone
([classical.md](classical.md#the-certificate-stage-plan-change-cx4)). When the run pins its
tools at its start and that tool does not answer, the next one the host offers takes its place
(`computeFallbacks`, `pinTools`): the run logs "compute.sage cannot be reached ...: compute.python is
used in its place" and records `compute.python` as its `autoTool`; the prompt's hash in `run.started`
(`config.prompt`) is taken after the tools are pinned, so it names `compute_python`, the tool the
provers get. Sage stays the tool wherever it
answers. The first cases the harness computes for a parameterised statement
([induction.md](induction.md#the-first-cases-the-harness-pushes)) go through whichever of the two the
run has; for Python their code first imports `comb` (as `binomial`), `factorial` and `prod` from
`math`, the built-ins Sage has. Lines M8, M11 and M16, whose code is Sage's, still need
`compute.sage` (CX8 moves M8's guessing to Python).

### Its contract and tests

`capabilities/compute.python/contract.json` has 19 cases: exact arithmetic, the last line and what
was printed, a statement, variables within a scope, a new scope that starts empty, a sympy Gröbner
basis, a python-sat model, a clarabel SDP, an error message, the call's own time limit, the memory
limit (run with `memoryMb` 256, the case's own `settings`, and an allocation of 400 MB that only the
cap refuses), `import js`, `pyodide.ffi`, `_pyodide_core` and `pyodide._core` refused, no socket from
JavaScript reached past the import guard, no network, no file outside the scratch directory, and
files in it. They need the real Pyodide: `pnpm harness contract compute.python` on a host with
`PYODIDE_DIR`, and `packages/registry/test/python.test.ts` runs them when `PYODIDE_DIR` is set and
skips them otherwise. They have not run: the expectations of the sympy, python-sat and clarabel
cases are written from those libraries' documentation, and whether Pyodide's clarabel has its
semidefinite cone is what the SDP case checks.

`pnpm test` runs the implementation against a stand-in for Pyodide
(`packages/registry/test/fixtures/pyodide/pyodide.mjs`, a module with Pyodide's `loadPyodide` that
runs a toy language): the protocol, scopes and their release, the time limit, a process that runs
out of memory, the WebAssembly cap, the empty environment, the file permissions of the real
`--permission` process, the deleted `fetch`, the seal (the stand-in reaches `process` through
`[].constructor.constructor` and tries `getBuiltinModule`, `binding`, `fetch` and `import()` of
`node:net`, `node:http` and `node:module` against a server of the test, which sees no connection,
while the same route outside the sandbox connects), an interpreter busy in a loop that ends itself
when its parent is killed, the version check, `maxSessions`, and health without Pyodide. The Python
every interpreter runs first (`PYTHON_PRELUDE`: the import guard and the function that runs a call)
is plain Python, and the same test runs it on the machine's `python3` when it has one, with a copy of
Pyodide's module layout as files (`pyodide`, `pyodide.ffi`, `pyodide._core`, `_pyodide`,
`_pyodide_core`): every import of them from the call's code is refused, a library's name bound to
`to_js` is deleted, and a late import of Pyodide's own still works. `packages/orchestrator/test/compute-python.test.ts` covers the host's compute tool: the
choice, the fallback when Sage does not answer, a `solve` that records `compute.python`, and the
first-cases code run by a `python3` when the machine has one.

## Not done yet

- `compute.python` has never run against the real Pyodide: its contract, its health on Linux, macOS
  and Windows, and the time Pyodide and its packages take to load. To check there besides: that
  loading a package (scipy, clarabel) still works with every module of Pyodide's refused and removed
  from `sys.modules` (a late import of Pyodide's that the guard does not recognise as Pyodide's would
  be refused), that Pyodide reads the orphan watch's interrupt buffer (`setInterruptBuffer`), and
  whether the process runs with `--disallow-code-generation-from-strings`, which would close the
  `Function("...")` route the seal now only narrows. CI runs only the fast checks
  (`.github/workflows/check.yml`); the plan's acceptance asks for health and contract on the three
  systems in CI, which needs the Pyodide download in the workflow.
- The `docker` implementation has never been started (see above).
- The server's other tools, such as `evaluate_sage_streaming` and `interrupt_sage_session`, are
  not given to the provers, although Sage's timeout message names them.
- Whether the tool helps is not measured. That is an ablation: runs with and without
  `--tool compute.sage`, at equal budget.
- The data sources are capabilities of their own now (`oeis.search`, `lmfdb.query`,
  `findstat.identify`, [models.md](models.md#the-services-as-capabilities)); the other classical tools
  of the plan are still to write.
