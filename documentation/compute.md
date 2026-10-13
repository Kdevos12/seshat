# Computer algebra: SageMath

The capability `compute.sage` gives the provers a computer algebra system:
[SageMath](https://www.sagemath.org), the open-source counterpart of Mathematica and of the
computing side of Wolfram Alpha. It is reached through
[sagemath-mcp](https://github.com/XBP-Europe/sagemath-mcp) (MIT), an MCP server that runs Sage code
in worker processes behind an allowlist. Sage is an external program: each host installs it, in a
container or with pip, and the harness talks to it over stdio.

What Wolfram Alpha adds to the computing, questions in plain language and curated data, is not
part of it. The model writes Sage code itself, and data sources such as the OEIS or the LMFDB are
to be capabilities of their own.

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

## Not done yet

- The `docker` implementation has never been started (see above).
- The server's other tools, such as `evaluate_sage_streaming` and `interrupt_sage_session`, are
  not given to the provers, although Sage's timeout message names them.
- Whether the tool helps is not measured. That is an ablation: runs with and without
  `--tool compute.sage`, at equal budget.
- The data sources (OEIS, LMFDB) and the other classical tools of the plan are capabilities still
  to write.
