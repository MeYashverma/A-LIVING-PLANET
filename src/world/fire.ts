import { Random } from '../core/rng';
import { clamp, clamp01, lerp } from '../core/math';
import { FIRE } from '../core/config';
import { Field } from './fields';
import type { Terrain } from './terrain';
import type { Climate } from './climate';
import type { Vegetation } from './vegetation';
import type { Forest } from './trees';

export interface FireReport {
  ignited: boolean;
  cellsBurned: number;
  treesLost: number;
  peakArea: number;
  extinguished: boolean;
  x: number;
  y: number;
}

/**
 * Wildfire: a per-cell intensity field that spreads with the wind, consumes
 * vegetation and litter as fuel, kills trees, releases ash nutrients and leaves
 * a burn scar that slowly fades into the landscape.
 */
export class Fire {
  terrain: Terrain;
  climate: Climate;
  vegetation: Vegetation;
  forest: Forest;

  /** 0..1+ current flame intensity per cell. */
  intensity: Field;
  /** Perceived heat for rendering (smoothed). */
  heat: Field;
  /** Burn scar: 1 = freshly burned, decays over months. */
  scar: Field;
  /** Smoke column strength per coarse region (for rendering/audio). */
  smoke = 0;

  activeCells = 0;
  totalCellsBurned = 0;
  totalTreesLost = 0;
  /** Currently burning fire complexes, for history and camera framing. */
  fronts: { cx: number; cy: number; x: number; y: number; area: number }[] = [];

  private rng: Random;
  private active: number[] = [];
  private nextScan = 0;

  constructor(terrain: Terrain, climate: Climate, vegetation: Vegetation, forest: Forest, seed: string) {
    this.terrain = terrain;
    this.climate = climate;
    this.vegetation = vegetation;
    this.forest = forest;
    this.intensity = new Field(terrain.size);
    this.heat = new Field(terrain.size);
    this.scar = new Field(terrain.size);
    this.rng = new Random(seed + ':fire');
  }

  /** Lightning hit: may start a fire if it is dry enough. */
  strike(cx: number, cy: number): boolean {
    const t = this.terrain;
    if (cx < 1 || cy < 1 || cx >= t.size - 1 || cy >= t.size - 1) return false;
    const moisture = t.soilMoisture.at(cx, cy);
    const dry = clamp01(1 - moisture / FIRE.moistureCutoff);
    const fuel = this.vegetation.fuelAt(cx, cy);
    if (fuel < FIRE.fuelThreshold || dry < 0.35) return false;
    if (!this.rng.chance(0.22 + dry * 0.5)) return false;
    this.ignite(cx, cy, 0.6 + dry * 0.5);
    return true;
  }

  ignite(cx: number, cy: number, strength = 1): void {
    const t = this.terrain;
    if (cx < 1 || cy < 1 || cx >= t.size - 1 || cy >= t.size - 1) return;
    const i = cy * t.size + cx;
    if (this.intensity.data[i] > 0.01) {
      this.intensity.data[i] = Math.max(this.intensity.data[i], strength);
      return;
    }
    this.intensity.data[i] = Math.max(this.intensity.data[i], strength);
    this.active.push(i);
  }

  /** Fire heat 0..1 at world coordinates (used by animals and rendering). */
  heatAt(x: number, y: number): number {
    return this.heat.at(
      clamp(Math.round(this.terrain.worldToCellX(x)), 0, this.terrain.last),
      clamp(Math.round(this.terrain.worldToCellY(y)), 0, this.terrain.last),
    );
  }

