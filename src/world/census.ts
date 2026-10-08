import { clamp01, shannonEvenness } from '../core/math';
import { ANIMAL_TEMPLATE } from '../life/genome';
import { SPECIES } from '../life/species';
import { isWaterBiome } from './biomes';
import type { World } from './world';

export interface TraitStat {
  key: string;
  label: string;
  value: number;
  /** Where the value sits across the trait's legal range, 0..1. */
  normalised: number;
  desc: string;
}

export interface SpeciesStat {
  key: string;
  name: string;
  latin: string;
  role: string;
  /** Individuals alive, or estimated population for patch species. */
  count: number;
  biomass: number;
  meanAgeYears: number;
  lifespanYears: number;
  meanHealth: number;
  meanHunger: number;
  birthsToday: number;
  deathsToday: number;
  birthsThisYear: number;
  deathsThisYear: number;
  maxGeneration: number;
  meanGeneration: number;
  extinct: boolean;
  trend: number;
  habitatRange: number;
  territoryCount: number;
  groupCount: number;
  diseasePrevalence: number;
  diseaseName: string;
  traits: TraitStat[];
  diet: string;
  predators: string[];
  prey: string[];
  layers: 'individual' | 'aggregate';
}

export interface BiodiversityIndex {
  speciesRichness: number;
  speciesPossible: number;
  evenness: number;
  shannon: number;
  totalBiomass: number;
  vegetationIndex: number;
  forestBiomass: number;
  waterAvailability: number;
  soilHealth: number;
  predatorPreyRatio: number;
  diseasePressure: number;
  stability: number;
  /** 0..1 composite "how well is this world doing". */
  vitality: number;
}

/**
 * The census turns simulation state into the numbers the interface reports.
 * Everything here is measured, nothing is invented: if the encyclopedia says a
 * species is declining, that is because its measured population is falling.
 */
export class Census {
  stats = new Map<string, SpeciesStat>();
  biodiversity: BiodiversityIndex = {
    speciesRichness: 0,
    speciesPossible: SPECIES.length,
    evenness: 0,
    shannon: 0,
    totalBiomass: 0,
    vegetationIndex: 0,
    forestBiomass: 0,
    waterAvailability: 0,
    soilHealth: 0,
    predatorPreyRatio: 0,
    diseasePressure: 0,
    stability: 0,
    vitality: 0,
  };
  private birthsYear = new Int32Array(SPECIES.length);
  private deathsYear = new Int32Array(SPECIES.length);
  private birthsWindow = new Int32Array(SPECIES.length);
  private deathsWindow = new Int32Array(SPECIES.length);
  private historyWindow: number[][] = [];
  private lastYear = 1;
  private lastCensusMinute = -999;

