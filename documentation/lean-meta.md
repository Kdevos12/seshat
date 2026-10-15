# The Lean meta tool

Lean answers questions about statements and proofs that text cannot: whether two statements are
the same term, which theorems a proof uses, which classes a statement involves, which known facts
it is an instance of. Three pieces give these answers to the harness:

- `lean/SeshatMeta`, a Lean library of commands that print one line of JSON each;
- the capability `lean.meta`, which runs those commands on the Lean server (exposure `auto`: the
  harness's code calls it, the provers do not);
- the package `@seshat/lean-meta`: the typed client `LeanMeta`, the Lean-backed statement identity
  `LeanIdentity` (`st1_` ids), the implementation over a `LeanChecker`, and a simulated
  implementation for tests.

The same package holds [`lean.goals`](#leangoals), proof goals one tactic at a time through
Pantograph, for the provers.

**SeshatMeta has never been compiled.** It was written against the sources of Lean v4.27.0 in an
environment without Lean, so it may not build as is, and the ids in this page are what its code
computes, by hand, not what a Lean run printed. Everything in TypeScript is tested against a
simulated Lean. [To verify against Lean](#to-verify-against-lean) lists what depends on Lean.

## The commands

A statement is written in the signature form of the harness's claims: the binders, then `:` and
the type, as between a theorem's name and its `:=` (`(n : ℕ) : n + 0 = n`, `: 1 + 1 = 2`).
SeshatMeta elaborates it to the closed term `∀ binders, type`. Unlike a theorem's header, it binds no
variable automatically (no auto-bound implicits): every variable must be bound by the binders.
Universe metavariables become universe parameters; a hole Lean cannot fill is refused. Each command
prints its answer as one line of JSON in an information message at the command; an elaboration
error is an error message instead, and no answer.

| Command | Answer |
|---|---|
| `#seshat_hash S` | `{"id":"st1_…"}`: the statement's id ([below](#the-canonical-form)). |
| `#seshat_hash S using [l₁, l₂]` | The id after `simp only [l₁, l₂]` rewrote the statement, so that `a ≥ b` and `b ≤ a` can be made the same with `ge_iff_le`. |
| `#seshat_defeq S with T` | `{"defeq":true}` or `false`: `isDefEq` on the two terms; `null` when it runs out of heartbeats (`maxHeartbeats` of the command, counted from `isDefEq` on). |
| `#seshat_premises d` | `{"premises":[…]}`: the theorems the value of `d` uses (`Expr.getUsedConstants`, theorems only), through the auxiliary lemmas elaboration creates (`d._proof_1`…). Sorted. |
| `#seshat_profile S` | `{"classes":[…],"instances":[…]}`: the classes of the instance binders and of the instance arguments of the constants the statement applies, and the instances it uses. Sorted. For comparing structures. |
| `#seshat_instances S using [f₀, f₁, …]` | `{"instanceOf":[i…],"covers":[j…]}`, positions in the list: the facts `S` is an instance of (once proved, each proves `S`), and the facts that are instances of `S` (once `S` is proved, it covers them). |

`#seshat_instances` puts the conclusions of the facts, their variables and hypotheses as
metavariables, in a discrimination tree (`Lean.Meta.DiscrTree`), and asks it for the conclusions
that unify with the statement's (`getUnify`). Each candidate is then checked both ways, as
`apply` then `assumption` would: with the special statement's variables and hypotheses fixed, the
general one's conclusion must unify with the special one's, and each hypothesis of the general one
left open must be one of the special one's. So `(a b : ℕ) : a + b = b + a` covers `: 2 + 3 = 3 + 2`,
and `(a b : ℕ) (h : a ≤ b) : a < b + 1` covers `(h : 2 ≤ 5) : 2 < 5 + 1`, but not `: 2 < 7`. The
facts are constants: declarations of the file or of its imports.

## The canonical form

`#seshat_hash` writes the elaborated statement as a text, and the id is `st1_` followed by the 32
hexadecimal digits of the FNV-1a hash of that text, on 128 bits (offset basis
`0x6c62272e07bb014262b821756295c58d`, prime `2^88 + 2^8 + 0x3b`, over the text's UTF-8 bytes):

```
#i              a bound variable, by its de Bruijn index
(S l)           a sort
(C n l…)        a constant, with its universe levels
(A f a…)        an application, flattened; a closed instance argument of a constant is _
(P t b)         a ∀, and (L t b) a fun: no binder name, no binder kind
(Z t v b)       a let or a have
(N n), (T "s")  a natural number literal, a string literal
(J S i e)       the projection i of the structure S
```

Levels are `0`, `(s l)`, `(max a b)`, `(imax a b)` and `u1`, `u2`…: the statement's universe
parameters are renamed in the order they first appear, then the level is normalized. Metadata is
dropped. An argument the constant's type declares instance-implicit (`[…]`) is `_` when it is
closed, built from global instances only: the instance path elaboration found does not count, and
the class still does, through the other arguments. An instance argument that uses the statement's
own instance binders is written out, so that a statement about two instances of the same class
(`[t₁ : TopologicalSpace X] [t₂ : TopologicalSpace X]`) does not get the id of another.

So bound names, binder kinds and global instance paths do not change the id; anything else does.
Some ids, as SeshatMeta's code computes them:

| Statement | Canonical text | Id |
|---|---|---|
| `: True` | `(C True)` | `st1_d76c7ae2a56599db06b0896a06e93c37` |
| `(n : ℕ) : n = n`, `(m : Nat) : m = m` | `(P (C Nat) (A (C Eq (s 0)) (C Nat) #0 #0))` | `st1_d00bd85fedab3a395168758d0a5ca620` |
| `{n : ℕ} : n + 0 = n` | `(P (C Nat) (A (C Eq (s 0)) (C Nat) (A (C HAdd.hAdd 0 0 0) (C Nat) (C Nat) (C Nat) _ #0 (A (C OfNat.ofNat 0) (C Nat) (N 0) _)) #0))` | `st1_c78985dfb79d4d8f3f1a904f7391d411` |

`n + 0 = n` and `n = n` have different ids although they are definitionally equal: the id
compares terms, and `#seshat_defeq` (op `defeq`) tells such statements apart. The id depends on
the environment only through the constants' names and the elaborated term, so it is the same on
every machine and in every run that has the same Lean and Mathlib. A new Mathlib can change it
(a renamed constant, another elaboration), which is why the implementation's version names the
project. The text is SeshatMeta's own rather than Lean's `Expr.hash`, which has 64 bits and no
guarantee of staying the same across Lean versions.

## The capability `lean.meta`

One capability for the five operations (`capabilities/lean.meta/manifest.json`):

| `op` | Input | Output |
|---|---|---|
| `hash` | `statement`, `header`, `simp` (lemma names) | `id` |
| `defeq` | `statement`, `other`, `header`, `heartbeats` (default 20000, Lean's `maxHeartbeats`) | `defeq`: `true`, `false` or `null` |
| `premises` | `code` (a whole file), `declaration` | `premises` |
| `profile` | `statement`, `header` | `classes`, `instances` |
| `instances` | `statement`, `facts` (`{name, statement?}`), `header` | `instanceOf`, `covers`: the facts' names |

All take `timeoutSec`, Lean's time limit. `header` holds the imports, `open`s and definitions the
statements need; without one it is `import Mathlib`, and an empty header imports nothing but
SeshatMeta. Lemma, declaration and fact names cannot hold spaces, commas or brackets, so they cannot
end the command's list.

Its implementation `kimina` (factory `kimina-meta`, `@seshat/lean-meta`'s `leanMetaImplementation`
over the `KiminaChecker` of the host's settings) sends each call to Kimina Lean Server as one
snippet (`metaSnippet`): the header in plain form (`toPlainHeader`) with `import SeshatMeta` after
its imports, so that the server takes it as part of the header; for `instances`, each fact given by
a statement as an axiom `seshat_fact_<i>` (with `autoImplicit` off); then the command, with each
statement followed by a line break, so that a comment at its end cannot hide the rest. `readAnswer`
reads the answer: the one information message on the command's lines whose text is a JSON object.

| Lean's result | The call |
|---|---|
| The server did not answer (`server_error`) | Unreachable: the registry tries the host's next implementation, else `unavailable`. |
| An error message anywhere in the file, Lean's time limit, a REPL failure, no answer or two | `failed`, with Lean's messages. |
| One answer | Its fields, checked (an id must be `st1_` and 32 digits, positions must be in the list). |

Lean's time limit is the call's `timeoutSec`, or else the registry's limit for the call less the
15 s margin the registry adds to a `timeoutSec` (`leanTimeoutSec`): Lean stops first, and the call
fails with "Lean ran out of time" (`rejected`) rather than being aborted (`unreachable`).

Its health check asks for the id of `: True` under an empty header and compares it with the one
above, which shows that the server's project has SeshatMeta and that its canonical form is the one
documented. Its version, `fb2393de+lean-v4.27.0+fc-bench-v1+seshat-meta-0.1.0`, adds the library's
version to `lean.check`'s.

The answer is read from a message, which code in a statement could forge, as for `lean.check`. An id
is an index for deduplication and never a proof: a claim is settled only by the certifier, against
its own stored statement.

The contract (`capabilities/lean.meta/contract.json`) has 11 cases: the three ids above, a
statement about a header's definition, a statement Lean refuses, `defeq` both ways, the premises of
a one-line proof, the profile of a group statement, and `instances` both ways.

## The TypeScript side

`LeanMeta` (`packages/lean-meta/src/meta.ts`) is the typed client over the registry: `hash`,
`defEq`, `premises`, `profile`, `instances`. Each call is a recorded tool run; it answers or throws
a `LeanMetaError` whose `kind` is `rejected` (Lean or the schema refused this input: the same call
would be refused again; the registry's `failed` and `invalid_input`) or `unreachable` (no answer:
the host has no `lean.meta`, the server is down or lacks SeshatMeta, a time out, an abort, a
malformed answer). `details` holds Lean's messages.

### `LeanIdentity`

`LeanIdentity` implements the memory's `StatementIdentity` ([memory.md](memory.md#claims)) with
version `st1`: `id(statement, {header, kind})` is `LeanMeta.hash` of the statement under its header,
or under the identity's default header (`import Mathlib` unless given). So
`(n : ℕ) : n + 0 = n` and `{m : Nat} : m + 0 = m` are the same claim. A statement Lean refuses has
no id: `id`, and so `ensureClaim`, throws the `LeanMetaError`. An informal statement cannot be
elaborated: it keeps its textual id (`statementIdV0`, `st0_`), and can only be the same claim as
the same text. Ids are cached by statement and header (10000 by default, the least recently used
dropped first); a failed call is not cached.

No run uses it yet: no line gives it as the run's identity (`Line.identity`,
[lines.md](lines.md#a-line)). In a run with lines every claim, the problems' own included, goes
through `ensureClaim`, so a line that gives `LeanIdentity` names all of them with `st1_` ids.

### Simulated

`SimulatedLeanMeta` (`simulated.ts`) answers from a table of entries
`{input, output | error | unavailable}`: the first entry whose fields equal the input's answers. A
`hash` no entry answers gets `simulatedId(statement)`, a hash of its text; any other call no entry
answers is refused. Tests put in the table which texts Lean would make the same term.
`simulated.factory()` serves the table as an implementation of `lean.meta`.

## `lean.goals`

`lean.goals` (`capabilities/lean.goals/manifest.json`) works on a proof goal by goal: `direct`, so
a run can give it to the provers, and stateful, one set of states per scope. A run gives it only
when asked (`harness run --tool lean.goals`): no run has it by default.

**It is not sandboxed.** The statements, headers, tactics and files come from the model, and Lean
runs them in a child process of the harness, as the harness's user. Lean code can do any IO
(`#eval`, `run_tac`, `elab`): read and write whatever that user can, including `.env` and the
runs' journals and blobs. Only the environment is cleaned (the process gets `PATH`, `HOME` and the
few variables of its settings). This breaks the rule that model-written code runs in a sandbox
([trust.md](trust.md#what-runs-where); `compute.sage` runs in a container without network or a
writable disk). Until an implementation in a container or under a restricted user exists, give
`lean.goals` to provers only on a machine and user whose files the model may read and change.

Its operations:

| `op` | Input | Output |
|---|---|---|
| `start` | `statement` (signature form), `header` | `state`, `goals` |
| `tactic` | `state`, `goal` (default 0), `tactic` | `state`, `goals`, `messages`; or `error` and `messages`, and no new state |
| `goals` | `state` | `state`, `goals` |
| `sketch` | `code`, a Lean file with `sorry`s | `targets`: a `state` and its `goals` per declaration with a `sorry` |

A goal is a string as Lean shows it: `case` and its name, the hypotheses (those of one type on one
line), `⊢` and the target. A state never changes: a tactic gives a new one, so a prover can go back
to any earlier state. A tactic Lean refuses is an answer (`error`), not a failed call; an unknown
state, a statement Lean refuses, or a header that imports a module the REPL has not loaded fails
the call.

Its implementation `pantograph` (factory `pantograph`, `pantograph.ts`) runs Pantograph's REPL
v0.3.13 as a child process, `PantographRepl`: started on the first call with the `modules` of its
settings (default `Mathlib`), since it cannot import others later; it prints `ready.`, then answers
each command line (`<command> <json>`) with one line of JSON. Commands go one at a time.

- `start` and `sketch` send the file to `frontend.distil`, its imports blanked (`distilFile`);
  `start`'s file is the header then `theorem seshat_goal <statement> := by sorry`, so the binders
  are the goal's hypotheses.
- `tactic` is `goal.tactic`, `goals` is `goal.print`, a released scope's states go with
  `goal.delete`, and the health check is `stat`. Lean's time limit is Pantograph's option
  `timeout` (`options.set`): `timeoutSec`, or else the registry's limit for the call less the
  15 s the registry adds to a `timeoutSec`, so that a slow tactic stops in Lean, with an answer,
  before the registry aborts the call (which kills the process).
- Each scope numbers its states from 0, mapped to Pantograph's ids. An abort kills the process,
  since Lean cannot be interrupted otherwise; the next call starts a new one, and the states of
  the old one are refused ("lost when Lean restarted"), in every scope.
- A REPL that cannot start (no executable, a module it cannot find) is unreachable, so the registry
  tries the host's next implementation.

Its settings: `command` (default `repl`), `args` (before the modules), `modules`, `cwd` and `env`
(added to the few variables a child process inherits, such as `LEAN_PATH`; an empty `cwd` or
variable is left out). The host profiles read `PANTOGRAPH_REPL`, `LEAN_PROJECT_DIR` and
`LEAN_PATH`. `LeanGoals` is its typed client for one scope (`start`, `tactic`, `goals`, `sketch`,
`release`), with the errors of `LeanMeta`. Its contract has 6 cases. The tests run the REPL
protocol against a fake Pantograph process (`packages/lean-meta/test/fixtures/fake-pantograph.ts`);
it has not run against Pantograph.

## Deployment

The server's project is the bench's formal-conjectures checkout ([lean.md](lean.md#deployment-for-the-bench));
SeshatMeta must be built in it. SeshatMeta imports only `Lean`; its own package requires Mathlib at
`v4.27.0` so that a file in its project can run the commands on Mathlib statements. Two ways, neither
tried yet:

1. As a dependency: add to formal-conjectures' Lake file
   `require SeshatMeta from "/path/to/seshat/lean/SeshatMeta"` (or a `[[require]]` with `path` in a
   `lakefile.toml`), then `lake update SeshatMeta && lake build SeshatMeta`. Lake keeps the root's
   Mathlib, so the bench's pin stands.
2. As a library of the project: copy `lean/SeshatMeta/SeshatMeta.lean` and
   `lean/SeshatMeta/SeshatMeta/` into the checkout, declare `lean_lib SeshatMeta` in its Lake file,
   and `lake build SeshatMeta`.

Then `pnpm harness health` shows whether SeshatMeta answers, and
`pnpm harness contract lean.meta` runs the contract. Kimina keeps one REPL per header, and the
headers of `lean.meta` (which import SeshatMeta) differ from those of `lean.check`, so the first
call under a header loads Mathlib again.

For `lean.goals`, build Pantograph at `v0.3.13` (Lean v4.27.0) with `lake build repl`, and point
the harness at it with the project's library path, as Pantograph's documentation says:

```sh
export PANTOGRAPH_REPL=/path/to/Pantograph/.lake/build/bin/repl
export LEAN_PROJECT_DIR=/path/to/formal-conjectures
export LEAN_PATH=$(cd "$LEAN_PROJECT_DIR" && lake env printenv LEAN_PATH)
pnpm harness contract lean.goals
```

## To verify against Lean

1. That SeshatMeta builds at v4.27.0. It uses `expandDeclSig`, `Term.elabBinders`,
   `Term.levelMVarToParam`, `Expr.getUsedConstants`, `isInstanceCore`, `DiscrTree.insert` and
   `getUnify`, `forallMetaTelescopeReducing`, `findLocalDeclWithType?`, `tryCatchRuntimeEx`,
   `Exception.isMaxHeartbeat`, `withCurrHeartbeats`, `SimpTheorems.addConst`, `Simp.mkContext` and
   `Lean.Meta.simp`, read from Lean's sources at v4.27.0.
2. The contract's three exact ids: they assume the elaborated forms in the cases' purposes (that
   `n + 0` is `HAdd.hAdd` with an instance argument and `0` an `OfNat.ofNat` literal). Another form
   is a change to this page and the contract, not a bug, as long as the id is stable.
3. That `with` and `using` end a statement's term, and that the answer under
   `set_option maxHeartbeats N in` is on the command's lines.
4. That the server takes `import SeshatMeta` as part of the header and finds the module.
5. That `#seshat_premises` sees through auxiliary lemmas, and `#seshat_instances` finds and checks
   the contract's facts.
6. For `lean.goals`: the JSON Pantograph v0.3.13 prints (field names, goals, messages, errors, as
   read from its `Protocol.lean`), that `frontend.distil` accepts a file whose imports are blank
   lines, and the goals' text in the contract's cases.
