import { TIME } from '../core/config';
import { clamp01, fmtNum, fmtPct } from '../core/math';
import { SPECIES } from '../life/species';
import type { WorldEvent } from '../core/events';
import type { World } from './world';

export interface Discovery {
  key: string;
  title: string;
  detail: string;
  day: number;
  year: number;
  /** Rarity 1..3 used for styling (3 = remarkable). */
  rarity: number;
  /** Set once the player opens it. */
  read: boolean;
}

/** A life story: everything needed to build a family tree and a biography. */
export interface IndividualRecord {
  id: number;
  speciesIdx: number;
  name: string | null;
  /** Days since the world began. */
  birthDay: number;
  deathDay: number | null;
  ageDays: number;
  parents: [number, number];
  offspring: number;
  generation: number;
  cause: string | null;
  traits?: number[];
  favourite: boolean;
}

export interface PopulationSample {
  day: number;
  /** Individual count for individually simulated species. */
  counts: number[];
  /** Aggregate biomass per aggregate species key. */
  aggregates: Record<string, number>;
  /** Total biomass of vegetation layers. */
  vegetation: number;
  treeCount: number;
  meanTraits: Float32Array[];
  generations: number[];
}

/**
 * World history: the running log of notable events, the sampled time series
 * that powers the charts, and the automatic detection of things worth telling
 * the player about ("Rabbit population collapsed", "First drought survived").
 *
 * Nothing here is scripted: every entry is generated from measured state.
 */
export class History {
  events: WorldEvent[] = [];
  private nextId = 1;
  discoveries: Discovery[] = [];
  private discoveryKeys = new Set<string>();
  samples: PopulationSample[] = [];
  /** Peak values for record-breaking events. */
  records = {
    population: new Int32Array(SPECIES.length),
    generation: new Int32Array(SPECIES.length),
    lifespanDays: new Float32Array(SPECIES.length),
    treeCount: 0,
    fireArea: 0,
    lakeVolume: 0,
    migrationSize: 0,
    droughtDays: 0,
    birthRate: 0,
  };
  /** Per-species guard so the same headline is not repeated every day. */
  private lastAnnounced = new Map<string, number>();
  private extinctionAnnounced = new Set<string>();
  /** Species that have ever been seen alive (so extinctions are detectable). */
  private seenSpecies = new Set<number>();
  /** Species the player deliberately introduced, with the day they arrived. */
  readonly introductions = new Map<string, number>();
  /** Compact records of every individual that ever lived here, for family trees. */
  individuals = new Map<number, IndividualRecord>();
  private individualOrder: number[] = [];
  maxIndividuals = 24000;
  private sampleAccumulator = 0;
  private daySampleAccumulator = 0;
  maxSamples = 360;

  constructor() {}

  add(
    e: Omit<WorldEvent, 'id' | 'day' | 'year' | 'minuteOfDay'> & { day?: number; year?: number; minuteOfDay?: number },
    world?: World,
  ): WorldEvent {
    const day = e.day ?? (world ? world.clock.day : 1);
    const ev: WorldEvent = {
      id: this.nextId++,
      day,
      year: e.year ?? (world ? world.clock.year : 1),
      minuteOfDay: e.minuteOfDay ?? (world ? Math.floor(world.clock.minutes % 1440) : 0),
      kind: e.kind,
      title: e.title,
      detail: e.detail,
      weight: e.weight ?? 1,
      speciesId: e.speciesId,
      organismId: e.organismId,
      x: e.x,
      y: e.y,
      subject: e.subject,
    };
    this.events.push(ev);
    if (this.events.length > 4000) this.events.splice(0, 500);
    return ev;
  }

  /** Throttled announcement: at most one event per key per `cooldownDays`. */
  announce(
    key: string,
    cooldownDays: number,
    day: number,
    build: () => Omit<WorldEvent, 'id' | 'day' | 'year' | 'minuteOfDay'> | null,
    world: World,
  ): void {
    const last = this.lastAnnounced.get(key);
    if (last !== undefined && day - last < cooldownDays) return;
    const ev = build();
    if (!ev) return;
    this.lastAnnounced.set(key, day);
    this.add(ev, world);
  }

