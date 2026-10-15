Reads statements and proofs at Lean's meta level, through the commands of the Lean library SeshatMeta (`lean/SeshatMeta`). A statement is in signature form, as between a theorem's name and its `:=`: `(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2`. It is elaborated under `header` (`import Mathlib` when not given), which must bind every name it uses. One operation per call, chosen by `op`:

- `hash`: the statement's canonical id, `st1_` and 32 hexadecimal digits. Two statements that elaborate to the same term, up to bound names, binder kinds and the paths Lean took through global instances, get the same id. `simp` rewrites the statement with `simp only` and these lemmas first.
- `defeq`: whether `statement` and `other` are definitionally equal (`isDefEq`); `null` when Lean ran out of `heartbeats` (20000 when not given) before deciding.
- `premises`: the theorems the proof of `declaration` uses, in the Lean file `code`, through the auxiliary lemmas elaboration creates.
- `profile`: the type classes and the instances the statement involves.
- `instances`: among `facts` (statements, or names of declarations of the header), those the statement is an instance of (`instanceOf`), and those that are instances of it (`covers`), found through a discrimination tree and confirmed by unification.

A statement or a file that Lean refuses fails the call with Lean's message.
