import { Random } from '../core/rng';
import { clamp, clamp01, lerp, smoothstep } from '../core/math';
import { CLIMATE, TIME } from '../core/config';
import { Field } from './fields';
import type { Terrain } from './terrain';
import type { WorldClock } from '../core/time';

export type WeatherState =
  | 'clear'
  | 'fair'
  | 'cloudy'
  | 'overcast'
  | 'drizzle'
  | 'rain'
  | 'heavyRain'
  | 'storm'
  | 'fog'
  | 'snow';

export type ClimateEventKind = 'drought' | 'heatwave' | 'coldwave' | 'monsoon' | 'volcanicWinter';

export interface ClimateEvent {
  kind: ClimateEventKind;
  /** Remaining duration in in-game minutes. */
  remaining: number;
  total: number;
  intensity: number;
  label: string;
}

/** Synoptic weather states and their base properties. */
const WEATHER_TABLE: Record<WeatherState, { rain: number; cloud: number; wind: number; humidity: number; label: string }> = {
  clear: { rain: 0, cloud: 0.05, wind: 0.5, humidity: 0.35, label: 'Clear' },
  fair: { rain: 0, cloud: 0.28, wind: 0.7, humidity: 0.42, label: 'Fair' },
  cloudy: { rain: 0, cloud: 0.62, wind: 0.9, humidity: 0.55, label: 'Cloudy' },
  overcast: { rain: 0.05, cloud: 0.9, wind: 1.0, humidity: 0.7, label: 'Overcast' },
  drizzle: { rain: 0.3, cloud: 0.92, wind: 0.95, humidity: 0.8, label: 'Drizzle' },
  rain: { rain: 0.72, cloud: 0.97, wind: 1.15, humidity: 0.88, label: 'Rain' },
  heavyRain: { rain: 1.25, cloud: 1.0, wind: 1.4, humidity: 0.94, label: 'Heavy rain' },
  storm: { rain: 2.0, cloud: 1.0, wind: 2.5, humidity: 0.98, label: 'Storm' },
  fog: { rain: 0.02, cloud: 0.85, wind: 0.25, humidity: 0.96, label: 'Fog' },
  snow: { rain: 0.85, cloud: 1.0, wind: 1.2, humidity: 0.9, label: 'Snow' },
};

const TRANSITIONS: Record<WeatherState, [WeatherState, number][]> = {
  clear: [['clear', 0.42], ['fair', 0.36], ['cloudy', 0.16], ['fog', 0.06]],
  fair: [['clear', 0.26], ['fair', 0.3], ['cloudy', 0.3], ['drizzle', 0.08], ['fog', 0.06]],
  cloudy: [['fair', 0.24], ['cloudy', 0.3], ['overcast', 0.28], ['drizzle', 0.14], ['fog', 0.04]],
  overcast: [['cloudy', 0.22], ['overcast', 0.3], ['drizzle', 0.24], ['rain', 0.18], ['fog', 0.06]],
  drizzle: [['overcast', 0.26], ['drizzle', 0.26], ['rain', 0.32], ['fog', 0.16]],
  rain: [['drizzle', 0.24], ['rain', 0.32], ['heavyRain', 0.26], ['storm', 0.1], ['overcast', 0.08]],
  heavyRain: [['rain', 0.36], ['heavyRain', 0.28], ['storm', 0.26], ['overcast', 0.1]],
  storm: [['heavyRain', 0.42], ['rain', 0.34], ['storm', 0.18], ['overcast', 0.06]],
  fog: [['fog', 0.24], ['clear', 0.3], ['fair', 0.28], ['cloudy', 0.18]],
  snow: [['snow', 0.4], ['overcast', 0.3], ['cloudy', 0.2], ['heavyRain', 0.1]],
};

const STATE_LABELS: Record<WeatherState, string> = {
  clear: 'Clear',
  fair: 'Fair',
  cloudy: 'Cloudy',
  overcast: 'Overcast',
  drizzle: 'Drizzle',
  rain: 'Rain',
  heavyRain: 'Heavy rain',
  storm: 'Storm',
  fog: 'Fog',
  snow: 'Snow',
};

