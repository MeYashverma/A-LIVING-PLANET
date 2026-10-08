import { clamp, clamp01, lerp } from '../core/math';
import { Random } from '../core/rng';
import { DensityGrid } from '../life/spatial';
import { BIOMES, PLANT_INDEX } from './biomes';
import type { Terrain } from './terrain';
import type { Climate } from './climate';
import type { Vegetation } from './vegetation';

export interface AggregateSpecies {
  key: string;
  name: string;
  blurb: string;
  aquatic: boolean;
  /** Intrinsic growth per hour at low density. */
  r: number;
  /** Base carrying capacity (biomass units per patch). */
  k: number;
  /** Baseline daily mortality fraction. */
  mortality: number;
  /** Which plant layers it feeds on (land species). */
  diet: number[];
  /** Temperature window. */
  tMin: number;
  tOpt: number;
  tMax: number;
  /** Species that eat it. */
  predators: string[];
  /** Ecosystem service multipliers. */
  pollination: number;
  decomposition: number;
  /** Rendering hint. */
  visual: 'swarm' | 'hiddenswarm' | 'plankton';
  colour: [number, number, number];
}

export const AGGREGATE_SPECIES: AggregateSpecies[] = [
  {
    key: 'mouse',
    name: 'Field Rodents',
    blurb:
      'A guild of voles, mice and shrews. They convert grass seed and insects into the protein that owls, foxes and eagles depend on.',
    aquatic: false,
    r: 0.055,
    // Carrying capacity is in "patch units": one unit is roughly a meal's
    // worth of small prey. A rich meadow patch holds several.
    k: 9,
    mortality: 0.00075,
    diet: [PLANT_INDEX.grass * 0 + 0, PLANT_INDEX.shrub, 0, 0, 0, 0],
    tMin: -12,
    tOpt: 18,
    tMax: 38,
    predators: ['owl', 'fox', 'eagle', 'wolf', 'raven'],
    pollination: 0,
    decomposition: 0.15,
    visual: 'hiddenswarm',
    colour: [0.42, 0.36, 0.3],
  },
  {
    key: 'insect',
    name: 'Insects',
    blurb:
      'Pollinators, herbivores and detritivores in their billions. They pollinate flowers, shred litter and feed half the food web.',
    aquatic: false,
    r: 0.09,
    k: 11,
    mortality: 0.0016,
    diet: [0, 0, 0, 0, 0, 0],
    tMin: 2,
    tOpt: 24,
    tMax: 44,
    predators: ['fox', 'raven', 'eagle', 'bear'],
    pollination: 1,
    decomposition: 0.45,
    visual: 'swarm',
    colour: [0.55, 0.5, 0.25],
  },
  {
    key: 'plankton',
    name: 'Plankton & Algae',
    blurb: 'The drifting base of every water food web — microscopic life in unimaginable numbers.',
    aquatic: true,
    r: 0.11,
    k: 14,
    mortality: 0.0022,
    diet: [],
    tMin: -2,
    tOpt: 20,
    tMax: 40,
    predators: ['trout'],
    pollination: 0,
    decomposition: 0,
    visual: 'plankton',
    colour: [0.35, 0.6, 0.4],
  },
];

/**
 * Aggregate populations. Small life is simulated as biomass per patch rather
 * than as individuals: the population dynamics (logistic growth, predation,
 * dispersal, environment-limited carrying capacity) are still real, they are
 * just not *individual* rabbits-and-mice bookkeeping.
 */
export class Aggregates {
  terrain: Terrain;
  climate: Climate;
  vegetation: Vegetation;
  species: AggregateSpecies[];

  /** Coarse resolution: one patch per `patchCells` terrain cells. */
  readonly patchCells = 3;
  readonly size: number;
  readonly cellUnits: number;
  biomass: Map<string, DensityGrid>;
  /** Rolling average biomass per species for the UI. */
  means: Record<string, number> = {};
  /** Recent consumption by predators per patch (to show grazing pressure). */
  pressure: Map<string, DensityGrid>;

  private rng: Random;
  private slice = 0;
  private slices = 4;

