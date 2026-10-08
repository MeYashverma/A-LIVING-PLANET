import { clamp, clamp01, lerp, TAU } from '../core/math';
import { LIFE, TIME } from '../core/config';
import { Random } from '../core/rng';
import { LinkedGrid } from './spatial';
import { Genome, ANIMAL_TEMPLATE, ANIMAL_TRAITS, type TraitDef } from './genome';
import { SPECIES, type SpeciesDef } from './species';

/** Behaviour states an animal can be in. */
export enum Action {
  Idle = 0,
  Wander = 1,
  Forage = 2,
  Hunt = 3,
  Scavenge = 4,
  Drink = 5,
  Rest = 6,
  Flee = 7,
  Hide = 8,
  ReturnHome = 9,
  Court = 10,
  Mate = 11,
  Nurture = 12,
  Patrol = 13,
  Socialize = 14,
  Migrate = 15,
  Bask = 16,
  Investigate = 17,
  Cache = 18,
  Die = 19,
}

export enum Stage {
  Juvenile = 0,
  Subadult = 1,
  Adult = 2,
  Aged = 3,
}

/** Personality axes: inherited, then nudged by early life. */
export enum P {
  Aggression = 0,
  Boldness = 1,
  Curiosity = 2,
  Sociability = 3,
  Caution = 4,
  Activity = 5,
}
export const P_TRAITS = 6;

/** Kinds of place an animal can remember. */
/** The kind of home an animal builds or uses. */
export enum HomeKind {
  Den = 0,
  Burrow = 1,
  Nest = 2,
  Roost = 3,
  Shoal = 4,
  Hive = 5,
}

/** Why an animal is walking somewhere — used to avoid re-planning every tick. */
export enum GoalKind {
  None = 0,
  Wander = 1,
  Forage = 2,
  Water = 3,
  Home = 4,
  Prey = 5,
  Carcass = 6,
  Mate = 7,
  Flee = 8,
  Group = 9,
  Migrate = 10,
}

export enum MemKind {
  Water = 0,
  Food = 1,
  Danger = 2,
  Mate = 3,
  Den = 4,
  Cache = 5,
  Carcass = 6,
  Kill = 7,
}
export const MEM_SLOTS = 10;

/** Ring buffer of trail points per animal, for the tracking view. */
export const TRAIL_POINTS = 96;

export interface CensusStats {
  count: Int32Array;
  males: Int32Array;
  females: Int32Array;
  juveniles: Int32Array;
  adults: Int32Array;
  pregnant: Int32Array;
  birthsToday: Int32Array;
  deathsToday: Int32Array;
  birthsThisYear: Int32Array;
  deathsThisYear: Int32Array;
  /** Days, for lifespan stats. */
  oldestDays: Float32Array;
  youngestDays: Float32Array;
  sumAgeDays: Float32Array;
  sumHealth: Float32Array;
  sumHunger: Float32Array;
  sumEnergy: Float32Array;
  sumSpeed: Float32Array;
  meanAge: Float32Array;
  meanHealth: Float32Array;
  meanHunger: Float32Array;
  meanEnergy: Float32Array;
  generations: Int32Array;
  groupMembers: Int32Array;
  homeRanges: Int32Array;
}

export interface SpawnOptions {
  speciesIdx: number;
  x: number;
  y: number;
  genome?: Genome | null;
  sex?: 0 | 1;
  ageDays?: number;
  motherId?: number;
  fatherId?: number;
  energy?: number;
  /** Starting condition 0..1 (founders arrive healthy; newborns are fragile). */
  health?: number;
  /** Starting hunger/thirst 0..1 (used by spawn tools and by founders). */
  hunger?: number;
  thirst?: number;
  generation?: number;
  personality?: Float32Array | null;
  groupId?: number;
  homeX?: number;
  homeY?: number;
  homeKind?: number;
  /** Litter siblings are born at the same instant; they share a nest. */
  litterSize?: number;
}

/**
 * Every individually simulated animal in the world. Struct-of-arrays so that
 * hundreds of animals can be stepped inside a few milliseconds: needs, memory,
 * genetics, social life and death live in flat typed arrays, and the AI in
 * `ai.ts` reads them directly.
 */
export class Creatures {
  readonly capacity: number;
  /** How many animals are alive (kept in step with `alive`). */
  count = 0;
  nextId = 1;

  // --- identity & lineage
  alive: Uint8Array;
  speciesIdx: Uint8Array;
  sex: Uint8Array;
  id: Int32Array;
  genome: (Genome | null)[];
  personality: Float32Array;
  generation: Int32Array;
  motherId: Int32Array;
  fatherId: Int32Array;
  offspringCount: Int32Array;
  childrenIds: number[][] = [];

  // --- age & body
  birthDay: Float32Array;
  ageDays: Float32Array;
  stage: Uint8Array;
  size: Float32Array;

  // --- need state (0..1)
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  energy: Float32Array;
  warmth: Float32Array;
  health: Float32Array;
  injury: Float32Array;
  stress: Float32Array;
  fear: Float32Array;
  /** Sick animals lose their appetite. */
  anorexia: Float32Array;
  /** Recent movement intensity, used by disease and by the SIT in ambush. */
  movementActivity: Float32Array;
  /** Set to 1 by another system when this animal should die this step. */
  pendingDeath: Uint8Array;
  knownCauseOfDeath: (string | null)[];

  // --- disease
  infection: Uint8Array;
  pathogen: Uint8Array;
  infectionDays: Float32Array;
  immunity: Float32Array;

  // --- position & movement
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  heading: Float32Array;
  speed: Float32Array;
  /** Position at the start of the last sim step, for smooth rendering. */
  prevX: Float32Array;
  prevY: Float32Array;
  prevHeading: Float32Array;
  /** Who is hunting this animal (id), from scent/observation — set by the AI. */
  pursuitId: Int32Array;
  /** Desired velocity from the current goal, integrated by the mover. */
  vx: Float32Array;
  vy: Float32Array;
  /** How long the current target stays valid (simulated minutes). */
  goalMinutes: Float32Array;
  /** Fear timer set when a predator is detected, and the hunt cooldown. */
  fleeTimer: Float32Array;
  huntCooldown: Float32Array;
  /** 0..1 — how close a stalk is to being sprung. */
  stalkProgress: Float32Array;
  /** Days since the last meal / drink, for the inspector. */
  lastMealDay: Float32Array;
  lastDrinkDay: Float32Array;
  /** Distance travelled in this life, in world units (used by home ranges). */
  distanceTravelled: Float32Array;
  /** Kills and meals this individual has made. */
  killsTotal: Int32Array;
  mealsTotal: Int32Array;
  /** Home slice index for a den/nest inside a tree, cave or burrow. */
  homeProp: Int32Array;
  /** Minutes since birth for juveniles, and the mother's nursing clock. */
  dependence: Float32Array;
  /** Flight altitude blend (0 grounded, 1 fully airborne). */
  airborne: Float32Array;
  /** Why this animal is doing what it is doing (shown in the inspector). */
  reason: (string | null)[];
  urgency: Float32Array;
  /** Filled at death: what killed it. */
  deathCause: (string | null)[];
  /** Animation phase and blend target, written by the AI for the renderer. */
  animPhase: Float32Array;
  animSpeed: Float32Array;
  animState: Uint8Array;
  inWater: Uint8Array;
  hiding: Uint8Array;
  sleeping: Uint8Array;
  flying: Uint8Array;

