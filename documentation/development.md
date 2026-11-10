# Development

## Requirements

- Node 22.19 or later. TypeScript runs directly through Node's type stripping: there is no build
  step, and imports name `.ts` files.
- pnpm 10 (`packageManager` in `package.json`).

```sh
pnpm install
pnpm check        # tsc --noEmit, then all tests
pnpm test
```

## Conventions

- Everything in the repository is in English.
- Packages live in `packages/*`, each with `src/` and `test/`, and are linked by pnpm workspaces.
  A package exports `./src/index.ts`.
- `@seshat/core` has no runtime dependency. Other packages add one only when it clearly
  pays for itself.
- TypeScript is strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), and
  only syntax that type stripping can erase is allowed (`erasableSyntaxOnly`): no enums, no
  parameter properties, no namespaces.
- Tests use `node:test` and `node:assert/strict`. They run without Lean, a model or a network;
  simulated Lean, Kimina and MCP servers stand in. The MCP tests also spawn a small MCP server
  (`packages/registry/test/fixtures/fake-mcp-server.ts`) as a child process, over stdio. The M0
  loop runs with pi-ai's faux provider, whose answers each test writes, and a simulated Lean
  (`packages/orchestrator/test/m0-helpers.ts`), and with a simulated SageMath server over an
  in-memory transport (`packages/orchestrator/test/fixtures/fake-sage.ts`), and a simulated
  lean-lsp-mcp (`packages/lean-lsp/test/fixtures/fake-lean-lsp-mcp.ts`, which checks every call
  against the arguments recorded from the real release); the command tests run `harness` as a
  child process. A test gives the same result whatever the machine has on it. The command tests set
  `SESHAT_LEAN_ENV_DIR` to a copy of `lean/env/*.toml` without the projects (`freshLeanEnvDir` in
  `m0-helpers.ts`): a resolved environment would otherwise add `+env:NAME@HASH` to every Lean tool's
  version, and a built one would become the default `LEAN_PROJECT_DIR`
  ([lean-env.md](lean-env.md#in-a-run)). They set `LEAN_SERVER_API_URL` to an address that answers
  nothing unless a test starts its own fake server, so a Kimina server on the machine's default
  address is never asked; and `cli.test.ts` sets `HARNESS_HOST=local`, so `solve` and `doctor` do not
  take the `sandboxed` profile a `harness doctor` may have written. The interface's tests give the
  server an environment and a config directory of their own (`packages/ui/test/helpers.ts`), so the
  machine's model credentials and host profiles are not seen.
- A change updates the documentation page that describes it, in the same commit.
- The diagram in the README, "How research flows", shows the steps a statement goes through and the
  tools a prover can call, each marked built, written but waiting for a Lean server, or planned. A
  change to that flow, such as a new capability, a new step, or a planned part that gets built,
  updates the diagram in the same commit. A test fails when a capability's tool is missing from the
  diagram or a node has none of the three marks
  (`packages/orchestrator/test/readme.test.ts`).

## Tests that use real data

Some tests run only when their data is on disk:

| Test | Data | Variable |
|---|---|---|
| Sketches of every research-solved theorem | a formal-conjectures checkout | `FORMAL_CONJECTURES_DIR` (default `../google-deepmind/formal-conjectures`) |
| The committed bench index is reproduced | the `bench-v1-lean4.27.0` checkout | `FC_BENCH_V1_DIR` (default `../google-deepmind/formal-conjectures-bench-v1`) |
| Live Kimina check | a running server | `LEAN_SERVER_API_URL` |
| The contract of `lean.lsp` against lean-lsp-mcp | a built Lean project and `uvx` (or `LEAN_LSP_MCP_COMMAND`) | `LEAN_PROJECT_DIR`; `LEAN_LSP_SITES=1` adds the four cases that ask network sites |
| `lean.lsp` against the real lean-lsp-mcp, its language server and sites canned (no Lean, no network) | a Python with `lean-lsp-mcp==0.31.0` and `leanclient==0.13.2` | `LEAN_LSP_MCP_PYTHON` |
| `lean.search` against a real search service or an index of Mathlib, and its `#check` verification against a real Lean | a service at `LEAN_SEARCH_URL` or `LEAN_PATTERN_URL`, or an index at `LEAN_SEARCH_INDEX`; a Kimina server | `pnpm harness contract lean.search` (needs a backend set up) |
| Graph and group batteries read from SageMath (`@seshat/models`) | the `sagemath-mcp` executable | `SAGEMATH_MCP_COMMAND` |

The contract of a capability runs against real implementations with `pnpm harness contract <id>`
([capabilities.md](capabilities.md#contract-tests)); it is not part of `pnpm test`. That includes
`oeis.search`, `lmfdb.query` and `findstat.identify`, on a host that reaches the sites; `pnpm test`
runs their contracts against a local server instead. For SageMath
without Docker: `SAGEMATH_MCP_COMMAND=PATH/TO/sagemath-mcp pnpm harness contract compute.sage
--implementation local` ([compute.md](compute.md#with-pip-no-docker)).

```sh
git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git ../google-deepmind/formal-conjectures-bench-v1
FC_BENCH_V1_DIR=../google-deepmind/formal-conjectures-bench-v1 pnpm test
```

## Commits

One logical change per commit, with the code, its tests and its documentation together.

## Working together

Several agents, driven by different people, build Seshat at the same time. [CLAUDE.md](../CLAUDE.md)
at the root is the protocol every one of them follows: sync at the start of each session, one
branch per task, who writes which file, how a task is merged into `main`, and when it is done. The
plan and its state are in [plans/](../plans/seshat-plan-ledger.md): the plan, its rulings, one ledger
per team, and the approved plan changes.