  constructor(terrain: Terrain, climate: Climate, vegetation: Vegetation, seed: string) {
    this.terrain = terrain;
    this.climate = climate;
    this.vegetation = vegetation;
    this.species = AGGREGATE_SPECIES;
    this.size = Math.ceil(terrain.size / this.patchCells);
    this.cellUnits = terrain.cellUnits * this.patchCells;
    this.rng = new Random(seed + ':aggregates');
    this.biomass = new Map();
    this.pressure = new Map();
    for (const s of this.species) {
      const g = new DensityGrid(this.size * this.cellUnits, this.cellUnits);
      const p = new DensityGrid(this.size * this.cellUnits, this.cellUnits);
      // Initialize near half carrying capacity where the habitat fits.
      for (let cy = 0; cy < this.size; cy++) {
        for (let cx = 0; cx < this.size; cx++) {
          const i = cy * this.size + cx;
          g.counts[i] = this.capacityAt(s, cx, cy) * this.rng.range(0.25, 0.7);
        }
      }
      this.biomass.set(s.key, g);
      this.pressure.set(s.key, p);
      this.means[s.key] = 0;
    }
  }

  private patchToTerrain(p: number): number {
    return p * this.patchCells;
  }

  /** Carrying capacity of a patch for a species, from real environment state. */
  capacityAt(s: AggregateSpecies, pcx: number, pcy: number): number {
    const t = this.terrain;
    const cx = clamp(Math.round(this.patchToTerrain(pcx)), 0, t.size - 1);
    const cy = clamp(Math.round(this.patchToTerrain(pcy)), 0, t.size - 1);
    const i = cy * t.size + cx;
    const temp = t.tempMean.data[i];
    if (temp < s.tMin || temp > s.tMax) return 0;
    const tempF = clamp01(1 - Math.abs(temp - s.tOpt) / Math.max(4, s.tMax - s.tMin) * 2);

    if (s.aquatic) {
      // A patch spans many terrain cells. Sampling one of them and calling the
      // whole patch dry is how a river patch ends up with no plankton at all:
      // look for open water inside the patch before giving up on it.
      const light = clamp01(this.climate.lightLevel * 1.4);
      let bestWater = 0;
      let sea = false;
      let fert = 0;
      for (let k = 0; k < 9; k++) {
        const ox = (k % 3) - 1;
        const oy = ((k / 3) | 0) - 1;
        const sx = clamp(cx + ox * (this.patchCells >> 1), 0, t.size - 1);
        const sy = clamp(cy + oy * (this.patchCells >> 1), 0, t.size - 1);
        const si = sy * t.size + sx;
        const st = t.tempMean.data[si];
        if (st < s.tMin || st > s.tMax) continue;
        const isSea = t.height.data[si] < t.params.seaLevel - 0.0005;
        const depth = isSea ? 1 : t.waterDepth.data[si];
        if (depth > bestWater) bestWater = depth;
        if (isSea) sea = true;
        fert = Math.max(fert, t.fertility.data[si]);
      }
      if (bestWater < 0.06) return 0;
      const seaBoost = sea ? 0.35 : 1;
      const nutrients = clamp01(0.2 + fert * 1.6);
      return s.k * tempF * seaBoost * clamp01(0.35 + Math.min(1, bestWater)) * clamp01(0.3 + light) * clamp01(0.4 + nutrients);
    }

    const land = t.land[i];
    if (!land) return 0;
    if (t.waterDepth.data[i] > 1.2) return 0;
    const biome = BIOMES[t.biome.data[i]];
    if (!biome) return 0;
    // Habitat favourability by biome.
    const habitat = s.key === 'insect' ? biome.plants[0] * 0.8 + biome.plants[1] * 0.5 + biome.plants[2] * 0.6 + biome.plants[5] * 0.5 : biome.plants[0] * 0.9 + biome.plants[1] * 0.6 + biome.plants[5] * 0.5;
    if (habitat <= 0.02) return 0;
    // Cover matters: grass feeds mice and shelters them from owls.
    let cover = 0;
    for (let L = 0; L < this.vegetation.plants.count; L++) {
      cover += this.vegetation.plants.layers[L].at(cx, cy);
    }
    cover = clamp01(cover);
    const organic = clamp01(t.detritus.data[i] + t.organic.data[i] * 0.5);
    const food = s.key === 'insect' ? clamp01(cover * 0.8 + organic * 0.9) : clamp01(cover * 1.1 + t.detritus.data[i] * 0.5);
    const snowPenalty = 1 - clamp01(t.snow.data[i] * 0.6);
    return s.k * tempF * clamp01(habitat * 1.2) * clamp01(0.15 + food) * snowPenalty;
  }

