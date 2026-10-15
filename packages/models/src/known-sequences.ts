/**
 * A table of well-known integer sequences, shipped with the package so that a sequence can be
 * recognized without a network. Each has the OEIS number it carries, its name, its offset (the index
 * of its first term) and its first terms. The terms of a sequence given by a formula or a recurrence
 * are computed here, with exact integers; the few that no formula gives (the numbers of groups, of
 * graphs, of magmas) are written out, and the tests check them against the package's own
 * enumerations wherever it can enumerate them.
 */
export interface KnownSequence {
  /** `A000045`. */
  id: string;
  name: string;
  /** The index of the first term. */
  offset: number;
  terms: readonly bigint[];
}

const big = (values: readonly number[]): bigint[] => values.map((v) => BigInt(v));
const upTo = (count: number, f: (n: number) => bigint): bigint[] => Array.from({ length: count }, (_, n) => f(n));

function recurrence(count: number, start: readonly bigint[], next: (previous: readonly bigint[], n: number) => bigint): bigint[] {
  const out = [...start];
  while (out.length < count) out.push(next(out, out.length));
  return out.slice(0, count);
}

const factorial = (n: number): bigint => (n <= 1 ? 1n : BigInt(n) * factorial(n - 1));
function binomial(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  for (let i = 1; i <= k; i++) result = (result * BigInt(n - k + i)) / BigInt(i);
  return result;
}

/** The integers 1..count, for the sequences of arithmetic functions. */
const naturals = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

function primesBelow(limit: number): number[] {
  const sieve = new Uint8Array(limit + 1).fill(1);
  const out: number[] = [];
  for (let i = 2; i <= limit; i++) {
    if (sieve[i] === 1) {
      out.push(i);
      for (let j = i * i; j <= limit; j += i) sieve[j] = 0;
    }
  }
  return out;
}

