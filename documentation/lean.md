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

## Search pushed by the harness

Plan change CA22, Task 40; `@seshat/lean-search`, the capability `lean.search` ([capabilities.md](capabilities.md#leansearch)), the option
`RunConfig.leanSearch` (`harness run --lean-search`, `harness solve --lean-search`; off in `harness run` and in both `solve` defaults sets).
Agents ignore lookup tools they must call, and hallucinated names are a third to a half of cheap models' errors: so the harness itself
searches, and puts what it finds into the answer to the check.

**When.** After a check that did not accept the file (the answer's `appendToCheck` hook of the session, `SessionOptions`; the same for
`lean_check` and `lean_edit`), at most three queries, in this order: each `unknown identifier 'NAME'` or `unknown constant 'NAME'` of the
report, with the missing name as the query (kind `name`); then each hole, with its goal as the query (kind `goal`; the last 500 characters,
which hold the target). A query is made once a check. Each query asks `lean.search` for at most five hits. The three numbers are constants of
`push.ts` (`MAX_QUERIES`, `MAX_HITS`) and `MAX_GOAL_QUERY_CHARS`.

**Checked before it is shown.** A hit is a name that a backend says exists, perhaps in another Mathlib. For the candidates of one answer the
harness makes one Lean call through the registry's `lean.check`, the same service the workbench uses: the imports of the checked file, then
`#check NAME` for each name, with a limit of 30 s. A name that Lean answers with an error at its line is dropped. If the call fails, times out
or throws, no hit is shown at all: an unverified name never reaches the model, and nothing of that call is remembered. A name that is
verified, or found missing, is kept for the run by the imports it was checked under, so a name is checked once per run and environment.
A name that is not the shape of a Lean name (one token, letters, digits, `_`, `'`, `.`, `!`, `?`, subscripts, `«»`) is dropped before it is
ever put in a Lean file, so that a backend cannot send a command through the name.

**What the model sees: Lean's text, not the backend's.** The section shows, for each hit, the name and signature that Lean printed for
`#check`, on one line and cut at 300 characters. The text that a backend returned (a type, a doc string, a description) is third-party text.
It ranks hits inside the local index and goes no further: the capability's answer holds names only, and the section is made from Lean's
output alone. It never enters a system prompt, a lesson, a note or the memory, and the model is told the section is the harness's, checked
with Lean. Global Constraint 16 (as amended): text from an external source never becomes part of a prompt or a lesson.

**The section.** It is appended to the answer after Lean's own, titled "Declarations that exist in this environment", with the hits under
the query that found them ("For unknown name `foo`:", "For hole 1:"), a name once. It is cut at a hit boundary at 1,200 characters
(`MAX_SECTION_CHARS`, the title included), so an answer is at most `formatCheck`'s bound plus that. It is not in the check's one-line summary
(`details.summary`), so [the masked form of an old check](m0-loop.md#masked-old-checks) does not keep it: the hits of a check that has aged out
of the last four are gone with the rest of its text. The journal keeps the checks as before and no event is added: the search is a tool run
of `lean.search` (actor `lean.search`) and the verification a tool run of `lean.check` (actor `lean.search`), neither attributed to the
attempt, so the loop telemetry's check times stay the provers' own. A hit is not a claim and changes no status.

**Once a run, once a session.** A query `(kind, query)` is sent to the backends once a run: its names are kept in the push object, as the
verification is, so the same unknown name or goal is not sent again (to a third party, with up to 8 s of waiting) at every failing check. An
answer is kept only when every backend that was to be asked answered: a failure, or a partial answer, is asked again at the next check
(a backend a private run leaves out by design is no failure). Each session also keeps the names it was shown and the check whose answer showed
them: a name is left out of a new section while that answer is in the history, and may come back once it has been masked (`maskedCount` of
`mask.ts`, when `maskOldChecks` is on; without masking, a name is shown once a session). When nothing new remains no section is appended.
A name is remembered as missing from the environment only when Lean's message at its line says `unknown identifier` or `unknown constant`: a file
that failed for another reason (an import, the server) says nothing of the name, and nothing is cached.

**The report.** The search's own Lean runs are kept out of the provers' check count and times: the verification is a tool run of
`lean.check` by the actor `lean.search`, and `report.json` has `leanSearch` (`requests`, `requestMs`, `checks`, `checkMs`), printed as its own
line in `report.md` ("Lean search (not in the checks above)").

**Backends** (the host profile's `lean.search` settings; each optional, any mix): `remote`, an HTTP service for natural-language and goal
queries (`remoteUrl`, `LEAN_SEARCH_URL`); `local`, a file of declarations ranked by BM25 with no model (`index`, `LEAN_SEARCH_INDEX`: a JSON
array or JSONL of `{name, type, doc?}`, for instance the export of the run's environment); `pattern`, a Loogle-like service (`patternUrl`,
`LEAN_PATTERN_URL`), or a match of a goal's conclusion over the index when there is no address. The services are reached over https only, only at a host of the setting `allowedHosts` (the shipped profiles allow `leansearch.net` and
`loogle.lean-lang.org`; none listed, none allowed), with no credentials in the address, no redirect, an answer read up to 256 KB and 8 s of
waiting. An address from `LEAN_SEARCH_URL` or `LEAN_PATTERN_URL` at another host makes that backend unavailable with its reason (in `skipped` and in
`harness health`), and the others go on. A name is one token of dot-separated parts (guillemets only as a whole `«...»` part).
With `--lean-search` and no usable backend the run says so once at its start. A backend that fails is skipped and the others
answer; with none set up the capability answers no hit.

**`--private`.** `RunConfig.private` (Task 36 adds the flag `--private`; this task adds only the optional field, with the same meaning:
nothing leaves for a third party other than the model provider) keeps `remote` and any `pattern` service off: the call says `private`, the
implementation does not ask them, and `pattern` falls back to the index when there is one. The local index never leaves the machine. Without
`private`, `remote` and `pattern` send the missing name, or a hole's goal (the statement being worked on), to the service: on for bench
problems, to be asked for `solve` (plan change, question 1).

**Not run.** Nothing here ran against a real Lean (the `#check` line and the lines Lean gives its messages are from its documentation as
remembered; the verification reads the message at the line of each `#check`), a real search service (the request and the answer shape of
`remote` and `pattern` are written from the services' documentation as remembered and may need an adapter, which is a replacement of the
backend behind the same capability) or an index of Mathlib. The tests use a simulated Lean and fake services.

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
11. For `lean.search`: that `#check NAME` of a Mathlib name prints its signature as one info message at the line of the command and
    that an unknown name is an error at that line; the real services' request and answer shapes; an index of Mathlib
    ([above](#search-pushed-by-the-harness)).