  /**
   * Population dynamics over rolling slices of the patch grid. Called once per
   * simulated hour by the world.
   */
  update(dtMinutes: number): void {
    const hours = dtMinutes / 60;
    const t = this.terrain;
    const n = this.size;
    const bandStart = Math.floor((this.slice * n) / this.slices);
    const bandEnd = Math.floor(((this.slice + 1) * n) / this.slices);
    this.slice = (this.slice + 1) % this.slices;

    // Read once per call: this is constant across every patch in the sweep.
    const rainMean = clamp01(this.climate.rainIntensity.stats().mean * 0.2);

    for (const s of this.species) {
      const grid = this.biomass.get(s.key) as DensityGrid;
      const press = this.pressure.get(s.key) as DensityGrid;
      const b = grid.counts;
      const p = press.counts;
      let sum = 0;
      for (let pcy = bandStart; pcy < bandEnd; pcy++) {
        for (let pcx = 0; pcx < n; pcx++) {
          const i = pcy * n + pcx;
          let val = b[i];
          const K = this.capacityAt(s, pcx, pcy);
          // Dispersal: a small flux between neighbours keeps patches connected.
          let flux = 0;
          if (pcx > 0) flux += b[i - 1] - val;
          if (pcx < n - 1) flux += b[i + 1] - val;
          if (pcy > 0) flux += b[i - n] - val;
          if (pcy < n - 1) flux += b[i + n] - val;
          val += flux * 0.03 * hours;

          if (K <= 0.001) {
            // Uninhabitable: decay fast.
            val = Math.max(0, val - val * (1 - Math.exp(-hours * 0.8)));
            b[i] = val;
            continue;
          }
          const room = clamp01(1 - val / K);
          const growth = s.r * hours * val * room;
          // Recruitment from outside the patch: refuges, drifters, recolonists.
          // Without this a grazed-out patch can never recover, because logistic
          // growth from zero is zero.
          const seedRain = K * 0.0045 * hours * room;
          const death = val * s.mortality * hours * (1 + rainMean);
          val = Math.max(0, val + growth + seedRain - death);
          // Starvation overshoot: if the patch is far above capacity (after a
          // boom), crash back rather than saturating.
          if (val > K * 1.6) val -= (val - K * 1.6) * 0.35;
          b[i] = val;
          p[i] = Math.max(0, p[i] - hours * 0.12);
          sum += val;
        }
      }
      this.means[s.key] = lerp(this.means[s.key], (sum / ((bandEnd - bandStart) * n)) || 0, 0.25);
    }
    void t;
  }

  /** Biomass available for a predator at a world position. */
  availableAt(key: string, x: number, y: number): number {
    const grid = this.biomass.get(key);
    if (!grid) return 0;
    const t = this.terrain;
    const pcx = Math.floor(t.worldToCellX(x) / this.patchCells);
    const pcy = Math.floor(t.worldToCellY(y) / this.patchCells);
    if (pcx < 0 || pcy < 0 || pcx >= this.size || pcy >= this.size) return 0;
    return grid.counts[pcy * this.size + pcx];
  }