  // --- behaviour
  action: Uint8Array;
  actionMinutes: Float32Array;
  thinkTimer: Float32Array;
  targetX: Float32Array;
  targetY: Float32Array;
  hasTarget: Uint8Array;
  goalKind: Uint8Array;
  goalId: Int32Array;
  attackTimer: Float32Array;
  lastMealHours: Float32Array;
  lastDrinkHours: Float32Array;
  lastSleepHours: Float32Array;
  /** Tracks how recently this animal was hunted, for wariness. */
  alerted: Float32Array;
  alarmTimer: Float32Array;
  callCooldown: Float32Array;

  // --- memory
  memX: Float32Array;
  memY: Float32Array;
  memKind: Uint8Array;
  memStrength: Float32Array;
  memCursor: Uint8Array;

  // --- home & territory
  homeX: Float32Array;
  homeY: Float32Array;
  homeKind: Uint8Array;
  hasHome: Uint8Array;
  denDay: Float32Array;
  territoryX: Float32Array;
  territoryY: Float32Array;
  territoryR: Float32Array;
  homeRangeDistance: Float32Array;

  // --- social
  groupId: Int32Array;
  groupRole: Uint8Array;
  leaderId: Int32Array;

  // --- reproduction
  pregnantLeft: Float32Array;
  fetusCount: Uint8Array;
  mateId: Int32Array;
  breedCooldown: Float32Array;
  nursingMinutes: Float32Array;
  dependentOf: Int32Array;
  weaned: Uint8Array;
  litters: Int32Array;
  eggsLaid: Int32Array;
  /** Fractional meal accumulator: a full stomach counts as one meal. */
  mealsFraction: Float32Array;
  /** Lifelong reproduction counters, used by the family tree and the census. */
  pregnancyCount: Int32Array;
  /** Total births in the whole population (a scalar, for history/discoveries). */
  birthsTotal = 0;

  // --- tracking trail (ring buffer)
  trailX: Float32Array;
  trailY: Float32Array;
  trailAge: Float32Array;
  trailCursor: Uint8Array;
  trailCount: Uint8Array;
  trailTimer: Float32Array;

  // --- derived caches refreshed periodically
  census: CensusStats;

  grid: LinkedGrid;
  rng: Random;
  scratch: Int32Array;
  /** World extent in world units, used to clamp targets. */
  worldSize: number;
  /** Species index → indices of species that hunt it. */
  predatorsOf: number[][];
  preyOf: number[][];

  private freeSlots: number[] = [];
  private scratchIds: number[] = [];

  constructor(seed: string, worldSize: number) {
    const cap = LIFE.maxIndividuals;
    this.capacity = cap;
    this.worldSize = worldSize;
    this.rng = new Random(seed + ':creatures');
    this.grid = new LinkedGrid(worldSize, 24, cap);

    const i32 = () => new Int32Array(cap).fill(-1);
    const f32 = () => new Float32Array(cap);
    this.alive = new Uint8Array(cap);
    this.speciesIdx = new Uint8Array(cap);
    this.sex = new Uint8Array(cap);
    this.id = new Int32Array(cap).fill(0);
    this.genome = new Array(cap).fill(null);
    // Six personality traits per animal. This was allocated with one float per
    // animal, so every slot above capacity/6 read undefined: personality-driven
    // scores (hunting, patrol, flight) came out NaN and those actions never won.
    this.personality = new Float32Array(cap * P_TRAITS);
    this.generation = new Int32Array(cap);
    this.motherId = i32();
    this.fatherId = i32();
    this.offspringCount = new Int32Array(cap);
    this.birthDay = f32();
    this.ageDays = f32();
    this.stage = new Uint8Array(cap);
    this.size = f32();
    this.hunger = f32();
    this.thirst = f32();
    this.fatigue = f32();
    this.energy = f32();
    this.warmth = f32();
    this.health = f32();
    this.injury = f32();
    this.stress = f32();
    this.fear = f32();
    this.anorexia = f32();
    this.movementActivity = f32();
    this.pendingDeath = new Uint8Array(cap);
    this.knownCauseOfDeath = new Array(cap).fill(null);
    this.infection = new Uint8Array(cap);
    this.pathogen = new Uint8Array(cap);
    this.infectionDays = f32();
    this.immunity = f32();
    this.x = f32();
    this.y = f32();
    this.z = f32();
    this.heading = f32();
    this.speed = f32();
    this.prevX = f32();
    this.prevY = f32();
    this.prevHeading = f32();
    this.pursuitId = new Int32Array(cap).fill(-1);
    this.vx = f32();
    this.vy = f32();
    this.goalMinutes = f32();
    this.fleeTimer = f32();
    this.huntCooldown = f32();
    this.stalkProgress = f32();
    this.lastMealDay = f32();
    this.lastDrinkDay = f32();
    this.distanceTravelled = f32();
    this.killsTotal = new Int32Array(cap);
    this.mealsTotal = new Int32Array(cap);
    this.mealsFraction = f32();
    this.homeProp = new Int32Array(cap).fill(-1);
    this.dependence = f32();
    this.airborne = f32();
    this.reason = new Array(cap).fill(null);
    this.urgency = f32();
    this.deathCause = new Array(cap).fill(null);
    this.animPhase = f32();
    this.animSpeed = f32();
    this.animState = new Uint8Array(cap);
    this.inWater = new Uint8Array(cap);
    this.hiding = new Uint8Array(cap);
    this.sleeping = new Uint8Array(cap);
    this.flying = new Uint8Array(cap);
    this.action = new Uint8Array(cap);
    this.actionMinutes = f32();
    this.thinkTimer = f32();
    this.targetX = f32();
    this.targetY = f32();
    this.hasTarget = new Uint8Array(cap);
    this.goalKind = new Uint8Array(cap);
    this.goalId = i32();
    this.attackTimer = f32();
    this.lastMealHours = f32();
    this.lastDrinkHours = f32();
    this.lastSleepHours = f32();
    this.alerted = f32();
    this.alarmTimer = f32();
    this.callCooldown = f32();
    // Per-animal arrays with several entries each. These were allocated one
    // entry per animal, so memory and trail reads for most slots were undefined.
    this.memX = new Float32Array(cap * MEM_SLOTS);
    this.memY = new Float32Array(cap * MEM_SLOTS);
    this.memKind = new Uint8Array(cap * MEM_SLOTS);
    this.memStrength = new Float32Array(cap * MEM_SLOTS);
    this.memCursor = new Uint8Array(cap);
    this.homeX = f32();
    this.homeY = f32();
    this.homeKind = new Uint8Array(cap);
    this.hasHome = new Uint8Array(cap);
    this.denDay = f32();
    this.territoryX = f32();
    this.territoryY = f32();
    this.territoryR = f32();
    this.homeRangeDistance = f32();
    this.groupId = i32();
    this.groupRole = new Uint8Array(cap);
    this.leaderId = i32();
    this.pregnantLeft = f32();
    this.fetusCount = new Uint8Array(cap);
    this.mateId = i32();
    this.breedCooldown = f32();
    this.nursingMinutes = f32();
    this.dependentOf = i32();
    this.weaned = new Uint8Array(cap);
    this.litters = new Int32Array(cap);
    this.eggsLaid = new Int32Array(cap);
    this.pregnancyCount = new Int32Array(cap);
    this.trailX = new Float32Array(cap * TRAIL_POINTS);
    this.trailY = new Float32Array(cap * TRAIL_POINTS);
    this.trailAge = new Float32Array(cap * TRAIL_POINTS);
    this.trailCursor = new Uint8Array(cap);
    this.trailCount = new Uint8Array(cap);
    this.trailTimer = f32();
    for (let i = 0; i < cap; i++) this.freeSlots.push(cap - 1 - i);

    this.census = {
      count: new Int32Array(SPECIES.length),
      males: new Int32Array(SPECIES.length),
      females: new Int32Array(SPECIES.length),
      juveniles: new Int32Array(SPECIES.length),
      adults: new Int32Array(SPECIES.length),
      pregnant: new Int32Array(SPECIES.length),
      birthsToday: new Int32Array(SPECIES.length),
      deathsToday: new Int32Array(SPECIES.length),
      birthsThisYear: new Int32Array(SPECIES.length),
      deathsThisYear: new Int32Array(SPECIES.length),
      oldestDays: new Float32Array(SPECIES.length),
      youngestDays: new Float32Array(SPECIES.length).fill(Infinity),
      sumAgeDays: new Float32Array(SPECIES.length),
      sumHealth: new Float32Array(SPECIES.length),
      sumHunger: new Float32Array(SPECIES.length),
      sumEnergy: new Float32Array(SPECIES.length),
      sumSpeed: new Float32Array(SPECIES.length),
      meanAge: new Float32Array(SPECIES.length),
      meanHealth: new Float32Array(SPECIES.length),
      meanHunger: new Float32Array(SPECIES.length),
      meanEnergy: new Float32Array(SPECIES.length),
      generations: new Int32Array(SPECIES.length),
      groupMembers: new Int32Array(SPECIES.length),
      homeRanges: new Int32Array(SPECIES.length),
    };
    this.scratch = new Int32Array(cap);

    // Food web relations derived from the species table, so the encyclopedia,
    // the AI and any "who eats whom" display all agree.
    this.predatorsOf = SPECIES.map(() => []);
    this.preyOf = SPECIES.map(() => []);
    for (let s = 0; s < SPECIES.length; s++) {
      for (let o = 0; o < SPECIES.length; o++) {
        if (s === o) continue;
        if (SPECIES[o].preySpecies.includes(SPECIES[s].key)) {
          this.predatorsOf[s].push(o);
          this.preyOf[o].push(s);
        }
      }
    }
  }

