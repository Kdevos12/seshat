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

The supervisor (`runCampaign`, `campaign.ts`) holds no state that the journal does not (the lock and the heartbeat are for the watchdog). Its loop:

1. Read the journal and decide whether the campaign is over ([How it ends](#how-it-ends)), whether the day's cap or a usage limit makes it wait ([Pacing](#pacing)), and the limit of the turn.
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

- **`--usd-per-day X`** (`campaign.usdPerDay`): the day's spend is counted from the journal by UTC day. Each
  turn's spend (`turn.ended.spent.turn`) is put on the day the turn began (`turn.started.at`, by the
  process's wall clock). Before each turn the supervisor gives it a dollar limit of what is left of the day, so a
  turn ends when the day's spend reaches the cap (one response in flight may pass it, by its cost); when nothing is
  left it journals `campaign.waiting` (`daily_cap`) and waits for the next UTC day. The cap pauses the campaign;
  it does not end it.
- **`--until ISO_TIME`** (`campaign.until`): the campaign stops at that instant (`until`). The turns before it get
  a minutes limit that does not pass it, and a wait for the next day that would pass it ends at it.
- **`--off-peak`** (the default; `--no-off-peak` turns it off): the existing `offpeak` setting
  ([human.md](human.md#off-peak)): each turn and each session starts only at the model's off-peak rate, and waits
  for the window otherwise (`turn.deferred`). The host profile needs the model's pricing calendar.
- **`--spiral-turns N`** (`campaign.spiralTurns`, 8): see [How it ends](#how-it-ends).

The supervisor takes the wall clock and the sleep as options, so a test advances a simulated clock; the same
clock goes to the turns' `wallClock`.

## The watchdog

- **The lock.** `harness campaign` writes `campaign/lock` (its process id and its start). A second supervisor on
  the same run refuses to start while the lock's process is alive, and takes over a lock whose process is gone. The
  lock is released when the supervisor ends.
- **The heartbeat.** `campaign/heartbeat` (the process id, the time, the turns ended) is rewritten each minute and at
  each turn, whichever comes first.
- **Resuming.** A process that dies (a crash, a reboot, a provider's usage limit) is replaced by
  `harness campaign --resume RUN_DIR`, which reads the checkout, the bench and the host from `resume.json` and
  everything else, the pacing included, from the journal. The turn the dead process left open is closed as
  `interrupted` by the next one, as `harness resume` does.
- **The watch.** `harness campaign --watch RUN_DIR` is a small loop that runs `--resume` as a child process and
  restarts it when it dies, or when its heartbeat is older than 15 minutes, after a backoff of 1, 2, 4, ... up to 60
  minutes that starts again whenever a restart ended a turn. It returns when the journal's last word is
  `campaign.stopped`, or when the supervisor was stopped by a person (exit 0 or 130).
- **A usage limit.** A session whose model request ends on a usage limit (a 429, "usage limit", "rate limit",
  "overloaded") ends the turn as `usage_limit` instead of failing, and does not count against the prover. The
  supervisor journals `campaign.waiting` (`usage_limit`) and waits 1, 2, 4, ... up to 60 minutes (one more
  doubling for each such turn in a row) before the next turn. A refusal that a retry cannot cure (a balance, a key)
  is not one: it stops the run as before.

An example, not installed: a systemd user unit (`~/.config/systemd/user/seshat-campaign.service`),

```ini
[Unit]
Description=Seshat campaign

[Service]
WorkingDirectory=%h/seshat
ExecStart=/usr/bin/env pnpm harness campaign --watch %h/seshat/runs/MY_RUN --host local
Restart=on-failure
RestartSec=300

[Install]
WantedBy=default.target
```

started with `systemctl --user enable --now seshat-campaign`, or a cron line that starts the watch at boot and
does nothing when a live supervisor holds the lock:

```cron
@reboot cd $HOME/seshat && pnpm harness campaign --watch runs/MY_RUN --host local >> runs/MY_RUN/campaign/watch.log 2>&1
```

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
