# Status: beta v1

Seshat is released as beta v1 (version 1.0.0-beta.1). This page says what has run for real, what has only
run against a simulated model and Lean, and keeps the longer status text that the README used to carry.
The measured runs are below, with their dates; the task ledger
([plans/seshat-plan-ledger.md](../plans/seshat-plan-ledger.md)) has every detail.

## What has run for real

On the owner's machine, with Lean 4.27.0, a real model through its API and the host profile `sandboxed`,
between 2026-11-11 and 2026-11-13:

- the graded bench was built with admission by the real Lean (grade A 111 of 111 statements, B 20 of 326
  candidates, C 10 of 70);
- `harness solve` and `harness ablate` ran on grade B (Putnam) problems: a pilot of six problems, a second run
  of six, a third run of 20 problems in three arms, a replay of the six that were not solved, and a smoke run of
  the graph and the context compiler (lines M2 and M4);
- the fast check, the certifier's kernel replay (`proved` only through it), `lean.lsp` and `lean.search`, the budget
  gate and the probe, the intake's literature sites (probed once on 2026-11-12), lines M1, M6 and M10, and line M12
  with blueprints, refinement rounds, the repair pass and the informal proof first (in the replay);
- the certifier was checked on a real Lean on 2026-11-13: six candidates that it had wrongly refused for
  `X._unsafe_rec` certified after the fix, and a `partial def` is still refused.

## Measured runs

All numbers are from the task ledger ([plans/seshat-plan-ledger.md](../plans/seshat-plan-ledger.md)), on grade B problems (Putnam competition problems) of the graded bench, on the owner's machine, with a real Lean and a real model.