  update(dtMinutes: number, moistureField: Float32Array): void {
    const t = this.terrain;
    const n = t.size;
    const hours = dtMinutes / 60;
    const inten = this.intensity.data;
    const heat = this.heat.data;
    const scar = this.scar.data;
    const rainMean = this.climate.rainIntensity.stats().mean;
    const wind = this.climate.windSpeed;
    const windDir = this.climate.windDirection;

    // Decay the scar very slowly (months) unless plants reclaim the ground.
    if (this.nextScan <= 0) {
      const decay = clamp01(hours * 0.00012);
      for (let i = 0; i < scar.length; i++) {
        if (scar[i] > 0) scar[i] = Math.max(0, scar[i] - decay * (1 + this.vegetation.fuelAt(i % n, (i / n) | 0) * 3));
      }
      this.nextScan = 20;
    }
    this.nextScan -= 1;

    let burned = 0;
    let treesLost = 0;
    const newActive: number[] = [];
    const windX = Math.cos(windDir);
    const windY = Math.sin(windDir);

    for (const i of this.active) {
      let f = inten[i];
      if (f <= 0.01) {
        inten[i] = 0;
        continue;
      }
      const cx = i % n;
      const cy = (i / n) | 0;
      const moisture = moistureField[i];
      const fuel = this.vegetation.fuelAt(cx, cy);
      const dry = clamp01(1 - moisture / (FIRE.moistureCutoff * 1.6));

      // Extinguish when there is nothing left to burn or rain arrives.
      if (fuel < FIRE.fuelThreshold * 0.5 || rainMean > 1.1) {
        inten[i] = Math.max(0, f - hours * 0.8);
        if (inten[i] < 0.02) {
          inten[i] = 0;
          continue;
        }
      }

      // Consume fuel.
      const consumeRate = clamp01(FIRE.burnRate * hours * (0.4 + dry) * (0.4 + f * 0.6));
      const eaten = this.vegetation.burn(cx, cy, consumeRate);
      burned += eaten;
      if (eaten > 0.05) treesLost += this.forest.burnTreesAt(cx, cy, clamp01(f));
      scar[i] = clamp01(scar[i] + consumeRate * 1.6);
      heat[i] = Math.min(1.4, heat[i] + hours * 2.2 * f);
      this.totalCellsBurned++;

      // Spread to neighbours: downwind and uphill burns faster.
      const spreadBase = FIRE.spreadRate * hours * (0.35 + dry * 1.3) * clamp01(f) * clamp01(fuel * 2);
      for (let d = 0; d < 8; d++) {
        const dx = d === 0 ? 1 : d === 1 ? -1 : d === 2 ? 0 : d === 3 ? 0 : d === 4 ? 1 : d === 5 ? 1 : d === 6 ? -1 : -1;
        const dy = d === 0 ? 0 : d === 1 ? 0 : d === 2 ? 1 : d === 3 ? -1 : d === 4 ? 1 : d === 5 ? -1 : d === 6 ? 1 : -1;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 1 || ny < 1 || nx >= n - 1 || ny >= n - 1) continue;
        const j = ny * n + nx;
        if (inten[j] > 0.01) continue;
        const nFuel = this.vegetation.fuelAt(nx, ny);
        if (nFuel < FIRE.fuelThreshold) continue;
        const nMoist = moistureField[j];
        const nDry = clamp01(1 - nMoist / FIRE.moistureCutoff);
        if (nDry <= 0) continue;
        // Wind alignment: fire spreads fastest in the direction the wind blows.
        const dot = (dx * windX + dy * windY) / Math.hypot(dx, dy);
        const windFactor = 1 + Math.max(0, dot) * FIRE.windBoost * clamp01(wind / 1.6);
        // Uphill spread.
        const rise = t.height.data[j] - t.height.data[i];
        const slopeFactor = 1 + Math.max(0, rise) * 22;
        const p = spreadBase * nFuel * nDry * windFactor * slopeFactor * (d >= 4 ? 0.55 : 1);
        if (this.rng.next() < p) this.ignite(nx, ny, clamp01(f * 0.85 + 0.25));
      }

      // The fire front advances; strong fronts outrun their own fuel.
      if (inten[i] <= 0.9 && this.rng.chance(hours * 0.5 * (0.4 + f))) {
        // Grass fires move fast and burn hot for a short time.
        inten[i] = Math.min(1.4, f * 1.15 + 0.1);
      } else {
        inten[i] = Math.max(0, f - hours * (0.35 + consumeRate * 1.5));
      }
      if (inten[i] > 0.02) newActive.push(i);
      else inten[i] = 0;
    }

