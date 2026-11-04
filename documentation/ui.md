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

## The server

`startServer` (`packages/ui/src/server.ts`) serves the page and the API with [hono](https://hono.dev), bound to
`127.0.0.1` and to nothing else; the address is a constant, not an option. With `--port 0` (the default) the
system picks a free port. It prints one address with a token in it; the first visit trades the token for a cookie
(`HttpOnly`, `SameSite=Strict`) and redirects to `/`, so the token leaves the address bar and the history.

### Security

All of it is in `packages/ui/src/security.ts` and runs before any route, so a request that fails a check never reaches code
that reads a run or starts a process. The tests are `packages/ui/test/server-security.test.ts`.

| Threat | What stops it |
|---|---|
| Another machine on the network | the socket is bound to loopback |
| A web page of another site that has the address | the token: no request is answered without it (cookie or `Authorization: Bearer`), the page included; and an `Origin` header that is not this server's is refused |
| DNS rebinding (an attacker's name that resolves to 127.0.0.1) | the `Host` header must be `127.0.0.1:PORT` or `localhost:PORT` |
| A cross-site form or fetch that changes something | a request that is not a read must carry this server's `Origin` (or `Sec-Fetch-Site: same-origin`), the header `X-Seshat-Request: 1` and a JSON content type, which a cross-origin page cannot send without a preflight this server never grants |
| Script in text that came from a model, a program or a person | every journal text is put on the page as text (the front end never sets HTML), and a content security policy, `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`, forbids inline script, inline style, any other origin and framing |
| A path that leaves the front end's files or the runs directory | static paths are resolved and checked against the build directory; a run id must be one plain name inside the runs directory |
| A token guessed by timing | the comparison is constant time |

Every answer, a failure included, carries the policy, `nosniff`, `no-referrer` and `no-store`. The server logs only what
it says about itself; it never logs a request body, and a line that came from an error has every stored key replaced.

### Running commands

`POST /api/jobs` takes `{kind, ...fields}` for `solve`, `run`, `resume`, `hint`, `steer` or `sign`.
`packages/ui/src/commands.ts` checks each field against a fixed list (length, pattern, range) and builds the
arguments of the command in the `--flag=value` form, as an argument list: no shell reads it, and no value can be taken
for a flag. The text of a hint comes after `--`. A statement is written to a file under `runs/_inputs` with mode 0600
and the command is given that file, so a statement that looks like a path or a flag is read as the text it is.

`packages/ui/src/jobs.ts` is the process manager. It starts `node packages/orchestrator/src/cli.ts ...` with the
process's environment plus the stored keys, keeps the last 2000 lines each command prints (every stored key replaced by
`[key hidden]`), and offers:

- `GET /api/jobs/ID` and `GET /api/jobs/ID/events` (server-sent events: every new line, then the end);
- `POST /api/jobs/ID/stop`, which does what Ctrl-C does: an interrupt first, so that the problems in progress end as
  `aborted` and `RESULT.md` is written; a terminate after ten seconds and a kill after twenty if the command has not
  stopped;
- `POST /api/jobs/ID/answer` with `{"yes": true}` or `false`, the answer to a signature.

One command works on a run at a time. At most four run at once. When the server stops it stops every command it
started the same way and waits for them. A `resume` or `run` the person starts **detached** (`"detached": true`) is
the exception: it outlives the server, writes to a log file under `runs/_inputs` and is not followed afterwards (a command
that needs this page, such as a `solve` that asks for a signature, cannot be detached). A server that is killed outright
leaves its commands running, as any parent does.

**The signature.** `harness solve` asks "Does this say what you mean?" on a terminal. Driven by a program it takes
`--ask-stdin`: it prints one line, `SESHAT_SIGNATURE` and then the signature as JSON (the person's words, the Lean
statement, the test lemmas), and reads one line on its standard input, `yes` or anything else for no. The manager shows that
as a job in the state `awaiting_signature` and writes the answer. The `statement.signed` event is written by the command, as
always, before any spend.

## What the server reads and writes

| Route | Reads | Writes |
|---|---|---|
| `GET /api/runs`, `/api/runs/ID`, `/api/runs/ID/result`, `/api/runs/ID/events` | the journal and blobs of a run, through the reader | nothing |
| `GET /api/doctor` | the machine, as `harness doctor --no-write` does | nothing (the isolation profile is written by the command only) |
| `GET /api/providers`, `/api/providers/ID/models` | the library's providers | nothing |
| `PUT` and `DELETE /api/providers/ID/key` | | the key file |
| `POST /api/jobs` and the routes of a job | | a statement file under `runs/_inputs`; whatever the command it starts writes, as that command |

## Provider settings

No provider is named in this package. `GET /api/providers` lists what the pi-ai library holds at run time
(`packages/ui/src/providers.ts`): its id, name, how many chat models it lists, and whether credentials are found.
`GET /api/providers/ID/models` lists the models of one, with the library's price per million input and output tokens, in the
`PROVIDER/ID` form that `--model` takes.

**Which variable carries a key.** The library reports every environment variable it looks at while it checks a provider's
credentials. The interface asks it, and takes the first name ending in `API_KEY` (then `TOKEN`) with which the library
says the provider is configured; a provider with none (ambient credentials, a login flow) has nothing to save, and the
screen says so. Nothing is mapped by hand, so a provider the library adds works the day it is added.

**Where a key lives.** `PUT /api/providers/ID/key` writes it to `keys.json` in `$XDG_CONFIG_HOME/seshat` (or
`~/.config/seshat`; `SESHAT_KEYS_FILE` moves it). The directory has mode 0700 and the file 0600, written whole through a rename.
A path inside the repository is refused, so a key cannot be committed. The file is read only if it is a plain file of the
current user that no one else can read; otherwise the settings screen says to `chmod 600` it, and no command is started
with keys the interface cannot trust. A stored key counts as credentials for the doctor and for the model list, and a
stored key wins over the same variable in the server's own environment.

**How a command receives it.** The process manager adds each stored key to the environment of the subprocess, under the variable
the library reads: the command finds its credentials as it does when you export them yourself.

**What never happens to it.** The browser can save and delete a key and is never sent one back: the answers say
`stored: true` and nothing more. It is not logged (the server logs no request body, and an error line has every stored key
replaced), not journaled (the interface writes no journal; a command's events never carry the environment) and not echoed: a
line a command prints that holds a stored key is shown as `[key hidden]`. The tests save a key and then look for it in every
answer, every log line and every file under the runs directory (`packages/ui/test/keys.test.ts`).
