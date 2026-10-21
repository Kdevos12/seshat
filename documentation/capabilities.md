# Capabilities

Every tool the harness uses sits behind a capability: a stable contract with a dotted id such as
`lean.check` or, later, `counterexample.finite_model`. Callers name the capability, never the
tool. The host profile picks the implementation, so replacing Kimina by another Lean server, or
Vampire 5.0 by 5.1, changes a manifest or a profile, not the code and not the prompts.

`@seshat/registry` loads the manifests and the host profiles, calls implementations (in
this process, or MCP servers in their own processes), checks every input and output against the
manifest's schemas, and records every call as a tool run in the journal.

## Layout

```
capabilities/<id>/manifest.json   the contract and the known implementations
capabilities/<id>/contract.json   golden cases, run before an implementation is trusted
capabilities/<id>/...             files the JSON includes with {"$file": "path"}
config/hosts/<host>.json          what one host uses, and where it finds it
```

An object `{"$file": "cases/x.lean"}` anywhere in a manifest or contract is replaced by the text of
that file, relative to the capability's directory (and refused if it points outside it), so Lean
code and long descriptions live in their own files.

## Manifests

| Field | Meaning |
|---|---|
| `id` | `namespace.name`; the directory has the same name. |
| `version` | Version of the contract. A change of input, output or meaning is a new version. |
| `title`, `description` | For the model: what it does and what it returns. |
| `when`, `whenNot` | When to use it, and when not (with what to use instead). |
| `exposure` | `auto`, `direct` or `deferred`, see below. |
| `input`, `output` | JSON schemas. |
| `produces`, `certificate` | Claim statuses a result can justify; `proved` and `refuted` need a `certificate` saying what makes the result trustworthy. |
| `timeoutMs` | Default time limit of one call. |
| `timeoutField` | A number field of the input, in seconds, that sets the tool's own time limit; the registry then allows that plus 15 seconds. |
| `stateful` | `true` when calls keep state between them, such as the variables of a computer algebra session ([scopes](#scopes)). |
| `summary` | Paths of the output recorded in each tool run, such as `results.*.status`. |
| `examples` | Inputs with their outputs, shown to models. |
| `implementations` | The known implementations, each with a pinned `version`. |

`exposure` places the capability in the three levels of the tool library: `auto` is called only by
the orchestrator, by rule (level 0); `direct` is one of the ten or so tools always declared to the
model (level 1); `deferred` is found on demand through tool search or code (level 2). `lean.check`
is `auto`, called by the validator; `compute.sage` is `direct`, given to the provers by
`harness run --tool` ([m0-loop.md](m0-loop.md#other-tools)). No capability is `deferred` yet.

Loading checks more than the shape: schemas use only the supported keywords, implementation ids
are unique, every example and every contract input is valid for the schemas, summary and
expectation paths parse, every regular expression compiles, the MCP implementations of a stateful
capability name their scope argument (and only theirs do), and `timeoutField` is a number field of
the input with both bounds. All problems of the catalog are reported together.

### Schemas

The registry checks a subset of JSON Schema: `type` (one or a list), `properties`, `required`,
`additionalProperties` (a boolean or a schema), `items`, `enum`, `const`, `minimum`, `maximum`,
`minLength`, `maxLength` (in code points), `minItems`, `maxItems`, `pattern`, `anyOf`, plus
`description` and `default` as documentation. Any other keyword is refused at load time, so a
schema never checks less than it appears to. `renderSchema` writes a schema in a compact notation
for models, such as `{id: string, code: string}[]`.

### Implementations

Every implementation has an `id`, a pinned `version`, an optional `description`, and an optional
`environment`: what its results depend on besides the input, such as the Lean version and the
project it imports from.

**In-process** (`"kind": "inproc"`): code in the harness, built by a factory. The manifest names
the factory and may give default `settings`. Factories are registered by the composition root
(`FACTORIES` in `@seshat/orchestrator`); a package that provides one exports it, as
`@seshat/lean-kimina` exports `kiminaFactory`.

**MCP** (`"kind": "mcp"`): one tool of an MCP server, reached with
[`@earendil-works/pi-mcp`](https://github.com/earendil-works/pi). Any external program goes this
way: it can be written in any language, it crashes, hangs or leaks memory in its own process, and
tools under the GPL are called, not linked.

```json
{
  "id": "mace4",
  "version": "2009-11A+mcp-1",
  "kind": "mcp",
  "tool": "find_model",
  "server": { "transport": "stdio", "command": "${dir}/server/run.sh", "args": ["--max-size", "12"] }
}
```

- `server` is `{"transport": "stdio", "command", "args?", "cwd?", "env?"}` or
  `{"transport": "http", "url", "headers?"}`.
- The connection opens on first use and is kept; after the server goes away, the next call
  connects again.
- On connection, the server must report the pinned `version` as its `serverInfo.version`
  (`"versionCheck": false` turns this off for a third-party server) and list the tool. Otherwise
  the implementation is unavailable.
- The capability's input is passed as the tool's arguments, so its schema must be an object. The
  output is the result's `structuredContent`, or else its single text block read as JSON. A
  result with `isError` is a failure, which keeps the tool's own message.
- A stdio server gets its own `env` and, from the harness's environment, only what programs need
  to start: `PATH`, `HOME`, the user and the shell, the locale and the time zone, the temporary
  directories, Windows' system variables, and Docker's (`DOCKER_HOST`, `DOCKER_CONTEXT`,
  `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`). The harness's credentials (model
  keys, the Lean server's key) never reach it; a server that needs a secret gets it in its `env`,
  from `${env:NAME}`.
- An implementation of a stateful capability names its `scope`:
  `{"argument": "session", "release": {"tool": "stop_sage_session", "argument": "name"}}`. The
  call's scope goes to the tool under `argument`. Releasing the scope calls `release.tool` with
  the scope under its own `argument`, if the current connection used that scope.

## Host profiles

Where the harness runs (a workstation, the dedicated server) is configuration. A profile names
the capabilities the host offers; a capability it does not name is unavailable there.

```json
{
  "host": "local",
  "capabilities": {
    "lean.check": {
      "use": ["kimina"],
      "settings": { "kimina": { "url": "${env:LEAN_SERVER_API_URL:-http://localhost:8000}", "apiKey": "${env:LEAN_SERVER_API_KEY:-}" } },
      "timeoutMs": 900000
    }
  }
}
```

- `use` lists implementations in order of preference. The next one is tried only when one
  cannot be reached. A run pins each tool it gives the provers to the first one that answers when
  the run starts ([m0-loop.md](m0-loop.md#other-tools)).
- `settings` gives, per implementation, the settings of an in-process one, or fields of an MCP
  server that replace the manifest's. A profile that changes an MCP server's `transport` replaces
  the whole server.
- Strings in settings and server fields may use `${dir}` (the capability's directory),
  `${env:NAME}` and `${env:NAME:-default}`. An unset variable without a default makes the
  implementation unavailable and names the variable. Secrets are never written in profiles; they
  come from the environment.
- `timeoutMs` replaces the manifest's time limit on this host.

The host is chosen with `--host`, or `HARNESS_HOST`, and defaults to `local`. The repository has
`local` (a workstation) and `server` (the dedicated server, where the Lean server's key is
required).

## Calls

```ts
const registry = openRegistry({ host: "local", journal, blobs });
const { output, toolRunId, implementation, version } = await registry.invoke("lean.check", input, { attemptId });
```

`invoke` checks the input against the manifest, then, for each implementation of the host in
order (or the one `implementation` names): records `tool_run.started` (capability,
implementation, pinned version, hash of the input, time limit, attempt, scope), calls the
implementation, checks the output against the manifest, and records `tool_run.finished` (outcome,
duration, hash of the output, summary). The time limit is the caller's `timeoutMs`, else the
input's `timeoutField` plus 15 seconds, else the host profile's, else the manifest's. Its errors
are `CapabilityError`s:

| Code | When | Tool run outcome |
|---|---|---|
| `unknown_capability` | No such manifest. | none |
| `invalid_input` | The input breaks the schema, or a call of a stateful capability has no scope. | none |
| `unavailable` | The host does not offer the capability, or no implementation could be reached. | `error`, for each one tried |
| `timeout` | The time limit passed. | `timeout` |
| `aborted` | The caller's signal aborted, for instance when a budget ran out. | `aborted` |
| `failed` | The implementation failed on this input; `details[0]` is its own message. | `error` |
| `invalid_output` | The output breaks the schema. | `error` |

With a blob store (`blobs`, any `BlobSink`), the input and the output of each call are kept there
under the hashes its tool run records ([journal.md](journal.md#blobs)), so that every tool call of
a run can be read back.

Only an implementation that cannot be reached at all (it throws `UnavailableError`: connection
refused, wrong version, missing tool) makes the registry try the next one. A failure on an input
is a result about that input, and is not retried elsewhere.

When the time limit passes or the caller aborts, the implementation's signal aborts and `invoke`
returns at once, even if the implementation ignores the signal.

### Scopes

A call of a stateful capability gives a `scope`. Calls with the same scope share state, such as
the variables of a SageMath session, and calls with different scopes share none.
`tool_run.started` records the scope, so the journal says which calls saw which state, in order.
`registry.release(scope)` ends the scope in every implementation that used it, best effort: an
implementation that went away took its state with it. The orchestrator uses an attempt's id as its
scope and releases it when the attempt ends ([m0-loop.md](m0-loop.md#other-tools)).

### Hashes, health, descriptions

`registry.hash` covers the catalog (every manifest, files included) and the host profile. It goes
into `run.started`, so a run's journal says which contracts and implementation versions it used.

`registry.health()` reaches every implementation the host lists and asks for its health.
`registry.usable(id)` asks only whether the host can create an implementation of the capability,
calling none: an in-process factory refuses a configuration it cannot work with (`lean.certify`
without a project or a sandbox), and `usable` gives the reasons. A factory is told the name of the
host profile (`FactoryContext.host`). `registry.describe(id)` writes a manifest out for a model: what it does, when to use it, its fields
and its examples.

## `lean.check`

The first capability: elaborate whole Lean files and return Lean's messages, the `sorry`s with
their goals, and a status per file. Its implementation `kimina` is Kimina Lean Server 2.x
([lean.md](lean.md#kimina-lean-server)); its version `fb2393de+lean-v4.27.0+fc-bench-v1` names the
server's commit, the Lean version and the project, because the same file can succeed or fail
depending on the Mathlib it imports.

The validator reaches Lean through `RegistryLeanChecker`, a `LeanChecker` whose checks are tool
runs of `lean.check`. The orchestrator makes one per attempt, so tool runs carry the attempt's id.
Like any `LeanChecker`, it reports a failure to reach Lean as `server_error` or `timeout` results,
never as an exception. `leanCheckImplementation(checker)` goes the other way and makes any
`LeanChecker` an implementation of `lean.check`; when no file reached Lean, it reports the
implementation as unreachable, so a host's next Lean server is tried.

Its contract is the list of Lean behaviours the validator relies on
([lean.md](lean.md#to-verify-against-lean)), as cases to run against a real server:

| Case | Checks |
|---|---|
| lean version | `#eval Lean.versionString` gives `"4.27.0"`, the bench's Lean. |
| axioms of a classical proof | The text of `#print axioms` for a proof using `Classical.em`, at its line. |
| no axioms | The text for a declaration without axioms. |
| axioms of a name with guillemets | Names with `«»` parts are printed with them. |
| the validator's check commands | `pp.maxSteps` exists; the `#check` message under `set_option ... in` comes after the axioms line and is the only other message. |
| two files in one call | One result per file, with its id; a `sorry`'s goal and position; an error's line. |
| line numbers after a header | Positions are those of the file after the server splits off the imports. |
| a formal-conjectures file | The project's imports, attributes and linters leave no error. |
| timeout | A file past Lean's time limit gives `timeout`, not a server error. |

A test runs this contract against the answers Lean is expected to give, which only shows that the
expectations are well written. Whether Lean answers so is what running it against a server tells.

## `lean.meta`

The Lean meta tool: a statement's `st1_` id (the hash of its elaborated term in a canonical form),
`isDefEq` of two statements, the theorems a proof uses, the classes and instances a statement
involves, and which facts a statement is an instance of or covers. It is `auto`: `LeanIdentity` and
the lines call it through the typed client `LeanMeta` of `@seshat/lean-meta`. Its implementation
`kimina` (factory `kimina-meta`) runs the commands of the Lean library `lean/SeshatMeta` as snippets
on the Kimina server of `lean.check`, and its version adds the library's to `lean.check`'s. Its
contract has 11 cases; the library has never been compiled, so they have not run.
[lean-meta.md](lean-meta.md) covers the commands, the canonical form, the errors and the
deployment.

## `lean.goals`

Proof goals one tactic at a time, through Pantograph's REPL: `start` gives the goals of a statement,
`tactic` runs a tactic on a goal of a state and answers the next state, `goals` shows a state again,
`sketch` gives the goals of a file's `sorry`s. It is `direct` and stateful: each scope numbers its
states from 0, and releasing the scope deletes them. Its implementation `pantograph` (factory
`pantograph`) runs the REPL as a child process. Its contract has 6 cases, not run against Pantograph
yet; [lean-meta.md](lean-meta.md#leangoals) covers the operations, the process and the settings.
It is not sandboxed: the model's Lean code runs as the harness's user, with that user's files, so
a run gives it to the provers only when asked (`--tool lean.goals`), on a machine where that is
acceptable, until an implementation in a container exists.

## `lean.certify`

The certifier ([certifier.md](certifier.md)): a candidate file, the reference file, the target's
name and the allowed axioms in; a verdict (`certified` or `rejected`, with reasons and the target's
axioms) out. It is `auto` and the one capability that `produces` `proved` and `refuted`, with a
`certificate` that says how. A call that reaches no verdict fails, as a call; it never answers
`rejected` for a failure that is not the candidate's (a project in which not even the reference
compiles is one). It fails closed: the implementation is unavailable until the host profile gives it
a `sandbox` command or opts in with `unsandboxed: true`, and neither shipped profile does
([certifier.md](certifier.md#where-untrusted-code-runs)). Its implementation `lake` (factory
`lake-certify`, in `@seshat/lean-local`) runs `lake env lean` in the project `LEAN_PROJECT_DIR`;
the orchestrator reaches it through `RegistryLeanCertifier.forHost(registry)`, a `LeanCertifier`
whose certifications are tool runs, and `leanCertifyImplementation(certifier)` makes any
`LeanCertifier` an implementation. Its contract has 9 cases, not run against Lean yet.

## `compute.sage`

SageMath, through the MCP server sagemath-mcp: Sage code in, the value of its last line and what it
printed out. It is stateful, one Sage session per scope, and `direct`. Its implementations are
`docker` (the server's container image, without network) and `local` (an installed server). Its
contract has 16 cases. [compute.md](compute.md) covers the installation, the settings, the
resources it takes, and what it offers and refuses.

## Contract tests

`contract.json` holds cases: a `name`, a `purpose`, an `input`, a list of expectations on the
output, and an optional `timeoutMs`. A case may also have:

- `before`: inputs called first, in the case's scope, for a case about state (stateful capabilities
  only);
- `fails` in place of `expect`: `{"code": "failed", "matches": "..."}`, the error the call must end
  with, and a regular expression its message must match.

Each case of a stateful capability runs in a scope of its own, released after the case.

An expectation has a `path` into the output and one check:

| Check | Holds when the value at `path` |
|---|---|
| `equals` | equals the JSON value. |
| `matches` | is a string matching the regular expression. |
| `length` | is a list or a string of that length. |
| `atLeast`, `atMost` | is a number within the bound. |
| `exists` | is there (`true`) or not (`false`). |
| `some` | is a list with an item that meets every sub-expectation (their paths start at the item). |
| `every` | is a list whose items all meet them. |

A path is dotted: `results.0.messages`; `*` maps the rest of the path over a list.

```sh
pnpm harness contract lean.check                         # the host's implementation
pnpm harness contract lean.check --host server --implementation kimina --case "timeout"
pnpm harness contract lean.check --out contract-report.json   # the outputs, for the record
```

The command prints each case and exits with 1 if one fails. The rule for updates: a new
implementation or version replaces the old one only when it passes the contract. (Comparing its
speed with the old one's is not implemented yet.)

## The `harness` command

| Command | Does |
|---|---|
| `harness capabilities [--host H]` | Lists the capabilities and the implementations the host uses. |
| `harness describe ID` | Prints the manifest as a model sees it. |
| `harness health [ID] [--host H]` | Reaches every implementation the host lists; exits with 1 if one is down. |
| `harness contract ID [--host H] [--implementation I] [--case NAME]... [--out FILE]` | Runs the contract cases. |
| `harness models [PROVIDER]` | Lists the model providers and whether their credentials are set, or the models of one provider. |
| `harness run ...` | Runs the M0 loop on bench problems ([m0-loop.md](m0-loop.md#commands)). |
| `harness report RUN_DIR [--json]` | Prints the report of a run, built from its journal. |

Run it as `pnpm harness ...` from the repository.

## Adding a tool

1. Write `capabilities/<id>/manifest.json` and `contract.json`: the contract, the model-facing
   description, examples, golden cases.
2. Provide an implementation: an MCP server for an external program (preferred), or a factory
   registered in `FACTORIES`.
   A tool that keeps state between calls is `stateful`, and its MCP implementations give their
   `scope`.
3. Add the capability to the host profiles that offer it.
4. Run `pnpm harness contract <id>` on each host, and `pnpm check`.

Not written yet: choosing among implementations by their measured success on similar goals,
tool search over `deferred` capabilities, and cost and health statistics from the journal's tool
runs.
