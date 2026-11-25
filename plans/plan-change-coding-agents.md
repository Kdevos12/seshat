# Plan change: a coding agent behind Seshat, and models by role and depth (EA1 to EA6, MM1 to MM3)

Status: **APPROVED by the owner 2026-11-25 at 09:02 UTC** (decision card "Approuver la proposition EA1 à EA6 et MM1 à
MM3, et jusqu'où ?", option "Tout, dans l'ordre proposé": EA1 to EA6, MM1 and MM2 in the order below; MM3 still needs
the owner's go and a cap). Proposed 2026-11-25. Written by the thread "Brancher un agent de code sur Seshat"
(read-only on the repository and the plan), after the owner asked (2026-11-25 08:43 UTC) for an optional, off-by-default
connector that lets a coding agent take instructions from Seshat, (1) as a developer for long coding tasks and (2) as a
reasoning partner on holes when the recursion reaches its maximum depth, following a convention if one exists; and
whether models could be mixed by task, with different models for the recursions and the main run. At 08:48 UTC the
owner accepted the connector's risks (cost hard to meter, workspace isolation, output as advice until `validate`) and
framed the connectors as **features of an engineering project, not something Seshat is evaluated on**: no benchmark
gates them. The report it rests on, in French: `research/agent-de-code-et-mix-de-modeles.md` (in the project files,
not in this repository). Read against `main` at `b5aa04d` and DP7 as the build thread described it (branch
`claude/project-thread-h60gyw`, not merged: `longProof.depth`, default 1; redrafts use the `planner` role, their holes
the `hole` role).

## Evidence in one paragraph

Both asks are mostly wiring. A coding-agent connector already exists: `@seshat/library-builder`'s builder
`coding-agent` runs a CLI agent (defaults for `claude-code`, `codex`, `opencode`, `agy`, `pi`) in a clone with an
environment of its own, behind the person's sandbox command, and keeps nothing it did unless Seshat's own gate (diff,
token screen, spec, fresh build, certifier) accepts the files; it has jobs `fill` and `port`, has never run against a
real agent, and nothing in a run calls it. The convention for "a program drives a coding agent" is the **Agent Client
Protocol** (ACP; Zed and JetBrains, Apache-2.0): JSON-RPC 2.0 over stdio, the client launches the agent and calls
`initialize`, `session/new` (with `cwd` and a list of `mcpServers` the agent must connect), `session/prompt`,
`session/cancel`; the client answers `session/request_permission` and serves `fs/*` and `terminal/*` only if it
declares them; agents may report `usage_update` with an optional cumulative cost. About 51 agents are listed: Gemini
CLI, Goose, OpenCode, Hermes Agent (any OpenAI-compatible provider), Qwen Code and others directly, Claude Code
(`claude-agent-acp`), Codex (`codex-acp`) and pi (`pi-acp`) through adapters. A2A (remote agents over HTTP) and MCP
(tools for an agent) are not this convention. Per-role models already exist (`RunConfig.roles`: `prover`, `planner`,
`hole`, `verifier`, `consult`, plus `roles.escalation`, CA15, CA23), charged and reported per role; what is missing is a
model by recursion depth and a per-role picker in the interface. On mixing, the literature supports a split of
**roles** (a strong general reasoner plans, a cheaper or specialised prover proves: Hilbert 99.2% miniF2F and 70.0%
PutnamBench, "the choice of informal reasoner appears more critical than prover strength"; DeepSeek-Prover-V2;
Numina-Lean-Agent), escalation on failure, and a different verifier; it does **not** support mixing several models on
the same task and fusing their answers: Self-MoA (arXiv 2502.00674) beats mixed Mixture-of-Agents by 6.6% on AlpacaEval
2.0 and 3.8% on average over MMLU, CRUX and MATH, "mixing different LLMs often lowers the average quality". A
generalist-plus-specialist prover pair (arXiv 2608.18084) gains little over the best single model (39.3% against 36.9%
on RLMEval-FLT3) but with 13.5 calls instead of 32. Cost frame: Numina-Lean-Agent spent about $50 per Putnam problem
with Claude Code; Seshat's run 7 spent $0.64 for three. A coding agent is one to two orders of magnitude dearer than a
Seshat session unless it runs on the same cheap API (OpenCode or Hermes on DeepSeek).

## Principle

One connector, the existing one. ACP is a transport of the `coding-agent` builder, not a second path; the new uses are
new jobs of the same builder, with the same clone, environment allowlist, sandbox rule, gate and record. Everything is
off by default, in no defaults set and no arm. The agent's output is files and quoted text: only `validate` and the
certifier change a status (Ruling 13, Global Constraint 16). For models: no new role and no mixing on one task; the
existing roles gain an optional override by depth, and the interface shows them.

## The changes

| # | Kind | Change | Acceptance |
|---|---|---|---|
| EA1 | CHECK, free | **The agents as they are installed.** `harness doctor` gains a section "coding agents" (only when `config/library-builder.json` selects `coding-agent`, or `--agents`): for each configured agent, whether its command is on `PATH`, its `--version`, and for ACP whether `initialize` answers within 10 s (protocol version, `loadSession`, MCP capabilities). The five default CLI commands of `library-builder.md` are checked against the releases installed on the owner's machine and corrected in the table, with the date. | A fake agent script that answers `initialize` is reported ready; a missing command is reported missing, not an error of the doctor; the table carries the checked flags and a date. |
| EA2 | MOD (`library-builder`: `coding-agent.ts`, `agent.ts`) | **ACP as a transport of the one builder.** `agent.transport: "cli" \| "acp"`, default `"cli"` (today's behaviour, byte for byte). With `"acp"`, Seshat is the client through the official TypeScript SDK (`@agentclientprotocol/sdk`, pinned): it launches the agent's ACP command behind the same `sandbox` command, with the same environment allowlist, `HOME`, `TMPDIR` and clone; declares no `fs` and no `terminal` capability (the agent uses its own tools inside the sandbox; the sandbox and the gate stay the trust boundary); passes `mcpServers` from the settings (by default the `lean-lsp-mcp` command that `lean.lsp` already wraps, pointed at the clone); answers `session/request_permission` by the settings' policy (`allow` inside the sandbox by default, `deny` for a kind the settings list), each answer journaled; sends the prompt with `session/prompt`; on the time limit or abort, `session/cancel`, then the process group is killed as today. Default ACP commands per agent are in a table next to the CLI table (`gemini --experimental-acp`, `opencode acp`, `hermes acp`, `claude-agent-acp`, `codex-acp`, `pi-acp`, `goose acp`: checked by EA1). `usage_update` notifications are recorded; a reported cost is charged to the ledger of the job's caller. | Fake ACP agent (a script over stdio): a `fill` job over ACP produces the same gate verdict and record as over CLI; `session/cancel` is sent at the time limit and the job is `failed`; permission answers are journaled; `mcpServers` reaches the agent; `transport: "cli"` unchanged (existing tests). |
| EA3 | ADD (job `hole`; M12 hook at DP7's limit) | **The reasoning partner on a hole.** `RunConfig.externalAgent` (absent = off; `{ agent settings as in config/library-builder.json, maxHoles?, rounds?, timeoutSec?, budgetUsd?, allowUnmetered? }`): under `longProof`, a hole that ends `too_hard` **at DP7's maximum depth**, for a reason other than `budget`, with no `suspect_false` node (VL4 sends those to a redraft first), is handed to the agent before it counts as failed for a refinement round. The agent gets a clone of the problem's workbench with one file: the header, the frozen context (LP3's accepted lemmas and VL5's local definitions), the hole's declaration with `sorry`, the informal step as a quoted comment, and the first lines of the last errors of its sessions; the prompt says: prove this declaration, change nothing else. The gate is the job's own, cheap: the diff touches only that file and only the hole's body; the validator's token screen; then the body is submitted through `validate` as a hole session's proof would be, and the result is recorded as an `m12_session` with the optional field `external` (`agent`, `transport`, `rounds`, `usage`, `unmetered`). Over ACP, a refused proof is sent back in the same session with Lean's first error, up to `rounds` (default 2). With no accepted proof, the agent's last message is the session's `argument` (quoted data, screened as prose) for the next refinement round. Caps: `maxHoles` per problem (default 1), `timeoutSec` (default 900), `budgetUsd` per hole passed to the agent when it has a budget flag; a hole is handed over only if the problem's remaining allowance covers `budgetUsd`; an agent that reports no cost needs `allowUnmetered: true`, and its jobs are counted and reported as unmetered. `harness solve --external-agent NAME` with `--external-agent-config FILE`. | Simulated (fake agent, simulated Lean): a hole at max depth is handed over and its proof validated (`computed`, same claim); a proof that edits another declaration is refused before `validate`; a refused proof goes back once with the error and is accepted at round 2; a `budget` hole, a hole above max depth and a `suspect_false` hole are not handed over; `maxHoles` holds; unmetered without `allowUnmetered` is refused at setup; absent `externalAgent`, the requests and journal are byte-identical. |
| EA4 | ADD (job `compute`) | **A long coding task: a program that computes.** `harness agent compute SPEC.json`: a spec (person-written, or screened like a non-human library spec) names a question, the language and runtime allowed, the output format (JSON) and a time limit. The agent writes a program in the clone; the gate allows only files under `compute/<id>/`, then **Seshat re-runs the program itself** behind the sandbox with the spec's limits and keeps the output only if the re-run matches what the agent reported. The output is an evidence node with the program and its output as blobs (Ruling 13: never a status; a Lean check of a stated fact can then make a `computed` edge as usual). Wired into runs later only if a line asks for it; the CA campaign is the first user. | Fake agent: a program that prints a sequence is re-run and recorded as evidence; an output that differs on re-run is rejected; a file outside `compute/<id>/` is rejected; nothing changes a claim. |
| EA5 | DOC | **`documentation/library-builder.md` becomes the connector's page**: the transports, the jobs (`fill`, `port`, `hole`, `compute`), the caps, the unmetered rule, what has not run. `models-setup.md` links it. The README diagram gains the dotted, optional arrow "too hard at max depth → external agent → validate" (`:::wait`, not run). | The diagram test passes with the new node; the pages name every option. |
| EA6 | ADD (interface) | **One switch.** The settings panel's advanced group gains "External coding agent (off)": agent name, transport, caps, the unmetered warning. | The panel writes `externalAgent` into the settings file and `solve` reads it; absent, the file is unchanged. |
| MM1 | MOD (`roles.ts`, shared: optional field) | **A model by depth.** `RoleConfig` gains optional `deeper?: { model?, settings? }`: used for the role's calls made at DP7 depth 1 or more (the redraft's `planner` call, the redraft's `hole` sessions); depth 0 keeps the role's own. Checked and resolved at setup like any role model; the journal's `role` field is unchanged and `model_call.finished` gains optional `depth`. The documentation says what the evidence supports: a **stronger** model where the redraft reasons (`planner.deeper`), not a cheaper one to save money. | Faux provider: a depth-1 redraft goes to `planner.deeper.model` and is charged at its price; depth-0 calls are unchanged; no `deeper`: byte-identical requests. |
| MM2 | ADD (interface) | **Models by role in the settings panel.** Today `roles` and `consult` are advanced parameters typed as JSON. The panel gets one model picker per role (the models `harness models` lists, with their price), `escalation` with its share, and `deeper` per role; the solve defaults line says them. | The panel round-trips a settings file with three roles and an escalation; an unknown model is refused by the same check as the command line. |
| MM3 | MEASURE, needs the owner's go and a cap | **One equal-dollar measurement of the role split.** On run 7's three problems (or the 20 level-B ones): `solve-v2-long` on one model against the same arm with `planner` (and `planner.deeper`) on a stronger model and `prover` and `hole` on the cheap one, at the same dollar cap per problem. Reported: solved, dollars, holes proved, spend by role. Not a gate for anything above. | Two RESULT.md files and one ledger line; no default changes either way unless the owner decides. |

## What is not proposed, and why

- **Mixing several models on one task and fusing their answers** (Mixture-of-Agents): Self-MoA shows the best single
  model sampled several times does better; Seshat already samples one model several times and lets Lean judge.
- **A2A**: for remote agents over HTTP; the agent runs on the same machine.
- **A Lean-specialised prover as a role** (the strongest mixed results pair a general reasoner with a 7B to 32B prover
  fine-tuned for Lean): allowed only through a provider's API; whether one serves such a model at a usable price is an
  open question, recorded here, not a task.
- **Seshat developing itself through the connector**: that is the person's coding agent with the Seshat skill, the
  other direction.

## Trust rules, unchanged

- Only Lean decides. A hole's proof from the agent is `open` until `validate` accepts it, then `computed`; the certifier
  settles the problem as today. A program's output is evidence. The agent's text is quoted data, screened as prose.
- The agent's exit code, claims and logs are never verdicts: the gate reads files.
- The agent never sees the harness's keys; it runs in a clone with no remote, behind the person's sandbox command or
  with an explicit `unsandboxed: true`, as `library-builder` already requires.
- Off by default; in no defaults set and no arm.

## Order

EA1 first (free, and it fixes the CLI table that is unchecked today). Then EA2, then EA3 once DP7 is merged (it hooks
at DP7's limit), then EA5 and EA6 with them. MM1 with or after DP7's merge; MM2 with EA6 (same panel). EA4 when the CA
campaign needs it. MM3 only on the owner's go. No benchmark gates EA1 to EA6 or MM1, MM2 (owner, 2026-11-25 08:48).

## Cost if this is wrong

If ACP's adapters prove unstable, `transport: "cli"` stays and nothing else depends on ACP. If the partner rarely
proves a hole, it costs nothing unless turned on. If `deeper` is never used, it is one optional field.
