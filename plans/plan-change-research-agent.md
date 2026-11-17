# Plan change: a research agent above the kernel (a lead that plans, delegates, reads and loops)

Status: **direction approved by the owner on 2026-11-12 at 01:12 UTC** ("Ça me va parfaitement, à bien
brancher au mode consortium sur lequel on travaille, et à lire la littérature ou les articles
substack/medium sur le sujet avant d'implémenter pour ne pas faire ça aléatoirement"), with the choice
recorded on the decision card: a minimal agent first, measured before the rest is built. This is the
second version, revised the same night after the reading the owner asked for
(`research/agent-de-recherche-lectures.md`, in French, outside the repository, with its sources) and
wired to consortium mode (section 5). What the reading changed is marked **[reading]**.

Written by the thread "Augmenter les capacités de Seshat de 50 %", after the owner wrote that Seshat
gives the impression of "a relatively linear and inflexible agent, with very scripted tool use,
little recursion, few sub-agents, few loops". Items are named RA1 to RA11. It goes with
`plans/plan-change-literature.md` (LW1 to LW6). Nothing here is built yet.

## 1. Why

What Seshat is today (`documentation/architecture.md`, "A problem, end to end"):

- A thin, deterministic orchestrator decides everything: which problems, how many provers, the
  budget, the tools, when to stop.
- A prover is a model in fresh sessions that edits two regions of a Lean file and calls
  `lean_check`. In the baseline arm of the real pilot of 2026-11-11, the 23 tool calls of one
  problem were all `lean_check`, its only tool.
- The lines (M1 to M17) are hooks at fixed points of that loop, not agents. The model never starts
  a sub-agent, does not choose its tools, and does not decide to read, to compute, to split the
  problem or to change plan.

This was a choice of October: every mechanism is a switch compared at equal budget, every run is
replayable, Lean alone judges. It gives a cheap solver of exercises (6 grade B problems certified
for $0.13). Its price is that the researcher is the script. On an open problem a researcher loops
at a higher level: tries a small case, reads, reformulates, splits, drops a dead branch, comes
back.

## 2. What the reading says [reading]

Seven findings, with their sources in the note:

1. What pays is typed state, a bounded context, literature and verification, not the agent's
   freedom (RMA's ablations: 8.5 with all; 2.6 with a stateless store; 4.2 without literature).
   Seshat's journal, graph and context compiler are that spine and stay at the centre.
2. One writer. Parallel writers make conflicting implicit decisions (Cognition); read-only
   sub-agents, a reviewer with a clean context and delegation managed by one lead work.
   Independent agents amplify errors 17 times, a centralized system 4 times; multi-agent variants
   lose 39 to 70% on sequential tasks and gain on parallel ones (Google, 180 configurations).
3. Decompose only when the direct attempt fails, and not deep: most of the gain is at depth 1 to 2
   (Hilbert, ADaPT). A global plan of lemmas refined after failure is preferred to nested recursion
   by Goedel-Architect, on our small model.
4. The simplest agent goes far: AlphaProof Nexus's basic agent, which is the shape of Seshat's
   present loop, reproduced all 9 Erdős results of their full agent. Their difference is the model
   and a budget of hundreds of dollars per problem.
5. Tokens buy performance and a multi-agent system uses about 15 times a chat's (Anthropic).
6. Literature is the most common useful outcome and the first source of errors (Aletheia: of 13
   real results on open Erdős problems, 5 were "already in the literature"; citations that exist
   but are misquoted).
7. A person in the loop pays: 30% to 52% task completion with help asked in 10% of tasks
   (Magentic-UI); goals approved by the mathematician and escalation when stuck (AI
   co-mathematician).

Not established anywhere: that a free lead beats a scripted loop at equal dollars with a small
model on open problems. Hence the minimal slice and RA11.

## 3. The principle: a kernel and what runs on it

The **kernel** carries the trust rules and does not change: the journal, the budgets, the
capability registry and the sandbox, `validate` and the certifier, the memory store and the graph.
Everything above it is a policy or an agent.

Two modes on the same kernel, chosen by a field of the run's configuration:

- `scripted`: today's loop, byte-for-byte. The baseline and the cheapest path.
- `lead`: a research agent per problem. The scripted loop becomes what a `prove` child runs.

## 4. The items

### RA1. The capabilities become tools an agent can choose

In `lead` mode an agent is offered the host's capabilities through the three levels the registry
already has: a few always declared (the plan, delegation, Lean check and goals), the rest found on
demand by tool search (Mathlib search, Sage, OEIS, LMFDB, FindStat, the classical battery,
literature search and reading, memory queries: what was tried, which lemmas are proved, which
failed and why). Each call is a tool run of the journal, charged to the caller. Each tool has one
distinct purpose and a short description that says when not to use it. [reading]

### RA2. The lead: the only writer of a plan that lives in the journal

One lead per problem. It does not write Lean. It holds the **research plan**: a graph of goals,
each a claim or an evidence need (the target, lemmas, special cases, a generalization, a
counterexample search, a reading), with its status read from the journal. **Only the lead writes
the plan.** [reading]

Beside the plan, an **obstacle ledger**: typed, ranked entries ("lemma L fails on the case n = 0",
"no source found for the bound", "statement may be vacuous"), each tied to a goal, ranked by
severity and by how many goals depend on it. The lead works the top entries first. [reading]

Its loop, one round at a time: read the state card, the plan and the top obstacles (all rebuilt
from the journal, within a token budget), choose one typed action, act, record. Each round is a
fresh context. Typed actions: `delegate`, `call a tool`, `revise the plan`, `ask the team`
(section 5), `conclude`.

### RA3. Delegation: children with a contract

`delegate(goal, kind, budget)` starts a child with a fresh context and a brief of a fixed shape
compiled by the harness: objective, expected output, tools, boundaries. [reading] Kinds:

- `prove`: a goal with a Lean statement. Today's prover loop, unchanged. The child sees its lemma
  and the dependencies the plan declares for it, nothing else: the contract between children is
  a Lean statement, not prose. [reading]
- `explore`: small cases, a computation, a counterexample search. Read-only: evidence nodes.
- `read`: find and read sources on a goal. Read-only: `literature` nodes with screened quotes.
- `formalize`: state a lemma in Lean, under the existing fidelity checks.

Children return typed results to the journal and the lead reads references to them, not long
reports. Children of one batch run in parallel as far as the host allows; the lead waits for the
batch.

### RA4. Recursion by refinement, not by nested leads [reading]

When a goal's child fails, the lead may refine that goal into sub-goals inside the same plan
(depth limit 2 by default). This is the recursion: the same single writer, one global plan,
as-needed. A `plan` child (a lead for a sub-goal, with its own plan) is **not** in the first
version: nested planners are where the reading reports loops on dead ends and conflicting
decisions. It stays a later option, measured against refinement, if deep problems show the need.

### RA5. Budgets in cascade, effort by rule, no lead for an easy problem

- Every child's cap is carved from its parent's remaining allowance (child ledgers exist). The
  lead's own rounds are capped at a share of the problem's allowance (default 20%). The budget
  gate is asked at each delegation.
- The number of children per batch and their caps are derived by the harness from what remains,
  not left to the model. [reading]
- Escalation: the classical battery, then the scripted probe, and the lead starts only when the
  probe fails. A problem the probe closes for $0.02 never pays for a lead.

### RA6. Guards against the known failures [reading]

- **Repetition and non-termination**: budgets end everything; the repeat rule applies to
  delegations (a third identical failure forces a plan revision, a fourth ends the branch).
- **Stall**: when a set number of children in a row bring no Lean progress (default 3), the next
  round must be a plan revision or a question to the team.
- **The lemma that hides the problem**: a goal whose statement restates its parent (the same up to
  renaming, checked mechanically) is refused.
- **Invented known results**: a lemma assumed "from the literature" needs a `literature` node with
  a screened quote; without one it is an open goal like any other.
- **Review spirals**: Lean reviews what is formal. Any critique by a model is limited to two
  rounds on a goal; after that the goal is marked stalled and goes to the team.

### RA7. Stepping back

After each batch, and at each budget round, the lead chooses explicitly among: continue; refine;
reformulate (a special case, a generalization, an analogous problem: the owner's direction of
2026-10-20); test (look for a counterexample before proving more); read; ask the team; stop with a
report. It is shown a few cards of the heuristic bank (Task 32) drawn for the situation. The
choice and its reason are journaled.

### RA8. The lines become policies

No line is lost; each keeps its switch. The battery (M10) is a tool and the first step.
Blueprints (M12) are one way to write or refine the plan. The graph (M2) and the context compiler
(M11) are what the lead reads and what briefs are made from. The detectors (M6) guard every
agent. The fleet's choice among strategies is the default policy for `prove` children.

### RA9. A model per role

The configuration names a model per role (lead, prover, reader, judge), all the same by default.
The best-supported arm is a stronger model that writes and revises the plan while the cheap model
proves. [reading] The reverse, a cheap lead that consults a stronger model, is reported not to
work well and is not proposed.

### RA10. Replay and a view

Every decision is an event (`plan.revised`, `obstacle.recorded`, `delegation.started`,
`delegation.finished`, `question.asked`). A resume rebuilds the plan from the journal. The report
and the UI show the plan: goals, who worked on each, the cost, what Lean said, the sources read.

### RA11. The measure

An arm `solve-lead` against `solve-v2` and `solve-v2-blueprints`, same cap per problem, on grades
B and C of the graded bench, by the paired protocol; a second arm with a stronger planner (RA9).
Expected and to be checked: no worse per dollar on grade B (the escalation), more solved on grade
C. Twenty paired problems are enough to see a large effect. Removed, or kept as an option only,
if it does not pay.

## 5. Consortium mode: the plan is what the team reads and edits [reading]

Consortium mode (`documentation/human.md`) already ends a turn at a limit or a breakpoint, writes
an account from the journal, and takes the team's answers (`hint`, `sign`, `steer`, `resume`) as
journal events that never change a claim's status. The lead plugs into it without a new
mechanism of trust:

- **Goals are claims**, so `harness hint --claim`, `steer --focus`, `--drop` and `--forbid` apply
  to any goal of the plan as they stand.
- **The account shows the plan**: the goals and their status, the top obstacles, what each child
  did and cost, the sources read with their quotes, and the lead's last choice with its reason.
  Built from the journal with no model call, as today.
- **Co-planning**: an optional breakpoint `plan` ends the turn when the lead has written its first
  plan, and at each revision that changes the target's direct sub-goals, before anything is spent
  on it. The team edits with the existing answers plus `harness plan RUN_DIR --add "goal"` (a goal
  proposed by a person, provenance `human`) and resumes.
- **Questions**: the action `ask the team` writes a `question` node on a goal and ends the turn
  with the breakpoint `question`. `harness answer RUN_DIR QUESTION_ID "text"` is a hint bound to
  it. Without `--human` the action is not offered and the lead goes on alone.
- **A guard on spending**: `steer --delegation-usd X` makes any delegation above X a breakpoint.
- **Stalled goals** (RA6) appear in the account marked as such, with the reason.
- The invariants hold: `question` nodes are the lead's, `hint`, `steer` and `plan --add` nodes
  are accepted from `human:NAME` only, nobody edits them afterwards, and an answer changes what
  the agents are told and the order of work, never a status.
- The ablation still refuses `--human`: the lead is measured fully automatic (RA11), and
  consortium runs are a way of working, not an arm.

## 6. Trust rules, unchanged

Lean is the judge: an agent changes a claim's status only by submitting a Lean proof through
`validate`; only the certifier makes `proved`. The journal is the only truth; the plan and the
obstacle ledger are projections of it. Tools are capabilities behind the registry. Fetched text
is data: a `read` child cannot delegate and writes only `literature` nodes. Models through their
APIs only.

## 7. Risks

- **Cost.** A lead with children uses several times the tokens of the scripted loop. Hence the
  cascade, the escalation, effort by rule, fresh contexts, typed results.
- **A small model may plan badly.** Reported for research-level problems (small models solved
  none in AlphaProof Nexus's sample). RA9's arm tests a stronger planner; RA11 decides.
- **Harder to compare.** More variance from run to run; the paired protocol and equal caps stay.
- **Scope.** The largest change since the first plan, though additive: `scripted` is untouched.

## 8. Order and cost

1. LW1 (literature against the real sites) and RA1 (tools an agent can choose): independent.
2. The minimal lead: RA2, RA3 with `prove` and `explore` only, RA4, RA5 and the guards of RA6.
   Two or three small tasks. Measured at once (RA11) on the pilot's six problems and on grade C.
3. If it pays: the `read` child with LW2 and LW3, RA7, RA9, RA10 and section 5, then LW4.

Tasks 38, 39, 43 and 44, deferred on 2026-11-11, are re-read against this change before any is
built: refinement rounds and the informal proof first become things the lead does; roles are RA9.

## 9. Questions for the owner

1. Recursion by refinement of one plan first, nested leads only if measured useful (RA4):
   agreed? This is the one place where the reading changed what was described to you.
2. Option or default? Proposed: an option until RA11 shows it pays.
3. The planner's model for the second arm: which stronger model, and what cap?
4. Co-planning on by default in consortium mode (a stop at the first plan)? Proposed: yes.

## 10. What is not verified

Nothing here has run. The figures of section 2 come from an automatic extraction of each source
on 2026-11-12 and were not recounted in the papers. The gain of a lead at equal dollars is a
hypothesis.
