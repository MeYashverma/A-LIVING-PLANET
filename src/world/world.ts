import { EventBus, type AppEvents, type OfflineSummary, type WorldEvent } from '../core/events';
import { Random } from '../core/rng';
import { clamp, clamp01, lerp, TAU } from '../core/math';
import { FIRE, LIFE, SIM, TIME } from '../core/config';
import { WorldClock, SEASON_NAMES } from '../core/time';
import { Terrain, type WorldParams } from './terrain';
import { Climate, type ClimateEvent } from './climate';
import { Hydrology } from './hydrology';
import { Soil } from './soil';
import { Vegetation } from './vegetation';
import { Forest } from './trees';
import { Fire } from './fire';
import { Aggregates } from './aggregates';
import { Disease } from './disease';
import { Census } from './census';
import { History } from './history';
import { BIOMES, Biome, biomeName, isWaterBiome, PLANT_LAYERS, PLANT_INDEX } from './biomes';
import { Creatures, Action, Stage, MemKind } from '../life/organism';
import { CarcassStore } from '../life/carcass';
import { SocialSystem } from '../life/ai';
import { Genome, ANIMAL_TEMPLATE } from '../life/genome';
import { SPECIES, type SpeciesDef } from '../life/species';
import { simulateCreature } from '../life/creatureSim';

export interface TrackMark {
  x: number;
  y: number;
  /** Species index that made it. */
  speciesIdx: number;
  /** 0..1 strength (footprints fade). */
  strength: number;
  day: number;
}

export interface SimStats {
  fps: number;
  simMs: number;
  renderMs: number;
  creatures: number;
  trees: number;
  simMinutesPerSecond: number;
  stepsThisFrame: number;
}

/**
 * The world: terrain, climate, water, soil, plants, animals, disease, fire and
 * the history they generate. Everything the interface shows is read from here.
 */
export class World {
  readonly seed: string;
  name: string;
  params: WorldParams;
  clock: WorldClock;
  terrain: Terrain;
  climate: Climate;
  hydrology: Hydrology;
  soil: Soil;
  vegetation: Vegetation;
  forest: Forest;
  fire: Fire;
  aggregates: Aggregates;
  disease: Disease;
  creatures: Creatures;
  carcasses: CarcassStore;
  social: SocialSystem;
  census: Census;
  history: History;
  bus: EventBus<AppEvents>;
  rng: Random;

  /** Where the player's attention is (animals notice; it is a real thing in the world). */
  playerPresence: { x: number; y: number; intensity?: number } | null = null;

  /** Scratch id buffer shared by spatial queries. */
  readonly scratchIds = new Int32Array(1024);

  /** Recent footprints for rendering and for track-following AI. */
  tracks: TrackMark[] = [];
  maxTracks = 1400;
  private trackCooldown = new Map<number, number>();

  stats: SimStats = { fps: 0, simMs: 0, renderMs: 0, creatures: 0, trees: 0, simMinutesPerSecond: 0, stepsThisFrame: 0 };

  /** Diagnostics. */
  errors: string[] = [];
  private lastDay = 1;
  private accumulator = 0;
  private cadence: Record<string, number> = {};
  private notifyCooldown = new Map<string, number>();
  private lastSimMs = 0;

  constructor(params: WorldParams) {
    this.seed = params.seed;
    this.params = params;
    this.name = params.name;
    this.bus = new EventBus<AppEvents>();
    this.rng = new Random(params.seed + ':world');
    this.clock = new WorldClock(1);

    this.terrain = new Terrain(params);
    this.terrain.generate();

    this.climate = new Climate(this.terrain, this.clock, params.seed);
    this.hydrology = new Hydrology(this.terrain, this.climate);
    this.soil = new Soil(this.terrain, this.climate);
    this.vegetation = new Vegetation(this.terrain, this.climate);
    this.forest = new Forest(this.terrain, this.climate, params.seed);
    this.fire = new Fire(this.terrain, this.climate, this.vegetation, this.forest, params.seed);
    this.aggregates = new Aggregates(this.terrain, this.climate, this.vegetation, params.seed);
    this.disease = new Disease(params.seed, this.terrain, this.climate);
    this.creatures = new Creatures(params.seed, this.terrain.worldSize);
    this.carcasses = new CarcassStore(params.seed);
    this.social = new SocialSystem();
    this.census = new Census();
    this.history = new History();

    this.wireSubsystems();
    this.forest.seedInitialForest();
    this.forest.refreshCanopy();
    // Measure the young world before anything moves: the opening report is a
    // real measurement of the landscape the player is about to watch, not a
    // placeholder that fills in an hour later.
    this.vegetation.recomputeStats();
    this.seedFounders();
    this.census.update(this, true);
    this.history.sample(this);
    this.hydrology.seaFill();
    this.hydrology.refreshWetSet(true);
    this.pushEvent({
      kind: 'discovery',
      title: `${this.name} came into being`,
      detail: `${SPECIES.length} species placed across ${(this.terrain.worldSize / 1000).toFixed(1)} km of wilderness, under the seed “${this.seed}”.`,
      weight: 2,
    });
  }