  onDeath: ((slot: number, speciesIdx: number, cause: string) => void) | null = null;
  onBirth: ((motherSlot: number, fatherSlot: number, born: number[]) => void) | null = null;
  onPredation: ((predatorSlot: number, preySlot: number) => void) | null = null;
  onMeal: ((slot: number, kind: string, amount: number) => void) | null = null;

  /* ------------------------------------------------------------------ */
  /* Spawning & death                                                    */
  /* ------------------------------------------------------------------ */

  spawn(o: SpawnOptions): number {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return -1;
    const sp = SPECIES[o.speciesIdx];
    const rng = this.rng;
    this.alive[slot] = 1;
    this.speciesIdx[slot] = o.speciesIdx;
    this.sex[slot] = o.sex ?? (rng.chance(0.5) ? 0 : 1);
    this.id[slot] = this.nextId++;
    this.genome[slot] = o.genome ?? founderGenome(rng, sp);
    const base = slot * P_TRAITS;
    if (o.personality) {
      for (let p = 0; p < P_TRAITS; p++) this.personality[base + p] = o.personality[p];
    } else {
      this.personality[base + P.Aggression] = clamp01(rng.gauss() * 0.28 + (sp.drives.aggression ?? 0.4));
      this.personality[base + P.Boldness] = clamp01(rng.gauss() * 0.28 + 0.5);
      this.personality[base + P.Curiosity] = clamp01(rng.gauss() * 0.3 + (sp.drives.curiosity ?? 0.6));
      this.personality[base + P.Sociability] = clamp01(
        rng.gauss() * 0.25 + (sp.social === 'solitary' ? 0.25 : sp.social === 'pair' ? 0.5 : 0.78),
      );
      this.personality[base + P.Caution] = clamp01(rng.gauss() * 0.28 + 0.55);
      this.personality[base + P.Activity] = clamp01(rng.gauss() * 0.25 + 0.6);
    }
    this.generation[slot] = o.generation ?? 0;
    this.motherId[slot] = o.motherId ?? -1;
    this.fatherId[slot] = o.fatherId ?? -1;
    this.offspringCount[slot] = 0;
    const ageDays = o.ageDays ?? 0;
    this.ageDays[slot] = ageDays;
    this.birthDay[slot] = -ageDays + this.rng.next() * 0.001;
    this.size[slot] = 1;
    this.stage[slot] = stageFor(sp, ageDays);
    this.hunger[slot] = o.hunger ?? 0.22 + rng.next() * 0.18;
    this.thirst[slot] = o.thirst ?? 0.2 + rng.next() * 0.2;
    this.health[slot] = o.health ?? 0.92;
    this.fatigue[slot] = 0.3 + rng.next() * 0.2;
    this.energy[slot] = o.energy ?? (0.6 + rng.next() * 0.3);
    this.warmth[slot] = 0.85;
    this.injury[slot] = 0;
    this.stress[slot] = 0.15;
    this.fear[slot] = 0;
    this.anorexia[slot] = 0;
    this.movementActivity[slot] = 0.3;
    this.pendingDeath[slot] = 0;
    this.knownCauseOfDeath[slot] = null;
    this.infection[slot] = 0;
    this.pathogen[slot] = 0;
    this.infectionDays[slot] = 0;
    this.immunity[slot] = 0;
    this.x[slot] = o.x;
    this.y[slot] = o.y;
    this.z[slot] = 0;
    this.heading[slot] = rng.range(0, TAU);
    this.speed[slot] = 0;
    this.vx[slot] = 0;
    this.vy[slot] = 0;
    this.animPhase[slot] = rng.range(0, TAU);
    this.animSpeed[slot] = 0;
    this.animState[slot] = 0;
    this.inWater[slot] = sp.locomotion === 'fish' ? 1 : 0;
    this.hiding[slot] = 0;
    this.sleeping[slot] = 0;
    this.flying[slot] = sp.locomotion === 'bird' ? 1 : 0;
    this.action[slot] = Action.Idle;
    this.actionMinutes[slot] = 0;
    this.thinkTimer[slot] = rng.range(0, 1.5);
    this.targetX[slot] = o.x;
    this.targetY[slot] = o.y;
    this.hasTarget[slot] = 0;
    this.goalMinutes[slot] = 0;
    this.prevX[slot] = this.x[slot];
    this.prevY[slot] = this.y[slot];
    this.prevHeading[slot] = this.heading[slot];
    this.pursuitId[slot] = -1;
    this.pregnancyCount[slot] = 0;
    this.litters[slot] = 0;
    this.weaned[slot] = this.ageDays[slot] > sp.weaningDays ? 1 : 0;
    this.dependentOf[slot] = -1;
    this.fleeTimer[slot] = 0;
    this.huntCooldown[slot] = 0;
    this.stalkProgress[slot] = 0;
    this.lastMealDay[slot] = 0;
    this.lastDrinkDay[slot] = 0;
    this.distanceTravelled[slot] = 0;
    this.killsTotal[slot] = 0;
    this.mealsTotal[slot] = 0;
    this.homeProp[slot] = -1;
    this.dependence[slot] = 0;
    this.airborne[slot] = this.flying[slot] ? 1 : 0;
    this.reason[slot] = null;
    this.urgency[slot] = 0;
    this.deathCause[slot] = null;
    this.goalKind[slot] = 255;
    this.pregnantLeft[slot] = 0;
    this.fetusCount[slot] = 0;
    this.mateId[slot] = -1;
    this.breedCooldown[slot] = 0;
    this.nursingMinutes[slot] = 0;
    this.killsTotal[slot] = 0;
    this.goalId[slot] = -1;
    this.attackTimer[slot] = 0;
    this.lastMealHours[slot] = 0;
    this.lastDrinkHours[slot] = 0;
    this.lastSleepHours[slot] = 0;
    this.alerted[slot] = 0;
    this.alarmTimer[slot] = 0;
    this.callCooldown[slot] = 0;
    for (let m = 0; m < MEM_SLOTS; m++) {
      this.memKind[slot * MEM_SLOTS + m] = 255;
      this.memStrength[slot * MEM_SLOTS + m] = 0;
    }
    this.memCursor[slot] = 0;
    this.homeX[slot] = o.homeX ?? o.x;
    this.homeY[slot] = o.homeY ?? o.y;
    this.homeKind[slot] = o.homeKind ?? 0;
    this.hasHome[slot] = o.homeKind ? 1 : 0;
    this.denDay[slot] = 0;
    this.territoryX[slot] = o.x;
    this.territoryY[slot] = o.y;
    this.territoryR[slot] = sp.territoryRadius;
    this.homeRangeDistance[slot] = 0;
    this.groupId[slot] = o.groupId ?? -1;
    this.groupRole[slot] = 0;
    this.leaderId[slot] = -1;
    this.pregnantLeft[slot] = 0;
    this.fetusCount[slot] = 0;
    this.mateId[slot] = -1;
    this.breedCooldown[slot] = 0;
    this.nursingMinutes[slot] = 0;
    this.dependentOf[slot] = o.motherId ?? -1;
    this.weaned[slot] = ageDays > sp.maturityYears * TIME.daysPerYear * 0.5 ? 1 : 0;
    this.litters[slot] = 0;
    this.eggsLaid[slot] = 0;
    for (let t = 0; t < TRAIL_POINTS; t++) {
      this.trailX[slot * TRAIL_POINTS + t] = o.x;
      this.trailY[slot * TRAIL_POINTS + t] = o.y;
      this.trailAge[slot * TRAIL_POINTS + t] = 0;
    }
    this.trailCursor[slot] = 0;
    this.trailCount[slot] = 0;
    this.trailTimer[slot] = 0;
    this.count++;
    this.census.count[o.speciesIdx]++;
    if (o.motherId && o.motherId > 0) {
      const m = this.findByLivingId(o.motherId);
      if (m >= 0) this.childrenIds[m] = this.childrenIds[m] ?? [];
      if (m >= 0) this.childrenIds[m].push(this.id[slot]);
    }
    if (o.motherId && o.motherId > 0) {
      const father = o.fatherId && o.fatherId > 0 ? this.findByLivingId(o.fatherId) : -1;
      if (father >= 0) {
        this.childrenIds[father] = this.childrenIds[father] ?? [];
        this.childrenIds[father].push(this.id[slot]);
      }
    }
    return slot;
  }