  update(w: World, force = false): void {
    const now = w.clock.minutes;
    if (!force && now - this.lastCensusMinute < 60) return;
    this.lastCensusMinute = now;
    const c = w.creatures;
    c.refreshCensus();
    const year = w.clock.year;
    if (year !== this.lastYear) {
      this.birthsYear = Int32Array.from(this.birthsWindow);
      this.deathsYear = Int32Array.from(this.deathsWindow);
      this.birthsWindow.fill(0);
      this.deathsWindow.fill(0);
      this.lastYear = year;
    }

    const counts: number[] = [];
    let predatorBiomass = 0;
    let herbivoreBiomass = 0;

    for (let s = 0; s < SPECIES.length; s++) {
      const sp = SPECIES[s];
      const isAggregate = sp.key === 'mouse' || sp.key === 'insect' || sp.key === 'plankton';
      const individuals = c.census.count[s];
      const stat = this.stats.get(sp.key) ?? ({} as SpeciesStat);
      const aggregateBiomass = isAggregate ? (w.aggregates.means[sp.key] ?? 0) : 0;
      const popCount = isAggregate ? Math.round(aggregateBiomass * 900) : individuals;
      stat.key = sp.key;
      stat.name = sp.name;
      stat.latin = sp.latin;
      stat.role = sp.role;
      stat.count = popCount;
      stat.biomass = isAggregate ? aggregateBiomass * 260 : individuals * sp.massKg * 0.35;
      stat.meanAgeYears = c.census.meanAge[s];
      stat.lifespanYears = sp.maxAgeYears;
      stat.meanHealth = individuals ? c.census.meanHealth[s] : isAggregate ? 1 : 0;
      stat.meanHunger = individuals ? c.census.meanHunger[s] : isAggregate ? 0.3 : 0;
      stat.birthsToday = c.census.birthsToday[s];
      stat.deathsToday = c.census.deathsToday[s];
      stat.birthsThisYear = this.birthsYear[s] + this.birthsWindow[s];
      stat.deathsThisYear = this.deathsYear[s] + this.deathsWindow[s];
      let maxGen = 0;
      let sumGen = 0;
      let territoryCount = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < c.capacity; i++) {
        if (!c.alive[i] || c.speciesIdx[i] !== s) continue;
        if (c.generation[i] > maxGen) maxGen = c.generation[i];
        sumGen += c.generation[i];
        if (c.hasHome[i]) territoryCount++;
        if (c.x[i] < minX) minX = c.x[i];
        if (c.x[i] > maxX) maxX = c.x[i];
        if (c.y[i] < minY) minY = c.y[i];
        if (c.y[i] > maxY) maxY = c.y[i];
      }
      stat.maxGeneration = maxGen;
      stat.meanGeneration = individuals ? sumGen / individuals : 0;
      stat.territoryCount = territoryCount;
      stat.groupCount = w.social.groups.reduce((acc, g) => acc + (g.speciesIdx === s ? 1 : 0), 0);
      stat.habitatRange = individuals > 1 && isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0;
      const disease = w.disease.summary(s);
      stat.diseasePrevalence = disease ? disease.prevalence : 0;
      stat.diseaseName = disease ? disease.name : '';
      stat.extinct = popCount <= 0;
      stat.layers = isAggregate ? 'aggregate' : 'individual';
      stat.diet = describeDiet(sp.key);
      stat.predators = SPECIES.filter((o) => o.preySpecies.includes(sp.key) || o.aggregatePrey.includes(sp.key)).map((o) => o.name);
      stat.prey = SPECIES.filter((o) => sp.preySpecies.includes(o.key) || sp.aggregatePrey.includes(o.key)).map((o) => o.name);
      stat.traits = buildTraitStats(c.speciesGenomeMean(s), sp.baseTraits);
      counts.push(popCount);

      if (sp.dietKind === 'predator' || sp.dietKind === 'scavenger' || sp.dietKind === 'piscivore') predatorBiomass += stat.biomass;
      else herbivoreBiomass += stat.biomass;
      this.stats.set(sp.key, stat);
    }

    this.historyWindow.push(counts.slice());
    if (this.historyWindow.length > 24) this.historyWindow.shift();
    for (let s = 0; s < SPECIES.length; s++) {
      const stat = this.stats.get(SPECIES[s].key) as SpeciesStat;
      const series = this.historyWindow.map((h) => h[s]);
      const recentSlice = series.slice(-3);
      const olderSlice = series.slice(0, 3);
      const recent = recentSlice.reduce((a, b) => a + b, 0) / Math.max(1, recentSlice.length);
      const older = olderSlice.reduce((a, b) => a + b, 0) / Math.max(1, olderSlice.length);
      stat.trend = older > 2 ? (recent - older) / older : recent > 0 ? 1 : 0;
    }

