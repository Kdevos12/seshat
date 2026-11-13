import { featuresOf, parseStatement, primaryDomain, routeFeatures } from "@seshat/classical";

/**
 * CA17: what kind of statement the router files a problem under, for the compute tool `harness solve --auto-tool` gives the provers.
 * `finite`: the router's own domain (a finite sort, decidable by enumeration); `graph`: the statement is about a graph (`SimpleGraph`,
 * `Graph`, `Digraph`, `Subgraph`, `Matching`...), which the router reads as first-order; `number`: every variable is a number (ℕ ℤ ℚ ℝ ℂ) or the
 * router's domain is one of arithmetic. Anything else, and a statement the router cannot read, is not filed: no tool is added.
 */
export type StatementKind = "finite" | "graph" | "number";

const GRAPH = /\b(?:Simple|Di)?[Gg]raph\b|\bSubgraph\b|\bMatching\b|\bClique\b|\bColorable\b|\bHamiltonian\b|\bAdj\b/;
const NUMBER_DOMAINS = new Set(["closed", "presburger", "linear_real", "polynomial_identity", "nonlinear_arith"]);
const NUMBER_SORTS = new Set(["ℕ", "ℤ", "ℚ", "ℝ", "ℂ", "Nat", "Int", "Rat", "Real", "Complex"]);

export function fileStatement(statement: string): StatementKind | undefined {
  if (GRAPH.test(statement)) return "graph";
  try {
    const features = featuresOf(parseStatement(statement));
    const route = routeFeatures(features);
    const domain = primaryDomain(route);
    if (route.domains.includes("finite")) return "finite";
    if (NUMBER_DOMAINS.has(domain)) return "number";
    if (features.sorts.length > 0 && features.sorts.every((s) => NUMBER_SORTS.has(s))) return "number";
  } catch {
    return undefined;
  }
  return undefined;
}