/**
 * Climate & weather. A coarse advected grid carries cloud, humidity and
 * precipitation; per-cell temperature is derived from the static annual mean
 * plus seasonal, diurnal and synoptic anomalies (so elevation still matters).
 */
export class Climate {
  readonly size: number;
  readonly last: number;
  readonly cellUnits: number;

  /** Coarse grids (weather cells). */
  cloud: Field;
  humidity: Field;
  rainIntensity: Field;
  /** Temperature anomaly in °C applied on top of the static mean. */
  tempAnomaly: Field;
  fog: Field;
  /** Snow water equivalent accumulated this frame at coarse resolution. */
  precipKind: Field;

  state: WeatherState = 'fair';
  stateRemaining = 240;
  /** 0..1 how hard the current state is being expressed. */
  intensity = 0.5;
  targetState: WeatherState = 'fair';

  windDirection: number;
  windSpeed = 1.1;
  windGust = 0;
  /** Lightning flash timer for rendering + ignition. */
  lightningFlash = 0;
  lightningTimer = 0;

  events: ClimateEvent[] = [];
  /** Rolling average of recent rainfall, used to detect droughts. */
  rainfallIndex = 1;
  /** 0..1 — how bright the sun is right now (cloud attenuation). */
  sunIntensity = 1;
  /** Global dimming from volcanic winter events. */
  globalDimming = 0;
  /** Optional player bias: degrees added to the whole world. */
  temperatureBias = 0;
  rainfallBias = 1;

  private rng: Random;
  private terrain: Terrain;
  readonly clock: WorldClock;
  private lcgState = 0;

  constructor(terrain: Terrain, clock: WorldClock, seed: string) {
    this.terrain = terrain;
    this.clock = clock;
    this.rng = new Random(seed + ':weather');
    this.size = CLIMATE.weatherGrid;
    this.last = this.size - 1;
    this.cellUnits = terrain.size / this.size;
    this.cloud = new Field(this.size, 0.35);
    this.humidity = new Field(this.size, 0.5);
    this.rainIntensity = new Field(this.size, 0);
    this.tempAnomaly = new Field(this.size, 0);
    this.fog = new Field(this.size, 0);
    this.precipKind = new Field(this.size, 0);
    this.windDirection = terrain.params.windDirection;
    this.state = 'fair';
    this.targetState = 'fair';
    this.stateRemaining = this.rng.range(120, 480);
  }

  /* ----------------------------- sampling ----------------------------- */

  /** Bilinear sample of a coarse weather grid at world coordinates. */
  private sampleCoarse(f: Field, x: number, y: number): number {
    return f.sample(this.terrain.worldToCellX(x) / this.cellUnits, this.terrain.worldToCellY(y) / this.cellUnits);
  }

  cloudAt(x: number, y: number): number {
    return clamp01(this.sampleCoarse(this.cloud, x, y));
  }
  rainAt(x: number, y: number): number {
    return Math.max(0, this.sampleCoarse(this.rainIntensity, x, y));
  }
  fogAt(x: number, y: number): number {
    return clamp01(this.sampleCoarse(this.fog, x, y));
  }
  /** Liquid-rain intensity at a world position (0..~2.5), with snow excluded. */
  rainIntensityAt(x: number, y: number): number {
    const temp = this.temperatureAt(x, y);
    if (temp < 1.2) return 0;
    return this.rainIntensity.sample(this.terrain.worldToCellX(x) / this.cellUnits, this.terrain.worldToCellY(y) / this.cellUnits);
  }

  /** Cloud cover at a world position (0..1). */
  cloudAtWorld(x: number, y: number): number {
    return this.cloud.sample(this.terrain.worldToCellX(x) / this.cellUnits, this.terrain.worldToCellY(y) / this.cellUnits);
  }

