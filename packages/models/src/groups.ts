import { permutations } from "./magma.ts";
import { type Magma, type MagmaObject, magmaObject } from "./objects.ts";

/**
 * Why a table is not a group, or undefined when it is one: it is associative, has an identity, and
 * every element has an inverse.
 */
export function groupProblem(magma: Magma): string | undefined {
  const n = magma.size;
  const at = (a: number, b: number) => magma.table[a * n + b] as number;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      for (let c = 0; c < n; c++) {
        if (at(at(a, b), c) !== at(a, at(b, c))) return `the product is not associative: (${a}${b})${c} differs from ${a}(${b}${c})`;
      }
    }
  }
  const identity = identityOf(magma);
  if (identity === undefined) return "there is no identity element";
  for (let a = 0; a < n; a++) {
    if (!Array.from({ length: n }, (_, b) => b).some((b) => at(a, b) === identity && at(b, a) === identity)) return `${a} has no inverse`;
  }
  return undefined;
}

function identityOf(magma: Magma): number | undefined {
  const n = magma.size;
  for (let e = 0; e < n; e++) {
    let ok = true;
    for (let a = 0; a < n && ok; a++) ok = magma.table[e * n + a] === a && magma.table[a * n + e] === a;
    if (ok) return e;
  }
  return undefined;
}

/** A group from its Cayley table. The table is checked: a wrong construction fails here, with the reason. */
export function groupObject(name: string, size: number, table: readonly number[]): MagmaObject {
  const magma = { size, table };
  const problem = groupProblem(magma);
  if (problem !== undefined) throw new Error(`${name} is not a group: ${problem}`);
  const identity = identityOf(magma) as number;
  const inverse = Array.from({ length: size }, (_, a) => table.slice(a * size, (a + 1) * size).indexOf(identity));
  return magmaObject(size, table, { name, identity, inverse });
}

/** The cyclic group of order n: addition modulo n. */
export function cyclicGroup(n: number): MagmaObject {
  const table: number[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) table.push((a + b) % n);
  }
  return groupObject(`C${n}`, n, table);
}

/** The dihedral group of order 2n, the symmetries of a regular n-gon: the rotations r^i, then the reflections s r^i. */
export function dihedralGroup(n: number): MagmaObject {
  const table: number[] = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < n; i++) {
      for (let l = 0; l < 2; l++) {
        for (let j = 0; j < n; j++) {
          // (s^k r^i)(s^l r^j) = s^(k+l) r^((-1)^l i + j)
          const exponent = (((l === 1 ? -i : i) + j) % n + n) % n;
          table.push(((k + l) % 2) * n + exponent);
        }
      }
    }
  }
  return groupObject(`D${n}`, 2 * n, table);
}

/** The dicyclic group of order 4n (the quaternion group when n = 2): a^i x^k with a^(2n) = 1, x^2 = a^n, x a = a^-1 x. */
export function dicyclicGroup(n: number): MagmaObject {
  const table: number[] = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 2 * n; i++) {
      for (let l = 0; l < 2; l++) {
        for (let j = 0; j < 2 * n; j++) {
          const exponent = ((i + (k === 0 ? j : -j) + (k === 1 && l === 1 ? n : 0)) % (2 * n) + 2 * n) % (2 * n);
          table.push(((k + l) % 2) * 2 * n + exponent);
        }
      }
    }
  }
  return groupObject(n === 2 ? "Q8" : `Dic${n}`, 4 * n, table);
}

function permutationGroup(name: string, members: number[][]): MagmaObject {
  const index = new Map(members.map((p, k) => [p.join(","), k]));
  const table: number[] = [];
  for (const a of members) {
    for (const b of members) {
      // The composition a after b.
      const product = b.map((x) => a[x] as number);
      table.push(index.get(product.join(",")) as number);
    }
  }
  return groupObject(name, members.length, table);
}

/** The symmetric group on n points (n up to 5), its permutations in lexicographic order. */
export function symmetricGroup(n: number): MagmaObject {
  if (n < 1 || n > 5) throw new RangeError(`symmetricGroup takes 1 to 5 points, not ${n}`);
  return permutationGroup(`S${n}`, permutations(n));
}

