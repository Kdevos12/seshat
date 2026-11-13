# The informal proof first (plan changes PA13, NL2, AL1, AL2, AL3)

Off unless `RunConfig.informalFirst` is set (`{ passes?, rounds? }`, defaults 3 and 4). `solve`'s sets `v1` and `v2` do not set it; the arm `solve-v2-informal` of the experiment `solve-defaults` is `solve-v2` plus it, and `solve-v2-blueprints-refine` has it too ([ablate.md](ablate.md)).

## The trust rule

An informal proof, however many verifier passes it has, is a **hint journaled as such** (Rulings 36 and 38). It never changes a claim's status, which stays `open`, and the word "proved" is never used for it. Only Lean judges.

## The loop

Once per problem, after the intake and before the first outer prover session and before M12's first blueprint (`informal.ts`, `runInformalLoop`):

1. **Generate** (role `planner`, the run's model when the role is absent): one call in a fresh context with the statement, its docstring or the person's prose, the first-cases table when `firstCases` computed one, and a person's `--sketch` as quoted data. It asks for a complete proof in natural language and, at its end, at most five Mathlib facts the proof relies on.
2. **Verify** (role `verifier`; the generator's model in a fresh context when the host names none, AL2): the input is the statement and **the final proof text only**: no reasoning content, no earlier round, no finding of an earlier pass, not the list of facts, and the first-cases table when the run computed one (the verifier is told to check the proof's claims against it). The answer is JSON `{ verdict: "correct" | "fixable" | "wrong", findings: string[] }`. **The verifier is strict (task 51, prompt version `v2`, journaled as `verifierPrompt` in the node):** it is told to look for the first gap or error, to treat any unjustified step, any appeal to "it is well known" or "clearly" without a reference, and any case left out as `fixable` at least, and to answer `correct` only if it can name, in `findings`, each key step and why it holds. A `correct` with no findings is read as `fixable` with the finding "the verifier gave no reasons". The same model as verifier is weak: in the replay (Task 50) the generator's own model, in a fresh context, answered `correct` 18 times out of 18, including on two problems out of reach, so this prompt is a patch; a verifier role on another model (AL2, `--role verifier=PROVIDER/ID`) is the real fix.
3. **Route** (AL1): `correct` counts one pass, and a proof is accepted after `passes` verdicts `correct` in a row, each a fresh call. `fixable` sends the proof and the findings to a **revision** call (role `planner`), whose answer is verified again from zero. `wrong` starts a fresh generation that sees not the rejected proof but one line: "An earlier approach failed: FIRST FINDING".
4. **Caps.** At most `rounds` generate-or-revise calls. Every call is asked of the budget gate first (`problem.budget.ask`, as the planner's round is), and a skip ends the loop with the last proof, not accepted. A call that fails, or a verifier answer that is not a verdict, ends it the same way.

## The sites and the journal

Calls are `model_call.finished` of the line `informal`, charged to the problem, at the sites `informal.generate`, `informal.verify` and `informal.revise`, with the role recorded (`planner`, `verifier`) like the other roles'.

The result is a node of kind `informal_proof` on the problem's claim (`@seshat/memory`, `informal.ts`): `accepted`, `passes`, `required`, `rounds`, the `verdicts`, the `models` by role, `stop` (`accepted`, `rounds`, `gate` or `failed`), the facts, the names `lean.search` found for them, and the proof text as a blob (`proofHash`): the accepted proof, or the last one when none was accepted. A problem whose node exists does not run the loop again on resume. A loop cut mid-way has no node: it is **run again from its start** (the calls of the first run stay in the journal and are paid; the log says so).

## Use

An **accepted** proof goes, under the title "An informal proof, checked by N verifier passes and not by Lean", quoted as data, with its facts, into the outer prover's first briefing and into the planner's prompt of [the refinement rounds](scheduler.md#refinement-rounds-plan-change-ca12-pa11). When the host offers `lean.search`, its facts are looked up first (at most five queries, no model call, tool runs in the journal) and the names found go with it. A proof that was not accepted is shown to no one; `solve`'s RESULT and the report show an accepted one with no certified Lean proof under "Not checked by Lean" ([quickstart.md](quickstart.md)).

## What the result shows (AL3)

No model call, from the journal and its blobs (`informal-view.ts`). In `RESULT.md` and in `report.md` (and so in what `harness solve` prints at the end): an accepted proof with **no certified Lean proof** of the problem is shown under "Not checked by Lean": the text cut at 4000 characters (a line says so), the verifier passes, the models by role and the line "This argument has not been checked by Lean; it may be wrong." When nothing was accepted and no Lean proof was certified, the headline is "No solution found." and no attempt is shown, the rejected ones included. With a certified Lean proof the informal one is not shown; one line says it exists. The claim's status is never changed. The partial Lean sketches of the RESULT, which are Lean's own files, stay where they were.

## Not run

Everything is tested with the faux provider and a simulated Lean. No real model has written or read a proof here: whether a verifier of another family catches what the generator's own would miss, and whether an accepted proof helps the prover, are what the arms measure. Putnam solutions are in the models' training data, so a gain measured there overstates the gain on open problems.