  /** Snow falling or lying at a world position (0..1+): a rendering hint. */
  snowFactorAt(x: number, y: number): number {
    const temp = this.temperatureAt(x, y);
    if (temp > 2.5) return 0;
    return clamp01(this.rainIntensity.sample(this.terrain.worldToCellX(x) / this.cellUnits, this.terrain.worldToCellY(y) / this.cellUnits) * (1 - clamp01((temp + 6) / 8.5)));
  }

  humidityAt(x: number, y: number): number {
    return clamp01(this.sampleCoarse(this.humidity, x, y));
  }

  /**
   * Temperature and precipitation are read tens of thousands of times per step
   * (water, soil, plants, every animal), so both are resolved into flat arrays
   * once every few sim-minutes and then read directly. Read the arrays through
   * the accessors below; they never do more than a lookup.
   */
  private ensureCaches(): void {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    this.cacheAge = 0;
    const t = this.terrain;
    const n = t.size;
    const cs = this.tempAnomaly.size;
    const units = this.cellUnits;
    const rainSize = this.rainIntensity.size;

    if (this.tempNow.length !== n * n) {
      this.tempNow = new Float32Array(n * n);
      this.precipNow = new Float32Array(n * n);
    }
    // 1. Synoptic anomalies on the coarse weather grid (sun, season, fronts).
    const coarse = this.coarseScratch.length === cs * cs ? this.coarseScratch : (this.coarseScratch = new Float32Array(cs * cs));
    const dayScalar = Math.cos(((this.clock.dayOfYear / TIME.daysPerYear) * Math.PI * 2 + Math.PI)) * -1 * CLIMATE.seasonalSwing;
    const hourScalar = (-Math.cos((this.clock.hour / 24) * Math.PI * 2) * 0.5 + 0.5 - 0.5) * 2 * CLIMATE.diurnalSwing * (0.75 + 0.5 * this.clock.solarElevation);
    for (let gy = 0; gy < cs; gy++) {
      for (let gx = 0; gx < cs; gx++) {
        const i = gy * cs + gx;
        const cont = t.continentality.data[clamp(Math.round((gx + 0.5) * units), 0, t.last) * n + clamp(Math.round((gx + 0.5) * units), 0, t.last)];
        const water = t.waterProximity.data[clamp(Math.round((gy + 0.5) * units), 0, t.last) * n + clamp(Math.round((gx + 0.5) * units), 0, t.last)];
        coarse[i] = this.tempAnomaly.data[i] + dayScalar * lerp(0.55, 1.25, cont) + hourScalar * lerp(1, 0.45, water);
      }
    }
    // 2. Lift it onto the terrain grid and add the static elevation pattern,
    //    plus precipitation with the local orographic (rain shadow) factor.
    const rain = this.rainIntensity.data;
    const exposure = t.windExposure.data;
    const mean = t.tempMean.data;
    for (let cy = 0; cy < n; cy++) {
      const gy = Math.min(cs - 1, Math.round(cy / units));
      const grow = gy * cs;
      const row = cy * n;
      const ry = Math.min(rainSize - 1, Math.round(cy / units));
      const rainRow = ry * rainSize;
      for (let cx = 0; cx < n; cx++) {
        const i = row + cx;
        this.tempNow[i] = mean[i] + coarse[grow + Math.min(cs - 1, Math.round(cx / units))] + this.temperatureBias;
        const r = rain[rainRow + Math.min(rainSize - 1, Math.round(cx / units))];
        this.precipNow[i] = r <= 0 ? 0 : r * lerp(0.45, 1.65, exposure[i]);
      }
    }
    this.cacheStep = this.stepCounter;
  }

  /** Precipitation rate at a world position (mm-equivalent per hour). */
  precipitationAt(x: number, y: number): number {
    const t = this.terrain;
    if (this.cacheDirty) this.ensureCaches();
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    return this.precipNow[cy * t.size + cx];
  }

