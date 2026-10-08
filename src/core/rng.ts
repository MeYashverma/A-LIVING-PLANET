/**
 * Seeded pseudo-randomness. Every stochastic process in the simulation runs
 * through a Random stream so that (seed + settings) reproduces a world.
 *
 * sfc32 is fast, has a long period, and passes smallcrush-class statistical
 * tests — good enough for both generation and simulation.
 */

export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    // splitmix-style expansion of the seed into 4 words
    let x = s ^ 0x9e3779b9;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform float in [0,1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) >>> 0;
    t = (t + this.d) >>> 0;
    this.c = (this.c + t) >>> 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform float in [min,max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min,max]. */
  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal (Box–Muller, cached). */
  private spare = 0;
  private hasSpare = false;
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    this.hasSpare = true;
    return u * m;
  }

  /** Normal-ish value clamped to [lo,hi]. */
  gaussRange(mean: number, sd: number, lo = -Infinity, hi = Infinity): number {
    return Math.min(hi, Math.max(lo, mean + this.gauss() * sd));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted pick from parallel arrays. Returns index. */
  weightedIndex(weights: ArrayLike<number>, total?: number): number {
    const n = weights.length;
    let sum = total ?? 0;
    if (total === undefined) {
      for (let i = 0; i < n; i++) sum += weights[i];
    }
    if (sum <= 0) return Math.floor(this.next() * n);
    let r = this.next() * sum;
    for (let i = 0; i < n; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return n - 1;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Fork a new independent stream (stable across serialisation). */
  fork(salt = 0): Random {
    return new Random((Math.floor(this.next() * 0xffffffff) ^ Math.imul(salt + 1, 2654435761)) >>> 0);
  }

  saveState(): number[] {
    return [this.a, this.b, this.c, this.d];
  }

  loadState(s: ArrayLike<number>): void {
    this.a = s[0] >>> 0;
    this.b = s[1] >>> 0;
    this.c = s[2] >>> 0;
    this.d = s[3] >>> 0;
  }
}

/* ------------------------------------------------------------------ *
 * Value/simplex noise — used for terrain, moisture, cloud and texture
 * fields. Pure functions of (x, y, seed) so worlds are reproducible.
 * ------------------------------------------------------------------ */

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 2D value-gradient noise in [-1,1], seeded. */
export class Noise2D {
  private perm: Uint8Array;

  constructor(seed: number) {
    const rng = new Random(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private static grad(hash: number, x: number, y: number): number {
    switch (hash & 7) {
      case 0:
        return x + y;
      case 1:
        return x - y;
      case 2:
        return -x + y;
      case 3:
        return -x - y;
      case 4:
        return x;
      case 5:
        return -x;
      case 6:
        return y;
      default:
        return -y;
    }
  }

  /** Perlin-style gradient noise, roughly [-1,1]. */
  noise(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    const x1 = lerp(Noise2D.grad(aa, xf, yf), Noise2D.grad(ba, xf - 1, yf), u);
    const x2 = lerp(Noise2D.grad(ab, xf, yf - 1), Noise2D.grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /** Fractal brownian motion. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — good for mountain ranges. */
  ridged(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Warped fbm — breaks up the "blobby" look of plain fbm. */
  warped(x: number, y: number, warp = 0.6, octaves = 5): number {
    const wx = x + warp * this.noise(x * 1.7 + 11.3, y * 1.7 - 5.2);
    const wy = y + warp * this.noise(x * 1.7 - 7.1, y * 1.7 + 3.9);
    return this.fbm(wx, wy, octaves);
  }
}
