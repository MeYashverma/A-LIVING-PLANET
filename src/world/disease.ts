import { clamp, clamp01, lerp } from '../core/math';
import { Random } from '../core/rng';
import { TIME } from '../core/config';
import { SPECIES } from '../life/species';
import type { Creatures } from '../life/organism';
import type { Terrain } from './terrain';
import type { Climate } from './climate';
import type { Vegetation } from './vegetation';

export type PathogenKind = 'virus' | 'bacteria' | 'parasite' | 'fungus' | 'prion';

export interface Pathogen {
  /** Index into SPECIES of the host species. */
  speciesIdx: number;
  kind: PathogenKind;
  name: string;
  /** Fraction of the living population currently infected. */
  prevalence: number;
  /** Fraction that has recovered and is now immune. */
  immunity: number;
  /** 0..1 — how sick it makes each host, and how fast it spreads. */
  virulence: number;
  /** Transmission efficiency — high for crowded, social hosts. */
  transmissibility: number;
  /** Days a host stays infectious. */
  infectiousDays: number;
  /** Additional mortality per day while infected, once symptomatic. */
  lethality: number;
  /** True while an outbreak is running. */
  active: boolean;
  /** Species this pathogen can spill over into (indices). */
  spillover: number[];
  /** Days since the outbreak began / since it faded. */
  ageDays: number;
  peakPrevalence: number;
  origin: string;
  /** Player-introduced pathogens behave the same but are logged differently. */
  deliberate: boolean;
}

interface PathogenSeed {
  species: string;
  kinds: PathogenKind[];
  names: string[];
  /** How the disease spreads, used for the origin text. */
  origins: string[];
}

const SEEDS: PathogenSeed[] = [
  {
    species: 'rabbit',
    kinds: ['virus', 'bacteria', 'parasite'],
    names: ['myxomatosis', 'rabbit haemorrhagic fever', 'coccidiosis', 'tularaemia'],
    origins: ['spread by biting insects after a warm wet spell', 'emerged in a crowded warren', 'carried in on the wind from over the ridge'],
  },
  {
    species: 'deer',
    kinds: ['virus', 'bacteria', 'parasite'],
    names: ['chronic wasting disease', 'bluetongue', 'foot rot', 'lungworm'],
    origins: ['passed between herds at a shared waterhole', 'emerged as the herds crowded into the valley', 'spread by midges in the warm season'],
  },
  {
    species: 'bison',
    kinds: ['bacteria', 'virus'],
    names: ['brucellosis', 'malignant catarrhal fever', 'anthrax'],
    origins: ['surfaced as the herd trampled the same ground for weeks', 'came out of the thawing soil', 'passed at a wallow'],
  },
  {
    species: 'wolf',
    kinds: ['virus', 'parasite'],
    names: ['distemper', 'mange', 'parvovirus'],
    origins: ['moved through the pack at a kill site', 'came with an injured pack member', 'spread at a den'],
  },
  {
    species: 'fox',
    kinds: ['virus', 'parasite'],
    names: ['sarcoptic mange', 'canine distemper', 'rabies'],
    origins: ['passed from a neighbouring territory', 'spread at a shared cache', 'arrived with an infected kill'],
  },
  {
    species: 'eagle',
    kinds: ['bacteria', 'virus', 'fungus'],
    names: ['avian pox', 'aspergillosis', 'west nile fever'],
    origins: ['contracted from an infected carcass', 'spread at a roost site', 'arrived with a sick prey animal'],
  },
  {
    species: 'owl',
    kinds: ['virus', 'fungus', 'parasite'],
    names: ['avian influenza', 'aspergillosis', 'trichomoniasis'],
    origins: ['carried by a migrating bird', 'spread at a winter roost', 'picked up from a shared kill'],
  },
  {
    species: 'raven',
    kinds: ['virus', 'bacteria'],
    names: ['avian influenza', 'avian pox', 'botulism'],
    origins: ['spread through the flock at a feeding site', 'came with a scavenged carcass', 'emerge from warm stagnant water'],
  },
  {
    species: 'bear',
    kinds: ['parasite', 'bacteria', 'virus'],
    names: ['trichinellosis', 'canine distemper', 'tularaemia'],
    origins: ['contracted from scavenged meat', 'spread at a salmon run', 'surfaced after a long denning winter'],
  },
  {
    species: 'trout',
    kinds: ['fungus', 'bacteria', 'parasite'],
    names: ['saprolegniasis', 'furunculosis', 'whirling disease', 'gill fluke'],
    origins: ['spread through a crowded pool as the river shrank', 'appeared in warming water', 'arrived with an introduced fish'],
  },
];

