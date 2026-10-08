import { clamp, clamp01, lerp, smoothstep } from '../core/math';
import { ECOLOGY, TIME } from '../core/config';
import { PlantFields, Field } from './fields';
import { BIOMES, PLANT_LAYERS, PLANT_INDEX } from './biomes';
import type { Terrain } from './terrain';
import type { Climate } from './climate';

export interface Forage {
  /** Total edible biomass at the point, 0..1 scale. */
  amount: number;
  /** Nutritional quality multiplier from the plants present. */
  quality: number;
}

/**
 * Field-layer vegetation: grass, shrubs, reeds, algae, moss and xeric scrub.
 * These are simulated as continuous biomass fields (millions of plants), while
 * trees are individual entities (see Forest). Growth is logistic, limited by
 * light, water, nutrients and temperature, and consumed by herbivores.
 */
export class Vegetation {
  terrain: Terrain;
  climate: Climate;
  plants: PlantFields;

  /** Per-layer nutritional quality for herbivores. */
  static QUALITY = [0.62, 0.48, 0.5, 0.4, 0.28, 0.34];

  /** Aggregate statistics for the HUD and history. */
  stats = { biomass: 0, meanCover: 0, grass: 0, shrub: 0, treeCover: 0, algae: 0, reed: 0, productivity: 0 };

  private slice = 0;
  private slices = 8;
  private growthScratch: Float32Array;
  private lightFactor = 1;
  private tempFactor = 1;
  /** Insect/pollinator activity per coarse cell — boosts seed set. */
  pollination = 1;

  /** Grazing/trampling pressure per cell 0..1: suppresses regrowth where heavy. */
  grazePressure: Field;

  constructor(terrain: Terrain, climate: Climate) {
    this.terrain = terrain;
    this.climate = climate;
    this.plants = new PlantFields(terrain.size, PLANT_LAYERS.length);
    this.growthScratch = new Float32Array(terrain.size * terrain.size);
    this.grazePressure = new Field(terrain.size, 0);
    // Seed from the generation-time suitability map.
    for (let L = 0; L < this.plants.count; L++) {
      this.plants.layers[L].data.set(terrain.initialPlantDensity[L]?.data ?? new Float32Array(terrain.size * terrain.size));
    }
  }

  layer(kind: string): Field {
    return this.plants.layers[PLANT_INDEX[kind as keyof typeof PLANT_INDEX]];
  }

  /** Edible biomass available to a grazer at a world position. */
  forageAt(x: number, y: number, diet: number[]): Forage {
    const t = this.terrain;
    const cx = t.worldToCellX(x);
    const cy = t.worldToCellY(y);
    let amount = 0;
    let qualitySum = 0;
    for (let L = 0; L < diet.length; L++) {
      const pref = diet[L];
      if (pref <= 0) continue;
      const b = this.plants.layers[L].sample(cx, cy);
      if (b <= 0.01) continue;
      const edible = b * pref;
      amount += edible;
      qualitySum += edible * Vegetation.QUALITY[L];
    }
    return { amount, quality: amount > 0 ? qualitySum / amount : 0 };
  }

  /** Remove biomass (grazing, burning, trampling). Returns what was actually eaten. */
  /**
   * Record grazing pressure. Heavily grazed ground regrows more slowly (trampling
   * and defoliation), which is how overgrazing turns into a real vegetation crash.
   */
  recordGraze(x: number, y: number, amount: number): void {
    const t = this.terrain;
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const i = cy * t.size + cx;
    this.grazePressure.data[i] = clamp01(this.grazePressure.data[i] + amount * 4);
  }