  discover(key: string, title: string, detail: string, day: number, year: number, rarity = 2): Discovery | null {
    if (this.discoveryKeys.has(key)) return null;
    this.discoveryKeys.add(key);
    const d: Discovery = { key, title, detail, day, year, rarity, read: false };
    this.discoveries.push(d);
    return d;
  }

  hasDiscovery(key: string): boolean {
    return this.discoveryKeys.has(key);
  }

  markSpeciesSeen(speciesIdx: number): void {
    this.seenSpecies.add(speciesIdx);
  }

  hasSeenSpecies(speciesIdx: number): boolean {
    return this.seenSpecies.has(speciesIdx);
  }

  markIntroduced(speciesKey: string, day: number): void {
    if (!this.introductions.has(speciesKey)) this.introductions.set(speciesKey, day);
  }

  recordIndividual(r: IndividualRecord): void {
    this.individuals.set(r.id, r);
    this.individualOrder.push(r.id);
    if (this.individualOrder.length > this.maxIndividuals) {
      const drop = this.individualOrder.shift();
      if (drop !== undefined) {
        const rec = this.individuals.get(drop);
        // Keep the notable ones.
        if (rec && (rec.favourite || rec.offspring > 3 || rec.generation > 6)) return;
        this.individuals.delete(drop);
      }
    }
  }

  individual(id: number): IndividualRecord | null {
    return this.individuals.get(id) ?? null;
  }

  /** Direct children of an individual (walking the record set). */
  childrenOf(id: number): IndividualRecord[] {
    const out: IndividualRecord[] = [];
    for (const r of this.individuals.values()) {
      if (r.parents[0] === id || r.parents[1] === id) out.push(r);
    }
    return out;
  }

  /** Sample the world's state (called roughly once per in-game day). */
  sample(w: World): void {
    const counts: number[] = [];
    const meanTraits: Float32Array[] = [];
    const generations: number[] = [];
    for (let s = 0; s < SPECIES.length; s++) {
      counts.push(w.creatures.census.count[s]);
      const g = w.creatures.speciesGenomeMean(s);
      meanTraits.push(g ?? new Float32Array(16));
      generations.push(w.creatures.census.count[s] ? this.maxGeneration(w, s) : 0);
    }
    this.samples.push({
      day: w.clock.day,
      counts,
      aggregates: { ...w.aggregates.means },
      vegetation: w.vegetation.stats.biomass,
      treeCount: w.forest.store.statsAlive(),
      meanTraits,
      generations,
    });
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
  }

