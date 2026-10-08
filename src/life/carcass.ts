import { clamp, clamp01 } from '../core/math';
import { Random } from '../core/rng';
import { SPECIES } from './species';

export interface Carcass {
  id: number;
  x: number;
  y: number;
  /** Index into SPECIES, or -1 for an unidentifiable remains. */
  speciesIdx: number;
  /** Remaining edible mass in kilograms. */
  massKg: number;
  /** Mass when it died, for the inspector and decay maths. */
  initialMassKg: number;
  /** 0 fresh → 1 skeleton → 2 gone. */
  decay: number;
  cause: string;
  /** Day it was created; used for "how long has this been here". */
  day: number;
  /** Species indices that have fed here. */
  fedBy: Set<number>;
  /** A predator remembers its kill for a while. */
  claimedBy: number | null;
}

export interface DecompositionRelease {
  cx: number;
  cy: number;
  amount: number;
}

/**
 * Dead animals. Carcasses are food for scavengers, breeding grounds for flies,
 * and — through the `onDecompose` hook — the main nutrient return path from
 * animals back into the soil.
 */
export class CarcassStore {
  readonly capacity = 320;
  private items: (Carcass | null)[] = new Array(this.capacity).fill(null);
  private free: number[] = [];
  count = 0;
  nextId = 1;
  private rng: Random;

  /** Total kilograms consumed by scavengers since the world began. */
  consumedTotal = 0;
  /** Total kilograms returned to the soil. */
  decomposedTotal = 0;

  /** Called when a carcass finishes rotting: nutrients go back to the field. */
  onDecompose: ((x: number, y: number, massKg: number, speciesIdx: number) => void) | null = null;
  /** Called when the first scavenger finds a carcass (for the history feed). */
  onScavenged: ((c: Carcass, speciesIdx: number) => void) | null = null;

  constructor(seed: string) {
    this.rng = new Random(seed + ':carcass');
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
  }

  spawn(x: number, y: number, speciesIdx: number, massKg: number, cause: string, day: number, scale = 1): Carcass | null {
    let slot = this.free.pop();
    if (slot === undefined) {
      // The most-decayed carcass makes way for a fresh one.
      let evict = -1;
      let worst = -1;
      for (let i = 0; i < this.capacity; i++) {
        const c = this.items[i];
        if (!c) continue;
        if (c.decay > worst) {
          worst = c.decay;
          evict = i;
        }
      }
      if (evict < 0) return null;
      const old = this.items[evict];
      if (old) this.onDecompose?.(old.x, old.y, old.massKg, old.speciesIdx);
      this.items[evict] = null;
      this.count--;
      slot = evict;
    }
    void scale;
    const carcass: Carcass = {
      id: this.nextId++,
      x,
      y,
      speciesIdx,
      massKg: Math.max(0.05, massKg),
      initialMassKg: Math.max(0.05, massKg),
      decay: 0,
      cause,
      day,
      fedBy: new Set<number>(),
      claimedBy: null,
    };
    this.items[slot] = carcass;
    this.count++;
    return carcass;
  }

  remove(slot: number): void {
    const c = this.items[slot];
    if (!c) return;
    this.items[slot] = null;
    this.free.push(slot);
    this.count = Math.max(0, this.count - 1);
  }

