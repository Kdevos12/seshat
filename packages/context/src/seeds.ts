/**
 * The pattern-seed channel (plan change PC5 item 1c; Ataeva et al. 2026): a table from features of a goal to declarations that
 * are usually needed with it. A seed is offered only if the environment's export has it (a name is never invented), and its
 * dependency neighbours come from an injected source (`lean.meta premises`, TheoremGraph's LeanGraph), none without one. The
 * table is small and hand-written; whether it helps is measured by Task 14, and the channel is off by default.
 */
export interface SeedRule {
  /** What the goal's statement shows. */
  feature: RegExp;
  /** The declarations of Mathlib that go with it. */
  seeds: readonly string[];
}

export const SEED_TABLE: readonly SeedRule[] = [
  { feature: /%/, seeds: ["Nat.mod_lt", "Nat.add_mod", "Nat.mul_mod", "Nat.mod_mod", "Int.emod_emod_of_dvd"] },
  { feature: /∣/, seeds: ["Nat.dvd_add", "Nat.dvd_sub", "dvd_trans", "Nat.dvd_of_mod_eq_zero", "Dvd.dvd.mul_right"] },
  { feature: /Finset\.sum|∑/, seeds: ["Finset.sum_comm", "Finset.sum_add_distrib", "Finset.sum_range_succ", "Finset.sum_le_sum"] },
  { feature: /Finset\.prod|∏/, seeds: ["Finset.prod_comm", "Finset.prod_range_succ", "Finset.prod_mul_distrib"] },
  { feature: /Finset\.card|\.card/, seeds: ["Finset.card_union_add_card_inter", "Finset.card_le_card", "Finset.card_image_le"] },
  { feature: /Nat\.Prime|Prime/, seeds: ["Nat.Prime.two_le", "Nat.Prime.eq_one_or_self_of_dvd", "Nat.Prime.dvd_mul"] },
  { feature: /Nat\.choose|choose/, seeds: ["Nat.choose_symm_diff", "Nat.succ_sub_one", "Nat.choose_succ_succ"] },
  { feature: /Real\.sqrt|√/, seeds: ["Real.sqrt_nonneg", "Real.sq_sqrt", "Real.sqrt_le_sqrt"] },
  { feature: /Even|Odd/, seeds: ["Nat.even_add", "Nat.even_mul", "Nat.odd_iff", "Nat.even_or_odd"] },
  { feature: /\|[^|]+\|/, seeds: ["abs_nonneg", "abs_sub_comm", "abs_add"] },
  { feature: /Nat\.factorial|!/, seeds: ["Nat.factorial_pos", "Nat.factorial_succ", "Nat.self_le_factorial"] },
  { feature: /Nat\.gcd|gcd/, seeds: ["Nat.gcd_comm", "Nat.gcd_dvd_left", "Nat.Coprime.dvd_of_dvd_mul_left"] },
];

/** The seed names the statement's features call for, in table order, once each. */
export function seedNames(statement: string, table: readonly SeedRule[] = SEED_TABLE): string[] {
  return [...new Set(table.filter((r) => r.feature.test(statement)).flatMap((r) => r.seeds))];
}

/** The dependency neighbours of a declaration (the declarations its proof uses and that use it): the export `lean.meta` gives. */
export type DependencyNeighbours = (name: string) => Promise<readonly string[]>;