    const t = w.terrain;
    const soil = t.fertility.stats().mean;
    const wetness = clamp01(t.soilMoisture.stats().mean * 1.4);
    const alive = counts.filter((v) => v > 0).length;
    const bd = this.biodiversity;
    bd.speciesRichness = alive;
    bd.evenness = shannonEvenness(counts);
    let shannon = 0;
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const v of counts) {
        if (v <= 0) continue;
        const p = v / sum;
        shannon -= p * Math.log(p);
      }
    }
    bd.shannon = shannon;
    bd.vegetationIndex = clamp01(w.vegetation.stats.biomass * 1.4);
    bd.forestBiomass = w.forest.store.statsAlive();
    bd.totalBiomass = bd.forestBiomass * 0.04 + w.vegetation.stats.biomass * 40 + predatorBiomass + herbivoreBiomass;
    bd.waterAvailability = clamp01(w.hydrology.wetnessIndex * 0.6 + wetness * 0.4);
    bd.soilHealth = clamp01(soil * 0.6 + t.soilBiota.stats().mean * 0.4);
    bd.predatorPreyRatio = herbivoreBiomass > 0.01 ? predatorBiomass / herbivoreBiomass : 0;
    bd.diseasePressure = w.disease.pressure;
    bd.stability =
      clamp01(1 - Math.abs(bd.predatorPreyRatio - 0.03) * 6) * 0.4 + bd.evenness * 0.4 + clamp01(1 - w.disease.pressure) * 0.2;
    bd.vitality = clamp01(
      bd.vegetationIndex * 0.28 +
        clamp01(alive / SPECIES.length) * 0.2 +
        bd.evenness * 0.16 +
        bd.waterAvailability * 0.14 +
        bd.soilHealth * 0.12 +
        clamp01(1 - bd.diseasePressure) * 0.1,
    );
  }

  recordBirth(speciesIdx: number): void {
    this.birthsWindow[speciesIdx]++;
  }

  recordDeath(speciesIdx: number): void {
    this.deathsWindow[speciesIdx]++;
  }

  get(speciesKey: string): SpeciesStat | null {
    return this.stats.get(speciesKey) ?? null;
  }

  /** Species ordered for display: iconic megafauna first, microbes last. */
  ordered(): SpeciesStat[] {
    const order = ['wolf', 'bear', 'bison', 'deer', 'eagle', 'fox', 'owl', 'raven', 'rabbit', 'trout', 'mouse', 'insect', 'plankton'];
    return order.map((k) => this.stats.get(k)).filter((s): s is SpeciesStat => !!s);
  }
}

function describeDiet(key: string): string {
  const sp = SPECIES.find((s) => s.key === key);
  if (!sp) return '';
  const parts: string[] = [];
  const layerNames = ['grass and herbs', 'shrubs, saplings and browse', 'reeds', 'algae', 'moss and lichen', 'xeric scrub'];
  sp.plantDiet.forEach((pref, i) => {
    if (pref > 0.2) parts.push(layerNames[i]);
  });
  if (sp.preySpecies.length) {
    parts.push(sp.preySpecies.map((p) => SPECIES.find((s) => s.key === p)?.name.toLowerCase() ?? p).join(', '));
  }
  if (sp.aggregatePrey.length) parts.push(sp.aggregatePrey.join(', '));
  if (sp.scavenges) parts.push('carrion');
  return parts.join(' · ');
}

function buildTraitStats(mean: Float32Array | null, base: Record<string, number>): TraitStat[] {
  const out: TraitStat[] = [];
  if (!mean) return out;
  ANIMAL_TEMPLATE.traits.forEach((t, i) => {
    if (t.secondary) return;
    const value = mean[i] ?? base[t.key] ?? (t.lo + t.hi) / 2;
    out.push({
      key: t.key,
      label: t.label,
      value,
      normalised: clamp01((value - t.lo) / (t.hi - t.lo)),
      desc: t.desc,
    });
  });
  return out;
}

/** Composite well-being of a species' population (0..1). */
export function populationHealth(stat: SpeciesStat): number {
  if (stat.count <= 0) return 0;
  return clamp01(stat.meanHealth * 0.55 + (1 - clamp01(stat.meanHunger)) * 0.3 + (1 - clamp01(stat.diseasePrevalence * 3)) * 0.15);
}
