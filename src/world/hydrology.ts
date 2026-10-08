import { clamp, clamp01, lerp } from '../core/math';
import { CLIMATE } from '../core/config';
import type { Terrain } from './terrain';
import type { Climate } from './climate';

export interface WaterDelta {
  cx: number;
  cy: number;
  delta: number;
}

/**
 * Hydrology: rainfall, snow pack, infiltration, evaporation and the lateral
 * flow that lets water pool in hollows, fill and drain lakes, and flood.
 *
 * The flow solver only visits cells that currently hold water (plus the ring
 * around them) so cost tracks the *wet* area rather than the whole map.
 */
/** 8-neighbour offsets: 0..3 orthogonal, 4..7 diagonal. */
const REACH_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const REACH_DY = [0, 0, 1, -1, 1, -1, 1, -1];


export class Hydrology {
  private terrain: Terrain;
  private climate: Climate;

  /** Compact list of land cells currently holding water. */
  private wetList: Int32Array;
  private wetCount = 0;
  private wetFlag: Uint8Array;
  /** Scratch surface heights for the flow pass. */
  private surface: Float32Array;
  private flowScratch: Float32Array;

  /** Water reach map: distance (world units) to the nearest drinkable water. */
  private reachDist = new Float32Array(0);
  private reachX = new Int32Array(0);
  private reachY = new Int32Array(0);
  private reachQueue = new Int32Array(0);
  private reachMax = 400;
  private reachAge = 0;
  /** Set when the map is stale (rain, flow or a terrain edit). */
  reachDirty = true;

  /**
   * Nearest drinkable water to a world position, or null beyond the search
   * range. Constant time: it reads the reach map built by `buildReachMap`.
   */
  waterReach(x: number, y: number): { x: number; y: number; distance: number } | null {
    const t = this.terrain;
    if (this.reachDirty) {
      this.reachDirty = false;
      this.buildReachMap();
    }
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const i = cy * t.size + cx;
    const d = this.reachDist[i];
    if (d < 0 || d > this.reachMax) return null;
    return { x: t.cellToWorldX(this.reachX[i]), y: t.cellToWorldY(this.reachY[i]), distance: d };
  }


  /** Total liquid water on land, for the HUD and biome stats. */
  landWaterVolume = 0;
  snowVolume = 0;
  /** 0..1 how saturated the world is (drought detection support). */
  wetnessIndex = 0.5;

  constructor(terrain: Terrain, climate: Climate) {
    this.terrain = terrain;
    this.climate = climate;
    const n = terrain.size * terrain.size;
    this.wetList = new Int32Array(n);
    this.wetFlag = new Uint8Array(n);
    this.surface = new Float32Array(n);
    this.flowScratch = new Float32Array(n);
    this.refreshWetSet(true);
  }

  /**
   * Rebuild the reach map: for every land cell, the distance to the nearest
   * cell an animal can drink from, and which way to walk to get there. It is a
   * multi-source Dijkstra over the 8-neighbourhood, rebuilt when the water
   * changes, and it answers "where is water?" in constant time — thousands of
   * animals asking every few minutes would otherwise dominate the frame.
   */
  private buildReachMap(): void {
    const t = this.terrain;
    const n = t.size;
    if (this.reachDist.length !== n * n) {
      this.reachDist = new Float32Array(n * n);
      this.reachX = new Int32Array(n * n);
      this.reachY = new Int32Array(n * n);
      this.reachQueue = new Int32Array(n * n);
    }
    const depth = t.waterDepth.data;
    const h = t.height.data;
    const sea = t.params.seaLevel;
    const dist = this.reachDist;
    const rx = this.reachX;
    const ry = this.reachY;
    const queue = this.reachQueue;
    const step = t.cellUnits;
    // Seed every drinkable cell, then breadth-first over the 8-neighbourhood.
    // A FIFO sweep with two edge lengths is not exact Euclidean distance, but
    // it is monotone, complete and O(cells) — and it never leaves a reachable
    // cell marked unreachable, which is what matters to a thirsty animal.
    let head = 0;
    let tail = 0;
    for (let i = 0; i < dist.length; i++) {
      const isSea = h[i] < sea - 0.0005;
      const drink = depth[i] > 0.05 && (!isSea || depth[i] > 0.4);
      if (drink) {
        dist[i] = 0;
        rx[i] = i % n;
        ry[i] = (i / n) | 0;
        queue[tail++] = i;
      } else {
        dist[i] = -1;
        rx[i] = -1;
        ry[i] = -1;
      }
    }
    const maxDist = this.reachMax;
    while (head < tail) {
      const i = queue[head++];
      const d = dist[i];
      if (d >= maxDist) continue;
      const cx = i % n;
      const cy = (i / n) | 0;
      for (let dir = 0; dir < 8; dir++) {
        const nx = cx + REACH_DX[dir];
        const ny = cy + REACH_DY[dir];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (dist[j] >= 0) continue;
        dist[j] = d + (dir < 4 ? step : step * 1.35);
        rx[j] = rx[i];
        ry[j] = ry[i];
        queue[tail++] = j;
      }
    }
  }

