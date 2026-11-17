# Campaigns

A campaign is a run that continues alone (plan change LH2, `plans/plan-change-long-horizon.md`): a loop of
consortium turns that do not wait for a person. `harness campaign STATEMENT` takes what `harness solve`
takes (one problem, the signature, the allowance) and runs it for as long as money, time and the claim
allow, instead of for a fixed number of sessions. Nothing about how a claim is settled changes: Lean is the
judge, and only the certifier's kernel replay makes a claim `proved` or `refuted`.

No real campaign has run. Everything here is tested with the faux provider and a simulated Lean, and the
owner has no budget for the $10 real marathon (plan change LH7.2) now.

## The two axes

A campaign is `horizon: "campaign"` and `human: "digest"` ([runs.md](runs.md#the-two-axes)), both recorded in
`run.started`:

- `campaign` has no session cap: a prover's sessions are numbered over the whole campaign (the cold-restart
  schedule caps their length, not their number), and the session prompt omits "of at most N". The
  allowance, the claim settled, the wall-clock end and the spiral guard end it ([How it ends](#how-it-ends)).
- `digest` is a turn that ends by itself (a limit or a breakpoint) and is followed by the next, with nobody
  asked. `campaign` with `consortium` also works and waits for the team as a consortium run does (resume it
  with `harness resume`); `digest` without `campaign` is refused at the start.

`harness campaign` sets `restarts` on (geometric schedule, so every session after a prover's first starts
cold from the frontier, the dead ends and the state card), `frontier.show` on, the off-peak window on (the
existing `offpeak` setting; `--no-off-peak` turns it off) and a turn limit of a tenth of the allowance
(`--turn-usd` changes it). `--usd-per-day`, `--until` and `--spiral-turns` are the `campaign` key of the
configuration ([parameters.md](parameters.md)), recorded with the rest so that a resumed campaign reads them
from its journal.

## The loop

The supervisor (`runCampaign`, `campaign.ts`) holds no state that the journal does not. Its loop:

1. Read the journal and decide whether the campaign is over ([How it ends](#how-it-ends)).
2. Work a turn, by the same path `harness resume` uses (`resumeBench`); the first turn is `solve`'s run.
3. After the turn, rebuild `campaign/digest.md` from the journal, and, when the turn ended at an impasse,
   journal `campaign.mode_changed`.
4. Go to 1.

The impasse breakpoint of a consortium run ("stop and wait") is, in a campaign, a change of mode: today the
only mode is `cold_restart`, and the next turn simply starts cold (Task 60 adds the others). A person's
`hint`, `steer` and `sign` stay available at any time between turns, as in a consortium run; they change what
the sessions are told and the order of the work, never a status.

A question a line or an agent would ask the team does not stop the campaign. The questions that exist today
are the breakpoints of the intake (a statement that is vacuous, a settled literature hit) and two informal
validators that disagree: in a campaign each is written into the digest ("open questions") and the work
goes on without an answer. There is no branch to freeze in a one-problem campaign; when a run has several
problems, the question about one problem still ends the turn for all of them, and the next turn starts, so
nothing waits on the answer. `harness hint` or `harness sign` tells the next turn.

## The digest

`campaign/digest.md` is written by code, whole or not at all, after each turn and when the campaign ends. It
holds: the state; the frontier (its score, its top entries, what is new); what changed in the last turn
(why it ended, what it spent, how many sessions ended how, claim status changes Lean made, new frontier
items, a change of mode); the open questions; and the spend (the run's, against its allowance; the day's,
against the cap). It also counts what CA24's model-free consolidation finds (open state cards, duplicate and
unsupported lessons). No model writes it. It is bounded: each list shows at most eight lines and the page at
most 7000 characters, so it does not grow with the campaign's age.

## Pacing

The settings of the `campaign` key (`usdPerDay`, `until`, `spiralTurns`) are recorded in `run.started`. The spiral guard is described under [How it ends](#how-it-ends).

## How it ends

The supervisor reads the end from the journal before each turn.

| Reason | When | Settled or stopped |
|---|---|---|
| `settled` | a claim of the run is `proved` or `refuted` (only the certifier's kernel replay makes it so) and the run has closed | settled |
| `allowance` | the run's budget is spent | stopped |
| `until` | the wall-clock end `--until` has come | stopped |
| `spiral` | `spiralTurns` (8) turns in a row spent money and the frontier's score did not grow | stopped |
| `ended` | the run finished some other way (an error, Lean unavailable, a provider refusal) | stopped |
| `aborted` | the supervisor was stopped | stopped |

A stop writes `campaign.stopped` with the frontier and says "out of reach at this budget, here is what is
established" in the digest. Only `settled` is not a stop. A claim that was certified at the end of a turn
while its problem had no outcome yet gets one more turn, which spends nothing and closes the run.

## The trust rule

A campaign ends `settled` only when the certifier's kernel replay settles the target; every other end is
`stopped`, with the frontier. A person's answers change what agents are told and the order of work, never a
status. The frontier is evidence of progress, never a status, and the spiral guard reads it only to stop.

## What has not run

No real campaign has run: not against a real model, a real Lean or for days. The tests use the faux
provider, a simulated Lean and injected clocks.
