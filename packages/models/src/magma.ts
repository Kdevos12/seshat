import { type Magma, type MagmaObject, magmaObject } from "./objects.ts";
import { Rng } from "./random.ts";

const permutationCache = new Map<number, number[][]>();

/** Every permutation of 0..n-1, in lexicographic order. */
export function permutations(n: number): number[][] {
  const known = permutationCache.get(n);
  if (known !== undefined) return known;
  const out: number[][] = [];
  const place = (prefix: number[], rest: number[]) => {
    if (rest.length === 0) {
      out.push(prefix);
      return;
    }
    rest.forEach((value, k) => place([...prefix, value], [...rest.slice(0, k), ...rest.slice(k + 1)]));
  };
  place([], Array.from({ length: n }, (_, i) => i));
  permutationCache.set(n, out);
  return out;
}

/** The table of the magma with its elements renamed: the element `a` becomes `perm[a]`. */
export function relabel(magma: Magma, perm: readonly number[]): number[] {
  const n = magma.size;
  const out = new Array<number>(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      out[(perm[a] as number) * n + (perm[b] as number)] = perm[magma.table[a * n + b] as number] as number;
    }
  }
  return out;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** The smallest table (in lexicographic order) among all the renamings of the elements. */
export function canonicalTable(magma: Magma): number[] {
  if (magma.size > 6) throw new RangeError(`canonicalTable tries every renaming of the elements: sizes up to 6, not ${magma.size}`);
  let best = [...magma.table];
  for (const perm of permutations(magma.size)) {
    const candidate = relabel(magma, perm);
    if (compare(candidate, best) < 0) best = candidate;
  }
  return best;
}

function isCanonical(magma: Magma): boolean {
  for (const perm of permutations(magma.size)) {
    if (compare(relabel(magma, perm), magma.table) < 0) return false;
  }
  return true;
}

/** The magma in its canonical form: two magmas are isomorphic exactly when their canonical forms are equal. */
export function canonicalMagma(magma: Magma): MagmaObject {
  return magmaObject(magma.size, canonicalTable(magma));
}

/** The most elements for which `allMagmas` enumerates (there are 178 981 952 magmas of size 4). */
export const MAX_ENUMERATED_SIZE = 3;

/**
 * Every magma with `size` elements, one for each isomorphism class, in lexicographic order of the
 * canonical table. It tries all `size^(size²)` tables and keeps those that are the smallest of their
 * renamings, so it stops at size 3 (3 330 classes out of 19 683 tables); use `sampleMagmas` above.
 */
export function allMagmas(size: number): MagmaObject[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`a magma has at least one element, not ${size}`);
  if (size > MAX_ENUMERATED_SIZE) {
    throw new RangeError(`there are too many magmas of size ${size} to list; sample them with sampleMagmas, or count them with countMagmas`);
  }
  const cells = size * size;
  const total = size ** cells;
  const out: MagmaObject[] = [];
  const table = new Array<number>(cells).fill(0);
  for (let code = 0; code < total; code++) {
    let rest = code;
    for (let i = cells - 1; i >= 0; i--) {
      table[i] = rest % size;
      rest = Math.floor(rest / size);
    }
    if (isCanonical({ size, table })) out.push(magmaObject(size, table));
  }
  return out;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * The number of magmas with `size` elements up to isomorphism, by Burnside's lemma, without listing
 * them: the average over the renamings of the number of tables each one leaves unchanged. For a
 * renaming whose cycles have lengths c, a pair of cycles (p, q) splits the pairs of elements into
 * gcd(p, q) orbits of size lcm(p, q), and the product on an orbit is free to take any value on a
 * cycle whose length divides the orbit's size. 1, 10, 3 330, 178 981 952, 2 483 527 537 094 825
 * (OEIS A001329).
 */
