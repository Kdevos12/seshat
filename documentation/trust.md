# Trust: statuses and certification

## Claim statuses

| Status | Meaning |
|---|---|
| `open` | A conjecture: nothing is established yet. |
| `computed` | A candidate: a proof passed the fast check, or a tool found evidence without a Lean certificate. |
| `proved` | A certified Lean proof. |
| `refuted` | A certified Lean proof of the negation. |
| `proved_informal` | An accepted informal proof (kept for later; the bench does not use it). |
| `retracted` | Withdrawn, for instance because a result it relied on was retracted. |

The first four are the plan's statuses: conjecture, candidate proof, certified proof, refuted.

Allowed transitions (`packages/core/src/status.ts`):

| From | To |
|---|---|
| `open` | `computed`, `refuted`, `proved`, `proved_informal` |
| `computed` | `open`, `refuted`, `proved`, `proved_informal` |
| `proved_informal` | `proved`, `refuted`, `retracted` |
| `proved` | `retracted` |
| `refuted` | `retracted` |
| `retracted` | `open` |

A proof or a refutation is never downgraded; it can only be retracted.

## Two levels of checking

**The fast check** runs in a Lean REPL ([validator.md](validator.md)). The validator rebuilds the
file from the fixed parts and the prover's two regions, refuses forbidden tokens before Lean runs,
appends `#print axioms` and a `pp.all` `#check` of the target, and accepts the proof when:

- Lean reports no error in the file;
- the target depends on no axiom other than `propext`, `Classical.choice` and `Quot.sound`;
- the target's fully elaborated type is the one of the original file.

The fast check is quick and gives the prover exact feedback. It reads messages that Lean prints
during elaboration, though, and code that runs during elaboration could forge them. A pass
therefore makes a candidate (`computed`), not a proof.

**Certification** compiles the candidate in a fresh process, replays every declaration of the
compiled module through the kernel, collects the target's axioms itself, and compares the target's
type with the reference type as terms. This is the design of
[lean4checker](https://github.com/leanprover/lean4checker) and
[SafeVerify](https://github.com/GasStationManager/SafeVerify). Its interface is `LeanCertifier`
(`packages/core/src/lean.ts`); the implementation needs Lean and comes with the Lean environment.

## The journal enforces it

A `claim.status_changed` event to `proved` or `refuted` is refused unless it names a
`validation.finished` event of the same claim that is valid and certified
(`method: "kernel_replay"`): a proof of the claim for `proved`, a proof of its negation
(`negation: true`) for `refuted`. No code path can mark a claim proved without a certificate
([journal.md](journal.md#invariants)).

## Edges

Edges between claims have their own statuses:

| Status | Meaning |
|---|---|
| `proposed` | Someone suggested it: a model, a heuristic, a search. |
| `computed` | A tool found evidence for it, without a Lean proof. |
| `informal_checked` | An informal argument was accepted. |
| `human_signed` | A person vouched for it. |
| `lean_checked` | Lean checked its link lemma. |

Only `lean_checked` edges propagate proofs. The journal accepts `lean_checked`, when an edge is
added or later, only with the edge's link lemma (`link`: a name and a statement) and a valid
validation, fast check or certification, of a claim whose statement is the link's statement (up to
comments and whitespace). Whether the lemma says what the edge says is the job of whoever
proposed the edge. Either way, a claim becomes `proved` only through a certified proof of that
claim, so a wrong edge can mislead a search, never prove anything. An edge's status can go down
again, with a reason (the lemma's file changed, a dependency was retracted).

## What runs where

The prover's code runs inside Lean during both checks. The Lean server and the certifier must run
in a sandbox: no network, read-only reference files, limits on time and memory. The reference type
is computed by the harness from the pristine original file, never from a file a prover could
touch.
