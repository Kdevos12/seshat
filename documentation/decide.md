# Decide: typed decisions that order work

`decide` is how a line asks for a short typed answer about a short state, to put work in order. By
default the run's own model answers. In the configuration a run can hand some decisions to Jev,
TypeSafe AI's decision-only model, which costs a fraction of a chat model's price and does not
generate text. It is plan change J2 to J4 ([plan-change-jev.md](../plans/plan-change-jev.md)) and
Task 20 of the plan.

A decision orders work. It never changes a claim's status, never judges a statement and never
stands in for what Lean or a tool can decide.

## Proof states go to a third party when Jev is on

With the backend `llm` (the default) nothing leaves the run's own model calls. With `jev`, the
state and the question of every decision at that site are sent over HTTP to OpenRouter or to
TypeSafe AI: a goal with its hypotheses, a conjecture's statement, a list of tactics. If a run
works on unpublished conjectures, keep `jev` off. A run that has `jev` on says so when it starts
(`decide: at ... the states and questions are sent to Jev, a third party`), the host profile says
it in its `description`, and the profile lists the hosts the client may send to (`allowedHosts`);
an address on another host makes the backend unavailable. The state and the question of each Jev
call are kept as blobs of the run, in the tool run of `decide.ask`.

## The call

```ts
const d = await problem.decide.decide({
  site: "prove.search.order",            // one of the three sites below
  state: "n : ℕ\n⊢ n + 0 = n",           // compact: a goal, or a statement; never a whole packet
  question: { type: "choice", instructions: "Which first?", options: { simp: "simp", omega: "omega" } },
  use: "order",                          // required, and the only value, see "Calibration"
});
d.answer; d.probabilities; d.backend; d.model; d.costUsd; d.replayed;
```

`problem.decide` is on every line's context (`Decide` of `@seshat/lines`; absent only in a context
that an older caller builds). The three question types:

| Type | Question | Answer | Distribution over |
|---|---|---|---|
| `choice` | `instructions`, `options` (key to short text, 2 to 255) | an option's key | the keys |
| `score` | `instructions`, `levels` (2 to 10, lowest first) | a level; `expected` is the mean level as an index from 0, the number to order by | the levels |
| `noul` | `instructions` | `true` or `false` | `yes`, `no` |

The result also says `requested` (what the configuration asked for) and, when another backend
answered, `fallback` (why). `replayed` is true when the journal already held the answer.

## Where it may be used

Only these sites accept `decide` (`DECISION_SITES` in `@seshat/core`, each with its question
types), each with the run's model as the default:

| Site | Decision | Question | Call site |
|---|---|---|---|
| `conjecture.relevance` | a Score per conjecture of the pool, on its statement alone (J3 item 1, plan change PC4.2) | `score`, `noul` | Task 13 (not built yet) |
| `prove.search.order` | the order in which to try candidates that come without a model call: battery tactics, mined tactics, library lemmas tried by `apply`, aesop rules (J3 item 3) | `choice` | `decideOrderer` below, for Task 6 |
| `fleet.cold_start` | a prior over strategy families, as capped pseudo-counts (J3 item 4) | `choice` | the fleet's option `coldStart` |

The abductive rerank of J3 item 2 was dropped with Task 12 ([Ruling 20](../plans/seshat-plan-rulings.md)).

**Forbidden, whatever the configuration** (`FORBIDDEN_DECISION_SITES`): the statement-fidelity
review and the equivalence of a Lean statement with an informal one; anything Lean, a decision
procedure or a tool can decide, including whether a step made progress (that comes from
`lean.goals`: open goals, closed subgoals, term size); any change of status; any generation. This is
checked in four places, not by convention: the manifest of `decide.ask` lists the three sites as
the only values of `site`; the backends and `createDecide` refuse a site on the list or off the
list (`ForbiddenDecisionError`) before any backend is asked; a configuration that names one is
refused when the run is configured (`checkConfig`, `--decide-site`); and the journal refuses a
`decision.made` for one. A new site is a change of `DECISION_SITES`, which is a change of the trust
boundary.

## Backends and configuration

