import SeshatMeta.Statement
import SeshatMeta.Hash
import SeshatMeta.Commands

/-!
# SeshatMeta

Commands that read statements and proofs at Lean's meta level, each printing its answer as one
line of JSON in an information message (`documentation/lean-meta.md`):

* `#seshat_hash <statement>`: the statement's canonical id, `{"id":"st1_…"}`;
* `#seshat_defeq <statement> with <statement>`: `isDefEq` within the heartbeat limit;
* `#seshat_premises <declaration>`: the theorems its proof uses;
* `#seshat_profile <statement>`: the type classes and instances it involves;
* `#seshat_instances <statement> using [facts]`: which facts it is an instance of, and which facts
  are instances of it, found through a discrimination tree.

A statement is in signature form: `(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2`.

This library has never been compiled: it was written against the sources of Lean v4.27.0 in an
environment without Lean.
-/
