import { clamp, clamp01 } from '../core/math';

/**
 * A dense scalar field over the square world grid. Almost every environmental
 * layer (height, moisture, nutrients, vegetation, water, fire, disease pressure)
 * is one of these, and they are sampled bilinearly by the simulation.
 */
export class Field {
  readonly data: Float32Array;
  readonly size: number;
  readonly last: number;

  constructor(size: number, init = 0) {
    this.size = size;
    this.last = size - 1;
    this.data = new Float32Array(size * size);
    if (init !== 0) this.data.fill(init);
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  get(x: number, y: number): number {
    return this.data[y * this.size + x];
  }

  set(x: number, y: number, v: number): void {
    this.data[y * this.size + x] = v;
  }

  add(x: number, y: number, v: number): void {
    this.data[y * this.size + x] += v;
  }

  /** Clamped integer cell fetch. */
  at(cx: number, cy: number): number {
    const x = cx < 0 ? 0 : cx > this.last ? this.last : cx;
    const y = cy < 0 ? 0 : cy > this.last ? this.last : cy;
    return this.data[y * this.size + x];
  }

  /** Bilinear sample in cell coordinates. */
  sample(cx: number, cy: number): number {
    const x = clamp(cx, 0, this.last - 1e-4);
    const y = clamp(cy, 0, this.last - 1e-4);
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const s = this.size;
    const d = this.data;
    const i = y0 * s + x0;
    const a = d[i];
    const b = d[i + 1];
    const c = d[i + s];
    const e = d[i + s + 1];
    const top = a + (b - a) * fx;
    const bot = c + (e - c) * fx;
    return top + (bot - top) * fy;
  }

  fill(v: number): void {
    this.data.fill(v);
  }

  /** Per-cell multiply-add of a scalar. */
  scaleAdd(mul: number, add: number): void {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = d[i] * mul + add;
  }

  clampAll(lo: number, hi: number): void {
    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      d[i] = v < lo ? lo : v > hi ? hi : v;
    }
  }

  /** Box blur in place using a scratch buffer (radius in cells). */
  blur(radius = 1, passes = 1, scratch?: Float32Array): void {
    const s = this.size;
    const d = this.data;
    const tmp = scratch ?? new Float32Array(d.length);
    for (let p = 0; p < passes; p++) {
      // horizontal
      for (let y = 0; y < s; y++) {
        const row = y * s;
        for (let x = 0; x < s; x++) {
          let sum = 0;
          let n = 0;
          for (let k = -radius; k <= radius; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= s) continue;
            sum += d[row + xx];
            n++;
          }
          tmp[row + x] = sum / n;
        }
      }
      // vertical
      for (let x = 0; x < s; x++) {
        for (let y = 0; y < s; y++) {
          let sum = 0;
          let n = 0;
          for (let k = -radius; k <= radius; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= s) continue;
            sum += tmp[yy * s + x];
            n++;
          }
          d[y * s + x] = sum / n;
        }
      }
    }
  }

  /** Separable gaussian-ish sharpen (unsharp mask) to restore detail after blur. */
  sharpen(amount: number, scratch?: Float32Array): void {
    const copy = scratch ?? new Float32Array(this.data.length);
    copy.set(this.data);
    const blurred = new Float32Array(copy.length);
    blurred.set(copy);
    const tmp = new Field(this.size);
    tmp.data.set(copy);
    tmp.blur(1, 1, blurred);
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = clamp01(copy[i] + (copy[i] - tmp.data[i]) * amount);
  }

  /** Approximate gradient (central difference, in cell units). */
  gradient(x: number, y: number, out: [number, number]): void {
    out[0] = (this.at(x + 1, y) - this.at(x - 1, y)) * 0.5;
    out[1] = (this.at(x, y + 1) - this.at(x, y - 1)) * 0.5;
  }

  /** Laplacian-ish diffusion (stability-safe explicit step). */
  diffuse(rate: number, dt: number, mask?: Uint8Array): void {
    const s = this.size;
    const d = this.data;
    const k = Math.min(0.24, rate * dt);
    const src = new Float32Array(d);
    for (let y = 1; y < s - 1; y++) {
      for (let x = 1; x < s - 1; x++) {
        const i = y * s + x;
        if (mask && !mask[i]) continue;
        const lap = src[i - 1] + src[i + 1] + src[i - s] + src[i + s] - 4 * src[i];
        d[i] = src[i] + lap * k;
      }
    }
  }

  /** Statistics helper for diagnostics and charts. */
  stats(): { min: number; max: number; mean: number } {
    const d = this.data;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, mean: sum / d.length };
  }

  serialise(): Float32Array {
    return this.data.slice();
  }

  restore(src: ArrayLike<number>): void {
    this.data.set(src as ArrayLike<number> & Float32Array);
  }
}

/** A stack of plant layers, one Field per plant lifeform. */
export class PlantFields {
  readonly layers: Field[];
  readonly count: number;

  constructor(size: number, count: number) {
    this.count = count;
    this.layers = [];
    for (let i = 0; i < count; i++) this.layers.push(new Field(size));
  }

  total(x: number, y: number): number {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.layers[i].get(x, y);
    return s;
  }

  /** Aggregate of all layers into a provided field (used for renders/census). */
  aggregateInto(out: Field): void {
    const d = out.data;
    d.fill(0);
    for (let l = 0; l < this.count; l++) {
      const src = this.layers[l].data;
      for (let i = 0; i < d.length; i++) d[i] += src[i];
    }
  }
}

/** Integer/byte field for categorical layers (biome, fire state, snow...). */
export class ByteField {
  readonly data: Uint8Array;
  readonly size: number;
  constructor(size: number, init = 0) {
    this.size = size;
    this.data = new Uint8Array(size * size);
    if (init) this.data.fill(init);
  }
  idx(x: number, y: number): number {
    return y * this.size + x;
  }
  get(x: number, y: number): number {
    return this.data[y * this.size + x];
  }
  set(x: number, y: number, v: number): void {
    this.data[y * this.size + x] = v & 255;
  }
  at(cx: number, cy: number): number {
    const x = cx < 0 ? 0 : cx > this.size - 1 ? this.size - 1 : cx;
    const y = cy < 0 ? 0 : cy > this.size - 1 ? this.size - 1 : cy;
    return this.data[y * this.size + x];
  }
}
