/**
 * The host: one place that owns the world, drives it at the requested speed,
 * remembers the player's settings, saves the planet to IndexedDB and turns
 * simulation facts into the statements the interface makes. Nothing here
 * invents state — every readout comes from `World`.
 */
import { DEFAULT_SETTINGS, type OfflineSummary, type Settings, type WorldEvent } from '../core/events';
import { clamp01 } from '../core/math';
import { TIME } from '../core/config';
import { Random } from '../core/rng';
import { World } from '../world/world';
import { defaultParams, type WorldParams } from '../world/terrain';
import { SPECIES, speciesIndex } from '../life/species';
import { Action, GoalKind, HomeKind, MemKind, Stage, ANIMAL_TRAITS, ACTION_LABEL, MEM_LABEL } from '../life/organism';
import { feedStats } from '../life/ai';
import { WorldStore, lastWorld, type WorldRecord } from './store';

export type ToolKind =
  | 'inspect'
  | 'spawn'
  | 'plant'
  | 'tree'
  | 'raise'
  | 'lower'
  | 'flatten'
  | 'water'
  | 'drain'
  | 'flood'
  | 'fire'
  | 'none';

export interface OrganismProfile {
  id: number;
  slot: number;
  species: string;
  speciesName: string;
  latin: string;
  role: string;
  sex: 'male' | 'female';
  ageYears: number;
  ageDays: number;
  stage: string;
  generation: number;
  health: number;
  hunger: number;
  thirst: number;
  energy: number;
  fatigue: number;
  warmth: number;
  injury: number;
  fear: number;
  fertility: number;
  pregnant: boolean;
  gestationLeftDays: number;
  fetusCount: number;
  nursingDays: number;
  condition: number;
  action: string;
  goal: string;
  goalTarget: { x: number; y: number } | null;
  position: { x: number; y: number };
  heading: number;
  speed: number;
  bodyLength: number;
  massKg: number;
  x: number;
  y: number;
  drankHoursAgo: number;
  ateHoursAgo: number;
  kills: number;
  meals: number;
  distanceTravelled: number;
  parents: { mother: number; father: number };
  offspring: number[];
  mates: number[];
  children: number[];
  group: { name: string; size: number; role: string; territory: { x: number; y: number; radius: number } } | null;
  home: { x: number; y: number; kind: string } | null;
  territory: { x: number; y: number; radius: number } | null;
  traits: { key: string; label: string; value: number; mean: number; sigma: number }[];
  personality: { key: string; value: number }[];
  memory: { kind: string; label: string; x: number; y: number; strength: number; distance: number }[];
  recentEvents: WorldEvent[];
  infection: { infected: boolean; pathogen: string; days: number; immunity: number };
}

export interface SpeedOption {
  label: string;
  value: number;
}

export const SPEEDS: SpeedOption[] = TIME.speedSteps.map((s) => ({ label: s === 0 ? 'Pause' : `${s}×`, value: s }));

const SETTINGS_KEY = 'living-planet:settings';

export class SimHost {
  world: World;
  settings: Settings;
  readonly store = new WorldStore();
  recordId: string | null = null;
  /** Tool currently armed in the sandbox bar. */
  tool: ToolKind = 'inspect';
  spawnSpecies: string = 'rabbit';
  followId: number | null = null;
  selectedId: number | null = null;
  documentary = false;
  caption = '';
  captionSubject = '';
  lastAutosave = 0;
  lastSavedAt = 0;
  dirty = false;
  pendingSummary: OfflineSummary | null = null;
  /** Errors the world reported, newest last. */
  readonly errors: string[] = [];

  private toastHandlers: ((text: string, kind?: string) => void)[] = [];
  private captionHandlers: ((text: string, subject: string) => void)[] = [];
  private changeHandlers: (() => void)[] = [];
  private captionTimer = 0;
  private settingsEvents = 0;
  private playingBeforePause = true;

  constructor(world: World, settings: Settings) {
    this.world = world;
    this.settings = settings;
    this.wire();
  }