/**
 * Disease. Pathogens are simulated as populations *within* host populations:
 * an outbreak grows while there are susceptible hosts, immunity accumulates,
 * and the pathogen fades — the classic SIR shape — but crowding, condition and
 * weather all feed into it, and pathogens can spill over between related hosts.
 */
export class Disease {
  pathogens: Pathogen[] = [];
  /** 0..1 aggregate pressure across all species, used by the biodiversity index. */
  pressure = 0;
  /** Diseases that have appeared since the world began (for the encyclopedia). */
  history: { name: string; species: string; day: number; peak: number; kind: PathogenKind }[] = [];

  onOutbreak: ((p: Pathogen, x: number, y: number) => void) | null = null;
  onEmerge: ((p: Pathogen) => void) | null = null;

  private rng: Random;
  private terrain: Terrain;
  private climate: Climate;
  private vegetation: Vegetation | null = null;
  /** Per-species susceptibility multipliers from the food-web layer. */
  private vectorActivity = new Float32Array(SPECIES.length);

  constructor(seed: string, terrain: Terrain, climate: Climate) {
    this.rng = new Random(seed + ':disease');
    this.terrain = terrain;
    this.climate = climate;
  }

  attachVegetation(vegetation: Vegetation): void {
    this.vegetation = vegetation;
  }

  /** Number of outbreaks currently running. */
  get activeOutbreaks(): number {
    let n = 0;
    for (const p of this.pathogens) if (p.active) n++;
    return n;
  }

  /** Summary for the census / encyclopedia / inspector. */
  summary(speciesIdx: number): { name: string; prevalence: number; active: boolean; virulence: number } | null {
    for (const p of this.pathogens) {
      if (p.speciesIdx === speciesIdx) {
        return { name: p.name, prevalence: p.prevalence, active: p.active, virulence: p.virulence };
      }
    }
    return null;
  }

  /** Which pathogen is infecting this species right now (by index). */
  forSpecies(speciesIdx: number): Pathogen | null {
    for (const p of this.pathogens) if (p.speciesIdx === speciesIdx && p.active) return p;
    return null;
  }

  /** How much disease a species is exposed to, given density and environment. */
  private exposureFactor(speciesIdx: number, density: number, crowding: number, condition: number): number {
    const sp = SPECIES[speciesIdx];
    const temp = this.climate.temperatureAt(0, 0);
    // Many pathogens need warmth and moisture; drought suppresses some.
    const wet = this.vegetation ? clamp01(this.vegetation.stats.grass * 2) : 0.5;
    const warmth = clamp01((temp + 5) / 30);
    const socialFactor = sp.social === 'herd' || sp.social === 'pack' || sp.social === 'flock' || sp.social === 'school' ? 1.35 : 1;
    const densityFactor = clamp01(density / Math.max(6, sp.softCap * 0.35));
    const conditionFactor = 1 + (1 - clamp01(condition)) * 0.9;
    return (0.45 + densityFactor * 1.25) * socialFactor * (0.55 + warmth * 0.65) * (0.7 + wet * 0.5) * conditionFactor * (1 + crowding * 0.8);
  }