  /** Rebuild the active water set. Cheap enough to run every few minutes. */
  refreshWetSet(includeSea = false): void {
    const t = this.terrain;
    const n = t.size;
    const depth = t.waterDepth.data;
    const h = t.height.data;
    const sea = t.params.seaLevel;
    let count = 0;
    for (let i = 0; i < depth.length; i++) {
      const isSea = h[i] < sea - 0.0005;
      const wet = depth[i] > 0.002 && (includeSea || !isSea);
      this.wetFlag[i] = wet ? 1 : 0;
      if (wet) this.wetList[count++] = i;
    }
    this.wetCount = count;
  }

  update(dtMinutes: number): void {
    const hours = dtMinutes / 60;
    const t = this.terrain;
    const n = t.size;
    const depth = t.waterDepth.data;
    const h = t.height.data;
    const snow = t.snow.data;
    const mud = t.mud.data;
    const soilMoisture = t.soilMoisture.data;
    const sea = t.params.seaLevel;
    const sun = this.climate.lightLevel;
    const globalWarm = this.climate.hasEvent('heatwave') ? 1.45 : 1;
    const cold = this.climate.hasEvent('coldwave') ? 0.6 : 1;

    /* --- 1. precipitation, snow, infiltration, evaporation --- */
    let snowTotal = 0;
    for (let cy = 0; cy < n; cy++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const temp = this.climate.temperatureAtCellFast(cx, cy);
        const precip = this.climate.precipitationAtCellFast(cx, cy) * hours * 0.012; // world units of water per hour
        const isSea = h[i] < sea - 0.0005;

        if (precip > 0) {
          if (temp < 0.6) {
            // Snow accumulates with a density factor.
            snow[i] += precip * (temp < -4 ? 2.6 : 1.6);
          } else if (isSea) {
            // falls straight into the sea
          } else {
            depth[i] += precip * 0.85;
            soilMoisture[i] = clamp01(soilMoisture[i] + precip * 1.8);
          }
        }

        // Snow melt: temperature driven, sunlight matters.
        if (snow[i] > 0) {
          const melt = clamp01((temp - 0.4) * 0.09) * (0.6 + sun * 0.8) * hours;
          if (melt > 0) {
            const melted = Math.min(snow[i], melt);
            snow[i] -= melted;
            if (!isSea) {
              depth[i] += melted * 0.7;
              soilMoisture[i] = clamp01(soilMoisture[i] + melted * 1.4);
            }
          }
          snowTotal += snow[i];
        }

        // Evaporation from open water and bare wet soil.
        const evap = CLIMATE.evaporationPerHour * hours * (0.35 + clamp01(temp / 28)) * globalWarm * cold;
        if (depth[i] > 0.002) {
          const ev = Math.min(depth[i], evap * (isSea ? 0.85 : 1.0));
          if (!isSea) depth[i] -= ev;
        }
        if (soilMoisture[i] > 0.06) {
          soilMoisture[i] = Math.max(0.05, soilMoisture[i] - evap * 0.55);
        }
        // Capillary loss to the air is stronger in wind.
        if (this.climate.windSpeed > 1.6) soilMoisture[i] = Math.max(0.05, soilMoisture[i] - 0.0004 * hours * this.climate.windSpeed);

        // Mud: bare, wet ground turns sticky.
        const bare = 1 - clamp01(t.canopy.data[i] * 1.2);
        const want = clamp01((soilMoisture[i] - 0.42) * 2.2) * bare;
        mud[i] = lerp(mud[i], want, 0.08 * hours);
      }
    }
    this.snowVolume = snowTotal;

