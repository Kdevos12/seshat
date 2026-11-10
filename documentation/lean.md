# Lean checkers

## Interfaces

The core depends on two interfaces (`packages/core/src/lean.ts`); implementations live in their own
packages and are chosen by configuration.

`LeanChecker` runs snippets in a Lean REPL:

```ts
interface LeanChecker {
  readonly implementation: string; // recorded in every tool run
  readonly version: string;
  check(snippets: readonly LeanSnippet[], options?: { timeoutSec?: number; signal?: AbortSignal }): Promise<LeanCheckResult[]>;
}
```

It returns one result per snippet, in order. Each result has a status, the messages (severity,
position, text), the remaining `sorry`s with their goals, the time, and an `error` when Lean gave
no answer:

| Status | Meaning |
|---|---|
| `valid` | No error and no `sorry`. |
| `sorry` | No error, at least one `sorry`. |
| `lean_error` | At least one message of severity `error`. |
| `repl_error` | The REPL refused the command. |
| `timeout` | The time limit was reached. |
| `server_error` | The server or the network failed. |

A failure of the server is a result, never an exception: the caller decides whether to retry and
does not count it against the prover.

`LeanCertifier` certifies a candidate in a fresh process ([trust.md](trust.md#two-levels-of-checking)):

```ts
interface LeanCertifier {
  certify(
    request: { original: string; candidate: string; target: string; allowedAxioms: readonly string[] },
    options?: { timeoutSec?: number; signal?: AbortSignal },
  ): Promise<{ verdict: "certified" | "rejected"; reasons: string[]; axioms: string[]; timeMs: number }>;
}
```

A call that reaches no verdict (the time limit, an abort, no Lean, a project in which nothing
compiles, a failure of the checking program) throws `CertifyFailedError` instead of answering `rejected`: it says nothing about the
candidate ([certifier.md](certifier.md#what-it-answers)).

## Kimina Lean Server

`@seshat/lean-kimina` implements `LeanChecker` over
[Kimina Lean Server](https://github.com/project-numina/kimina-lean-server) 2.x. The wire format
below was read from the server's source (commit `fb2393de`, January 2026).

- `POST /api/check` with `{"snippets": [{"id", "code"}], "timeout": <seconds>, "debug": false, "reuse": true}`
  and `Authorization: Bearer <key>` when the server has a key.
- The answer is `{"results": [...]}`. A result has either `error` (a timeout when it contains
  "timed out") or `response`. A response is either `{"message"}` (a REPL error) or
  `{"messages", "sorries"}`, where a message has `severity`, `pos`, `endPos` and its text in `data`.
- The server cuts each snippet into a header (the leading `import` and blank lines) and a body. It
  keeps one REPL per header, so the imports are loaded once, and it shifts the body's positions
  back, so the lines in the answer are the lines of the snippet as sent. A file in plain-header
  form ([validator.md](validator.md#plain-header-form)) therefore gets its own line numbers.
- All `import Mathlib...` lines of a header are merged into a single `import Mathlib`.

The client retries after a network failure, a 429 (no free REPL) or a 5xx, waiting 1, 2, then 4
seconds; any other HTTP error is reported at once. Results are matched to snippets by id; a missing
one is a `server_error`. The HTTP request is abandoned 30 seconds after the Lean timeout.

```ts
const checker = new KiminaChecker({ url: "http://localhost:8000", apiKey: process.env.LEAN_SERVER_API_KEY, version: "fb2393de+lean-v4.27.0+fc-bench-v1" });
```

`url` and `apiKey` default to `LEAN_SERVER_API_URL` and `LEAN_SERVER_API_KEY`. With
`LEAN_SERVER_API_URL` set, `pnpm test` also runs a live check against that server.

The harness does not build a `KiminaChecker` itself: the registry does, through the factory
`kimina` (`kiminaFactory`), with the settings of the host profile (`url`, `apiKey`, `timeoutSec`,
`httpSlackMs`, `retries`; an empty `apiKey` sends no key) and the version pinned in
`capabilities/lean.check/manifest.json` ([capabilities.md](capabilities.md#leancheck)).

## Bounded checks

Three optional settings of a host profile (`config/hosts/HOST.json`, top level) concern the Lean checks; a profile that gives none
behaves as before:

| Setting | Default | Meaning |
|---|---|---|
| `checkTimeoutSec` | 120 | The seconds a prover's Lean check may take, for a run that turns the bound on (`RunConfig.checkTimeoutSec`; `harness solve`'s defaults set `v2` does, `harness run` does not). It bounds the provers' checks only: the validator's policy (300 s) and the certifier keep their limits. A check that passes it answers "Lean did not finish within the time limit" and costs the session one turn, not 900 s. |
| `healthTimeoutMs` | 15000 | How long `harness health` waits for one implementation; raise it for a cold laptop. |
| `leanServerMemoryWarnMb` | 8192 | The resident memory of the Lean server past which `harness doctor` warns. |

`healthTimeoutMs` and `leanServerMemoryWarnMb` are diagnostics: they are left out of the registry's hash, so changing them does not
make a recorded run unresumable. `checkTimeoutSec` is in it.

## Memory of the Lean server

Kimina keeps REPLs with Mathlib loaded, and by default never recycles one (`MAX_REPL_USES` unset), so a long run grows the server until the
machine swaps and checks time out. `harness doctor` ([quickstart.md](quickstart.md#harness-doctor)) prints the settings that fit the machine's
memory (`kiminaSettingsFor` in `lean-memory.ts`): about 60% of the memory is the server's, one REPL per 4 GB of it (`MAX_REPLS`, at least 1 and
at most 32), `MAX_REPL_MEM` the share of each, and `MAX_REPL_USES` 50 on a machine under 32 GB and 100 above. They are working figures, not
measurements. It also warns when the server's resident memory passes the host's `leanServerMemoryWarnMb` (default 8 GB).

The server's memory is read from the process table (`ps -eo rss=,args=`: the processes of a Kimina server and its `repl` processes, summed),
and only when `LEAN_SERVER_API_URL` is empty or points at this machine. Any failure (no `ps`, a server elsewhere, no such process) gives no
number, and no number gives no warning. The reader is a member of `DoctorSystem` (`leanServerMemoryMb`), so a test gives its own.
`harness lean-server start`, which would start Kimina with these settings under a memory cap, is not built (Ruling 33): the advice comes first.
The names of the settings are the plan's; whether the server reads them with a prefix of its own has not been checked against a real Kimina.

## Deployment for the bench

The bench is pinned to formal-conjectures `bench-v1-lean4.27.0` ([bench.md](bench.md)), so the
server needs Lean v4.27.0 and a built checkout of that tag as its project. The project can be the
environment `base` ([lean-env.md](lean-env.md)), which the harness resolves and builds itself and
which is the one place that says which Lean a run used:

```sh
pnpm harness lean-env resolve base     # checks the packages agree, writes lean/env/base/ and its lock
pnpm harness lean-env build base       # lake exe cache get, lake build; needs Lean through elan
export LEAN_SERVER_PROJECT_DIR=$PWD/lean/env/base
```

Or by hand. This recipe follows the server's `setup.sh`; neither has been run yet:

```sh
git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git
cd formal-conjectures && lake exe cache get && lake build && cd ..

git clone https://github.com/project-numina/kimina-lean-server.git && cd kimina-lean-server
LEAN_SERVER_LEAN_VERSION=v4.27.0 REPL_BRANCH=v4.27.0 ./setup.sh   # Lean, the REPL, a Mathlib project
export LEAN_SERVER_PROJECT_DIR=/path/to/formal-conjectures
export LEAN_SERVER_API_KEY=...            # any secret; the harness sends it
python -m server
```

Then, from the harness, with the same `LEAN_SERVER_API_URL` and `LEAN_SERVER_API_KEY`:

```sh
pnpm harness health                          # the server answers
pnpm harness contract lean.check --out lean-contract.json
```

The prebuilt image `projectnumina/kimina-lean-server:2.0.0` targets Lean v4.26.0 and a plain
Mathlib project, so it does not fit as is. The same build works on a workstation and on the
dedicated server; only `LEAN_SERVER_API_URL` changes in the harness.

The Lean meta tool (`lean.meta`) runs on the same server, and needs the library `lean/SeshatMeta`
built in the project ([lean-meta.md](lean-meta.md#deployment)). That library has never been
compiled. `lean.goals` runs Pantograph's REPL on the harness's machine, in the same project, and so
does `lean.lsp`, which runs lean-lsp-mcp on it ([lean-lsp.md](lean-lsp.md#installing-it)).

## The certifier

`@seshat/lean-local` implements `LeanCertifier` with `lake`, and the Lean library
`lean/SeshatCertify` replays the compiled files. For each candidate, in fresh processes of the
project above:

1. Compile the candidate and the reference with `lake env lean --root=DIR -o`, each as
   `SeshatTarget.lean` in a directory `DIR` of its own, so that the two modules have the same name.
2. Load the candidate's compiled module, import its imports, and replay its declarations through
   the kernel (`Lean.Environment.replay`, as lean4checker does).
3. Check that the target exists, that its type equals the reference's target type as a term, with
   the definitions it depends on, and that the axioms it depends on, collected by walking the
   replayed environment, are allowed.

It is the capability `lean.certify`, on the host through `LEAN_PROJECT_DIR` (the project above).
[certifier.md](certifier.md) has the process, the sandbox the compile should run in, the settings
and the deployment. It has run against a real Lean v4.27.0 on one Mathlib theorem
([certifier.md](certifier.md#what-ran-against-a-real-lean)), not on a bench problem.

A run uses it without being asked when the host's profile lists `lean.certify` (the default
profiles do): it certifies each problem's candidate, and the proofs and refutations the lines submit
([m0-loop.md](m0-loop.md#certification)). Where the project is not set up, or the profile has
neither a sandbox command nor `unsandboxed: true` (neither default profile has one), the
certifier is unavailable: every candidate stays a candidate and its problem says why.

## To verify against Lean

These depend on Lean's exact behaviour and are covered only by simulations so far. The contract
of `lean.check` checks each of them against a server
([capabilities.md](capabilities.md#leancheck)):

1. The text of `#print axioms` (`'X' depends on axioms: [...]` and `'X' does not depend on any
   axioms`), also for names with `«»` parts such as `Arxiv.«1609.08688».maximalLength_le`.
2. The line Lean gives the `#check` message under `set_option ... in`; the validator accepts any
   info message after the axioms line, as long as there is exactly one.
3. That the option `pp.maxSteps` exists in Lean v4.27.0.
4. That the REPL at v4.27.0 and the server's header split work with formal-conjectures files,
   including files that import other problem files.
5. That formal-conjectures' linters only emit warnings in the REPL (warnings do not fail a check).
6. Timings: the first REPL for a header loads all of Mathlib; `LEAN_SERVER_INIT_REPLS` can start
   REPLs ahead of time.
7. The first words of Lean's error messages (`unsolved goals` followed by `case <name>`,
   `unknown identifier`, `type mismatch`, `linarith failed`...), which classify a failed check
   ([m1-identity-memory.md](m1-identity-memory.md#failure-classes)); a message not matched is
   `other`.
8. The Lean meta tool, from building SeshatMeta on: [lean-meta.md](lean-meta.md#to-verify-against-lean).
9. For `lean.lsp`: what depends on the language server and on the search sites, listed in
   [lean-lsp.md](lean-lsp.md#to-verify-against-lean).
10. The certifier, from building SeshatCertify on: [certifier.md](certifier.md#to-verify-against-lean).