/** The prime factorization of n as [prime, exponent] pairs. */
function factorize(n: number): Array<[number, number]> {
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

const isSquarefree = (n: number) => factorize(n).every(([, e]) => e === 1);
const bigOmega = (n: number) => factorize(n).reduce((s, [, e]) => s + e, 0);

function partitions(count: number, distinct: boolean): bigint[] {
  const ways: bigint[] = Array.from({ length: count }, (_, i) => (i === 0 ? 1n : 0n));
  for (let part = 1; part < count; part++) {
    if (distinct) for (let total = count - 1; total >= part; total--) ways[total] = (ways[total] as bigint) + (ways[total - part] as bigint);
    else for (let total = part; total < count; total++) ways[total] = (ways[total] as bigint) + (ways[total - part] as bigint);
  }
  return ways;
}

function bellNumbers(count: number): bigint[] {
  // The Bell triangle: each row starts with the last entry of the row before.
  const out: bigint[] = [1n];
  let row: bigint[] = [1n];
  while (out.length < count) {
    const next: bigint[] = [row[row.length - 1] as bigint];
    for (const value of row) next.push((next[next.length - 1] as bigint) + value);
    out.push(next[0] as bigint);
    row = next;
  }
  return out;
}

/** The triangle of Stirling numbers of the second kind, read by rows (n >= 1, 1 <= k <= n). */
function stirling2Rows(rows: number): bigint[] {
  const table: bigint[][] = [[]];
  const out: bigint[] = [];
  for (let n = 1; n <= rows; n++) {
    const row: bigint[] = [];
    for (let k = 1; k <= n; k++) {
      const above = table[n - 1] ?? [];
      row.push(BigInt(k) * (above[k - 1] ?? 0n) + (k === 1 ? (n === 1 ? 1n : 0n) : (above[k - 2] ?? 0n)));
    }
    table.push(row);
    out.push(...row);
  }
  return out;
}

function pascalRows(rows: number): bigint[] {
  return Array.from({ length: rows }, (_, n) => Array.from({ length: n + 1 }, (_, k) => binomial(n, k))).flat();
}

/** floor(sqrt(n)) for a BigInt. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** The first `count` decimal digits of a real number given as floor(value * 10^(count - 1)). */
const digitsOf = (scaled: bigint, count: number): bigint[] => [...scaled.toString()].slice(0, count).map((d) => BigInt(d));

function piDigits(count: number): bigint[] {
  const scale = 10n ** BigInt(count + 10);
  // Machin: pi = 16 arctan(1/5) - 4 arctan(1/239), arctan(1/x) = sum (-1)^k / ((2k+1) x^(2k+1)).
  const arctanInverse = (x: bigint): bigint => {
    let term = scale / x;
    let sum = term;
    for (let k = 1n; term !== 0n; k++) {
      term /= x * x;
      sum += (k % 2n === 0n ? 1n : -1n) * (term / (2n * k + 1n));
    }
    return sum;
  };
  const pi = 16n * arctanInverse(5n) - 4n * arctanInverse(239n);
  return digitsOf(pi / 10n ** 10n, count);
}

function eDigits(count: number): bigint[] {
  const scale = 10n ** BigInt(count + 10);
  let term = scale;
  let sum = 0n;
  for (let k = 0n; term !== 0n; k++) {
    sum += term;
    term /= k + 1n;
  }
  return digitsOf(sum / 10n ** 10n, count);
}

const sqrtDigits = (n: bigint, count: number): bigint[] => digitsOf(isqrt(n * 10n ** BigInt(2 * (count - 1))), count);

function goldenRatioDigits(count: number): bigint[] {
  // (1 + sqrt 5) / 2 = (10^(count-1) + sqrt(5 * 10^(2 (count - 1)))) / 2, up to the last digit.
  const scale = 10n ** BigInt(count - 1);
  return digitsOf((scale + isqrt(5n * scale * scale)) / 2n, count);
}

const isPalindrome = (n: number) => String(n) === [...String(n)].reverse().join("");

function build(): KnownSequence[] {
  const primes = primesBelow(400);
  const nat = naturals(60);
  const seq = (id: string, name: string, offset: number, terms: readonly bigint[]): KnownSequence => ({ id, name, offset, terms });
  return [
    seq("A000004", "The zero sequence.", 0, upTo(30, () => 0n)),
    seq("A000012", "The simplest sequence of positive numbers: the all 1's sequence.", 0, upTo(30, () => 1n)),
    seq("A000027", "The positive integers.", 1, upTo(60, (n) => BigInt(n + 1))),
    seq("A001477", "The nonnegative integers.", 0, upTo(60, (n) => BigInt(n))),
    seq("A005843", "The even numbers: a(n) = 2n.", 0, upTo(60, (n) => BigInt(2 * n))),
    seq("A005408", "The odd numbers: a(n) = 2n+1.", 0, upTo(60, (n) => BigInt(2 * n + 1))),
    seq("A000290", "The squares: a(n) = n^2.", 0, upTo(60, (n) => BigInt(n * n))),
    seq("A000578", "The cubes: a(n) = n^3.", 0, upTo(60, (n) => BigInt(n) ** 3n)),
    seq("A000217", "Triangular numbers: a(n) = binomial(n+1,2) = n(n+1)/2.", 0, upTo(60, (n) => BigInt((n * (n + 1)) / 2))),
    seq("A000292", "Tetrahedral numbers: a(n) = C(n+2,3) = n(n+1)(n+2)/6.", 0, upTo(60, (n) => binomial(n + 2, 3))),
    seq("A000330", "Square pyramidal numbers: a(n) = 0^2 + 1^2 + 2^2 + ... + n^2 = n(n+1)(2n+1)/6.", 0, upTo(60, (n) => BigInt((n * (n + 1) * (2 * n + 1)) / 6))),
    seq("A000326", "Pentagonal numbers: a(n) = n(3n-1)/2.", 0, upTo(60, (n) => BigInt((n * (3 * n - 1)) / 2))),
    seq("A000384", "Hexagonal numbers: a(n) = n(2n-1).", 0, upTo(60, (n) => BigInt(n * (2 * n - 1)))),
    seq("A000124", "Central polygonal numbers (the Lazy Caterer's sequence): n(n+1)/2 + 1.", 0, upTo(60, (n) => BigInt((n * (n + 1)) / 2 + 1))),
    seq("A000079", "Powers of 2: a(n) = 2^n.", 0, upTo(70, (n) => 2n ** BigInt(n))),
    seq("A000244", "Powers of 3: a(n) = 3^n.", 0, upTo(50, (n) => 3n ** BigInt(n))),
    seq("A000302", "Powers of 4: a(n) = 4^n.", 0, upTo(40, (n) => 4n ** BigInt(n))),
    seq("A000225", "a(n) = 2^n - 1. (Sometimes called Mersenne numbers, although that name is usually reserved for A001348.)", 0, upTo(70, (n) => 2n ** BigInt(n) - 1n)),
    seq("A001045", "Jacobsthal sequence (or Jacobsthal numbers): a(n) = a(n-1) + 2*a(n-2), with a(0) = 0, a(1) = 1.", 0, recurrence(60, [0n, 1n], (a, n) => (a[n - 1] as bigint) + 2n * (a[n - 2] as bigint))),
    seq("A000045", "Fibonacci numbers: F(n) = F(n-1) + F(n-2) with F(0) = 0 and F(1) = 1.", 0, recurrence(90, [0n, 1n], (a, n) => (a[n - 1] as bigint) + (a[n - 2] as bigint))),
    seq("A000032", "Lucas numbers beginning at 2: L(n) = L(n-1) + L(n-2), L(0) = 2, L(1) = 1.", 0, recurrence(80, [2n, 1n], (a, n) => (a[n - 1] as bigint) + (a[n - 2] as bigint))),
    seq("A000073", "Tribonacci numbers: a(n) = a(n-1) + a(n-2) + a(n-3) for n >= 3 with a(0) = a(1) = 0 and a(2) = 1.", 0, recurrence(60, [0n, 0n, 1n], (a, n) => (a[n - 1] as bigint) + (a[n - 2] as bigint) + (a[n - 3] as bigint))),
    seq("A000142", "Factorial numbers: n! = 1*2*3*4*...*n (order of symmetric group S_n, number of permutations of n letters).", 0, upTo(30, factorial)),
    seq("A000108", "Catalan numbers: C(n) = binomial(2n,n)/(n+1) = (2n)!/(n!(n+1)!).", 0, upTo(30, (n) => binomial(2 * n, n) / BigInt(n + 1))),
    seq("A000984", "Central binomial coefficients: binomial(2*n,n) = (2*n)!/(n!)^2.", 0, upTo(30, (n) => binomial(2 * n, n))),
    seq("A000110", "Bell or exponential numbers: number of ways to partition a set of n labeled elements.", 0, bellNumbers(25)),
    seq("A000041", "a(n) is the number of partitions of n (the partition numbers).", 0, partitions(60, false)),
    seq("A000009", "Expansion of Product_{m >= 1} (1 + x^m); number of partitions of n into distinct parts; number of partitions of n into odd parts.", 0, partitions(60, true)),
    seq("A000085", "Number of self-inverse permutations on n letters, also known as involutions; number of standard Young tableaux with n cells.", 0, recurrence(25, [1n, 1n], (a, n) => (a[n - 1] as bigint) + BigInt(n - 1) * (a[n - 2] as bigint))),
    seq("A000670", "Fubini numbers: number of preferential arrangements of n labeled elements; or number of weak orders on n labeled elements.", 0, recurrence(20, [1n], (a, n) => Array.from({ length: n }, (_, j) => binomial(n, j + 1) * (a[n - j - 1] as bigint)).reduce((s, v) => s + v, 0n))),
    seq("A001006", "Motzkin numbers: number of ways of drawing any number of nonintersecting chords joining n (labeled) points on a circle.", 0, recurrence(30, [1n, 1n], (a, n) => (BigInt(2 * n + 1) * (a[n - 1] as bigint) + BigInt(3 * n - 3) * (a[n - 2] as bigint)) / BigInt(n + 2))),
    seq("A001147", "Double factorial of odd numbers: a(n) = (2*n-1)!! = 1*3*5*...*(2*n-1).", 0, recurrence(20, [1n], (a, n) => BigInt(2 * n - 1) * (a[n - 1] as bigint))),
    seq("A000165", "Double factorial of even numbers: (2n)!! = 2^n*n!.", 0, recurrence(20, [1n], (a, n) => BigInt(2 * n) * (a[n - 1] as bigint))),
    seq("A000272", "Number of trees on n labeled nodes: n^(n-2) with a(0)=1.", 0, upTo(20, (n) => (n === 0 ? 1n : n === 1 ? 1n : BigInt(n) ** BigInt(n - 2)))),
    seq("A000312", "Number of labeled mappings from n points to themselves (endofunctions): n^n.", 0, upTo(20, (n) => BigInt(n) ** BigInt(n))),
    seq("A002416", "2^(n^2): number of binary relations on n labeled points.", 0, upTo(8, (n) => 2n ** BigInt(n * n))),
    seq("A006125", "a(n) = 2^(n(n-1)/2): number of labeled graphs on n nodes.", 0, upTo(12, (n) => 2n ** BigInt((n * (n - 1)) / 2))),
    seq("A000010", "Euler totient function phi(n): count numbers <= n and prime to n.", 1, nat.map((n) => BigInt(factorize(n).reduce((phi, [p]) => (phi / p) * (p - 1), n)))),
    seq("A000005", "d(n) (also called tau(n) or sigma_0(n)), the number of divisors of n.", 1, nat.map((n) => BigInt(factorize(n).reduce((d, [, e]) => d * (e + 1), 1)))),
    seq("A000203", "a(n) = sigma(n), the sum of the divisors of n. Also called sigma_1(n).", 1, nat.map((n) => BigInt(factorize(n).reduce((s, [p, e]) => s * ((p ** (e + 1) - 1) / (p - 1)), 1)))),
    seq("A001222", "Number of prime divisors of n counted with multiplicity (also called bigomega(n) or Omega(n)).", 1, nat.map((n) => BigInt(bigOmega(n)))),
    seq("A001221", "Number of distinct primes dividing n (also called omega(n)).", 1, nat.map((n) => BigInt(factorize(n).length))),
    seq("A008683", "Moebius (or Mobius) function mu(n).", 1, nat.map((n) => BigInt(isSquarefree(n) ? (factorize(n).length % 2 === 0 ? 1 : -1) : 0))),
    seq("A000040", "The prime numbers.", 1, big(primes.slice(0, 70))),
    seq("A000720", "pi(n), the number of primes <= n.", 1, nat.map((n) => BigInt(primes.filter((p) => p <= n).length))),
    seq("A002808", "The composite numbers: numbers n of the form x*y for x > 1 and y > 1.", 1, big(Array.from({ length: 80 }, (_, i) => i + 4).filter((n) => factorize(n).length > 1 || (factorize(n)[0]?.[1] ?? 0) > 1).slice(0, 60))),
    seq("A005117", "Squarefree numbers: numbers that are not divisible by a square greater than 1.", 1, big(naturals(120).filter(isSquarefree).slice(0, 60))),
    seq("A001358", "Semiprimes (or biprimes): products of two primes.", 1, big(naturals(200).filter((n) => bigOmega(n) === 2).slice(0, 50))),
    seq("A000961", "Powers of primes. Alternatively, 1 and the prime powers (p^k, p prime, k >= 1).", 1, big(naturals(200).filter((n) => n === 1 || factorize(n).length === 1).slice(0, 60))),
    seq("A000396", "Perfect numbers n: n is equal to the sum of the proper divisors of n.", 1, [6n, 28n, 496n, 8128n, 33550336n, 8589869056n]),
    seq("A002113", "Palindromes in base 10.", 1, big(Array.from({ length: 400 }, (_, i) => i).filter(isPalindrome).slice(0, 50))),
    seq("A007318", "Pascal's triangle read by rows: C(n,k) = binomial(n,k) = n!/(k!*(n-k)!), 0 <= k <= n.", 0, pascalRows(12)),
    seq("A008277", "Triangle of Stirling numbers of the second kind, S2(n,k), n >= 1, 1 <= k <= n.", 1, stirling2Rows(10)),
    seq("A000796", "Decimal expansion of Pi (or digits of Pi).", 1, piDigits(60)),
    seq("A001113", "Decimal expansion of e.", 1, eDigits(60)),
    seq("A002193", "Decimal expansion of square root of 2.", 1, sqrtDigits(2n, 60)),
    seq("A001622", "Decimal expansion of golden ratio phi (or tau) = (1 + sqrt(5))/2.", 1, goldenRatioDigits(60)),
    // Counts of structures. Where the package can enumerate them its tests compare (documentation/models.md).
    seq("A000001", "Number of groups of order n.", 0, big([0, 1, 1, 1, 2, 1, 2, 1, 5, 2, 2, 1, 5, 1, 2, 1, 14, 1, 5, 1, 5, 2, 2, 1, 15, 2, 2, 5, 4, 1, 4, 1, 51])),
    seq("A000088", "Number of graphs on n unlabeled nodes.", 0, big([1, 1, 2, 4, 11, 34, 156, 1044, 12346, 274668, 12005168])),
    seq("A001349", "Number of connected graphs with n nodes.", 0, big([1, 1, 1, 2, 6, 21, 112, 853, 11117, 261080, 11716571])),
    seq("A000055", "Number of trees with n unlabeled nodes.", 0, big([1, 1, 1, 1, 2, 3, 6, 11, 23, 47, 106, 235, 551, 1301, 3159, 7741, 19320, 48629, 123867, 317955])),
    seq("A000595", "Number of binary relations on n unlabeled points.", 0, big([1, 2, 10, 104, 3044, 291968])),
    seq("A001329", "Number of groupoids (or magmas) with n elements up to isomorphism.", 1, [1n, 10n, 3330n, 178981952n, 2483527537094825n]),
    seq("A027851", "Number of nonisomorphic semigroups of order n.", 1, big([1, 5, 24, 188, 1915, 28634])),
    seq("A001426", "Number of commutative semigroups of order n up to isomorphism.", 1, big([1, 3, 12, 58, 325, 2143])),
  ];
}

let table: readonly KnownSequence[] | undefined;

/** The known sequences, in the order of the table: the more basic sequences first. */
export function knownSequences(): readonly KnownSequence[] {
  table ??= build();
  return table;
}