/** The alternating group on n points (n from 3 to 5): the even permutations. */
export function alternatingGroup(n: number): MagmaObject {
  if (n < 3 || n > 5) throw new RangeError(`alternatingGroup takes 3 to 5 points, not ${n}`);
  const even = permutations(n).filter((p) => {
    let inversions = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) inversions += (p[i] as number) > (p[j] as number) ? 1 : 0;
    }
    return inversions % 2 === 0;
  });
  return permutationGroup(`A${n}`, even);
}

/** The direct product: the pair (x, y) is the element x * |b| + y. */
export function directProduct(a: MagmaObject, b: MagmaObject): MagmaObject {
  const table: number[] = [];
  for (let x = 0; x < a.size; x++) {
    for (let y = 0; y < b.size; y++) {
      for (let u = 0; u < a.size; u++) {
        for (let v = 0; v < b.size; v++) {
          table.push((a.table[x * a.size + u] as number) * b.size + (b.table[y * b.size + v] as number));
        }
      }
    }
  }
  return groupObject(`${a.name ?? "?"} x ${b.name ?? "?"}`, a.size * b.size, table);
}

function primeFactors(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let rest = n;
  for (let p = 2; p * p <= rest; p++) {
    let e = 0;
    while (rest % p === 0) {
      rest /= p;
      e++;
    }
    if (e > 0) out.push([p, e]);
  }
  if (rest > 1) out.push([rest, 1]);
  return out;
}

/** The ways to write e as a sum of parts, each part at most `max`. */
function partitions(e: number, max = e): number[][] {
  if (e === 0) return [[]];
  const out: number[][] = [];
  for (let part = Math.min(e, max); part >= 1; part--) {
    for (const rest of partitions(e - part, part)) out.push([part, ...rest]);
  }
  return out;
}

/** The abelian groups of order n: for each prime, a partition of its exponent, whose parts give the cyclic factors. */
export function abelianGroups(n: number): MagmaObject[] {
  let choices: Array<{ factors: number[]; cyclic: boolean }> = [{ factors: [], cyclic: true }];
  for (const [p, e] of primeFactors(n)) {
    choices = choices.flatMap((chosen) =>
      partitions(e).map((parts) => ({
        factors: [...chosen.factors, ...parts.map((part) => p ** part)],
        cyclic: chosen.cyclic && parts.length === 1,
      })),
    );
  }
  return choices.map(({ factors, cyclic }) => {
    if (cyclic) return cyclicGroup(n);
    const sorted = [...factors].sort((a, b) => b - a);
    return sorted.slice(1).reduce((product, order) => directProduct(product, cyclicGroup(order)), cyclicGroup(sorted[0] as number));
  });
}

/**
 * The groups of order 1 to `maxOrder` that the code builds: the abelian ones, the dihedral groups of
 * order 6 and more, the dicyclic groups (the quaternion group among them), and the symmetric and
 * alternating groups on 4 and 5 points. It has every group of order up to 15, 5 of the 14 groups
 * of order 16, and so on: the library of small groups comes from SageMath (`sage.ts`).
 */
export function smallGroups(maxOrder: number): MagmaObject[] {
  const out: MagmaObject[] = [];
  for (let n = 1; n <= maxOrder; n++) {
    out.push(...abelianGroups(n));
    if (n % 2 === 0 && n / 2 >= 3) out.push(dihedralGroup(n / 2));
    if (n % 4 === 0 && n / 4 >= 2) out.push(dicyclicGroup(n / 4));
    if (n === 12) out.push(alternatingGroup(4));
    if (n === 24) out.push(symmetricGroup(4));
    if (n === 60) out.push(alternatingGroup(5));
    if (n === 120) out.push(symmetricGroup(5));
  }
  return out;
}

/** The number of groups of order n, for n from 1 to 32 (OEIS A000001). */
export const GROUPS_OF_ORDER: readonly number[] = [
  1, 1, 1, 2, 1, 2, 1, 5, 2, 2, 1, 5, 1, 2, 1, 14, 1, 5, 1, 5, 2, 2, 1, 15, 2, 2, 5, 4, 1, 4, 1, 51,
];
