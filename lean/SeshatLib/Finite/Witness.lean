import SeshatLib.Finite.Graph

/-!
# `SeshatLib.Finite.Witness`: checking a witness on a small graph by `decide`

Every check is a Boolean function on a list of vertices and a proposition that says it is `true`, so
that `decide` evaluates it with no instance to find. They are small on purpose: `decide` runs in the
kernel, and the number of orderings of the vertices grows as `n!`, so `HasHamPath` is for `n ≤ 7`.

* `IsIndepSet G s`: `s` has no repeated vertex and no two of its vertices are adjacent;
* `IsPathList G p`: `p` has no repeated vertex and each vertex is adjacent to the next;
* `HasHamPath G`: some ordering of all the vertices is a path (a Hamiltonian path);
* `ConnectedSmall G`: every vertex is reached from the vertex 0, by growing a set `n` times;
* the degree sequence is `degreeSeq` of `Graph.lean`.

These are the statements that a counterexample to a conjecture on graphs is checked with. They are
not Mathlib's `SimpleGraph.IsIndepSet`, `SimpleGraph.Walk.IsPath`, `SimpleGraph.Walk.IsHamiltonian` or
`SimpleGraph.Connected`: the bridge lemmas that prove each one equivalent are not written, and
`documentation/finite-lean.md` lists them as the first thing to do on a real Lean. A claim stated with
Mathlib's own predicates is refuted by `decide` only where Mathlib gives them a `Decidable` instance.

Never compiled (see `Graph.lean`).
-/

namespace SeshatLib.Finite

variable {n : Nat}

/-- No vertex of `s` is adjacent to another one of `s`. -/
def indepB (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (s : List (Fin n)) : Bool :=
  s.all fun a => s.all fun b => !(adjB G a b)

/-- `s` is an independent set: no repeated vertex, and no two vertices adjacent. -/
def IsIndepSet (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (s : List (Fin n)) : Prop :=
  s.Nodup ∧ indepB G s = true

instance (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (s : List (Fin n)) : Decidable (IsIndepSet G s) := by
  unfold IsIndepSet
  infer_instance

/-- Each vertex of the list is adjacent to the next one. -/
def pathB (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] : List (Fin n) → Bool
  | a :: b :: rest => adjB G a b && pathB G (b :: rest)
  | _ => true

/-- `p` is a path: no repeated vertex, and each vertex adjacent to the next. -/
def IsPathList (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (p : List (Fin n)) : Prop :=
  p.Nodup ∧ pathB G p = true

instance (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (p : List (Fin n)) : Decidable (IsPathList G p) := by
  unfold IsPathList
  infer_instance

/-- Some ordering of all the vertices is a path. -/
def HasHamPath (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] : Prop :=
  ∃ p ∈ (List.finRange n).permutations, pathB G p = true

instance (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] : Decidable (HasHamPath G) := by
  unfold HasHamPath
  infer_instance

/-- The vertices adjacent to a vertex of `s`, with those of `s`. -/
def growB (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (s : List (Fin n)) : List (Fin n) :=
  (List.finRange n).filter fun w => s.contains w || s.any fun v => adjB G v w

/-- The vertices reached from `v` in `k` steps or fewer. -/
def reachB (G : SimpleGraph (Fin n)) [DecidableRel G.Adj] (v : Fin n) : Nat → List (Fin n)
  | 0 => [v]
  | k + 1 => growB G (reachB G v k)

/-- Every vertex is reached from the vertex 0 in at most `n` steps. -/
def connectedB {m : Nat} (G : SimpleGraph (Fin (m + 1))) [DecidableRel G.Adj] : Bool :=
  (reachB G 0 (m + 1)).length == m + 1

/-- A graph on at least one vertex in which every vertex is reached from the vertex 0. -/
def ConnectedSmall {m : Nat} (G : SimpleGraph (Fin (m + 1))) [DecidableRel G.Adj] : Prop :=
  connectedB G = true

instance {m : Nat} (G : SimpleGraph (Fin (m + 1))) [DecidableRel G.Adj] : Decidable (ConnectedSmall G) := by
  unfold ConnectedSmall
  infer_instance

/-! ## Examples: the star on four vertices, the witness of "every connected graph has a Hamiltonian path" -/

/-- The star with centre 0 and leaves 1, 2, 3. -/
abbrev star4 : SimpleGraph (Fin 4) := ofEdges 4 [(0, 1), (0, 2), (0, 3)]

example : degreeSeq star4 = [3, 1, 1, 1] := by decide
example : IsIndepSet star4 [1, 2, 3] := by decide
example : IsPathList star4 [1, 0, 2] := by decide
example : ConnectedSmall star4 := by decide
example : ¬ HasHamPath star4 := by decide

end SeshatLib.Finite