  /** Mark an animal dead. The world handles carcasses, lineage and events. */
  kill(slot: number, cause: string): void {
    if (!this.alive[slot]) return;
    this.alive[slot] = 0;
    this.knownCauseOfDeath[slot] = cause;
    this.action[slot] = Action.Die;
    this.count = Math.max(0, this.count - 1);
    this.census.count[this.speciesIdx[slot]] = Math.max(0, this.census.count[this.speciesIdx[slot]] - 1);
    this.census.deathsThisYear[this.speciesIdx[slot]]++;
    this.onDeath?.(slot, this.speciesIdx[slot], cause);
    this.freeSlots.push(slot);
    this.genome[slot] = null;
    this.childrenIds[slot] = [];
  }

  /* ------------------------------------------------------------------ */
  /* Genetics & derived traits                                           */
  /* ------------------------------------------------------------------ */

  trait(slot: number, key: string): number {
    const g = this.genome[slot];
    return g ? g.get(key) : 1;
  }

  /** Body size relative to the species norm: genes plus a growth curve. */
  bodyScale(slot: number): number {
    const sp = SPECIES[this.speciesIdx[slot]];
    const grown = clamp01(this.ageDays[slot] / Math.max(1, sp.maturityYears * TIME.daysPerYear));
    const growth = 0.22 + 0.78 * Math.pow(grown, 0.65);
    return growth * this.trait(slot, 'size');
  }

  /** Kleiber-style metabolic rate: mass^0.75, adjusted by the metabolism gene. */
  metabolicRate(slot: number): number {
    const sp = SPECIES[this.speciesIdx[slot]];
    const mass = sp.massKg * Math.max(0.05, this.bodyScale(slot));
    return Math.pow(mass, 0.75) * this.trait(slot, 'metabolism');
  }