  consume(x: number, y: number, diet: number[], requested: number): number {
    const t = this.terrain;
    const ccx = t.worldToCellX(x);
    const ccy = t.worldToCellY(y);
    const cx = Math.round(ccx);
    const cy = Math.round(ccy);
    if (cx < 1 || cy < 1 || cx >= t.size - 1 || cy >= t.size - 1) return 0;
    const i = cy * t.size + cx;
    // Gather the locally available preferred biomass.
    let available = 0;
    const weights = new Array(diet.length).fill(0);
    for (let L = 0; L < diet.length; L++) {
      if (diet[L] <= 0) continue;
      const b = this.plants.layers[L].data[i] * diet[L];
      weights[L] = b;
      available += b;
    }
    if (available <= 0.002) return 0;
    const take = Math.min(requested, available * 0.85);
    for (let L = 0; L < diet.length; L++) {
      if (weights[L] <= 0) continue;
      const share = (weights[L] / available) * take;
      const arr = this.plants.layers[L].data;
      arr[i] = Math.max(0, arr[i] - share);
    }
    // Grazing returns dung → detritus.
    t.detritus.data[i] = clamp01(t.detritus.data[i] + take * 0.22);
    return take;
  }

  /** Total ground cover (used for camouflage, movement cost and fire fuel). */
  coverAt(x: number, y: number): number {
    const t = this.terrain;
    const cx = t.worldToCellX(x);
    const cy = t.worldToCellY(y);
    let s = 0;
    for (let L = 0; L < this.plants.count; L++) s += this.plants.layers[L].sample(cx, cy);
    return clamp01(s);
  }

  /** Fuel available to a fire at a cell (dry matter). */
  fuelAt(cx: number, cy: number): number {
    let s = 0;
    for (let L = 0; L < this.plants.count; L++) s += this.plants.layers[L].at(cx, cy);
    return clamp01(s * 0.8 + this.terrain.detritus.at(cx, cy) * 0.6);
  }

  /** Apply burn damage at a cell: consume fuel, leave ash. */
  burn(cx: number, cy: number, intensity: number): number {
    const t = this.terrain;
    if (cx < 0 || cy < 0 || cx >= t.size || cy >= t.size) return 0;
    const i = cy * t.size + cx;
    let consumed = 0;
    for (let L = 0; L < this.plants.count; L++) {
      const arr = this.plants.layers[L].data;
      const take = arr[i] * clamp01(intensity);
      arr[i] -= take;
      consumed += take;
    }
    const det = t.detritus.data;
    const detTake = det[i] * clamp01(intensity * 0.8);
    det[i] -= detTake;
    consumed += detTake;
    // Ash returns nutrients fast; soil biota is sterilised near the surface.
    t.fertility.data[i] = clamp01(t.fertility.data[i] + consumed * 0.16);
    t.soilBiota.data[i] *= 1 - clamp01(intensity * 0.5);
    return consumed;
  }

  /** Plant from a seed/root into a cell (player planting tool). */
  sow(cx: number, cy: number, layer: number, amount: number): boolean {
    const t = this.terrain;
    if (cx < 0 || cy < 0 || cx >= t.size || cy >= t.size) return false;
    const suit = BIOMES[t.biome.at(cx, cy)]?.plants[layer] ?? 0;
    if (suit <= 0.02) return false;
    const arr = this.plants.layers[layer].data;
    arr[cy * t.size + cx] = clamp01(arr[cy * t.size + cx] + amount);
    return true;
  }

  /** Refresh seasonal growth multipliers (cheap; called on the main cadence). */
  private refreshConditions(): void {
    const light = this.climate.lightLevel;
    const day = this.climate.clock.dayOfYear;
    // Growing season: solar input and warmth.
    const half = this.terrain.half * 0.5;
    const meanT = this.climate.temperatureAt(half, half);
    const spring = smoothstep(TIME.daysPerSeason * 0.6, TIME.daysPerSeason * 1.4, day) - smoothstep(TIME.daysPerSeason * 2.4, TIME.daysPerSeason * 3.2, day);
    this.lightFactor = clamp01(0.35 + light * 0.9) * clamp01(0.55 + spring * 0.9);
    this.tempFactor = clamp01((meanT + 4) / 18);
  }

