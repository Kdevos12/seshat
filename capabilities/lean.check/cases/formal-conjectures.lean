import FormalConjectures.Util.ProblemImports

/-! A problem file of the bench's project: its attributes and linters must leave no error. -/

namespace Harness

/-- Two is prime. -/
@[category test, AMS 11]
theorem prime_two : Nat.Prime 2 := by
  norm_num

end Harness