  /** Per-hour hunger increase. */
  hungerRate(slot: number): number {
    const sp = SPECIES[this.speciesIdx[slot]];
    const base = 1 / Math.max(2, sp.hungerHours);
    const activity = 0.75 + this.movementActivity[slot] * 0.9;
    const thermoreg = 0.8 + this.stress[slot] * 0.7;
    return base * activity * thermoreg;
  }

  diseaseResistance(slot: number): number {
    const gene = this.trait(slot, 'diseaseResistance');
    const ageFrac = clamp01(this.ageDays[slot] / Math.max(1, SPECIES[this.speciesIdx[slot]].maxAgeYears * TIME.daysPerYear));
    const age = 1 - Math.abs(ageFrac - 0.4) * 0.9;
    const condition = 0.6 + clamp01(this.energy[slot] * 0.6 + this.health[slot] * 0.4) * 0.6;
    return clamp01(gene * age * condition * 0.9);
  }

  personality_(slot: number, p: P): number {
    return this.personality[slot * P_TRAITS + p];
  }

  /** Heritable traits of one animal, as a plain object for the inspector. */
  traitTable(slot: number): { key: string; label: string; value: number; species: number; desc: string }[] {
    const g = this.genome[slot];
    if (!g) return [];
    return ANIMAL_TRAITS.map((t) => ({
      key: t.key,
      label: t.label,
      value: g.get(t.key),
      species: SPECIES[this.speciesIdx[slot]].baseTraits[t.key] ?? 1,
      desc: t.desc,
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Memory                                                              */
  /* ------------------------------------------------------------------ */

  remember(slot: number, kind: MemKind, x: number, y: number, strength = 1): void {
    // Overwrite the same kind of memory if it is close, else use the cursor.
    // Important places (water, the den) get their own protected slot so a busy
    // day cannot overwrite the drinking hole with five uneventful meals.
    const base = slot * MEM_SLOTS;
    let target = -1;
    if (kind === MemKind.Water || kind === MemKind.Den) {
      const reserved = kind === MemKind.Water ? 0 : 1;
      target = reserved;
      this.memKind[base + target] = kind;
      this.memX[base + target] = x;
      this.memY[base + target] = y;
      this.memStrength[base + target] = Math.max(strength, this.memStrength[base + target] * 0.9);
      return;
    }
    for (let m = 0; m < MEM_SLOTS; m++) {
      if (this.memKind[base + m] === kind) {
        const dx = this.memX[base + m] - x;
        const dy = this.memY[base + m] - y;
        if (dx * dx + dy * dy < 900) {
          target = m;
          break;
        }
      }
    }
    if (target < 0) {
      target = this.memCursor[slot] % MEM_SLOTS;
      this.memCursor[slot] = (this.memCursor[slot] + 1) % MEM_SLOTS;
    }
    this.memKind[base + target] = kind;
    this.memX[base + target] = x;
    this.memY[base + target] = y;
    this.memStrength[base + target] = strength;
  }

  /** Recall the strongest remembered place of a kind. */
  recall(slot: number, kind: MemKind, maxAge = Infinity): { x: number; y: number; strength: number } | null {
    const base = slot * MEM_SLOTS;
    let best = -1;
    let bestStrength = 0;
    for (let m = 0; m < MEM_SLOTS; m++) {
      if (this.memKind[base + m] !== kind) continue;
      const s = this.memStrength[base + m];
      if (s <= 0 || s > bestStrength) {
        bestStrength = s;
        best = m;
      }
    }
    if (best < 0) return null;
    void maxAge;
    return { x: this.memX[base + best], y: this.memY[base + best], strength: bestStrength };
  }

  forget(slot: number, kind: MemKind): void {
    const base = slot * MEM_SLOTS;
    for (let m = 0; m < MEM_SLOTS; m++) {
      if (this.memKind[base + m] === kind) this.memStrength[base + m] = 0;
    }
  }

  /** Age memories and trails. Called once per simulation step. */
  decayMemory(dtMinutes: number): void {
    const decay = dtMinutes / 60;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const base = i * MEM_SLOTS;
      for (let m = 0; m < MEM_SLOTS; m++) {
        const s = this.memStrength[base + m];
        if (s > 0) {
          // Water holes and kills are remembered longer than a meal.
          const kind = this.memKind[base + m];
          const rate = kind === MemKind.Water || kind === MemKind.Den ? 0.006 : 0.02;
          this.memStrength[base + m] = Math.max(0, s - rate * decay);
        }
      }
    }
  }

  /** Record a trail point for one animal (ring buffer, used by the tracking view). */
  recordTrail(slot: number, dtMinutes: number): void {
    this.trailTimer[slot] += dtMinutes;
    if (this.trailTimer[slot] < 6) return;
    this.trailTimer[slot] = 0;
    const cur = this.trailCursor[slot];
    this.trailX[slot * TRAIL_POINTS + cur] = this.x[slot];
    this.trailY[slot * TRAIL_POINTS + cur] = this.y[slot];
    this.trailAge[slot * TRAIL_POINTS + cur] = 0;
    this.trailCursor[slot] = (cur + 1) % TRAIL_POINTS;
    if (this.trailCount[slot] < TRAIL_POINTS) this.trailCount[slot]++;
  }

  /** Age every trail point in the world by one step. */
  ageTrails(dtMinutes: number): void {
    const step = dtMinutes / 60;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const base = i * TRAIL_POINTS;
      for (let t = 0; t < TRAIL_POINTS; t++) {
        const age = this.trailAge[base + t];
        if (age > 0) this.trailAge[base + t] = age + step;
      }
    }
  }

  /** Memories fade; weak ones are dropped so new places can be learned. */
  forgetWeakMemories(slot: number, dtMinutes: number): void {
    const hours = dtMinutes / 60;
    const base = slot * MEM_SLOTS;
    for (let m = 0; m < MEM_SLOTS; m++) {
      const strength = this.memStrength[base + m];
      if (strength <= 0) continue;
      const kind = this.memKind[base + m];
      // Water and den sites are worth remembering for a long time; a meal is not.
      const decay = kind === MemKind.Water || kind === MemKind.Den ? 0.006 : kind === MemKind.Cache ? 0.01 : 0.035;
      this.memStrength[base + m] = Math.max(0, strength - decay * hours);
      if (this.memStrength[base + m] <= 0.001) {
        this.memKind[base + m] = 255;
        this.memStrength[base + m] = 0;
      }
    }
  }

  /**
   * Movement goals: the tick engine sets a target and a patience timer, and
   * the movement code clears it when it is reached or has gone stale.
   */
  setTarget(slot: number, x: number, y: number, minutes = 30): void {
    this.targetX[slot] = clamp(x, -this.worldSize / 2 + 4, this.worldSize / 2 - 4);
    this.targetY[slot] = clamp(y, -this.worldSize / 2 + 4, this.worldSize / 2 - 4);
    this.hasTarget[slot] = 1;
    this.goalMinutes[slot] = minutes;
  }

  clearTarget(slot: number): void {
    this.hasTarget[slot] = 0;
    this.goalMinutes[slot] = 0;
  }

  /**
   * Snapshot position before a sim step so the renderer can interpolate. With a
   * slot it records just that animal (the per-individual step calls it); without
   * one it records the whole population.
   */
  savePrevious(slot = -1): void {
    if (slot >= 0) {
      this.prevX[slot] = this.x[slot];
      this.prevY[slot] = this.y[slot];
      this.prevHeading[slot] = this.heading[slot];
      return;
    }
    this.prevX.set(this.x);
    this.prevY.set(this.y);
    this.prevHeading.set(this.heading);
  }

  /** Advance a stage if the animal has grown into it. */
  updateStage(slot: number): void {
    const stage = stageFor(SPECIES[this.speciesIdx[slot]], this.ageDays[slot]);
    if (this.stage[slot] !== stage) {
      this.stage[slot] = stage;
      if (stage === Stage.Adult) this.homeRangeDistance[slot] = 0;
    }
  }

  /** How many animals are alive right now. */
  aliveCount(): number {
    return this.count;
  }

  /** Serialise every living animal. Genomes are stored as plain arrays. */
  save(): Record<string, unknown> {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      out.push({
        id: this.id[i],
        sp: this.speciesIdx[i],
        sex: this.sex[i],
        x: this.x[i],
        y: this.y[i],
        z: this.z[i],
        heading: this.heading[i],
        ageDays: this.ageDays[i],
        birthDay: this.birthDay[i],
        stage: this.stage[i],
        hunger: this.hunger[i],
        thirst: this.thirst[i],
        energy: this.energy[i],
        health: this.health[i],
        injury: this.injury[i],
        warmth: this.warmth[i],
        fear: this.fear[i],
        infection: this.infection[i],
        pathogen: this.pathogen[i],
        immunity: this.immunity[i],
        infectionDays: this.infectionDays[i],
        generation: this.generation[i],
        motherId: this.motherId[i],
        fatherId: this.fatherId[i],
        offspringCount: this.offspringCount[i],
        homeX: this.homeX[i],
        homeY: this.homeY[i],
        homeKind: this.homeKind[i],
        hasHome: this.hasHome[i],
        territoryX: this.territoryX[i],
        territoryY: this.territoryY[i],
        territoryR: this.territoryR[i],
        groupId: this.groupId[i],
        groupRole: this.groupRole[i],
        action: this.action[i],
        pregnantLeft: this.pregnantLeft[i],
        fetusCount: this.fetusCount[i],
        mateId: this.mateId[i],
        breedCooldown: this.breedCooldown[i],
        nursingMinutes: this.nursingMinutes[i],
        litters: this.litters[i],
        pregnancyCount: this.pregnancyCount[i],
        killsTotal: this.killsTotal[i],
        mealsTotal: this.mealsTotal[i],
        personality: Array.from(this.personality.subarray(i * P_TRAITS, i * P_TRAITS + P_TRAITS)),
        genome: this.genome[i] ? { values: Array.from(this.genome[i]!.values), generation: this.genome[i]!.generation } : null,
      });
    }
    return { nextId: this.nextId, birthsTotal: this.birthsTotal, animals: out };
  }

  /** Restore animals from a save. Ids are preserved so family trees survive. */
  load(d: Record<string, any>): void {
    const animals = (d.animals ?? []) as Record<string, any>[];
    this.reset();
    this.nextId = 1;
    for (const a of animals) {
      const slot = this.spawn({
        speciesIdx: a.sp,
        x: a.x,
        y: a.y,
        sex: a.sex,
        genome: a.genome ? new Genome(ANIMAL_TEMPLATE, Float32Array.from(a.genome.values as number[]), a.genome.generation ?? 1) : null,
        ageDays: a.ageDays,
        personality: a.personality ? Float32Array.from(a.personality as number[]) : undefined,
        generation: a.generation,
        motherId: a.motherId,
        fatherId: a.fatherId,
      });
      if (slot < 0) break;
      this.id[slot] = a.id;
      if (a.id >= this.nextId) this.nextId = a.id + 1;
      this.heading[slot] = a.heading ?? 0;
      this.z[slot] = a.z ?? 0;
      this.birthDay[slot] = a.birthDay ?? -a.ageDays;
      this.hunger[slot] = a.hunger ?? this.hunger[slot];
      this.thirst[slot] = a.thirst ?? this.thirst[slot];
      this.energy[slot] = a.energy ?? this.energy[slot];
      this.health[slot] = a.health ?? this.health[slot];
      this.injury[slot] = a.injury ?? 0;
      this.warmth[slot] = a.warmth ?? 0.85;
      this.fear[slot] = a.fear ?? 0;
      this.infection[slot] = a.infection ?? 0;
      this.pathogen[slot] = a.pathogen ?? 255;
      this.immunity[slot] = a.immunity ?? 0;
      this.infectionDays[slot] = a.infectionDays ?? 0;
      this.offspringCount[slot] = a.offspringCount ?? 0;
      this.homeX[slot] = a.homeX ?? 0;
      this.homeY[slot] = a.homeY ?? 0;
      this.homeKind[slot] = a.homeKind ?? 0;
      this.hasHome[slot] = a.hasHome ?? 0;
      this.territoryX[slot] = a.territoryX ?? 0;
      this.territoryY[slot] = a.territoryY ?? 0;
      this.territoryR[slot] = a.territoryR ?? 0;
      this.groupId[slot] = a.groupId ?? -1;
      this.groupRole[slot] = a.groupRole ?? 0;
      this.action[slot] = a.action ?? Action.Idle;
      this.pregnantLeft[slot] = a.pregnantLeft ?? 0;
      this.fetusCount[slot] = a.fetusCount ?? 0;
      this.mateId[slot] = a.mateId ?? -1;
      this.breedCooldown[slot] = a.breedCooldown ?? 0;
      this.nursingMinutes[slot] = a.nursingMinutes ?? 0;
      this.litters[slot] = a.litters ?? 0;
      this.pregnancyCount[slot] = a.pregnancyCount ?? 0;
      this.killsTotal[slot] = a.killsTotal ?? 0;
      this.mealsTotal[slot] = a.mealsTotal ?? 0;
      this.updateStage(slot);
      this.grid.insert(slot, this.x[slot], this.y[slot]);
    }
    this.birthsTotal = d.birthsTotal ?? 0;
    this.refreshCensus();
  }

  /** Empty the store (used before loading a save). */
  reset(): void {
    this.alive.fill(0);
    this.freeSlots.length = 0;
    this.count = 0;
    for (let i = this.capacity - 1; i >= 0; i--) this.freeSlots.push(i);
    for (let s = 0; s < SPECIES.length; s++) {
      this.census.count[s] = 0;
      this.census.males[s] = 0;
      this.census.females[s] = 0;
      this.census.juveniles[s] = 0;
      this.census.adults[s] = 0;
      this.census.pregnant[s] = 0;
      this.census.generations[s] = 0;
      this.census.groupMembers[s] = 0;
      this.census.homeRanges[s] = 0;
      this.census.oldestDays[s] = 0;
      this.census.youngestDays[s] = Infinity;
      this.census.sumAgeDays[s] = 0;
      this.census.sumHealth[s] = 0;
      this.census.sumHunger[s] = 0;
      this.census.sumEnergy[s] = 0;
      this.census.sumSpeed[s] = 0;
    }
    this.grid.clear();
  }

  /** Mean genome per species, for the evolution displays. */
  speciesGenomeMean(speciesIdx: number): Float32Array | null {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.speciesIdx[i] === speciesIdx) n++;
    }
    if (n === 0) return null;
    return this.meanGenome(speciesIdx);
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  species(slot: number): SpeciesDef {
    return SPECIES[this.speciesIdx[slot]];
  }