  /** Instantaneous air temperature (°C) at a world position (bilinear). */
  temperatureAt(x: number, y: number): number {
    const t = this.terrain;
    if (this.cacheDirty) this.ensureCaches();
    const cx = t.worldToCellX(x);
    const cy = t.worldToCellY(y);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = x0 + 1 >= t.size ? t.last : x0 + 1;
    const y1 = y0 + 1 >= t.size ? t.last : y0 + 1;
    const fx = cx - x0;
    const fy = cy - y0;
    const tmp = this.tempNow;
    const row0 = (y0 < 0 ? 0 : y0) * t.size;
    const row1 = y1 * t.size;
    const a = row0 + (x0 < 0 ? 0 : x0);
    const b = row0 + x1;
    const c = row1 + (x0 < 0 ? 0 : x0);
    const d = row1 + x1;
    return lerp(lerp(tmp[a], tmp[b], fx), lerp(tmp[c], tmp[d], fx), fy);
  }

  /** Temperature at a terrain cell. One array read: used in field loops. */
  temperatureAtCellFast(cx: number, cy: number): number {
    const t = this.terrain;
    if (this.cacheDirty) this.ensureCaches();
    return this.tempNow[cy * t.size + cx];
  }

  /** Precipitation at a terrain cell. One array read: used in field loops. */
  precipitationAtCellFast(cx: number, cy: number): number {
    const t = this.terrain;
    if (this.cacheDirty) this.ensureCaches();
    return this.precipNow[cy * t.size + cx];
  }

  /** Age the caches. Called once per simulation step. */
  beginStep(dtMinutes = 1): void {
    this.cacheAge += dtMinutes;
    if (this.cacheAge >= this.cacheEvery) this.cacheDirty = true;
  }

  temperatureAtCell(cx: number, cy: number): number {
    return this.temperatureAtCellFast(cx, cy);
  }

  /** Cached temperature field, one value per terrain cell. */
  private tempNow = new Float32Array(0);
  /** Cached precipitation field, one value per terrain cell. */
  private precipNow = new Float32Array(0);
  private coarseScratch = new Float32Array(0);
  private stepCounter = 0;
  private cacheStep = -1;
  private cacheAge = 999;
  private cacheEvery = 3;
  private cacheDirty = true;

  /** Seasonal departure from the annual mean (°C). */
  seasonalAnomaly(x: number, y: number): number {
    // Peaks mid-summer, minimum mid-winter; amplified inland.
    const phase = Math.cos(((this.clock.dayOfYear / TIME.daysPerYear) * Math.PI * 2 + Math.PI) * 1) * -1;
    const cont = this.terrain.continentality.sample(this.terrain.worldToCellX(x), this.terrain.worldToCellY(y));
    return phase * CLIMATE.seasonalSwing * lerp(0.55, 1.25, cont);
  }

  /** Day/night departure from the daily mean (°C). */
  diurnalAnomaly(x: number, y: number): number {
    const elev = this.clock.solarElevation;
    const t = -Math.cos(this.clock.hour / 24 * Math.PI * 2) * 0.5 + 0.5; // 0 at 00:00, 1 at noon
    const water = this.terrain.waterProximity.sample(this.terrain.worldToCellX(x), this.terrain.worldToCellY(y));
    const swing = CLIMATE.diurnalSwing * lerp(1, 0.45, water) * (0.75 + 0.5 * elev);
    return (t - 0.5) * swing * 2 * 0.5;
  }

  /** Current weather label for the HUD. */
  get label(): string {
    if (this.state === 'rain' && this.temperatureAt(0, 0) < 0.6) return 'Snow';
    return STATE_LABELS[this.state];
  }

  get isPrecipitating(): boolean {
    return this.rainIntensity.stats().mean > 0.02;
  }

  /* ----------------------------- update ----------------------------- */

  update(dtMinutes: number): void {
    const hours = dtMinutes / 60;
    this.updateSynoptic(hours);
    this.updateFields(hours, dtMinutes);
    this.updateEvents(dtMinutes);
    this.updateSun();
  }

