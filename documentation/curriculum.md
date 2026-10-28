# Curriculum of variants (line M18)

Line `M18` ([lines.md](lines.md)) is rung 1 of the escalation ladder ([scheduler.md](scheduler.md#the-escalation-ladder-pe4-of-the-memory-evolution-plan-change)),
plan change PE7. It is AlphaProof's test-time curriculum without its training: when a problem has spent
a fraction of its budget without Lean progress, easier variants of the target are solved first, with a
capped share of the budget, and what is learned from them reaches the sessions that follow. It is
`createM18Line` in `@seshat/scheduler` (`packages/scheduler/src/curriculum.ts`); a run enables it with
`harness run --lines M1,M12,M18` (it requires M12, which owns the ladder and the schedule step).

**No published evidence says this pays without updating weights.** The line is an experiment: it is
removed if it does not beat the ladder without it at equal budget (the ablation of Task 14). It is
on rung 1 only so that problems that the cheap stack solves never pay for it.

## What it does

1. **Nothing until the ladder moves the problem up.** With the ladder on (M12's option `ladder`), the
   orchestrator gives M18 no hook for a problem until `ladder.escalated` moves it to rung 1, then calls
   `beforeProvers`. With the ladder off M18 starts at once, like every line, and the curriculum runs before the first attempt (capped as below). `beforeProvers` does nothing for a problem whose claim is already settled.
2. **One request for variants** (site `curriculum.variants`). A model is shown the target and its header
   and asked for at most `maxVariants` statements the target implies, easiest first, of three kinds:
   `small_case` (a specific small value), `prime_case` (a prime, or a special family) and
   `extra_hypothesis` (a weakening: a bound or an inequality added). Each is written in signature form
   (`(n : ℕ) (h : 0 < n) : n + 0 = n`).
3. **Each statement becomes a claim** with `createVariant` (M2's variant generator,
   [graph.md](graph.md#variants-and-edges)), relation `special_case`: the claim's `parentId` is the target
   and a `special_case_of` edge goes from the variant to the target, `proposed`, with its link lemma
   `target → variant`. A statement is dropped, with the reason in the log, when it does not read as a signature, is
   the target's own statement or a repeat, mentions `sorry`, or is over the limit. A statement the memory
   has already is that claim, with its status.
4. **Each open variant gets a `prove` task** in the ledger (proposed by `line:M18`, acceptance "the
   variant's claim is at least `computed`", budget `{sessions: sessionsPerVariant}`). The fleet's
   `assignOwners` sees them like any task. One task per variant: a variant is a stepping stone, it is not retried.
5. **The line works its tasks itself.** M12 is the scheduling line and works only the tasks it proposed;
   M18 gives the hook `runTask` ([lines.md](lines.md#scheduling)), which the orchestrator calls in the
   same schedule step, before M12 chooses, for the first `ready` task M18 proposed. An inner session is one
   model call (site `curriculum.prove`) whose proof goes through `validate` like any prover's. The task ends
   `done` when the claim reaches `computed`, `failed` when `sessionsPerVariant` sessions did not succeed or the
   share is spent. A task cut by an interruption stays `running` and the resumed run makes it `ready` again.
6. **When a variant is accepted**, the line tries to check the `special_case_of` edge with a handful of cheap
   tactics (`exact fun h => h`, `intro h; exact h _`, ...: no model), so that "the target implies the variant"
   is a Lean fact when it can be, and says so in the briefing when it could not be.
7. **Certification.** The variants' proofs are submissions of the line for other claims than the problem's: the
   orchestrator certifies them when the problem ends (`ClaimBenches.certifyPending`), as for any line
   ([lines.md](lines.md)), and a variant becomes `proved` only then.

## What reaches the sessions that follow

The `briefing` hook adds a section **Special cases already proved**: every claim with a `special_case_of` edge to the target
that Lean accepted (`computed` or `proved`), with a note on whether Lean checked that the target implies it, and
`examples` (1 or 2, default 2) of their proofs as `theorem variant_k ... := by ...`. The examples are drawn from the
run's seeded source (`seeded(hash32(seed:m18:problem:prover:session))`, the seed being the option `seed` or the run's seed), so
a resumed run draws the same ones. The section says that Lean accepted a proof of each statement, that only those marked checked are known to follow from the target, and that none proves it. (`computed` is the fast check; the certifier runs when the problem ends, so a variant is rarely `proved` while sessions run.) Claims that
are not accepted never appear in it: what a model proposed and Lean did not accept is not a fact.
Because the section reads the edges of the memory, a proved special case of the target made by another problem or
run that shares the claim ([memory.md](memory.md)) reaches the briefing too.

## What it can never do

- **A variant never changes the target's status.** A claim changes status only through `validate` and the
  certifier (Lean is the judge). The variant is a claim of its own. The propagation rules of the graph
  ([graph.md](graph.md)) carry a proof of the general statement to the special one (`special_case_of/proved`), and a *refutation of
  the special one* to the general one (`special_case_of/refuted`); M18 submits no refutation, and a proof of a
  special case derives nothing for the target. The test runs M2's propagation with every variant proved and
  checks that the target has no status change.
- **The budget cap.** The line spends at most `share` (default 0.2) of the problem's dollar budget: the request
  for variants and the inner sessions count, in the dollars the problem's ledger counts (the calls go through
  `problem.llm`), so they are in the ladder's spend and in the report's dollars per rung. Before each call the line
  reserves the dearest call it has made so far (the request for variants included): a call starts only while the spend is
  under the cap and the spend plus that reserve fits. With a cap of 0.20 and a request that cost 0.19, no session is started.
  The first call has no reserve, and a call can cost more than the dearest before it, so the cap holds as long as calls cost
  about what the dearest earlier one did; it can be passed by at most what the last call cost beyond its reserve. When the
  share is spent, the open variants' tasks fail with that reason. A problem with no dollar budget has no share to count:
  the line is capped at the option `unbudgetedUsd` (default 1) instead, which also holds when the ladder is off and the
  curriculum runs before the first attempt. The cost of a call whose JSON answer failed is not on the error; it is taken from the
  problem's spend over the call, which includes what concurrent provers spent meanwhile, so the count can be too high (the cap then
  trips early, never late).
- **It learns nothing from outcomes.** The line writes what a model proposed and tried as `learned` nodes, which the
  memory stamps with the run's provenance (Global Constraint 16, [memory.md](memory.md#provenance-and-epochs)). None of
  it is read as a fact, and no later decision is made from it except the count of the line's own spend.

## Options

| Option (`--line-option M18.NAME=...`) | Default | Meaning |
|---|---|---|
| `unbudgetedUsd` | 1 | The most the line may spend on a problem with no dollar budget. |
| `share` | 0.2 | The share of the problem's dollar budget the line may spend in all (0 turns it off). |
| `maxVariants` | 4 | The most variants made for a problem (at most 12). |
| `sessionsPerVariant` | 3 | Inner sessions on a variant before its task fails. |
| `examples` | 2 | Proofs of variants shown in a briefing (1 or 2). |
| `seed` | null | Seeds the choice of examples. Null: the run's seed. |

## What it records

Nodes of the problem's claim, all `learned` (stamped): `m18_generation` (the request for variants: dollars, how many were proposed and
kept, why nothing came), `m18_variant` (the variant's claim, its edge, its kind and statement) and `m18_session` (an inner
session: task, number, whether Lean accepted it, dollars, reasons). A session is recorded when the model has answered, before Lean
is asked, so that the share's count survives a cut. The claims, edges, tasks and validations are the memory's and the ledger's
as for any line.

## Resuming

M18 declares `resume: "rebuild"` ([lines.md](lines.md#resuming-a-run-with-lines)) and keeps nothing in the process: `resumeProblem`
and `beforeProvers` are the same function, which reads the nodes, the claims and the ledger and does what a cut left
undone. It is safe to call twice:

- the request for variants is made once (an `m18_generation` node says it was), and a cut between the call and
  the node finds the answer again, at no new charge, because the call is `reuse: true`;
- `createVariant` returns the claim and the edge that exist; a variant is recorded once; a variant with a task gets no second one;
- a session cut between the model's answer and Lean's verdict is a `pending` record: the resumed session asks the same
  question, gets the recorded answer at no new charge (its recorded cost still counts in the share), and ends that record;
- a variant already accepted when its task starts again has its edge checked, if the cut came before that.

A cut between the move up the ladder and the next session resumes with the variants' tasks worked before that session
and not after it (the resumed process runs the schedule step first): the same work in another order.
`packages/orchestrator/test/resume-m18.test.ts` cuts a whole run after every event of its journal and resumes each;
outside that window the resumed run has the claims, edges, tasks, records, outcome and cost of the run that was not cut.
An interruption (`isInterrupted`) passes through every step of the line and writes nothing as an end.

## Tests, and what has not run

`packages/scheduler/test/curriculum.test.ts` covers the reading of the model's variants, the share's arithmetic and the
interruption; `packages/orchestrator/test/m18.test.ts` runs the line in whole runs (variant claims, edges and tasks on
escalation, the proofs certified, the target untouched, the cap, the briefing with its examples and the seeded choice, a
problem that never moves up, the ladder off); `run-task.test.ts` covers `runTask`.

Everything runs with a simulated Lean, a faux model and a faux certifier. **Not run** against a real model or Lean: the
prompt for the variants and the inner sessions' prompt, whether a model proposes statements that read under the problem's
header and are special cases, the cheap closers of the link lemma, and above all **whether the curriculum pays at all**,
which only the ablation against the ladder without it can say.
