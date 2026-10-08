import { Noise2D, Random } from '../core/rng';
import { clamp, clamp01, lerp, smoothstep } from '../core/math';
import { CLIMATE, TERRAIN, WORLD } from '../core/config';
import { ByteField, Field } from './fields';
import { Biome, BIOMES, PLANT_LAYERS, isWaterBiome } from './biomes';

export interface WorldParams {
  seed: string;
  name: string;
  grid: number;
  landFraction: number;
  seaLevel: number;
  relief: number;
  temperatureBias: number;
  rainfallBias: number;
  /** Direction the prevailing wind blows toward, in radians (0 = +x / east). */
  windDirection: number;
  volcanism: number;
  /** Number of large landmasses the generator aims for. */
  landmasses: number;
  /** Starting life: population multiplier for initial seeding. */
  seeding: number;
}

export function defaultParams(seed: string, name: string): WorldParams {
  const r = new Random(seed);
  return {
    seed,
    name,
    grid: WORLD.defaultGrid,
    landFraction: 0.58,
    seaLevel: WORLD.seaLevel,
    relief: 1,
    temperatureBias: r.range(-2.5, 3.5),
    rainfallBias: r.range(0.85, 1.25),
    windDirection: r.range(-0.5, 0.5) + (r.chance(0.5) ? 0 : Math.PI),
    volcanism: r.range(0, 0.7),
    landmasses: r.int(1, 2),
    seeding: 1,
  };
}

export interface Landmark {
  kind: 'peak' | 'lake' | 'river' | 'forest' | 'marsh' | 'desert' | 'volcano' | 'cave' | 'plateau';
  name: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  value: number;
}

export interface RiverNode {
  cx: number;
  cy: number;
  flow: number;
  width: number;
}

export interface River {
  id: number;
  name: string;
  nodes: RiverNode[];
  /** Peak flow accumulation (normalised), used for width and drought resilience. */
  maxFlow: number;
  lengthUnits: number;
  mouthIsSea: boolean;
  /** Runtime discharge multiplier (1 = normal flow, <1 in droughts). */
  discharge?: number;
}