  /** Create a brand new planet. */
  static create(seed: string, name: string, settings: Settings): SimHost {
    const world = new World(defaultParams(seed, name));
    const host = new SimHost(world, settings);
    host.world.pushEvent({
      kind: 'discovery',
      title: `${name} settled into its orbit`,
      detail: `Seed “${seed}”: ${SPECIES.length} species, ${Math.round(world.terrain.worldSize)} m across, day one.`,
      weight: 2,
    });
    return host;
  }

  /** Load a saved world record (does not touch IndexedDB beyond the lookup). */
  static fromRecord(record: WorldRecord, settings: Settings): SimHost {
    const params = (record.data.params as WorldParams | undefined) ?? defaultParams(record.seed, record.name);
    const world = new World({ ...params, seed: record.seed, name: record.name });
    world.load(record.data);
    const host = new SimHost(world, settings);
    host.recordId = record.id;
    host.lastSavedAt = record.savedAt;
    return host;
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  private wire(): void {
    const bus = this.world.bus;
    bus.on('event:notable', (event) => {
      if (this.documentary && event.weight >= 2) this.say(this.captionFor(event), event.speciesId ?? '');
      if (event.weight >= 2) this.toast(`${event.title}${event.detail ? ` — ${event.detail}` : ''}`, event.kind);
      this.dirty = true;
      this.emitChange();
    });
    bus.on('discovery:new', ({ title, detail }) => {
      this.toast(`New observation: ${title}`, 'discovery');
      if (this.documentary) this.say(`${title}. ${detail}`, '');
    });
    bus.on('species:extinct', ({ speciesId, day }) => {
      const sp = SPECIES.find((s) => s.key === speciesId);
      this.toast(`${sp?.name ?? speciesId} is gone from this world — day ${day}.`, 'extinct');
      if (this.documentary) this.say(`The last ${sp?.name.toLowerCase() ?? speciesId} has died. Day ${day}.`, speciesId);
    });
    bus.on('sim:error', ({ message, where }) => {
      this.errors.push(`${where}: ${message}`);
      if (this.errors.length > 40) this.errors.shift();
    });
    bus.on('weather:change', ({ state }) => {
      if (this.documentary && state === 'storm') this.say('A storm front moves over the basin.', '');
    });
  }

  onToast(handler: (text: string, kind?: string) => void): () => void {
    this.toastHandlers.push(handler);
    return () => {
      const i = this.toastHandlers.indexOf(handler);
      if (i >= 0) this.toastHandlers.splice(i, 1);
    };
  }

  onCaption(handler: (text: string, subject: string) => void): () => void {
    this.captionHandlers.push(handler);
    return () => {
      const i = this.captionHandlers.indexOf(handler);
      if (i >= 0) this.captionHandlers.splice(i, 1);
    };
  }

  onChange(handler: () => void): () => void {
    this.changeHandlers.push(handler);
    return () => {
      const i = this.changeHandlers.indexOf(handler);
      if (i >= 0) this.changeHandlers.splice(i, 1);
    };
  }

  private emitChange(): void {
    for (const h of this.changeHandlers) h();
  }

  toast(text: string, kind?: string): void {
    for (const h of this.toastHandlers) h(text, kind);
  }

  say(text: string, subject: string): void {
    this.caption = text;
    this.captionSubject = subject;
    this.captionTimer = 9;
    for (const h of this.captionHandlers) h(text, subject);
  }

  private captionFor(event: WorldEvent): string {
    switch (event.kind) {
      case 'hunt':
        return 'A hunt concludes. The carcass will feed scavengers and, eventually, the soil.';
      case 'disaster':
        return `${event.title}. The land will recover on its own schedule, not ours.`;
      case 'climate':
        return `${event.title}. Weather is the strongest force in this valley.`;
      case 'evolution':
        return `${event.title}. Heritable change, measured across generations.`;
      case 'population':
        return `${event.title}. Populations here rise and fall with their food.`;
      case 'disease':
        return `${event.title}. Pathogens spread where hosts are crowded.`;
      case 'birth':
        return `${event.title}. New animals to follow.`;
      default:
        return event.detail ?? event.title;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Time control                                                        */
  /* ------------------------------------------------------------------ */

  get speedIndex(): number {
    return this.world.clock.speedIndex;
  }

  get paused(): boolean {
    return this.world.clock.paused;
  }

  setSpeedIndex(index: number): void {
    if (index > 0) this.playingBeforePause = true;
    this.world.clock.setSpeedIndex(index);
    this.emitChange();
  }

  setSpeed(value: number): void {
    const index = TIME.speedSteps.indexOf(value as (typeof TIME.speedSteps)[number]);
    this.setSpeedIndex(index < 0 ? 1 : index);
  }

  togglePause(): void {
    if (this.paused) this.setSpeed((this.speedIndex > 0 ? TIME.speedSteps[this.speedIndex] : 1) as number);
    else {
      this.playingBeforePause = false;
      this.world.clock.setSpeedIndex(0);
    }
    this.emitChange();
  }

  /** Fast-forward by an exact span of simulated time. */
  jump(kind: 'hour' | 'day' | 'week' | 'month' | 'year'): void {
    const minutes =
      kind === 'hour' ? 60 : kind === 'day' ? TIME.minutesPerDay : kind === 'week' ? TIME.minutesPerDay * 7 : kind === 'month' ? TIME.minutesPerDay * 30 : TIME.minutesPerDay * TIME.daysPerYear;
    this.toast(`Advancing ${kind}...`);
    this.world.advance(minutes, 2500);
    this.world.census.update(this.world, true);
    this.world.history.sample(this.world);
    this.dirty = true;
    this.emitChange();
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  frame(realSeconds: number, now: number): void {
    const minutes = this.world.update(realSeconds);
    void minutes;
    // Autosave: frequent enough that a reload never costs much, cheap because
    // serialising a world is a few milliseconds.
    if (this.settings.autosave && this.recordId && this.dirty && now - this.lastAutosave > 60_000) {
      this.lastAutosave = now;
      void this.save();
    }
    if (this.captionTimer > 0) this.captionTimer -= realSeconds;
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  private recordFor(id: string | null, name: string): WorldRecord {
    const world = this.world;
    const data = world.save();
    const population = SPECIES.reduce((n, sp) => n + (world.census.get(sp.key)?.count ?? 0), 0);
    return {
      id: id ?? WorldStore.newId(),
      name,
      seed: world.seed,
      day: world.clock.day,
      year: world.clock.year,
      savedAt: Date.now(),
      population,
      species: SPECIES.filter((sp) => !(world.census.get(sp.key)?.extinct ?? false)).length,
      minutes: Math.round(world.clock.minutes),
      byteSize: WorldStore.estimateSize(data),
      data,
    };
  }

  async save(name?: string): Promise<string> {
    const id = this.recordId ?? WorldStore.newId();
    const record = this.recordFor(id, name ?? this.world.name);
    this.world.name = record.name;
    await this.store.save(record);
    this.recordId = id;
    this.lastSavedAt = Date.now();
    this.lastAutosave = Date.now();
    this.dirty = false;
    lastWorld.set(id);
    this.emitChange();
    return id;
  }

  async load(id: string): Promise<boolean> {
    const record = await this.store.get(id);
    if (!record) return false;
    const summary = await this.applyRecord(record);
    this.pendingSummary = summary;
    this.emitChange();
    return true;
  }

  private async applyRecord(record: WorldRecord): Promise<OfflineSummary | null> {
    const params = (record.data.params as WorldParams | undefined) ?? defaultParams(record.seed, record.name);
    const world = new World({ ...params, seed: record.seed, name: record.name });
    world.load(record.data);
    // The old world is replaced wholesale; the caller re-reads `host.world`.
    this.world = world;
    this.recordId = record.id;
    this.lastSavedAt = record.savedAt;
    this.selectedId = null;
    this.followId = null;
    this.errors.length = 0;
    this.wire();
    lastWorld.set(record.id);
    // Offline time only counts if the world was loaded from a previous visit.
    const elapsedDays = (Date.now() - record.savedAt) / 1000 / (TIME.realSecondsPerDayAt1x / 6);
    if (elapsedDays > 0.5) {
      const summary = this.world.catchUp(record.savedAt, { maxDays: 365, budgetMs: 1600 });
      this.dirty = true;
      return summary;
    }
    return null;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.store.rename(id, name);
    if (this.recordId === id) this.world.name = name;
    this.emitChange();
  }

  async deleteWorld(id: string): Promise<void> {
    await this.store.remove(id);
    if (this.recordId === id) {
      this.recordId = null;
      lastWorld.set(null);
    }
    this.emitChange();
  }

  async duplicate(id: string, name: string): Promise<void> {
    await this.store.duplicate(id, name);
    this.emitChange();
  }

  exportWorld(): void {
    const record = this.recordFor(this.recordId, this.world.name);
    const text = WorldStore.export(record);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(this.world.name)}-day${record.day}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importWorld(file: File): Promise<void> {
    const text = await file.text();
    const record = WorldStore.parse(text);
    await this.store.save(record);
    await this.load(record.id);
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  static loadSettings(): Settings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  applySettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.settingsEvents++;
    if (patch.reducedMotion !== undefined || patch.uiScale !== undefined || patch.highContrast !== undefined || patch.colorblindSafe !== undefined) {
      applyAppearance(this.settings);
    }
    this.world.bus.emit('settings:changed', patch);
    this.emitChange();
  }

  resetSettings(): void {
    this.applySettings({ ...DEFAULT_SETTINGS });
  }

  get settingsVersion(): number {
    return this.settingsEvents;
  }

  /* ------------------------------------------------------------------ */
  /* Sandbox tools                                                       */
  /* ------------------------------------------------------------------ */

  /** Apply the armed tool at a world position. */
  applyTool(x: number, y: number, radius: number, opts: { strength?: number; species?: string; layer?: number } = {}): string {
    const world = this.world;
    const strength = opts.strength ?? 1;
    switch (this.tool) {
      case 'spawn': {
        const key = opts.species ?? this.spawnSpecies;
        const ids = world.spawnSpecies(key, x, y, { count: 1 + Math.round(radius / 24) });
        const sp = SPECIES[speciesIndex(key)];
        this.toast(`Released ${ids.length} ${sp?.name.toLowerCase() ?? key} into the ${world.terrain.regionNameAt(x, y)}.`, 'spawn');
        this.dirty = true;
        return `${ids.length} × ${sp?.name ?? key}`;
      }
      case 'plant': {
        const n = world.sowAt(x, y, radius, opts.layer ?? 0, 0.5 * strength);
        this.toast(`Sowed vegetation in ${n} cells.`, 'plant');
        this.dirty = true;
        return `${n} cells sown`;
      }
      case 'tree': {
        const n = world.plantTreesAt(x, y, radius, 0, Math.round(6 * strength));
        this.toast(`Planted ${n} trees.`, 'tree');
        this.dirty = true;
        return `${n} trees`;
      }
      case 'raise':
      case 'lower': {
        const delta = (this.tool === 'raise' ? 1 : -1) * 0.05 * strength;
        world.sculptTerrain(x, y, radius, delta, false);
        this.dirty = true;
        return `${delta > 0 ? 'Raised' : 'Lowered'} terrain`;
      }
      case 'flatten': {
        world.sculptTerrain(x, y, radius, 0, true);
        this.dirty = true;
        return 'Flattened terrain';
      }
      case 'water': {
        world.hydrology.addWaterAt(x, y, radius, 0.35 * strength);
        this.dirty = true;
        return 'Water added';
      }
      case 'drain': {
        world.hydrology.removeWaterAt(x, y, radius, 1);
        this.dirty = true;
        return 'Water drained';
      }
      case 'flood': {
        world.floodAt(x, y, radius, 0.9 * strength);
        this.toast('The river bursts its banks.', 'disaster');
        this.dirty = true;
        return 'Flood';
      }
      case 'fire': {
        const cx = Math.round(world.terrain.worldToCellX(x));
        const cy = Math.round(world.terrain.worldToCellY(y));
        world.fire.ignite(cx, cy, 0.6 + strength * 0.4);
        this.dirty = true;
        return 'Fire lit';
      }
      case 'inspect':
      default:
        return '';
    }
  }

  removeSelected(): boolean {
    if (this.selectedId === null) return false;
    const slot = this.world.creatures.findByLivingId(this.selectedId);
    if (slot < 0) return false;
    this.world.removeOrganism(this.selectedId, 'removed by observer');
    this.selectedId = null;
    this.emitChange();
    return true;
  }

  cloneSelected(): boolean {
    if (this.selectedId === null) return false;
    const id = this.world.cloneOrganism(this.selectedId);
    if (id === null) return false;
    this.select(id);
    return true;
  }

  relocateSelected(x: number, y: number): boolean {
    if (this.selectedId === null) return false;
    return this.world.relocateOrganism(this.selectedId, x, y);
  }

  select(id: number | null): void {
    this.selectedId = id;
    this.emitChange();
  }

  follow(id: number | null): void {
    this.followId = id;
    this.selectedId = id ?? this.selectedId;
    this.emitChange();
  }

  favourite(id: number): void {
    if (!this.favourites.includes(id)) this.favourites.unshift(id);
    if (this.favourites.length > 12) this.favourites.pop();
    this.emitChange();
  }

  favourites: number[] = [];
  compareA: number | null = null;
  compareB: number | null = null;

  /* ------------------------------------------------------------------ */
  /* Reports                                                             */
  /* ------------------------------------------------------------------ */

  /** A "while you were away" report, built only from measured differences. */
  buildReport(summary: OfflineSummary | null): { title: string; lines: string[]; changes: { name: string; from: number; to: number; delta: number }[] } | null {
    if (!summary) return null;
    const changes = summary.speciesChanges.map((c) => ({ name: c.name, from: c.from, to: c.to, delta: c.to - c.from }));
    const notable = summary.events.filter((e) => e.weight >= 2).slice(-6);
    const lines: string[] = [];
    lines.push(`${summary.elapsedDays.toFixed(1)} days passed while you were away (day ${summary.fromDay} → ${summary.toDay}).`);
    lines.push(`${summary.births} births and ${summary.deaths} deaths were recorded.`);
    if (summary.generationsAdvanced > 0) lines.push(`${summary.generationsAdvanced} animals reached a new generation.`);
    for (const c of changes.filter((c) => Math.abs(c.delta) >= 1).slice(0, 8)) {
      lines.push(`${c.name}: ${c.from} → ${c.to} (${c.delta > 0 ? '+' : ''}${c.delta})`);
    }
    for (const e of notable) lines.push(`Day ${e.day}: ${e.title}`);
    if (summary.mutations.length) lines.push(`Trait shifts: ${summary.mutations.slice(0, 4).join(', ')}.`);
    return { title: 'Returned from the field', lines, changes };
  }

  /* ------------------------------------------------------------------ */
  /* Inspection                                                          */
  /* ------------------------------------------------------------------ */

  profile(id: number): OrganismProfile | null {
    const c = this.world.creatures;
    const slot = c.findByLivingId(id);
    if (slot < 0) return null;
    const sp = SPECIES[c.speciesIdx[slot]];
    const field = this.world.terrain;
    const group = this.world.social.groupFor(c, slot);
    const home = c.hasHome[slot]
      ? { x: c.homeX[slot], y: c.homeY[slot], kind: HomeKind[c.homeKind[slot]] ?? 'none' }
      : null;
    const territory = c.territoryR[slot] > 0 ? { x: c.territoryX[slot], y: c.territoryY[slot], radius: c.territoryR[slot] } : null;
    const stats = this.world.census.get(sp.key);
    const traits = ANIMAL_TRAITS.map((t, i) => {
      // The population mean comes from the census; the spread is measured from
      // the living genomes. The individual's value is its own.
      const mean = stats?.traits[i]?.value ?? 0;
      const sigma = c.traitSigma(c.speciesIdx[slot], i, mean);
      return { key: t.key, label: t.label, value: c.trait(slot, t.key), mean, sigma };
    });
    const personalityKeys = ['Boldness', 'Caution', 'Curiosity', 'Sociability', 'Activity', 'Aggression'];
    const personality = personalityKeys.map((k, i) => ({ key: k, value: c.personality_(slot, i as never) }));
    const memory: OrganismProfile['memory'] = [];
    for (const kind of [MemKind.Water, MemKind.Food, MemKind.Danger, MemKind.Den, MemKind.Kill, MemKind.Carcass, MemKind.Mate, MemKind.Cache]) {
      const mem = c.recall(slot, kind);
      if (!mem) continue;
      memory.push({
        kind: MemKind[kind],
        label: MEM_LABEL[kind],
        x: mem.x,
        y: mem.y,
        strength: mem.strength,
        distance: Math.hypot(mem.x - c.x[slot], mem.y - c.y[slot]),
      });
    }
    const recentEvents = this.world.history.events.filter((e) => e.organismId === id).slice(-8).reverse();
    return {
      id,
      slot,
      species: sp.key,
      speciesName: sp.name,
      latin: sp.latin,
      role: sp.role,
      sex: c.sex[slot] === 1 ? 'female' : 'male',
      ageYears: c.ageDays[slot] / TIME.daysPerYear,
      ageDays: c.ageDays[slot],
      stage: Stage[c.stage[slot]],
      generation: c.generation[slot],
      health: c.health[slot],
      hunger: c.hunger[slot],
      thirst: c.thirst[slot],
      energy: c.energy[slot],
      fatigue: c.fatigue[slot],
      warmth: c.warmth[slot],
      injury: c.injury[slot],
      fear: c.fear[slot],
      fertility: c.trait(slot, 'fertility'),
      pregnant: c.pregnantLeft[slot] > 0,
      gestationLeftDays: c.pregnantLeft[slot],
      fetusCount: c.fetusCount[slot],
      nursingDays: c.nursingMinutes[slot] / TIME.minutesPerDay,
      condition: clamp01(c.health[slot] * 0.6 + c.energy[slot] * 0.4),
      action: ACTION_LABEL[c.action[slot] as Action] ?? Action[c.action[slot]],
      goal: GoalKind[c.goalKind[slot]] ?? 'None',
      goalTarget: c.hasTarget[slot] ? { x: c.targetX[slot], y: c.targetY[slot] } : null,
      position: { x: c.x[slot], y: c.y[slot] },
      heading: c.heading[slot],
      speed: c.speed[slot],
      bodyLength: c.size[slot],
      massKg: sp.massKg * c.bodyScale(slot),
      x: c.x[slot],
      y: c.y[slot],
      drankHoursAgo: c.lastDrinkHours[slot],
      ateHoursAgo: c.lastMealHours[slot],
      kills: c.killsTotal[slot],
      meals: c.mealsTotal[slot],
      distanceTravelled: c.distanceTravelled[slot],
      parents: { mother: c.motherId[slot], father: c.fatherId[slot] },
      offspring: c.childrenIds[slot] ?? [],
      mates: c.mateId[slot] > 0 ? [c.mateId[slot]] : [],
      children: this.world.juvenilesOf(slot),
      group: group
        ? {
            name: `${sp.name} ${sp.social}`,
            size: group.members.length,
            role: group.leaderSlot === slot ? 'leader' : 'member',
            territory: { x: group.territoryX, y: group.territoryY, radius: group.territoryRadius },
          }
        : null,
      home,
      territory,
      traits,
      personality,
      memory,
      recentEvents,
      infection: {
        infected: c.infection[slot] === 1,
        pathogen: this.world.disease.summary(c.speciesIdx[slot])?.name ?? 'none',
        days: c.infectionDays[slot],
        immunity: c.immunity[slot],
      },
    };
  }

  get regionAt(): (x: number, y: number) => string {
    return (x, y) => this.world.terrain.regionNameAt(x, y);
  }

  /** Live feeding diagnostics (real counts, used by the stats panel). */
  get feed(): typeof feedStats {
    return feedStats;
  }

  /** A random fresh seed for the world creator. */
  static randomSeed(): string {
    const rng = new Random(`seed-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    const syllables = ['ka', 'mor', 'vel', 'tir', 'ash', 'len', 'dor', 'syl', 'nara', 'ith', 'ven', 'orin', 'bela', 'cra', 'tovan', 'yara'];
    let out = '';
    const n = rng.int(3, 4);
    for (let i = 0; i < n; i++) out += syllables[rng.int(0, syllables.length - 1)];
    return out;
  }
}

export function applyAppearance(settings: Settings): void {
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(settings.uiScale));
  root.classList.toggle('reduced-motion', settings.reducedMotion);
  root.classList.toggle('high-contrast', settings.highContrast);
  root.classList.toggle('colorblind', settings.colorblindSafe);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'world';
}
