# Plan change: literature (search during the research, full text, a recurring watch)

Status: **direction approved by the owner on 2026-11-12 at 01:12 UTC**, together with
`plans/plan-change-research-agent.md` ("Ça me va parfaitement ..."), a minimal slice first: LW1 is
in that slice; LW2 to LW6 follow in the order of that change's section 8. Written 2026-11-12 by the thread "Augmenter les capacités de Seshat
de 50 %", after the owner asked whether Seshat can read the scientific literature and keep a watch
("crucial in a researcher's work to do it iteratively and regularly") and judged the present limits
"absolutely catastrophic". Nothing here is built. Items are named LW1 to LW6. If approved they become
Tasks 45 to 49 of `plans/seshat-plan.md`.

It goes with `plans/plan-change-research-agent.md` (RA1 to RA9), written the same night: if that
change is approved, searching and reading during the research (LW2, LW3) are tools and `read`
children of the lead agent, and LW2's searches by rule remain for the scripted mode. LW1 and LW4
do not depend on it.

Each item is an option, off unless the person agreed to send the statement outside, and each is
measured (LW6) and removed if it does not pay: the plan's standing rule.

## 1. Why

- Graffiti WOWII conjecture 194 cost $0.72 and 90 minutes on 2026-11-10 and ended in an impasse. It
  had been refuted, with a Lean proof, in arXiv 2609.19195 on 2026-09-15. A search would have cost
  cents.
- A researcher reads before, during and after: before, to learn whether the question is settled;
  during, when a sub-lemma appears ("is this known, under what name?"); after, because the field
  moves while the problem stays open. Seshat does the first only, and on abstracts only.
- A published informal proof is the best lead a prover can get: formalizing a known argument is far
  cheaper than finding one. Today Seshat never sees it.

## 2. What exists (pull request 2, Task 36)

- `lit.search` (`packages/lit`, `documentation/literature.md`): OpenAlex, arXiv, Semantic Scholar,
  zbMATH and the metadata of a local bench checkout. Each hit is a link, a title and the text the
  site gave (an abstract, a review). Exposure `auto`: no prover has it as a tool.
- The intake step: once per problem, before any paid session. Three queries made without a model,
  one judge call ("does a hit prove, refute or restrict this exact statement?") for at most 12
  hits, a quote kept only when it is verbatim in the hit's text, a `literature` memory node, a cap
  of $0.05. Not run again when a run is resumed.
- Trust: fetched text is hostile (allowed hosts, https, size limit, cleaning, markers, escaping);
  it never enters a system prompt or a lesson; no hit changes a claim's status (Ruling 13).
  `--private` turns everything off; `harness solve` asks for consent once and journals it.

The limits:

1. Titles and abstracts only. No full text, so no statement of a theorem, no lemma, no proof idea.
2. One search, at the gate. Nothing searches again when a sub-lemma, a hole of a blueprint or an
   impasse appears.
3. No watch. Nothing runs between runs, follows a subject over time, or notices that a watched
   problem was settled in the meantime.
4. Never run against a real site: every backend is tested against a fake server, and the request
   formats were written from memory of each site's documentation. The profile `sandboxed` that
   `harness doctor` writes does not enable `lit.search`, so the first real runs skipped the step.

## 3. The items

### LW1. Make what exists work for real

- `harness doctor` adds `lit.search` (the four remote backends) to the profile it writes, and its
  health check makes one real request to each site and says which answered.
- One recorded answer from each real site becomes a test fixture (as Task 7 did with a real Lean),
  and each backend's request and parser are corrected against it.
- A cache: an answer is stored in the blob store under the hash of its request and reused for a
  number of days (default 7), so that a rerun or a resume pays no second request.
- Politeness: one request at a time per site with the pause the site asks (arXiv: 3 seconds), a
  generic client name; a contact address in the request header only if the owner sets one
  (section 6, question 3).

Cost: no model call. Needs a machine that reaches the sites: the owner's, by Remote Control (the
cloud environment of the build reaches none).

### LW2. Search during the research

Two ways, the first without relying on the model's initiative:

- **By rule.** The harness runs the intake's search and judge, under the same quote screen, on:
  each hole of a blueprint when M12 states it (a hole is a lemma: the most likely thing to be
  known); the goal a prover is stuck on when the budget gate reads "no Lean progress" or M6's repeat
  rule ends a session; the start of a consortium turn or a `--resume` when the last intake is older
  than N days (default 7). Each is one journaled step with its own share of the problem's cap.
- **By the prover.** An optional tool `lit_lookup` (query in, screened hits out: title, link,
  cleaned text between markers, as a tool result, never in the system prompt), at most 3 calls per
  session, charged to the session. This relaxes "no prover has it as a tool": question 5.

A kept hit becomes a `literature` node about the hole's or the goal's claim and appears in the next
briefing as data. `lean.search` already answers "is this lemma in Mathlib"; the two are shown
together.

### LW3. Full text

A capability `lit.read`: one paper in, its text out, cut into passages.

- Sources, in this order: arXiv's HTML rendering; the paper's LaTeX source from arXiv (an archive
  of `.tex` files, read as text, never compiled or executed); the open-access link OpenAlex gives,
  when it serves HTML or text; a PDF only through a local text extractor when the host offers one
  (optional capability, off by default). No paywalled source, no scraping of a search engine.
- Same guards as `lit.search` (allowed hosts, https, no redirect outside the list, size limit,
  text only, cleaning), a larger size limit (5 MiB), and the cache of LW1 keyed by the paper's id,
  so that a paper is fetched once for all runs.
- Passages without a model: sections, and the `theorem`, `lemma`, `proposition`, `corollary`,
  `conjecture`, `proof` environments, each with a locator (section number, environment label).
  Passages are ranked against the statement's words by a classical ranking function (BM25), no
  model and no index service.
