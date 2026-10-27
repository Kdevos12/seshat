/**
 * A seeded pseudo-random generator (mulberry32). The batteries that sample use it, so that the same
 * seed gives the same objects on every machine, and fingerprints computed at different times can be
 * compared position by position.
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** The next number, in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [0, bound). */
  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  /** A random permutation of 0..n-1 (Fisher-Yates). */
  permutation(n: number): number[] {
    const out = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const keep = out[i] as number;
      out[i] = out[j] as number;
      out[j] = keep;
    }
    return out;
  }
}
