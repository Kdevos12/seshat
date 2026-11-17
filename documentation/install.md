# Installing Seshat

This page is the one road from a fresh machine to a first certified proof. It has three levels; stop at
the one you need:

| Level | What you get | What it takes |
|---|---|---|
| [1. Try it](#1-try-it-node-only) | the command line, the local interface, the heuristic card bank, the tests | Node and pnpm; two minutes |
| [2. A real run](#2-a-real-run) | `harness solve` on a statement of your own, proofs certified by Lean's kernel | Lean 4.27.0, a built Lean environment, a Kimina Lean server, a sandbox, a model key; about an hour the first time and about 15 GB of disk |
| [3. Optional tools](#3-optional-tools) | computer algebra, ATPs and SMT, Lean's language server, literature search, Jev | each one on its own |

Seshat runs on Linux and macOS. On Windows, install WSL2 with Ubuntu and do everything inside it. The
machine it has run on for real is a 4-core Linux laptop with 13 GB of memory
([status.md](status.md)).

## In one command

```sh
git clone https://github.com/Kdevos12/seshat.git && cd seshat
scripts/setup.sh              # levels 1 and 2; --no-lean stops after level 1, --no-kimina skips the server
```

`scripts/setup.sh` does the steps below in order and can be run again: a step that is done is skipped. It
never uses `sudo`; what needs it (bubblewrap) is printed for you to run. It ends with `pnpm harness doctor`
and the next steps. Then:

```sh
$EDITOR .env                  # put your DEEPSEEK_API_KEY in
scripts/kimina.sh             # in a terminal of its own: the Lean server
pnpm harness doctor           # every line a run needs is ok
pnpm harness solve "(n : ℕ) : n + 0 = n" --max-usd 0.10
```

The rest of this page is the same thing by hand, with what each step is for.

## 1. Try it (Node only)

You need **Node 22.19 or later** ([nodejs.org](https://nodejs.org), or nvm or fnm) and **pnpm 10**.
Node ships corepack, which installs the pnpm version that `package.json` pins:

```sh
corepack enable               # once; or: npm install -g pnpm@10
git clone https://github.com/Kdevos12/seshat.git && cd seshat
pnpm install
cp .env.example .env          # the env file, below
```

There is no build step: TypeScript runs directly through Node. Without Lean or a model you can already use:

```sh
pnpm harness --help           # the full command line
pnpm harness ui               # the local interface, on 127.0.0.1 only (ui.md)
pnpm harness heuristics list  # the heuristic card bank (heuristics.md)
pnpm harness models           # the model providers, and which have a key
pnpm harness capabilities     # the tools behind the registry (capabilities.md)
pnpm typecheck                # the type check, under a minute
```

`pnpm check` (the type check, then every test, without Lean, a model or a network) is the bar every change
to the code passes ([development.md](development.md)). It runs about 3,300 tests and can take close to an hour
on a slow disk: you do not need it to use Seshat.

### The env file

`pnpm harness` reads the file `.env` at the root of the repository by itself. Git ignores it. A variable
already set in your shell wins over the file, and `SESHAT_ENV_FILE=PATH` names another file.
[`.env.example`](../.env.example) lists what a run uses:

| Variable | For |
|---|---|
| `DEEPSEEK_API_KEY` | the model, through DeepSeek's own API ([models-setup.md](models-setup.md)). Its name ends in `_KEY` |
| `SESHAT_MODEL` | the run's model, for example `deepseek/deepseek-flash` (the cheapest) or `deepseek/deepseek-v4-pro` |
| `LEAN_SERVER_API_URL` | where the Kimina Lean server answers; `http://127.0.0.1:8000` by default |
| `LEAN_SERVER_API_KEY` | a secret of your choice, the same for Seshat and for the server |

Any provider that pi-ai knows works the same way with its own key variable (`pnpm harness models` lists
them); the defaults and the price tables are DeepSeek's.

## 2. A real run

A real run needs five things. `pnpm harness doctor` checks all of them and says how to fix what is missing
([quickstart.md](quickstart.md#harness-doctor)).

| What | Why | Check |
|---|---|---|
| Lean 4.27.0, through elan | the judge: nothing is proved without it | `lake --version` |
| The Lean environment `base` | formal-conjectures and Mathlib at the bench's pin, built, so that statements and proofs compile | `pnpm harness lean-env show base` says `built` |
| A Kimina Lean server | checks each attempt fast, in a pool of Lean processes | `pnpm harness health lean.check` |
| bubblewrap (or Docker) | the certifier replays a candidate's proof through the kernel only inside a sandbox | `pnpm harness doctor`, line "Certifier isolation" |
| A model key | the provers | `pnpm harness models deepseek` |

### 1. Lean through elan

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y --default-toolchain none
source ~/.elan/env
elan toolchain install leanprover/lean4:v4.27.0
```

The version is fixed: the bench and its results are pinned to Lean and Mathlib 4.27.0 ([lean-env.md](lean-env.md)).

### 2. The Lean environment `base`

```sh
pnpm harness lean-env resolve base   # fetches formal-conjectures at bench-v1-lean4.27.0, checks the versions agree
pnpm harness lean-env build base     # Mathlib's cache, then lake build: 30 to 60 minutes the first time
```

It lands in `lean/env/base/` (git-ignored). The certifier and the Lean server both use it.

### 3. The Kimina Lean server

[Kimina](https://github.com/project-numina/kimina-lean-server) keeps Lean processes warm and answers a
check in seconds. It needs Python 3.9 or later, `git` and `jq`. `scripts/setup.sh` installs it next to the
repository (`../kimina-lean-server`, or `--kimina-dir DIR`), at the commit that ran with Seshat:

```sh
git clone https://github.com/project-numina/kimina-lean-server.git ../kimina-lean-server
cd ../kimina-lean-server && git checkout fb2393d
LEAN_SERVER_LEAN_VERSION=v4.27.0 REPL_BRANCH=v4.27.0 bash setup.sh   # its REPL and a Mathlib project
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install .
cd -
```

Start it with `scripts/kimina.sh`, in a terminal of its own, and leave it running. The script reads `.env`,
listens on 127.0.0.1 only (Kimina's own default is every interface), points the server at `lean/env/base`,
and sets its memory: one Lean process per 4 GB of 60% of the machine's memory, recycled every 50 checks
(100 above 32 GB), and a limit of 12G each. That limit is on virtual memory: below about 12G Lean does not
start. The server's memory grows with use ([lean.md](lean.md#memory-of-the-lean-server)), and `doctor`
warns when it passes 8 GB. Every value can be set in `.env` (`LEAN_SERVER_MAX_REPLS`,
`LEAN_SERVER_MAX_REPL_USES`, `LEAN_SERVER_MAX_REPL_MEM`, `LEAN_SERVER_PORT`).

### 4. The sandbox

```sh
sudo apt install bubblewrap          # Debian, Ubuntu; Fedora: sudo dnf install bubblewrap
```

The certifier runs a candidate's Lean code, which a model wrote, so it runs it only inside a sandbox
([certifier.md](certifier.md#where-untrusted-code-runs)). `pnpm harness doctor` finds bubblewrap (or
Docker), tests that it really confines, and writes `config/hosts/sandboxed.json`, which `solve` then uses
by itself. Without a sandbox Seshat still runs, but every proof stays `computed` and nothing becomes
`proved`.

### 5. The model key, and the first run

Put the key in `.env` (`DEEPSEEK_API_KEY=sk-...`, from [platform.deepseek.com](https://platform.deepseek.com)),
then:

```sh
pnpm harness doctor                                   # every line a run needs is ok
pnpm harness solve "(n : ℕ) : n + 0 = n" --max-usd 0.10
pnpm harness solve "The sum of two odd numbers is even." --max-usd 0.50
```

The first one is proved by the classical tactic battery before any model is asked, for $0.00, which checks
Lean, the server and the certifier end to end. The second may need the model: a statement in prose is
formalized and shown for your signature before anything is spent. Each run leaves `runs/RUN_ID/RESULT.md`;
`pnpm harness view runs/RUN_ID` draws it. [quickstart.md](quickstart.md) is the guide to `solve`, and the
[measured runs](status.md#measured-runs) say what it costs on competition problems (cents each).

## 3. Optional tools

Each one is a capability behind the registry: a run uses it when it is there and goes on without it
([capabilities.md](capabilities.md)). `pnpm harness health CAPABILITY` says whether one answers.

| Tool | What it adds | How |
|---|---|---|
| SageMath (`compute.sage`) | computer algebra for the provers, counterexample search | `docker pull` of the pinned image, or pip ([compute.md](compute.md#installing-it)) |
| z3, E, Vampire (`smt.z3`, `atp.eprover`, `atp.vampire`) | SMT and first-order ATPs on translated goals, rebuilt in Lean | `sudo apt install z3 eprover`; Vampire from its [releases](https://github.com/vprover/vampire/releases); commands `Z3_COMMAND`, `EPROVER_COMMAND`, `VAMPIRE_COMMAND` ([classical.md](classical.md#atp-and-smt-with-reconstruction)) |
| lean-lsp-mcp (`lean.lsp`) | Lean's language server for the provers: goals, hovers, search | `pip install uv`; the harness starts it with `uvx` ([lean-lsp.md](lean-lsp.md#installing-it)) |
| Pantograph (`lean.goals`) | proof states step by step | [lean-meta.md](lean-meta.md#deployment) |
| Literature search (`lit.search`) | OpenAlex, arXiv, Semantic Scholar and zbMATH, searched before paid proving starts | enabled in the shipped host profiles; needs the network ([literature.md](literature.md)) |
| Jev (`decide.ask`) | a cheap typed decision model | `JEV_API_KEY` in `.env` ([models-setup.md](models-setup.md#jev-for-decide)) |
| The bench | the graded problems of formal-conjectures, for `harness run` and `ablate` | `git clone --depth 1 --branch bench-v1-lean4.27.0 https://github.com/google-deepmind/formal-conjectures.git ../fc-bench` ([bench.md](bench.md)) |

## When something goes wrong

| Symptom | Cause and fix |
|---|---|
| `doctor`: no model credentials, though the key is in `.env` | the variable's name: `DEEPSEEK_API_KEY`, not `DEEPSEEK_API`; and the command must be started as `pnpm harness`, from the repository |
| `doctor`: Kimina does not answer, or answers 401 | `scripts/kimina.sh` is not running, or the two `LEAN_SERVER_API_KEY` differ |
| Lean checks time out, "No available REPLs" | the server filled the memory: restart `scripts/kimina.sh`, lower `LEAN_SERVER_MAX_REPLS` to 1 |
| Kimina's REPL does not start | `LEAN_SERVER_MAX_REPL_MEM` below 12G |
| Proofs stay `computed` | no sandbox: install bubblewrap and run `pnpm harness doctor` |
| `lean-env build` stops | it prints the end of the failing command; a network error during Mathlib's cache is retried by running it again |
| A tool is "unavailable" on a slow machine | its health check took more than 15 s while the machine was busy (a Lean build, a test run); try again when it is idle |
| A timed test fails under `pnpm check` | a test with a time limit on a slow or busy machine; run it alone (`node --test FILE`) |

## Updating

```sh
git pull
pnpm install
pnpm harness doctor
```

The Lean environment changes only when the bench's pin does, which is announced in [status.md](status.md).
