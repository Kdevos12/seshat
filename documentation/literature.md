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
