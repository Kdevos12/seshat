# Contributing to Seshat

Thank you for your interest. Seshat is a harness for autonomous mathematical research with language models:
models through their APIs, Lean as the judge, classical tools first. It is in beta, and many of its parts
have only run against a simulated Lean and a simulated model ([documentation/status.md](documentation/status.md)).
Running them for real, and reporting what happens, is one of the most useful contributions there is.

## Ways to help

- **Report a run.** Ran `harness solve` or `harness run` on a problem of your own? Open an issue with the
  "Run report" form: what you ran, what it cost, what `RESULT.md` says. Failures are as useful as successes.
- **Report a bug.** Use the "Bug report" form, with the output of `pnpm harness doctor`.
- **Run a part that has never run for real.** [status.md](documentation/status.md) lists them; each page of
  [documentation/](documentation/README.md) ends with what has not run and how to check it.
- **Add a tool.** Every external tool is a capability behind the registry (manifest, contract, host
  profiles); [documentation/capabilities.md](documentation/capabilities.md) shows how. Tools, skills and
  heuristic cards can also ship as a pack (`pnpm harness add`, [documentation/packs.md](documentation/packs.md)).
- **Add a heuristic card** to the bank ([documentation/heuristics.md](documentation/heuristics.md)).
- **Improve the documentation**, especially [documentation/install.md](documentation/install.md) after you
  installed Seshat on a machine it had not seen.

For a larger change, open an issue first so we can agree on the approach.

## Setting up

```sh
scripts/setup.sh --no-lean    # Node packages and .env; enough to work on the code and run the tests
pnpm check                    # the type check, then every test
```

Node 22.19 or later and pnpm 10. TypeScript runs directly through Node's type stripping: there is no build
step. The tests run without Lean, a model or a network: a simulated Lean, fake servers and pi-ai's faux
provider stand in. To run Seshat for real, follow [documentation/install.md](documentation/install.md).

## The rules a change keeps

These come from the plan's Global Constraints; a review checks them first.

- **Lean is the judge.** A claim becomes `proved` or `refuted` only through the certifier's kernel replay,
  and `computed` only through a Lean check. A model's answer, a tool's output, an informal proof or a
  heuristic is evidence, never a status ([documentation/trust.md](documentation/trust.md)).
- **The journal is the only source of truth.** State is an event in the hash-chained journal; tables and
  indexes are projections rebuilt from it ([documentation/journal.md](documentation/journal.md)).
- **Models through their APIs only.** No training and no fine-tuning.
- **Every external tool is a capability** behind the registry, replaceable without touching the rest.
- **Tests need no Lean, model or network**, and give the same result on every machine. What needs a real
  Lean or model is written against its interface, tested with simulations, and documented as not run.
- **Everything in the repository is in English.**
- **Documentation changes with the code**, in the same commit: the page in `documentation/` that describes
  the change, and the README's research-flow diagram when the flow changes (a test checks it).
- **Shared interfaces change additively**: new events, optional fields, new options, with existing
  callers still working.

[documentation/development.md](documentation/development.md) has the coding conventions (strict TypeScript,
`node:test`, no enums).

## Commits and pull requests

- One logical change per commit, with its code, its tests and its documentation together.
- Branch from the latest `main`; open a pull request against `main`. `pnpm check` must pass.
- Fill in the pull request template: what changed, why, and what has or has not run for real.

## The plan

Seshat is built by following one plan, [plans/seshat-plan.md](plans/seshat-plan.md), with its rulings and
a ledger of the state of every task. The maintainer owns the plan: a proposal to change it goes in an issue
or in a new `plans/plan-change-TOPIC.md` file in a pull request. Agents that work on the repository read
[CLAUDE.md](CLAUDE.md) first.

## License of contributions

Seshat is licensed under the [Apache License 2.0](LICENSE). Unless you say otherwise, a contribution you
submit is licensed under the same terms (section 5 of the license). By contributing you agree to follow the
[code of conduct](CODE_OF_CONDUCT.md).