  findByLivingId(id: number): number {
    if (id <= 0) return -1;
    // Ids are handed out in order and the population is small, so a linear scan
    // with an early exit on the id range is the pragmatic choice here.
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.id[i] === id) return i;
    }
    return -1;
  }

  /** Living animals of a species within a radius (fills `out`, returns count). */
  querySpeciesNear(x: number, y: number, radius: number, speciesIdx: number, out: Int32Array): number {
    const n = this.grid.queryRadius(x, y, radius, out);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = out[i];
      if (this.alive[s] && this.speciesIdx[s] === speciesIdx) out[k++] = s;
    }
    return k;
  }

  queryAliveNear(x: number, y: number, radius: number, out: Int32Array): number {
    const n = this.grid.queryRadius(x, y, radius, out);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (this.alive[out[i]]) out[k++] = out[i];
    }
    return k;
  }

  /** Nearest living conspecific of the opposite sex that is ready to breed. */
  findMate(slot: number, radius: number): number {
    const sp = this.species(slot);
    const desiredSex = this.sex[slot] === 0 ? 1 : 0;
    const n = this.grid.queryRadius(this.x[slot], this.y[slot], radius, this.scratch);
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < n; i++) {
      const other = this.scratch[i];
      if (other === slot || !this.alive[other]) continue;
      if (this.speciesIdx[other] !== this.speciesIdx[slot]) continue;
      if (this.sex[other] !== desiredSex) continue;
      if (this.generation[other] > 0 && this.generation[slot] > 0 && this.areCloseKin(slot, other)) continue;
      if (this.health[other] < 0.35) continue;
      if (this.energy[other] < 0.35) continue;
      if (this.ageDays[other] < sp.maturityYears * TIME.daysPerYear) continue;
      if (this.pregnantLeft[other] > 0) continue;
      if (this.breedCooldown[other] > 0) continue;
      const d = (this.x[other] - this.x[slot]) ** 2 + (this.y[other] - this.y[slot]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  /** Simple inbreeding check: shared parent, or parent/child. */
  areCloseKin(a: number, b: number): boolean {
    if (this.motherId[a] > 0 && (this.motherId[a] === this.id[b] || this.motherId[a] === this.motherId[b])) return true;
    if (this.fatherId[a] > 0 && (this.fatherId[a] === this.id[b] || this.fatherId[a] === this.fatherId[b])) return true;
    if (this.motherId[b] > 0 && this.motherId[b] === this.id[a]) return true;
    if (this.fatherId[b] > 0 && this.fatherId[b] === this.id[a]) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Census                                                             */
  /* ------------------------------------------------------------------ */

  /** Recompute census values. Called on a cadence by the world, not per step. */
  refreshCensus(): void {
    const c = this.census;
    c.count.fill(0);
    c.males.fill(0);
    c.females.fill(0);
    c.juveniles.fill(0);
    c.adults.fill(0);
    c.pregnant.fill(0);
    c.oldestDays.fill(0);
    c.youngestDays.fill(Infinity);
    c.sumAgeDays.fill(0);
    c.sumHealth.fill(0);
    c.sumHunger.fill(0);
    c.sumEnergy.fill(0);
    c.sumSpeed.fill(0);
    c.generations.fill(0);
    c.groupMembers.fill(0);
    c.homeRanges.fill(0);
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const s = this.speciesIdx[i];
      c.count[s]++;
      if (this.sex[i] === 0) c.males[s]++;
      else c.females[s]++;
      if (this.stage[i] <= Stage.Subadult) c.juveniles[s]++;
      else c.adults[s]++;
      if (this.pregnantLeft[i] > 0) c.pregnant[s]++;
      c.oldestDays[s] = Math.max(c.oldestDays[s], this.ageDays[i]);
      c.youngestDays[s] = Math.min(c.youngestDays[s], this.ageDays[i]);
      c.sumAgeDays[s] += this.ageDays[i];
      c.sumHealth[s] += this.health[i];
      c.sumHunger[s] += this.hunger[i];
      c.sumEnergy[s] += this.energy[i];
      c.sumSpeed[s] += this.speed[i];
      c.generations[s] = Math.max(c.generations[s], this.generation[i]);
      if (this.hasHome[i]) c.homeRanges[s]++;
      if (this.groupId[i] >= 0) c.groupMembers[s]++;
    }
    for (let s = 0; s < SPECIES.length; s++) {
      const n = c.count[s];
      c.meanAge[s] = n ? c.sumAgeDays[s] / n / TIME.daysPerYear : 0;
      c.meanHealth[s] = n ? c.sumHealth[s] / n : 0;
      c.meanHunger[s] = n ? c.sumHunger[s] / n : 0;
      c.meanEnergy[s] = n ? c.sumEnergy[s] / n : 0;
      if (!isFinite(c.youngestDays[s])) c.youngestDays[s] = 0;
    }
  }

  /** Mean genome of a species, used for evolution displays and selection checks. */
  meanGenome(speciesIdx: number): Float32Array {
    const out = new Float32Array(ANIMAL_TEMPLATE.traits.length);
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i] || this.speciesIdx[i] !== speciesIdx) continue;
      const g = this.genome[i];
      if (!g) continue;
      for (let t = 0; t < out.length; t++) out[t] += g.values[t];
      n++;
    }
    if (n > 0) for (let t = 0; t < out.length; t++) out[t] /= n;
    return out;
  }

  /** Species-wide standard deviation per trait (for detecting real shifts). */
  traitSigma(speciesIdx: number, traitIndex: number, mean: number): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i] || this.speciesIdx[i] !== speciesIdx) continue;
      const g = this.genome[i];
      if (!g) continue;
      const d = g.values[traitIndex] - mean;
      sum += d * d;
      n++;
    }
    return n > 1 ? Math.sqrt(sum / (n - 1)) : 0;
  }

  /** Animals grouped by generation, for the evolution view. */
  generationHistogram(speciesIdx: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i] || this.speciesIdx[i] !== speciesIdx) continue;
      const g = this.generation[i];
      out[g] = (out[g] ?? 0) + 1;
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = 0;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Stepping                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Per-step bookkeeping for every animal: arousal, combat and call cooldowns,
   * anorexia recovery and the "time since" telemetry the inspector reads.
   * Growth, ageing and gestation are the AI's job — this pass only handles the
   * timers that must tick for all animals whatever they are doing.
   */
  tick(dtMinutes: number, day: number): void {
    const hours = dtMinutes / 60;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      // Arousal: an animal that was startled stays wary for a while, then
      // relaxes. This gates how easy it is to ambush.
      if (this.alerted[i] > 0) this.alerted[i] = Math.max(0, this.alerted[i] - hours);
      if (this.alarmTimer[i] > 0) this.alarmTimer[i] = Math.max(0, this.alarmTimer[i] - dtMinutes);
      if (this.callCooldown[i] > 0) this.callCooldown[i] = Math.max(0, this.callCooldown[i] - dtMinutes);
      if (this.attackTimer[i] > 0) this.attackTimer[i] = Math.max(0, this.attackTimer[i] - dtMinutes);
      this.lastMealHours[i] += hours;
      this.lastDrinkHours[i] += hours;
      this.lastSleepHours[i] += hours;
      if (this.sleeping[i]) {
        this.lastSleepHours[i] = 0;
        if (this.fatigue[i] <= 0.02) this.sleeping[i] = 0;
      }
      // Appetite comes back slowly after illness or a fright.
      if (this.anorexia[i] > 0) this.anorexia[i] = Math.max(0, this.anorexia[i] - hours * 0.05);
      void day;
    }
  }

  /** Ids of animals that died this step (for post-processing by the world). */
  collectDeaths(scratch: number[]): number[] {
    scratch.length = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.pendingDeath[i]) scratch.push(i);
    }
    return scratch;
  }

  scratchQuery(radius: number, x: number, y: number): Int32Array {
    const n = this.grid.queryRadius(x, y, radius, this.scratch);
    return this.scratch.subarray(0, n);
  }

  /** Living animals, as ids, nearest first to a point (for the UI). */
  nearestIds(x: number, y: number, count: number, maxDistance = 400): number[] {
    const n = this.grid.queryRadius(x, y, maxDistance, this.scratch);
    const scored: { id: number; d: number }[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.scratch[i];
      if (!this.alive[s]) continue;
      scored.push({ id: this.id[s], d: (this.x[s] - x) ** 2 + (this.y[s] - y) ** 2 });
    }
    scored.sort((a, b) => a.d - b.d);
    this.scratchIds = scored.slice(0, count).map((s) => s.id);
    return this.scratchIds;
  }
}

