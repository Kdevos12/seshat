import Mathlib.Combinatorics.SimpleGraph.Basic
import Mathlib.Data.Fintype.Basic
import Mathlib.Data.List.Basic

/-!
# `SeshatLib.Finite.Graph`: a simple graph on `Fin n` from an edge list

`ofEdges n edges` is the simple graph on `Fin n` whose edges are the pairs of `edges` (in either
order). Its adjacency is a decidable proposition, so the instance of `DecidableRel` below is found
by type class resolution, and `decide` settles statements about the graph. `Fin n` has `Fintype` and
`DecidableEq` already, which is why a graph on it needs nothing else.

An edge is a pair of natural numbers `(u, v)` with `u < n` and `v < n`; a pair with `u = v` is no
edge, as a simple graph has no loop.

Documented in `documentation/finite-lean.md`. This file has never been compiled: it was written
against Mathlib at Lean v4.27.0 in an environment without Lean. Where a name may differ in that
version (`loopless` and `Irreflexive`), `documentation/finite-lean.md` lists it.

The templates use `decide` only. They never use the tactics that add an axiom outside the three that
the validator allows. Whether `decide +kernel` adds one on Lean 4.27 is to verify on a real Lean, and
nothing here uses it.
-/

namespace SeshatLib.Finite

/-- Adjacency of `ofEdges`, as a proposition on two vertices. -/
def AdjP (n : Nat) (edges : List (Nat × Nat)) (a b : Fin n) : Prop :=
  a ≠ b ∧ ((a.val, b.val) ∈ edges ∨ (b.val, a.val) ∈ edges)

instance (n : Nat) (edges : List (Nat × Nat)) (a b : Fin n) : Decidable (AdjP n edges a b) := by
  unfold AdjP
  infer_instance

/-- The simple graph on `Fin n` with the given edges. -/
def ofEdges (n : Nat) (edges : List (Nat × Nat)) : SimpleGraph (Fin n) where
  Adj := AdjP n edges
  symm := fun _ _ h => ⟨h.1.symm, h.2.symm⟩
  loopless := fun _ h => h.1 rfl

instance (n : Nat) (edges : List (Nat × Nat)) : DecidableRel (ofEdges n edges).Adj :=
  fun a b => inferInstanceAs (Decidable (AdjP n edges a b))

/-- The adjacency of `ofEdges` unfolds to `AdjP`: the lemma that `decide` goals about a graph reduce with. -/
theorem ofEdges_adj (n : Nat) (edges : List (Nat × Nat)) (a b : Fin n) :
    (ofEdges n edges).Adj a b ↔ AdjP n edges a b :=
  Iff.rfl

/-- The adjacency as a Boolean. -/
def adjB {n : Nat} (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (a b : Fin n) : Bool :=
  decide (G.Adj a b)

/-- The degree of a vertex: how many vertices it is adjacent to. -/
def degB {n : Nat} (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (v : Fin n) : Nat :=
  ((List.finRange n).filter (fun w => adjB G v w)).length

/-- The degrees of the vertices 0, 1, ..., n - 1, in this order. -/
def degreeSeq {n : Nat} (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] : List Nat :=
  (List.finRange n).map (degB G)

end SeshatLib.Finite