| Run | Date | What it measured | Result |
|---|---|---|---|
| Pilot | 2026-11-11 | 6 problems, cap $0.50 each, `solve` with the baseline defaults `v1` | 6 of 6 certified by kernel replay for $0.126 in all; the other two arms were not valid (the provider's balance ran out) |
| Second run | 2026-11-12 | the same 6 problems | `v1` 4 of 6 for $0.205: the baseline varies from run to run; two defects found and fixed |
| Third run | 2026-11-12 to 13 | 20 problems, cap $0.50 each, three arms: `v1`, `v2` and `v2` with blueprints | after the certifier fix: `v1` 16 of 20, `v2` 14, blueprints 15; $4.02 in all with a one-problem trial; no arm beats another |
| Replay | 2026-11-13 | the 6 problems left unsolved, the arm with blueprints, refinement rounds, repair and the informal proof first | 0 of 6 certified for $1.41 |
| Graph smoke run | 2026-11-13 | lines M2 and M4 on 4 of those problems | 0 of 4 for $0.67; they ran without error and added nothing in a single fresh run |

What the runs taught, and what was fixed because of them:

- The third run's first scores (13, 13, 13) were wrong: the certifier refused `X._unsafe_rec`, a constant that Lean 4.27.0 adds for every recursive definition, and rejected six good proofs. After the fix, checked on a real Lean on 2026-11-13, the same candidates certify (`v1` 16, `v2` 14, blueprints 15 of 20). A `partial def` is still refused.
- The blueprints of the third run were all judged unhealthy because the blueprint format was in no prompt; it is now in the briefing, and the check answer says how a blueprint is read.
- The replay (0 of 6) showed that four of the six problems were stopped by the budget gate after the probe, that the verifier of the informal proof (the same model) was too lenient, and that a hole's file did not carry its context; the fixes are in the ledger. These six are the hard end of the set: no claim is made that blueprints help.
- A yardstick caveat: every PutnamBench problem has a public Lean proof, which a model may have seen.

## What has not run for real

Everything else was written against its interface and tested with a simulated model, a simulated Lean, fake
servers and pi-ai's faux provider: lines M3, M5, M8, M11, M13 to M18, the consortium turns and the consolidation
pass, the heuristic card bank and its measurement, `consult` (a dry run only), ATP and SMT with reconstruction,
the LibraryBuilder, and the first real ablation of the cumulative configurations. The README's diagram marks
each node built, waiting for something real (orange), or planned. A model that solves a problem is one
measurement; the limits of the yardstick (every PutnamBench problem has a public Lean proof, and the baseline
varies from run to run) are in the ledger.

## The record before the first real run

The text below is the README's status paragraph as it stood before 2026-11-11. Where it says that nothing has run
against a real Lean or a real model, read the section above instead.


Status: early development (phase P0a). The event journal, the memory store, the line API, the proof
validator, the certifier (a kernel replay in a fresh Lean process), a client for Kimina Lean Server,
the capability registry (manifests, host profiles, MCP boundary, contract tests), a first bench of
575 problems from
[formal-conjectures](https://github.com/google-deepmind/formal-conjectures), the M0 loop
(independent provers on pi, in sessions that pass on their notes) and seventeen lines (M1: shared claims
and negative memory; M2: the variant graph and its logical propagation; M11: small models and
counter-models; M6: guards and drift detectors; M12: the scheduler and its ladder; M18: a curriculum of variants on its first rung; M15: an archive of alternative decompositions and the schemas of the closed ones, on its second rung, documented in [documentation/archive.md](archive.md); M17: a run in an extended Lean environment; the fleet policy, with sampled session settings, informal-first sessions and a soft failure memory; M8: data tables, hypotheses as programs run in a sandbox and a pool of conjectures; M13: theory exploration; M3: the lemma library, promoted auxiliary lemmas with BM25 and hybrid search, documented in [documentation/library.md](library.md); M4: the context compiler, a packet in place of the history, documented in [documentation/context.md](context.md); M5: lessons from accepted proofs and from failures that recur, judged by their effect, documented in [documentation/lessons.md](lessons.md); M14: typed repairs and Lakatos-style repair; M16: program search for scored subgoals; M10: a classical battery, a domain router, z3 and Vampire with reconstruction in Lean, before any model; documented in [documentation/induction.md](induction.md), [documentation/repair.md](repair.md) and [documentation/classical.md](classical.md)) are written and tested with a
simulated model and a simulated Lean, and all of them work in one run (M7 and M9 are suspended). `harness ablate` runs the cumulative configurations, M0 and then each line in turn, or one experiment, on the same problems at the same budget and writes the comparison table; it reads everything from the journals, together with the reliability of the typed decisions, the cost-to-first-success curves and an entrenchment probe of the memory ([documentation/ablate.md](ablate.md)). `harness optimize-prompts` rewrites the prover's prompt (a file) GEPA-style on a dev split and proposes patches that beat the merged prompt on a held-out split and a temporal holdout; a person merges them ([documentation/prompts.md](prompts.md)). The graded bench (`bench/graded-v1.json`, built by `harness-bench graded` from local checkouts of formal-conjectures and PutnamBench, never vendored: grade A exercises, B competition problems, C research problems with a formal proof elsewhere, each admitted only if its statement compiles under the base Lean environment) is the yardstick of the capability work; `harness ablate` reads it through `--bench` and `--grade`, prints the paired protocol (Wilson intervals, an exact McNemar test, dollars per solved problem, problems solved per dollar against a baseline arm and the target line), and every run report gains a Loop section (checks and their seconds, output tokens per check, dollars by cache hit, miss and output, end context, repeated failures, open holes over time) ([documentation/bench.md](bench.md), [documentation/ablate.md](ablate.md)); the builder is tested on fixture checkouts and no index is committed, and no real Lean admission or paired run has been made. The bench also holds sequences of related problems and analogy and induction tags, and `bench-ext` converts the equational-theories data from a local cache ([documentation/bench.md](bench.md)). The work of a run is recorded as tasks in a ledger, and a run
whose process ended is continued from its journal ([documentation/ledger.md](ledger.md)). A run can also stop by itself at a
token, dollar or time limit or at a breakpoint, write an account of where it stands and wait for the research team, whose hints, signatures and
steers go into the journal and change no claim's status ([documentation/human.md](human.md)). The Lean the harness runs against is written
as data, an environment (`lean/env/NAME.toml`), which `harness lean-env resolve` checks for
consistency before anything is built ([documentation/lean-env.md](lean-env.md)); line M17 puts a run in
one with more packages than the bench's. An optional library builder (off by default) can ask a coding agent for new Lean under `lean/SeshatLib`, behind a gate of Seshat's own; what it writes is `unreviewed` and cannot appear in a claim statement until a person or two checkers review it ([documentation/library-builder.md](library-builder.md)).
The provers can also be given SageMath, an external program installed with Docker or pip
([documentation/compute.md](compute.md)). Tools and skills can also be installed as packs (`harness add`), which add tools at level 2, human-written skills and heuristic cards and can never write a claim's status ([documentation/packs.md](packs.md)). With the fleet's option `heuristics`, each session can be given one heuristic card, a method of reasoning written by a person ("vary one parameter at a time"), drawn by family and card against a control share of sessions that get none, and `harness heuristics stats` counts what each family did against that control ([documentation/heuristics.md](heuristics.md)). A run can start on the memory of an earlier
one (`--memory-from`), its learned records are stamped with where they come from, and the memory store can
draw the unverified items a briefing shows at random and measure their effect, which lines M3 and M5 use
([documentation/memory.md](memory.md)). `harness solve` takes a problem of one's own, in Lean or in prose, with the defaults of a student: a mandatory small dollar allowance, the budget gate and probe first, the classical lines M1 and M10, the cheapest model that has a price, and a stop with an account at half the allowance; its defaults set `v2` (`--defaults v1` keeps the older one) also gives the provers an edit tool in place of a rewritten file, masks old check results, bounds the Lean checks, opens each session with a state card built from the journal in place of long notes and shares the run budget among its problems in rounds with a doubling cap (not yet run against a real Kimina or model). An option, `--lean-search`, makes the harness search Lean declarations after a check that did not accept the file (an unknown identifier, a hole's goal; a remote service, a local index or a pattern search, as the host sets them up), check every hit with Lean in the run's environment and append the names and signatures Lean printed to the check's answer; it is off in `harness run` and on in the defaults set `v2` of `harness solve` when the host offers it (`--no-lean-search` turns it off), asks the person's agreement in `harness solve` before it may use a remote service, is local with a private run, and is not run against a real Lean or search service ([documentation/lean.md](lean.md#search-pushed-by-the-harness)). A prose statement is formalized, shown with test lemmas on its first cases and signed by the person before any spend (a `statement.signed` event); `harness doctor` says what the machine lacks (Lean, the Kimina server, credentials, prices, network) and the Kimina settings that fit its memory and writes the host profile that isolates the certifier when bubblewrap or Docker works, and without isolation a run says plainly that its results stay `computed`. Before any paid session a run can take an intake step (on in `harness solve`'s set `v2`, with the compute tool for finite, graph and number statements when the host offers it; `--no-intake`, `--no-auto-tool` and `--no-lean-search` turn one off, `--defaults v1` none; the literature still needs the person's yes, and the intake's judge call is capped at 5% of a solve's allowance) ([documentation/literature.md](literature.md)): the literature is searched (`lit.search`: OpenAlex, arXiv, Semantic Scholar, zbMATH, a bench checkout's metadata), one judge call under a cap of $0.05 says whether a hit proves, refutes or restricts the exact statement, a quote counts only when it is in the fetched text, and the statement itself is tested (vacuity, `plausible`, the first cases); a settled hit or a vacuous statement is a breakpoint in a run with a person, and `--private` is one rule, enforced by the registry, for every capability that sends content of the problem to a third party (the literature, `lean.search`, the OEIS, LMFDB, FindStat and a hosted decision model: [documentation/trust.md](trust.md#third-parties)); none of it has run against a real site, model or Lean. Every run leaves `RESULT.md` beside its journal (built from the journal by code, rewritten after every certified result and every stop, rebuilt by `harness report`), and `harness view` writes one static HTML page of it ([documentation/quickstart.md](quickstart.md)); `harness ui` is a local web page (a loopback server with a per-session token, Host and Origin checks and a content security policy, a journal reader, provider settings with each key in a 0600 file outside the repository, and screens to start a problem, sign its statement, watch the spend and stop, read the result, continue, hint or steer, and see the read-only graph) that starts the same commands as subprocesses and cannot change a claim's status ([documentation/ui.md](ui.md); tested with a fake subprocess, the faux provider and one headless-browser smoke test, never with a real browser session by a person); none of it has run against a real model, Lean, bubblewrap or Docker. Nothing has run against a real
Lean or a real model yet.

## Notes that went with the diagram

Today one loop runs, tested with a simulated model and a simulated Lean: each prover edits a Lean
sketch and checks it with `lean_check`, and the first file that passes the fast check makes the
statement `computed`, a candidate. SageMath is the only classical tool for computing that is plugged
in; the OEIS, the LMFDB and FindStat can be asked too ([documentation/models.md](models.md#the-services-as-capabilities)).
The provers can also be given Lean's language server, `lean_lsp` (the goals at a line, several
tactics tried at one line, Mathlib search): information that never changes a status, written and
waiting for a Lean like the fast check ([documentation/lean-lsp.md](lean-lsp.md)).
Every tool call goes through the capability registry, which writes it to the journal, with its inputs
and outputs as blobs. The orchestrator records the work as tasks in a ledger (one `prove` task per
prover, and a routing decision for each failed check), never copying a claim's status, and a run
whose process ended is continued from the journal alone: `harness run --resume` takes up each
problem where the journal left it, with the budgets that were left, and records one certification
per candidate ([documentation/ledger.md](ledger.md#resume)).
With `--human` or a turn limit (`--turn-tokens`, `--turn-usd`, `--turn-minutes`) the run ends a turn by itself, at the limit or at a breakpoint
(an impasse, a problem settled, two informal validators in disagreement): no session or model call starts after it, the account
`turns/N/report.md` is built from the journal alone, and the run waits until the team has answered with `harness hint`, `sign` and `steer`
and resumed it. Those answers are recorded under each person's name and change no claim's status
([documentation/human.md](human.md)).
Lean is the judge: no statement becomes `proved` without the certifier's kernel replay
([documentation/certifier.md](certifier.md)). A run certifies each candidate when the
host has a certifier, and the lines' proofs of other claims and of negations too: a certified proof
makes a claim `proved`, a certified proof of its negation `refuted`. The certifier is unavailable
until the host profile gives it a sandbox command or opts in to running candidates' code unsandboxed
(neither shipped profile does). It is tested with a fake `lake`, and has certified a one-line
Mathlib theorem against a real Lean v4.27.0, without a sandbox and through bubblewrap; no bench
problem has been certified yet.
The memory is what the plan counts on to beat existing systems: its store is
written (claims, the edges between them and records of every kind, all in the journal), and so are
the first lines that use it. M1: one claim per statement, each attempt labeled with its strategy
and how it failed, and an "already tried" section in every session
([documentation/memory.md](memory.md),
[documentation/m1-identity-memory.md](m1-identity-memory.md)). M2: a graph of variants
of a claim, joined by edges that become `lean_checked` only when Lean accepts their link lemma; logic
rules follow those edges and turn what they derive into composed proofs that go through the same
fast check; and a proof of the negation of a claim is tried alongside the provers, whichever side
loses being stopped ([documentation/graph.md](graph.md)). M2 waits for a Lean server
like the fast check. M11: a statement of magmas or of a number is tried on batteries of small
objects, a counter-model becomes a proof of the negation that Lean must check, and the verdicts
give candidate edges between claims and a lookup of the numbers where it holds as a sequence
([documentation/models.md](models.md)); it waits for a Lean server too. With its option `graphs` (off by default) M11 also reads statements about simple graphs: a program the model writes (run in the sandbox) is tried on every graph up to isomorphism to 8 vertices, and to 10 through SageMath's nauty when the host has it; a hit becomes a Lean refutation from the templates of `lean/SeshatLib/Finite`, through `validate`, and stays evidence until Lean accepts it; "none found up to N vertices" is evidence with its filters, never a status; a local search on a model-written score and M16's program search for families go beyond the lists ([documentation/models.md](models.md#statements-about-graphs), [documentation/finite-lean.md](finite-lean.md)); the Lean templates have never been compiled, and SageMath's generator and a real model have not run. M6 adds the
guards against hallucination and the drift detectors: neutral framing, citations that must
resolve, no raw error text, anchored revisions, and sessions stopped when they loop
([documentation/guards.md](guards.md)). The fleet policy chooses what each session
works on by Thompson sampling on the verdicts the memory holds, puts more provers on a subgoal only
where one does badly, and sends hard decisions to a stronger model. It samples each session's settings
(temperature, thinking level, a diversity directive, standard or informal-first mode), discounts old failures per run and keeps
a floor of exploration, so that a failure of a weaker configuration does not close a door for good
([documentation/fleet.md](fleet.md)). Informal-first sessions and the multi-call `judge` helper
have only run against a simulated model. M12 schedules the work between sessions: a prover's sketch with named `sorry` holes becomes claims joined by a decomposition that Lean checks, each hole is a task for a short inner prover (with the option `blueprints`, the holes may declare that they use each other, `-- uses: aux_a`, and a blueprint with a cycle, a hole that reaches no target or one that restates the target is refused; each hole is then worked in a short session with tools on a small file of stubs, after a pre-flight with no model, and ends `proved`, `statement_wrong` or `too_hard`, a negation becoming `computed` only through a Lean-checked proof; none of it has run against a real Lean or model), chosen by a given-clause loop with weighted proof numbers, and a problem that spends its budget without Lean progress moves up a ladder of lines ([documentation/scheduler.md](scheduler.md)); M18, the first rung, solves easier variants of a hard problem with a capped share of its budget and feeds their proofs to later sessions ([documentation/curriculum.md](curriculum.md)); M15, the second rung, keeps several decompositions of a problem alive in cells, chooses by Thompson sampling the one a session extends, and shows the schemas of closed decompositions to the sessions of other problems through the randomized inclusion ([documentation/archive.md](archive.md)); all three have only run against a simulated model and Lean, and nothing says M18 or M15 pays.  `decide` puts a typed choice, score or yes/no to a decision-only model (Jev, optional, off by default,
with the run's own model as the default and the fallback) to order work, never to change a claim's status; with Jev on, short proof states go to a third party, and it has never run against the real service
([documentation/decide.md](decide.md)). The mechanisms are lines that a
run switches on (`harness run --lines M1,M10` or `--ablation M10`), so that each is measured against
the run without it ([documentation/lines.md](lines.md)); `harness ablate` does that comparison for all of them and the
table it writes is the plan's measure of what each line is worth. The tables have only been made with a simulated model and Lean: the first
real ablation waits for a model, a Lean server and, for the decisions and the equational-theories problems, Jev and the dataset.


The consolidation pass (`harness consolidate RUN_DIR`) looks backward over a finished or paused run and writes, in a new run started on it, the state card of each open problem, merged duplicate lessons, flagged unsupported ones and, with a model and a dollar cap, one page per problem of which every sentence cites journal events; `harness run --consolidation` shows the page to a later run, drawn and judged by effect ([documentation/consolidation.md](consolidation.md)); a real model has not run it.
