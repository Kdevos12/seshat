import type { ColumnSpec } from "./datatable.ts";

/**
 * The columns every table of a family starts with: invariants a model can build hypotheses on. Each is a
 * function expression run in the sandbox on the object: a plain number for the integers, `{size, table}` for a magma (the row-major table of its operation). `lean` is the invariant as a Lean term in `n`, where
 * there is one: only such a column can be the end of a bound stated in Lean.
 */
export function defaultColumns(family: "integers" | "magmas"): ColumnSpec[] {
  if (family === "integers") {
    return [
      { name: "n", description: "the number", program: "(n) => n", lean: "n" },
      { name: "odd", description: "n is odd", program: "(n) => n % 2 === 1", lean: "n % 2 = 1" },
      { name: "digitsum", description: "sum of the decimal digits", program: "(n) => String(n).split('').reduce((a, c) => a + Number(c), 0)", lean: "(Nat.digits 10 n).sum" },
      {
        name: "divisors",
        description: "number of divisors (0 for n = 0)",
        program: "(n) => { let c = 0; for (let d = 1; d <= n; d++) if (n % d === 0) c++; return c; }",
        lean: "(Nat.divisors n).card",
      },
      {
        name: "sigma",
        description: "sum of the divisors (0 for n = 0)",
        program: "(n) => { let s = 0; for (let d = 1; d <= n; d++) if (n % d === 0) s += d; return s; }",
        lean: "(Nat.divisors n).sum id",
      },
      {
        name: "prime",
        description: "n is prime",
        program: "(n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; }",
        lean: "Nat.Prime n",
      },
      {
        name: "squarefree",
        description: "no square larger than 1 divides n",
        program: "(n) => { if (n < 1) return false; for (let d = 2; d * d <= n; d++) if (n % (d * d) === 0) return false; return true; }",
      },
      { name: "popcount", description: "ones in the binary expansion", program: "(n) => n.toString(2).split('').filter((c) => c === '1').length" },
    ];
  }
  const at = "o.table[a * o.size + b]";
  return [
    { name: "size", description: "number of elements", program: "(o) => o.size" },
    { name: "commutative", description: "a*b = b*a", program: `(o) => { for (let a = 0; a < o.size; a++) for (let b = 0; b < o.size; b++) if (${at} !== o.table[b * o.size + a]) return false; return true; }` },
    {
      name: "associative",
      description: "(a*b)*c = a*(b*c)",
      program: "(o) => { const m = (a, b) => o.table[a * o.size + b]; for (let a = 0; a < o.size; a++) for (let b = 0; b < o.size; b++) for (let c = 0; c < o.size; c++) if (m(m(a, b), c) !== m(a, m(b, c))) return false; return true; }",
    },
    { name: "idempotent", description: "a*a = a for every a", program: "(o) => { for (let a = 0; a < o.size; a++) if (o.table[a * o.size + a] !== a) return false; return true; }" },
    { name: "squares", description: "number of a with a*a = a", program: "(o) => { let c = 0; for (let a = 0; a < o.size; a++) if (o.table[a * o.size + a] === a) c++; return c; }" },
    {
      name: "unital",
      description: "there is an element e with e*a = a*e = a",
      program: "(o) => { for (let e = 0; e < o.size; e++) { let ok = true; for (let a = 0; a < o.size && ok; a++) ok = o.table[e * o.size + a] === a && o.table[a * o.size + e] === a; if (ok) return true; } return false; }",
    },
    { name: "image", description: "number of distinct products", program: "(o) => new Set(o.table).size" },
  ];
}
