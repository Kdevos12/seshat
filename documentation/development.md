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
  child process.
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

The contract of a capability runs against real implementations with `pnpm harness contract <id>`
([capabilities.md](capabilities.md#contract-tests)); it is not part of `pnpm test`. For SageMath
without Docker: `SAGEMATH_MCP_COMMAND=PATH/TO/sagemath-mcp pnpm harness contract compute.sage
--implementation local` ([compute.md](compute.md#with-pip-no-docker)).

```sh
git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git ../google-deepmind/formal-conjectures-bench-v1
FC_BENCH_V1_DIR=../google-deepmind/formal-conjectures-bench-v1 pnpm test
```

## Commits

One logical change per commit, with the code, its tests and its documentation together.
