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

## Consult: advice from another model (beta)

**Beta: checked by a dry run only (the faux provider); the owner tests it later with an open-source model.** Plan change NL3. `RunConfig.consult` (`{ model, maxCalls?, maxOutputTokens? }`; `harness run` and `harness solve --consult PROVIDER/ID`, with `--consult-calls N`, default 2, and `--consult-tokens N`, default 1000) gives the outer prover a tool `consult(question)`: one question, as text, to another configured model, answered as text in the prover's context only. It is off unless asked for: no defaults set (`v1`, `v2`) and no arm of an experiment turns it on, and a run without it records, prompts and journals what it always did. The model is looked up like the run's model (`provider/id`, credentials checked before any spend). The tool says of itself: "advice from another model; only Lean decides".

- **Caps.** `maxCalls` per prover session; a call beyond it is a tool error and no model call. A call is also refused when the turn or the problem is over, or when its largest possible cost (the question as input and `maxOutputTokens` as output, at the model's price, the host's table when it has one) would not fit what the problem's budget has left, the check a session makes before it resends a cut response.
- **Cost and journal.** The call is charged to the problem's ledger at the model's price and journaled as a `model_call.finished` at the site `consult`, from the prover's actor (`prover:p1`), with the problem and no attempt (the cost is in the problem's totals; the request blob names the attempt); the question and the answer are blobs as for other model calls. `harness report` and `RESULT.md` count the calls (`consult`: model, calls, dollars) and the spend by site shows `consult`. `describeSet` and the start of `harness solve` say it is on.
- **No status.** The answer never changes a claim, an edge or a status: only Lean's check does.
- **Not built:** the hole sessions of M12 do not have it; only the outer prover. Not run against a real model; `consult.test.ts` covers the tool's absence, a call answered, journaled and charged, the cap, the budget refusal, and the sets unchanged.

## Roles: a model and settings for each place a model is called (CA15, CA23)

`RunConfig.roles` gives a model, and sampling settings, to each place the harness calls a model from. A role that is not named has the run's model and its default settings, and a run without `roles` sends and records what it always did (a test compares the requests). It is in no defaults set.

| Role | The calls it governs |
|---|---|
| `prover` | the outer prover's sessions (`prover.session`) |
| `planner` | the refinement rounds' call of M12, at the site `scheduler.planner` ([scheduler.md](scheduler.md#refinement-rounds-plan-change-ca12-pa11)) |
| `hole` | M12's hole sessions, at the site `scheduler.hole` |
| `verifier` | reserved for the verifier that a later part of Task 39 adds: the setting is checked and kept, and nothing reads it yet |
| `consult` | the consult tool: `roles.consult.model` is another way to name `consult.model`, which wins when both are given |

`roles.escalation` (`{ model, maxShare? }`) is the planner's: see [scheduler.md](scheduler.md#refinement-rounds-plan-change-ca12-pa11).

```json
{ "roles": { "planner": { "model": "provider/id", "settings": { "temperature": 0.2, "thinking": "high" } }, "hole": { "model": "provider/id" } } }
```

- **Model.** `model` is `provider/id`, looked up like the run's model with its credentials checked before any spend: an unknown name, or a provider with no key, is a `RunSetupError` that names the role (`roles.planner.model "x/y": ...`). Each call is charged at its own model's price (the host's table when it has one) to the same ledgers as the run's, and a model with no price anywhere is warned of, or refused under a dollar cap, as the run's model is.
- **Settings.** `settings` holds `temperature` (0 to 2), `topP` (above 0, at most 1) and `thinking` (a level the run knows). They are sent with every request of the role, the one-shot calls (`completeJson` and the like) included. `temperature` is a request option of the provider; `topP` goes as the `top_p` sampling parameter, which only OpenAI-compatible adapters of pi-ai act on, the others ignore it. A temperature or thinking level that a line sampled for an outer session ([fleet.md](fleet.md#sampled-settings)) wins over the `prover` role's, key by key.
- **Ignored settings.** A setting that the host profile says the model's family ignores (`models.PROVIDER/ID.ignores`, [m0-loop.md](m0-loop.md#prices): `always`, or `thinking` for the ones ignored while the request thinks) is not sent and is recorded as ignored, as the fleet does.
- **The journal.** `run.started` records `roles`. A one-shot call or a hole session's response is a `model_call.finished` with the optional fields `role` and `settings` (`{ temperature?, topP?, thinking?, ignored? }`, the settings as sent); the `prover` role's settings are in the `settings` of `attempt.started`, merged with the line's. The planner's escalation adds `escalation`. Fields absent mean the run named no role for the call.
- **The command line.** `harness run` and `harness solve`: `--role ROLE=PROVIDER/ID` (repeatable; ROLE is one of the five, or `escalation`) and `--role-setting ROLE.KEY=VALUE` (repeatable; KEY is `temperature`, `topP` or `thinking`, VALUE read as JSON when it parses; `escalation.maxShare=X`), the way `--line-option` takes its options. Example: `--role planner=provider/id --role-setting planner.temperature=0.2`. A resumed run keeps the roles it began with.
- **To see them.** The start log has a line `roles: ...`, `harness solve` says them in its defaults line (`describeSet`), and `harness report` and `RESULT.md` have one line per role named: `Role hole: provider/id, 4 call(s), $0.0123` (the prover's are sessions).
- **Not run.** Only the faux provider has answered a request under a role (`roles.test.ts`: the planner's call goes to the planner's model and is charged at its price, a setting the family ignores is not sent and is recorded, an unknown model fails at the start, the hole and prover roles, consult through the role, and no `roles`: unchanged). Whether a real provider honours `top_p` through its adapter is untested.

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
