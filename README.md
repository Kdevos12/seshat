# math-harness

A harness for autonomous mathematical research with LLMs: models through their APIs, Lean as the
judge, classical tools first.

Status: early development (phase P0a). The event journal, the proof validator, a client for Kimina
Lean Server, the capability registry (manifests, host profiles, MCP boundary, contract tests) and
a first bench of 575 problems from
[formal-conjectures](https://github.com/google-deepmind/formal-conjectures) are written and
tested; the loop that runs provers comes next. Nothing has been checked against a real Lean yet.

```sh
pnpm install
pnpm check
pnpm harness capabilities
```

Documentation: [documentation/](documentation/README.md).
