import type { RandomSource } from "@seshat/core";

// The seeded source and its seed hash live in the core, where the memory store's draws use them too.
export { hash32, type RandomSource, seeded } from "@seshat/core";

/** A draw from (0, 1): never 0, so that a logarithm or a power of it is defined. */
function open(random: RandomSource): number {
  let u = random();
  while (u <= 0) u = random();
  return u;
}

/** A standard normal draw (Box-Muller). */
function normal(random: RandomSource): number {
  return Math.sqrt(-2 * Math.log(open(random))) * Math.cos(2 * Math.PI * random());
}

/** A Gamma(shape, 1) draw (Marsaglia and Tsang, 2000), for any shape above 0. */
export function gamma(random: RandomSource, shape: number): number {
  if (!(shape > 0)) throw new RangeError(`the shape of a gamma draw must be above 0, got ${shape}`);
  // For a shape under 1, Gamma(a) = Gamma(a + 1) * U^(1/a).
  if (shape < 1) return gamma(random, shape + 1) * Math.pow(open(random), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = open(random);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** A Beta(alpha, beta) draw, as the share of two gamma draws. */
export function betaDraw(random: RandomSource, alpha: number, beta: number): number {
  const x = gamma(random, alpha);
  const y = gamma(random, beta);
  return x + y === 0 ? alpha / (alpha + beta) : x / (x + y);
}
