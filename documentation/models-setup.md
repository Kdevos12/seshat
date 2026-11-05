# Model providers for a real run

This page is the configuration of the providers a first real run uses: DeepSeek's own API for the run's
model, and Jev, at OpenRouter or at TypeSafe, for the typed decisions of [decide.md](decide.md). Nothing
on it changes what counts as a result: Lean is the judge ([trust.md](trust.md)), and a model or Jev only
proposes.

Model identifiers and prices are data of the host profiles (`config/hosts/*.json`, plan Ruling 30), so
this page names the providers and the variables, and `pnpm harness models PROVIDER` lists the models.

## The run's model: DeepSeek's own API

pi-ai carries DeepSeek as the provider `deepseek` (the OpenAI-compatible API at `https://api.deepseek.com`),
with its catalog of models, its key variable and its thinking format. Seshat adds nothing to the client;
what it adds is the price table and the defaults:

| What | Where |
|---|---|
| The key | `DEEPSEEK_API_KEY`, read by pi-ai (or saved on the Providers page of `harness ui`) |
| The models | `pnpm harness models deepseek` lists them with pi-ai's prices |
| The prices | `models` of both shipped profiles: the two models of the provider `deepseek`, at their peak prices (cache hit, cache miss, output, per million tokens), with DeepSeek's calendar: peak 01:00-04:00 and 06:00-10:00 UTC Monday to Friday, every other instant at half price ([m0-loop.md](m0-loop.md#prices)) |
| The run's model | `--model deepseek/ID`, or `SESHAT_MODEL=deepseek/ID` for the commands that start work (a resume keeps its run's model) |
| Off-peak | `--offpeak` waits for the half-price hours ([human.md](human.md#off-peak)) |

**The calendar is conservative.** DeepSeek's page also makes Chinese public holidays off-peak all day.
The profiles list none (`offPeakDates`), so a holiday is charged at the peak price: the budget can only
overcount there. Add the dates to `offPeakDates` to count them right.

**Thinking.** DeepSeek's models think by default. A run asks for its thinking level (`--thinking`,
`medium` by default) and pi-ai sends the nearest level the model supports, which for DeepSeek is `high`;
`--thinking off` turns thinking off. In a tool-call loop the reasoning of each assistant message is sent
back, which DeepSeek's API requires in thinking mode ([lines.md](lines.md#the-reasoning-of-a-tool-call-loop)).
The profiles say that the provider ignores `temperature` when it thinks, so the fleet samples no
temperature arm for these models ([fleet.md](fleet.md#sampled-settings)).

**The cache.** DeepSeek caches prompt prefixes by itself and reports `prompt_cache_hit_tokens`; pi-ai
reads them as cache reads, and a charge prices them at the table's cache-hit price, with the saving
recorded (`savedUsd`). Nothing is to be set.

**The model a command uses.** `harness solve` and `doctor` without `--model` take the cheapest priced
model among the providers that have credentials. With `SESHAT_MODEL` set, that model is used instead
(it counts as named). Set it when other providers' keys are in the environment: a key for OpenRouter,
in particular, makes all of OpenRouter's chat models candidates.

## Jev for `decide`

`decide` is off unless a run asks for it (`--decide-backend jev`, or `--decide-site SITE=jev`), and then
the states and questions of decisions go to a third party ([decide.md](decide.md#proof-states-go-to-a-third-party-when-jev-is-on)).
Two providers are configured; `JEV_PROVIDER` picks one:

| `JEV_PROVIDER` | Where | Key |
|---|---|---|
| `openrouter` (default) | OpenRouter's Decisions endpoint | `OPENROUTER_API_KEY`, else `JEV_API_KEY` |
| `typesafe` | TypeSafe's own System One API | `TYPESAFE_API_KEY`, else `JEV_API_KEY` |

Each provider's pinned model and price are in the profiles; `JEV_MODEL`, `JEV_BASE_URL` and `JEV_PATH`
replace them ([decide.md](decide.md#the-two-providers-of-jev)). Prefer `JEV_API_KEY` for an OpenRouter key:
it reaches Jev without making OpenRouter's chat models candidates for the run's model. `JEV_API_KEY` is the key
of the provider chosen, so change it with `JEV_PROVIDER` (an OpenRouter key is refused for TypeSafe).

## The variables

| Variable | For | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | the run's model at DeepSeek | none |
| `SESHAT_MODEL` | the model of `run`, `solve`, `doctor`, `ablate`, `probe` and `optimize-prompts` when `--model` is not given (a resume keeps its run's model) | none: the cheapest priced model, for `solve` and `doctor` |
| `JEV_PROVIDER` | `openrouter` or `typesafe` | `openrouter` |
| `JEV_API_KEY` | Jev's key, for the provider chosen, when its own variable is not set | none |
| `JEV_MODEL`, `JEV_BASE_URL`, `JEV_PATH` | replace the provider's pinned model, address, endpoint | the profile's preset |

Keys are never written into a profile: a profile reads them with `${env:NAME}`.

## Checking the prices

The prices in the profiles were read from DeepSeek's "Models & Pricing" page, OpenRouter's Jev model
page and TypeSafe's model page on 2026-11-05. They change. Before a large run, compare them with the
pages and correct the profile: a corrected price is the price from then on, and a resumed run keeps
the dollars already journaled ([m0-loop.md](m0-loop.md#prices)). A test checks that every priced model
exists in pi-ai's catalog, so a misspelt identifier fails `pnpm check` instead of charging $0.

## What has not run

No request has been made to DeepSeek, OpenRouter or TypeSafe from this repository's environment: there
is no network to them and no key. The tests answer from fake servers in each provider's documented
shape: DeepSeek's streamed `reasoning_content` and cache-hit usage through pi-ai's own catalog entry
(`packages/orchestrator/test/deepseek.test.ts`), and Jev's System One answers
(`packages/decide/test/jev.test.ts`). The first real run is the first check of both.