  update(dtMinutes: number): void {
    this.refreshConditions();
    const t = this.terrain;
    const n = t.size;
    const hours = dtMinutes / 60;
    const light = this.climate.lightLevel;
    const canopied = t.canopy.data;
    const moist = t.soilMoisture.data;
    const fert = t.fertility.data;
    const det = t.detritus.data;
    const tempMean = t.tempMean.data;
    const height = t.height.data;
    const biome = t.biome.data;
    const water = t.waterDepth.data;
    const sea = t.params.seaLevel;
    const albedo = t.snow.data;

    const bandStart = Math.floor((this.slice * n) / this.slices);
    const bandEnd = Math.floor(((this.slice + 1) * n) / this.slices);
    this.slice = (this.slice + 1) % this.slices;

    let biomass = 0;
    let productivity = 0;
    const layerTotals = new Array(this.plants.count).fill(0);

    for (let cy = bandStart; cy < bandEnd; cy++) {
      const worldY = t.cellToWorldY(cy);
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const def = BIOMES[biome[i]];
        if (!def) continue;
        const isSea = height[i] < sea - 0.0005;
        const localTemp = tempMean[i] + (this.climate.temperatureAtCell(cx, cy) - tempMean[i]);
        const m = moist[i];
        const shade = clamp01(1 - canopied[i] * 0.85);
        const snowCover = clamp01(albedo[i] * 1.4);
        const frozen = clamp01((localTemp - 0.5) / 4);
        const lightHere = clamp01(light * 1.15) * shade * (1 - snowCover * 0.85);
        const wetOK = clamp01(m * (1.35 - m * 0.25) * 1.5);
        const nutriOK = clamp01(0.2 + fert[i] * 1.25);

        for (let L = 0; L < this.plants.count; L++) {
          const arr = this.plants.layers[L].data;
          let b = arr[i];
          const suit = def.plants[L] ?? 0;
          const aquatic = L === PLANT_INDEX.algae;
          const inWater = water[i] > 0.02 || isSea;
          if (suit <= 0.001) {
            // Unsuitable: existing biomass dies off and returns to the litter.
            if (b > 0.001) {
              const loss = b * clamp01(hours * 0.02 + 0.01);
              arr[i] = b - loss;
              det[i] = clamp01(det[i] + loss * 0.6);
            }
            continue;
          }
          if (aquatic && !inWater) {
            const loss = b * clamp01(hours * 0.06 + 0.02);
            arr[i] = b - loss;
            det[i] = clamp01(det[i] + loss * 0.5);
            continue;
          }
          if (!aquatic && inWater && water[i] > 0.35) {
            // Terrestrial plants drown in deep water.
            const loss = b * clamp01(hours * 0.05);
            arr[i] = b - loss;
            det[i] = clamp01(det[i] + loss * 0.5);
            continue;
          }

          const waterFactor = aquatic ? clamp01(0.5 + water[i] * 0.2) : wetOK;
          const tempFactor = clamp01(0.15 + (localTemp + 6) / 26) * (0.35 + 0.65 * frozen);
          // Heavy grazing and trampling reduce both the standing crop and how
          // fast it can regrow — this is what turns overgrazing into a crash.
          const grazed = this.grazePressure.data[i];
          const capacity = clamp01(suit * waterFactor * nutriOK * tempFactor * (0.35 + 0.65 * lightHere) * (1 - grazed * 0.75)) * 1.1;
          let growth = 0;
          if (capacity > 0.01 && b > 0.0005) {
            const growthRate =
              (L === PLANT_INDEX.grass ? ECOLOGY.grassGrowthPerHour : L === PLANT_INDEX.shrub ? ECOLOGY.shrubGrowthPerHour : ECOLOGY.grassGrowthPerHour * 0.7) *
              hours *
              this.lightFactor;
            const room = clamp01(1 - b / Math.max(0.02, capacity));
            growth = growthRate * b * (0.35 + room * 1.5) * 3.2;
            b = clamp01(b + growth);
            // Nutrient draw-down and litter return.
            fert[i] = clamp01(fert[i] - growth * ECOLOGY.nutrientPerGrowth * 0.35);
            productivity += growth;
          } else if (b <= 0.0005 && capacity > 0.25) {
            // Regeneration from dormant seed bank (or seed rain from neighbours).
            const seedPressure = this.neighbourSeed(cx, cy, L);
            if (seedPressure > 0.02) {
              b = Math.min(0.02, seedPressure * 0.05);
              arr[i] = b;
            }
          }

          // Senescence: winter die-back, drought and old age.
          const winter = clamp01(1 - frozen);
          const drought = m < 0.14 ? clamp01((0.14 - m) / 0.14) : 0;
          let loss = 0;
          if (winter > 0.55 && !aquatic) loss += b * 0.0009 * hours * (winter - 0.55) * 3;
          if (drought > 0.3) loss += b * 0.0016 * hours * drought;
          if (L === PLANT_INDEX.shrub || L === PLANT_INDEX.moss) loss *= 0.3;
          if (loss > 0) {
            arr[i] = Math.max(0, b - loss);
            det[i] = clamp01(det[i] + loss * 0.45);
          }
          layerTotals[L] += arr[i];
        }
      }
    }

