# Literature intake

Task 36 (plan change CA16, CA17, CA21): a statement is tested before any paid proving starts. This page describes the capability
`lit.search` and, as the intake step is built, the step itself.

## `lit.search`

The capability ([capabilities.md](capabilities.md#litsearch)) is in `@seshat/lit`. Its backends are OpenAlex, arXiv, Semantic Scholar,
zbMATH and `bench-metadata` (the docstrings and the `formal_proof using KIND at "URL"` attributes in a local bench checkout, found by the
words of the query). Each is optional and has its own settings in the host profile; `config/hosts/local.json` and `server.json` enable
the four remote ones at their public addresses (`OPENALEX_URL`, `ARXIV_URL`, `SEMANTIC_SCHOLAR_URL`, `ZBMATH_URL` replace them, and the
`allowedHosts` of the profile then has to name the new host) and `bench-metadata` when `BENCH_CHECKOUT` is set.

### Fetched text is hostile

- Only the hosts of a backend's `allowedHosts` are reached, over https (a loopback address only for a test); an address with
  credentials, a redirect, an answer over the size limit and an answer of a type that is not text are refused.
- A hit's title and text are cleaned when read: control, bidirectional and zero-width characters are removed, white space is one space,
  the length is bounded. A link a site gives is kept only when it is https; otherwise the backend's own address stands in its place.
- Where a person reads a hit (briefing, report, RESULT.md) it goes through `shown`, which also escapes `&`, `<`, `>`, `|`, brackets and
  backticks.
- A hit's text is data. It never enters a system prompt or a lesson, and no hit changes a claim's status.

### Not run

No backend has run against its site: this environment reaches none. The requests and the answers are written from each site's
documentation as remembered (zbMATH's the least sure) and are tested against a fake server (`packages/lit/test/fake-lit.ts`).

## The intake step

`runIntake` (`packages/lit/src/intake.ts`) is the step; the orchestrator calls it for a problem before any paid session
(below, "In a run"). It never throws except for an interruption: any other failure is a skipped step with its reason.

1. **Three query forms**, made without a model (`queryForms`): the words of the statement, the statement itself (the person's prose when
   there is some, otherwise the Lean statement with its symbols read as words), and the words with `conjecture counterexample
   disproof`. Nothing of the Lean syntax is sent. Each form is one `lit.search` call, so each query and its answer is a tool run of the
   journal, as every other tool's.
2. **One judge call**: "does a hit prove, refute or restrict this exact statement?", for at most 12 hits (duplicates by link removed),
   with JSON of `{index, verdict, quote}` for each. The system prompt (`JUDGE_SYSTEM`) is fixed and holds nothing fetched; the hits are in the
   user turn, each between markers, as data, and the system prompt says they may contain instructions that are never followed.
3. **The screen**: a quote counts only when it is a verbatim part of the hit's title or text after the normalization the citation guard
   applies to references (`normalizeQuote`: white space collapsed, case folded, plus the plain form of typographic quotes and dashes, and at
   least 25 characters). A hit with a verdict other than `unrelated` whose quote is not found is **dropped** and listed as dropped, with
   why, in `intake.finished`. A hit the judge gave no verdict for is dropped too.
4. **The node**: each kept hit is a memory node of kind `literature`, data exactly `{backend, url, title, quote, verdict, settled}`, with
   `verdict` one of `proves`, `refutes`, `restricts`, `unrelated`, and `settled` true only when the verdict is `proves` or `refutes` and the
   quote passed the screen. The node is about the problem's claim and changes no status (Ruling 13); no node and no text of a hit is in a system
   prompt or a lesson. The briefing shows the title, the link, the verdict and the screened quote, as data in a user-role section.
5. **The cap**: the step may spend `capUsd` (default $0.05, an option) on its judge call. With the model's price the call is sized to fit:
   hits are left out until the input fits, and the answer's tokens are what the rest of the cap pays for; when nothing fits the step is
   skipped with `cap: ...`. The budget gate is asked first (`problem.budget.ask`, site `judge`); its `skip` is a skipped step with
   `budget: ...`. A skipped step is journaled, with its reason, in `intake.finished`.

A judge's verdict is an opinion of a model about text from a third party, and `settled` means "the literature says so, with a quote that is
really there": it is not a proof, and nothing in the harness treats it as one.

## Statement hygiene (CA21)

Tests of the statement itself, at intake and before any paid proving (`packages/lit/src/hygiene.ts`). Each result is an evidence node of kind
`hygiene` about the claim, data `{check, result, detail?, witness?}`, and none is a status.

| Check | Results | What it does |
|---|---|---|
| `vacuity` | `satisfiable` (with the witness), `vacuous`, `unknown`, `skipped` | Lean is asked for one object that satisfies the hypotheses: the statement's number variables (`ℕ ℤ ℚ ℝ`) get small values, its hypothesis binders are discharged by `decide`, `norm_num`, `simp`, `omega`. When none does, Lean is asked for a proof that none exists; only that proof makes the statement `vacuous`. A statement the test cannot read (an instance binder, a binder that is not a number or a hypothesis about numbers, not in signature form) is `skipped` with the reason. |
| `plausible` | `counterexample`, `no_counterexample`, `unavailable`, `skipped` | `example STATEMENT := by plausible`, read from Lean's answer; `unavailable` where the project has no such tactic. A counterexample is evidence to look at, not a refutation. |
| `test_lemmas` | `passed`, `failed`, `skipped`, `inconclusive` | The first cases of the statement by `decide` (the induction package's `testLemmas`), which `solve` made only for a statement in prose; at intake, for every statement. |

The statement text a check reads is the problem's (binders and type). All three run on a simulated Lean in the tests.
