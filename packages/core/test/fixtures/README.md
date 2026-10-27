# Test fixtures

`erdos-125.lean` is `FormalConjectures/ErdosProblems/125.lean` from
[google-deepmind/formal-conjectures](https://github.com/google-deepmind/formal-conjectures) at commit
`e47a327f7befa3df97115abf87aa8ed35c381f1f`, under the Apache License 2.0 (header kept in the file).

`lean-oracle-regions.json` is a recording of a real Lean, not of this repository's code: regions of text,
each with the payload `#eval 7777` somewhere in it, on which Lean 4.27.0 (core, `Init` only, no
Mathlib) ran the payload as a command. The Task 7 re-review of 2026-10-27 made 560 000 random regions
(after a tactic block and in a term-mode theorem), ran them through Lean, and kept the 59 624 in which a
message was exactly `7777\n`. The file holds the 666 distinct regions among them that the screen of
`c79681e` or `ec4817a` accepted (`missed`), and 3 000 others chosen with a fixed seed (`sample`), about 120 KB
in all. `validator.test.ts` checks that the screen refuses every one. Lean is not run by any test; the
file is the oracle, and a new region that a real Lean runs and the screen accepts is added to `missed`.
