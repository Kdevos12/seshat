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
- `@math-harness/core` has no runtime dependency. Other packages add one only when it clearly
  pays for itself.
- TypeScript is strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), and
  only syntax that type stripping can erase is allowed (`erasableSyntaxOnly`): no enums, no
  parameter properties, no namespaces.
- Tests use `node:test` and `node:assert/strict`. They run without Lean, a model or a network;
  simulated Lean, Kimina and MCP servers stand in. The MCP tests also spawn a small MCP server
  (`packages/registry/test/fixtures/fake-mcp-server.ts`) as a child process, over stdio.
- A change updates the documentation page that describes it, in the same commit.

## Tests that use real data

Some tests run only when their data is on disk:

| Test | Data | Variable |
|---|---|---|
| Sketches of every research-solved theorem | a formal-conjectures checkout | `FORMAL_CONJECTURES_DIR` (default `../google-deepmind/formal-conjectures`) |
| The committed bench index is reproduced | the `bench-v1-lean4.27.0` checkout | `FC_BENCH_V1_DIR` (default `../google-deepmind/formal-conjectures-bench-v1`) |
| Live Kimina check | a running server | `LEAN_SERVER_API_URL` |

The contract of a capability runs against real implementations with `pnpm harness contract <id>`
([capabilities.md](capabilities.md#contract-tests)); it is not part of `pnpm test`.

```sh
git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git ../google-deepmind/formal-conjectures-bench-v1
FC_BENCH_V1_DIR=../google-deepmind/formal-conjectures-bench-v1 pnpm test
```

## Commits

One logical change per commit, with the code, its tests and its documentation together.