/** Which life stage an animal is in, given its species and age. */
export function stageFor(sp: SpeciesDef, ageDays: number): Stage {
  const maturity = sp.maturityYears * TIME.daysPerYear;
  const maxAge = sp.maxAgeYears * TIME.daysPerYear;
  if (ageDays < maturity * 0.45) return Stage.Juvenile;
  if (ageDays < maturity) return Stage.Subadult;
  if (ageDays > maxAge * 0.72) return Stage.Aged;
  return Stage.Adult;
}

/** Human-readable action label, used by the inspector and the documentary feed. */
export const ACTION_LABEL: Record<Action, string> = {
  [Action.Idle]: 'standing still',
  [Action.Wander]: 'wandering',
  [Action.Forage]: 'feeding',
  [Action.Hunt]: 'hunting',
  [Action.Scavenge]: 'scavenging',
  [Action.Drink]: 'drinking',
  [Action.Rest]: 'resting',
  [Action.Flee]: 'fleeing',
  [Action.Hide]: 'hiding',
  [Action.ReturnHome]: 'returning to its home',
  [Action.Court]: 'courting',
  [Action.Mate]: 'mating',
  [Action.Nurture]: 'caring for young',
  [Action.Patrol]: 'patrolling its territory',
  [Action.Socialize]: 'with its group',
  [Action.Migrate]: 'migrating',
  [Action.Bask]: 'thermoregulating',
  [Action.Investigate]: 'investigating',
  [Action.Cache]: 'caching food',
  [Action.Die]: 'dying',
};