/* ------------------------------------------------------------------ */
/* Min-heap used by the depression-filling pass.                       */
/* ------------------------------------------------------------------ */
class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  private n = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  push(key: number, val: number): void {
    if (this.n >= this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      const v = new Int32Array(this.vals.length * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.n++;
    this.keys[i] = key;
    this.vals[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const top = this.vals[0];
    this.n--;
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n];
      this.vals[0] = this.vals[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.keys[l] < this.keys[m]) m = l;
        if (r < this.n && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const DIR_DIST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/**
 * The terrain: a static-ish height field plus the slowly evolving environmental
 * layers (moisture, fertility, water, snow). It also owns the river network and
 * landmark names so the rest of the app can talk about the world geographically.
 */
export class Terrain {
  readonly size: number;
  readonly last: number;
  readonly cellUnits: number;
  readonly worldSize: number;
  readonly half: number;
  params: WorldParams;

  /** Normalised height 0..1 (sea level is params.seaLevel). */
  height: Field;
  /** Hydrologically filled surface (never below height). */
  filled: Field;
  /** Depression depth → where lakes and ponds sit. */
  lakeDepth: Field;
  /** Log-normalised flow accumulation (0..1) — the river mask. */
  river: Field;
  /** Channel depth of river cells. */
  riverDepth: Field;
  /** Per-cell steepness 0..1. */
  slope: Field;
  /** Dominant wind exposure: windward cells are cooler/wetter. */
  windExposure: Field;

  /** Annual-mean temperature (°C). Instantaneous temperature is derived at runtime. */
  tempMean: Field;
  /** Annual-mean wetness 0..1. */
  moistureMean: Field;
  /** Annual rainfall in mm (relative scale). */
  rainfall: Field;
  /** Continentality 0..1 (seasonal swing multiplier). */
  continentality: Field;
  /** Distance-weighted proximity to any water body, 0..1. */
  waterProximity: Field;

  fertility: Field;
  /** Fresh dead biomass awaiting decomposition. */
  detritus: Field;
  /** Living soil community (bacteria, fungi, invertebrates) 0..1. */
  soilBiota: Field;

  /** Runtime water depth in world units (lakes, sea, rivers). */
  waterDepth: Field;
  /** Position of the free water surface (world units) — cached for rendering. */
  waterSurface: Field;
  /** Dynamic soil moisture 0..1 near the surface. */
  soilMoisture: Field;
  /** Stable soil organic matter 0..1. */
  organic: Field;
  /** Fraction of each cell shaded by tree canopy 0..1. */
  canopy: Field;
  /** Standing snow depth in world units. */
  snow: Field;
  /** Mud 0..1 — from rain on bare soil, slows movement. */
  mud: Field;

  biome: ByteField;
  /** Static: 1 where the cell is above sea level. */
  land: Uint8Array;

  rivers: River[] = [];
  landmarks: Landmark[] = [];
  volcanoes: { x: number; y: number; cx: number; cy: number; radius: number; name: string }[] = [];
  caves: { x: number; y: number; cx: number; cy: number; name: string }[] = [];
  /** Named regions used for territory labels and event text. */
  regions: { name: string; cx: number; cy: number; biome: Biome }[] = [];

  private noiseA: Noise2D;
  private noiseB: Noise2D;
  private noiseC: Noise2D;
  elevationScratch = new Float32Array(1);

  constructor(params: WorldParams) {
    this.params = params;
    this.size = params.grid;
    this.last = params.grid - 1;
    this.cellUnits = WORLD.cellUnits;
    this.worldSize = this.size * this.cellUnits;
    this.half = this.worldSize / 2;

    const n = this.size;
    this.height = new Field(n);
    this.filled = new Field(n);
    this.lakeDepth = new Field(n);
    this.river = new Field(n);
    this.riverDepth = new Field(n);
    this.slope = new Field(n);
    this.windExposure = new Field(n);
    this.tempMean = new Field(n);
    this.moistureMean = new Field(n);
    this.rainfall = new Field(n);
    this.continentality = new Field(n);
    this.waterProximity = new Field(n);
    this.fertility = new Field(n);
    this.detritus = new Field(n);
    this.soilBiota = new Field(n, 0.45);
    this.waterDepth = new Field(n);
    this.waterSurface = new Field(n);
    this.soilMoisture = new Field(n, 0.4);
    this.organic = new Field(n, 0.2);
    this.canopy = new Field(n);
    this.snow = new Field(n);
    this.mud = new Field(n);
    this.biome = new ByteField(n);
    this.land = new Uint8Array(n * n);

    this.noiseA = new Noise2D(new Random(params.seed + ':a').int(0, 1e9));
    this.noiseB = new Noise2D(new Random(params.seed + ':b').int(0, 1e9));
    this.noiseC = new Noise2D(new Random(params.seed + ':c').int(0, 1e9));
  }

  /* ---------------- coordinate helpers ---------------- */

  cellToWorldX(cx: number): number {
    return cx * this.cellUnits - this.half;
  }
  cellToWorldY(cy: number): number {
    return cy * this.cellUnits - this.half;
  }
  worldToCellX(x: number): number {
    return (x + this.half) / this.cellUnits;
  }
  worldToCellY(y: number): number {
    return (y + this.half) / this.cellUnits;
  }
  clampCellX(cx: number): number {
    return clamp(cx, 0.001, this.last - 0.001);
  }

  /** World Y (height) at a normalised height value, in world units. */
  elevationOf(h: number): number {
    return (h - this.params.seaLevel) * WORLD.heightScale;
  }

  heightAtWorld(x: number, y: number): number {
    return this.height.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  elevationAtWorld(x: number, y: number): number {
    return this.elevationOf(this.heightAtWorld(x, y));
  }

  biomeAtWorld(x: number, y: number): Biome {
    const cx = clamp(Math.round(this.worldToCellX(x)), 0, this.last);
    const cy = clamp(Math.round(this.worldToCellY(y)), 0, this.last);
    return this.biome.get(cx, cy) as Biome;
  }

  moistureAtWorld(x: number, y: number): number {
    return this.moistureMean.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  fertilityAtWorld(x: number, y: number): number {
    return this.fertility.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  /** Rough fraction of the land that is currently under water (sampled). */
  wetFraction(): number {
    const d = this.waterDepth.data;
    let wet = 0;
    let total = 0;
    for (let i = 0; i < d.length; i += 7) {
      total++;
      if (d[i] > 0.05) wet++;
    }
    return total > 0 ? wet / total : 0;
  }

  /** World position of a named region's centre (for event framing). */
  regionCenter(index: number): { x: number; y: number; name: string } {
    const r = this.regions[index] ?? this.regions[0];
    if (!r) return { x: 0, y: 0, name: 'Wilderness' };
    return { x: this.cellToWorldX(r.cx), y: this.cellToWorldY(r.cy), name: r.name };
  }

  /** Snow depth hint at a world position (0..1). */
  /** Ground slope (0 flat .. 1 cliff) at world coordinates. */
  slopeAtWorld(x: number, y: number): number {
    return this.slope.at(
      clamp(Math.round(this.worldToCellX(x)), 0, this.last),
      clamp(Math.round(this.worldToCellY(y)), 0, this.last),
    );
  }

  snowAtWorld(x: number, y: number): number {
    return this.snow.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  /** Mud at a world position (0..1). */
  mudAtWorld(x: number, y: number): number {
    return this.mud.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  /** Canopy cover at a world position (0..1). */
  canopyAtWorld(x: number, y: number): number {
    return this.canopy.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  /** Soil moisture at a world position (0..1). */
  soilMoistureAtWorld(x: number, y: number): number {
    return this.soilMoisture.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  /** Terrain movement difficulty (slope, roughness, mud) at a world position. */
  roughnessAtWorld(x: number, y: number): number {
    const cx = this.clampCellX(this.worldToCellX(x));
    const cy = this.clampCellX(this.worldToCellY(y));
    const slope = this.slope.sample(cx, cy);
    const mud = this.mud.sample(cx, cy);
    return clamp01(slope * 1.8 + mud * 0.5);
  }

  /** Water depth in world units at a world position. */
  waterAtWorld(x: number, y: number): number {
    return this.waterDepth.sample(this.worldToCellX(x), this.worldToCellY(y));
  }

  /** Water surface Y at a world position (or -Infinity where dry). */
  waterSurfaceAtWorld(x: number, y: number): number {
    const depth = this.waterAtWorld(x, y);
    if (depth <= 0.02) return -Infinity;
    return this.elevationAtWorld(x, y) + depth;
  }

  /** True when a terrestrial animal could not stand here (too deep). */
  isImpassableWater(x: number, y: number): boolean {
    return this.waterAtWorld(x, y) > 0.9;
  }

  /** Compass direction label from a world position (for geography text). */
  regionNameAt(x: number, y: number): string {
    const cx = clamp(Math.floor(this.worldToCellX(x) / (this.size / 6)), 0, 5);
    const cy = clamp(Math.floor(this.worldToCellY(y) / (this.size / 6)), 0, 5);
    const idx = cy * 6 + cx;
    return this.regions[idx]?.name ?? 'Wilderness';
  }

  /* ---------------- generation ---------------- */

  generate(): void {
    this.buildHeightField();
    this.buildHydrology();
    this.buildClimate();
    this.buildSoil();
    this.classifyBiomes();
    this.seedInitialVegetation();
    this.seedSurfaceWater();
    this.nameGeography();
  }

  /**
   * Put water where the terrain says it should be. The flow model finds the
   * depressions (lakes, ponds) and the drainage channels (rivers, streams);
   * this turns those two fields into real water depth on the terrain grid, so
   * there are rivers to follow, ponds to drink from and wetlands downstream
   * before the first drop of rain has been simulated.
   */
  private seedSurfaceWater(): void {
    const n = this.size;
    const h = this.height.data;
    const sea = this.params.seaLevel;
    const depth = this.waterDepth.data;
    const lake = this.lakeDepth.data;
    const river = this.riverDepth.data;
    for (let i = 0; i < depth.length; i++) {
      if (h[i] < sea - 0.0005) continue; // the sea is filled elsewhere
      let d = 0;
      // Basins: the depression-fill depth, scaled into metres. Ponds are
      // shallow, the deepest basins hold real lake water.
      if (lake[i] > 0.0025) d = clamp(lake[i] * 60, 0.3, 2.6);
      // Channels: flowing water, shallower than a lake, and only along the
      // actual drainage lines — a watershed is not a wetland.
      if (river[i] > 0.0035) {
        const channel = clamp(0.06 + river[i] * 40, 0.06, 1.2);
        if (channel > d) d = channel;
      }
      if (d > 0) depth[i] = Math.max(depth[i], d);
    }
    // A thin film of water on the banks keeps shorelines continuous, and gives
    // amphibians, insects and drinking animals a wet edge to use.
    const bank = new Float32Array(depth.length);
    for (let cy = 1; cy < n - 1; cy++) {
      for (let cx = 1; cx < n - 1; cx++) {
        const i = cy * n + cx;
        if (depth[i] > 0.02) continue;
        if (h[i] < sea - 0.0005) continue;
        let wetNeighbour = 0;
        for (let d = 0; d < 8; d++) {
          const j = i + DIRS[d][1] * n + DIRS[d][0];
          if (depth[j] > 0.25) wetNeighbour++;
        }
        if (wetNeighbour > 0) bank[i] = 0.05;
      }
    }
    for (let i = 0; i < depth.length; i++) if (bank[i] > 0) depth[i] = Math.max(depth[i], bank[i]);
  }

  /** Step 1 — continent shape, mountain ranges, volcanoes. */
  private buildHeightField(): void {
    const n = this.size;
    const rng = new Random(this.params.seed + ':height');
    const h = this.height.data;
    const { relief, landmassBias } = { relief: this.params.relief, landmassBias: this.params.landmasses };

    // Seed points for radial landmass influence.
    const centers: { x: number; y: number; r: number; w: number }[] = [];
    const count = Math.max(1, Math.round(landmassBias) + (rng.chance(0.4) ? 1 : 0));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng.range(-0.6, 0.6);
      const d = count === 1 ? 0 : rng.range(0.08, 0.24);
      centers.push({
        x: 0.5 + Math.cos(a) * d,
        y: 0.5 + Math.sin(a) * d,
        r: rng.range(0.34, 0.54) / Math.sqrt(count) + 0.12,
        w: rng.range(0.7, 1.35),
      });
    }

    // Ridged mountain backbone orientation.
    const rangeAngle = rng.range(0, Math.PI);
    const rx = Math.cos(rangeAngle);
    const ry = Math.sin(rangeAngle);

    const fbm = (x: number, y: number, oct: number, scale: number) => this.noiseA.fbm(x * scale, y * scale, oct, 2.05, 0.5);

    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const u = cx / n;
        const v = cy / n;

        // Warped continent mask from radial influence + large-scale noise.
        let mask = 0;
        for (const c of centers) {
          const dx = u - c.x;
          const dy = v - c.y;
          const d = Math.sqrt(dx * dx + dy * dy) / c.r;
          mask = Math.max(mask, c.w * (1 - d));
        }
        const warpX = this.noiseB.fbm(u * 3.1 + 4.2, v * 3.1 - 1.7, 3) * 0.22;
        const warpY = this.noiseB.fbm(u * 3.1 - 9.1, v * 3.1 + 6.4, 3) * 0.22;
        const continentNoise = this.noiseA.warped(u * 2.4 + warpX, v * 2.4 + warpY, 0.35, 4);
        let base = mask * 0.85 + continentNoise * 0.45 + 0.16;

        // Ocean rim so the world reads as a landmass in a sea.
        const edgeX = Math.min(u, 1 - u);
        const edgeY = Math.min(v, 1 - v);
        const edge = Math.min(edgeX, edgeY);
        const rimNoise = this.noiseC.fbm(u * 5.5, v * 5.5, 3) * 0.05;
        base -= smoothstep(0.12, 0.0, edge + rimNoise) * 0.5;

        // Mountain ranges: ridged noise gated by a soft band.
        const along = u * rx + v * ry;
        const perp = -u * ry + v * rx;
        const band = Math.exp(-Math.pow((perp - 0.5 - this.noiseB.fbm(u * 2.2, v * 2.2, 2) * 0.16) * 3.4, 2));
        const ridge = this.noiseA.ridged(u * 2.6 + 3.3, v * 2.6 - 8.1, 5, 2.1, 0.52);
        const ridgeMask = smoothstep(this.params.seaLevel - 0.06, this.params.seaLevel + 0.22, base) * band;
        const mountains = ridge * ridgeMask * 0.5 * relief * (1.05 + 0.35 * Math.sin(along * 6.0));

        // Mid-scale hills and micro detail.
        const hills = fbm(u, v, 4, 6.5) * 0.075 * relief;
        const detail = fbm(u, v, 3, 20) * 0.016 + this.noiseC.fbm(u * 46, v * 46, 2) * 0.006;

        let height = base + mountains + hills + detail;
        // Flatten shallow shelves into beaches rather than cliffs into the sea.
        const sl = this.params.seaLevel;
        if (height > sl - 0.02 && height < sl + 0.02) height = sl + (height - sl) * 0.55;

        h[i] = height;
      }
    }

    // Normalise land fraction by choosing a waterline that matches the request.
    const sorted = Float32Array.from(h);
    sorted.sort();
    const target = 1 - clamp(this.params.landFraction, 0.15, 0.85);
    const quantile = sorted[Math.floor(target * (sorted.length - 1))];
    const shift = quantile - this.params.seaLevel;
    for (let i = 0; i < h.length; i++) h[i] -= shift;

    // Hypsometric curve. Raw noise puts most of the land on a high plateau;
    // real continents are mostly low ground with a thin tail of high country.
    // Compressing the low relief and keeping the ridges makes river valleys,
    // floodplains and coastal shelves read as such, and leaves snow and alpine
    // for genuinely high ground.
    const sl0 = this.params.seaLevel;
    const PIVOT = 0.62;
    const EXP = TERRAIN.hypsometricExponent;
    for (let i = 0; i < h.length; i++) {
      const rel = h[i] - sl0;
      if (rel <= 0) continue;
      const r = Math.min(rel, PIVOT * 1.9);
      h[i] = sl0 + Math.pow(r, EXP) / Math.pow(PIVOT, EXP - 1);
    }

    // Relief floor: every world should have some high ground, even when the
    // noise happened to land a flat basin. Stretch land relief toward the
    // target without touching the coastline.
    const landElev: number[] = [];
    for (let i = 0; i < h.length; i++) if (h[i] > sl0) landElev.push((h[i] - sl0) * WORLD.heightScale);
    landElev.sort((a, b) => a - b);
    const high = landElev[Math.floor(landElev.length * 0.97)] ?? 0;
    const stretch = clamp(TERRAIN.minRelief / Math.max(0.001, high), 1, 3.2);
    if (stretch > 1.02) {
      for (let i = 0; i < h.length; i++) {
        const rel = h[i] - sl0;
        if (rel > 0) h[i] = sl0 + rel * stretch;
      }
    }

    // Volcanoes: cones with craters, biased to land.
    this.volcanoes = [];
    const volcanoCount = Math.round(this.params.volcanism * 4);
    for (let k = 0; k < volcanoCount; k++) {
      let cx = 0;
      let cy = 0;
      for (let tries = 0; tries < 60; tries++) {
        cx = rng.int(n * 0.12, n * 0.88);
        cy = rng.int(n * 0.12, n * 0.88);
        if (h[cy * n + cx] > this.params.seaLevel + 0.06) break;
      }
      const radius = rng.range(0.035, 0.075) * n;
      const coneH = rng.range(0.1, 0.19) * relief;
      for (let y = Math.max(0, cy - radius) | 0; y <= Math.min(n - 1, cy + radius); y++) {
        for (let x = Math.max(0, cx - radius) | 0; x <= Math.min(n - 1, cx + radius); x++) {
          const d = Math.hypot(x - cx, y - cy) / radius;
          if (d > 1) continue;
          const profile = Math.pow(1 - d, 1.7);
          const crater = d < 0.16 ? (0.16 - d) * 2.4 * coneH : 0;
          const jitter = this.noiseC.fbm(x * 0.12, y * 0.12, 3) * 0.1;
          h[y * n + x] += (profile * coneH * (1 + jitter) - crater) * Math.min(1, 1.4 - d);
        }
      }
      const vol = {
        cx,
        cy,
        x: this.cellToWorldX(cx),
        y: this.cellToWorldY(cy),
        radius: radius * this.cellUnits,
        name: '',
      };
      this.volcanoes.push(vol);
    }

    // Keep everything in a sane range.
    this.height.clampAll(0.02, 1.25);
    this.computeSlope();
  }

  /** Step 2 — depression filling, flow accumulation, river carving, lakes. */
  private buildHydrology(): void {
    const n = this.size;
    const h = this.height.data;
    const filled = this.filled.data;

    // Priority-flood from the borders: guarantees every cell drains to the sea.
    const heap = new MinHeap(n * n);
    const seen = new Uint8Array(n * n);
    filled.set(h);
    for (let x = 0; x < n; x++) {
      for (const y of [0, n - 1]) {
        const i = y * n + x;
        seen[i] = 1;
        heap.push(filled[i], i);
      }
    }
    for (let y = 0; y < n; y++) {
      for (const x of [0, n - 1]) {
        const i = y * n + x;
        if (seen[i]) continue;
        seen[i] = 1;
        heap.push(filled[i], i);
      }
    }
    while (heap.size > 0) {
      const i = heap.pop();
      const cx = i % n;
      const cy = (i / n) | 0;
      const lvl = filled[i];
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0];
        const ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (seen[j]) continue;
        seen[j] = 1;
        const v = Math.max(h[j], lvl + 1e-5);
        filled[j] = v;
        heap.push(v, j);
      }
    }

    // Any change caused by erosion elsewhere invalidates the flood fill; because
    // the player can reshape terrain later we re-run this cheaply on demand.
    const lake = this.lakeDepth.data;
    for (let i = 0; i < h.length; i++) {
      const d = filled[i] - h[i];
      lake[i] = d > 0.0022 ? d : 0;
    }

    // Flow directions (D8) on the filled surface, then accumulate downstream.
    const downIdx = new Int32Array(n * n);
    const slopeField = this.slope.data;
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        let best = -1;
        let bestScore = 0;
        for (let d = 0; d < 8; d++) {
          const nx = cx + DIRS[d][0];
          const ny = cy + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          const drop = filled[i] - filled[j];
          const score = drop / DIR_DIST[d];
          if (score > bestScore) {
            bestScore = score;
            best = j;
          }
        }
        downIdx[i] = best;
      }
    }

    // Accumulate in descending height order.
    const order = new Int32Array(n * n);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const orderArr = Array.from(order);
    orderArr.sort((a, b) => filled[b] - filled[a]);
    const acc = new Float32Array(n * n);
    acc.fill(1);
    for (let k = 0; k < orderArr.length; k++) {
      const i = orderArr[k];
      const d = downIdx[i];
      if (d >= 0) acc[d] += acc[i];
    }

    // Normalise flow for the river mask (log scale feels right for widths).
    let maxAcc = 0;
    for (let i = 0; i < acc.length; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
    const riverD = this.river.data;
    const riverDepthD = this.riverDepth.data;
    const RIVER_START = 26; // cells of upstream area needed before a channel exists
    for (let i = 0; i < acc.length; i++) {
      const v = acc[i];
      if (v < RIVER_START) {
        riverD[i] = 0;
        continue;
      }
      const norm = Math.log(v / RIVER_START) / Math.log(Math.max(2, maxAcc / RIVER_START));
      const m = clamp01(norm);
      riverD[i] = m;
      riverDepthD[i] = 0.0012 + m * 0.006;
    }

    // Carve channels so rivers sit inside valleys instead of on top of ridges.
    const blur = new Float32Array(riverD.length);
    blur.set(riverD);
    for (let pass = 0; pass < 2; pass++) {
      const tmp = new Float32Array(blur);
      for (let cy = 1; cy < n - 1; cy++) {
        for (let cx = 1; cx < n - 1; cx++) {
          const i = cy * n + cx;
          let s = 0;
          for (let d = 0; d < 8; d++) s += tmp[i + DIRS[d][1] * n + DIRS[d][0]] * 0.09;
          blur[i] = tmp[i] * 0.28 + s;
        }
      }
    }
    for (let i = 0; i < h.length; i++) {
      if (blur[i] <= 0.001) continue;
      // Carve mostly into the channel itself, gently into the surrounding banks.
      const carve = Math.pow(blur[i], 1.35) * 0.028;
      const isChannel = riverD[i] > 0.01;
      h[i] -= isChannel ? carve : carve * 0.35;
    }
    // Re-derive slope and shallow-water surfaces after carving.
    this.computeSlope();
    this.buildWaterProximity();

    // Build river polylines for rendering, hydrology and naming.
    this.traceRivers(riverD, acc, maxAcc, downIdx);
  }

  private traceRivers(riverD: Float32Array, acc: Float32Array, maxAcc: number, downIdx: Int32Array): void {
    const n = this.size;
    const isRiver = new Uint8Array(n * n);
    for (let i = 0; i < riverD.length; i++) isRiver[i] = riverD[i] > 0.02 ? 1 : 0;

    const visited = new Uint8Array(n * n);
    const rivers: River[] = [];
    const logMax = Math.log(Math.max(2, maxAcc / 26));

    const buildFrom = (start: number): void => {
      const nodes: RiverNode[] = [];
      let i = start;
      let guard = 0;
      let mouthIsSea = false;
      while (i >= 0 && guard++ < n * 4) {
        if (visited[i] && nodes.length > 2) break;
        visited[i] = 1;
        const cx = i % n;
        const cy = (i / n) | 0;
        const flow = riverD[i];
        nodes.push({
          cx,
          cy,
          flow,
          width: 0.6 + Math.pow(flow, 0.8) * 9,
        });
        const elev = this.height.data[i];
        const next = downIdx[i];
        if (next < 0) {
          mouthIsSea = elev < this.params.seaLevel;
          break;
        }
        if (this.height.data[next] < this.params.seaLevel) {
          mouthIsSea = true;
          // include one node in the sea for a clean mouth
          nodes.push({
            cx: next % n,
            cy: (next / n) | 0,
            flow: riverD[next],
            width: nodes[nodes.length - 1].width * 1.15,
          });
          break;
        }
        if (isRiver[next] === 0 && this.height.data[next] >= this.params.seaLevel) {
          // flow ends in a basin (a lake)
          break;
        }
        i = next;
      }
      if (nodes.length < 4) return;
      let len = 0;
      for (let k = 1; k < nodes.length; k++) {
        len += Math.hypot(nodes[k].cx - nodes[k - 1].cx, nodes[k].cy - nodes[k - 1].cy) * this.cellUnits;
      }
      let maxFlow = 0;
      for (const nd of nodes) maxFlow = Math.max(maxFlow, nd.flow);
      rivers.push({
        id: rivers.length,
        name: '',
        nodes,
        maxFlow,
        lengthUnits: len,
        mouthIsSea,
      });
    };

    // Headwaters first: river cells with no upstream river neighbour.
    for (let cy = 1; cy < n - 1; cy++) {
      for (let cx = 1; cx < n - 1; cx++) {
        const i = cy * n + cx;
        if (!isRiver[i] || visited[i]) continue;
        if (riverD[i] > 0.34) continue; // major trunk handled below
        let upstream = false;
        for (let d = 0; d < 8; d++) {
          const j = (cy + DIRS[d][1]) * n + (cx + DIRS[d][0]);
          // A neighbour flows into us and is itself a river cell.
          if (isRiver[j] && downIdx[j] === i) {
            upstream = true;
            break;
          }
        }
        if (!upstream) buildFrom(i);
      }
    }
    // Then the trunk segments that were skipped.
    for (let cy = 1; cy < n - 1; cy++) {
      for (let cx = 1; cx < n - 1; cx++) {
        const i = cy * n + cx;
        if (!isRiver[i] || visited[i]) continue;
        buildFrom(i);
      }
    }
    // Keep only significant rivers, sorted by size.
    this.rivers = rivers
      .filter((r) => r.nodes.length > 8 || r.maxFlow > 0.4)
      .sort((a, b) => b.maxFlow * b.nodes.length - a.maxFlow * a.nodes.length)
      .slice(0, 14)
      .map((r, idx) => ({ ...r, id: idx }));
  }

  private buildWaterProximity(): void {
    const n = this.size;
    const prox = this.waterProximity.data;
    const h = this.height.data;
    const lake = this.lakeDepth.data;
    // Multi-pass spread from water cells: cheap distance-ish falloff.
    prox.fill(0);
    const isWater = new Uint8Array(n * n);
    for (let i = 0; i < h.length; i++) {
      if (h[i] < this.params.seaLevel + 0.004 || lake[i] > 0.0022 || this.river.data[i] > 0.05) isWater[i] = 1;
      prox[i] = isWater[i] ? 1 : 0;
    }
    let src = Float32Array.from(prox);
    for (let pass = 0; pass < 10; pass++) {
      const tmp = Float32Array.from(src);
      for (let cy = 1; cy < n - 1; cy++) {
        for (let cx = 1; cx < n - 1; cx++) {
          const i = cy * n + cx;
          let best = tmp[i];
          for (let d = 0; d < 8; d++) {
            const v = tmp[i + DIRS[d][1] * n + DIRS[d][0]];
            if (v > best) best = v;
          }
          src[i] = Math.max(tmp[i], best - 0.085);
        }
      }
    }
    for (let i = 0; i < prox.length; i++) prox[i] = clamp01(src[i]);
  }

  /** Step 3 — temperature, wind, rainfall, humidity. */
  private buildClimate(): void {
    const n = this.size;
    const h = this.height.data;
    const temp = this.tempMean.data;
    const moist = this.moistureMean.data;
    const rain = this.rainfall.data;
    const cont = this.continentality.data;
    const exposure = this.windExposure.data;
    const rng = new Random(this.params.seed + ':climate');
    const wdx = Math.cos(this.params.windDirection);
    const wdy = Math.sin(this.params.windDirection);

    // Latitude proxy: north is colder (y = 0 is the north edge).
    const latGradient = rng.range(16, 26);
    for (let cy = 0; cy < n; cy++) {
      const v = cy / n;
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const elevation = this.elevationOf(h[i]);
        const lat = lerp(latGradient * 0.55, -latGradient * 0.45, v);
        const local = this.noiseB.fbm(cx * 0.02, cy * 0.02, 3) * 1.8;
        temp[i] = CLIMATE.baseTemp + this.params.temperatureBias + lat * 0.55 + local - Math.max(0, elevation) * 0.29;
      }
    }

    // Wind exposure: how much a cell faces into the prevailing wind.
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const px = clamp(cx - wdx * 3, 0, n - 1);
        const py = clamp(cy - wdy * 3, 0, n - 1);
        const up = this.height.sample(px, py);
        const local = h[i];
        exposure[i] = clamp01(0.5 + (local - up) * 26);
      }
    }

    // Air-mass sweep: moisture picked up over water, rained out on rising ground.
    const air = new Float32Array(n * n);
    const order: number[] = [];
    for (let i = 0; i < n * n; i++) order.push(i);
    const proj = new Float32Array(n * n);
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) proj[cy * n + cx] = cx * wdx + cy * wdy;
    }
    order.sort((a, b) => proj[a] - proj[b]);

    const seaLevel = this.params.seaLevel;
    const lake = this.lakeDepth.data;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const cx = i % n;
      const cy = (i / n) | 0;
      const ux = Math.round(cx - wdx * 1.6);
      const uy = Math.round(cy - wdy * 1.6);
      let incoming = 0.55; // base ocean moisture advected in from off-map
      if (ux >= 0 && uy >= 0 && ux < n && uy < n) {
        const j = uy * n + ux;
        if (proj[j] < proj[i]) incoming = air[j];
      }
      const isWater = h[i] < seaLevel + 0.002 || lake[i] > 0.0022;
      // Water surfaces evaporate strongly; land re-evaporates a little.
      const evap = isWater ? 0.94 : 0.3;
      let a = lerp(incoming, evap, 0.55);
      // Orographic lift: rising air cools and drops its load.
      const upx = clamp(Math.round(cx - wdx * 1.6), 0, n - 1);
      const upy = clamp(Math.round(cy - wdy * 1.6), 0, n - 1);
      const dElev = h[i] - h[upy * n + upx];
      const lift = isWater ? 0 : clamp01(dElev * 9);
      const tempF = clamp01((temp[i] + 6) / 30);
      const hold = 0.25 + 0.75 * tempF; // cold air holds less water
      const raining = clamp01(lift * TERRAIN.rainLift + TERRAIN.rainBase) * hold;
      const out = Math.max(0, a - a * raining);
      rain[i] = (a - out) * (170 * this.params.rainfallBias);
      a = out;
      // Continental interiors are drier (rain has already fallen).
      a *= isWater ? 0.995 : 0.981;
      air[i] = a;
    }

