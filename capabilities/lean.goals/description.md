Lean, goal by goal, through Pantograph: see the goals a statement leaves, try a tactic on one goal and see what remains, without writing a whole file each time. Each answer gives a `state`, a number that later calls of this session use; a state never changes, so you can go back to an earlier one and try something else. A goal is shown as Lean shows it: the hypotheses, one per line, then `⊢` and the target.

- `start`: the goals of `statement` (signature form, `(n : ℕ) : n + 0 = n`), read after `header` (opens and definitions; this Lean has already loaded its modules, usually Mathlib, and cannot import others).
- `tactic`: runs `tactic` on goal `goal` (default 0) of `state`. It answers the new state and its goals (none left: that branch is proved), or `error` and Lean's `messages` when the tactic fails, in which case `state` is still there to try again.
- `goals`: the goals of `state` again.
- `sketch`: for a Lean file whose proofs have `sorry`s, one target per declaration with a `sorry`: its state and the goals of its `sorry`s.

A proof found here is only a candidate: the proof counts once the whole file passes `lean_check`.
