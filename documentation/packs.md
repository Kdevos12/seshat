# Installable packs: tools and skills

Seshat stays modular: a **pack** is the unit of installation for tools and skills. A pack is a
directory (or a git repository) with a `pack.json`; `harness add` validates it and installs it, and
the registry offers what it carries. This page is the reference. The rule behind all of it is that a
pack is **untrusted input**: it is read and checked, never run on install, and it cannot touch a
claim's status.

Plan: PD7 of `plans/plan-change-polya-costs.md`, Task 27. Code: `packages/registry/src/packs.ts`
(the manifest and its checks), `pack-store.ts` (install, list, remove), `skills.ts`, `tool-index.ts`;
`packages/orchestrator/src/packs-command.ts` (the commands).

## Layout of a pack

```
pack.json                           the manifest
capabilities/<id>/manifest.json     one directory per tool, the layout of the repository's own catalog
capabilities/<id>/contract.json     the contract cases the pack carries
skills/<name>.md                    the skills, written by people
```

```json
{
  "name": "adder",
  "version": "1.0.0",
  "description": "Adds numbers.",
  "trust": "computed",
  "writesClaimStatus": false,
  "capabilities": ["pack_adder.padd"],
  "level1": [],
  "skills": [{ "name": "adding", "description": "When and how to add.", "file": "skills/adding.md" }],
  "requires": { "hosts": ["local"], "commands": ["node"], "env": [] }
}
```

| Field | Meaning |
|---|---|
| `name`, `version` | Lowercase letters, digits and hyphens; a version `MAJOR.MINOR.PATCH`. |
| `trust` | The declared trust class. `evidence`: the pack's tools produce no status at all. `computed`: a tool may declare `produces: ["computed"]`, which is an edge or a node of evidence (Ruling 13), never a claim's status. |
| `writesClaimStatus` | Must be exactly `false`. The manifest says it so that a pack that says anything else is refused. |
| `capabilities` | The ids of the tools the pack adds; they must be the ones `capabilities/` carries, neither more nor fewer. |
| `level1` | Tools that ask for the level-1 declared set ([below](#levels)). |
| `skills` | `name`, `description` (at most 300 characters) and `file` (a `.md` or `.txt` file inside the pack, at most 32 KiB). |
| `requires` | `hosts` the tools are offered on (default: every host), `commands` that must be on the `PATH` and `env`: the only environment variables the pack's manifests may read with `${env:NAME}`. `harness add` prints them, and a manifest that reads any other name is refused at load; at run time the interpolation of a pack's manifest sees only those names. Missing commands and variables are reported as warnings; nothing is installed for the pack. |

Any other field is refused (a `scripts`, `postinstall` or `install` field is how a package
manager runs code on install; a pack has no such field, and the refusal says so).

## What a pack may be

Loading a pack reports every problem together (`PackError`). A pack is refused when:

- `pack.json` is not valid, has a field it should not have, or `writesClaimStatus` is not `false`;
- a capability does not load with the repository's own rules (`loadCatalog`: schemas, examples,
  contract cases that do not validate against the manifest, a case with neither `expect` nor
  `fails`), or carries **no contract case**;
- a capability's id does not start with `pack_<name>.` (hyphens of the pack's name become `_`): the tool a model calls is then `pack_<name>_<tool>`, which never takes the name of a tool of the harness (`lean_check`, `expand`, `graph_query`, `tool_search`, the capabilities') nor another pack's;
- a capability's `exposure` is not `deferred` (a pack's tools are level 2);
- a capability `produces` anything but `computed`, has a `certificate` (the way a result becomes
  `proved` or `refuted`), or belongs to an `evidence` pack and produces anything;
- a capability has an in-process implementation: a pack carries **MCP servers**, never code that runs
  inside the harness;