    // Convert rainfall to a 0..1 wetness. The reference is a high percentile of
    // *land* rainfall rather than the map maximum: one storm-soaked ridge should
    // not decide what "wet" means, and the ocean should not set the scale for
    // what grows on shore.
    const landRain: number[] = [];
    for (let i = 0; i < rain.length; i++) if (h[i] >= this.params.seaLevel) landRain.push(rain[i]);
    landRain.sort((a, b) => a - b);
    const refRain = Math.max(0.5, landRain[Math.floor(landRain.length * 0.97)] ?? 1);
    for (let i = 0; i < rain.length; i++) {
      const v = rain[i] / refRain;
      moist[i] = clamp01(Math.pow(v, 0.78));
    }
    // Coastal humidity: proximity to water increases moisture (fog belts).
    const prox = this.waterProximity.data;
    for (let i = 0; i < moist.length; i++) {
      moist[i] = clamp01(moist[i] * 0.86 + prox[i] * 0.22);
    }
    // Smooth the moisture field so biomes form coherent regions.
    this.moistureMean.blur(2, 1);

    // Continentality: distance from the sea drives seasonal extremes.
    for (let i = 0; i < cont.length; i++) {
      cont[i] = clamp01(1 - prox[i] * 0.75 + (1 - moist[i]) * 0.3);
    }
  }

  /** Step 4 — soil fertility from geology, deposition, slope and vegetation history. */
  private buildSoil(): void {
    const n = this.size;
    const f = this.fertility.data;
    const h = this.height.data;
    const slope = this.slope.data;
    const prox = this.waterProximity.data;
    const moist = this.moistureMean.data;

    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const geo = 0.5 + this.noiseA.fbm(cx * 0.045 + 21, cy * 0.045 - 13, 4) * 0.5;
        const deposition = clamp01(this.river.data[i] * 0.8 + prox[i] * 0.45);
        const flat = 1 - clamp01(slope[i] * 3.2);
        const wet = moist[i];
        let fert = geo * 0.42 + deposition * 0.3 + flat * 0.16 + wet * 0.2;
        // Very dry and very cold soils are thin.
        fert *= lerp(0.55, 1.0, clamp01(wet * 1.4));
        if (h[i] < this.params.seaLevel) fert = 0.05;
        f[i] = clamp01(fert);
      }
    }
    this.fertility.blur(1, 1);
    const det = this.detritus.data;
    const org = this.organic.data;
    const moistD = this.soilMoisture.data;
    for (let i = 0; i < det.length; i++) {
      det[i] = f[i] * 0.25;
      org[i] = f[i] * 0.35;
      moistD[i] = clamp01(moist[i] * 1.1) * 0.75;
    }
  }

  /** Step 5 — classify biomes from the environmental fields. */
  classifyBiomes(): void {
    const n = this.size;
    const h = this.height.data;
    const temp = this.tempMean.data;
    const moist = this.moistureMean.data;
    const slope = this.slope.data;
    const lake = this.lakeDepth.data;
    const river = this.river.data;
    const prox = this.waterProximity.data;
    const seaLevel = this.params.seaLevel;
    const b = this.biome.data;
    const land = this.land;

    for (let i = 0; i < h.length; i++) {
      const elev = this.elevationOf(h[i]);
      const t = temp[i];
      const m = moist[i];
      const steep = slope[i];

      if (h[i] < seaLevel - 0.0005) {
        b[i] = Biome.Ocean;
        land[i] = 0;
        continue;
      }
      land[i] = 1;
      if (lake[i] > 0.0026) {
        b[i] = Biome.Lake;
        continue;
      }
      if (river[i] > 0.06) {
        b[i] = Biome.River;
        continue;
      }

      // Climate first, elevation second: what grows somewhere is decided by
      // how warm and how wet it is, and height only enters through temperature.
      let biome: Biome;
      if (t < -2 || (t < 1.2 && elev > 34)) biome = Biome.Snow;
      else if (t < 2) biome = m > 0.5 ? Biome.BorealForest : Biome.Tundra;
      else if (t < 5) biome = m > 0.52 ? Biome.BorealForest : m > 0.34 ? Biome.Tundra : Biome.Steppe;
      else if (elev > 30 && t < 8) biome = Biome.Alpine;
      else if (steep > 0.5 && elev > 14) biome = Biome.Alpine;
      else if (m < 0.2) biome = Biome.Desert;
      else if (m < 0.34) biome = t > 17 && m < 0.26 ? Biome.Desert : Biome.Steppe;
      else if (elev < 1.4 && prox[i] > 0.72 && m > 0.62) biome = Biome.Marsh;
      else if (elev < 2.2 && prox[i] > 0.78) biome = Biome.Coast;
      else if (m > 0.66) biome = Biome.TemperateForest;
      else if (m > 0.56) biome = t > 17 ? Biome.TemperateForest : Biome.Grassland;
      else biome = Biome.Grassland;
      b[i] = biome;
    }

    // Coastal smoothing: a beach ring wherever land meets the sea.
    for (let cy = 1; cy < n - 1; cy++) {
      for (let cx = 1; cx < n - 1; cx++) {
        const i = cy * n + cx;
        if (b[i] === Biome.Ocean) continue;
        let nearSea = false;
        for (let d = 0; d < 8; d++) {
          if (b[i + DIRS[d][1] * n + DIRS[d][0]] === Biome.Ocean) {
            nearSea = true;
            break;
          }
        }
        if (nearSea && this.elevationOf(h[i]) < 3.5 && b[i] !== Biome.Lake && b[i] !== Biome.River) {
          b[i] = Biome.Coast;
        }
      }
    }
  }

  /** Step 6 — initial plant cover derived from biome suitability. */
  seedInitialVegetation(seedDensityFields: Field[] = []): void {
    const n = this.size;
    this.initialPlantDensity = seedDensityFields.length
      ? seedDensityFields
      : PLANT_LAYERS.map(() => new Field(n));
    const moist = this.moistureMean.data;
    const temp = this.tempMean.data;
    for (let i = 0; i < this.height.data.length; i++) {
      const biomeIdx = this.biome.data[i];
      const def = BIOMES[biomeIdx];
      const soil = this.fertility.data[i];
      for (let L = 0; L < this.initialPlantDensity.length; L++) {
        const suit = def?.plants[L] ?? 0;
        if (suit <= 0.001) {
          this.initialPlantDensity[L].data[i] = 0;
          continue;
        }
        const growthCondition =
          clamp01(1.15 - Math.abs(moist[i] - 0.62) * 1.5) * clamp01((temp[i] + 12) / 26) * 0.5 + 0.5;
        const noise = 0.75 + this.noiseC.fbm(i % n, (i / n) | 0, 3) * 0.5;
        // Start the world thick with plants: this is a young, ungrazeable
        // landscape, and the herbivores arrive to find it already green.
        this.initialPlantDensity[L].data[i] = clamp01(suit * (0.35 + soil * 0.75) * growthCondition * noise * this.params.seeding * 1.35);
      }
    }
  }

  initialPlantDensity: Field[] = [];

  /** Step 7 — human-readable geography. */
  private nameGeography(): void {
    const rng = new Random(this.params.seed + ':names');
    const prefixes = [
      'Ash', 'Thorn', 'Grey', 'Amber', 'Hollow', 'Broken', 'Long', 'Cold', 'Sun', 'Wolf', 'Raven', 'Elk',
      'Stone', 'Mist', 'Fern', 'Hollow', 'Wyrm', 'Bright', 'Slow', 'Wild', 'Ember', 'Frost', 'Dawn', 'Dusk',
    ];
    const lakeNames = ['Lake', 'Tarn', 'Mere', 'Pool'];
    const riverNames = ['River', 'Beck', 'Fork', 'Run', 'Wash'];
    const peakNames = ['Mount', 'Peak', 'Crag', 'Spire', 'Horn'];
    const suffixes = ['fall', 'water', 'hollow', 'reach', 'mere', 'gate', 'stead', 'wood', 'moor', 'strand', 'ridge', 'vale'];
    const name = (kind: string) => {
      const p = rng.pick(prefixes);
      const s = rng.pick(suffixes);
      return kind ? `${rng.pick(peakNames)} ${p}${s}` : `${p}${s}`;
    };

    this.landmarks = [];
    const n = this.size;

    // Peaks: local maxima above the treeline.
    const peaks: { i: number; h: number }[] = [];
    for (let cy = 2; cy < n - 2; cy += 2) {
      for (let cx = 2; cx < n - 2; cx += 2) {
        const i = cy * n + cx;
        const hv = this.height.data[i];
        if (hv < this.params.seaLevel + 0.35) continue;
        let isMax = true;
        for (let d = 0; d < 8; d++) {
          if (this.height.data[i + DIRS[d][1] * n + DIRS[d][0]] > hv) {
            isMax = false;
            break;
          }
        }
        if (isMax) peaks.push({ i, h: hv });
      }
    }
    peaks.sort((a, b) => b.h - a.h);
    for (let k = 0; k < Math.min(6, peaks.length); k++) {
      const pk = peaks[k];
      const cx = pk.i % n;
      const cy = (pk.i / n) | 0;
      this.landmarks.push({
        kind: 'peak',
        name: name('peak'),
        cx,
        cy,
        x: this.cellToWorldX(cx),
        y: this.cellToWorldY(cy),
        value: this.elevationOf(pk.h),
      });
    }

    // Volcanoes get names too.
    for (const v of this.volcanoes) {
      v.name = name('peak');
      this.landmarks.push({ kind: 'volcano', name: v.name, cx: v.cx, cy: v.cy, x: v.x, y: v.y, value: 0 });
    }

    // Lakes: connected components of lake cells above a size threshold.
    const visited = new Uint8Array(n * n);
    const lakeCells = this.lakeDepth.data;
    const found: { volume: number; cx: number; cy: number; cells: number }[] = [];
    const stack: number[] = [];
    for (let i = 0; i < lakeCells.length; i++) {
      if (visited[i] || lakeCells[i] < 0.0022 || this.height.data[i] < this.params.seaLevel) continue;
      stack.length = 0;
      stack.push(i);
      visited[i] = 1;
      let volume = 0;
      let cells = 0;
      let sx = 0;
      let sy = 0;
      while (stack.length) {
        const j = stack.pop() as number;
        const jx = j % n;
        const jy = (j / n) | 0;
        volume += lakeCells[j];
        cells++;
        sx += jx;
        sy += jy;
        for (let d = 0; d < 8; d++) {
          const nx = jx + DIRS[d][0];
          const ny = jy + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const k = ny * n + nx;
          if (!visited[k] && lakeCells[k] >= 0.0022 && this.height.data[k] >= this.params.seaLevel) {
            visited[k] = 1;
            stack.push(k);
          }
        }
      }
      if (cells > 22) found.push({ volume, cx: Math.round(sx / cells), cy: Math.round(sy / cells), cells });
    }
    found.sort((a, b) => b.volume - a.volume);
    this.lakes = found.slice(0, 8).map((f, idx) => ({
      id: idx,
      name: `${rng.pick(lakeNames)} ${rng.pick(prefixes)}${rng.pick(suffixes)}`.replace('Lake Lake', 'Lake'),
      cx: f.cx,
      cy: f.cy,
      x: this.cellToWorldX(f.cx),
      y: this.cellToWorldY(f.cy),
      cells: f.cells,
      volume: f.volume,
    }));
    for (const l of this.lakes) {
      this.landmarks.push({ kind: 'lake', name: l.name, cx: l.cx, cy: l.cy, x: l.x, y: l.y, value: l.cells });
    }

    // Rivers get names, longest first.
    for (let i = 0; i < this.rivers.length; i++) {
      const r = this.rivers[i];
      r.name = `${rng.pick(prefixes)} ${rng.pick(riverNames)}`;
      const mid = r.nodes[Math.floor(r.nodes.length / 2)];
      this.landmarks.push({
        kind: 'river',
        name: r.name,
        cx: mid.cx,
        cy: mid.cy,
        x: this.cellToWorldX(mid.cx),
        y: this.cellToWorldY(mid.cy),
        value: r.maxFlow,
      });
    }

    // Shelters: rock overhangs on steep ground — used by animals as refuges.
    let shelterTries = 0;
    while (this.caves.length < 14 && shelterTries++ < 4000) {
      const cx = rng.int(3, n - 4);
      const cy = rng.int(3, n - 4);
      const i = cy * n + cx;
      if (this.land[i] !== 1) continue;
      if (this.slope.data[i] < 0.55) continue;
      this.caves.push({
        cx,
        cy,
        x: this.cellToWorldX(cx),
        y: this.cellToWorldY(cy),
        name: `${rng.pick(prefixes)} Hollow`,
      });
    }

    // Named regions for territory labels.
    this.regions = [];
    const regionNames = [
      'Northwest', 'Northern', 'Northeast',
      'Western', 'Central', 'Eastern',
      'Southwest', 'Southern', 'Southeast',
    ];
    const cellPer = this.size / 6;
    for (let ry = 0; ry < 6; ry++) {
      for (let rx = 0; rx < 6; rx++) {
        const cx = Math.floor(rx * cellPer + cellPer / 2);
        const cy = Math.floor(ry * cellPer + cellPer / 2);
        const idx = clamp(Math.round(cx), 0, n - 1) + clamp(Math.round(cy), 0, n - 1) * n;
        const biomeIdx = this.biome.data[idx] as Biome;
        const label = regionNames[Math.min(8, ry * 3 + rx)] ?? 'Central';
        const biomeWord = regionWordFor(biomeIdx);
        this.regions.push({ name: `${label} ${biomeWord}`, cx, cy, biome: biomeIdx });
      }
    }
  }

  lakes: { id: number; name: string; cx: number; cy: number; x: number; y: number; cells: number; volume: number }[] = [];

  /** Recompute slope from the current height field (after carving or sculpting). */
  computeSlope(): void {
    const n = this.size;
    const h = this.height.data;
    const slope = this.slope.data;
    let maxS = 1e-6;
    for (let cy = 1; cy < n - 1; cy++) {
      for (let cx = 1; cx < n - 1; cx++) {
        const i = cy * n + cx;
        const dx = (h[i + 1] - h[i - 1]) * 0.5;
        const dy = (h[i + n] - h[i - n]) * 0.5;
        const s = Math.hypot(dx, dy) * this.cellUnits * WORLD.heightScale * 0.1;
        slope[i] = s;
        if (s > maxS) maxS = s;
      }
    }
    const k = 1 / maxS;
    for (let i = 0; i < slope.length; i++) slope[i] = clamp01(slope[i] * k);
  }

  /** Re-derive the hydrological network after the player reshapes terrain. */
  rebuildHydrology(): void {
    this.buildHydrology();
    this.classifyBiomes();
  }

  /** Summary used by world cards and the encyclopedia header. */
  summary(): { landPct: number; forestPct: number; waterPct: number; biomeCounts: Record<string, number> } {
    const counts: Record<string, number> = {};
    let land = 0;
    let water = 0;
    const total = this.size * this.size;
    for (let i = 0; i < total; i++) {
      const b = this.biome.data[i] as Biome;
      const key = BIOMES[b]?.key ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      if (isWaterBiome(b)) water++;
      else land++;
    }
    const forestPct = ((counts['temperate_forest'] ?? 0) + (counts['boreal_forest'] ?? 0)) / total;
    return { landPct: land / total, forestPct, waterPct: water / total, biomeCounts: counts };
  }
}

function regionWordFor(b: Biome): string {
  switch (b) {
    case Biome.Ocean:
      return 'Shelf';
    case Biome.Coast:
      return 'Reach';
    case Biome.Marsh:
      return 'Marshes';
    case Biome.Grassland:
      return 'Plains';
    case Biome.Steppe:
      return 'Steppe';
    case Biome.TemperateForest:
      return 'Woodlands';
    case Biome.BorealForest:
      return 'Taiga';
    case Biome.Alpine:
      return 'Highlands';
    case Biome.Snow:
      return 'Icefields';
    case Biome.Desert:
      return 'Badlands';
    case Biome.Tundra:
      return 'Tundra';
    case Biome.Lake:
      return 'Lakes';
    case Biome.River:
      return 'Riverlands';
    default:
      return 'Wilds';
  }
}