  /** Advance outbreaks. Called hourly in simulation time. */
  update(creatures: Creatures, days: number, day: number, crowding = 0): void {
    const dtDays = days;
    for (let si = 0; si < SPECIES.length; si++) {
      const sp = SPECIES[si];
      const stat = creatures.census;
      const population = stat.count[si];
      if (population <= 0) {
        // No hosts: any running outbreak dies with them.
        for (const p of this.pathogens) if (p.speciesIdx === si && p.active) this.fadeOut(p);
        continue;
      }
      let pathogen: Pathogen | null = null;
      for (const p of this.pathogens) if (p.speciesIdx === si) pathogen = p;

      const condition = this.averageCondition(creatures, si);
      const density = population;

      if (!pathogen) {
        // Spontaneous emergence: rare, and much more likely when hosts are
        // crowded, in poor condition, or in unusual weather.
        const exposure = this.exposureFactor(si, density, crowding, condition);
        const season = clamp01(this.climate.seasonalInstability());
        const chancePerDay = 0.000018 * exposure * (0.4 + season) * (1 / Math.max(1, sp.vectorAttraction + 0.3)) * this.hostAbundanceFactor(sp.key);
        if (this.rng.chance(clamp01(chancePerDay) * dtDays)) {
          this.emerge(si, day, false);
        }
        continue;
      }

      if (!pathogen.active) {
        // A dormant pathogen can re-emerge when hosts are stressed again.
        if (this.rng.chance(clamp01(0.0004 * this.exposureFactor(si, density, crowding, condition)) * dtDays * (0.5 + pathogen.virulence))) {
          this.reactivate(pathogen, day);
        }
        continue;
      }

      // The outbreak's numbers are read from the animals themselves, not kept
      // as a parallel bookkeeping value: prevalence *is* how many of this
      // species are currently ill, and immunity is how many have recovered.
      // One source of truth means the inspector, the encyclopedia and the
      // epidemic cannot disagree with each other.
      const counts = this.countHosts(creatures, si);
      pathogen.ageDays += dtDays;
      pathogen.prevalence = counts.population > 0 ? counts.infected / counts.population : 0;
      pathogen.immunity = counts.population > 0 ? counts.recovered / counts.population : 0;
      pathogen.peakPrevalence = Math.max(pathogen.peakPrevalence, pathogen.prevalence);

      // Transmission. Infection spreads between individuals that are actually
      // near each other, weighted by how sociable the species is: a crowded
      // warren or a packed shoal moves a pathogen far faster than scattered
      // solitary hunters.
      const social = sp.social === 'herd' || sp.social === 'pack' || sp.social === 'flock' || sp.social === 'school' ? 1.35 : 1;
      const baseContact = pathogen.transmissibility * (0.45 + pathogen.virulence) * dtDays * 0.55 * social;
      if (counts.infected > 0) {
        for (let i = 0; i < creatures.capacity; i++) {
          if (!creatures.alive[i] || creatures.speciesIdx[i] !== si) continue;
          if (creatures.infection[i] !== 0) continue;
          const local = this.localDensity(creatures, i, si);
          const resistance = clamp01(creatures.diseaseResistance(i));
          const chance = clamp01(baseContact * pathogen.prevalence * (0.25 + local) * (1 - resistance));
          if (chance > 0 && this.rng.chance(chance)) {
            // A bite, a sneeze, a shared waterhole. The vector activity of the
            // season decides how many of these chances actually land.
            const vector = this.vectorPressureAt(si, creatures.x[i], creatures.y[i]);
            if (this.rng.chance(clamp01(0.55 + vector * 0.5))) {
              creatures.infection[i] = 1;
              creatures.infectionDays[i] = 0;
            }
          }
        }
      }

      // Herd immunity erodes as susceptible young are born into the population;
      // the recovered keep their immunity, but the pool they sit in grows.
      const birthRate = clamp01(creatures.census.birthsToday[si] / Math.max(1, population) * 6);
      if (birthRate > 0) pathogen.immunity = clamp01(pathogen.immunity - pathogen.immunity * birthRate * dtDays);

      if (counts.infected === 0 && pathogen.ageDays > 12) this.fadeOut(pathogen);
      if (pathogen.prevalence < 0.01 && pathogen.ageDays > 30) this.fadeOut(pathogen);
    }

    // Aggregate pressure.
    let total = 0;
    for (const p of this.pathogens) {
      total += (p.active ? 1 : 0.25) * p.prevalence * (0.5 + p.virulence);
    }
    this.pressure = clamp01(total * 2.6);
    this.updateVectors();
  }