export const MEM_LABEL: Record<MemKind, string> = {
  [MemKind.Water]: 'a water source',
  [MemKind.Food]: 'a food patch',
  [MemKind.Danger]: 'a place of danger',
  [MemKind.Mate]: 'a mate',
  [MemKind.Den]: 'a den site',
  [MemKind.Cache]: 'a food cache',
  [MemKind.Carcass]: 'a carcass',
  [MemKind.Kill]: 'a kill site',
};

export type { GeneticTrait };
type GeneticTrait = TraitDef;
export { ANIMAL_TEMPLATE, ANIMAL_TRAITS };

/**
 * A founding genome for a species: its template values, jittered a little so
 * the initial population already carries standing variation to select on.
 */
export function founderGenome(rng: Random, sp: SpeciesDef): Genome {
  const tpl = ANIMAL_TEMPLATE;
  const v = new Float32Array(tpl.traits.length);
  for (let i = 0; i < v.length; i++) {
    const t = tpl.traits[i];
    const centre = sp.baseTraits[t.key] ?? (t.lo + t.hi) / 2;
    v[i] = clamp(centre + rng.gauss() * 0.045 * (t.hi - t.lo), t.lo, t.hi);
  }
  return new Genome(tpl, v, 1);
}

/** Is this species breeding in the given season? */
export function inBreedingSeason(sp: SpeciesDef, seasonIndex: number): boolean {
  if (!sp.breedingSeasons.length) return true;
  return sp.breedingSeasons.includes(seasonIndex);
}

/**
 * How active a species is at this hour: 0 asleep, 1 fully active. Used for
 * roosting, baseline metabolism and how likely an animal is to notice things.
 */
export function activityFactor(sp: SpeciesDef, hour: number, nightVision: number): number {
  const dawn = Math.exp(-Math.pow((hour - 6.2) / 1.6, 2));
  const dusk = Math.exp(-Math.pow((hour - 19.0) / 1.8, 2));
  const midday = Math.exp(-Math.pow((hour - 13) / 5.5, 2));
  switch (sp.activity) {
    case 'diurnal':
      return clamp01(midday * 0.8 + dawn * 0.5 + dusk * 0.4 + 0.05);
    case 'nocturnal':
      return clamp01((1 - Math.max(midday, dawn * 0.7)) * 0.9 * (0.6 + nightVision * 0.4));
    case 'crepuscular':
      return clamp01(dawn * 0.9 + dusk * 0.9 + midday * 0.15);
    default:
      return clamp01(0.35 + midday * 0.4 + dawn * 0.2 + dusk * 0.2);
  }
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
}

export { lerp, clamp };
