# Lean templates for finite witnesses

Plan change CA19 (Task 41). The first real run of the harness on a conjecture about graphs failed
exactly here: the model could not build a finite witness in Lean, because of the type class instances
(adjacency decidable, `DecidableEq`, `Fintype`). `lean/SeshatLib/Finite` writes them once.

**None of this has been compiled.** It was written against Mathlib at Lean v4.27.0 (the pin of
[lean-env.md](lean-env.md)) in an environment with no Lean. The TypeScript generator is tested as text.

## The templates

- `Graph.lean`: `ofEdges n edges`, the simple graph on `Fin n` whose edges are a list of pairs of numbers
  (`AdjP n edges a b := a ≠ b ∧ ((a, b) ∈ edges ∨ (b, a) ∈ edges)`), with its `DecidableRel` instance (`Fin n` has
  `Fintype` and `DecidableEq` already); `adjB`, `degB` and `degreeSeq`.
- `Witness.lean`: checks that `decide` settles, each a Boolean function and the proposition that it is `true`:
  `IsIndepSet G s`, `IsPathList G p`, `HasHamPath G` (an ordering of all the vertices that is a path: `n ≤ 7`),
  `ConnectedSmall G`, and the degree sequence; and examples on the star on four vertices.

They use `decide` and nothing else. They never use `bv_decide` or `native_decide`, which add an axiom outside the three
the validator allows, and the validator refuses them. A test runs the repository's own text guard
(`forbiddenTokensIn`) over the templates and the generated proofs. `decide +kernel`: whether it adds an axiom on
Lean 4.27 is **to verify on a real Lean**, and nothing here uses it.

The files are modules `SeshatLib.Finite.Graph` and `SeshatLib.Finite.Witness` of the library tree (`lean/`); the lake project that
builds `SeshatLib` ([lean-env.md](lean-env.md)) is not part of this task.

## What the templates are for, and what the recheck reaches

**The refutation the harness submits does not use these templates.** It proves `¬ (type_of% @claim)` by instantiating the claim at the
witness and `decide`, with the graph written out as two `abbrev`s in the auxiliary region (a copy of `ofEdges`'s body, since the check
cannot import the library). The templates serve two other purposes: the certificate's Lean text (`graphCertificateLean`), and a prover that
writes the refutation by hand, who can use `ofEdges`, `HasHamPath` and the others where the library is built into the environment.

`decide` needs a `Decidable` instance for each predicate of the claim, and the kernel has to evaluate it. What is expected to be confirmed
automatically (not yet verified on a real Lean): claims made of `G.Adj`, `Fintype.card`, quantifiers over the vertices, `G.degree`, `G.edgeFinset.card`,
equalities and inequalities of numbers. What is **not** expected to be: claims stated with `G.Connected`, `G.Reachable`, `G.Walk` and
`Walk.IsPath` or `Walk.IsHamiltonian` (an existential over walks), colourings and `chromaticNumber`. Mathlib may give some of them a
`Decidable` instance; if it does not, or the kernel is too slow, the hit stays **unconfirmed**: an evidence node with the class of Lean's error.
The first follow-up on a real Lean is the bridge: lemmas that prove `ConnectedSmall`, `HasHamPath`, `IsPathList` and `IsIndepSet` equivalent to
Mathlib's predicates, so that a claim can be rewritten into the decidable form before `decide`.

A graph with more than `GRAPH_HUNT.leanVertices` (8) vertices is not sent at all: it stays unconfirmed with the class `too_large`
(`decide` on a claim about orderings or walks is a search of up to n! cases in the kernel; 8 is the size of the lists the code builds).
Hits are sent smallest first (fewest vertices, then fewest edges), at most three.

**An unconfirmed hit still goes to the provers.** The briefing ([models.md](models.md#statements-about-graphs)) gives the witness (vertex count and
edge list), the names and text of the auxiliary definitions for that graph, the class of Lean's error, and says that a program found the graph, Lean has not
confirmed it, and proving the negation at this graph is a candidate route. It is labelled evidence and never says the statement is false; it is cut at
`GRAPH_HUNT.briefingChars` (2500) characters, and lists at most `GRAPH_HUNT.briefingEdges` (60) edges.

## The generator

`packages/models/src/graph-lean.ts`:

- `graphAux(graph)` writes the graph as two `abbrev`s named `aux_g_<hash>` and `aux_gd_<hash>`, the body of `ofEdges` written out. The
  validator admits only `theorem`, `lemma`, `def` and `abbrev` in the auxiliary region and no `instance` or instance attribute, so the check
  cannot import the library and the proof cannot declare an instance.
- `graphNegationProofs(statement, graph)` gives two proofs of `¬ (type_of% @claim)` as M11 does for magmas: `have key := @hall <arguments>`,
  `revert key`, `decide`; and the same with the adjacency instance passed by name. The arguments follow the claim's binders
  (`recognizeGraphStatement`): `(Fin n)`, `_` for the instances, the graph; for a claim over `Type*` the graph on `ULift (Fin n)` through
  `SimpleGraph.comap ULift.down`.
- `submitGraphRefutation` sends them through `validate` after `leanTextProblems`, and classes a refusal (`leanErrorClass`).
- `graphCertificateLean(graph, facts)` is the certificate's Lean file: the witness by `ofEdges`, its degree sequence and its connectivity, by `decide`.

The tests (`packages/models/test/graph-lean.test.ts`, `graph-hunt.test.ts`) check structure, the guards, no forbidden tactic, and that the
edge list of the generated text is the certificate's.

## To verify on a real Lean

1. `Graph.lean` and `Witness.lean` compile. Places most likely to differ at Lean 4.27: the field `loopless` of `SimpleGraph` and
   `Irreflexive`; `List.finRange`, `List.permutations`; the `unfold; infer_instance` instances.
2. The proofs of the negation elaborate for a claim with `[DecidableRel G.Adj]`, for `Type` and `Type*`, and `decide` finds the
   instances for `aux_g_<hash>` through the `abbrev` (the explicit form passes `aux_gd_<hash>`, but the `Decidable` instances of the
   claim's own predicates still need the instance found by resolution: if they do not, a third form with `letI` is the next to try).
3. **The bridge.** The checks of `Witness.lean` are not Mathlib's `IsIndepSet`, `Walk.IsPath`, `Walk.IsHamiltonian` or `Connected`: no lemma
   proves them equivalent. A claim stated with Mathlib's predicates is refuted by `decide` only where Mathlib has a `Decidable` instance for
   them (check `SimpleGraph.Connected` and `Reachable`); otherwise the hit stays an unconfirmed evidence node with the error class `instance`.
4. `decide +kernel` and axioms: `#print axioms` on a proof that uses it.
5. The cost of `decide` on 8 to 10 vertices.