  private updateSynoptic(hours: number): void {
    this.stateRemaining -= hours * 60;
    if (this.stateRemaining <= 0) {
      const options = TRANSITIONS[this.state];
      // Season nudges the odds: winters are cloudier & snowier, summers clearer.
      const season = this.clock.seasonIndex;
      const weights = options.map(([s, w]) => {
        let ww = w;
        if (season === 3) {
          if (s === 'clear' || s === 'fair') ww *= 0.6;
          if (s === 'snow' || s === 'overcast' || s === 'storm') ww *= 1.8;
        } else if (season === 1) {
          if (s === 'clear') ww *= 1.6;
          if (s === 'snow') ww *= 0.05;
          if (s === 'storm') ww *= 1.25;
        }
        if (this.events.some((e) => e.kind === 'drought')) {
          if (s === 'drizzle' || s === 'rain' || s === 'heavyRain' || s === 'storm' || s === 'fog') ww *= 0.12;
          if (s === 'clear' || s === 'fair') ww *= 2.2;
        }
        if (this.events.some((e) => e.kind === 'monsoon')) {
          if (s === 'rain' || s === 'heavyRain' || s === 'storm' || s === 'drizzle') ww *= 2.6;
          if (s === 'clear') ww *= 0.25;
        }
        return ww;
      });
      // Snow state only when cold enough somewhere in the world.
      const globalMeanT = this.terrain.tempMean.stats().mean + this.seasonalAnomaly(0, 0);
      const idx = this.rng.weightedIndex(weights);
      let next = options[idx][0];
      if (next === 'snow' && globalMeanT > 3) next = 'overcast';
      const wet = next === 'drizzle' || next === 'rain' || next === 'heavyRain' || next === 'storm';
      const meanMoist = this.terrain.moistureMean.stats().mean;
      if (wet && meanMoist < 0.2 && this.rng.chance(0.6)) next = 'cloudy';
      if (next === 'fog' && this.clock.hour > 9 && this.clock.hour < 18 && this.rng.chance(0.7)) next = 'fair';
      this.state = next;
      // Rainy spells last longer than clear ones; storms are brief.
      const dur =
        next === 'storm'
          ? this.rng.range(40, 130)
          : wet
            ? this.rng.range(120, 520)
            : this.rng.range(180, 900);
      this.stateRemaining = dur;
      this.intensity = this.rng.range(0.55, 1.0);
    }
    // Wind slowly veers, and freshens with the weather system.
    const target = this.terrain.params.windDirection + Math.sin(this.clock.yearFraction * Math.PI * 2) * 0.5;
    const tableWind = WEATHER_TABLE[this.state].wind;
    this.windDirection += Math.sin(this.clock.minutes * 0.0007) * 0.0009 * hours * 60;
    this.windSpeed = lerp(this.windSpeed, CLIMATE.windBase * tableWind * (1 + this.intensity * 0.35), 0.05 * hours * 60);
    this.windGust = Math.max(0, this.windGust - hours * 2) + (this.state === 'storm' ? this.rng.next() * 0.6 * hours * 6 : 0);
    void target;
  }

