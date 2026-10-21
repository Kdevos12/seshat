# Trust: statuses and certification

## Claim statuses

| Status | Meaning |
|---|---|
| `open` | A conjecture: nothing is established yet. |
| `computed` | A candidate: a proof of the claim passed the fast check. |
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

Going down is revocation: a `computed` claim goes back to `open`, and a `proved`, `refuted` or
`proved_informal` claim becomes `retracted`. The memory store has one method for it,
`retractClaim(claimId, {reason})` ([memory.md](memory.md#claims)). It chooses the lower status
itself, so it raises none (it never reopens a `retracted` claim, though the table allows that move),
it needs a reason, and the journal records the change under the caller's actor. A
line may call it: it is the single change of status a line makes besides `validate`, and the line M2
is its only caller ([lines.md](lines.md#validate)).

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

An event to `computed` is refused unless it names a valid `validation.finished` event of the same
claim, a proof of the claim and not of its negation. A claim is also created `open`: the other
statuses come only through these checked changes. Tool output without a Lean proof therefore
never changes a claim's status: it marks an edge `computed` or is recorded as a node. Lines cannot
bypass the journal either: the memory store keeps it private ([memory.md](memory.md)), and a line
raises a status only through `validate` ([lines.md](lines.md#validate)). The one other change of
status a line makes only lowers one: `retractClaim`, the revocation described above.

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

The line M2 follows `lean_checked` edges with logic rules ([graph.md](graph.md)). What the rules
derive is a proposal: the line writes the composed Lean proof (the link lemmas applied to the proofs
of the premises) and submits it like any other, so a claim goes up only through a proof of its own
that passes the validator. A claim that held only through such a proof goes back down by revocation
(`retractClaim`, the only status change a line makes besides `validate`) when the proof's premises
are retracted: a candidate back to `open`, a certified claim to `retracted`.

## What runs where

The prover's code runs inside Lean during both checks. The Lean server and the certifier must run
in a sandbox: no network, read-only reference files, limits on time and memory. The reference type
is computed by the harness from the pristine original file, never from a file a prover could
touch.

Line M11 ([models.md](models.md)) sends Lean files of its own to the same server, for `decide` on a
statement about a number. The text of a statement reaches such a file as it is, so it is refused
unless it is free of the tokens that the validator refuses in a prover's regions
(`forbiddenTokensIn`) and of `#`, which starts a command; the rest of the file is the harness's.
That screen reads text as Lean's lexer does and trusts a run of letters as a name only where the lexer
starts a token for sure (after a space, `(`, `,` or `)`), because a keyword glued after a symbol token
that ends in letters (`#check`, Mathlib's `[MOD`) is a token of its own
([validator.md](validator.md#structural-checks)).

M11 also runs JavaScript that a model wrote, outside Lean: the programs of its `small_models` tool
([models.md](models.md#the-sandbox)). Each run is a Node child process of the harness, started with
`--permission`, so it reads nothing but its own script and has no file to write, no child process and
no worker. Its environment is empty: none of the harness's variables, and so none of its keys, are
in the process. Time is limited for each call and for the run, and the V8 heap by
`--max-old-space-size`; memory is not limited as such, since the buffers of typed arrays are outside
the heap. The network is open: Node's permission model does not restrict it, and the program's
`node:vm` context offers none. `node:vm` is not a security boundary. A program written to get out of
its context would find that open network, the files the permission model allows (its own script) and
the process's memory, which holds nothing of the harness's; nothing stronger than that is promised,
and a deployment that runs programs of models it does not trust puts the child in a container. The
verdicts of a program are test results: they change no status.