    // Grazing pressure fades as plants recover (and as animals move on).
    for (let cy = bandStart; cy < bandEnd; cy++) {
      const row = cy * n;
      for (let cx = 0; cx < n; cx++) {
        const i = row + cx;
        const p = this.grazePressure.data[i];
        if (p > 0) this.grazePressure.data[i] = Math.max(0, p - hours * 0.02);
      }
    }

    const cells = (bandEnd - bandStart) * n;
    this.stats.productivity = lerp(this.stats.productivity, productivity / Math.max(1, cells), 0.15);
    if (this.slice === 0) {
      // A full sweep just completed: refresh aggregate statistics.
      this.recomputeStats();
      void biomass;
    }

    this.pollination = clamp01(this.pollination * 0.98 + 0.02 * (0.4 + this.climate.lightLevel));
  }

  /** Recompute the aggregate cover statistics from the live field layers. */
  recomputeStats(): void {
    const t = this.terrain;
    let total = 0;
    let cover = 0;
    const n = t.size * t.size;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let L = 0; L < this.plants.count; L++) s += this.plants.layers[L].data[i] as number;
      total += s;
      cover += clamp01(s);
    }
    this.stats.biomass = total / n;
    this.stats.meanCover = cover / n;
    this.stats.grass = this.plants.layers[PLANT_INDEX.grass].stats().mean;
    this.stats.shrub = this.plants.layers[PLANT_INDEX.shrub].stats().mean;
    this.stats.algae = this.plants.layers[PLANT_INDEX.algae].stats().mean;
    this.stats.reed = this.plants.layers[PLANT_INDEX.reed].stats().mean;
    this.stats.treeCover = t.canopy.stats().mean;
  }

  /** Seed pressure from the neighbourhood, used to recolonise bare ground. */
  private neighbourSeed(cx: number, cy: number, layer: number): number {
    const arr = this.plants.layers[layer].data;
    const n = this.terrain.size;
    let best = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= n) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= n) continue;
        const v = arr[y * n + x];
        if (v > best) best = v;
      }
    }
    // Distant sources matter less.
    return best * (0.35 + 0.65 * clamp01(best));
  }

  save(): Record<string, unknown> {
    return {
      layers: this.plants.layers.map((l) => l.serialise()),
      slice: this.slice,
    };
  }

  load(d: Record<string, any>): void {
    if (Array.isArray(d.layers)) {
      d.layers.forEach((arr: Float32Array, i: number) => {
        if (i < this.plants.count) this.plants.layers[i].restore(arr);
      });
    }
    this.slice = d.slice ?? 0;
  }
}
