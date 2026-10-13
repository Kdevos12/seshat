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
  certify(request: { original: string; candidate: string; target: string; allowedAxioms: readonly string[] }): Promise<{ verdict: "certified" | "rejected"; reasons: string[]; axioms: string[]; timeMs: number }>;
}
```

## Kimina Lean Server

`@math-harness/lean-kimina` implements `LeanChecker` over
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
const checker = new KiminaChecker({ url: "http://localhost:8000", apiKey: process.env.LEAN_SERVER_API_KEY, version: "2.0.0+lean-v4.27.0" });
```

`url` and `apiKey` default to `LEAN_SERVER_API_URL` and `LEAN_SERVER_API_KEY`. With
`LEAN_SERVER_API_URL` set, `pnpm test` also runs a live check against that server.

## Deployment for the bench

The bench is pinned to formal-conjectures `bench-v1-lean4.27.0` ([bench.md](bench.md)), so the
server needs Lean v4.27.0 and a built checkout of that tag as its project. This recipe follows the
server's `setup.sh`; it has not been run yet:

```sh
git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git
cd formal-conjectures && lake exe cache get && lake build && cd ..

git clone https://github.com/project-numina/kimina-lean-server.git && cd kimina-lean-server
LEAN_SERVER_LEAN_VERSION=v4.27.0 REPL_BRANCH=v4.27.0 ./setup.sh   # Lean, the REPL, a Mathlib project
export LEAN_SERVER_PROJECT_DIR=/path/to/formal-conjectures
export LEAN_SERVER_API_KEY=...            # any secret; the harness sends it
python -m server
```

The prebuilt image `projectnumina/kimina-lean-server:2.0.0` targets Lean v4.26.0 and a plain
Mathlib project, so it does not fit as is. The same build works on a workstation and on the
dedicated server; only `LEAN_SERVER_API_URL` changes in the harness.

## The certifier (to write)

A small Lean program, run in a fresh process for each candidate:

1. Compile the original file and the candidate with `lake env lean -o`.
2. Load the candidate's compiled module, import its imports, and replay its declarations through
   the kernel (`Lean.Environment.replay`, as lean4checker does).
3. Check that the target exists, that its type equals the original's target type as a term, and
   that the axioms it depends on, collected by walking the replayed environment, are allowed.

The reference module is compiled once per problem from the pristine file. The candidate is
compiled in a sandbox without network and with read-only access to the reference.

## To verify against Lean

These depend on Lean's exact behaviour and are covered only by simulations so far:

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