    // Cool down unburned cells that were heated by nearby flames.
    const cool = clamp01(hours * 1.6);
    for (let x = 0; x < n; x += 1) {
      for (let y = 0; y < n; y += 1) {
        const i = y * n + x;
        if (heat[i] > 0) {
          heat[i] = Math.max(0, heat[i] - cool);
          // Conduct heat to neighbours so approaching fire is felt first.
          if (heat[i] > 0.35 && x > 0 && y > 0 && x < n - 1 && y < n - 1) {
            this.heat.data[i - 1] = Math.min(1.2, this.heat.data[i - 1] + heat[i] * 0.02);
            this.heat.data[i + 1] = Math.min(1.2, this.heat.data[i + 1] + heat[i] * 0.02);
            this.heat.data[i - n] = Math.min(1.2, this.heat.data[i - n] + heat[i] * 0.02);
            this.heat.data[i + n] = Math.min(1.2, this.heat.data[i + n] + heat[i] * 0.02);
          }
        }
      }
    }

    this.active = newActive;
    this.activeCells = this.active.length;
    this.totalTreesLost += treesLost;
    this.smoke = lerp(this.smoke, clamp01(this.activeCells / 260), 0.1);

    // Keep a short list of fire fronts for the camera and the event feed.
    if (this.activeCells > 0) {
      let sx = 0;
      let sy = 0;
      for (const i of this.active) {
        sx += i % n;
        sy += (i / n) | 0;
      }
      const cx = Math.round(sx / this.activeCells);
      const cy = Math.round(sy / this.activeCells);
      this.fronts = [
        {
          cx,
          cy,
          x: t.cellToWorldX(cx),
          y: t.cellToWorldY(cy),
          area: this.activeCells * t.cellUnits * t.cellUnits,
        },
      ];
    } else if (this.fronts.length && this.totalCellsBurned > 0) {
      // The front has just died out: report it once.
      const report: FireReport = {
        ignited: false,
        cellsBurned: this.totalCellsBurned,
        treesLost: this.totalTreesLost,
        peakArea: 0,
        extinguished: true,
        x: this.fronts[0].x,
        y: this.fronts[0].y,
      };
      this.fronts = [];
      this.onExtinguished?.(report);
    }
  }

  onExtinguished: ((r: FireReport) => void) | null = null;

  /** Total burning area in world units². */
  get area(): number {
    return this.activeCells * this.terrain.cellUnits * this.terrain.cellUnits;
  }

  /** Extinguish everything (player tool: rainstorm). */
  suppress(): void {
    this.intensity.data.fill(0);
    this.active = [];
    this.activeCells = 0;
  }

  /** Auto-ignition from extreme heat and dryness (rare). */
  spontaneous(dtMinutes: number): void {
    const t = this.terrain;
    const hours = dtMinutes / 60;
    const heat = this.climate.hasEvent('heatwave');
    const moisture = this.terrain.soilMoisture.stats().mean;
    const p = FIRE.ignitionBase * hours * (heat ? 6 : 1) * clamp01(1 - moisture * 2.2) * 60;
    if (!this.rng.chance(p)) return;
    const cx = this.rng.int(1, t.size - 2);
    const cy = this.rng.int(1, t.size - 2);
    const fuel = this.vegetation.fuelAt(cx, cy);
    if (fuel < FIRE.fuelThreshold * 1.4) return;
    this.ignite(cx, cy, 0.8);
    this.onIgnite?.(cx, cy);
  }

  onIgnite: ((cx: number, cy: number) => void) | null = null;

  save(): Record<string, unknown> {
    return {
      intensity: this.intensity.serialise(),
      scar: this.scar.serialise(),
      active: this.active.slice(),
      totalCellsBurned: this.totalCellsBurned,
      totalTreesLost: this.totalTreesLost,
    };
  }

  load(d: Record<string, any>): void {
    if (d.intensity) this.intensity.restore(d.intensity);
    if (d.scar) this.scar.restore(d.scar);
    this.active = Array.isArray(d.active) ? d.active.slice() : [];
    this.activeCells = this.active.length;
    this.totalCellsBurned = d.totalCellsBurned ?? 0;
    this.totalTreesLost = d.totalTreesLost ?? 0;
  }
}
