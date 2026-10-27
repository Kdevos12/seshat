# Lean's language server for the provers

The capability `lean.lsp` gives the provers what a person has in an editor: the goals before and
after a line of the proof, the type a term must have, Lean's messages on the file, several tactics
tried at one line, and searches of Mathlib. It is
[lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp) (MIT), an MCP server over Lean's language
server, at a pinned release. The plan asks for it in PC7: provers that can look at the proof state
and search for lemmas do better than provers that only see `lean_check`'s verdict. Whether they do
here is what Task 14 measures, with this tool set against M0 with `lean_check` only.

**Not run against a real Lean yet.** The development environment has no Lean toolchain. Most of the
tests run against a stand-in server whose shapes were taken from the real release. Besides them
there is an opt-in test of the real server (release 0.31.0, from PyPI) with its language server and
its network call replaced by canned values: its tools, their argument checks, rate limits and error
texts, and the shapes of their answers are the server's own, and what Lean and the sites answer is
canned. It is committed, and says how to run it in [Tests](#tests); it is skipped on a host that
does not have the server's Python package. `pnpm harness contract lean.lsp` on a host with a Lean
project is what settles the rest ([To verify against Lean](#to-verify-against-lean)).

## What a prover gets

With `harness run --tool lean.lsp` ([m0-loop.md](m0-loop.md#other-tools)), each session has a
tool `lean_lsp(op, ...)`. It works on the file the prover is editing: the problem's sketch with the
two regions of the prover's last `lean_check` in it (the sketch's own proof before the first
check), or the regions the call passes as `aux` and `proof`. Lines count inside a region as
`lean_check` counts them (`PROOF line 3`, or `region: "aux"`). A column counts characters from 1 in
the line as it stands in the file, where the proof's lines carry the indentation the harness adds.

| `op` | Input | Answer |
|---|---|---|
| `goal` | `line`; `column` optional | Without a column, the goals before and after the line. With one, the goals at that position, and `status`: `goals`, `complete` (the language server reports no goal left; the prover reads "Lean's language server reports no goal left here. That is not a verdict: only lean_check judges a proof."), `no_goal_here`. Either way, `still_elaborating` and no goals when Lean did not finish within `timeoutSec`. |
| `term_goal` | `line`, `column` optional | The type expected of the term at the position (the line's end without a column), or `no_term_goal`. |
| `diagnostics` | `region` and `severity` optional | Lean's messages on the file, errors first, each with its region, line, column and the line of code; at most 25, with the count of the rest. |
| `multi_attempt` | `line`, `tactics` (1 to 8), `column` optional | For each tactic, tried in place of the line (from the column, by default the first non-blank character, to the line's end, as many lines as the tactic has, which must end inside the region): `closed` (no goal and no error), `open` (the goals left) or `error` (Lean's messages). Nothing is saved. |
| `loogle` | `query`, `limit` | Mathlib by name, type pattern or conclusion (8 results by default). |
| `leansearch` | `query`, `limit` | Mathlib by what a lemma says (5 results by default). |
| `state_search` | `line`, `column` optional, `limit` | Lemmas for the goal at the position: the goal is read with `lean_goal`, and its text is the query to Lean Finder (5 results). |
| `hammer_premise` | `line`, `column` optional, `limit` | Names of premises to try in `simp only [...]`, `aesop` or `grind` for the goal at the position (16 by default). |

`timeoutSec` (up to 300) says how long Lean may take to elaborate the file for `goal`, `diagnostics`
and `state_search`; a file still being elaborated is reported as such (`status: still_elaborating`
for `goal`, in the line form too, and for `state_search`, which then searches nothing; `partial` for
`diagnostics`), never as a line with no goal. The answers are written
for the model, not as JSON ([The answer](#the-answer)), and are clipped at 8000 characters like any
tool's. `pnpm harness describe lean.lsp` prints what the model reads about the tool;
`capabilities/lean.lsp/` holds it.

**State search.** The plan names "state search". The server's `lean_state_search` is gone in 0.31.0
(it was a call to a LeanSearch endpoint with the goal), and Lean Finder replaces it: `state_search`
reads the goal with `lean_goal` and asks `lean_leanfinder` with its text (the last 1500 characters,
which hold the target).

### How a call reaches the file

The tool's parameters do not show the problem's `sketch`: the run fills it in from the problem and
a value the model gives is refused ([The orchestrator's side](#the-orchestrators-side)). The
implementation builds the file as `lean_check` would, writes it to the project as
`.seshat-lsp/<attempt>-<hash>.lean`, and passes that path to the server. The file is written only
when its text changed, one file per attempt, and deleted when the attempt ends
(`registry.release`) or the registry closes; the directory has a `.gitignore` of `*`. A call runs
alone in its attempt, so the file holds the regions of the call that is running; calls of
different attempts run at the same time.

The deletion does not depend on how the attempt ends: a finished session, a session that ends in an
error and a run that is aborted while a call is on its way all leave the directory without a file
(`packages/orchestrator/test/lean-lsp.test.ts`). A harness that is killed gets no such chance, and
the files it leaves in `.seshat-lsp/` stay there until someone removes them by hand (`rm
.seshat-lsp/*.lean` in the project, when no run is using it). They do no harm, since each attempt
has a name of its own and git ignores the directory, but they accumulate.

The server splits a file into lines at more characters than Lean does (Python's `splitlines()`: a
carriage return that no line feed follows, vertical tab, form feed, the file, group and record
separators, NEL, U+2028 and U+2029). Text with one of them would be a comment to the screen and code
in the trial documents of `multi_attempt` (the server splits the file and joins it again), and every
line after it would be off by one. So a region or a tactic that holds one is refused, a CRLF (one
break for both) is written as a line feed, and a problem whose own file holds one of the others is
refused as a whole.

The server's answers are read back in the prover's terms: a line of the file becomes `PROOF line 3`
(or `AUX line 2`, or `line 9 of the fixed part` for the theorem's header and the rest of the file).

What a path in a text becomes is the same everywhere a text of the server or of Lean reaches the
prover: an error of the server or of a tool, the reason a site gave, the note about imports that did
not build, and the text and the hint of each message of Lean in `diagnostics` and `multi_attempt`.
The project directory, as the profile gave it and by its real path (a symbolic link followed),
becomes `<project>`; the scratch directory becomes `<scratch>`; the scratch file itself, wherever a
message names it, becomes `the sketch file`. Nothing else is replaced: a message that names the
home directory, the toolchain or the package cache shows that path as it is.

### How a tactic is tried

`multi_attempt` does not hand the tactic to Lean alone. For each tactic the server builds a document
from the file (`build_attempt_text` in lean-lsp-mcp 0.31.0): from the line asked, as many lines of the
file are replaced as the tactic has, and each becomes the first `column - 1` characters of that line
followed by one line of the tactic. A name or a command can therefore be cut in two, half in the line
and half in the tactic (`Le` and `an.Elab...`, `#ev` and `al 1`), and a tactic can close a comment that
hid code (`-/`). Each half is clean alone and the join is not.

So the harness names the column itself when the prover gives none (the server's default, the first
non-blank character, is what it sends), builds each document as the server does (`attemptLines`), reads
its two regions back, and runs the screen of regions on them: a refusal says the tactic, where it is
joined and what the server would elaborate. A tactic that has more lines than the region has from the
line asked is refused, because the server would replace the marker that ends the region and the
lines after it. A tactic is screened as given, and then a CRLF in it is written as a line feed, which is how it is joined and sent (a lone carriage return, even one before a CRLF, is refused). `attemptLines` is compared with the
server's own `build_attempt_text` on 1500 seeded random cases (astral characters, tabs, no-break
spaces, several lines, trailing line feeds), and gave the same document in each (and in 3000 when it
was first written). The comparison is the opt-in test `real-server.test.ts` ([Tests](#tests)); it
needs the real server's Python package, not Lean.

## What it never does

| Rule | How |
|---|---|
| **Eight operations, no more.** | The client calls 8 of the server's 22 tools (`lean_goal`, `lean_term_goal`, `lean_diagnostic_messages`, `lean_multi_attempt`, `lean_loogle`, `lean_leansearch`, `lean_leanfinder`, `lean_hammer_premise`) and refuses any other by name, whatever the server lists. The other 14 (`lean_build`, `lean_run_code`, `lean_file_outline`, `lean_declaration_file`, `lean_local_search`, `lean_hover_info`, `lean_verify`, `lean_profile_proof`, and six more) are also switched off in the server (`LEAN_MCP_DISABLED_TOOLS`), so a prover that reached the process by another way would not find them. |
| **No path.** | No input names a file. The only file a call touches is its attempt's scratch file; the project's other files are not read, and a path in an argument fails the tool's schema before it reaches the registry. |
| **Nothing the model writes runs unscreened.** | The regions and every tactic go through the policy of `lean_check` (`SKETCH_POLICY`: no `#eval`, `IO`, `import`, `native_decide`...) and are refused with the same reasons, before the server hears of them. A tactic is screened twice: alone, and in the document the server will elaborate for it, which joins it to the start of its line ([How a tactic is tried](#how-a-tactic-is-tried)). A query is plain text: one line of at most 500 characters. |
| **No verdict.** | The tool `produces` nothing, and no field of its answer is a verdict. `complete` and `closed` are information about the language server's view of a file; only `lean_check`, through the validator, records a validation or changes a claim's status ([trust.md](trust.md)). A run that uses only `lean_lsp` ends with the claim `open`. |
| **No failure of the run.** | A search site that cannot be reached is an answer (`status: unavailable`, and why), not an error, and is left alone for 60 seconds. A server that stops makes the tool unavailable for the rest of the session, and the prover goes on with `lean_check`. A run does not start with `--tool lean.lsp` when the server is not there ([Health](#health)). |
| **Charged like any tool.** | A call is part of a turn of the prover: the model's response is what costs, and the turn limit and the budgets stop a prover that only looks. Every call is a tool run in the journal, with its input and output as blobs. |

## The answer

The registry's output is JSON (`op`, `status`, then the fields of the operation: `goalsBefore`,
`goals`, `messages`, `attempts`, `results`, `premises`, `unavailable`, `note`...; the manifest has
the schema). The model reads it written out by `presentOutput`, for example:

```text
Before PROOF line 1, `sorry`: 1 goal(s)
n : Nat
⊢ n + 0 = n

After PROOF line 1, `sorry`: no goal.
```

```text
Tried 3 tactic(s) at PROOF line 1, `sorry`. Each replaces the line from the column on; the goals are read at its end. Lean's errors elsewhere in the file are listed too.
1. `omega`: closes the goal (no goal left, no error).
2. `ring`: leaves 1 goal(s).
   n : Nat
   ⊢ n + 0 = n
3. `exact bad`: gives an error.
   1. error, PROOF line 1, column 9:
      unknown identifier 'bad'
```

A call that cannot be answered fails with a sentence the prover can act on: `PROOF has 1 line;
there is no line 7`, `column 40 is past the end of the line, which has 7 characters`,
`Refused before Lean ran; nothing was asked: - tactic 1: 'native_decide' is not allowed`.

## The orchestrator's side

`capabilityTool` takes an optional `binding` (`ToolBinding` in `packages/orchestrator/src/tools.ts`):
`hidden` input fields, left out of the tool's parameters; `bind`, which makes the registry's input
from the model's arguments; and `present`, which writes the answer. `toolBinding(id, ...)` gives
`lean.lsp` the binding of `@seshat/lean-lsp` (`leanLspBinding`) and every other capability none, so
their tools are unchanged. The binding drops whatever the model put in `sketch`, sets the problem's,
and fills `aux` and `proof` from `Workbench.lastSubmission(attemptId)` (the regions of the attempt's
last check) or else the regions the session started with. The prover builds the tool with it for
each session.

## Installing it

The server needs Python 3.10 or later and a built Lean project: `lean-toolchain` and a
`lakefile.lean` or `lakefile.toml` in its root, `lake build` done (and for Mathlib, its cache),
because the first call starts Lean on it.

```sh
pip install uv                                        # or the installer of https://docs.astral.sh/uv/
export LEAN_PROJECT_DIR=/path/to/formal-conjectures   # the Lean project the files are checked in
pnpm harness health lean.lsp                          # starts the pinned server and asks its version
pnpm harness contract lean.lsp                        # needs Lean; four cases also need the network
pnpm harness run --checkout DIR --model PROVIDER/ID --sample 5 --tool lean.lsp
```

By default the harness starts `uvx --from lean-lsp-mcp==0.31.0 --with leanclient==0.13.2
lean-lsp-mcp`, which fetches the pinned release from PyPI on the first start. `leanclient` is pinned
exactly because the release asks only `leanclient>=0.13.2`, and `leanclient` decides what a goal, a
barrier and a position are: a newer one could change the answers without the handshake showing it.
Release 0.31.0 was written and seen with 0.13.2. The other dependencies are not pinned by the
harness: `mcp[cli]` is fixed by the release itself (`==2.0.0`), while `orjson` and `certifi` float
(`orjson>=3.11.9`, `certifi>=2026.7.22`: they do not change what a tool answers, and a floating
`certifi` keeps the certificate bundle current). To use an installed server instead, set
`LEAN_LSP_MCP_COMMAND` to its executable (`pip install lean-lsp-mcp==0.31.0 leanclient==0.13.2` in a
virtual environment, which then also fixes `orjson` and `certifi` at what it installed). With a
command other than `uvx` the harness passes no arguments.

The project is the bench's formal-conjectures checkout when the provers work on bench problems
([lean.md](lean.md#deployment-for-the-bench)): its imports must resolve there. Lean runs as the
harness's user, in that project.

### The pinned version

`0.31.0`, checked against PyPI: the harness reads `serverInfo` of the MCP handshake and refuses a
server that reports another version, or that lacks one of the eight tools, as unavailable
(`harness health`, and `--tool` at the start of a run). The recorded tool list of the release (the
names, arguments, types, minimums and enumerations of its 22 tools) is
`packages/lean-lsp/test/fixtures/lean-lsp-mcp-0.31.0-tools.json`; the stand-in server checks every
call against it as the server's argument validation does. Moving the pin means changing
`LEAN_LSP_MCP_VERSION`, the manifest's implementation version, reading the new release's tool list
and running the contract.

## Settings

The host profiles (`config/hosts/local.json`, `server.json`) list `lean.lsp` with the implementation
`lean-lsp-mcp`. Settings, in the profile or the manifest:

| Setting | Variable the profiles read | Meaning |
|---|---|---|
| `command` | `LEAN_LSP_MCP_COMMAND` | The server's executable; default `uvx`. |
| `args` | | Its arguments; default as above for `uvx`, none otherwise. The operator's, and trusted (below). |
| `projectDir` | `LEAN_PROJECT_DIR` | The Lean project (required: without it the capability is unavailable and says how to name one). |
| `scratchDir` | | The scratch directory, relative to the project; default `.seshat-lsp`. |
| `loogleUrl` | `LOOGLE_URL` | A Loogle of the host's, in place of the public site. |
| `leanFinderUrl` | `LEAN_FINDER_URL` | A Lean Finder of the host's. |
| `hammerUrl` | `LEAN_HAMMER_URL` | A premise server of the host's. |
| `leanFinderVersion` | | The Mathlib snapshot Lean Finder searches (`v4.19.0`, `v4.24.0`, `v4.28.0`); default the server's. |
| `maxOpenFiles` | | The server's `LEAN_LSP_MAX_OPEN_FILES` (default 4). |
| `siteCooldownSec` | | How long a site that failed is left alone; default 60. |
| `env` | | More variables for the server, such as `HTTPS_PROXY`. |

An empty text is no value (`${env:LOOGLE_URL:-}` leaves the server's own address). The server's
process gets no variable of the harness's environment besides those programs need to start
([capabilities.md](capabilities.md#implementations)), so a proxy goes in `env`. The harness sets
`LEAN_PROJECT_PATH` and `LEAN_MCP_DISABLED_TOOLS` itself, and `env` may not set them or any other
variable that would change what the server may do (`LEAN_REPL*`, `LEAN_LOOGLE_LOCAL`,
`LEAN_MCP_INSTRUCTIONS`...): the profile is refused.

`args` is not held to that rule. It is the operator's, like `command`, and trusted: the harness
passes it as given and does not read it. The server turns each of its flags into the variable of
the same name when it starts, over the one the harness set, so a flag can do what the refused
variable would: `--disable-tools` replaces the list of the 14 tools that are switched off,
`--repl` starts a Lean REPL beside the language server (the server tries its REPL for
`multi_attempt` only when the call has no column, and the harness always sends one), and
`--loogle-local` has the server clone, build and run a Loogle. A profile that adds one of them (or any flag besides the defaults) leaves
the surface that this page describes and the tests cover. The harness's own side still holds, since
the closed schema and the allowlist of the client let only the eight tools be called with the
arguments listed here, but what the server does behind them is then the operator's to vouch for.

### Health

`harness health lean.lsp` starts the server and checks its version and tools. It does not start
Lean: the server reaches the language server on the first file call.

## The network sites

The four searches ask public services, declared in the manifest's `environment` like the other
site-backed capabilities:

| Operation | Site | Default address | The server's own limit | What is sent |
|---|---|---|---|---|
| `loogle` | Loogle | `https://loogle.lean-lang.org` | 3 requests per 30 s | the query |
| `leansearch` | LeanSearch | `https://leansearch.net` (fixed in the server) | 90 per 30 s | the query |
| `state_search` | Lean Finder | `https://lean-lsp-proxy.leanfinder.workers.dev` | 10 per 30 s | the goal's text |
| `hammer_premise` | the premise server | `http://leanpremise.net` (plain HTTP) | 6 per 30 s | the goal |

When the network call to a site fails (a name that does not resolve, a refused or a cut
connection, an HTTP status, a time limit of the socket) or the server's own limit refuses the call,
the answer says `unavailable` with the reason, and the site is not asked again for
`siteCooldownSec`. Nothing else is taken for an outage. A refused query (a Loogle pattern Lean
cannot read) is an error of the call, since it is the prover's to fix; so is any other failure of
these four tools, such as an answer the server cannot read or a site that reports an error of its
own, which are shown as they are and put nothing on a cooldown. `hammer_premise` reads the goal
from the language server before it asks its site, so a failure there (a line out of range, a time
limit of Lean) is Lean's and also an error of the call. A host with its own copy of Loogle or the
premise server names it, and the server's client-side limit then does not apply to it.

Things to know before using it:

- **Goal text leaves the machine.** `state_search` and `hammer_premise` send the text of a goal
  (hypotheses and target) to third parties, and the searches send the prover's queries. For
  unpublished statements, name sites of your own (`LOOGLE_URL`, `LEAN_FINDER_URL`, `LEAN_HAMMER_URL`);
  LeanSearch's address cannot be changed.
- **The limits are shared.** One server process serves every prover of the run, so 3 Loogle requests
  per 30 seconds are for all of them together. Past the limit the site degrades for a minute and the
  provers go on without it.
- **The indexes are snapshots.** A search can name a lemma that the project's Mathlib does not have;
  the description tells the prover to try a name before relying on it.
- **Open files.** The server keeps 4 files open by default (`LEAN_LSP_MAX_OPEN_FILES`), one per
  attempt at work here. A run with more attempts at once than that makes the server close and open
  files again, which costs a new elaboration each time: set `maxOpenFiles` to at least
  `provers × concurrency`.

## It is not sandboxed

The regions, the tactics and the queries come from the model, and Lean elaborates them in a child
process of the server, which is a child process of the harness, as the harness's user. Lean code
can do any IO (`#eval`, `run_cmd`, `elab`, `IO.Process`): read and write whatever that user can,
including `.env` and the runs' journals and blobs, and reach the network. Only the environment is
cleaned (the server's process gets the few variables that programs need to start and those of its
settings). This breaks the rule that model-written code runs in a sandbox
([trust.md](trust.md#what-runs-where); `compute.sage` runs in a container without network or a
writable disk). The screening above refuses what `lean_check` refuses (commands that run code or
read files, `import`), which is the same line `lean_check` holds, but a filter on text is not a
sandbox, and neither check is one. Like `lean.goals` ([lean-meta.md](lean-meta.md#leangoals)), give
`lean.lsp` to provers only on a machine and user whose files the model may read and change, until
an implementation in a container or under a restricted user exists.

Two more things follow from how it is built:

- **One language server serves every prover.** The provers of a run share the server and the Lean
  behind it: their files differ, the process does not. A tactic that does not terminate, or that
  takes all the memory, slows or stops the calls of every attempt, not only of the prover that sent
  it. `timeoutSec` stops the waiting, not Lean: a call that reaches it answers
  `still_elaborating` (or a partial list of messages), and Lean may go on elaborating what it was
  given.
- **The answers of the four sites are third-party text.** What Loogle, LeanSearch, Lean Finder and
  the premise server answer (names, types, descriptions) reaches the model as it comes, the types
  and descriptions clipped, and can say anything, including words addressed to the model. The
  harness treats it as text and nothing else: a prover acts only through its tools, and only
  `lean_check` judges. But nothing checks what the sites say.

## Tests

Except for `real-server.test.ts`, which is opt-in, none needs Python, Lean or a network.

- `packages/lean-lsp/test/fixtures/fake-lean-lsp-mcp.ts` is a stand-in for the server: it lists the
  tools, checks every call against the recorded arguments of the real release, reads the file the
  call names from the project (a path outside the project, or a missing file, is an error as in the
  server), and answers with canned values of the real shapes. It also runs as a child process on
  stdio, honouring the server's environment variables, so the tests see what the harness gives a
  child.
- `implementation.test.ts`, `layout.test.ts`, `screen.test.ts`, `results.test.ts`,
  `present.test.ts`, `binding.test.ts`: every operation, the lines and columns, the refusals, the
  site failures and cooldown, the reconnection after the server went away, one file per attempt.
- `registry.test.ts`: the capability through the registry (output schema, tool runs and blobs,
  refused inputs, scopes, health, the host profiles). `stdio.test.ts`: the default transport and the
  environment of the child. `contract.test.ts`: the manifest (eight operations, no path-like field,
  no verdict, the pin, the declared sites) and the contract, run against the stand-in.
- `packages/orchestrator/test/lean-lsp.test.ts`: a run with the tool: the file each call reads, the
  forged sketch, the journal, no status change, a site down, the server dying, the budget.
- `real-server.test.ts` runs the real lean-lsp-mcp, for a host that has it, and is skipped otherwise
  (the skip says why). It needs neither Lean nor the network: set `LEAN_LSP_MCP_PYTHON` to a Python
  with `pip install lean-lsp-mcp==0.31.0 leanclient==0.13.2` (a virtual environment's `bin/python`)
  and run `LEAN_LSP_MCP_PYTHON=/path/to/venv/bin/python pnpm test`. It fails on any other release.
  It has two parts. One compares `attemptLines` with the server's own `build_attempt_text` on 1500
  random cases. The other starts the server through the harness's implementation, with
  `fixtures/real_server_canned.py` replacing the language server (a canned client and scratch pool)
  and `urllib.request.urlopen`, the one call that every search ends in, by canned values; the server's
  own code does the rest. It checks the handshake (the release and the eight tools, none of the 14
  others); the eight operations in the shapes the harness reads, with the document that the real
  `build_attempt_text` made of a `multi_attempt` call equal to the one the screen examined; the
  language server's timeout as `still_elaborating`, in line mode as at a position; the seven kinds of
  network failure as urllib raises them, each an outage with the reason in the server's words; an
  answer that is not JSON, which fails the call; and the server's own limits (Loogle 3 requests and
  Lean Finder 10 in 30 s). What it does not check is Lean: the goals, the messages and the
  elaboration are canned.

The contract (`capabilities/lean.lsp/contract.json`, 15 cases) is for a host with Lean. It works on
a file without imports (`theorem seshat_contract (n : Nat) : n + 0 = n := by sorry`), so the project
needs only Lean's core for it. The four cases that ask a site need the network. They run with

```sh
LEAN_PROJECT_DIR=/path/to/project pnpm harness contract lean.lsp
LEAN_PROJECT_DIR=/path/to/project pnpm test                    # contract.test.ts runs it, without the network cases
LEAN_PROJECT_DIR=/path/to/project LEAN_LSP_SITES=1 pnpm test   # and with them
```

## To verify against Lean

1. That the server starts on the project and that the first call, which starts Lean and elaborates
   the file's imports, fits `timeoutSec` (the contract asks for 240 s). A slow first call is a cold
   start, not an error of the tool.
2. The text of goals (`ℕ` or `Nat`, the order of hypotheses), the status `complete` at the end of a
   closing tactic, and `no_goal_at_position` on a blank line: the contract's expectations are
   written from the server's code and its canned results.
3. That `multi_attempt` replaces the line from the column to its end as described, for tactics of
   several lines, and that its `closed` is what Lean means (no goal and no error). The server's
   REPL variant (`--repl`) is not used.
4. That Lean Finder's default snapshot suits the project's Mathlib (`leanFinderVersion`), and that
   each site answers in the shape the server parses.
5. The server's behavior with several provers at once: one language server, files opened by
   `LEAN_LSP_MAX_OPEN_FILES`, and requests that wait for each other.

## Not done

Nothing here is measured: not the tool's effect on proofs found (Task 14), not the latency of a call,
not how often provers use it. There is no sandbox, no cache of search answers, no per-site share of
the rate limit among provers, and no choice among several servers.