  /** Find the best patch of a prey species within radius (predator search). */
  bestPatchNear(key: string, x: number, y: number, radiusUnits: number): { x: number; y: number; amount: number } | null {
    const grid = this.biomass.get(key);
    if (!grid) return null;
    const t = this.terrain;
    const r = Math.ceil(radiusUnits / this.cellUnits);
    const pcx = Math.floor(t.worldToCellX(x) / this.patchCells);
    const pcy = Math.floor(t.worldToCellY(y) / this.patchCells);
    let bx = -1;
    let by = -1;
    let best = 0.02;
    for (let dy = -r; dy <= r; dy++) {
      const yy = pcy + dy;
      if (yy < 0 || yy >= this.size) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = pcx + dx;
        if (xx < 0 || xx >= this.size) continue;
        const d = Math.hypot(dx, dy) * this.cellUnits;
        if (d > radiusUnits) continue;
        const v = grid.counts[yy * this.size + xx] * (1 - d / (radiusUnits + 1) * 0.5);
        if (v > best) {
          best = v;
          bx = xx;
          by = yy;
        }
      }
    }
    if (bx < 0) return null;
    return {
      x: (bx + 0.5) * this.cellUnits - (this.size * this.cellUnits) / 2,
      y: (by + 0.5) * this.cellUnits - (this.size * this.cellUnits) / 2,
      amount: best,
    };
  }

  /**
   * A predator eats from a patch. Returns the biomass actually gained, and the
   * patch is depleted (which is real predation pressure, not decoration).
   */
  consume(key: string, x: number, y: number, amount: number): number {
    const grid = this.biomass.get(key);
    if (!grid) return 0;
    const t = this.terrain;
    const pcy = Math.floor(t.worldToCellY(y) / this.patchCells);
    const pcx = Math.floor(t.worldToCellX(x) / this.patchCells);
    if (pcx < 0 || pcy < 0 || pcx >= this.size || pcy >= this.size) return 0;
    const i = pcy * this.size + pcx;
    const avail = grid.counts[i];
    const take = Math.min(avail * 0.6, amount);
    grid.counts[i] = Math.max(0, avail - take);
    const press = this.pressure.get(key);
    if (press) press.counts[i] = clamp01(press.counts[i] + take * 0.8);
    return take;
  }

  /** Population trend of a species, 0..1 relative to its historic mean. */
  relative(key: string): number {
    const s = this.species.find((x) => x.key === key);
    if (!s) return 0;
    return clamp01(this.means[key] / Math.max(0.05, s.k));
  }

  /** Total biomass of a species across the world (for the encyclopedia). */
  total(key: string): number {
    const grid = this.biomass.get(key);
    if (!grid) return 0;
    let sum = 0;
    const c = grid.counts;
    for (let i = 0; i < c.length; i++) sum += c[i];
    return sum * this.cellUnits * this.cellUnits * 0.01;
  }

  /** Approximate insect activity at a point (drives pollination + audio + visuals). */
  insectActivityAt(x: number, y: number): number {
    // Fraction of a well-populated patch, not of the world maximum.
    return clamp01(this.availableAt('insect', x, y) / 4);
  }

  /** Random swarm positions for the renderer (insects visibly gathering). */
  sampleSwarms(out: Float32Array, maxCount: number, focusX: number, focusY: number, radius: number): number {
    const grid = this.biomass.get('insect');
    if (!grid) return 0;
    const t = this.terrain;
    const cx = Math.floor(t.worldToCellX(focusX) / this.patchCells);
    const cy = Math.floor(t.worldToCellY(focusY) / this.patchCells);
    const r = Math.ceil(radius / this.cellUnits);
    let n = 0;
    for (let dy = -r; dy <= r && n < maxCount; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= this.size) continue;
      for (let dx = -r; dx <= r && n < maxCount; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= this.size) continue;
        const v = grid.counts[yy * this.size + xx];
        if (v < 0.35) continue;
        const p = (v - 0.35) / 0.9;
        const count = Math.min(3, Math.round(p * 3));
        for (let k = 0; k < count && n < maxCount; k++) {
          out[n * 3 + 0] = (xx + this.rng.next()) * this.cellUnits - (this.size * this.cellUnits) / 2;
          out[n * 3 + 1] = (yy + this.rng.next()) * this.cellUnits - (this.size * this.cellUnits) / 2;
          out[n * 3 + 2] = v;
          n++;
        }
      }
    }
    return n;
  }

  save(): Record<string, unknown> {
    const out: Record<string, unknown> = { means: this.means };
    for (const s of this.species) out[s.key] = (this.biomass.get(s.key) as DensityGrid).counts.slice();
    return out;
  }

  load(d: Record<string, any>): void {
    for (const s of this.species) {
      const arr = d[s.key];
      if (arr) (this.biomass.get(s.key) as DensityGrid).counts.set(arr as ArrayLike<number> as Float32Array);
    }
    if (d.means) this.means = { ...this.means, ...d.means };
  }
}
