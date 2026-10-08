import { clamp01, lerp } from '../core/math';
import { ECOLOGY } from '../core/config';
import type { Terrain } from './terrain';
import type { Climate } from './climate';

/**
 * The soil engine: decomposition, humification, erosion, leaching and the
 * nutrient release that closes the loop from corpses and litter back into
 * living plants. Work is spread over rolling slices of the grid.
 */
export class Soil {
  terrain: Terrain;
  climate: Climate;

  /** Rolling diagnostics. */
  decompositionRate = 0;
  erosionRate = 0;
  /** Total soil organic carbon proxy, for reports. */
  organicTotal = 0;

  private slice = 0;
  private slices = 8;
  private scratch: Float32Array;

  constructor(terrain: Terrain, climate: Climate) {
    this.terrain = terrain;
    this.climate = climate;
    this.scratch = new Float32Array(terrain.size);
  }

  update(dtMinutes: number): void {
    const t = this.terrain;
    const n = t.size;
    const hours = dtMinutes / 60;
    const det = t.detritus.data;
    const fert = t.fertility.data;
    const org = t.organic.data;
    const biota = t.soilBiota.data;
    const moist = t.soilMoisture.data;
    const canopy = t.canopy.data;
    const mud = t.mud.data;

    // Process a horizontal band per update; a full sweep completes every
    // (slices × cadence) sim-minutes.
    const bandStart = Math.floor((this.slice * n) / this.slices);
    const bandEnd = Math.floor(((this.slice + 1) * n) / this.slices);
    this.slice = (this.slice + 1) % this.slices;

    let decomposed = 0;
    let eroded = 0;
    let orgSum = 0;

    // Rainfall mean is constant across the band: read it once, not per cell.
    const rain = this.climate.rainIntensity.stats().mean;

    for (let cy = bandStart; cy < bandEnd; cy++) {
      const worldY = t.cellToWorldY(cy);
      void worldY;
      for (let cx = 0; cx < n; cx++) {
        const i = cy * n + cx;
        const x = t.cellToWorldX(cx);
        const temp = this.climate.temperatureAtCellFast(cx, cy);
        const m = moist[i];
        // Decomposer activity: warm and damp is fast, frozen or arid is slow.
        const q10 = Math.pow(2, clamp01((temp - 5) / 10) * 1.0);
        const wetFactor = clamp01(m * 1.6) * clamp01(1.4 - m * 0.4);
        const biotaFactor = clamp01(0.25 + biota[i] * 1.5);
        const rate = ECOLOGY.decompositionPerHour * hours * q10 * wetFactor * biotaFactor;

        if (det[i] > 0.0005) {
          const consumed = Math.min(det[i], det[i] * rate * 0.55 + 0.00002 * hours);
          det[i] -= consumed;
          decomposed += consumed;
          // Part becomes plant-available nutrients, part becomes stable humus.
          fert[i] = clamp01(fert[i] + consumed * ECOLOGY.humification * 3.2);
          org[i] = clamp01(org[i] + consumed * (1 - ECOLOGY.humification) * 0.55);
        }

        // Soil biota self-regulates toward the food supply + moisture.
        const food = det[i] + org[i] * 0.4;
        const biotaTarget = clamp01(0.12 + food * 1.1) * clamp01(m * 1.8) * clamp01((temp + 6) / 26);
        biota[i] = lerp(biota[i], biotaTarget, 0.05 * hours);

        // Leaching: wet climates lose soluble nutrients; arid ones accumulate salts.
        const leach = clamp01(m - 0.55) * 0.0006 * hours * clamp01(1 - t.canopy.data[i]);
        fert[i] = clamp01(fert[i] - leach);

        // Erosion: bare, steep, wet ground loses topsoil downhill.
        const bare = clamp01(1 - canopy[i] * 1.3);
        const steep = t.slope.data[i];
        if (bare > 0.3 && steep > 0.15) {
          const loss = ECOLOGY.erosionBase * hours * bare * steep * (0.4 + rain) * (1 + mud[i]);
          const taken = Math.min(fert[i], loss);
          fert[i] -= taken;
          // Deposit downhill (one cell along the steepest descent) or lose it.
          const below = cy + 1 < n ? (cy + 1) * n + cx : -1;
          if (below >= 0 && t.height.data[below] < t.height.data[i]) fert[below] = clamp01(fert[below] + taken * 0.55);
          eroded += taken;
        }

        // Arid soils build up a little fertility from dust and dead roots.
        if (m < 0.15) fert[i] = clamp01(fert[i] + 0.00002 * hours * (1 + org[i]));
        orgSum += org[i];
      }
    }

    this.decompositionRate = lerp(this.decompositionRate, decomposed, 0.2);
    this.erosionRate = lerp(this.erosionRate, eroded, 0.2);
    this.organicTotal = (orgSum / Math.max(1, bandEnd - bandStart)) * n;
  }

  /** Add organic matter (carcasses, dung, fallen leaves). */
  addDetritus(cx: number, cy: number, amount: number): void {
    const t = this.terrain;
    if (cx < 0 || cy < 0 || cx >= t.size || cy >= t.size) return;
    const i = cy * t.size + cx;
    t.detritus.data[i] = clamp01(t.detritus.data[i] + amount);
  }

  /** Bulk fertilisation (player tool, ash from fire, flooding silt). */
  addNutrients(cx: number, cy: number, amount: number): void {
    const t = this.terrain;
    if (cx < 0 || cy < 0 || cx >= t.size || cy >= t.size) return;
    const i = cy * t.size + cx;
    t.fertility.data[i] = clamp01(t.fertility.data[i] + amount);
  }

  save(): Record<string, unknown> {
    return {
      detritus: this.terrain.detritus.serialise(),
      fertility: this.terrain.fertility.serialise(),
      organic: this.terrain.organic.serialise(),
      soilBiota: this.terrain.soilBiota.serialise(),
      slice: this.slice,
    };
  }

  load(d: Record<string, any>): void {
    if (d.detritus) this.terrain.detritus.restore(d.detritus);
    if (d.fertility) this.terrain.fertility.restore(d.fertility);
    if (d.organic) this.terrain.organic.restore(d.organic);
    if (d.soilBiota) this.terrain.soilBiota.restore(d.soilBiota);
    this.slice = d.slice ?? 0;
  }
}