| Backend | Who answers | Needs |
|---|---|---|
| `llm` (default) | The run's model, through the line's `llm` (so charged to the problem, tagged by the decision's site, never another provider's key). `votes` independent calls of `judge` ([lines.md](lines.md#judge)); their shares are the distribution. With one vote the distribution has one label at 1. | nothing |
| `jev` | Jev, through the capability `decide.ask`, implementation `jev`. | `JEV_API_KEY`, a pinned `JEV_MODEL`, an allowed host |
| `faux` | Scripted answers, through `decide.ask`, implementation `faux`. For tests; no shipped profile lists it. | a host that lists it |

The configuration (`RunConfig.decide`, recorded in `run.started`; a resumed run keeps it):

| Key | Flag | Meaning |
|---|---|---|
| `decide.backend` | `--decide-backend llm\|jev` | Who decides at the sites with no entry of their own. Default `llm`. |
| `decide.sites.<site>` | `--decide-site SITE=llm\|jev\|off` (repeatable) | A backend for one site, or `off`: `backendFor(site)` says `off` and the line keeps its way of deciding from before `decide` (asking `decide` anyway rejects with `DecisionOffError`). |
| `decide.votes` | `--decide-votes N` | Calls of the run's model per decision, 1 to 9. Default 1. |

**Fallback.** With `jev` asked for, a decision falls back to the run's model, and says why in
`fallback`, when: the host profile does not list `decide.ask`/`jev`; the key or the model is not in
the environment (the capability is unavailable and names the variable); the host is not among
`allowedHosts`; the host cannot be reached (no connection, no answer in time, 5xx, 408, 429);
Jev refuses or answers something the client cannot read; or the request is too long (below). It
never fails the run. A pause (the consortium turn is over) or a stop is not a failure of Jev and is
not turned into a fallback.

**The 32k refusal.** A request of more than 32 000 tokens (state, question and options, estimated
at one token per three characters, a deliberately high count for mathematics) is refused by the
`jev` implementation (`DecisionTooLargeError`) rather than sent in the provider's slower, less
accurate long-context mode. `decide` then answers with the run's model and records why.

The `jev` client does not follow redirects (`redirect: "error"`): a redirect would send the state to
a host that was never checked against `allowedHosts`. An answer that does not say its cost
(`usage.cost`) is booked at a conservative estimate of $0.01 (`JEV_UNREPORTED_COST_USD`), since Jev
charged for the call; it is not refused, which would leave the money off the books.

The model of `jev` is pinned in the host profile through `JEV_MODEL`; a name that ends in `latest`
is refused, so a decision can always be replayed against the exact snapshot.

## The capability `decide.ask`

`capabilities/decide.ask` holds the two backends that leave the process, so that Jev can be replaced
or updated by changing a manifest or a profile ([capabilities.md](capabilities.md#decideask)). It is
`auto` and justifies no status (`produces` is empty). Its input is the request above with the
three sites as the only `site`; its output is `answer`, `probabilities`, `backend`, `model`,
`costUsd` and the tokens. The run's model is not an implementation: it is the line's own `llm`,
which `decide` falls back to. Each call of `decide.ask` is a tool run from `line:<id>`.

The `jev` implementation is a small HTTP client of its own (pi-ai covers chat models, not this
endpoint): `POST {baseUrl}/decisions` with the pinned model, the type, the state, the instructions
and the options or levels, and the key as a bearer token; it reads `answer`, `distribution` and
`usage.cost` (and `usage.prompt_tokens`). **The request and the answer are written from the plan
change's description of OpenRouter's Decisions endpoint and have never been made**: this
environment cannot reach `openrouter.ai`, there is no key, and the shapes may need adjusting
against the real service. The default base address is `https://openrouter.ai/api/alpha`.

## What is journaled and paid

- A call of `jev` is a tool run of `decide.ask` and a `model_call.finished` of the line at the
  decision's site, with its cost from `usage.cost`, charged to the problem's ledger like any model
  call. So `harness report`'s spend by site ([ledger.md](ledger.md#sites)) shows what decisions take
  of the budget, the number that caps any saving a cheaper backend can make.
- Every decision is a `decision.made` ([journal.md](journal.md)): the line, the site, the backend
  that answered and the one asked for, why it fell back, the model as it named itself, the type, the
  labels, the full distribution, the answer, the cost, the model calls and the tool run behind it, a
  blob of the request and a hash of the state. Only the orchestrator writes it, so that no line forges or hides
  one, and the journal checks that the site may use `decide`, that the distribution sums to 1 over
  the labels and that the answer is one of them. It changes no claim.

## Interruption and resumption

A line that calls `decide` follows the contract of interrupted work ([lines.md](lines.md#interrupted-work)):
it lets `isInterrupted(error)` through. Before any backend is called, and again before a fallback,
`decide` checks whether the consortium turn is over and throws the same error `problem.llm` would.

The same question asked twice at once (several provers starting together) is one ask: the second
shares the first one's answer (`replayed: true`, paid once, written once), and a failed ask is not
kept, so the next one asks again.

A decision is identified by its site, state and question. Asked again in the same problem, it is
answered from the journal (`replayed: true`, `costUsd: 0`), nothing is asked and nothing is paid, so
a line declared `resume: "stateless"` that asks the same questions of the same state when its hook
runs again after `harness run --resume` pays once. A decision cut before it was written is made
again, and a partial vote already paid for stays on the books. A decision that fell back is replayed as it was written: if the key is set in the environment when
the run is resumed, the run's model's answer still stands and Jev is not asked again for that
question. Decisions of an earlier journal that
a run starts on (`--memory-from`) are not read: they belong to that run.

## Calibration: order only

No threshold on a probability, from either backend, until a reliability curve exists for the site
(plan change J4). The independent measurements range from an ECE of 0.03 to 0.15 for Jev, and the
provider's own `confidence` measures the concentration of the distribution, not correctness. So
`use` is required and is `order`: `use: "threshold"`, or a request that does not say, is refused with
`ForbiddenDecisionError`, and the manifest accepts only `order`. The distribution a `Decision` carries
is plain data, so a caller that thresholds it anyway is a matter for review, not for the type. The curve will come from the journal: a decision is labeled by the Lean
outcome (did the chosen or top-ranked candidate lead to a proved subgoal within the problem), and
`harness ablate` (Task 14) will print the per-site table and the ECE. `decision.made` holds what
that needs. `createDecide` takes an optional `calibrated(site)`, false everywhere today, for the
task that builds the curve.

## The call sites

**`prove.search` (Task 6).** Task 6, the collaborator's, does not exist yet. `@seshat/decide`
gives it the interface and a test double: `CandidateOrderer.order(state, candidates)` returns the
candidates in the order to try them. `decideOrderer(problem.decide)` asks a Choice at
`prove.search.order`, sorts by probability (ties keep the given order), ranks the first 255 and
keeps the rest after them, and keeps the given order when the site is `off`, with fewer than two
candidates, or when the decision fails. Only candidates that come without a model call are ordered
(`source` is `battery`, `mined`, `library` or `aesop`): a candidate a model proposed has its rank for
free, and `decide` refuses to order it. With the run's model and one vote only the top candidate is
separated from the others; more votes or Jev separate more. `keepOrder` is what the search does
without `decide`, and `scriptedOrderer(first)` is a double for the search's own tests. Nothing in
the harness calls the orderer until Task 6 does.

**The fleet's cold start.** With the fleet option `coldStart` (off by default), the first Thompson
draw of a strategy is seeded with a Choice over the strategy families allowed at that moment. The
distribution becomes pseudo-counts Beta(1 + w p, 1 + w (1 - p)) for each family, added to what the
journal says; `w` is `coldStartWeight`, 2 by default and at most 4, and it fades linearly with the
attempts of the claim (and subgoal) in the journal: gone at 6 (`COLD_START_FADE_ATTEMPTS`), when no
decision is asked any more, so the prior seeds the first sessions and the journal decides after. A weight of 0, the site `off`, no `decide` or a failed decision leaves the flat
prior the fleet had. See [fleet.md](fleet.md).

When the orderer or the cold start keeps the flat or given order because a decision failed, it says
so in the progress log (`log`, passed by the caller; the fleet passes the session's).

## What is not done, and what has not run

- Not run against a real Jev, OpenRouter or TypeSafe: no network and no key here. Everything is
  tested with a fake server, the faux backend and pi-ai's faux provider.
- The ablation line `D1` (J5) belongs to Task 14, and so do the reliability table and the ECE.
- Task 6's orderer and Task 13's relevance score are not built, so `prove.search.order` and
  `conjecture.relevance` have no caller in the harness; the cold start is the only one that does.
- The `llm` backend with one vote has a one-hot distribution; a verbalized probability is not asked
  of the model.
- Token counting is an estimate, not the provider's tokenizer.
- A partial vote of the run's model that a pause cut is paid again when the decision is made again.
