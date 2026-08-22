/* A seeded random source with the handful of methods the engine asks for.
 *
 * Seeded because a performance has to be reproducible: the same seed must give
 * the same piece, which is the only reproducibility a live-only player needs.
 * `Math.random` cannot do that, so the generator is explicit and carries its
 * own state.
 *
 * mulberry32: one 32-bit word of state, good equidistribution, and short
 * enough to read. Nothing here is cryptographic and nothing needs to be.
 */
export class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 1;
  }

  random() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* Inclusive at both ends, matching the engine's original semantics. */
  randint(lo, hi) {
    return lo + Math.floor(this.random() * (hi - lo + 1));
  }

  choice(seq) {
    return seq[Math.floor(this.random() * seq.length)];
  }

  /* One weighted pick. Cumulative weights, so a weight of 0 is never chosen. */
  choices(seq, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.random() * total;
    for (let i = 0; i < seq.length; i++) {
      r -= weights[i];
      if (r < 0) return seq[i];
    }
    return seq[seq.length - 1];
  }

  /* Box-Muller. The second normal it produces is discarded rather than cached:
     a cache would make the value you get depend on how many gauss() calls came
     before, which is a surprising thing for a seeded generator to do. */
  gauss(mu, sigma) {
    let u = this.random();
    if (u < 1e-12) u = 1e-12;
    const v = this.random();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/* Round half to even. Half-up would bias every exact .5 upward, and the grid
   arithmetic lands on .5 often enough for that to show as a rhythmic lean. */
export function round(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/* Non-negative modulo. The engine folds intervals with `% 12` and needs a
   result that is never negative; the native operator can be. */
export function mod(n, m) {
  return ((n % m) + m) % m;
}
