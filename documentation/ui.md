# The local interface

`harness ui` is a small web page on your own machine for the person who would rather click than type.
It lets you state a problem, watch what it costs, stop it, read the result and answer the team. It is
`packages/ui` (`@seshat/ui`). Everything it does is something a command already does: it reads the
journal, and it starts `harness solve|run|resume|hint|steer|sign` as subprocesses. **It contains no
research logic and it cannot change a claim's status**: only a Lean check does, as everywhere else
([trust.md](trust.md)).

This page is built stage by stage, as the interface is.

## The journal reader

`readRun(dir)` (`packages/ui/src/reader.ts`) returns the projection of a run directory as JSON, from its
`journal.jsonl` and its blobs alone, with no model call and no write. Every number and status in it is
what `buildResult`, `buildAccount` and the projection already say ([quickstart.md](quickstart.md#resultmd),
[human.md](human.md)); the reader only gathers them.

| Field | Holds |
|---|---|
| `state`, `stop`, `journal` | how the run ended (finished, paused for the team, or cut), why, and the journal's length, last hash and whether its hash chain verifies |
| `status` | the plain-language status of each problem: `proved` or `refuted` only when a valid kernel replay of that claim is in the journal, `candidate` for a proof that passed the fast check only, `leads` when programs found evidence, and so on. Evidence is never worded as proof |
| `claims`, `edges` | the research graph: each claim with the status the journal holds, its parent and whether it is a problem's claim; each edge with its kind and its status (`lean_checked`, `human_signed`, `proposed`) |
| `leads`, `evidence` | counter-examples and indicative evidence, listed apart; none of it changes a claim's status |
| `turns` | each turn of a consortium run: its limit, why it ended, what it spent, and its account (what the team is asked, what the team has answered) |
| `spend` | dollars and tokens, the budget, what is left, spend per site and per rung of the ladder |
| `proof` | the certified Lean files, then the candidates and the partial sketches, apart |
| `resume`, `resumeInfo` | the command that continues the run, and the checkout, bench and host it began with (`resume.json`) |
| `resultMd` | the text of `RESULT.md` as the journal gives it now |

`listRuns(runsDir)` lists the directories that hold a journal. `runDirectory(runsDir, id)` maps a run id
to its directory and refuses anything that is not one plain name inside the runs directory (`..`, a
slash, a leading dot or underscore). `JournalTail` follows a journal as it grows, reading only the
bytes after the last whole line; what it announces (sequence number, type, actor, time) never carries
an event's data.
