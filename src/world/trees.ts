import { Random } from '../core/rng';
import { clamp, clamp01, lerp } from '../core/math';
import { ECOLOGY, LIFE, TIME } from '../core/config';
import { LinkedGrid } from '../life/spatial';
import { Genome, TREE_TEMPLATE } from '../life/genome';
import { BIOMES, PLANT_INDEX } from './biomes';
import type { Terrain } from './terrain';
import type { Climate } from './climate';

export enum TreeState {
  Alive = 0,
  Snag = 1,
  Fallen = 2,
}

export const TREE_SPECIES = [
  {
    id: 0,
    key: 'broadleaf',
    name: 'Broadleaf',
    deciduous: true,
    maturityYears: ECOLOGY.treeMaturityYears,
    maxAgeYears: ECOLOGY.treeMaxAgeYears,
    maxHeight: 26,
    maxRadius: 5.6,
    seedRange: 26,
    woodDensity: 1,
  },
  {
    id: 1,
    key: 'conifer',
    name: 'Conifer',
    deciduous: false,
    maturityYears: ECOLOGY.coniferMaturityYears,
    maxAgeYears: 340,
    maxHeight: 33,
    maxRadius: 4.2,
    seedRange: 19,
    woodDensity: 0.9,
  },
] as const;

const TRAITS = TREE_TEMPLATE.traits.length;

/**
 * Trees are simulated as individuals (they are the visual and ecological
 * backbone of the world) using struct-of-arrays storage so tens of thousands of
 * them stay cache-friendly. Each tree thinks rarely — trees are patient.
 */
export class TreeStore {
  readonly capacity: number;
  count = 0;
  nextId = 1;

  x: Float32Array;
  y: Float32Array;
  cx: Int16Array;
  cy: Int16Array;
  species: Uint8Array;
  state: Uint8Array;
  ageDays: Float32Array;
  height: Float32Array;
  radius: Float32Array;
  health: Float32Array;
  vigor: Float32Array;
  /** 0..1 how charred/scorched; kills the canopy when high. */
  burn: Float32Array;
  decay: Float32Array;
  seedTimer: Float32Array;
  id: Int32Array;
  alive: Uint8Array;
  /** Cached growing-season photosynthesis accumulator. */
  leafDrop: Float32Array;

  genome: Float32Array;

  grid: LinkedGrid;
  free: number[] = [];

  /** Statistics refreshed each cycle for the UI and charts. */
  stats = { alive: 0, saplings: 0, meanHeight: 0, snags: 0, meanGrowth: 0, meanDroughtTol: 0, meanColdTol: 0, meanFlammability: 0, canopyCover: 0 };