  private maxGeneration(w: World, speciesIdx: number): number {
    let max = 0;
    const c = w.creatures;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i] || c.speciesIdx[i] !== speciesIdx) continue;
      if (c.generation[i] > max) max = c.generation[i];
    }
    return max;
  }

  /** Series for the charts: population of one species over time. */
  series(speciesIdx: number): { day: number; value: number }[] {
    return this.samples.map((s) => ({ day: s.day, value: s.counts[speciesIdx] ?? 0 }));
  }

  /** Aggregate series for a patch species. */
  aggregateSeries(key: string): { day: number; value: number }[] {
    return this.samples.map((s) => ({ day: s.day, value: s.aggregates[key] ?? 0 }));
  }

  /** Trait trajectory: mean value of a trait index per sampled day. */
  traitSeries(speciesIdx: number, traitIndex: number): { day: number; value: number }[] {
    const out: { day: number; value: number }[] = [];
    for (const s of this.samples) {
      const t = s.meanTraits[speciesIdx];
      if (!t || !s.counts[speciesIdx]) continue;
      out.push({ day: s.day, value: t[traitIndex] ?? 0 });
    }
    return out;
  }

  /** Compare the current state to a sample `daysAgo` for the "away" summary. */
  snapshotAt(daysAgo: number): PopulationSample | null {
    if (!this.samples.length) return null;
    const target = this.samples[this.samples.length - 1].day - daysAgo;
    let best: PopulationSample | null = null;
    for (const s of this.samples) {
      if (s.day <= target) best = s;
      else break;
    }
    return best;
  }

  get recent(): WorldEvent[] {
    return this.events.slice(-40).reverse();
  }

  /** Events on or near a given day (used by the documentary feed). */
  between(fromDay: number, toDay: number): WorldEvent[] {
    return this.events.filter((e) => e.day >= fromDay && e.day <= toDay);
  }

  save(): Record<string, unknown> {
    return {
      nextId: this.nextId,
      events: this.events.slice(-1200),
      discoveries: this.discoveries,
      samples: this.samples.map((s) => ({
        day: s.day,
        counts: s.counts,
        aggregates: s.aggregates,
        vegetation: s.vegetation,
        treeCount: s.treeCount,
        meanTraits: s.meanTraits.map((t) => Array.from(t)),
        generations: s.generations,
      })),
      records: {
        population: Array.from(this.records.population),
        generation: Array.from(this.records.generation),
        lifespanDays: Array.from(this.records.lifespanDays),
        treeCount: this.records.treeCount,
        fireArea: this.records.fireArea,
        lakeVolume: this.records.lakeVolume,
        migrationSize: this.records.migrationSize,
        droughtDays: this.records.droughtDays,
        birthRate: this.records.birthRate,
      },
      lastAnnounced: Array.from(this.lastAnnounced.entries()),
      extinctionAnnounced: Array.from(this.extinctionAnnounced),
      seenSpecies: Array.from(this.seenSpecies),
      introductions: Array.from(this.introductions.entries()),
      individuals: Array.from(this.individuals.values()),
    };
  }

  load(d: Record<string, any>): void {
    this.nextId = d.nextId ?? 1;
    this.events = d.events ?? [];
    this.discoveries = d.discoveries ?? [];
    this.discoveryKeys = new Set(this.discoveries.map((x) => x.key));
    this.samples = (d.samples ?? []).map((s: any) => ({
      day: s.day,
      counts: s.counts,
      aggregates: s.aggregates,
      vegetation: s.vegetation,
      treeCount: s.treeCount,
      meanTraits: (s.meanTraits ?? []).map((t: number[]) => Float32Array.from(t)),
      generations: s.generations,
    }));
    const r = d.records;
    if (r) {
      this.records.population = Int32Array.from(r.population ?? []);
      this.records.generation = Int32Array.from(r.generation ?? []);
      this.records.lifespanDays = Float32Array.from(r.lifespanDays ?? []);
      this.records.treeCount = r.treeCount ?? 0;
      this.records.fireArea = r.fireArea ?? 0;
      this.records.lakeVolume = r.lakeVolume ?? 0;
      this.records.migrationSize = r.migrationSize ?? 0;
      this.records.droughtDays = r.droughtDays ?? 0;
      this.records.birthRate = r.birthRate ?? 0;
    }
    this.lastAnnounced = new Map(d.lastAnnounced ?? []);
    this.extinctionAnnounced = new Set(d.extinctionAnnounced ?? []);
    this.seenSpecies = new Set(d.seenSpecies ?? []);
    this.introductions.clear();
    for (const [k, v] of d.introductions ?? []) this.introductions.set(k, v);
    this.individuals.clear();
    this.individualOrder = [];
    for (const r of d.individuals ?? []) {
      this.individuals.set(r.id, r);
      this.individualOrder.push(r.id);
    }
  }
}

/** Format helpers used by the history/detail panels. */
export function eventSummary(ev: WorldEvent): string {
  const season = Math.floor(((ev.day - 1) % TIME.daysPerYear) / TIME.daysPerSeason);
  const seasonName = ['Spring', 'Summer', 'Autumn', 'Winter'][season] ?? '';
  return `Year ${ev.year} · Day ${((ev.day - 1) % TIME.daysPerYear) + 1} · ${seasonName}`;
}

export function describeChange(from: number, to: number): string {
  if (from <= 0 && to <= 0) return 'still absent';
  if (from <= 0) return 'reappeared';
  const pct = (to - from) / Math.max(1, from);
  if (Math.abs(pct) < 0.03) return 'stable';
  return `${pct > 0 ? '+' : '−'}${fmtPct(Math.abs(pct))} (${fmtNum(from)} → ${fmtNum(to)})`;
}

export function stabilityIndex(samples: PopulationSample[], speciesIdx: number): number {
  const values = samples.map((s) => s.counts[speciesIdx] ?? 0).filter((v) => v > 0);
  if (values.length < 3) return 0.5;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const cv = Math.sqrt(variance) / mean;
  return clamp01(1 - cv / 1.6);
}