    // Sea stays put (treated as an infinite reservoir), and glaciers hold their ice.
    this.seaFill();

    /* --- 2. lateral flow over the wet set --- */
    this.flow(dtMinutes);

    /* --- 3. rivers: discharge-driven depth --- */
    this.updateRivers(hours);

    // Track land water volume for reports.
    let vol = 0;
    for (let i = 0; i < depth.length; i++) {
      if (h[i] < sea - 0.0005) continue;
      vol += depth[i];
    }
    this.landWaterVolume = vol;
    this.wetnessIndex = lerp(this.wetnessIndex, clamp01(vol / (t.size * t.size * 0.06)), 0.1);

    // Refresh the active set periodically so newly filled hollows join in.
    if (Math.random() < 0.25) this.refreshWetSet(false);

    const anyRain = this.climate.rainIntensity.stats().mean > 0.02;
    if (this.reachDirty || this.reachAge > (anyRain ? 180 : 1200)) {
      this.reachAge = 0;
      this.reachDirty = false;
      this.buildReachMap();
    }
  }

  /** Cells below sea level are always full to sea level. */
  seaFill(): void {
    const t = this.terrain;
    const sea = t.params.seaLevel;
    const h = t.height.data;
    const depth = t.waterDepth.data;
    for (let i = 0; i < h.length; i++) {
      if (h[i] < sea - 0.0005) {
        const want = (sea - h[i]) * 1;
        if (depth[i] < want) depth[i] = want;
        // River mouths and coastal cells never dry out below sea level.
      }
    }
  }

  /** One relaxation pass of shallow-water lateral flow. */
  private flow(dtMinutes: number): void {
    const t = this.terrain;
    const n = t.size;
    const depth = t.waterDepth.data;
    const h = t.height.data;
    const surf = this.surface;
    const delta = this.flowScratch;
    delta.fill(0);
    const sea = t.params.seaLevel;
    const k = clamp01(dtMinutes / 30) * 0.22;

    const list = this.wetList;
    for (let w = 0; w < this.wetCount; w++) {
      const i = list[w];
      if (this.wetFlag[i] === 0) continue;
      if (h[i] < sea - 0.0005) continue; // sea handled by seaFill
      const cx = i % n;
      const cy = (i / n) | 0;
      const d = depth[i];
      if (d <= 0.0025) continue;
      const s = h[i] + d;
      surf[i] = s;
      // Move water to the lowest neighbouring surface.
      let lowest = -1;
      let lowestS = s;
      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
        const ny = cy + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        const sj = h[j] + Math.max(depth[j], 0);
        if (sj < lowestS - 1e-7) {
          lowestS = sj;
          lowest = j;
        }
      }
      if (lowest >= 0 && s > lowestS) {
        // Water cannot flow into a cell whose surface is below the bed.
        const head = s - Math.max(lowestS, h[lowest]);
        let move = Math.min(d * k, head * k * 6);
        // The receiving cell's capacity: lakes fill to a flat surface, so only
        // the head difference limits the transfer (plus a per-step cap).
        const cap = Math.max(0, s - lowestS) + d * 0.05;
        move = Math.min(move, cap, d * 0.5);
        if (move > 1e-6) {
          delta[i] -= move;
          delta[lowest] += move;
        }
      }
    }
    for (let w = 0; w < this.wetCount; w++) {
      const i = this.wetList[w];
      if (delta[i] === 0) continue;
      const nd = depth[i] + delta[i];
      depth[i] = nd < 0 ? 0 : nd;
    }
  }

  /** River channel depth follows discharge, so droughts shrink rivers. */
  private updateRivers(hours: number): void {
    const t = this.terrain;
    const rainMean = clamp01(this.climate.rainIntensity.stats().mean * 0.6 + this.climate.rainfallIndex * 0.4);
    const drought = this.climate.hasEvent('drought') ? 0.28 : 1;
    for (const river of t.rivers) {
      // Discharge responds to recent rain, with a slow baseflow component.
      river.discharge = lerp(river.discharge ?? rainMean, clamp(0.25 + rainMean * 1.35, 0.05, 2.2) * drought, 0.1 * hours);
      const scale = clamp(river.discharge, 0.05, 2.5);
      for (let k = 0; k < river.nodes.length; k++) {
        const nd = river.nodes[k];
        const i = nd.cy * t.size + nd.cx;
        const channelDepth = (0.02 + nd.flow * 0.075) * Math.pow(scale, 0.7);
        if (t.height.data[i] < t.params.seaLevel - 0.0005) continue;
        const want = Math.min(channelDepth, t.riverDepth.data[i] * 22 + 0.02);
        if (t.waterDepth.data[i] < want * 0.35) {
          // Rivers push water into their channel from upstream baseflow.
          t.waterDepth.data[i] += Math.min(want * 0.35, want - t.waterDepth.data[i] + 0.01) * 0.25;
        }
        const target = want;
        t.waterDepth.data[i] = lerp(t.waterDepth.data[i], Math.max(target, 0.004), 0.1);
      }
    }
  }

  /* ------------------------ player interaction ------------------------ */

  /** Add water to a disc (used by the flood / rain tools and dam-building). */
  addWaterAt(worldX: number, worldY: number, radiusUnits: number, amount: number): void {
    const t = this.terrain;
    const cx = Math.round(t.worldToCellX(worldX));
    const cy = Math.round(t.worldToCellY(worldY));
    const r = Math.max(1, Math.round(radiusUnits / t.cellUnits));
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= t.size || y >= t.size) continue;
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d > 1) continue;
        const falloff = Math.cos(d * Math.PI * 0.5);
        const i = y * t.size + x;
        t.waterDepth.data[i] += amount * falloff;
        t.waterDepth.clampAll(0, 8);
      }
    }
    this.refreshWetSet(false);
  }

  /** Remove water (drain lakes, dry a marsh). */
  removeWaterAt(worldX: number, worldY: number, radiusUnits: number, fraction: number): void {
    const t = this.terrain;
    const cx = Math.round(t.worldToCellX(worldX));
    const cy = Math.round(t.worldToCellY(worldY));
    const r = Math.max(1, Math.round(radiusUnits / t.cellUnits));
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= t.size || y >= t.size) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        const i = y * t.size + x;
        t.waterDepth.data[i] *= 1 - fraction;
        if (t.waterDepth.data[i] < 0.002) t.waterDepth.data[i] = 0;
      }
    }
    this.refreshWetSet(false);
  }

  save(): Record<string, unknown> {
    return {
      waterDepth: this.terrain.waterDepth.serialise(),
      snow: this.terrain.snow.serialise(),
      soilMoisture: this.terrain.soilMoisture.serialise(),
      mud: this.terrain.mud.serialise(),
      landWaterVolume: this.landWaterVolume,
      riverDischarge: this.terrain.rivers.map((r) => r.discharge ?? 1),
    };
  }

  load(d: Record<string, any>): void {
    if (d.waterDepth) this.terrain.waterDepth.restore(d.waterDepth);
    if (d.snow) this.terrain.snow.restore(d.snow);
    if (d.soilMoisture) this.terrain.soilMoisture.restore(d.soilMoisture);
    if (d.mud) this.terrain.mud.restore(d.mud);
    this.landWaterVolume = d.landWaterVolume ?? 0;
    if (Array.isArray(d.riverDischarge)) {
      this.terrain.rivers.forEach((r, i) => (r.discharge = d.riverDischarge[i] ?? 1));
    }
    this.refreshWetSet(true);
  }
}