  /** The nearest carcass with meat left, within `range`. */
  nearest(x: number, y: number, range: number, requireMeat = true): Carcass | null {
    let best: Carcass | null = null;
    let bestD = range * range;
    for (const c of this.items) {
      if (!c) continue;
      if (requireMeat && c.massKg < 0.12) continue;
      const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  all(): Carcass[] {
    const out: Carcass[] = [];
    for (const c of this.items) if (c) out.push(c);
    return out;
  }

  /** Scavengers eat: returns the kilograms actually taken. */
  consume(c: Carcass, amountKg: number, speciesIdx: number): number {
    const taken = Math.min(c.massKg, amountKg);
    c.massKg -= taken;
    if (!c.fedBy.has(speciesIdx)) {
      c.fedBy.add(speciesIdx);
      this.onScavenged?.(c, speciesIdx);
    }
    this.consumedTotal += taken;
    if (c.massKg <= 0.02) {
      this.bury(c);
    }
    return taken;
  }

  private bury(c: Carcass): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.items[i] === c) {
        this.onDecompose?.(c.x, c.y, c.initialMassKg, c.speciesIdx);
        this.decomposedTotal += c.initialMassKg;
        this.remove(i);
        return;
      }
    }
  }

  /**
   * Advance decay. Warmth and rainfall speed it up; the frozen north preserves
   * bodies for months. Flies lay eggs on fresh carcasses which is why a hot
   * summer can consume a deer in a week and a cold snap can preserve it.
   */
  update(days: number, climate: { temperatureAt: (x: number, y: number) => number; rainAt: (x: number, y: number) => number }): { x: number; y: number; amount: number }[] {
    const leached: { x: number; y: number; amount: number }[] = [];
    const rate = clamp01(days / 30);
    for (let i = 0; i < this.capacity; i++) {
      const c = this.items[i];
      if (!c) continue;
      const temp = climate.temperatureAt(c.x, c.y);
      const rain = climate.rainAt(c.x, c.y);
      // Decomposition is strongly temperature dependent (roughly Q10 = 2).
      const tempFactor = clamp(0.12 + Math.max(0, temp + 4) * 0.085, 0.08, 2.4);
      const decay = rate * (0.35 + tempFactor) * (0.6 + rain * 0.8);
      c.decay += decay;
      if (c.massKg > 0.02) {
        // Mass is lost to scavenging insects and microbes whether or not a
        // large animal finds it.
        const loss = c.massKg * (decay * 0.28);
        c.massKg -= loss;
        leached.push({ x: c.x, y: c.y, amount: loss * 0.3 });
        if (c.massKg <= 0.02) c.massKg = 0;
      }
      if (c.decay >= 2 || (c.decay > 1 && c.massKg <= 0.02)) {
        this.onDecompose?.(c.x, c.y, c.initialMassKg, c.speciesIdx);
        this.decomposedTotal += c.initialMassKg * 0.5;
        this.remove(i);
      }
    }
    return leached;
  }

  /** Fly and beetle activity around a carcass — attracts scavengers and is visible. */
  carrionActivityAt(x: number, y: number, radius = 20): number {
    let total = 0;
    for (const c of this.items) {
      if (!c || c.massKg < 0.05) continue;
      const d = Math.hypot(c.x - x, c.y - y);
      if (d > radius) continue;
      total += clamp01(1 - d / radius) * clamp01(c.massKg / 30) * clamp01(1 - c.decay / 2);
    }
    return clamp01(total);
  }

  save(): Record<string, unknown> {
    const list: unknown[] = [];
    for (const c of this.items) {
      if (!c) continue;
      list.push({
        id: c.id,
        x: c.x,
        y: c.y,
        s: c.speciesIdx,
        m: c.massKg,
        im: c.initialMassKg,
        d: c.decay,
        cause: c.cause,
        day: c.day,
        fed: Array.from(c.fedBy),
        claimed: c.claimedBy,
      });
    }
    return { nextId: this.nextId, items: list, consumed: this.consumedTotal, decomposed: this.decomposedTotal };
  }

  load(d: Record<string, any>): void {
    this.items = new Array(this.capacity).fill(null);
    this.free = [];
    this.count = 0;
    this.nextId = d.nextId ?? 1;
    this.consumedTotal = d.consumed ?? 0;
    this.decomposedTotal = d.decomposed ?? 0;
    for (const raw of d.items ?? []) {
      const slot = this.free.pop();
      if (slot === undefined) break;
      this.items[slot] = {
        id: raw.id,
        x: raw.x,
        y: raw.y,
        speciesIdx: raw.s,
        massKg: raw.m,
        initialMassKg: raw.im,
        decay: raw.d,
        cause: raw.cause,
        day: raw.day,
        fedBy: new Set<number>(raw.fed ?? []),
        claimedBy: raw.claimed ?? null,
      };
      this.count++;
    }
    for (let i = this.capacity - 1; i >= 0; i--) {
      if (!this.items[i] && !this.free.includes(i) && this.free.length + this.count < this.capacity) this.free.push(i);
    }
  }

  /** Human-readable summary for an inspector panel. */
  describe(c: Carcass): string {
    const sp = c.speciesIdx >= 0 ? SPECIES[c.speciesIdx] : null;
    const who = sp ? sp.name.toLowerCase() : 'unidentified animal';
    const state = c.decay < 0.3 ? 'fresh' : c.decay < 0.8 ? 'partly eaten' : c.decay < 1.4 ? 'rotting' : 'skeletal';
    return `Remains of a ${who} — ${state}, ${c.massKg.toFixed(1)} kg left. Died of ${c.cause}.`;
  }
}
