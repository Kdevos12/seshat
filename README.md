# Seshat

A harness for autonomous mathematical research with LLMs: models through their APIs, Lean as the
judge, classical tools first.

Status: early development (phase P0a). The event journal, the proof validator, a client for Kimina
Lean Server, the capability registry (manifests, host profiles, MCP boundary, contract tests), a
first bench of 575 problems from
[formal-conjectures](https://github.com/google-deepmind/formal-conjectures), and the M0 loop
(independent provers on pi, in sessions that pass on their notes) are written and tested with a
simulated model and a simulated Lean. The provers can also be given SageMath, an external program
installed with Docker or pip ([documentation/compute.md](documentation/compute.md)). Nothing has
run against a real Lean or a real model yet.

```sh
pnpm install
pnpm check
pnpm harness capabilities
pnpm harness models
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5
pnpm harness run --checkout ../google-deepmind/formal-conjectures-bench-v1 --model PROVIDER/ID --sample 5 --tool compute.sage
```

The checkout is formal-conjectures at the bench's tag, `bench-v1-lean4.27.0`
([documentation/m0-loop.md](documentation/m0-loop.md#commands)); `pnpm harness models` lists the
models and says whether their credentials are set.

Documentation: [documentation/](documentation/README.md).