  constructor(terrain: Terrain, capacity = LIFE.maxTrees) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.cx = new Int16Array(capacity);
    this.cy = new Int16Array(capacity);
    this.species = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
    this.ageDays = new Float32Array(capacity);
    this.height = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.vigor = new Float32Array(capacity);
    this.burn = new Float32Array(capacity);
    this.decay = new Float32Array(capacity);
    this.seedTimer = new Float32Array(capacity);
    this.id = new Int32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.leafDrop = new Float32Array(capacity);
    this.genome = new Float32Array(capacity * TRAITS);
    this.grid = new LinkedGrid(terrain.worldSize, 10, capacity);
  }

  trait(slot: number, key: string): number {
    const idx = TREE_TEMPLATE.index[key];
    return this.genome[slot * TRAITS + idx];
  }

  setTrait(slot: number, key: string, v: number): void {
    const idx = TREE_TEMPLATE.index[key];
    this.genome[slot * TRAITS + idx] = v;
  }

  /** Plant a new tree. Returns the slot, or -1 if the forest is full. */
  plant(terrain: Terrain, x: number, y: number, species: number, genome: Genome, height = 0.6, ageDays = 0): number {
    let slot: number;
    if (this.free.length) slot = this.free.pop() as number;
    else if (this.count < this.capacity) slot = this.count++;
    else return -1;
    this.alive[slot] = 1;
    this.x[slot] = x;
    this.y[slot] = y;
    this.cx[slot] = Math.round(terrain.worldToCellX(x));
    this.cy[slot] = Math.round(terrain.worldToCellY(y));
    this.species[slot] = species;
    this.state[slot] = TreeState.Alive;
    this.ageDays[slot] = ageDays;
    this.height[slot] = height;
    this.radius[slot] = height * 0.22;
    this.health[slot] = 1;
    this.vigor[slot] = 1;
    this.burn[slot] = 0;
    this.decay[slot] = 0;
    this.seedTimer[slot] = 0;
    this.leafDrop[slot] = 1;
    this.id[slot] = this.nextId++;
    for (let i = 0; i < TRAITS; i++) this.genome[slot * TRAITS + i] = genome.values[i];
    return slot;
  }

  kill(slot: number, cause: 'fire' | 'drought' | 'age' | 'cold' | 'wind' | 'axe' | 'disease'): void {
    if (!this.alive[slot]) return;
    if (cause === 'fire') {
      this.state[slot] = TreeState.Snag;
      this.burn[slot] = 1;
      this.height[slot] *= 0.86;
    } else if (cause === 'wind') {
      this.state[slot] = TreeState.Fallen;
    } else {
      this.state[slot] = this.ageDays[slot] > 40 * (TIME.daysPerYear / 12) ? TreeState.Snag : TreeState.Fallen;
    }
  }

  remove(slot: number): void {
    this.alive[slot] = 0;
    this.free.push(slot);
  }

  /** Rebuild the spatial index (called before seeding/crowding queries). */
  rebuildGrid(): void {
    this.grid.clear();
    for (let s = 0; s < this.count; s++) {
      if (this.alive[s]) this.grid.insert(s, this.x[s], this.y[s]);
    }
  }

  /** Local crowding 0..1 within a radius (used to limit regeneration). */
  crowding(x: number, y: number, radius: number, scratch: Int32Array): number {
    const n = this.grid.queryRadius(x, y, radius, scratch);
    let pressure = 0;
    for (let i = 0; i < n; i++) {
      const s = scratch[i];
      if (!this.alive[s]) continue;
      const d = Math.hypot(this.x[s] - x, this.y[s] - y);
      const crown = this.radius[s];
      pressure += clamp01(1 - (d - crown * 0.4) / (radius + crown));
    }
    return clamp01(pressure / 6);
  }

  /** Number of living, non-snag trees (census, charts, habitat quality). */
  statsAlive(): number {
    return this.stats.alive;
  }

  /** Nearest living trees for animal shelter/nesting queries. */
  queryNear(x: number, y: number, radius: number, out: Int32Array, scratch: Int32Array): number {
    const n = this.grid.queryRadius(x, y, radius, scratch);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const s = scratch[i];
      if (!this.alive[s] || this.state[s] !== TreeState.Alive) continue;
      if (out.length <= m) break;
      out[m++] = s;
    }
    return m;
  }

  /** Tree standing at/near a point (for perching, nesting, shade). */
  nearest(x: number, y: number, radius: number, scratch: Int32Array): number {
    const n = this.grid.queryRadius(x, y, radius, scratch);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const s = scratch[i];
      if (!this.alive[s] || this.height[s] < 3) continue;
      const d = (this.x[s] - x) ** 2 + (this.y[s] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}

/**
 * Tree ecology: growth, seeding, senescence, drought die-off, windthrow and
 * decomposition of dead wood. Updates are staggered across the population so a
 * twenty-thousand tree forest costs the same per tick as a small one.
 */
export class Forest {
  terrain: Terrain;
  climate: Climate;
  store: TreeStore;
  rng: Random;

  /** Rolling counters for history/reporting. */
  bornThisYear = 0;
  diedThisYear = 0;
  yearMarker = 1;

  private cursor = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  private scratch = new Int32Array(256);
  private scratchOut = new Int32Array(64);
  private cycleDay = 0;

  constructor(terrain: Terrain, climate: Climate, seed: string) {
    this.terrain = terrain;
    this.climate = climate;
    this.store = new TreeStore(terrain);
    this.rng = new Random(seed + ':forest');
  }

  /** Forest suitability for a species at a position (used by seeding + planting). */
  suitability(cx: number, cy: number, species: number): number {
    const t = this.terrain;
    const biomeIdx = t.biome.at(cx, cy);
    const def = BIOMES[biomeIdx];
    if (!def) return 0;
    let suit = def.trees[species];
    if (suit <= 0) return 0;
    const moist = t.moistureMean.at(cx, cy);
    const temp = t.tempMean.at(cx, cy);
    const fert = t.fertility.at(cx, cy);
    if (species === 0) {
      // Broadleaf likes warmth and moisture.
      suit *= clamp01(0.35 + temp / 22) * clamp01(0.4 + moist) * clamp01(0.5 + fert);
    } else {
      // Conifer is hardy: cold and acid-tolerant, but hates heat.
      suit *= clamp01(1.25 - temp / 26) * clamp01(0.55 + moist * 0.8) * clamp01(0.55 + fert * 0.7);
    }
    return clamp01(suit);
  }

  /** Seeded at world creation: a plausible forest derived from the biome map. */
  seedInitialForest(): void {
    const t = this.terrain;
    // Old-growth density: a forest you can walk into, not a scatter of trees.
    const perCell = 0.2;
    const rng = this.rng;
    const scratchOut = new Int32Array(1);
    for (let cy = 2; cy < t.size - 2; cy += 2) {
      for (let cx = 2; cx < t.size - 2; cx += 2) {
        if (t.land[cy * t.size + cx] !== 1) continue;
        const def = BIOMES[t.biome.at(cx, cy)];
        if (!def) continue;
        for (let sp = 0; sp < 2; sp++) {
          const suit = this.suitability(cx, cy, sp);
          if (suit < 0.22) continue;
          if (!rng.chance(suit * perCell * 2)) continue;
          const jitterX = (rng.next() - 0.5) * t.cellUnits * 2;
          const jitterY = (rng.next() - 0.5) * t.cellUnits * 2;
          const x = t.cellToWorldX(cx) + jitterX;
          const y = t.cellToWorldY(cy) + jitterY;
          if (this.store.crowding(x, y, 5, scratchOut) > 0.5) continue;
          const genome = this.makeFounderGenome(sp, suit);
          const age = rng.range(0, TREE_SPECIES[sp].maxAgeYears * 0.7) * TIME.daysPerYear;
          const maturity = TREE_SPECIES[sp].maturityYears * TIME.daysPerYear;
          const grown = clamp01(age / (maturity * 2.4));
          const h = lerp(1.6, TREE_SPECIES[sp].maxHeight * 0.92, Math.pow(grown, 0.6)) * rng.range(0.7, 1.1);
          const slot = this.store.plant(t, x, y, sp, genome, h, age);
          if (slot >= 0) {
            this.store.radius[slot] = h * 0.2 * rng.range(0.8, 1.25);
            this.store.grid.insert(slot, x, y);
          }
        }
      }
    }
  }

  private makeFounderGenome(species: number, suit: number): Genome {
    const rng = this.rng;
    const values = new Float32Array(TRAITS);
    for (let i = 0; i < TRAITS; i++) {
      const t = TREE_TEMPLATE.traits[i];
      const mid = (t.lo + t.hi) / 2;
      values[i] = clamp(mid + rng.gauss() * (t.hi - t.lo) * 0.18, t.lo, t.hi);
    }
    // Founders in marginal ground skew toward being tolerant of it.
    const idx = TREE_TEMPLATE.index;
    if (suit < 0.5) {
      const dt = TREE_TEMPLATE.traits[idx['droughtTol']];
      values[idx['droughtTol']] = clamp(values[idx['droughtTol']] + 0.15, dt.lo, dt.hi);
    }
    void species;
    return new Genome(TREE_TEMPLATE, values, 1);
  }

  /** Fast path seeding: place a sapling from a parent tree. */
  private seedFrom(slot: number): void {
    const t = this.terrain;
    const sp = this.store.species[slot];
    const range = this.store.trait(slot, 'seedRange') * TREE_SPECIES[sp].seedRange;
    const rng = this.rng;
    const n = 1;
    for (let i = 0; i < n; i++) {
      const ang = rng.next() * Math.PI * 2;
      const dist = Math.pow(rng.next(), 0.6) * range;
      const x = this.store.x[slot] + Math.cos(ang) * dist;
      const y = this.store.y[slot] + Math.sin(ang) * dist;
      const cx = Math.round(t.worldToCellX(x));
      const cy = Math.round(t.worldToCellY(y));
      if (cx < 1 || cy < 1 || cx >= t.size - 1 || cy >= t.size - 1) continue;
      const idx = cy * t.size + cx;
      if (t.land[idx] !== 1) continue;
      if (t.waterDepth.data[idx] > 0.5) continue;
      const suit = this.suitability(cx, cy, sp);
      if (suit < 0.12) continue;
      // Shade tolerance gates establishment under a closed canopy.
      const shadeTol = this.store.trait(slot, 'shadeTol');
      const canopy = t.canopy.data[idx];
      if (rng.next() > clamp01(suit * (0.35 + shadeTol * 0.75)) * (1 - canopy * clamp01(1 - shadeTol * 1.1))) continue;
      if (this.store.crowding(x, y, 3.4, this.scratch) > 0.72) continue;
      if (this.store.count >= this.store.capacity) return;
      const values = new Float32Array(TRAITS);
      for (let k = 0; k < TRAITS; k++) {
        const td = TREE_TEMPLATE.traits[k];
        let v = this.store.genome[slot * TRAITS + k];
        if (rng.chance(0.3)) v += (rng.chance(0.5) ? 1 : -1) * td.mutation * (td.hi - td.lo) * (0.4 + rng.next());
        values[k] = clamp(v, td.lo, td.hi);
      }
      const genome = new Genome(TREE_TEMPLATE, values, Math.max(1, this.store.id[slot] % 100000));
      const newSlot = this.store.plant(t, x, y, sp, genome, 0.4, 0);
      if (newSlot >= 0) {
        this.store.grid.insert(newSlot, x, y);
        this.bornThisYear++;
      }
      return;
    }
  }

  /**
   * Per-tick update. Only a slice of the population is processed, rotating
   * through the forest so long-lived trees cost almost nothing per frame.
   */
  update(dtMinutes: number): void {
    const t = this.terrain;
    const s = this.store;
    const hours = dtMinutes / 60;

    // Process roughly every tree once per simulated hour: 60 trees/minute.
    const slice = Math.max(16, Math.ceil(s.count / 60));
    const start = this.cursor;
    const n = s.count;
    if (n === 0) return;
    const light = this.climate.lightLevel;
    const cloudCover = this.climate.cloud.stats().mean;
    void cloudCover;

    for (let k = 0; k < slice; k++) {
      const slot = (start + k) % n;
      if (!s.alive[slot]) continue;
      const cx = s.cx[slot];
      const cy = s.cy[slot];
      const idx = cy * t.size + cx;
      const sp = s.species[slot];
      const def = TREE_SPECIES[sp];

      if (s.state[slot] !== TreeState.Alive) {
        // Dead wood decays into the litter layer.
        s.decay[slot] += hours * (0.0008 + 0.0016 * clamp01(t.soilMoisture.data[idx] + 0.2));
        if (s.decay[slot] >= 1) {
          t.detritus.data[idx] = clamp01(t.detritus.data[idx] + 0.05 * def.woodDensity);
          t.organic.data[idx] = clamp01(t.organic.data[idx] + 0.02);
          s.remove(slot);
        } else if (s.state[slot] === TreeState.Snag && s.decay[slot] > 0.55 && this.rng.chance(0.05)) {
          s.state[slot] = TreeState.Fallen;
        }
        continue;
      }

      s.ageDays[slot] += dtMinutes / (24 * 60) * 24; // minutes → days
      const ageYears = s.ageDays[slot] / TIME.daysPerYear;
      const temp = this.climate.temperatureAt(s.x[slot], s.y[slot]);
      const moist = t.soilMoisture.data[idx];
      const fert = t.fertility.data[idx];
      const canopy = t.canopy.data[idx];
      const coldTol = s.trait(slot, 'coldTol');
      const droughtTol = s.trait(slot, 'droughtTol');
      const shadeTol = s.trait(slot, 'shadeTol');

      // --- growth ---
      const maturity = def.maturityYears * (1.4 - s.trait(slot, 'growth') * 0.35);
      const grownFraction = clamp01(s.height[slot] / def.maxHeight);
      const lightHere = sp === 1 && !def.deciduous ? lerp(0.35, 1, light) : light;
      const shade = clamp01(1 - canopy * clamp01(1.35 - shadeTol));
      const tempFactor =
        sp === 1
          ? clamp01((temp - (0.4 - coldTol * 4)) / 12)
          : clamp01((temp - 1.5) / 9) * clamp01(1.4 - Math.max(0, temp - 28) / 18);
      const water = clamp01(moist * (1.2 + droughtTol * 1.5) - 0.06);
      const nutrient = clamp01(0.25 + fert * 1.1);
      // Photosynthesis needs light + water + warmth; growth stalls near maturity.
      const photosynth = lightHere * water * tempFactor * nutrient * shade * (1 - grownFraction * 0.82);
      const growthPerHour = ECOLOGY.treeGrowthPerHour * s.trait(slot, 'growth') * (sp === 1 ? 0.65 : 1);
      if (ageYears > maturity * 0.45) {
        s.height[slot] = clamp(
          s.height[slot] + growthPerHour * def.maxHeight * photosynth * hours * 26,
          0.2,
          def.maxHeight * (0.7 + s.trait(slot, 'longevity') * 0.4),
        );
        s.radius[slot] = lerp(s.radius[slot], s.height[slot] * (sp === 1 ? 0.15 : 0.215), 0.05 * hours * 10);
      }
      s.vigor[slot] = lerp(s.vigor[slot], clamp01(photosynth * 1.4), 0.02 * hours * 10);

      // --- stress & health ---
      let stress = 0;
      if (moist < 0.18) stress += (0.18 - moist) * (2.4 - droughtTol * 1.1) * 2.4;
      if (temp < 0) stress += -temp * 0.004 * (1.6 - coldTol) * 0.6;
      if (temp > 34) stress += (temp - 34) * 0.01;
      if (s.burn[slot] > 0.25) stress += s.burn[slot] * 0.08;
      if (t.waterDepth.data[idx] > 0.6) stress += 0.05 * (1 - clamp01(s.height[slot] / 12));
      s.health[slot] = clamp01(s.health[slot] + (stress > 0.001 ? -stress * hours * 0.05 : 0.0016 * hours * clamp01(moist * 2)));
      if (s.health[slot] <= 0 || ageYears > def.maxAgeYears * (0.7 + s.trait(slot, 'longevity') * 0.5)) {
        const cause: 'age' | 'drought' | 'cold' | 'fire' = s.burn[slot] > 0.3 ? 'fire' : moist < 0.18 ? 'drought' : temp < -12 ? 'cold' : 'age';
        this.store.kill(slot, cause);
        this.diedThisYear++;
        continue;
      }
      // Windthrow: wet, exposed, tall trees in storms.
      if (this.climate.windSpeed > 2 && this.rng.chance(0.0006 * (this.climate.windSpeed - 2) * clamp01(moist * 1.3) * clamp01(s.height[slot] / 18))) {
        this.store.kill(slot, 'wind');
        this.diedThisYear++;
        continue;
      }

      // --- seeding ---
      if (ageYears > maturity && s.health[slot] > 0.45) {
        const seedOut = s.trait(slot, 'seedOutput');
        const rate = 0.00022 * seedOut * clamp01(s.vigor[slot] * 1.4) * (def.deciduous && this.lowerLightSeason() ? 0.4 : 1);
        if (this.rng.chance(rate * hours * 24)) this.seedFrom(slot);
      }
    }
    this.cursor = (start + slice) % n;
  }

  private lowerLightSeason(): boolean {
    // Broadleaf seeds ripen in late summer/autumn.
    const d = this.climate.clock.dayOfYear;
    return d > TIME.daysPerSeason * 2 && d < TIME.daysPerSeason * 3;
  }

  /** Forest statistics (proxied from the store for convenience). */
  get stats() {
    return this.store.stats;
  }

  /** Recompute the canopy field and forest statistics (every ~30 sim minutes). */
  refreshCanopy(): void {
    const t = this.terrain;
    const s = this.store;
    t.canopy.data.fill(0);
    let alive = 0;
    let saplings = 0;
    let snags = 0;
    let sumH = 0;
    let sumGrowth = 0;
    let sumDrought = 0;
    let sumCold = 0;
    let sumFlamm = 0;
    const n = t.size;
    for (let slot = 0; slot < s.count; slot++) {
      if (!s.alive[slot]) continue;
      if (s.state[slot] === TreeState.Snag) {
        snags++;
        continue;
      }
      alive++;
      sumH += s.height[slot];
      if (s.height[slot] < 2.5) saplings++;
      sumGrowth += s.trait(slot, 'growth');
      sumDrought += s.trait(slot, 'droughtTol');
      sumCold += s.trait(slot, 'coldTol');
      sumFlamm += s.trait(slot, 'flammability');
      // Stamp crown shade onto the canopy field.
      const r = Math.ceil(s.radius[slot] / t.cellUnits);
      const ccx = s.cx[slot];
      const ccy = s.cy[slot];
      const shade = clamp01((s.height[slot] / 16) * (s.health[slot] * 0.5 + 0.5));
      for (let dy = -r; dy <= r; dy++) {
        const y = ccy + dy;
        if (y < 0 || y >= n) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = ccx + dx;
          if (x < 0 || x >= n) continue;
          const d = Math.hypot(dx, dy) * t.cellUnits;
          if (d > s.radius[slot]) continue;
          const f = 1 - d / (s.radius[slot] + 0.01);
          const i = y * n + x;
          t.canopy.data[i] = clamp01(t.canopy.data[i] + shade * f * 0.6);
        }
      }
    }
    const st = this.store.stats;
    st.alive = alive;
    st.saplings = saplings;
    st.snags = snags;
    st.meanHeight = alive ? sumH / alive : 0;
    st.meanGrowth = alive ? sumGrowth / alive : 0;
    st.meanDroughtTol = alive ? sumDrought / alive : 0;
    st.meanColdTol = alive ? sumCold / alive : 0;
    st.meanFlammability = alive ? sumFlamm / alive : 0;
    st.canopyCover = t.canopy.stats().mean;
  }

  /** All live trees within a radius (used by the renderer for LOD and shadows). */
  countNear(x: number, y: number, radius: number): number {
    return this.store.grid.queryRadius(x, y, radius, this.scratch);
  }

  /** Total biomass, for biodiversity reporting. */
  biomass(): number {
    const s = this.store;
    let b = 0;
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i]) continue;
      if (s.state[i] === TreeState.Alive) b += s.height[i] * s.radius[i] * 1.2;
      else b += s.height[i] * 0.7 * (1 - s.decay[i]);
    }
    return b;
  }

  /** Trees lost to a fire (called by the fire system as it consumes cells). */
  burnTreesAt(cx: number, cy: number, intensity: number): number {
    const t = this.terrain;
    const x = t.cellToWorldX(cx);
    const y = t.cellToWorldY(cy);
    const out = this.scratchOut;
    const n = this.store.grid.queryRadius(x, y, t.cellUnits * 1.6, out);
    let burned = 0;
    for (let i = 0; i < n; i++) {
      const slot = out[i];
      if (!this.store.alive[slot]) continue;
      const flamm = this.store.trait(slot, 'flammability');
      if (!this.rng.chance(clamp01(intensity * (0.35 + flamm * 1.1)) * 0.5)) continue;
      if (this.store.state[slot] === TreeState.Alive) {
        this.store.kill(slot, 'fire');
        // Burning foliage returns nutrients quickly.
        t.fertility.data[cy * t.size + cx] = clamp01(t.fertility.data[cy * t.size + cx] + 0.05);
        burned++;
      }
    }
    return burned;
  }

  save(): Record<string, unknown> {
    const s = this.store;
    const aliveSlots: number[] = [];
    for (let i = 0; i < s.count; i++) if (s.alive[i]) aliveSlots.push(i);
    const count = aliveSlots.length;
    const out = {
      count,
      x: new Float32Array(count),
      y: new Float32Array(count),
      species: new Uint8Array(count),
      state: new Uint8Array(count),
      age: new Float32Array(count),
      height: new Float32Array(count),
      radius: new Float32Array(count),
      health: new Float32Array(count),
      burn: new Float32Array(count),
      decay: new Float32Array(count),
      genome: new Float32Array(count * TRAITS),
      nextId: s.nextId,
      bornThisYear: this.bornThisYear,
      diedThisYear: this.diedThisYear,
    };
    for (let k = 0; k < count; k++) {
      const i = aliveSlots[k];
      out.x[k] = s.x[i];
      out.y[k] = s.y[i];
      out.species[k] = s.species[i];
      out.state[k] = s.state[i];
      out.age[k] = s.ageDays[i];
      out.height[k] = s.height[i];
      out.radius[k] = s.radius[i];
      out.health[k] = s.health[i];
      out.burn[k] = s.burn[i];
      out.decay[k] = s.decay[i];
      for (let t = 0; t < TRAITS; t++) out.genome[k * TRAITS + t] = s.genome[i * TRAITS + t];
    }
    return out;
  }

  load(d: Record<string, any>): void {
    const s = this.store;
    s.count = 0;
    s.free.length = 0;
    s.nextId = d.nextId ?? 1;
    const count = d.count ?? 0;
    for (let k = 0; k < count; k++) {
      const slot = s.count++;
      s.alive[slot] = 1;
      s.x[slot] = d.x[k];
      s.y[slot] = d.y[k];
      s.cx[slot] = Math.round(this.terrain.worldToCellX(d.x[k]));
      s.cy[slot] = Math.round(this.terrain.worldToCellY(d.y[k]));
      s.species[slot] = d.species[k];
      s.state[slot] = d.state[k];
      s.ageDays[slot] = d.age[k];
      s.height[slot] = d.height[k];
      s.radius[slot] = d.radius[k];
      s.health[slot] = d.health[k];
      s.vigor[slot] = 1;
      s.burn[slot] = d.burn[k];
      s.decay[slot] = d.decay[k];
      s.id[slot] = s.nextId++;
      for (let t = 0; t < TRAITS; t++) s.genome[slot * TRAITS + t] = d.genome[k * TRAITS + t];
    }
    this.bornThisYear = d.bornThisYear ?? 0;
    this.diedThisYear = d.diedThisYear ?? 0;
    this.refreshCanopy();
  }
}
