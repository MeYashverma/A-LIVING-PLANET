/** Small math helpers used all over the simulation. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export function angleLerp(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Normalize a 2D vector in place-ish (returns new values via out array). */
export function norm2(x: number, y: number, out: [number, number]): void {
  const l = Math.sqrt(x * x + y * y);
  if (l < 1e-6) {
    out[0] = 0;
    out[1] = 0;
  } else {
    out[0] = x / l;
    out[1] = y / l;
  }
}

/** A tiny 2-component mutable vector, allocation-free when reused. */
export class Vec2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  add(x: number, y: number): this {
    this.x += x;
    this.y += y;
    return this;
  }
  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }
  get length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
  normalize(): this {
    const l = this.length;
    if (l > 1e-6) {
      this.x /= l;
      this.y /= l;
    }
    return this;
  }
  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }
}

/** Stable hash of a position → [0,1). Used for deterministic jitter. */
export function posHash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Simple running statistics used for population/trait charts. */
export class RunningStats {
  count = 0;
  mean = 0;
  m2 = 0;
  min = Infinity;
  max = -Infinity;

  push(v: number): void {
    this.count++;
    const d = v - this.mean;
    this.mean += d / this.count;
    this.m2 += d * (v - this.mean);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }
  get variance(): number {
    return this.count > 1 ? this.m2 / (this.count - 1) : 0;
  }
  get sd(): number {
    return Math.sqrt(this.variance);
  }
  reset(): void {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }
}

/** Shannon evenness for biodiversity reporting. */
export function shannonEvenness(counts: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < counts.length; i++) total += counts[i];
  if (total <= 0) return 0;
  let h = 0;
  let rich = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] <= 0) continue;
    rich++;
    const p = counts[i] / total;
    h -= p * Math.log(p);
  }
  if (rich <= 1) return 0;
  return h / Math.log(rich);
}

export function sum(arr: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

export function mean(arr: ArrayLike<number>): number {
  return arr.length ? sum(arr) / arr.length : 0;
}

/** Format helpers for the UI. */
export function fmtPct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtNum(v: number, digits = 0): string {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtSigned(v: number, digits = 0): string {
  const s = fmtNum(Math.abs(v), digits);
  return `${v >= 0 ? '+' : '−'}${s}`;
}