export function countMagmas(size: number): bigint {
  if (!Number.isInteger(size) || size < 1 || size > 8) throw new RangeError(`countMagmas takes a size from 1 to 8, not ${size}`);
  let total = 0n;
  let factorial = 1n;
  for (let k = 2; k <= size; k++) factorial *= BigInt(k);
  for (const perm of permutations(size)) {
    const lengths: number[] = [];
    const seen = new Array<boolean>(size).fill(false);
    for (let start = 0; start < size; start++) {
      if (seen[start]) continue;
      let length = 0;
      for (let at = start; !seen[at]; at = perm[at] as number) {
        seen[at] = true;
        length++;
      }
      lengths.push(length);
    }
    let fixed = 1n;
    for (const p of lengths) {
      for (const q of lengths) {
        const orbit = (p * q) / gcd(p, q);
        const choices = lengths.filter((c) => orbit % c === 0).reduce((sum, c) => sum + c, 0);
        fixed *= BigInt(choices) ** BigInt(gcd(p, q));
      }
    }
    total += fixed;
  }
  return total / factorial;
}

/** How a sampled table is drawn: each favors a family of structures that a uniform draw almost never hits. */
export const SAMPLING_STRATEGIES = ["uniform", "commutative", "idempotent", "affine", "latin", "row-constant", "column-constant"] as const;
export type SamplingStrategy = (typeof SAMPLING_STRATEGIES)[number];

function draw(strategy: SamplingStrategy, n: number, rng: Rng): number[] {
  const table = new Array<number>(n * n).fill(0);
  switch (strategy) {
    case "uniform":
      for (let i = 0; i < table.length; i++) table[i] = rng.int(n);
      break;
    case "commutative":
      for (let a = 0; a < n; a++) {
        for (let b = a; b < n; b++) {
          const value = rng.int(n);
          table[a * n + b] = value;
          table[b * n + a] = value;
        }
      }
      break;
    case "idempotent":
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) table[a * n + b] = a === b ? a : rng.int(n);
      }
      break;
    case "affine": {
      // x * y = a x + b y + c, the linear models of the equational laws.
      const [a, b, c] = [rng.int(n), rng.int(n), rng.int(n)] as [number, number, number];
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) table[x * n + y] = (a * x + b * y + c) % n;
      }
      break;
    }
    case "latin": {
      // A quasigroup: the cyclic square with its rows, columns and symbols renamed.
      const [rows, columns, symbols] = [rng.permutation(n), rng.permutation(n), rng.permutation(n)] as [number[], number[], number[]];
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) table[x * n + y] = symbols[((rows[x] as number) + (columns[y] as number)) % n] as number;
      }
      break;
    }
    case "row-constant": {
      const f = Array.from({ length: n }, () => rng.int(n));
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) table[x * n + y] = f[x] as number;
      }
      break;
    }
    case "column-constant": {
      const g = Array.from({ length: n }, () => rng.int(n));
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) table[x * n + y] = g[y] as number;
      }
      break;
    }
  }
  return table;
}

/**
 * `count` magmas with `size` elements, drawn with a seeded generator, none isomorphic to another and
 * each in its canonical form. The draws rotate over `SAMPLING_STRATEGIES`, because a uniform table
 * almost never satisfies a law (about 3 500 of the 4.3 billion tables of size 4 are associative).
 * Fewer than `count` come back when the size has fewer classes than that.
 */
export function sampleMagmas(size: number, count: number, seed: number): MagmaObject[] {
  if (!Number.isInteger(size) || size < 1 || size > 6) throw new RangeError(`sampleMagmas takes a size from 1 to 6, not ${size}`);
  const rng = new Rng(seed);
  const seen = new Set<string>();
  const out: MagmaObject[] = [];
  const attempts = count * 40 + 100;
  for (let k = 0; k < attempts && out.length < count; k++) {
    const strategy = SAMPLING_STRATEGIES[k % SAMPLING_STRATEGIES.length] as SamplingStrategy;
    const canonical = canonicalMagma({ size, table: draw(strategy, size, rng) });
    if (seen.has(canonical.id)) continue;
    seen.add(canonical.id);
    out.push(canonical);
  }
  return out;
}

/** The product of two elements. */
export function product(magma: Magma, a: number, b: number): number {
  return magma.table[a * magma.size + b] as number;
}