- a text a model will read (the pack's description, a tool's title, description, `when`, `whenNot` and schema descriptions, a skill's description) is too long, or holds a control character, a link, markup (a fence, a tag, a heading) or a sentence aimed at the model ("ignore...", "system prompt"). The caps are 300 characters, 80 for a title and 1500 for a description (Global Constraint 16: text from outside never becomes part of a prompt unscreened);
- a file is a symbolic link, a skill's file lies outside the pack, or the pack has more than 500 files
  or 8 MiB.

## Installing

```
harness add PATH|GIT_URL [--allow-programs] [--level1] [--replace] [--packs-dir DIR]
harness packs [--packs-dir DIR]
harness remove NAME [--packs-dir DIR]
```

The pack directory is `--packs-dir`, `SESHAT_PACKS_DIR`, or `packs/` of the repository (not
versioned). `harness add`:

1. copies a directory, or clones a git url (`https`, `ssh`, `git`, `file`, `git@host:path`; a clone
   runs no code of the repository: no hook, template, submodule, LFS filter or fsmonitor, only the https, ssh, git and file protocols, and neither the user's nor the system's git configuration; it keeps no `.git`. A url that carries a password is refused, and a user name is dropped from the `source` the journal keeps. A local directory is counted, against the 500-file and 8 MiB limits, before it is copied) into a staging directory;
2. loads and checks the staged copy ([above](#what-a-pack-may-be));
3. refuses a capability id that the repository's catalog or another installed pack already has, a skill
   name another pack has, and a name that is installed (unless `--replace`, which journals the
   removal of the old one and the install of the new);
4. refuses a pack with tools unless `--allow-programs` is given: the pack's tools would start the
   programs (stdio) and reach the servers (http) its manifests list, **when a run calls them**. The
   refusal prints them. Installing starts none of them, and a test checks that a program of a pack is
   not started by `harness add`;
5. refuses a leftover `installed/<name>` directory that the journal does not know, with the way out;
6. moves the staged copy to `installed/<name>/` and records `pack.installed` (name, version, content
   hash, trust class, capabilities, skills, programs, source, and what the owner accepted: `acceptedPrograms`, `level1Accepted`, the `env` names) in `journal/`, a journal of its own
   ([journal.md](journal.md)). The orchestrator is the only actor that writes the pack events.

`harness packs` lists the installed packs from the journal (a fold of `pack.installed` and
`pack.removed`), with each pack's hash, the programs its tools run and the requirements that are
missing. `harness remove` writes `pack.removed` and deletes the files; the journal keeps the install.

The contract cases a pack carries are **validated, not run**, on install: running one would start the
pack's program, which `harness add` never does. `harness contract ID` runs them against a host, once
the person has read the pack.

**Content hash.** Any `.git` entry, at any depth, is left out of the hash and of the copy; file modes are not part of the hash (a command that depends on the executable bit is a command the owner read at install).

**Integrity.** The pack journal is hash-chained: `installedPacks` verifies the chain and refuses an edited one. (Like any journal, a chain that is cut at its end still verifies.) The content hash is a sha256 over the sorted paths and file hashes of the pack. A pack
whose files differ from the hash its install recorded is listed as changed on disk and refused when a
registry is opened, and again just before the registry starts a program of the pack (the first call of its tool), which refuses if the files changed in between: a run never uses files nobody installed.

## Levels

A pack's tools join **level 2** of the tool library ([capabilities.md](capabilities.md#manifests)):
the manifest says `deferred`, and the registry offers the tool (on the hosts the pack names, bound to
all its implementations, as an `optional` capability: a tool that does not answer is a warning of
`harness health`, never a failed host). Level 1, the declared set, is the tools a session always shows
the model; changing it changes the prompt prefix and breaks the provider's cache, so a pack's tool is
never in it:

- `toolIndex(registry)` lists the deferred capabilities the host offers, with the pack that adds each,
  and `searchTools(registry, query)` finds them by a plain count of words. These are what `tool_search`
  and `codemode` read. (The tool-search tool itself belongs to the context compiler, Task 11; it reads
  this index.)
- A pack that wants level 1 names the tool in `level1`. That request grants nothing: the owner grants it with `harness add --level1` (recorded as `level1Accepted` in the journal), because a level-1 tool's description is part of the prompt prefix. A registry is built for one session from the
  packs installed before it, and never changes, so the request takes effect in the session **after**
  the install: `checkTools` accepts the tool for `--tool` only then, and a running session's declared
  set is the one it began with.

## Skills

The skills of installed packs fall under Global Constraint 16: they are written by people (a pack
author), and nothing writes a skill from a run's outcomes. At most **3** are loaded in full in a
session; the others are listed by name and description.

`selectSkills(skills, { full, maxFull })` takes the names to load in full (default: none), refuses more
than `maxFull` (0 to 3, default 3), and `renderSkills` writes the full ones and the list, each skill
with its pack. The body is fenced as "text from outside the run" and quoted line by line, so that it cannot forge a heading or close its fence. A skill is advice from outside the run: it is not a lesson and not part of a system
prompt, and nothing in the loop calls these functions yet (the context compiler and the briefing are
their readers).

## Reproducibility

The registry's `hash` includes the name, version and content hash of each pack, and only when there are
packs, so a registry without packs keeps the hash it always had. A run records the packs in
`run.started` (`config.packs`), in `config.json` and in the report ("Packs: ..."); `harness run
--resume` compares the registry hash, so a run is resumed only with the packs it began with.

## What a pack can never do

| It cannot | Because |
|---|---|
| Change a claim's status | A status moves only through a Lean validation of the same claim ([trust.md](trust.md)); a pack's tool output is a `computed` edge or an evidence node at most, and `produces`, `certificate`, in-process code and `writesClaimStatus` are checked at install. The pack events touch no claim. |
| Run code on install | There is no install script; `harness add` copies and reads. |
| Be changed behind the journal's back | The files are checked against the recorded hash each time a registry is opened. |
| Replace a repository capability | Its id is refused. |
| Read the harness's credentials | A pack's manifest may read `${env:NAME}` only for the names in its `requires.env`, which the install prints (the load refuses any other, and the registry interpolates a pack's manifest with only those variables). A stdio server also gets only the environment that programs need ([capabilities.md](capabilities.md#implementations)). The `--allow-programs` summary lists each command, URL, header name and `env` name of every tool. A variable a pack declares is one the owner chooses to hand over: read the list. |
| Put itself in the declared set of a running session | The registry's packs are fixed when it is built. |

## Left out on purpose

A pack whose tool ids a later release of the harness takes is left out with a warning by `openRegistry`, and `harness remove` clears it. A git clone has no size cap of its own besides the 120 second limit (the file and byte limits apply to what it fetched, before the copy is accepted). Tail truncation of the pack journal is not detectable by its chain.

## What is simulated or has not run

Tests run without a network or a model: the installs use temporary directories and a local git
repository (`file://`), and the pack's tool is the test MCP server of the registry's tests (a real stdio
process). Not done: a pack of a real third party; the contract cases of a pack run on a host; the
tool-search tool that reads the index; a caller of `selectSkills` in a session.