  private averageCondition(creatures: Creatures, si: number): number {
    const c = creatures;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i] || c.speciesIdx[i] !== si) continue;
      sum += clamp01(c.health[i] * 0.6 + c.energy[i] * 0.4);
      n++;
    }
    return n > 0 ? sum / n : 0.6;
  }

  /** How abundant a host's preferred prey is — predators get parasites from prey. */
  private hostAbundanceFactor(key: string): number {
    if (this.vegetation) {
      if (key === 'rabbit' || key === 'deer' || key === 'bison') return clamp(0.5 + this.vegetation.stats.grass * 2, 0.5, 1.6);
      if (key === 'trout') return clamp(0.6 + this.terrain.wetFraction() * 2, 0.5, 1.5);
    }
    return 1;
  }

  /** How many hosts are in each disease state, and how many are alive. */
  private countHosts(creatures: Creatures, si: number): { population: number; infected: number; recovered: number } {
    const c = creatures;
    let population = 0;
    let infected = 0;
    let recovered = 0;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i] || c.speciesIdx[i] !== si) continue;
      population++;
      if (c.infection[i] === 1) infected++;
      else if (c.infection[i] === 2) recovered++;
    }
    return { population, infected, recovered };
  }

  /**
   * Conspecifics within contact range, as a rough crowding number. A pathogen
   * needs hosts to be near each other; a scattered population barely transmits.
   */
  private localDensity(creatures: Creatures, slot: number, si: number): number {
    const c = creatures;
    const n = c.grid.queryRadius(c.x[slot], c.y[slot], 70, c.scratch);
    let same = 0;
    for (let k = 0; k < n; k++) {
      const other = c.scratch[k];
      if (other === slot || c.speciesIdx[other] !== si) continue;
      same++;
    }
    return clamp01(same / 24) * 1.6;
  }

  /** Whether insects and other vectors are active — feeds disease and foraging. */
  updateVectors(): void {
    const temp = this.climate.temperatureAt(0, 0);
    const activity = clamp01((temp - 4) / 22) * (0.6 + clamp01(this.climate.rainAt(0, 0) * 2) * 0.4);
    for (let i = 0; i < SPECIES.length; i++) {
      this.vectorActivity[i] = activity * SPECIES[i].vectorAttraction;
    }
  }

  vectorPressureAt(speciesIdx: number, x: number, y: number): number {
    const temp = this.climate.temperatureAt(x, y);
    const warm = clamp01((temp - 4) / 22);
    const wet = clamp01(this.terrain.soilMoistureAtWorld(x, y) * 1.4);
    return this.vectorActivity[speciesIdx] * warm * (0.4 + wet * 0.8);
  }

  /** Start a new outbreak for a species (spontaneous or player-triggered). */
  emerge(speciesIdx: number, day: number, deliberate: boolean, kind?: PathogenKind, name?: string): Pathogen {
    const seed = SEEDS.find((s) => s.species === SPECIES[speciesIdx].key) ?? SEEDS[0];
    const chosenKind = kind ?? seed.kinds[this.rng.int(0, seed.kinds.length - 1)];
    const pathogen: Pathogen = {
      speciesIdx,
      kind: chosenKind,
      name: name ?? seed.names[this.rng.int(0, seed.names.length - 1)],
      prevalence: 0.02 + this.rng.next() * 0.04,
      immunity: 0,
      virulence: clamp(0.25 + this.rng.next() * 0.55 + (deliberate ? 0.15 : 0), 0.15, 0.95),
      transmissibility: clamp(0.35 + this.rng.next() * 0.6, 0.2, 1),
      infectiousDays: 4 + this.rng.next() * 22,
      lethality: clamp(0.004 + this.rng.next() * 0.05, 0.002, 0.07),
      active: true,
      spillover: this.findSpillover(speciesIdx),
      ageDays: 0,
      peakPrevalence: 0,
      origin: seed.origins[this.rng.int(0, seed.origins.length - 1)],
      deliberate,
    };
    // Replace any dormant pathogen for this species.
    this.pathogens = this.pathogens.filter((p) => p.speciesIdx !== speciesIdx);
    this.pathogens.push(pathogen);
    this.history.push({ name: pathogen.name, species: SPECIES[speciesIdx].key, day, peak: 0, kind: pathogen.kind });
    const origin = this.terrain.regionCenter(this.rng.int(0, Math.max(0, this.terrain.regions.length - 1)));
    this.onOutbreak?.(pathogen, origin.x, origin.y);
    this.onEmerge?.(pathogen);
    return pathogen;
  }

  private reactivate(p: Pathogen, day: number): void {
    p.active = true;
    p.ageDays = 0;
    p.prevalence = Math.max(p.prevalence, 0.02);
    p.virulence = clamp(p.virulence * 1.05, 0.2, 0.95);
    this.history.push({ name: p.name, species: SPECIES[p.speciesIdx].key, day, peak: 0, kind: p.kind });
    this.onOutbreak?.(p, 0, 0);
  }

  private fadeOut(p: Pathogen): void {
    p.active = false;
    p.ageDays = 0;
    for (const entry of this.history) {
      if (entry.name === p.name && entry.species === SPECIES[p.speciesIdx].key && entry.peak === 0) {
        entry.peak = p.peakPrevalence;
      }
    }
    p.peakPrevalence = 0;
  }

  /**
   * Which other species this pathogen could jump into. Related hosts
   * (canids → canids, birds → birds, rodents → rodents) are allowed.
   */
  private findSpillover(speciesIdx: number): number[] {
    const sp = SPECIES[speciesIdx];
    const out: number[] = [];
    for (let i = 0; i < SPECIES.length; i++) {
      if (i === speciesIdx) continue;
      const other = SPECIES[i];
      const sameClass = other.locomotion === sp.locomotion;
      const bothSmall = other.massKg < 30 && sp.massKg < 30;
      const bothLarge = other.massKg > 30 && sp.massKg > 30;
      if (sameClass && (bothSmall || bothLarge)) out.push(i);
    }
    return out;
  }

  /** Deliberate release (sandbox tool). */
  release(speciesIdx: number, day: number, kind?: PathogenKind): Pathogen {
    const p = this.emerge(speciesIdx, day, true, kind);
    p.prevalence = Math.max(p.prevalence, 0.08);
    p.virulence = Math.max(p.virulence, 0.45);
    return p;
  }

  /** Percent of living hosts currently infected, for the HUD. */
  prevalenceAt(speciesIdx: number): number {
    const best = this.forSpecies(speciesIdx);
    return best ? best.prevalence : 0;
  }

  /** Age-adjusted risk: old and young hosts suffer more. */
  static riskForAge(ageFraction: number): number {
    return lerp(1.6, 1.0, clamp01(Math.abs(ageFraction - 0.35) * 2.2));
  }

  save(): Record<string, unknown> {
    return {
      pathogens: this.pathogens.map((p) => ({ ...p, spillover: p.spillover })),
      history: this.history.slice(-200),
      pressure: this.pressure,
    };
  }

  load(d: Record<string, any>): void {
    this.pathogens = (d.pathogens ?? []).map((p: Pathogen) => ({ ...p, spillover: p.spillover ?? [] }));
    this.history = d.history ?? [];
    this.pressure = d.pressure ?? 0;
  }

  /** Day-length helper for the UI: how long the current outbreak has run. */
  describe(p: Pathogen): string {
    const sp = SPECIES[p.speciesIdx];
    const state = p.active ? 'active outbreak' : 'faded';
    return `${p.name} (${p.kind}) in ${sp.name.toLowerCase()}s — ${state}, ${(p.prevalence * 100).toFixed(1)}% infected, ${(p.immunity * 100).toFixed(0)}% immune, virulence ${(p.virulence * 100).toFixed(0)}%.`;
  }
}

void TIME;