  private wireSubsystems(): void {
    this.climate.onLightning = (cx, cy) => {
      const ignited = this.fire.strike(cx, cy);
      if (ignited) this.onFireStarted(cx, cy, 'lightning');
    };
    this.climate.onEventStart = (e) => {
      this.pushEvent({
        kind: 'climate',
        title: `${e.label} begins`,
        detail: describeClimateEvent(e),
        weight: e.kind === 'drought' || e.kind === 'coldwave' ? 2 : 1,
        x: 0,
        y: 0,
      });
    };
    this.climate.onEventEnd = (e) => {
      this.pushEvent({ kind: 'climate', title: `${e.label} ends`, weight: 1 });
      if (e.kind === 'drought') {
        this.history.discover('drought-survived', 'Drought survived', `The world held its water through a ${Math.round(e.total / TIME.minutesPerDay)}-day drought.`, this.clock.day, this.clock.year, 2);
      }
    };
    this.fire.onIgnite = (cx, cy) => this.onFireStarted(cx, cy, 'spontaneous');
    this.fire.onExtinguished = (r) => {
      const area = r.cellsBurned * this.terrain.cellUnits * this.terrain.cellUnits;
      const pct = (r.cellsBurned / (this.terrain.size * this.terrain.size)) * 100;
      this.pushEvent({
        kind: 'disaster',
        title: 'Wildfire burned out',
        detail: `${pct.toFixed(1)}% of the world was scorched, ${Math.round(area / 1000)} ha affected, ${r.treesLost} trees lost.`,
        weight: pct > 12 ? 3 : 2,
        x: r.x,
        y: r.y,
      });
      if (area > this.history.records.fireArea) {
        this.history.records.fireArea = area;
        this.history.discover('major-fire', 'Major wildfire', `The largest fire so far covered ${Math.round(area / 1000)} hectares.`, this.clock.day, this.clock.year, 2);
      }
      this.markRecovery(r.x, r.y);
    };
    this.disease.onOutbreak = (p, x, y) => {
      const sp = SPECIES[p.speciesIdx];
      this.pushEvent({
        kind: 'disease',
        title: `Disease outbreak among ${sp.name.toLowerCase()}s`,
        detail: `A ${p.name} outbreak began. Virulence ${(p.virulence * 100).toFixed(0)}%.`,
        weight: 2,
        speciesId: sp.key,
        x,
        y,
      });
      this.history.discover('first-outbreak', 'First disease outbreak', `${sp.name}s were struck by ${p.name}.`, this.clock.day, this.clock.year, 2);
    };
    this.carcasses.onDecompose = (x, y, mass, speciesIdx) => {
      const cx = clamp(Math.round(this.terrain.worldToCellX(x)), 0, this.terrain.last);
      const cy = clamp(Math.round(this.terrain.worldToCellY(y)), 0, this.terrain.last);
      this.soil.addDetritus(cx, cy, mass * 0.4);
      this.soil.addNutrients(cx, cy, mass * 0.12);
      void speciesIdx;
    };
    this.creatures.onDeath = (slot, speciesIdx, cause) => this.handleDeath(slot, speciesIdx, cause);
    this.creatures.onBirth = () => {
      /* handled in spawnLitter via onMating/onBirth hooks */
    };
    this.social.onGroupFormed = (g) => {
      const sp = SPECIES[g.speciesIdx];
      if (sp.social === 'pack' || sp.social === 'herd') {
        this.throttled(`group-${sp.key}`, 12, () => {
          this.pushEvent({
            kind: 'colony',
            title: `A ${sp.social} of ${sp.name.toLowerCase()}s formed`,
            detail: `Group behaviour has emerged in the ${this.terrain.regionNameAt(g.centerX, g.centerY)}.`,
            weight: 0,
          });
        });
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Seeding                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Place the founding population of every species according to habitat. Most
   * founders arrive as adults in prime condition — a world seeded entirely with
   * juveniles would take years of real time to produce its first generation —
   * but a quarter are young, so the population starts with an age structure.
   */
  private seedFounders(): void {
    const rng = this.rng;
    // Founders are a food pyramid, not a census of equals: many small prey,
    // a healthy spread of large herbivores, and comparatively few predators.
    // A world seeded with as many hunters as hunted collapses within days
    // however good the AI is.
    const foundationCounts: Record<string, number> = {
      rabbit: 90,
      deer: 40,
      bison: 24,
      wolf: 5,
      fox: 4,
      eagle: 3,
      owl: 3,
      raven: 10,
      bear: 2,
      trout: 90,
      goat: 24,
      lynx: 2,
      perch: 40,
      heron: 3,
    };
    const scale = clamp01(this.params.seeding) * (this.terrain.size / 288);
    for (let s = 0; s < SPECIES.length; s++) {
      const sp = SPECIES[s];
      let want = Math.round((foundationCounts[sp.key] ?? 6) * scale);
      if (want <= 0) continue;
      const sites = this.findSuitableSites(s, want * 6);
      if (!sites.length) continue;
      let placed = 0;
      let guard = 0;
      while (placed < want && guard++ < want * 30) {
        const site = sites[rng.int(0, sites.length - 1)];
        const genome = this.founderGenome(sp, rng);
        // Alternate the sexes exactly, so a small founding group can breed.
        const sex: 0 | 1 = placed % 2 === 0 ? 1 : 0;
        const young = placed % 4 === 3;
        const ageYears = young
          ? rng.range(0.15, 0.8) * sp.maturityYears
          : rng.range(1.0, 1.0 + Math.min(0.9, sp.maxAgeYears * 0.35 > sp.maturityYears ? sp.maturityYears * 0.8 : 0.5)) * sp.maturityYears;
        const slot = this.creatures.spawn({
          speciesIdx: s,
          x: site.x,
          y: site.y,
          genome,
          sex,
          ageDays: ageYears * TIME.daysPerYear,
          energy: rng.range(0.7, 0.95),
          health: rng.range(0.85, 1),
        });
        if (slot < 0) break;
        // A founding cohort that arrives in spring is not a group of empty
        // females: some are already carrying young, at various stages. Without
        // this the world spends its first gestation period childless while
        // predators eat through the founders, which is not how a spring
        // colonisation looks. Staggered terms produce a birth pulse, not a
        // single simultaneous litter.
        if (sex === 1 && ageYears >= sp.maturityYears * 1.05 && sp.gestationDays < 400 && rng.chance(0.55)) {
          const [lo, hi] = sp.litterSize;
          this.creatures.pregnantLeft[slot] = sp.gestationDays * rng.range(0.08, 0.55);
          this.creatures.fetusCount[slot] = Math.max(1, Math.round(lerp(lo, hi, 0.35 + rng.next() * 0.5)));
          this.creatures.pregnancyCount[slot]++;
        }
        placed++;
      }
    }
  }

  /** Founder genomes are drawn around the species' typical trait values. */
  private founderGenome(sp: SpeciesDef, rng: Random): Genome {
    const values = new Float32Array(ANIMAL_TEMPLATE.traits.length);
    ANIMAL_TEMPLATE.traits.forEach((t, i) => {
      const base = sp.baseTraits[t.key] ?? (t.lo + t.hi) / 2;
      values[i] = clamp(base + rng.gauss() * (t.hi - t.lo) * 0.075, t.lo, t.hi);
    });
    return new Genome(ANIMAL_TEMPLATE, values, 1);
  }

  /** Random sample of positions this species could actually live in. */
  private findSuitableSites(speciesIdx: number, count: number): { x: number; y: number }[] {
    const t = this.terrain;
    const sp = SPECIES[speciesIdx];
    const out: { x: number; y: number }[] = [];
    const rng = this.rng;
    let tries = 0;
    while (out.length < count && tries++ < count * 60) {
      const cx = rng.int(2, t.size - 3);
      const cy = rng.int(2, t.size - 3);
      const i = cy * t.size + cx;
      if (!t.land[i]) continue;
      const biome = t.biome.data[i] as Biome;
      const affinity = sp.habitat[biome] ?? 0;
      if (affinity <= 0.05) continue;
      const elev = t.elevationOf(t.height.data[i]);
      if (elev < sp.elevationRange[0] || elev > sp.elevationRange[1]) continue;
      if (sp.locomotion === 'fish') {
        const depth = t.waterDepth.data[i];
        const isWater = isWaterBiome(biome) || depth > 0.25;
        if (!isWater || depth > 4) continue;
      } else if (t.waterDepth.data[i] > 0.6) continue;
      if (rng.next() > affinity) continue;
      out.push({ x: t.cellToWorldX(cx), y: t.cellToWorldY(cy) });
    }
    // Not enough good sites: fall back to any land (the species will disperse).
    if (!out.length) {
      for (let k = 0; k < count; k++) {
        const cx = rng.int(2, t.size - 3);
        const cy = rng.int(2, t.size - 3);
        if (t.land[cy * t.size + cx]) out.push({ x: t.cellToWorldX(cx), y: t.cellToWorldY(cy) });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Main update                                                        */
  /* ------------------------------------------------------------------ */

  /** Advance the world by real time. Returns simulated minutes advanced. */
  update(realSeconds: number): number {
    const started = performance.now();
    const owed = Math.min(this.clock.minutesOwed(realSeconds), TIME.maxMinutesPerFrame);
    // Whole steps only. A frame at 1x owes about 0.017 minutes, and running a
    // full step for each frame's sliver of time cost a step per frame. Time
    // accumulates here instead, so a step runs once per simulated step.
    this.owedMinutes += owed;
    const stepLen = this.stepLength();
    let steps = 0;
    const budgetMs = 9;
    while (this.owedMinutes >= stepLen - 1e-9) {
      this.step(stepLen);
      this.owedMinutes -= stepLen;
      steps++;
      if (steps > 6 && performance.now() - started > budgetMs) {
        // If we cannot keep up, drop the rest of the owed time rather than
        // stalling the frame: the clock falls behind a little, not forever.
        break;
      }
      if (steps > 180) break;
    }
    this.owedMinutes = Math.min(this.owedMinutes, stepLen);
    this.stats.stepsThisFrame = steps;
    this.stats.simMs = performance.now() - started;
    this.lastSimMs = this.stats.simMs;
    this.stats.simMinutesPerSecond = this.stats.simMs > 0 ? (owed / this.stats.simMs) * 1000 : 0;
    return owed;
  }

  private owedMinutes = 0;

  /**
   * In-game time for the renderer. The clock only moves in whole steps, so this
   * adds the time owed but not yet stepped: sky, water and wind animation then
   * move every frame, not once a second.
   */
  get smoothMinutes(): number {
    return this.clock.minutes + this.owedMinutes;
  }

  /** Length of one simulation step at the current speed, in in-game minutes. */
  private stepLength(): number {
    return SIM.stepMinutes * (this.clock.speed > 40 ? 2 : 1);
  }

  /** Fraction of the way from the last simulation step to the next (0..1), for rendering. */
  get frameAlpha(): number {
    return Math.min(1, Math.max(0, this.owedMinutes / this.stepLength()));
  }

  /** Advance simulation by an exact number of minutes (fast-forward, catch-up). */
  advance(minutes: number, budgetMs = 4000): void {
    const started = performance.now();
    let remaining = minutes;
    while (remaining > 0.001) {
      const dt = Math.min(this.clock.speed > 40 ? 4 : 2, remaining);
      this.step(dt);
      remaining -= dt;
      if (performance.now() - started > budgetMs) break;
    }
  }

  /** A single simulation step of `dt` in-game minutes. */
  step(dt: number): void {
    try {
      this.clock.advanceMinutes(dt);
      this.climate.beginStep(dt);
      this.climate.update(dt);
      // The heavier field simulators run at their own cadence. Plants and soil
      // do not need two-minute resolution; water does, because it flows.
      if (this.due('hydro', dt, 3)) this.hydrology.update(3);
      if (this.due('soil', dt, 6)) this.soil.update(6);
      if (this.due('veg', dt, 6)) this.vegetation.update(6);
      if (this.due('forest', dt, 18)) this.forest.update(18);
      this.fire.update(dt, this.terrain.soilMoisture.data);
      if (this.due('agg', dt, 6)) this.aggregates.update(6);
      this.updateCreatureGrid();

      // Individual animals think and move.
      const c = this.creatures;
      for (let i = 0; i < c.capacity; i++) {
        if (c.alive[i]) simulateCreature(this, i, dt);
      }
      c.tick(dt, this.clock.day);
      c.ageTrails(dt);

      // Thirty minutes of real simulation time, expressed in days: the SIR step
      // must match the clock, or an epidemic burns through a generation a minute.
      if (this.due('disease', dt, 30)) this.disease.update(c, 30 / TIME.minutesPerDay, this.clock.day);
      if (this.due('social', dt, 15)) this.social.update(this, 15);
      if (this.due('carcass', dt, 20)) {
        const leach = this.carcasses.update(20 / TIME.minutesPerDay, this.climate);
        for (const l of leach) {
          const cx = clamp(Math.round(this.terrain.worldToCellX(l.x)), 0, this.terrain.last);
          const cy = clamp(Math.round(this.terrain.worldToCellY(l.y)), 0, this.terrain.last);
          this.soil.addNutrients(cx, cy, l.amount * 0.4);
        }
      }
      if (this.due('canopy', dt, 30)) this.forest.refreshCanopy();
      if (this.due('census', dt, 60)) this.census.update(this, true);
      if (this.due('events', dt, 60)) this.detectNotableEvents();
      if (this.due('fire-spont', dt, 90)) this.fire.spontaneous(90);
      if (this.due('day', dt, 1)) this.onMinuteTick();

      // Daily rollover.
      if (this.clock.day !== this.lastDay) {
        const previous = this.lastDay;
        this.lastDay = this.clock.day;
        this.onNewDay(previous);
      }
      this.stats.creatures = c.aliveCount();
      this.stats.trees = this.forest.store.count;
    } catch (err) {
      this.reportError('world:step', err);
    }
  }

  /** Called once per simulated minute-ish for cheap bookkeeping. */
  private onMinuteTick(): void {
    this.playerPresence = this.playerPresence ?? null;
  }

  /** Rebuild the neighbour index used by perception and disease. */
  private updateCreatureGrid(): void {
    const c = this.creatures;
    c.grid.clear();
    for (let i = 0; i < c.capacity; i++) {
      if (c.alive[i]) c.grid.insert(i, c.x[i], c.y[i]);
    }
  }

  private due(key: string, dt: number, everyMinutes: number): boolean {
    const current = (this.cadence[key] ?? 0) + dt;
    if (current >= everyMinutes) {
      this.cadence[key] = 0;
      return true;
    }
    this.cadence[key] = current;
    return false;
  }

  private onNewDay(previousDay: number): void {
    const c = this.creatures;
    c.census.birthsToday.fill(0);
    c.census.deathsToday.fill(0);
    this.history.sample(this);

    // Seasonal announcements.
    const seasonBefore = Math.floor(((previousDay - 1) % TIME.daysPerYear) / TIME.daysPerSeason);
    const seasonNow = Math.floor(((this.clock.day - 1) % TIME.daysPerYear) / TIME.daysPerSeason);
    if (seasonBefore !== seasonNow) {
      this.pushEvent({
        kind: 'climate',
        title: `${SEASON_NAMES[seasonNow]} begins`,
        detail: `${SEASON_NAMES[seasonNow]} in the ${this.name} wilderness.`,
        weight: 1,
      });
      this.bus.emit('season:change', { season: seasonNow, year: this.clock.year });
      // Seasonal migrations: herds set off as the seasons turn.
      this.triggerSeasonalMigration(seasonNow);
    }
    this.bus.emit('time:day', { day: this.clock.day, year: this.clock.year });

    // Extinction checks are day-granular.
    for (let s = 0; s < SPECIES.length; s++) {
      const sp = SPECIES[s];
      const count = this.creatures.census.count[s];
      const prevRecord = this.history.records.population[s];
      if (count > prevRecord) {
        this.history.records.population[s] = count;
        if (prevRecord > 0 && count > prevRecord && count > 20) {
          this.throttled(`poprecord-${sp.key}`, 30, () => {
            this.pushEvent({
              kind: 'population',
              title: `${sp.name} population at a record ${count}`,
              detail: `The highest count ever recorded in this world (previous record ${prevRecord}).`,
              weight: 1,
              speciesId: sp.key,
            });
          });
        }
      }
      if (count === 0 && !this.history.hasSeenSpecies(s)) {
        continue;
      }
      if (count === 0) {
        this.throttled(`extinct-${sp.key}`, 365, () => {
          const wasKnown = this.history.hasSeenSpecies(s);
          if (!wasKnown) return;
          this.pushEvent({
            kind: 'population',
            title: `${sp.name}s are gone`,
            detail: `No living ${sp.name.toLowerCase()} remains in this world.`,
            weight: 3,
            speciesId: sp.key,
          });
          this.bus.emit('species:extinct', { speciesId: sp.key, day: this.clock.day });
          const d = this.history.discover(
            `extinction-${sp.key}`,
            'First extinction observed',
            `You were watching when the last ${sp.name.toLowerCase()} disappeared.`,
            this.clock.day,
            this.clock.year,
            3,
          );
          if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
        });
      } else {
        this.history.markSpeciesSeen(s);
      }
    }
  }

  private triggerSeasonalMigration(season: number): void {
    // Herds move downhill before winter and uphill in spring; birds move to
    // their breeding or wintering grounds.
    for (const g of this.social.groups) {
      const sp = SPECIES[g.speciesIdx];
      if (sp.locomotion !== 'quadruped' && sp.locomotion !== 'bird') continue;
      if (sp.social === 'solitary') continue;
      if (g.members.length < 2) continue;
      const elev = this.terrain.elevationAtWorld(g.centerX, g.centerY);
      const winter = season === 3;
      const spring = season === 0;
      if (!winter && !spring) continue;
      if (this.rng.chance(winter ? 0.5 : 0.35)) {
        const targetElev = winter ? 1 : elev + 8;
        const sites = this.findSuitableSites(g.speciesIdx, 24).filter((s) => {
          const e = this.terrain.elevationAtWorld(s.x, s.y);
          return winter ? e < targetElev + 3 : e > targetElev - 4;
        });
        if (sites.length) {
          const pick = sites[this.rng.int(0, sites.length - 1)];
          this.social.setMigration(this.creatures, g, pick.x, pick.y);
          this.throttled(`migration-${sp.key}`, 20, () => {
            this.pushEvent({
              kind: 'climate',
              title: `${sp.name}s are migrating`,
              detail: `A ${sp.social} of ${g.members.length} is moving ${winter ? 'down out of the high country' : 'up to the summer pastures'}.`,
              weight: 1,
              speciesId: sp.key,
              x: g.centerX,
              y: g.centerY,
            });
          });
          if (g.members.length > this.history.records.migrationSize) {
            this.history.records.migrationSize = g.members.length;
            const d = this.history.discover('largest-migration', 'Largest migration', `A group of ${g.members.length} ${sp.name.toLowerCase()}s moved together.`, this.clock.day, this.clock.year, 1);
            if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Death                                                              */
  /* ------------------------------------------------------------------ */

  private handleDeath(slot: number, speciesIdx: number, cause: string): void {
    const c = this.creatures;
    const sp = SPECIES[speciesIdx];
    this.census.recordDeath(c.speciesIdx[slot]);
    const id = c.id[slot];
    const scale = c.bodyScale(slot);
    // Records keep the individual's identity available for the family tree.
    this.history.recordIndividual({
      id,
      speciesIdx: c.speciesIdx[slot],
      birthDay: this.clock.day - c.ageDays[slot],
      deathDay: this.clock.day,
      ageDays: c.ageDays[slot],
      parents: [c.motherId[slot] >= 0 ? c.motherId[slot] : 0, c.fatherId[slot] >= 0 ? c.fatherId[slot] : 0],
      offspring: c.offspringCount[slot],
      generation: c.generation[slot],
      cause,
      traits: c.genome[slot] ? Array.from(c.genome[slot]!.values) : undefined,
      favourite: false,
      name: null,
    });
    // A body is left behind: food for scavengers, then nutrients for the soil.
    const mass = sp.massKg * scale * (c.stage[slot] === Stage.Juvenile ? 0.4 : 1);
    if (cause !== 'wildfire' || this.rng.chance(0.4)) {
      this.carcasses.spawn(c.x[slot], c.y[slot], c.speciesIdx[slot], mass * 0.85, cause, this.clock.day, scale);
    } else {
      // Burned to ash: nutrients return immediately.
      const cx = clamp(Math.round(this.terrain.worldToCellX(c.x[slot])), 0, this.terrain.last);
      const cy = clamp(Math.round(this.terrain.worldToCellY(c.y[slot])), 0, this.terrain.last);
      this.soil.addNutrients(cx, cy, 0.04);
    }
    // Longevity record.
    const ageYears = c.ageDays[slot] / TIME.daysPerYear;
    if (ageYears > this.history.records.lifespanDays[c.speciesIdx[slot]]) {
      this.history.records.lifespanDays[c.speciesIdx[slot]] = ageYears;
      if (ageYears > sp.maxAgeYears * 0.9) {
        const d = this.history.discover(
          'longest-lived',
          'Longest-lived individual',
          `A ${sp.name.toLowerCase()} (${tagFor(sp, id)}) reached ${ageYears.toFixed(1)} years — the oldest of its kind recorded here.`,
          this.clock.day,
          this.clock.year,
          2,
        );
        if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
      }
    }
    const weight = cause === 'old age' ? 0 : c.stage[slot] === Stage.Adult && sp.massKg > 20 ? 1 : 0;
    if (weight > 0) {
      this.throttled(`death-${sp.key}`, 2, () => {
        this.pushEvent({
          kind: 'death',
          title: `${sp.name} ${tagFor(sp, id)} died`,
          detail: `Cause: ${cause}. Lived ${ageYears.toFixed(1)} years, ${c.offspringCount[slot]} offspring.`,
          weight,
          speciesId: sp.key,
          organismId: id,
          x: c.x[slot],
          y: c.y[slot],
          subject: `${sp.name} ${tagFor(sp, id)}`,
        });
      });
    }
    this.bus.emit('organism:died', { id, speciesId: sp.key, cause, x: c.x[slot], y: c.y[slot] });
    if (c.groupId[slot] >= 0) {
      const g = this.social.groupFor(c, slot);
      if (g) {
        const idx = g.members.indexOf(slot);
        if (idx >= 0) g.members.splice(idx, 1);
      }
    }
    // Dependent young left behind will starve without care.
    for (let i = 0; i < c.capacity; i++) {
      if (c.alive[i] && c.dependentOf[i] === id) {
        c.dependence[i] = Math.min(c.dependence[i], 0.4);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public hooks used by the creature simulation                        */
  /* ------------------------------------------------------------------ */

  onCreatureDeath: ((slot: number, cause: string, killer?: number) => void) | null = null;
  onPredation: ((predator: number, prey: number, day: number) => void) | null = null;
  onHuntOutcome: ((predator: number, prey: number, success: boolean) => void) | null = null;
  onMating: ((female: number, male: number) => void) | null = null;
  onBirth: ((mother: number, father: number, born: number[]) => void) | null = null;
  onCreatureCall: ((slot: number, kind: string) => void) | null = null;

  /** Does `observer` currently notice `target`? (used for stalk/ambush logic) */
  creatureDetects(observer: number, target: number): boolean {
    const c = this.creatures;
    const sp = c.species(observer);
    const d = Math.hypot(c.x[observer] - c.x[target], c.y[observer] - c.y[target]);
    const range = Math.max(sp.visionRange * 0.5, 20);
    if (d > range) return false;
    const cover = this.vegetation.coverAt(c.x[target], c.y[target]);
    const p = clamp01(1 - d / range) * clamp01(1 - cover * 0.4);
    return c.rng.chance(p * 0.25);
  }

  /** Track marks left by heavy or conspicuous animals. */
  recordTracks(slot: number, moved: number): void {
    const c = this.creatures;
    const last = this.trackCooldown.get(slot) ?? 0;
    if (this.clock.minutes - last < 6) return;
    const sp = c.species(slot);
    const inSnow = this.terrain.snow.at(clamp(Math.round(this.terrain.worldToCellX(c.x[slot])), 0, this.terrain.last), clamp(Math.round(this.terrain.worldToCellY(c.y[slot])), 0, this.terrain.last));
    const muddy = this.terrain.mud.at(clamp(Math.round(this.terrain.worldToCellX(c.x[slot])), 0, this.terrain.last), clamp(Math.round(this.terrain.worldToCellY(c.y[slot])), 0, this.terrain.last));
    // Tracks show best in snow and mud, and belong to bigger animals.
    const strength = clamp01(sp.massKg / 120) * clamp01(inSnow * 3 + muddy * 2 + 0.12);
    if (strength < 0.03) return;
    this.trackCooldown.set(slot, this.clock.minutes);
    this.tracks.push({ x: c.x[slot], y: c.y[slot], speciesIdx: c.speciesIdx[slot], strength: clamp01(strength * (0.4 + moved * 2)), day: this.clock.day });
    if (this.tracks.length > this.maxTracks) this.tracks.splice(0, this.tracks.length - this.maxTracks);
  }

  /** Habitat quality 0..1 of a position for a species — drives movement choices. */
  habitatQuality(speciesIdx: number, x: number, y: number): number {
    const t = this.terrain;
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const i = cy * t.size + cx;
    const sp = SPECIES[speciesIdx];
    const biome = t.biome.data[i] as Biome;
    let q = sp.habitat[biome] ?? 0.02;
    // Standing water is bad for terrestrial animals, good for fish.
    const depth = t.waterDepth.data[i];
    if (sp.locomotion === 'fish') {
      if (depth < 0.2) q = 0;
      else q *= clamp01(0.4 + depth);
    } else if (depth > 0.5) {
      q *= sp.swims ? 0.6 : 0.15;
    }
    const elev = t.elevationOf(t.height.data[i]);
    if (elev < sp.elevationRange[0] - 4 || elev > sp.elevationRange[1] + 6) q *= 0.25;
    const temp = t.tempMean.data[i];
    if (temp < sp.tempComfort[0] - 8 || temp > sp.tempComfort[1] + 10) q *= 0.4;
    return clamp01(q);
  }

  /** Nearest water within `range`, searching in expanding rings. */
  findWaterNear(x: number, y: number, range: number): { x: number; y: number } | null {
    const t = this.terrain;
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const step = Math.max(2, Math.floor(range / t.cellUnits / 10));
    for (let ring = 1; ring <= 12; ring++) {
      const r = ring * step;
      if (r * t.cellUnits > range) break;
      const samples = Math.max(6, Math.min(28, Math.round(r * 1.6)));
      for (let a = 0; a < samples; a++) {
        const ang = (a / samples) * TAU + ring * 0.37;
        const sx = clamp(Math.round(cx + Math.cos(ang) * r), 0, t.last);
        const sy = clamp(Math.round(cy + Math.sin(ang) * r), 0, t.last);
        const depth = t.waterDepth.data[sy * t.size + sx];
        const isSea = t.height.data[sy * t.size + sx] < t.params.seaLevel - 0.0005;
        if (depth > 0.05 && depth < 1.6 && !isSea) {
          return { x: t.cellToWorldX(sx), y: t.cellToWorldY(sy) };
        }
      }
    }
    return null;
  }

  /** Shade: mature tree canopy, or a cave mouth. */
  findShadeNear(x: number, y: number, range: number): { x: number; y: number } | null {
    const t = this.terrain;
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const r = Math.round(range / t.cellUnits);
    let best: { x: number; y: number; v: number } | null = null;
    for (let ring = 1; ring <= 6; ring++) {
      const rr = (ring * r) / 6;
      const samples = 10;
      for (let a = 0; a < samples; a++) {
        const ang = (a / samples) * TAU + ring * 0.5;
        const sx = clamp(Math.round(cx + Math.cos(ang) * rr), 0, t.last);
        const sy = clamp(Math.round(cy + Math.sin(ang) * rr), 0, t.last);
        const canopy = t.canopy.data[sy * t.size + sx];
        if (canopy > 0.25 && (!best || canopy > best.v)) best = { x: t.cellToWorldX(sx), y: t.cellToWorldY(sy), v: canopy };
      }
    }
    if (best) return { x: best.x, y: best.y };
    // Caves and rock overhangs are reliable shade.
    for (const cave of this.terrain.caves) {
      if (Math.hypot(cave.x - x, cave.y - y) < range) return { x: cave.x, y: cave.y };
    }
    return null;
  }

  /** Sun: open, unshaded ground, preferably south-facing and calm. */
  findSunNear(x: number, y: number, range: number): { x: number; y: number } | null {
    const t = this.terrain;
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const r = Math.round(range / t.cellUnits);
    let best: { x: number; y: number; v: number } | null = null;
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * TAU;
      for (let k = 1; k <= 3; k++) {
        const rr = (r * k) / 3;
        const sx = clamp(Math.round(cx + Math.cos(ang) * rr), 0, t.last);
        const sy = clamp(Math.round(cy + Math.sin(ang) * rr), 0, t.last);
        const idx = sy * t.size + sx;
        if (!t.land[idx] || t.waterDepth.data[idx] > 0.25) continue;
        const v = (1 - t.canopy.data[idx]) * 1.5 + (t.slope.data[idx] > 0.2 ? 0.3 : 0);
        if (!best || v > best.v) best = { x: t.cellToWorldX(sx), y: t.cellToWorldY(sy), v };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /** A den/nest site suited to the species (cave, burrow ground, tall tree). */
  findDenSite(slot: number): { x: number; y: number; prop?: number } | null {
    const c = this.creatures;
    const sp = c.species(slot);
    const x = c.x[slot];
    const y = c.y[slot];
    if (sp.shelter === 'cave' || sp.shelter === 'roost' || sp.shelter === 'den') {
      // Caves and rock shelters first.
      let best: { x: number; y: number; d: number } | null = null;
      for (const cave of this.terrain.caves) {
        const d = Math.hypot(cave.x - x, cave.y - y);
        if (d < 260 && (!best || d < best.d)) best = { x: cave.x, y: cave.y, d };
      }
      if (best) return { x: best.x, y: best.y };
    }
    if (sp.shelter === 'nest' || sp.shelter === 'roost') {
      const tree = this.forest.store.nearest(x, y, 120, this.scratchIds);
      if (tree >= 0) return { x: this.forest.store.x[tree], y: this.forest.store.y[tree], prop: tree };
    }
    if (sp.shelter === 'burrow') {
      // Burrows need soft, well-drained, unflooded ground with cover.
      const t = this.terrain;
      for (let tries = 0; tries < 40; tries++) {
        const ang = this.rng.range(0, TAU);
        const dist = this.rng.range(8, 70);
        const px = x + Math.cos(ang) * dist;
        const py = y + Math.sin(ang) * dist;
        const cx = clamp(Math.round(t.worldToCellX(px)), 0, t.last);
        const cy = clamp(Math.round(t.worldToCellY(py)), 0, t.last);
        const i = cy * t.size + cx;
        if (!t.land[i] || t.waterDepth.data[i] > 0.2) continue;
        if (t.slope.data[i] > 0.55) continue;
        if (t.fertility.data[i] < 0.25) continue;
        return { x: px, y: py };
      }
    }
    if (sp.shelter === 'shoal') {
      const water = this.findWaterNear(x, y, 90);
      if (water) return { x: water.x, y: water.y };
    }
    // A generic fallback: any sheltered spot near cover.
    return this.findShadeNear(x, y, 70);
  }

  /** A perch for raptors: a tall tree or a cliff edge. */
  findPerch(x: number, y: number, range: number): { x: number; y: number } | null {
    const tree = this.forest.store.nearest(x, y, range, this.scratchIds);
    if (tree >= 0 && this.forest.store.height[tree] > 6) {
      return { x: this.forest.store.x[tree], y: this.forest.store.y[tree] };
    }
    // Otherwise any steep ground works as a lookout.
    const t = this.terrain;
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const r = Math.round(range / t.cellUnits);
    let best: { x: number; y: number; v: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * TAU;
      const sx = clamp(Math.round(cx + Math.cos(ang) * r), 0, t.last);
      const sy = clamp(Math.round(cy + Math.sin(ang) * r), 0, t.last);
      const idx = sy * t.size + sx;
      const v = t.slope.data[idx] * 1.5 + t.elevationOf(t.height.data[idx]) * 0.02;
      if (!best || v > best.v) best = { x: t.cellToWorldX(sx), y: t.cellToWorldY(sy), v };
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /** Seasonal destination for a migrating species. */
  migrationTarget(speciesIdx: number, x: number, y: number): { x: number; y: number } {
    const sp = SPECIES[speciesIdx];
    const season = this.clock.seasonIndex;
    const elev = this.terrain.elevationAtWorld(x, y);
    // Winter: head for low ground (or south, which is the warm edge of the map).
    if (season === 3) {
      const targetElev = Math.max(0, elev - 12);
      return this.findSiteWithElevation(speciesIdx, targetElev, y > 0 ? 1 : -1, x, y) ?? { x, y: y + 160 };
    }
    if (season === 0) {
      return this.findSiteWithElevation(speciesIdx, elev + 9, y < 0 ? 1 : -1, x, y) ?? { x, y: y - 160 };
    }
    if (sp.locomotion === 'fish' && season === 0) {
      // Trout run upstream (toward the highest water they can reach).
      const t = this.terrain;
      let bestX = x;
      let bestY = y;
      let bestElev = -Infinity;
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * TAU;
        const px = x + Math.cos(ang) * 120;
        const py = y + Math.sin(ang) * 120;
        const e = t.elevationAtWorld(px, py);
        if (e > bestElev && t.waterAtWorld(px, py) > 0.2) {
          bestElev = e;
          bestX = px;
          bestY = py;
        }
      }
      return { x: bestX, y: bestY };
    }
    return { x, y };
  }

  private findSiteWithElevation(speciesIdx: number, targetElev: number, preferY: number, x: number, y: number): { x: number; y: number } | null {
    const t = this.terrain;
    let best: { x: number; y: number; score: number } | null = null;
    for (let i = 0; i < 40; i++) {
      const ang = this.rng.range(0, TAU);
      const dist = this.rng.range(80, 420);
      const px = clamp(x + Math.cos(ang) * dist, -t.half + 10, t.half - 10);
      const py = clamp(y + Math.sin(ang) * dist, -t.half + 10, t.half - 10);
      const cx = clamp(Math.round(t.worldToCellX(px)), 0, t.last);
      const cy = clamp(Math.round(t.worldToCellY(py)), 0, t.last);
      if (!t.land[cy * t.size + cx]) continue;
      const q = this.habitatQuality(speciesIdx, px, py);
      if (q < 0.15) continue;
      const e = t.elevationOf(t.height.data[cy * t.size + cx]);
      const score = q * 2 - Math.abs(e - targetElev) * 0.12 + (Math.sign(py - y) === preferY ? 0.4 : 0);
      if (!best || score > best.score) best = { x: px, y: py, score };
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /** How many catchable trout are near a point (bear fishing). */
  troutAbundanceAt(x: number, y: number): number {
    const c = this.creatures;
    const sit = SPECIES.findIndex((s) => s.key === 'trout');
    if (sit < 0) return 0;
    const n = c.grid.queryRadius(x, y, 25, this.scratchIds);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const o = this.scratchIds[i];
      if (c.alive[o] && c.speciesIdx[o] === sit) count++;
    }
    return clamp01(count / 5) * 0.5 + this.aggregates.availableAt('plankton', x, y) * 0.4;
  }

  /** A bear catches a trout at the water's edge. Returns the mass eaten. */
  catchTroutAt(x: number, y: number, bearSlot: number): number {
    const c = this.creatures;
    const sit = SPECIES.findIndex((s) => s.key === 'trout');
    if (sit < 0) return 0;
    const n = c.grid.queryRadius(x, y, 18, this.scratchIds);
    for (let i = 0; i < n; i++) {
      const o = this.scratchIds[i];
      if (!c.alive[o] || c.speciesIdx[o] !== sit) continue;
      const sp = c.species(bearSlot);
      const chance = clamp01(0.06 + w_ind(c, bearSlot) * 0.1);
      if (c.rng.chance(chance)) {
        const mass = SPECIES[sit].massKg * c.bodyScale(o) * 0.8;
        c.alive[o] = 0;
        c.deathCause[o] = 'predation';
        c.action[o] = Action.Die;
        this.handleDeath(o, sit, 'predation');
        const g = this.social.groupFor(c, bearSlot);
        if (g) {
          g.killX = c.x[bearSlot];
          g.killY = c.y[bearSlot];
          g.killFreshness = 1;
        }
        void sp;
        return mass;
      }
    }
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* Events & history                                                    */
  /* ------------------------------------------------------------------ */

  pushEvent(e: Omit<WorldEvent, 'id' | 'day' | 'year' | 'minuteOfDay'>): WorldEvent {
    const ev = this.history.add(e, this);
    this.bus.emit('event:notable', ev);
    return ev;
  }

  private throttled(key: string, hours: number, fn: () => void): void {
    const last = this.notifyCooldown.get(key) ?? -Infinity;
    const now = this.clock.minutes;
    if (now - last < hours * 60) return;
    this.notifyCooldown.set(key, now);
    fn();
  }

  private onFireStarted(cx: number, cy: number, cause: string): void {
    const x = this.terrain.cellToWorldX(cx);
    const y = this.terrain.cellToWorldY(cy);
    const region = this.terrain.regionNameAt(x, y);
    this.pushEvent({
      kind: 'disaster',
      title: cause === 'lightning' ? 'Lightning strikes a fire' : 'A wildfire has started',
      detail: `Flames are spreading through the ${region}. Wind is ${this.climate.windSpeed.toFixed(1)} m/s.`,
      weight: 2,
      x,
      y,
    });
    const d = this.history.discover('first-fire', 'First wildfire', `You watched the first fire take hold in the ${region}.`, this.clock.day, this.clock.year, 2);
    if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
  }

  /** Remember burned ground so we can notice when it recovers. */
  private regrowthTargets: { x: number; y: number; day: number; coverAtBurn: number }[] = [];

  markRecovery(x: number, y: number): void {
    const cover = this.vegetation.coverAt(x, y);
    this.regrowthTargets.push({ x, y, day: this.clock.day, coverAtBurn: cover });
    if (this.regrowthTargets.length > 40) this.regrowthTargets.shift();
  }

  private checkRecovery(): void {
    for (let i = this.regrowthTargets.length - 1; i >= 0; i--) {
      const target = this.regrowthTargets[i];
      const daysSince = this.clock.day - target.day;
      if (daysSince < 20) continue;
      const cover = this.vegetation.coverAt(target.x, target.y);
      if (cover > 0.45) {
        this.regrowthTargets.splice(i, 1);
        this.pushEvent({
          kind: 'recovery',
          title: 'Burnt ground is green again',
          detail: `${daysSince} days after the fire, vegetation has reclaimed the ${this.terrain.regionNameAt(target.x, target.y)}.`,
          weight: 1,
          x: target.x,
          y: target.y,
        });
        const d = this.history.discover('first-recovery', 'Ecosystem recovery', `You watched vegetation return to scorched ground in ${daysSince} days.`, this.clock.day, this.clock.year, 2);
        if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
      } else if (daysSince > 400) {
        this.regrowthTargets.splice(i, 1);
      }
    }
  }

  /**
   * Look at measured state and decide whether anything worth reporting has
   * happened. Nothing here is scripted: every headline comes from a number.
   */
  private detectNotableEvents(): void {
    this.checkRecovery();
    const day = this.clock.day;
    for (let s = 0; s < SPECIES.length; s++) {
      const sp = SPECIES[s];
      const stat = this.census.get(sp.key);
      if (!stat) continue;
      // Population swings: compare with the sampled history.
      const sample = this.history.snapshotAt(7);
      if (sample) {
        const before = sample.counts[s];
        const after = stat.count;
        if (before > 8) {
          const change = (after - before) / before;
          if (change < -0.4) {
            this.history.announce(
              `crash-${sp.key}`,
              45,
              day,
              () =>
                this.bus ? { kind: 'population', title: `${sp.name} population collapse`, detail: `Down ${Math.abs(change * 100).toFixed(0)}% in a week (${before} → ${after}).`, weight: 3, speciesId: sp.key } : null,
              this,
            );
          } else if (change > 0.6) {
            this.history.announce(
              `boom-${sp.key}`,
              45,
              day,
              () => ({ kind: 'population', title: `${sp.name} population boom`, detail: `Up ${(change * 100).toFixed(0)}% in a week (${before} → ${after}).`, weight: 2, speciesId: sp.key }),
              this,
            );
          }
        }
      }
      // New generation records and rare individuals.
      const genRecord = this.history.records.generation[s];
      if (stat.maxGeneration > genRecord) {
        this.history.records.generation[s] = stat.maxGeneration;
        if (stat.maxGeneration >= 5 && stat.maxGeneration % 5 === 0) {
          this.pushEvent({
            kind: 'evolution',
            title: `Generation ${stat.maxGeneration} ${sp.name.toLowerCase()}`,
            detail: `A ${sp.name.toLowerCase()} born in this world is now ${stat.maxGeneration} generations from the founders.`,
            weight: 1,
            speciesId: sp.key,
          });
          if (stat.maxGeneration >= 10) {
            const d = this.history.discover('gen10', 'Generation 10 reached', `Ten generations of ${sp.name.toLowerCase()}s have been born in this world.`, day, this.clock.year, 3);
            if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
          }
        }
      }
    }
    // Rare individuals: extreme traits worth a mention.
    this.detectRareIndividuals();
    // Migration size records, disease pressure, drought records.
    if (this.climate.hasEvent('drought')) {
      const drought = this.climate.events.find((e) => e.kind === 'drought') as ClimateEvent;
      const elapsed = (drought.total - drought.remaining) / TIME.minutesPerDay;
      if (elapsed > this.history.records.droughtDays) this.history.records.droughtDays = elapsed;
      if (elapsed > 20) {
        const d = this.history.discover('long-drought', 'Long drought endured', `Rain stayed away for ${Math.round(elapsed)} days.`, day, this.clock.year, 2);
        if (d) this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
      }
    }
    if (this.disease.activeOutbreaks >= 3) {
      this.history.announce(
        'multi-outbreak',
        30,
        day,
        () => ({ kind: 'disease', title: 'Multiple outbreaks at once', detail: `${this.disease.activeOutbreaks} pathogens are circulating simultaneously.`, weight: 2 }),
        this,
      );
    }
  }

  private rareTraitCooldown = 0;

  private detectRareIndividuals(): void {
    if (this.clock.minutes < this.rareTraitCooldown) return;
    this.rareTraitCooldown = this.clock.minutes + 60 * 12;
    const c = this.creatures;
    for (let s = 0; s < SPECIES.length; s++) {
      const mean = c.speciesGenomeMean(s);
      if (!mean || c.census.count[s] < 6) continue;
      for (let i = 0; i < c.capacity; i++) {
        if (!c.alive[i] || c.speciesIdx[i] !== s) continue;
        const g = c.genome[i];
        if (!g) continue;
        const anomaly = Genome.anomaly(mean, g);
        if (!anomaly) continue;
        const sp = SPECIES[s];
        const id = c.id[i];
        const key = `rare-${sp.key}-${anomaly.trait}`;
        if (this.history.hasDiscovery(key)) continue;
        const d = this.history.discover(
          key,
          `${anomaly.dir > 0 ? 'Exceptional' : 'Diminished'} ${anomaly.trait.toLowerCase()}`,
          `${sp.name} ${tagFor(sp, id)} carries an unusual ${anomaly.trait.toLowerCase()} (${(
            (anomaly.z > 0 ? '+' : '') + anomaly.z.toFixed(1)
          )} σ from the population mean). If it survives and breeds, this lineage may spread.`,
          this.clock.day,
          this.clock.year,
          2,
        );
        if (d) {
          this.bus.emit('discovery:new', { key: d.key, title: d.title, detail: d.detail });
          this.pushEvent({
            kind: 'evolution',
            title: `Unusual ${anomaly.trait.toLowerCase()} observed`,
            detail: `${sp.name} ${tagFor(sp, id)} — ${anomaly.z > 0 ? 'well above' : 'well below'} the population average.`,
            weight: 2,
            speciesId: sp.key,
            organismId: id,
            x: c.x[i],
            y: c.y[i],
          });
        }
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sandbox / player tools                                              */
  /* ------------------------------------------------------------------ */

  /** Spawn an individual of a species at a position (returns its id). */
  spawnSpecies(speciesKey: string, x: number, y: number, opts: { count?: number; genome?: Genome; ageYears?: number; energy?: number } = {}): number[] {
    const s = SPECIES.findIndex((sp) => sp.key === speciesKey);
    if (s < 0) return [];
    const count = opts.count ?? 1;
    const ids: number[] = [];
    for (let k = 0; k < count; k++) {
      const ang = this.rng.range(0, TAU);
      const dist = k === 0 ? 0 : this.rng.range(1.5, 6 + count * 0.4);
      const px = clamp(x + Math.cos(ang) * dist, -this.terrain.half + 4, this.terrain.half - 4);
      const py = clamp(y + Math.sin(ang) * dist, -this.terrain.half + 4, this.terrain.half - 4);
      const genome = opts.genome ? Genome.mutate(opts.genome, this.rng, 0.4) : this.founderGenome(SPECIES[s], this.rng);
      const slot = this.creatures.spawn({
        speciesIdx: s,
        x: px,
        y: py,
        genome,
        ageDays: (opts.ageYears ?? this.rng.range(0.3, 0.7) * SPECIES[s].maturityYears * 1.6) * TIME.daysPerYear,
        energy: opts.energy ?? 0.8,
      });
      if (slot >= 0) {
        this.creatures.census.count[s]++;
        ids.push(this.creatures.id[slot]);
      }
    }
    return ids;
  }

  /** Clone an existing individual (exact genetics, mutated slightly). */
  cloneOrganism(id: number): number | null {
    const slot = this.creatures.findByLivingId(id);
    if (slot < 0) return null;
    const g = this.creatures.genome[slot];
    if (!g) return null;
    const ids = this.spawnSpecies(SPECIES[this.creatures.speciesIdx[slot]].key, this.creatures.x[slot] + 3, this.creatures.y[slot] + 3, {
      genome: g,
      ageYears: this.creatures.ageDays[slot] / TIME.daysPerYear,
    });
    return ids[0] ?? null;
  }

  /** Teleport an individual. */
  relocateOrganism(id: number, x: number, y: number): boolean {
    const slot = this.creatures.findByLivingId(id);
    if (slot < 0) return false;
    this.creatures.x[slot] = clamp(x, -this.terrain.half + 4, this.terrain.half - 4);
    this.creatures.y[slot] = clamp(y, -this.terrain.half + 4, this.terrain.half - 4);
    this.creatures.clearTarget(slot);
    return true;
  }

  /** Remove an individual (returns false if it is already gone). */
  removeOrganism(id: number, cause = 'removed by player'): boolean {
    const slot = this.creatures.findByLivingId(id);
    if (slot < 0) return false;
    this.creatures.kill(slot, cause);
    return true;
  }

  /** Kill everything within a radius (used by meteor / cull tools). */
  cullAt(x: number, y: number, radius: number, cause = 'removed by player'): number {
    const c = this.creatures;
    let count = 0;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      if (Math.hypot(c.x[i] - x, c.y[i] - y) <= radius) {
        c.kill(i, cause);
        count++;
      }
    }
    return count;
  }

  /** Plant vegetation (restoration tools). */
  sowAt(x: number, y: number, radius: number, layer: number, amount: number): number {
    const t = this.terrain;
    const cx = Math.round(t.worldToCellX(x));
    const cy = Math.round(t.worldToCellY(y));
    const r = Math.max(1, Math.round(radius / t.cellUnits));
    let planted = 0;
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= t.size || yy >= t.size) continue;
        if (Math.hypot(xx - cx, yy - cy) > r) continue;
        if (this.vegetation.sow(xx, yy, layer, amount)) planted++;
      }
    }
    return planted;
  }

  /** Plant trees in an area. */
  plantTreesAt(x: number, y: number, radius: number, species = 0, count = 8): number {
    const t = this.terrain;
    let planted = 0;
    for (let k = 0; k < count * 6 && planted < count; k++) {
      const ang = this.rng.range(0, TAU);
      const dist = Math.sqrt(this.rng.next()) * radius;
      const px = x + Math.cos(ang) * dist;
      const py = y + Math.sin(ang) * dist;
      const cx = Math.round(t.worldToCellX(px));
      const cy = Math.round(t.worldToCellY(py));
      if (cx < 2 || cy < 2 || cx >= t.size - 2 || cy >= t.size - 2) continue;
      if (this.forest.suitability(cx, cy, species) < 0.12) continue;
      const genome = this.founderGenome(SPECIES[0], this.rng);
      const slot = this.forest.store.plant(t, px, py, species, genome, 1.2, 0);
      if (slot >= 0) {
        planted++;
      }
    }
    this.forest.refreshCanopy();
    return planted;
  }

  /** Sculpt terrain (raise/lower/flatten) and re-derive hydrology. */
  sculptTerrain(x: number, y: number, radius: number, delta: number, flatten = false): void {
    const t = this.terrain;
    const cx = Math.round(t.worldToCellX(x));
    const cy = Math.round(t.worldToCellY(y));
    const r = Math.max(1, Math.round(radius / t.cellUnits));
    let sum = 0;
    let n = 0;
    if (flatten) {
      for (let yy = cy - r; yy <= cy + r; yy++) {
        for (let xx = cx - r; xx <= cx + r; xx++) {
          if (xx < 0 || yy < 0 || xx >= t.size || yy >= t.size) continue;
          if (Math.hypot(xx - cx, yy - cy) > r) continue;
          sum += t.height.data[yy * t.size + xx];
          n++;
        }
      }
      sum /= Math.max(1, n);
    }
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= t.size || yy >= t.size) continue;
        const d = Math.hypot(xx - cx, yy - cy) / r;
        if (d > 1) continue;
        const falloff = 0.5 + 0.5 * Math.cos(d * Math.PI);
        const i = yy * t.size + xx;
        if (flatten) {
          t.height.data[i] = lerp(t.height.data[i], sum, falloff * 0.8);
        } else {
          t.height.data[i] = clamp(t.height.data[i] + delta * falloff, 0.02, 1.3);
        }
      }
    }
    t.computeSlope();
    t.rebuildHydrology();
  }

  /** Trigger a weather or climate event from the sandbox. */
  setWeather(state: string, intensity = 1): void {
    this.climate.state = state as never;
    this.climate.intensity = clamp01(intensity);
    this.climate.stateRemaining = this.rng.range(180, 600);
    this.pushEvent({
      kind: 'human',
      title: `Weather shifted to ${state}`,
      detail: 'You interfered directly with the atmosphere.',
      weight: 1,
    });
  }

  startClimateEvent(kind: 'drought' | 'heatwave' | 'coldwave' | 'monsoon' | 'volcanicWinter', days = 8, intensity = 0.8): void {
    this.climate.startEvent(kind, days, intensity);
    if (kind === 'volcanicWinter') this.climate.globalDimming = clamp01(this.climate.globalDimming + 0.35);
    if (kind === 'heatwave') this.fire.spontaneous(60);
  }

  /** Meteor strike: a crater, a shockwave that kills, and a lot of dust. */
  meteorStrike(x: number, y: number, radius = 40): void {
    const t = this.terrain;
    const cx = Math.round(t.worldToCellX(x));
    const cy = Math.round(t.worldToCellY(y));
    const r = Math.max(2, Math.round(radius / t.cellUnits));
    for (let yy = cy - r * 2; yy <= cy + r * 2; yy++) {
      for (let xx = cx - r * 2; xx <= cx + r * 2; xx++) {
        if (xx < 0 || yy < 0 || xx >= t.size || yy >= t.size) continue;
        const d = Math.hypot(xx - cx, yy - cy);
        if (d > r * 2) continue;
        const i = yy * t.size + xx;
        const k = d / r;
        if (k < 1) {
          t.height.data[i] = Math.max(0.02, t.height.data[i] - 0.06 * (1 - k) * (1 - k));
          this.vegetation.plants.layers.forEach((l) => (l.data[i] = 0));
          t.fertility.data[i] = clamp01(t.fertility.data[i] + 0.1);
        } else if (k < 2) {
          t.height.data[i] = clamp01(t.height.data[i] + 0.02 * (1 - (k - 1)) * 0.5);
          this.fire.ignite(xx, yy, 0.9);
        }
      }
    }
    const killed = this.cullAt(x, y, radius * 1.6, 'meteor impact');
    const trees = this.forest.store;
    for (let i = 0; i < trees.count; i++) {
      if (!trees.alive[i]) continue;
      if (Math.hypot(trees.x[i] - x, trees.y[i] - y) < radius * 1.5) trees.kill(i, 'fire');
    }
    t.computeSlope();
    t.rebuildHydrology();
    this.climate.globalDimming = clamp01(this.climate.globalDimming + 0.5);
    this.climate.cloud.data.fill(0.9);
    this.coverInDust(x, y);
    this.pushEvent({
      kind: 'disaster',
      title: 'Meteor impact',
      detail: `A strike in the ${t.regionNameAt(x, y)} killed ${killed} animals, flattened trees and threw dust into the sky.`,
      weight: 3,
      x,
      y,
    });
    this.history.discover('meteor', 'Meteor impact', 'You opened the sky and something came through it.', this.clock.day, this.clock.year, 3);
  }

  private coverInDust(x: number, y: number): void {
    // Dust dims the sun and drops temperatures for a while.
    this.climate.startEvent('volcanicWinter', 30, 0.8, true);
    const t = this.terrain;
    const cx = Math.round(t.worldToCellX(x));
    const cy = Math.round(t.worldToCellY(y));
    const r = 12;
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= t.size || yy >= t.size) continue;
        const i = yy * t.size + xx;
        t.soilBiota.data[i] *= 0.5;
      }
    }
  }

  /** Earthquake: shakes down cliffs, cracks the ground, opens springs. */
  earthquake(x: number, y: number, magnitude = 0.6): void {
    const t = this.terrain;
    const strength = clamp01(magnitude) * 0.05;
    for (let i = 0; i < t.height.data.length; i++) {
      const cx = i % t.size;
      const cy = (i / t.size) | 0;
      const d = Math.hypot(cx - t.worldToCellX(x), cy - t.worldToCellY(y));
      if (d > 60 / t.cellUnits) continue;
      const f = (1 - d / (60 / t.cellUnits)) * strength;
      t.height.data[i] = clamp(t.height.data[i] + (t.slope.data[i] * 2 - 0.4) * f, 0.02, 1.3);
    }
    t.computeSlope();
    t.rebuildHydrology();
    // Springs open: water pushes up through the cracks.
    this.hydrology.addWaterAt(x, y, 24, 0.5);
    const killed = this.cullAt(x, y, 22, 'earthquake');
    this.pushEvent({
      kind: 'disaster',
      title: 'Earthquake',
      detail: `The ground shook near the ${t.regionNameAt(x, y)}; ${killed} animals were lost and the terrain has shifted.`,
      weight: 3,
      x,
      y,
    });
  }

  /** Volcanic eruption: lava, ash, new rock, a lot of dead trees. */
  eruptVolcano(index = 0): void {
    const vol = this.terrain.volcanoes[index] ?? this.terrain.volcanoes[0];
    if (!vol) return;
    const t = this.terrain;
    const r = Math.max(4, Math.round(vol.radius / t.cellUnits));
    for (let yy = vol.cy - r; yy <= vol.cy + r; yy++) {
      for (let xx = vol.cx - r; xx <= vol.cx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= t.size || yy >= t.size) continue;
        const d = Math.hypot(xx - vol.cx, yy - vol.cy) / r;
        if (d > 1) continue;
        const i = yy * t.size + xx;
        t.fertility.data[i] = clamp01(t.fertility.data[i] + 0.35 * (1 - d));
        t.height.data[i] = clamp01(t.height.data[i] + 0.03 * (1 - d));
        if (d < 0.5) {
          this.vegetation.plants.layers.forEach((l) => (l.data[i] = 0));
          this.fire.ignite(xx, yy, 1.2);
        }
      }
    }
    this.cullAt(vol.x, vol.y, vol.radius, 'volcanic eruption');
    this.climate.startEvent('volcanicWinter', 20, 0.6, true);
    this.climate.globalDimming = clamp01(this.climate.globalDimming + 0.3);
    t.computeSlope();
    this.pushEvent({
      kind: 'disaster',
      title: `${vol.name} erupts`,
      detail: 'Lava, ash and fire. The first plants to return will be pioneers on fresh ash.',
      weight: 3,
      x: vol.x,
      y: vol.y,
    });
    this.history.discover('eruption', 'Volcanic eruption', `You watched ${vol.name} erupt and reshape the land.`, this.clock.day, this.clock.year, 3);
  }

  /** Flood a region: water rises, then drains away downhill. */
  floodAt(x: number, y: number, radius: number, depth = 0.9): void {
    this.hydrology.addWaterAt(x, y, radius, depth);
    const killed = this.cullAt(x, y, radius * 0.25, 'flood');
    this.pushEvent({
      kind: 'disaster',
      title: 'Flood',
      detail: `A surge of water covered the ${this.terrain.regionNameAt(x, y)}; ${killed} animals were caught.`,
      weight: 2,
      x,
      y,
    });
  }

  /** Introduce a species deliberately (invasive species experiments). */
  introduceSpecies(speciesKey: string, x: number, y: number, count = 6): number[] {
    const ids = this.spawnSpecies(speciesKey, x, y, { count });
    const sp = SPECIES.find((s) => s.key === speciesKey);
    if (sp) {
      this.pushEvent({
        kind: 'human',
        title: `${count} ${sp.name.toLowerCase()}s introduced`,
        detail: `Released in the ${this.terrain.regionNameAt(x, y)}. Whether they establish, spread or die out is up to the ecosystem.`,
        weight: 2,
        speciesId: speciesKey,
        x,
        y,
      });
      this.history.markIntroduced(speciesKey, this.clock.day);
    }
    return ids;
  }

  reportError(where: string, err: unknown): void {
    const message = err instanceof Error ? `${err.message}` : String(err);
    this.errors.push(`${where}: ${message}`);
    if (this.errors.length > 40) this.errors.shift();
    this.bus.emit('sim:error', { message, where });
  }

  /* ------------------------------------------------------------------ */
  /* Save / load & offline catch-up                                      */
  /* ------------------------------------------------------------------ */

  save(): Record<string, unknown> {
    return {
      seed: this.seed,
      name: this.name,
      params: this.params,
      minutes: this.clock.save(),
      speedIndex: this.clock.speedIndex,
      climate: this.climate.save(),
      hydrology: this.hydrology.save(),
      soil: this.soil.save(),
      vegetation: this.vegetation.save(),
      forest: this.forest.save(),
      fire: this.fire.save(),
      aggregates: this.aggregates.save(),
      disease: this.disease.save(),
      creatures: this.creatures.save(),
      carcasses: this.carcasses.save(),
      social: this.social.save(),
      history: this.history.save(),
      rng: this.rng.saveState(),
      savedAt: Date.now(),
    };
  }

  load(d: Record<string, any>): void {
    this.clock.load(d.minutes ?? 0);
    this.clock.speedIndex = d.speedIndex ?? 1;
    this.climate.load(d.climate ?? {});
    this.hydrology.load(d.hydrology ?? {});
    this.soil.load(d.soil ?? {});
    this.vegetation.load(d.vegetation ?? {});
    this.forest.load(d.forest ?? {});
    this.fire.load(d.fire ?? {});
    this.aggregates.load(d.aggregates ?? {});
    this.disease.load(d.disease ?? {});
    this.creatures.load(d.creatures ?? {});
    this.carcasses.load(d.carcasses ?? {});
    this.social.load(d.social ?? this.social.save());
    this.history.load(d.history ?? {});
    if (d.rng) this.rng.loadState(d.rng);
    this.forest.refreshCanopy();
    this.census.update(this, true);
    this.lastDay = this.clock.day;
  }

  /* ------------------------------------------------------------------ */
  /* Thin query helpers used by the behaviour code                       */
  /* ------------------------------------------------------------------ */

  /**
   * Nearest drinkable water, as a point. Answered from the hydrology reach map
   * so a thousand thirsty animals cost nothing.
   */
  findWater(x: number, y: number, range = 220): { x: number; y: number; distance: number } | null {
    const p = this.hydrology.waterReach(x, y);
    if (p && p.distance <= range) return p;
    return null;
  }

  /**
   * Nearest water deep enough for a fish to swim in. Trout cannot survive in a
   * drying puddle, so they search for the pools and channels that are left.
   */
  findDeepWater(x: number, y: number, minDepth = 0.35, maxRadius = 90): { x: number; y: number; depth: number } | null {
    const t = this.terrain;
    let best: { x: number; y: number; depth: number } | null = null;
    let bestScore = minDepth;
    for (let r = 6; r <= maxRadius; r += 6) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU + r * 0.3;
        const px = clamp(x + Math.cos(a) * r, -t.half * 0.98, t.half * 0.98);
        const py = clamp(y + Math.sin(a) * r, -t.half * 0.98, t.half * 0.98);
        const d = t.waterAtWorld(px, py);
        // Prefer deeper water, and water that is not far away.
        const score = d - r * 0.002;
        if (score > bestScore) {
          bestScore = score;
          best = { x: px, y: py, depth: d };
        }
      }
    }
    return best;
  }

  /**
   * Nearest dense cover: shrubs or closed canopy. Cover changes over seasons,
   * not seconds, so the search is cached per 4×4-cell block and cleared each
   * simulated day. The distance is always measured from the animal's own
   * position, so only the choice of cover is shared between nearby animals.
   */
  private coverCache = new Map<number, { x: number; y: number; score: number } | null>();
  private coverCacheDay = -1;

  findCover(x: number, y: number, range = 180): { x: number; y: number; distance: number } | null {
    const t = this.terrain;
    if (this.clock.day !== this.coverCacheDay) {
      this.coverCache.clear();
      this.coverCacheDay = this.clock.day;
    }
    const cx = clamp(Math.round(t.worldToCellX(x)), 0, t.last);
    const cy = clamp(Math.round(t.worldToCellY(y)), 0, t.last);
    const bx = cx >> 2;
    const by = cy >> 2;
    const key = bx * 65536 + by;
    let best: { x: number; y: number; score: number } | null;
    if (this.coverCache.has(key)) {
      best = this.coverCache.get(key) ?? null;
    } else {
      best = this.searchCover(bx * 4 + 2, by * 4 + 2, range);
      this.coverCache.set(key, best);
    }
    return best ? { x: best.x, y: best.y, distance: Math.hypot(best.x - x, best.y - y) } : null;
  }

  private searchCover(cx: number, cy: number, range: number): { x: number; y: number; score: number } | null {
    const t = this.terrain;
    const step = Math.max(2, Math.round(range / t.cellUnits / 8));
    let best: { x: number; y: number; score: number } | null = null;
    for (let ring = 1; ring <= 10; ring++) {
      const r = ring * step;
      const samples = Math.max(6, Math.min(26, Math.round(r * 1.5)));
      for (let a = 0; a < samples; a++) {
        const ang = (a / samples) * TAU + ring * 0.5;
        const sx = clamp(Math.round(cx + Math.cos(ang) * r), 0, t.last);
        const sy = clamp(Math.round(cy + Math.sin(ang) * r), 0, t.last);
        const i = sy * t.size + sx;
        const wx = t.cellToWorldX(sx);
        const wy = t.cellToWorldY(sy);
        const cover = clamp01(t.canopy.data[i] * 0.8 + this.vegetation.coverAt(wx, wy) * 0.6);
        const d = Math.hypot(wx - t.cellToWorldX(cx), wy - t.cellToWorldY(cy));
        const score = cover * 1.4 - d / Math.max(1, range);
        if (cover > 0.35 && (!best || score > best.score)) best = { x: wx, y: wy, score };
      }
    }
    return best;
  }

  /** Nearest shade (a cool spot under a canopy). */
  findShade(x: number, y: number, range = 180): { x: number; y: number; distance: number } | null {
    const p = this.findShadeNear(x, y, range);
    return p ? { x: p.x, y: p.y, distance: Math.hypot(p.x - x, p.y - y) } : null;
  }

  /** Nearest sunlit spot (used when an animal is cold). */
  findSun(x: number, y: number, range = 180): { x: number; y: number; distance: number } | null {
    const p = this.findSunNear(x, y, range);
    return p ? { x: p.x, y: p.y, distance: Math.hypot(p.x - x, p.y - y) } : null;
  }

  /** Record a footprint (the AI calls this while moving). */
  recordTrack(slot: number, moved = 1): void {
    this.recordTracks(slot, moved);
  }

  /**
   * A kill has happened. Predators keep score, the site is remembered (caches,
   * scavenging), and notable kills become history.
   */
  recordPredation(predator: number, prey: number, preyMass: number): void {
    const c = this.creatures;
    // The prey actually dies here: the body becomes carrion, the predator is
    // credited, and the death runs through the normal mortality path (census,
    // history, lineage records, nutrient return).
    c.knownCauseOfDeath[prey] = 'predation';
    c.kill(prey, 'predation');
    c.killsTotal[predator]++;
    this.onHuntOutcome?.(predator, prey, true);
    c.remember(predator, MemKind.Kill, c.x[prey], c.y[prey], 1);
    this.social.recordKill(c, predator);
    this.onPredation?.(predator, prey, this.clock.day);
    const sp = SPECIES[c.speciesIdx[predator]];
    if (preyMass > 60) {
      this.throttled('big-kill', 6, () => {
        this.pushEvent({
          kind: 'hunt',
          title: `${sp.name} took large prey`,
          detail: `A ${sp.name.toLowerCase()} killed an animal of about ${Math.round(preyMass)} kg in the ${this.terrain.regionNameAt(c.x[prey], c.y[prey])}.`,
          weight: 2,
          speciesId: sp.key,
          x: c.x[prey],
          y: c.y[prey],
        });
      });
    }
  }

  /**
   * Announce a kill to everything that eats carrion: animals with a good sense
   * of smell learn where the body is and will come to investigate.
   */
  broadcastKill(x: number, y: number, killedSpeciesIdx: number): void {
    const c = this.creatures;
    const n = c.queryAliveNear(x, y, 190, this.scratchIds);
    for (let i = 0; i < n; i++) {
      const slot = this.scratchIds[i];
      if (!c.alive[slot] || c.speciesIdx[slot] === killedSpeciesIdx) continue;
      const sp = SPECIES[c.speciesIdx[slot]];
      if (!sp.scavenges && sp.dietKind !== 'predator' && sp.dietKind !== 'piscivore' && sp.dietKind !== 'omnivore') continue;
      if (c.rng.chance(0.35)) c.remember(slot, MemKind.Carcass, x, y, 0.55);
    }
  }

  /** Pass an alarm to conspecifics — a real behaviour, not a UI effect. */
  raiseAlarm(slot: number, x: number, y: number, strength: number): void {
    const c = this.creatures;
    this.social.alarm(c, slot, x, y, clamp01(strength));
    const n = c.querySpeciesNear(x, y, 130, c.speciesIdx[slot], this.scratchIds);
    for (let i = 0; i < n; i++) {
      const other = this.scratchIds[i];
      if (other === slot || !c.alive[other]) continue;
      c.alerted[other] = Math.max(c.alerted[other], 0.7 * strength);
      c.fear[other] = Math.max(c.fear[other], 0.5 * strength);
      if (c.rng.chance(0.4 * strength)) c.remember(other, MemKind.Danger, x, y, 0.5 * strength);
    }
  }

  /** Living children that still depend on this mother. */
  juvenilesOf(mother: number): number[] {
    const c = this.creatures;
    const out: number[] = [];
    const ids = c.childrenIds[mother];
    if (!ids) return out;
    for (const id of ids) {
      const slot = c.findByLivingId(id);
      if (slot < 0) continue;
      if (!c.weaned[slot] || c.dependentOf[slot] === c.id[mother]) out.push(slot);
    }
    return out;
  }

  /** A successful mating: start gestation with a real fetus count. */
  beginPregnancy(female: number, male: number): void {
    const c = this.creatures;
    const sp = SPECIES[c.speciesIdx[female]];
    const fecundity = c.trait(female, 'fertility');
    const [lo, hi] = sp.litterSize;
    const fetuses = Math.max(1, Math.round(clamp(lerp(lo, hi, 0.35 + this.rng.next() * 0.5) * fecundity, 1, 8)));
    c.pregnantLeft[female] = sp.gestationDays * (0.9 + this.rng.next() * 0.2);
    c.fetusCount[female] = fetuses;
    c.mateId[female] = c.id[male];
    c.mateId[male] = c.id[female];
    c.pregnancyCount[female]++;
    this.onMating?.(female, male);
  }

  /**
   * "While you were away": advance the world to account for real time that
   * passed since the save, then summarise what changed.
   */
  catchUp(savedAt: number, options: { maxDays?: number; budgetMs?: number } = {}): OfflineSummary | null {
    const elapsedMs = Date.now() - savedAt;
    const minutes = Math.min(
      (options.maxDays ?? 365) * TIME.minutesPerDay,
      Math.max(0, (elapsedMs / 1000) * (TIME.minutesPerDay / TIME.realSecondsPerDayAt1x) * 6),
    );
    if (minutes < 30) return null;
    const fromDay = this.clock.day;
    const before: Record<string, number> = {};
    for (const s of SPECIES) before[s.key] = this.census.get(s.key)?.count ?? 0;
    const beforeEvents = this.history.events.length;
    this.advance(minutes, options.budgetMs ?? 2600);
    this.census.update(this, true);
    const after: Record<string, number> = {};
    for (const s of SPECIES) after[s.key] = this.census.get(s.key)?.count ?? 0;
    let births = 0;
    let deaths = 0;
    let generations = 0;
    for (let i = 0; i < SPECIES.length; i++) {
      births += this.census.get(SPECIES[i].key)?.birthsThisYear ?? 0;
      generations = Math.max(generations, this.census.get(SPECIES[i].key)?.maxGeneration ?? 0);
    }
    const newEvents = this.history.events.slice(beforeEvents);
    for (const e of newEvents) if (e.kind === 'death') deaths++;
    const changes = SPECIES.filter((s) => before[s.key] !== after[s.key]).map((s) => ({ id: s.key, name: s.name, from: before[s.key], to: after[s.key] }));
    const summary: OfflineSummary = {
      elapsedDays: Math.round(this.clock.day - fromDay),
      fromDay,
      toDay: this.clock.day,
      births,
      deaths,
      speciesChanges: changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 6),
      events: newEvents.filter((e) => e.weight >= 2).slice(-8),
      generationsAdvanced: generations,
      mutations: this.history.discoveries.filter((d) => d.day >= fromDay).map((d) => d.title),
      biomeChanges: [],
    };
    return summary;
  }
}

function describeClimateEvent(e: ClimateEvent): string {
  switch (e.kind) {
    case 'drought':
      return 'Rain has stopped and the soil is drying out. Rivers will shrink; grazers will have to travel.';
    case 'heatwave':
      return 'Temperature is far above normal. Water loss is high and fire risk climbs.';
    case 'coldwave':
      return 'A severe cold snap is moving in. Unprotected animals and shallow-rooted plants are at risk.';
    case 'monsoon':
      return 'Persistent rain is soaking the ground; rivers will rise and low ground may flood.';
    case 'volcanicWinter':
      return 'Ash is dimming the sun and the world is cooling.';
    default:
      return '';
  }
}

function w_ind(c: Creatures, slot: number): number {
  const g = c.genome[slot];
  return g ? g.get('speed') : 1;
}

/** Short readable identifier such as "W-1847". */
export function tagFor(sp: SpeciesDef, id: number): string {
  return `${sp.tag}-${id}`;
}

export { Biome, biomeName, isWaterBiome, PLANT_LAYERS, PLANT_INDEX, FIRE, LIFE };