- Two stages, so that reading is paid only where it can matter: the existing judge on abstracts;
  then, for at most 3 hits whose verdict is not `unrelated`, the full text is fetched and the
  judge is asked again on the top passages. The quote screen then runs against the full text.
- **Leads.** For a hit that `proves` or `restricts`, one extractive call picks the passages that
  state the result and its key lemmas: its output is locators and verbatim quotes only, screened
  like any quote. The prover's briefing shows them as data ("a published argument, not checked").
  No model paraphrase of a third party's text enters a prompt.
- The cap: the intake's cap covers both stages; its default rises from $0.05 to $0.10 when
  `lit.read` is on, still at most 5% of the problem's allowance.

### LW4. A recurring watch

A command `harness watch`, one pass per call, and a watchlist with its own journal (hash chain, as
every journal), so that a pass is replayable and its nodes can feed a run with `--memory-from`.

- A **subject** is a problem (its statement in words, and the ids of its source papers when known)
  or a topic (query words, arXiv categories). `harness watch add`, `list`, `remove`. Option: every
  problem a run leaves unsolved is added automatically (question 4).
- A **pass**, for each subject: the stored queries restricted to what appeared since the last pass
  (the date filters of arXiv, OpenAlex and zbMATH); the new works that cite the subject's source
  papers (OpenAlex and Semantic Scholar give citing works: for a named conjecture this is the
  strongest signal); removal of what was already seen (by DOI or arXiv id); then the same judge
  and quote screen, and LW3's second stage, on the new hits only.
- **What comes out**: `literature` nodes in the watch's journal; a digest `WATCH.md` (by subject:
  what is new, the verdict, the quote, the link); a flag on a watched problem that a hit settles,
  which `harness solve` and the intake read before spending anything, and which the consortium
  report shows ("since your last turn: 2 new papers, 1 settles the problem").
- **Cost**: no model call when nothing new appeared; a cap per pass (default $0.10) and per
  subject. The pass is proportionate: a subject with no new hit costs a few requests.
- **Schedule**: Seshat has no daemon. `harness watch` is one pass; the documentation gives the
  line for a daily timer on the person's machine, and `harness watch --every 24h` loops for those
  who prefer a process. Default proposed: daily (question 2).
- Consent is per subject and journaled; `--private` subjects are never sent.

### LW5. Reading notes a person can use

For each problem, a page built from the journal with no model call: the sources read, when, what
each says (the screened quotes with their locators), its verdict, and whether a lead was given to
a prover and what became of it (the Lean outcome of the sessions that saw it). It is a section of
`RESULT.md`, of the report and of the UI. Everything shown is escaped as data.

### LW6. The measure

- A small literature bench, model-free to build: problems whose status in the literature is known
  (formal-conjectures entries carrying a `formal_proof ... at "URL"` attribute, conjecture 194 and
  its refutation) and open problems as negatives. Measures: settled problems found over settled
  problems known; false "settled" (target: none, each audited by hand in the pilot); dollars per
  problem; dollars a run would have spent on the problems the step stops.
- An ablation arm on the graded bench: `solve-v2` with and without LW2 and LW3, same cap. Caveat:
  PutnamBench solutions are public, so a gain there measures retrieval of a known proof, which is
  exactly what the feature is for, but must be reported as such and not as proving ability.

## 4. Trust rules, unchanged

- Lean is the judge. A hit, a passage or a lead never changes a claim's status; `settled` means
  "a source says so, with a quote that is really there".
- Fetched text is data: user-role sections and tool results between markers, never a system
  prompt, never a lesson, never executed. LaTeX is read as text.
- Every request and every answer is a tool run in a journal; a watch pass is replayable.
- One privacy rule: `--private` sends nothing outside, in a run and in the watch.
- Global Constraint 16 (the gate on model-written memory) is not touched: leads are extractive.

## 5. Order and cost

1. LW1 (half a task, then a real check on the owner's machine).
2. LW2 (one task): it reuses the intake as it is.
3. LW3 (one task, the largest: fetching, passages, second stage, leads).
4. LW4 (one task) and LW5 (half a task).
5. LW6 (half a task), then a real measurement.

About five small tasks, each one to three commits, by small agents, one or two at a time. No new
dependency is foreseen (text handling and ranking are a few hundred lines).

## 6. Questions for the owner

1. Order: before Tasks 38, 39, 43 and 44 (proposed, since it does not depend on the pilot's
   numbers), or after the measurement as decided on 2026-11-11?
2. The watch's default schedule (proposed: daily) and cap per pass (proposed: $0.10).
3. May requests carry a contact address (some sites give faster service for it)? Proposed: no,
   unless you set one.
4. Add every unsolved problem to the watchlist automatically? Proposed: yes, when the run had
   consent to search.
5. May a prover call `lit_lookup` itself (3 calls per session, screened results)? Proposed: yes,
   as an option measured in LW6; the searches by rule do not depend on it.

## 7. Not proposed, and why

- Model-written summaries of papers inside prompts or memory: a paraphrase cannot be checked
  against the source; quotes can.
- A learned index of papers (embeddings): later, and only if the classical ranking is shown to
  miss; it would be a small non-LLM component used as it is.
- Deep citation crawling: one hop (works citing the source) is the signal; more is cost.
- Forums and question sites (MathOverflow): a possible sixth backend later.
- Paywalled text and PDF parsing by a model.

## 8. What is not verified

The sites' request formats (arXiv's HTML and source addresses, the date and citation filters of
OpenAlex, Semantic Scholar and zbMATH) are written from memory and are checked in LW1 before
anything is built on them. Not every arXiv paper has an HTML rendering. The gain in problems
solved per dollar is unknown until LW6 runs.
