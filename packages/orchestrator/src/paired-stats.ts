/**
 * The statistics of the paired protocol (plan change CA2), written by hand: no dependency.
 */

/** The Wilson score interval of `successes` out of `n` (default 95%, z = 1.96). `n` = 0 gives [0, 1]. */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * The exact two-sided McNemar test: under the null the `b + c` discordant pairs split as a fair coin, so
 * p = min(1, 2 P(X <= min(b, c))) for X binomial (b + c, 1/2). No discordant pair gives p = 1.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let term = 1;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) term = (term * (n - i + 1)) / i;
    sum += term;
  }
  return Math.min(1, (2 * sum) / 2 ** n);
}
