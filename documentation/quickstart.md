# Quickstart: a problem of your own

This page is for someone who has a problem and wants Seshat to work on it at the lowest cost, without
learning the flag list: a student, a researcher with an afternoon. It covers `harness solve` (a problem of
your own), `harness doctor` (what is missing on this machine), `RESULT.md` (what a run leaves, whatever
stopped it) and `harness view` (one HTML page of a run). The harness itself is described in
[m0-loop.md](m0-loop.md); this page is the shortest road through it.

Nothing here changes what counts as a result. Lean is the judge: a claim is `proved` or `refuted` only when
the certifier's kernel replay says so ([trust.md](trust.md)), and a run without a certifier says plainly
that its results stay `computed`.

## RESULT.md

Every run leaves `RUN_DIR/RESULT.md` next to its journal. It is built from the journal alone, by code: no
model writes it, it costs no token, and the same journal always gives the same text (`buildResult` and
`renderResult` in `packages/orchestrator/src/result.ts`).

**When it is written.** After every certified result (a claim that becomes `proved` or `refuted`) while the
run goes on; at every stop (a turn that ends at its token, dollar or time limit or at a breakpoint, the end
of the run, a budget that runs out, Ctrl-C); and once more when the process ends, which covers a crash
that the run itself survives to report. A process killed outright (`kill -9`, a power cut) writes
nothing, and `harness report RUN_DIR` rebuilds the file from whatever the journal holds. The file is
written whole or not at all (a rename), so a reader never sees half of one.

**What it holds**, in this order:

1. The headline, one line for each problem: proved or refuted (certified), a candidate (fast check only),
   or not solved yet, with the journal's reason.
2. Where the run stands: how it ended, or that the journal has no end; dollars, tokens and time; the
   journal's length, last hash and whether its hash chain verifies (a chain that does not verify is
   said first, above the headline). When you signed a statement, the statement, your words and the
   test lemmas.
3. A note when no certifier ran, with the reason the run recorded.
4. The claims by status.
5. **Lean proofs certified so far**: each with the validation behind it and the whole Lean file as it was
   checked. A proof is listed here only when a valid `kernel_replay` validation of that claim is in the
   journal.
6. **Passed the fast check, not certified**: candidates. They are `computed`, not results.
7. **Partial sketches with open holes**: the provers' last files that still have `sorry`, and what Lean
   said of them. Not proofs.
8. **Counter-examples** and **indicative evidence**: what programs, small models, fingerprints and
   conjectures found, each line marked as a lead or as evidence. None of it changes a claim's status.
9. What was tried and failed, by strategy, and the model calls and tools that failed.
10. Spend per site, and per rung of the ladder when the run has one.
11. The exact command that resumes the run (`pnpm harness resume RUN_DIR --checkout ...`), or the
    sentence that there is nothing to resume. The command comes from `resume.json`, which the run
    writes beside its journal with the checkout, the bench file and the host it began with; without it
    the command has placeholders.

**What it never does.** It never states a status the journal does not hold: the headline reads the
claim's status from the projection, "certified" means a valid kernel replay of that claim, and a claim
`proved` in the memory a run started on (`--memory-from`) is listed apart as carried, not as this run's
result. It reads a prefix of a journal as well as a whole one, which is what makes a cut run readable:
a test cuts a run at every event and checks that the file built from the prefix holds every certified
result up to the cut.

`harness report RUN_DIR` writes `report.md` and `report.json` as before and rewrites `RESULT.md`, for a run
whose process died.

## The view

`harness view RUN_DIR [--out FILE]` writes `RUN_DIR/view.html`: one static page built from the journal and
its blobs. It has no script, no link, no address and no form, and a content security policy
(`default-src 'none'`) forbids the browser to fetch anything; open it from the disk. It changes nothing in
the run: hints, signatures and steers stay commands ([human.md](human.md)). Every text that came from the
journal, a model or a person is escaped, so a statement that is HTML is shown as text.

The page has: the headline and, when the run signed a statement, the statement; **the proof** (the certified
Lean files, then the candidates and partial sketches under a warning that they are not results); **the
research graph**, one box per claim coloured by the status the journal holds, with its edges (a Lean-checked
edge solid green, a person's signature blue, a proposed edge dashed), and the same facts as tables; **the
account of each turn** of a consortium run (why it ended, what it spent, each problem's state, what the team is
asked, the answers since); **spend per site and rung**; the leads and the evidence, marked; what failed; and
the command that resumes the run. A journal whose hash chain does not verify gets a banner at the top.

A live interface that watches a run as it goes waits for the first real runs.