  private updateFields(hours: number, dtMinutes: number): void {
    const n = this.size;
    const dx = Math.cos(this.windDirection);
    const dy = Math.sin(this.windDirection);
    const cloud = this.cloud.data;
    const hum = this.humidity.data;
    const rainI = this.rainIntensity.data;
    const anom = this.tempAnomaly.data;
    const fog = this.fog.data;
    const table = WEATHER_TABLE[this.state];
    const drift = this.windSpeed * hours * 0.09 * n * 0.09;

    // Advect (semi-Lagrangian, coarse grid — cheap and stable).
    const cloudSrc = Float32Array.from(cloud);
    const humSrc = Float32Array.from(hum);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const sx = clamp(x - dx * drift, 0, this.last);
        const sy = clamp(y - dy * drift, 0, this.last);
        const cl = sampleFieldArr(cloudSrc, n, sx, sy);
        const hm = sampleFieldArr(humSrc, n, sx, sy);
        // Relax toward the synoptic state, add a little noise for texture.
        const noise = Math.sin(x * 0.7 + y * 1.3 + this.clock.minutes * 0.01) * 0.03;
        cloud[i] = clamp01(lerp(cl, table.cloud * this.intensity, 0.06 * hours * 10) + noise * 0.5);
        hum[i] = clamp01(lerp(hm, table.humidity * this.intensity, 0.05 * hours * 10));
      }
    }

    // Evaporation feeds humidity from water bodies and wet soil.
    const terrain = this.terrain;
    const evapRate = CLIMATE.evaporationPerHour * hours;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const cx = clamp(Math.round(x * this.cellUnits), 0, terrain.last);
        const cy = clamp(Math.round(y * this.cellUnits), 0, terrain.last);
        const water = terrain.waterDepth.at(cx, cy);
        const isSea = terrain.height.at(cx, cy) < terrain.params.seaLevel;
        const soilWet = terrain.moistureMean.at(cx, cy);
        const t = this.tempAnomaly.data[i] + terrain.tempMean.at(cx, cy);
        const warm = clamp01((t + 5) / 35);
        let evap = (isSea ? 1 : water > 0.05 ? 0.75 : soilWet * 0.3) * evapRate * (0.4 + warm);
        if (this.events.some((e) => e.kind === 'heatwave')) evap *= 1.6;
        if (this.events.some((e) => e.kind === 'drought')) evap *= 0.55;
        hum[i] = clamp01(hum[i] + evap * 1.6);
        cloud[i] = clamp01(cloud[i] + Math.max(0, hum[i] - 0.72) * 0.02 * hours * 10 * 0.35);
        cloud[i] = clamp01(cloud[i] - CLIMATE.cloudDissipation * hours * 0.25);
      }
    }

    // Rain out: cloud above the dew-point threshold, enhanced by orography.
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const cx = clamp(Math.round(x * this.cellUnits), 0, terrain.last);
        const cy = clamp(Math.round(y * this.cellUnits), 0, terrain.last);
        const exposure = terrain.windExposure.at(cx, cy);
        const lift = smoothstep(0.5, 1, exposure);
        const over = Math.max(0, cloud[i] - 0.62);
        let storm = 0;
        if (this.state === 'storm') storm = 0.35 * this.intensity;
        const base = table.rain * this.intensity;
        const strength = base + over * (2.4 + lift * 3.2) + storm;
        rainI[i] = Math.max(0, strength * this.rainfallBias);
        // Raining out dries the air.
        hum[i] = clamp01(hum[i] - Math.min(0.2, strength * 0.06 * hours * 10));
      }
    }

    // Temperature anomalies: advected warm/cold air + radiative cooling.
    const anomSrc = Float32Array.from(anom);
    const solar = this.clock.solarElevation;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const sx = clamp(x - dx * drift * 0.8, 0, this.last);
        const sy = clamp(y - dy * drift * 0.8, 0, this.last);
        const adv = sampleFieldArr(anomSrc, n, sx, sy);
        // Cloud keeps nights warmer and days cooler; clear skies amplify both.
        const cl = cloud[i];
        const rad = (0.5 - cl) * 5.5 * (solar > 0.05 ? 1 : -0.55);
        let target = rad;
        if (this.state === 'storm') target -= 3.5;
        if (this.state === 'clear') target += solar > 0.05 ? 2.4 : -3.2;
        anom[i] = lerp(adv, target, 0.05 * hours * 10);
      }
    }

    // Ground fog: cold, calm, humid, valley bottoms and mornings.
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const cx = clamp(Math.round(x * this.cellUnits), 0, terrain.last);
        const cy = clamp(Math.round(y * this.cellUnits), 0, terrain.last);
        const elev = terrain.elevationOf(terrain.height.at(cx, cy));
        const tempHere = terrain.tempMean.at(cx, cy) + this.seasonalAnomaly(terrain.cellToWorldX(cx), terrain.cellToWorldY(cy));
        const valley = 1 - clamp01((elev - 1) / 16);
        const calm = 1 - clamp01(this.windSpeed / 2.4);
        const wet = clamp01(hum[i] * 1.2 - 0.35);
        const cold = smoothstep(14, 2, tempHere + this.tempAnomaly.data[i]);
        const dawn = smoothstep(0.25, 0.02, solar) * 0.6 + 0.4;
        const want = clamp01(wet * cold * valley * calm * dawn * (this.state === 'fog' ? 1.6 : 0.75));
        fog[i] = lerp(fog[i], want, 0.05 * hours * 10);
      }
    }

    // Lightning during storms.
    if (this.state === 'storm') {
      this.lightningTimer -= dtMinutes;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = this.rng.range(4, 30) / Math.max(0.4, this.intensity);
        this.lightningFlash = 1;
        const strikes = this.rng.int(1, 3);
        for (let s = 0; s < strikes; s++) {
          const cx = this.rng.int(0, this.terrain.last);
          const cy = this.rng.int(0, this.terrain.last);
          this.onLightning?.(cx, cy);
        }
      }
    } else {
      this.lightningTimer = Math.max(this.lightningTimer, 6);
    }
    this.lightningFlash = Math.max(0, this.lightningFlash - dtMinutes / 3);
  }

  /** Set by the world: gives fire a chance to start. */
  onLightning: ((cx: number, cy: number) => void) | null = null;

  private updateEvents(dtMinutes: number): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      e.remaining -= dtMinutes;
      if (e.remaining <= 0) {
        this.events.splice(i, 1);
        this.onEventEnd?.(e);
      }
    }
    // Spontaneous climate events, weighted by season and existing conditions.
    const hours = dtMinutes / 60;
    const season = this.clock.seasonIndex;
    const dryWorld = 1 - clamp01(this.terrain.moistureMean.stats().mean * 1.6);
    if (this.rng.chance(hours * 0.0011 * (1 + dryWorld * 2) * (season === 1 ? 1.7 : season === 3 ? 0.4 : 1))) {
      this.startEvent('drought', this.rng.range(CLIMATE.eventMinDays, CLIMATE.eventMaxDays), this.rng.range(0.4, 0.85));
    }
    if (this.rng.chance(hours * 0.0009 * (season === 1 ? 2.1 : season === 3 ? 0.2 : 1))) {
      this.startEvent('heatwave', this.rng.range(2, 7), this.rng.range(0.5, 1));
    }
    if (this.rng.chance(hours * 0.0009 * (season === 3 ? 2.1 : season === 1 ? 0.2 : 1))) {
      this.startEvent('coldwave', this.rng.range(2, 8), this.rng.range(0.5, 1));
    }
    if (this.rng.chance(hours * 0.00035 * (this.terrain.moistureMean.stats().mean < 0.5 ? 1.4 : 1))) {
      this.startEvent('monsoon', this.rng.range(5, 14), this.rng.range(0.5, 1));
    }

    // Rainfall index for drought detection / HUD.
    this.rainfallIndex = lerp(this.rainfallIndex, this.rainIntensity.stats().mean, 0.02);
  }

  onEventEnd: ((e: ClimateEvent) => void) | null = null;

  startEvent(kind: ClimateEventKind, days: number, intensity: number, silent = false): ClimateEvent {
    const existing = this.events.find((e) => e.kind === kind);
    const labelMap: Record<ClimateEventKind, string> = {
      drought: 'Drought',
      heatwave: 'Heatwave',
      coldwave: 'Cold snap',
      monsoon: 'Monsoon rains',
      volcanicWinter: 'Volcanic winter',
    };
    if (existing) {
      existing.remaining = Math.max(existing.remaining, days * TIME.minutesPerDay);
      existing.total = Math.max(existing.total, existing.remaining);
      existing.intensity = Math.max(existing.intensity, intensity);
      return existing;
    }
    const ev: ClimateEvent = {
      kind,
      remaining: days * TIME.minutesPerDay,
      total: days * TIME.minutesPerDay,
      intensity,
      label: labelMap[kind],
    };
    this.events.push(ev);
    if (!silent) this.onEventStart?.(ev);
    return ev;
  }

  onEventStart: ((e: ClimateEvent) => void) | null = null;

  hasEvent(kind: ClimateEventKind): boolean {
    return this.events.some((e) => e.kind === kind);
  }

  private updateSun(): void {
    let sun = this.clock.solarElevation;
    const meanCloud = this.cloud.stats().mean;
    sun *= lerp(1, 0.28, meanCloud);
    sun *= lerp(1, 0.45, this.fog.stats().mean * 1.5);
    sun *= 1 - this.globalDimming;
    this.sunIntensity = clamp01(sun);
  }

  /**
   * How unstable the weather is right now, 0..1. Spring and autumn are the
   * turbulent seasons; high values mean more fronts, more storms and — for
   * disease — more chances to spread.
   */
  seasonalInstability(): number {
    const f = ((this.clock.yearFraction % 1) + 1) % 1;
    const spring = Math.exp(-Math.pow((f - 0.12) / 0.11, 2));
    const autumn = Math.exp(-Math.pow((f - 0.62) / 0.12, 2));
    return clamp01(0.12 + spring * 0.5 + autumn * 0.42 + this.intensity * 0.25);
  }

  /** Photoperiod + light quality used by plants and behaviour. */
  get lightLevel(): number {
    return clamp01(this.clock.solarElevation * lerp(1.05, 0.45, this.cloud.stats().mean));
  }

  /** Apply the current temperature anomalies to the static mean (for visualisation). */
  temperatureField(out: Field): void {
    const t = this.terrain;
    const n = t.size;
    for (let cy = 0; cy < n; cy++) {
      const y = t.cellToWorldY(cy);
      for (let cx = 0; cx < n; cx++) {
        const x = t.cellToWorldX(cx);
        out.data[cy * n + cx] =
          t.tempMean.data[cy * n + cx] +
          this.tempAnomaly.sample(cx / this.cellUnits, cy / this.cellUnits) +
          this.seasonalAnomaly(x, y) +
          this.diurnalAnomaly(x, y) +
          this.temperatureBias;
      }
    }
  }

  save(): Record<string, unknown> {
    return {
      state: this.state,
      stateRemaining: this.stateRemaining,
      intensity: this.intensity,
      windDirection: this.windDirection,
      windSpeed: this.windSpeed,
      cloud: this.cloud.serialise(),
      humidity: this.humidity.serialise(),
      tempAnomaly: this.tempAnomaly.serialise(),
      fog: this.fog.serialise(),
      events: this.events,
      temperatureBias: this.temperatureBias,
      rainfallBias: this.rainfallBias,
      rainfallIndex: this.rainfallIndex,
      lightningTimer: this.lightningTimer,
      rng: this.rng.saveState(),
    };
  }

  load(d: Record<string, any>): void {
    this.state = d.state ?? 'fair';
    this.stateRemaining = d.stateRemaining ?? 240;
    this.intensity = d.intensity ?? 0.5;
    this.windDirection = d.windDirection ?? this.terrain.params.windDirection;
    this.windSpeed = d.windSpeed ?? 1.1;
    if (d.cloud) this.cloud.restore(d.cloud);
    if (d.humidity) this.humidity.restore(d.humidity);
    if (d.tempAnomaly) this.tempAnomaly.restore(d.tempAnomaly);
    if (d.fog) this.fog.restore(d.fog);
    this.events = d.events ?? [];
    this.temperatureBias = d.temperatureBias ?? 0;
    this.rainfallBias = d.rainfallBias ?? 1;
    this.rainfallIndex = d.rainfallIndex ?? 1;
    this.lightningTimer = d.lightningTimer ?? 20;
    if (d.rng) this.rng.loadState(d.rng);
  }
}

function sampleFieldArr(arr: Float32Array, n: number, x: number, y: number): number {
  const x0 = clamp(x | 0, 0, n - 2);
  const y0 = clamp(y | 0, 0, n - 2);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * n + x0;
  const a = arr[i];
  const b = arr[i + 1];
  const c = arr[i + n];
  const d = arr[i + n + 1];
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}
