import { clamp, clamp01, lerp, TAU, wrapAngle } from '../core/math';

/* Feeding conversion: how much food of each kind counts as one full meal. */
/** Vegetation field units removed per unit of feeding satisfaction. */
const FORAGE_PER_MEAL = 0.35;
/** Patch-prey biomass units consumed per unit of feeding satisfaction. */
const PATCH_PER_MEAL = 0.9;
/** Carcass kilograms consumed per unit of feeding satisfaction. */
const MEAT_PER_MEAL = 5;

/**
 * Where prey is: hunters with nothing in sight head for cover and water, the
 * places herbivores must visit. This is a habitat search, not omniscience —
 * the predator only learns what it sees once it gets there.
 */
const PREY_HABITAT_DIET = [1, 0.6, 0.25, 0.3, 0.2, 0.45];

/**
 * Feeding diagnostics: how much food of each kind the population has actually
 * eaten. Exposed so the debug overlay can show whether the world is feeding
 * itself — and so a starved animal can be traced to the food it never got.
 */
export const feedStats: {
  plants: number; insects: number; meat: number; carrion: number; fish: number;
  calls: number; denied: number; perSpecies: Record<string, number>;
  hunts: number; attacks: number; kills: number; sightings: number;
  pSum: number; attackPairs: Record<string, number>; cooldownDenied: number; cooldownSum: number; cooldownBySpecies: Record<string, number>; trace: string[]; ambush: number;
} = { plants: 0, insects: 0, meat: 0, carrion: 0, fish: 0, calls: 0, denied: 0, perSpecies: {}, hunts: 0, attacks: 0, kills: 0, sightings: 0, pSum: 0, attackPairs: {}, cooldownDenied: 0, cooldownSum: 0, cooldownBySpecies: {}, trace: [], ambush: 0 };
import { TIME } from '../core/config';
import { isWaterBiome } from '../world/biomes';
import { Action, GoalKind, MEM_SLOTS, MemKind, P, P_TRAITS, Stage, type Creatures } from './organism';
import { Genome } from './genome';
import { SPECIES, type SpeciesDef } from './species';
import type { World } from '../world/world';

export interface Perceived {
  threatSlot: number;
  threatDistance: number;
  preySlot: number;
  preyDistance: number;
  carcassSlot: number;
  carcassDistance: number;
  mateSlot: number;
  mateDistance: number;
  conspecifics: number;
  groupX: number;
  groupY: number;
  groupSize: number;
  intruderSlot: number;
  intruderDistance: number;
  waterX: number;
  waterY: number;
  hasWater: boolean;
  foodQuality: number;
  foodX: number;
  foodY: number;
  hasFood: boolean;
  shelterX: number;
  shelterY: number;
  hasShelter: boolean;
  aggregateX: number;
  aggregateY: number;
  aggregateAmount: number;
  temperature: number;
  cover: number;
  disturbance: number;
}

export function newPerceived(): Perceived {
  return {
    threatSlot: -1,
    threatDistance: Infinity,
    preySlot: -1,
    preyDistance: Infinity,
    carcassSlot: -1,
    carcassDistance: Infinity,
    mateSlot: -1,
    mateDistance: Infinity,
    conspecifics: 0,
    groupX: 0,
    groupY: 0,
    groupSize: 0,
    intruderSlot: -1,
    intruderDistance: Infinity,
    waterX: 0,
    waterY: 0,
    hasWater: false,
    foodQuality: 0,
    foodX: 0,
    foodY: 0,
    hasFood: false,
    shelterX: 0,
    shelterY: 0,
    hasShelter: false,
    aggregateX: 0,
    aggregateY: 0,
    aggregateAmount: 0,
    temperature: 15,
    cover: 0,
    disturbance: 0,
  };
}

export interface SocialGroup {
  id: number;
  speciesIdx: number;
  members: number[];
  leaderSlot: number;
  leaderId: number;
  centerX: number;
  centerY: number;
  /** Alarm level: 0 calm, 1 panicked. */
  alarm: number;
  alarmX: number;
  alarmY: number;
  /** Where the group is heading this season, if it migrates. */
  migrateX: number;
  migrateY: number;
  migrating: boolean;
  /** Kill site dropped by the group's hunters (draws scavengers). */
  killX: number;
  killY: number;
  killFreshness: number;
  territoryX: number;
  territoryY: number;
  territoryRadius: number;
  formedDay: number;
  /** Longest-lived member, used to name the group. */
  matriarchId: number;
}

/**
 * Social life: packs, herds, flocks and schools. A group is a real entity with
 * memory (where the last kill was, where they are migrating to) and an alarm
 * level that spreads — one deer bolting makes the whole herd nervous.
 */
export class SocialSystem {
  groups: SocialGroup[] = [];
  nextId = 1;
  onGroupFormed: ((g: SocialGroup) => void) | null = null;

  groupFor(creatures: Creatures, slot: number): SocialGroup | null {
    const gid = creatures.groupId[slot];
    if (gid < 0) return null;
    for (const g of this.groups) if (g.id === gid) return g;
    return null;
  }

  /** Add an animal to a group, or form one around it. */
  join(creatures: Creatures, slot: number, day: number): SocialGroup {
    const sp = SPECIES[creatures.speciesIdx[slot]];
    const existing = this.groupFor(creatures, slot);
    if (existing) return existing;
    // Find a nearby group of the same species with room.
    let best: SocialGroup | null = null;
    let bestD = 60 * 60;
    for (const g of this.groups) {
      if (g.speciesIdx !== creatures.speciesIdx[slot]) continue;
      if (g.members.length >= sp.groupSize[1]) continue;
      const d = (g.centerX - creatures.x[slot]) ** 2 + (g.centerY - creatures.y[slot]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    if (best) {
      best.members.push(slot);
      creatures.groupId[slot] = best.id;
      creatures.groupRole[slot] = 2;
      creatures.leaderId[slot] = best.leaderId;
      return best;
    }
    const group: SocialGroup = {
      id: this.nextId++,
      speciesIdx: creatures.speciesIdx[slot],
      members: [slot],
      leaderSlot: slot,
      leaderId: creatures.id[slot],
      centerX: creatures.x[slot],
      centerY: creatures.y[slot],
      alarm: 0,
      alarmX: 0,
      alarmY: 0,
      migrateX: creatures.x[slot],
      migrateY: creatures.y[slot],
      migrating: false,
      killX: 0,
      killY: 0,
      killFreshness: 0,
      territoryX: creatures.x[slot],
      territoryY: creatures.y[slot],
      territoryRadius: sp.territoryRadius,
      formedDay: day,
      matriarchId: creatures.id[slot],
    };
    creatures.groupId[slot] = group.id;
    creatures.groupRole[slot] = 1;
    creatures.leaderId[slot] = group.leaderId;
    this.groups.push(group);
    this.onGroupFormed?.(group);
    return group;
  }

  leave(creatures: Creatures, slot: number): void {
    const g = this.groupFor(creatures, slot);
    if (!g) return;
    const i = g.members.indexOf(slot);
    if (i >= 0) g.members.splice(i, 1);
    creatures.groupId[slot] = -1;
    creatures.groupRole[slot] = 0;
    if (g.members.length === 0) {
      const gi = this.groups.indexOf(g);
      if (gi >= 0) this.groups.splice(gi, 1);
    } else if (g.leaderSlot === slot) {
      g.leaderSlot = g.members[0];
      g.leaderId = creatures.id[g.members[0]];
    }
  }

  alarm(creatures: Creatures, slot: number, x: number, y: number, strength = 1): void {
    const g = this.groupFor(creatures, slot);
    if (!g) return;
    g.alarm = Math.min(1, g.alarm + strength);
    g.alarmX = x;
    g.alarmY = y;
  }

  recordKill(creatures: Creatures, slot: number): void {
    const g = this.groupFor(creatures, slot);
    if (!g) return;
    g.killX = creatures.x[slot];
    g.killY = creatures.y[slot];
    g.killFreshness = 1;
  }

  setMigration(creatures: Creatures, group: SocialGroup, x: number, y: number): void {
    group.migrateX = x;
    group.migrateY = y;
    group.migrating = true;
    for (const m of group.members) {
      if (creatures.alive[m]) {
        creatures.remember(m, MemKind.Food, x, y, 0.8);
      }
    }
  }

  /**
   * Maintain groups: merge stragglers, drop the dead, keep the centroid and
   * alarm current, and dissolve groups whose species does not actually live in
   * groups any more (e.g. after a population crash).
   */
  update(world: World, dtMinutes: number): void {
    const c = world.creatures;
    const hours = dtMinutes / 60;
    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      const sp = SPECIES[g.speciesIdx];
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (let i = g.members.length - 1; i >= 0; i--) {
        const slot = g.members[i];
        if (!c.alive[slot] || c.groupId[slot] !== g.id) {
          g.members.splice(i, 1);
          continue;
        }
        cx += c.x[slot];
        cy += c.y[slot];
        n++;
      }
      if (n === 0) {
        this.groups.splice(gi, 1);
        continue;
      }
      g.centerX = cx / n;
      g.centerY = cy / n;
      g.alarm = Math.max(0, g.alarm - hours * 0.35);
      g.killFreshness = Math.max(0, g.killFreshness - hours / 30);
      // Cap group size at the species maximum: excess members drift away.
      if (g.members.length > sp.groupSize[1]) {
        const excess = g.members.length - sp.groupSize[1];
        for (let k = 0; k < excess; k++) this.leave(c, g.members[g.members.length - 1 - k]);
      }
      // Nomadic species forget their migration target when they arrive.
      if (g.migrating) {
        const d = Math.hypot(g.migrateX - g.centerX, g.migrateY - g.centerY);
        if (d < 24) g.migrating = false;
      }
      // Territory follows the group.
      if (sp.territoryRadius > 0) {
        g.territoryX = lerp(g.territoryX, g.centerX, 0.02);
        g.territoryY = lerp(g.territoryY, g.centerY, 0.02);
        g.territoryRadius = sp.territoryRadius;
      }
      void dtMinutes;
    }
  }

  save(): unknown {
    return this.groups.map((g) => ({ ...g }));
  }

  load(data: unknown[]): void {
    this.groups = (data ?? []).map((g) => ({ ...(g as SocialGroup) })) as SocialGroup[];
    this.nextId = 1 + this.groups.reduce((m, g) => Math.max(m, g.id), 0);
  }
}

/* ------------------------------------------------------------------ */
/* Perception                                                          */
/* ------------------------------------------------------------------ */

/**
 * What this animal can actually detect, given its senses, the weather, the
 * light, cover, and how conspicuous the target is. Nothing here is
 * omniscient: detection is probabilistic and fails in fog, at distance, and
 * against still, camouflaged targets.
 */
export function perceive(world: World, slot: number, p: Perceived): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const x = c.x[slot];
  const y = c.y[slot];
  const temp = world.climate.temperatureAt(x, y);
  const night = world.clock.isNight;
  const vision = sp.visionRange * c.trait(slot, 'vision') * (night ? 0.25 + sp.nightVision * 0.85 : 1) * (1 - world.climate.fogAt(x, y) * 0.55);
  const smell = sp.smellRange * 1.35;
  const camouflage = c.trait(slot, 'camouflage');

  // Reset the scratchpad. Every field must be cleared here: the same object is
  // reused for every animal in the world, so a stale flag would become
  // telepathy — an animal "knowing" about a waterhole it has never seen.
  p.threatSlot = -1;
  p.threatDistance = Infinity;
  p.preySlot = -1;
  p.preyDistance = Infinity;
  p.carcassSlot = -1;
  p.carcassDistance = Infinity;
  p.mateSlot = -1;
  p.mateDistance = Infinity;
  p.conspecifics = 0;
  p.groupX = 0;
  p.groupY = 0;
  p.groupSize = 0;
  p.intruderSlot = -1;
  p.intruderDistance = Infinity;
  p.aggregateAmount = 0;
  p.aggregateX = 0;
  p.aggregateY = 0;
  p.waterX = x;
  p.waterY = y;
  p.hasWater = false;
  p.foodX = x;
  p.foodY = y;
  p.hasFood = false;
  p.foodQuality = 0;
  p.shelterX = x;
  p.shelterY = y;
  p.hasShelter = false;
  p.disturbance = 0;
  p.temperature = temp;
  p.cover = world.vegetation.coverAt(x, y);

  // --- nearby animals, in one spatial-hash pass.
  // Hunters can smell prey much further than they can see it: a wide-ranging
  // predator in a sparse world would otherwise never find anything to eat.
  const scentPrey = sp.dietKind === 'predator' || sp.dietKind === 'omnivore' || sp.dietKind === 'piscivore';
  const preySearch = scentPrey ? Math.max(vision, smell * 2.8) : vision;
  const n = c.grid.queryRadius(x, y, Math.max(vision, smell, preySearch), c.scratch);
  const group = world.social.groupFor(c, slot);
  for (let i = 0; i < n; i++) {
    const other = c.scratch[i];
    if (other === slot || !c.alive[other]) continue;
    const dx = c.x[other] - x;
    const dy = c.y[other] - y;
    const dist = Math.hypot(dx, dy);
    const otherSp = SPECIES[c.speciesIdx[other]];

    if (c.speciesIdx[other] === c.speciesIdx[slot]) {
      p.conspecifics++;
      if (group) {
        p.groupX += c.x[other];
        p.groupY += c.y[other];
        p.groupSize++;
      }
      // Territorial rivals are conspecifics: an animal defends its ground
      // against its own kind (and occasionally a close competitor), not against
      // every other species that happens to walk through it.
      if (
        sp.territoryDefence > 0 &&
        dist < c.territoryR[slot] &&
        !(c.hasHome[slot] === 1 && Math.hypot(c.homeX[other] - c.homeX[slot], c.homeY[other] - c.homeY[slot]) < 4) &&
        (group === null || c.groupId[other] !== group.id)
      ) {
        if (dist < p.intruderDistance) {
          p.intruderSlot = other;
          p.intruderDistance = dist;
        }
      }
      // Courtship and territorial rivals both come from conspecifics.
      if (c.sex[other] !== c.sex[slot] && canBreed(world, other) && dist < vision && dist < p.mateDistance && !c.areCloseKin(slot, other)) {
        p.mateSlot = other;
        p.mateDistance = dist;
      }
      continue;
    }

    // Threat: something that hunts my species.
    if (c.predatorsOf[c.speciesIdx[slot]].includes(c.speciesIdx[other])) {
      const detect = detectionChance(world, slot, other, dist, vision, 1.1);
      if (detect > 0.28 && dist < p.threatDistance) {
        // A predator that is already hunting is easier to notice.
        const hunting = c.action[other] === Action.Hunt ? 1.25 : 1;
        if (world.rng.chance(clamp01(detect * hunting))) {
          p.threatSlot = other;
          p.threatDistance = dist;
        }
      }
      continue;
    }

    // Prey: something my species hunts.
    if (sp.preySpecies.includes(otherSp.key)) {
      const sizeOk = otherSp.massKg >= sp.preyMass[0] * 0.6 && otherSp.massKg <= sp.preyMass[1];
      if (sizeOk && dist < p.preyDistance && dist < preySearch) {
        // Sight first; beyond that, a scent trail weakened by distance, wind
        // and the prey's own camouflage. Scent gives a quarry, not telepathy.
        const sighted = detectionChance(world, slot, other, dist, vision, 1) > 0.3;
        const scentRange = Math.max(vision, smell * 2.8);
        const falloff = clamp01(1 - dist / scentRange);
        const wind = 0.6 + world.climate.windSpeed * 0.25;
        const trail = sighted ? 1 : falloff * falloff * wind * (1 - clamp01(c.trait(other, 'camouflage')) * 0.45);
        if (trail > 0.16 && world.rng.chance(clamp01(trail))) {
          p.preySlot = other;
          p.preyDistance = dist;
        }
      }
      continue;
    }


  }
  if (p.groupSize > 0) {
    p.groupX /= p.groupSize;
    p.groupY /= p.groupSize;
  }

  // --- corpses: smell travels much further than sight
  const carcassRange = Math.max(smell * 1.5, 40);
  const carcass = world.carcasses.nearest(x, y, carcassRange);
  if (carcass) {
    const d = Math.hypot(carcass.x - x, carcass.y - y);
    const smellStrength = clamp01(carcass.massKg / 25) * (1 - d / carcassRange);
    if ((sp.scavenges || sp.dietKind === 'predator' || sp.dietKind === 'omnivore') && smellStrength > 0.12) {
      p.carcassSlot = carcass.id;
      p.carcassDistance = d;
    } else if (d < vision * 0.7) {
      p.carcassSlot = carcass.id;
      p.carcassDistance = d;
    }
  }

  // --- water: from memory first, then by searching
  const waterMemory = c.recall(slot, MemKind.Water);
  if (waterMemory && waterMemory.strength > 0.12) {
    p.waterX = waterMemory.x;
    p.waterY = waterMemory.y;
    p.hasWater = true;
  } else if (sp.locomotion !== 'fish') {
    const water = world.findWater(x, y);
    if (water) {
      p.waterX = water.x;
      p.waterY = water.y;
      p.hasWater = true;
      c.remember(slot, MemKind.Water, water.x, water.y, 1);
    }
  } else {
    p.waterX = x;
    p.waterY = y;
    p.hasWater = true;
  }

  // --- food: vegetation for herbivores, patches for insectivores
  let bestFood = 0;
  const foodMemory = c.recall(slot, MemKind.Food);
  const here = world.vegetation.forageAt(x, y, sp.plantDiet);
  if (here.amount > bestFood) {
    bestFood = here.amount;
    p.foodX = x;
    p.foodY = y;
    p.hasFood = here.amount > 0.08;
  }
  if (foodMemory && foodMemory.strength > 0.25) {
    const d = Math.hypot(foodMemory.x - x, foodMemory.y - y);
    const quality = world.vegetation.forageAt(foodMemory.x, foodMemory.y, sp.plantDiet).amount * (1 - clamp01(d / 220) * 0.4);
    if (quality > bestFood * 0.8) {
      bestFood = quality;
      p.foodX = foodMemory.x;
      p.foodY = foodMemory.y;
      p.hasFood = quality > 0.06;
    }
  }
  if (sp.plantDiet.some((v) => v > 0.05) && (!p.hasFood || bestFood < 0.25)) {
    const sample = bestPatchNear(world, x, y, 90, sp.plantDiet);
    if (sample && sample.amount > bestFood) {
      bestFood = sample.amount;
      p.foodX = sample.x;
      p.foodY = sample.y;
      p.hasFood = true;
    }
  }
  p.foodQuality = bestFood;

  // --- aggregate prey (mice, insects, plankton): a rich patch nearby
  if (sp.aggregatePrey.length && sp.locomotion !== 'fish') {
    let bestKey: string | null = null;
    let bestAmount = 0;
    for (const key of sp.aggregatePrey) {
      const amount = world.aggregates.availableAt(key, x, y);
      if (amount > bestAmount) {
        bestAmount = amount;
        bestKey = key;
      }
    }
    if (bestKey && bestAmount > 0.05) {
      const patch = world.aggregates.bestPatchNear(bestKey, x, y, 70);
      if (patch) {
        p.aggregateX = patch.x;
        p.aggregateY = patch.y;
        p.aggregateAmount = patch.amount;
      } else if (bestAmount > 0.2) {
        p.aggregateX = x;
        p.aggregateY = y;
        p.aggregateAmount = bestAmount;
      }
    }
  }

  // --- shelter: den, nest, cave or dense cover
  if (c.hasHome[slot]) {
    const d = Math.hypot(c.homeX[slot] - x, c.homeY[slot] - y);
    if (d < 260) {
      p.shelterX = c.homeX[slot];
      p.shelterY = c.homeY[slot];
      p.hasShelter = true;
    }
  }
  if (!p.hasShelter && (sp.shelter === 'roost' || sp.shelter === 'den' || sp.shelter === 'burrow')) {
    const dense = world.findCover(x, y);
    if (dense) {
      p.shelterX = dense.x;
      p.shelterY = dense.y;
      p.hasShelter = true;
    }
  }

  // --- the player is a real presence in the world
  const presence = world.playerPresence;
  if (presence) {
    const d = Math.hypot(presence.x - x, presence.y - y);
    p.disturbance = clamp01(1 - d / ((presence.intensity ?? 1) * 60)) * clamp01(1 - c.personality_(slot, P.Boldness) * 0.7);
  } else {
    p.disturbance = 0;
  }
  void camouflage;
}

/** Probability that `observer` notices `target` at a distance. */
function detectionChance(world: World, observer: number, target: number, dist: number, vision: number, salience: number): number {
  const c = world.creatures;
  if (dist > vision) {
    // Beyond vision, smell and hearing still work for close-range detection.
    const smellRange = SPECIES[c.speciesIdx[observer]].smellRange * 1.4;
    if (dist > smellRange) return 0;
    return clamp01(1 - dist / smellRange) * 0.4;
  }
  const targetSp = SPECIES[c.speciesIdx[target]];
  const camouflage = c.trait(target, 'camouflage');
  const cover = world.vegetation.coverAt(c.x[target], c.y[target]);
  const motion = clamp01(c.speed[target] / Math.max(1, targetSp.runSpeed) + 0.15);
  const size = clamp01(targetSp.bodyLength / 2.2);
  const crouching = c.hiding[target] ? 0.45 : 1;
  const base = (1 - dist / vision) ** 1.35;
  return clamp01(base * (0.5 + motion * 0.9) * (0.6 + size * 0.7) * crouching * (1.25 - camouflage * 0.45) * (1 - cover * 0.35) * salience);
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

/** Can this animal breed right now? (used by perception and by decisions) */
export function canBreed(world: World, slot: number): boolean {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  if (c.ageDays[slot] < sp.maturityYears * TIME.daysPerYear) return false;
  if (c.sex[slot] === 1 && c.pregnantLeft[slot] > 0) return false;
  if (c.breedCooldown[slot] > 0) return false;
  if (c.health[slot] < 0.4 || c.energy[slot] < 0.4) return false;
  if (sp.breedingSeasons.length && !sp.breedingSeasons.includes(world.clock.seasonIndex)) return false;
  return true;
}

interface Scores {
  [key: number]: number;
}

/** Utility AI: score every action, take the best, with a little hysteresis. */
export function decide(world: World, slot: number, p: Perceived): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const d = sp.drives;
  const hunger = c.hunger[slot];
  const thirst = c.thirst[slot];
  const fatigue = c.fatigue[slot];
  const energy = c.energy[slot];
  const boldness = c.personality_(slot, P.Boldness);
  const caution = c.personality_(slot, P.Caution);
  const curiosity = c.personality_(slot, P.Curiosity);
  const sociability = c.personality_(slot, P.Sociability);
  const aggression = c.personality_(slot, P.Aggression) * 0.5 + c.trait(slot, 'aggression') * 0.5;
  const scores: Scores = {};
  const urgency = clamp01(Math.max(c.hunger[slot], c.thirst[slot], c.fatigue[slot]));

  // --- Flee: the strongest drive in the game when a predator is close.
  if (p.threatSlot >= 0) {
    const close = clamp01(1 - p.threatDistance / (sp.visionRange + 10));
    const threat = SPECIES[c.speciesIdx[p.threatSlot]];
    // Prey that can fight (bison, bear) may stand instead of run.
    const defiance = threat.massKg > sp.massKg * 1.6 && sp.massKg > 300 && aggression > 0.6 && c.health[slot] > 0.7 ? 0.35 : 0;
    scores[Action.Flee] = (0.7 + d.fear * 0.5 + close * 1.2) * (1 + caution * 0.5) * (1 - boldness * 0.35) * (1 - defiance);
    if ((sp.shelter === 'burrow' || sp.shelter === 'den') && p.hasShelter) {
      scores[Action.Hide] = (0.65 + d.fear * 0.4 + close) * (0.8 + caution * 0.4) * (1 - boldness * 0.2);
    }
  }

  // --- Feeding.
  const appetite = 1 - c.anorexia[slot];
  const foodDrive = d.hungerWeight * (hunger * hunger) * 4.5 * appetite * (0.6 + (1 - energy) * 0.8);
  if (sp.dietKind === 'predator' || sp.dietKind === 'omnivore' || sp.dietKind === 'piscivore') {
    let hunt = 0;
    if (p.preySlot >= 0) {
      feedStats.sightings++;
      const targetSp = SPECIES[c.speciesIdx[p.preySlot]];
      const sizePenalty = clamp01((targetSp.massKg / Math.max(1, sp.massKg * (sp.groupHunter ? 4 : 1.6))) ** 1.2);
      const packBonus = sp.groupHunter ? clamp01(1 + p.groupSize * 0.16) : 1;
      const approach = clamp01(1 - p.preyDistance / (sp.visionRange * 1.2));
      hunt = foodDrive * (0.55 + approach * 0.7) * packBonus * (1 - sizePenalty * 0.85) * (0.65 + aggression * 0.7);
      if (sp.activity === 'nocturnal' && !world.clock.isNight) hunt *= 0.45;
      if (sp.locomotion === 'bird' && !world.clock.isNight && world.climate.windSpeed > 6) hunt *= 1.1;
    }
    if (p.aggregateAmount > 0.12) {
      const patch = foodDrive * clamp01(p.aggregateAmount * 1.8) * 0.75;
      hunt = Math.max(hunt, patch);
    }
    if (sp.locomotion === 'fish') {
      const plankton = world.aggregates.availableAt('plankton', c.x[slot], c.y[slot]);
      hunt = Math.max(hunt, foodDrive * clamp01(plankton * 2.5) * 1.1);
    }
    // A hunter that can see nothing still hunts: it works the habitat where
    // prey must be. Without this predators patrol empty ground until they die.
    if (hunt < 0.02 && hunger > 0.3 && sp.locomotion !== 'fish') hunt = foodDrive * 0.85;
    // A hunter on a scent or a trail commits to it instead of re-deciding
    // every couple of minutes and losing the animal.
    if (hunt > 0.05 && hunger > 0.45) hunt += 0.35;
    scores[Action.Hunt] = hunt;
  } else if (p.hasFood) {
    scores[Action.Forage] = foodDrive * (0.5 + clamp01(p.foodQuality * 1.6) * 1.2);
  } else {
    // Nothing found yet: searching is still worthwhile when hungry.
    scores[Action.Forage] = foodDrive * 0.35;
  }
  if (sp.scavenges) {
    if (p.carcassSlot >= 0) {
      const richness = clamp01(1 - p.carcassDistance / (sp.smellRange * 1.6));
      scores[Action.Scavenge] = foodDrive * (0.7 + richness * 0.9) + 0.25 * (1 - hunger);
    } else if (hunger > 0.3 && world.carcasses.nearest(c.x[slot], c.y[slot], sp.smellRange) !== null) {
      // Carrion carries on the wind: no sight required.
      scores[Action.Scavenge] = foodDrive * 0.6;
    }
  }

  // --- Drinking. Thirst outranks hunger: an animal dies of dehydration in
  // days, and in life the drive to drink takes precedence over feeding. A
  // starving animal standing at a waterhole must drink, not graze until it dies.
  if (!sp.waterIndependent) {
    const need = Math.pow(thirst, 1.4) * 14 * (0.8 + clamp01(p.temperature / 30) * 0.6);
    if (p.hasWater) scores[Action.Drink] = need;
  }

  // --- Rest.
  const night = world.clock.isNight;
  const active = sp.activity === 'nocturnal' ? night : sp.activity === 'diurnal' ? !night : true;
  let rest = fatigue * fatigue * 2.6 * (0.7 + d.thermoregulation * 0.2);
  if (!active && sp.activity !== 'cathemeral') rest += 1.4;
  if (c.stage[slot] === Stage.Juvenile) rest += 0.35;
  if (c.infection[slot] === 1) rest += 1.1;
  if (c.pregnantLeft[slot] > 0) rest += 0.3;
  scores[Action.Rest] = rest * (1 - clamp01(c.fear[slot]) * 0.7);

  // --- Return home / nurture.
  const mother = c.motherId[slot];
  const hasYoung = c.offspringCount[slot] > 0 && c.nursingMinutes[slot] > 0;
  if (c.hasHome[slot] && (hasYoung || (sp.nestRequired && c.pregnantLeft[slot] > 0))) {
    const dHome = Math.hypot(c.homeX[slot] - c.x[slot], c.homeY[slot] - c.y[slot]);
    const drive = (hasYoung ? 1.5 + d.parenting * 0.6 : 0.7) * (dHome > 20 ? 1 : 1.45);
    scores[Action.ReturnHome] = drive;
    scores[Action.Nurture] = dHome < 26 ? 1.2 + d.parenting * 0.8 : 0;
  }
  void mother;

  // --- Breeding. Mates are found by sight at close range, but also by scent
  // and call over a much wider area (the rut, the lek, the dawn chorus).
  if (canBreed(world, slot)) {
    const condition = clamp01(energy * 0.6 + c.health[slot] * 0.4);
    const drive = (0.5 + d.socialWeight * 0.5) * (0.4 + condition) * clamp01(1 - hunger * 0.6) * 1.6;
    let mate = p.mateSlot;
    if (mate < 0 && p.conspecifics === 0 && hunger < 0.55) {
      mate = c.findMate(slot, 420);
      if (mate >= 0) {
        p.mateSlot = mate;
        p.mateDistance = Math.hypot(c.x[mate] - c.x[slot], c.y[mate] - c.y[slot]);
      }
    }
    if (mate >= 0) {
      // Breeding is worth interrupting anything short of starving or fleeing.
      const desperation = p.threatSlot < 0 ? 1 : 0.25;
      scores[Action.Court] = drive * desperation;
      scores[Action.Mate] = p.mateDistance < 6 ? drive * 1.5 : 0;
    }
  }

  // --- Social life.
  if (sociability > 0.25 && p.conspecifics > 0) {
    const loner = sp.social === 'solitary' ? 0.35 : 1;
    scores[Action.Socialize] = sociability * d.socialWeight * (p.groupSize < sp.groupSize[0] ? 1.2 : 0.5) * loner * (1 - hunger * 0.5);
  }
  if (sp.groupSize[1] > 1 && p.conspecifics > 0 && c.groupId[slot] < 0 && sociability > 0.3) {
    scores[Action.Socialize] = Math.max(scores[Action.Socialize] ?? 0, 1.1 * sociability);
  }

  // --- Territory defence.
  if (sp.territoryDefence > 0) {
    if (p.intruderSlot >= 0) {
      scores[Action.Patrol] = (0.8 + aggression * 0.8 + d.territorial * 0.6) * (1 - clamp01(p.intruderDistance / 120) * 0.5);
    } else {
      const t = world.social.groupFor(c, slot);
      const dT = t ? Math.hypot(c.x[slot] - t.territoryX, c.y[slot] - t.territoryY) : 0;
      // Walking the boundary is what a fed animal does; a hungry one hunts.
      const fed = 1 - clamp01((hunger - 0.35) * 1.6);
      scores[Action.Patrol] = d.territorial * 0.3 * fed * (t && dT > t.territoryRadius ? 0.5 : 1);
    }
  }

  // --- Thermoregulation: seek sun when cold, shade/water when hot.
  const comfortMid = (sp.tempComfort[0] + sp.tempComfort[1]) / 2;
  const range = Math.max(6, (sp.tempComfort[1] - sp.tempComfort[0]) * (0.6 + c.trait(slot, 'tempTolerance')));
  const tempStress = clamp01((Math.abs(p.temperature - comfortMid) - range * 0.5) / range) * d.thermoregulation * (1 - c.warmth[slot]);
  // Sunning yourself only makes sense out of the water.
  if (tempStress > 0.25 && sp.locomotion !== 'fish' && sp.shelter !== 'shoal') scores[Action.Bask] = tempStress * 1.5;

  // --- Migration: seasonal movement for herd species, or when the range dries out.
  if (sp.social === 'herd' || sp.social === 'flock' || sp.social === 'school' || sp.social === 'pack') {
    const group = world.social.groupFor(c, slot);
    if (group?.migrating) scores[Action.Migrate] = 1.5 * (1 - clamp01((hunger - 0.45) * 1.6));
    else if (hunger > 0.6 && p.foodQuality < 0.1) scores[Action.Migrate] = 0.9 * d.hungerWeight;
  }
  // Spawning runs matter, but a starving fish feeds first.
  const fishFeed = 1 - clamp01((hunger - 0.35) * 2);
  if (sp.locomotion === 'fish' && world.clock.seasonIndex === 0 && canBreed(world, slot)) {
    scores[Action.Migrate] = 1.1 * fishFeed;
  }

  // --- Curiosity: investigate kills, fires, and the observer.
  if (curiosity > 0.3) {
    let interesting = 0;
    if (p.carcassSlot >= 0) interesting += 0.5;
    if (p.disturbance > 0.3) interesting += p.disturbance * 0.9;
    const fire = world.fire.heat.sample(world.terrain.worldToCellX(c.x[slot]), world.terrain.worldToCellY(c.y[slot]));
    if (fire > 0.4) interesting -= fire * 1.5;
    if (interesting > 0) {
      scores[Action.Investigate] = clamp01(interesting + curiosity * 0.4) * (1 - clamp01(c.fear[slot])) * (1 - clamp01(hunger * 0.7));
    }
  }

  // --- Caching for species that do it.
  if (sp.caches && hunger < 0.25 && energy > 0.7 && c.action[slot] !== Action.Cache) {
    scores[Action.Cache] = 0.25;
  }

  // --- Hiding when hurt or sick.
  if ((c.health[slot] < 0.5 || c.injury[slot] > 0.3 || c.infection[slot] === 1) && p.hasShelter) {
    scores[Action.Hide] = (0.5 + (1 - c.health[slot]) * 1.2) * caution;
  }

  // Fish out of water can only swim, feed, flee or spawn in the shallows:
  // everything that belongs on land is closed to them, and finding water again
  // is the most urgent thing in their lives.
  if (sp.locomotion === 'fish' || sp.shelter === 'shoal') {
    const depth = world.terrain.waterAtWorld(c.x[slot], c.y[slot]);
    if (depth < 0.15) {
      const stranded = 1 + clamp01(0.15 - depth) * 6;
      for (const key of Object.keys(scores)) {
        const a = Number(key) as Action;
        if (a === Action.Hunt || a === Action.Wander || a === Action.Migrate || a === Action.Flee || a === Action.Idle) continue;
        delete scores[a];
      }
      // A fed fish in a drying puddle looks for deeper water; a hungry one
      // filters what it can right where it is.
      const hungryHere = hunger > 0.4;
      scores[Action.Hunt] = Math.max(scores[Action.Hunt] ?? 0, (hungryHere ? 1.2 : 0.3) * stranded);
      scores[Action.Wander] = (hungryHere ? 0.6 : 1.6) * stranded;
    }
  }

  // --- Default: wander.
  scores[Action.Wander] = 0.28 + c.personality_(slot, P.Activity) * 0.32;
  scores[Action.Idle] = 0.12;

  // Hysteresis: staying on the current action is slightly cheaper, which keeps
  // animals from dithering between two nearly equal options.
  const current = c.action[slot] as Action;
  if (scores[current] !== undefined) scores[current] = (scores[current] as number) * 1.16;

  let bestAction = Action.Wander;
  let bestScore = -Infinity;
  for (const key of Object.keys(scores)) {
    const value = scores[Number(key)];
    // Personality noise so two identical animals do not behave identically.
    const jitter = 1 + (world.rng.next() - 0.5) * 0.14;
    const v = (value as number) * jitter;
    if (v > bestScore) {
      bestScore = v;
      bestAction = Number(key) as Action;
    }
  }

  if (bestAction !== c.action[slot]) {
    c.action[slot] = bestAction;
    c.actionMinutes[slot] = 0;
    c.hasTarget[slot] = 0;
  }
  c.thinkTimer[slot] = 0.5 + world.rng.next() * 1.6 + (1 - clamp01(urgency)) * 0.6;
  c.animState[slot] = bestAction;
}

/* ------------------------------------------------------------------ */
/* Action execution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Carry out the current action for this step: drive the legs, eat, hunt, mate,
 * sleep. Steering is deliberately simple and physical — the intelligence is in
 * the choice of action, not in pathfinding.
 */
export function act(world: World, slot: number, dt: number): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const action = c.action[slot] as Action;
  const x = c.x[slot];
  const y = c.y[slot];
  let desiredSpeed = 0;
  let targetX = c.targetX[slot];
  let targetY = c.targetY[slot];
  let hasTarget = c.hasTarget[slot] === 1;

  const walk = speedFor(world, slot, false);
  const run = speedFor(world, slot, true);

  switch (action) {
    case Action.Idle:
      desiredSpeed = 0;
      break;
    case Action.Wander:
      if (!hasTarget || Math.hypot(targetX - x, targetY - y) < 6) {
        const angle = world.rng.range(0, TAU);
        const radius = world.rng.range(20, 140) * (sp.social === 'solitary' ? 1.2 : 0.7);
        targetX = clamp(x + Math.cos(angle) * radius, -world.terrain.half * 0.94, world.terrain.half * 0.94);
        targetY = clamp(y + Math.sin(angle) * radius, -world.terrain.half * 0.94, world.terrain.half * 0.94);
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
      }
      desiredSpeed = walk * 0.55;
      // Grazers crop as they walk. A herbivore does not stop living while it
      // travels to better pasture, and a simulation in which it does will
      // starve its herds on ground that is green underfoot.
      if (sp.plantDiet.length) {
        const here = world.vegetation.forageAt(x, y, sp.plantDiet);
        if (here.amount > 0.01) {
          const taken = world.vegetation.consume(x, y, sp.plantDiet, plantIntakePerMinute(world, slot) * dt * 0.45);
          if (taken > 0) {
            applyFood(world, slot, (taken / FORAGE_PER_MEAL) * clamp(sp.plantNutrition * here.quality + 0.25, 0.3, 1.3), 'plants');
            world.vegetation.recordGraze(x, y, taken);
          }
        }
      }
      // Filter feeders eat as they swim: plankton is not something a fish
      // stops for, it is something it moves through.
      if (sp.locomotion === 'fish' || sp.shelter === 'shoal') {
        const filtered = world.aggregates.consume('plankton', x, y, intakePerMinute(world, slot) * dt * 0.55);
        const picked = world.aggregates.consume('insect', x, y, intakePerMinute(world, slot) * dt * 0.35);
        if (filtered > 0) applyFood(world, slot, (filtered / PATCH_PER_MEAL) * sp.meatNutrition, 'fish');
        if (picked > 0) applyFood(world, slot, (picked / PATCH_PER_MEAL) * sp.meatNutrition, 'insects');
      }
      // Most herbivores graze on the move, so wandering is never a total loss.
      if (sp.plantDiet.some((v) => v > 0.05)) {
        const taken = world.vegetation.consume(x, y, sp.plantDiet, plantIntakePerMinute(world, slot) * dt * 0.5);
        if (taken > 0) {
          applyFood(world, slot, (taken / FORAGE_PER_MEAL) * clamp(sp.plantNutrition + 0.2, 0.4, 1.2), 'plants');
          world.vegetation.recordGraze(x, y, taken);
        }
      }
      break;
    case Action.Forage: {
      // Eat what is underfoot first: grazing animals do not walk past food.
      const forage = world.vegetation.forageAt(x, y, sp.plantDiet);
      // Rates are per minute; this step may be several minutes long.
      const want = plantIntakePerMinute(world, slot) * dt;
      if (forage.amount > 0.004) {
        const taken = world.vegetation.consume(x, y, sp.plantDiet, want);
        if (taken > 0) {
          // Poor forage fills a belly more slowly: quality is nutritional value.
          applyFood(world, slot, (taken / FORAGE_PER_MEAL) * clamp(sp.plantNutrition * forage.quality + 0.25, 0.3, 1.3), 'plants');
          world.vegetation.recordGraze(x, y, taken);
          if (forage.amount > 0.12) c.remember(slot, MemKind.Food, x, y, 0.55);
        }
      }
      // If the ground here is grazed out, walk to remembered or sampled better
      // pasture. A hungry animal always has somewhere to go.
      const here = world.vegetation.forageAt(x, y, sp.plantDiet);
      const thin = here.amount < 0.05;
      if (thin) {
        const toTarget = hasTarget ? Math.hypot(targetX - x, targetY - y) : 0;
        const search = c.goalKind[slot] !== GoalKind.Forage || !hasTarget || toTarget < 5;
        let moved = false;
        if (search) {
          const memory = c.recall(slot, MemKind.Food);
          let tx = 0;
          let ty = 0;
          let ok = false;
          if (memory && memory.strength > 0.2) {
            tx = memory.x;
            ty = memory.y;
            ok = true;
          } else {
            const patch = bestPatchNear(world, x, y, 160, sp.plantDiet);
            if (patch) {
              tx = patch.x;
              ty = patch.y;
              ok = true;
              c.remember(slot, MemKind.Food, tx, ty, 0.45);
            }
          }
          if (ok) {
            targetX = tx;
            targetY = ty;
            c.targetX[slot] = tx;
            c.targetY[slot] = ty;
            c.hasTarget[slot] = 1;
            c.goalKind[slot] = GoalKind.Forage;
            c.goalMinutes[slot] = 60;
            hasTarget = true;
            moved = true;
          }
        } else {
          moved = true; // keep walking to the patch we already chose
        }
        if (moved) desiredSpeed = walk * 0.7;
      } else {
        // Good grazing: stay put and crop it down.
        desiredSpeed = 0;
        c.clearTarget(slot);
      }
      break;
    }
    case Action.Hunt: {
      const prey = p_prey(world, slot);
      if (prey >= 0) {
        targetX = c.x[prey];
        targetY = c.y[prey];
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
        const dist = Math.hypot(targetX - x, targetY - y);
        desiredSpeed = run;
        // Hunters close the distance; a bear fishing waits at the water's edge.
        if (dist < Math.max(2.5, sp.bodyLength * 1.4) + 1.5) {
          feedStats.attacks++;
          resolveAttack(world, slot, prey);
        }
      } else if (c.hasTarget[slot]) {
        // Hunting a remembered patch or a target that has gone.
        desiredSpeed = walk * 0.8;
        if (Math.hypot(targetX - x, targetY - y) < 6) c.hasTarget[slot] = 0;
      } else {
        // Try aggregate prey where we stand, or move to a patch.
        let ate = 0;
        for (const key of sp.aggregatePrey) {
          const available = world.aggregates.availableAt(key, x, y);
          if (available > 0.05) {
            ate += world.aggregates.consume(key, x, y, intakePerMinute(world, slot) * dt * 0.7);
          }
        }
        if (sp.locomotion === 'fish') {
          ate += world.aggregates.consume('plankton', x, y, intakePerMinute(world, slot) * dt * 0.6);
          ate += world.aggregates.consume('insect', x, y, intakePerMinute(world, slot) * dt * 0.3);
        }
        if (sp.key === 'bear' && world.terrain.waterAtWorld(x, y) > 0.05) {
          const fish = world.catchTroutAt(x, y, slot);
          if (fish > 0) applyFood(world, slot, (fish / MEAT_PER_MEAL) * sp.meatNutrition, 'fish');
        }
        if (ate > 0) applyFood(world, slot, (ate / PATCH_PER_MEAL) * sp.meatNutrition, 'insects');
        // Move toward the best patch if we know of one.
        const best = sp.aggregatePrey.length ? world.aggregates.bestPatchNear(sp.aggregatePrey[0], x, y, 60) : null;
        if (best && (c.hunger[slot] > 0.2 || ate <= 0)) {
          c.targetX[slot] = best.x;
          c.targetY[slot] = best.y;
          c.hasTarget[slot] = 1;
          c.goalKind[slot] = GoalKind.Prey;
          c.goalMinutes[slot] = 90;
          desiredSpeed = walk * 0.7;
        } else if (c.hunger[slot] > 0.3 && !c.hasTarget[slot]) {
          // Hungry and empty-handed: hunt the habitat — cover where herbivores
          // browse, or the nearest waterhole they must come to drink.
          const patch = bestPatchNear(world, x, y, 130, PREY_HABITAT_DIET);
          const water = world.hydrology.waterReach(x, y);
          let tx = 0;
          let ty = 0;
          let ok = false;
          if (patch && patch.amount > 0.06) {
            tx = patch.x;
            ty = patch.y;
            ok = true;
          } else if (water) {
            tx = water.x;
            ty = water.y;
            ok = true;
          }
          if (ok) {
            targetX = tx;
            targetY = ty;
            c.targetX[slot] = tx;
            c.targetY[slot] = ty;
            c.hasTarget[slot] = 1;
            c.goalKind[slot] = GoalKind.Prey;
            c.goalMinutes[slot] = 90;
            hasTarget = true;
            desiredSpeed = walk * 0.85;
            c.remember(slot, MemKind.Food, tx, ty, 0.3);
          } else {
            desiredSpeed = walk * 0.5;
          }
        } else {
          desiredSpeed = walk * 0.5;
        }
      }
      break;
    }
    case Action.Scavenge: {
      const carcass = world.carcasses.nearest(x, y, 60);
      if (carcass) {
        const dist = Math.hypot(carcass.x - x, carcass.y - y);
        targetX = carcass.x;
        targetY = carcass.y;
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
        desiredSpeed = dist > 3 ? walk * 1.4 : 0;
        if (dist < 3.5) {
          const want = feedRatePerMinute(world, slot) * dt * MEAT_PER_MEAL;
          const got = world.carcasses.consume(carcass, want, c.speciesIdx[slot]);
          if (got > 0) {
            applyFood(world, slot, (got / MEAT_PER_MEAL) * sp.meatNutrition, 'carrion');
            c.remember(slot, MemKind.Carcass, carcass.x, carcass.y, 0.6);
          } else {
            c.hasTarget[slot] = 0;
          }
        }
      } else {
        c.action[slot] = Action.Wander;
      }
      break;
    }
    case Action.Drink: {
      // Walk to the remembered water, then drink at the edge. The reach map
      // tells us the true distance to the nearest drinkable cell, so an animal
      // standing in the shallows can drink even if its target is a step away.
      targetX = c.targetX[slot];
      targetY = c.targetY[slot];
      hasTarget = true;
      const reach = world.hydrology.waterReach(x, y);
      const atWater = reach !== null && reach.distance <= 7.5;
      if (reach && !atWater) {
        // Walk straight for the nearest drinkable cell. The stale memory is
        // only a hint; the reach map knows where the water actually is.
        targetX = reach.x;
        targetY = reach.y;
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        c.goalKind[slot] = GoalKind.Water;
        c.goalMinutes[slot] = 120;
        hasTarget = true;
        desiredSpeed = walk * 1.15;
      } else if (atWater) {
        desiredSpeed = 0;
      } else {
        desiredSpeed = walk * 0.9;
      }
      if (atWater) {
        // Drinking rate: big animals drink more but also less often.
        const rate = 1 / Math.max(0.4, sp.thirstHours * 0.08);
        c.thirst[slot] = Math.max(0, c.thirst[slot] - rate * (dt / 60) * 2.6);
        c.lastDrinkHours[slot] = 0;
        // Standing at water is when an animal actually refreshes its memory.
        c.remember(slot, MemKind.Water, reach.x, reach.y, 1);
      } else if (c.actionMinutes[slot] > 150) {
        // Half a day of walking to a waterhole and still dry: the memory is
        // wrong (the hole dried up, or something is in the way) — forget it.
        c.forget(slot, MemKind.Water);
        c.action[slot] = Action.Wander;
        c.clearTarget(slot);
        c.remember(slot, MemKind.Danger, targetX, targetY, 0.5);
      }
      break;
    }
    case Action.Rest: {
      desiredSpeed = 0;
      c.sleeping[slot] = 1;
      const recovery = dt / 60 / Math.max(0.4, sp.sleepHours) * 3.4;
      c.fatigue[slot] = Math.max(0, c.fatigue[slot] - recovery);
      c.energy[slot] = clamp01(c.energy[slot] + recovery * 0.1);
      if (c.fatigue[slot] <= 0.02) {
        c.sleeping[slot] = 0;
        c.action[slot] = Action.Wander;
      }
      break;
    }
    case Action.Flee: {
      c.sleeping[slot] = 0;
      const threat = p_threat(world, slot);
      if (threat >= 0) {
        const dx = x - c.x[threat];
        const dy = y - c.y[threat];
        const len = Math.max(0.001, Math.hypot(dx, dy));
        targetX = clamp(x + (dx / len) * 60, -world.terrain.half * 0.95, world.terrain.half * 0.95);
        targetY = clamp(y + (dy / len) * 60, -world.terrain.half * 0.95, world.terrain.half * 0.95);
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
        desiredSpeed = run;
        c.fear[slot] = Math.min(1, c.fear[slot] + dt / 30);
        // Alarm calls: this is how a whole herd learns about a predator.
        if (c.callCooldown[slot] <= 0 && sp.voice) {
          world.raiseAlarm(slot, x, y, 1);
          c.callCooldown[slot] = 6 + world.rng.next() * 10;
        }
      } else {
        c.fear[slot] = Math.max(0, c.fear[slot] - dt / 40);
        c.action[slot] = Action.Wander;
      }
      break;
    }
    case Action.Hide: {
      c.hiding[slot] = 1;
      targetX = c.targetX[slot];
      targetY = c.targetY[slot];
      if (!c.hasTarget[slot] && p_hasShelterTarget(world, slot)) {
        targetX = c.targetX[slot];
        targetY = c.targetY[slot];
        c.hasTarget[slot] = 1;
        hasTarget = true;
      }
      const dist = Math.hypot(targetX - x, targetY - y);
      desiredSpeed = dist > 3 ? walk * 1.2 : 0;
      if (dist <= 3) {
        c.fear[slot] = Math.max(0, c.fear[slot] - dt / 25);
        c.stress[slot] = Math.max(0, c.stress[slot] - dt / 90);
      }
      if (c.fear[slot] <= 0.05 && c.health[slot] > 0.5) {
        c.hiding[slot] = 0;
        c.action[slot] = Action.Wander;
      }
      break;
    }
    case Action.ReturnHome:
    case Action.Nurture: {
      const hx = c.homeX[slot];
      const hy = c.homeY[slot];
      const dist = Math.hypot(hx - x, hy - y);
      targetX = hx;
      targetY = hy;
      c.targetX[slot] = hx;
      c.targetY[slot] = hy;
      c.hasTarget[slot] = 1;
      hasTarget = true;
      desiredSpeed = dist > 3 ? walk * (action === Action.Nurture ? 1.3 : 1.0) : 0;
      if (action === Action.Nurture && dist < 4) {
        // Nursing: juveniles gain condition, the mother pays for it.
        const young = world.juvenilesOf(slot);
        for (const j of young) {
          c.energy[j] = clamp01(c.energy[j] + dt / 60 * 0.22);
          // Milk is food, not a snack: a suckling juvenile must be able to grow
          // on it, otherwise every litter starves while still unweaned.
          c.hunger[j] = Math.max(0, c.hunger[j] - (dt / 60 / Math.max(1, sp.hungerHours)) * 2.6);
          c.dependentOf[j] = c.id[slot];
        }
        if (young.length > 0) {
          c.hunger[slot] = clamp01(c.hunger[slot] + dt / 60 / Math.max(2, sp.hungerHours) * 0.5);
          c.nursingMinutes[slot] = Math.max(0, c.nursingMinutes[slot] - dt / TIME.minutesPerDay);
        }
      }
      break;
    }
    case Action.Court: {
      // A mate found by scent is a long walk away; follow the trail to it.
      let mate = p_mate(world, slot);
      if (mate < 0) mate = c.findMate(slot, 420);
      if (mate >= 0) {
        const dist = Math.hypot(c.x[mate] - x, c.y[mate] - y);
        if (dist > 4) {
          targetX = c.x[mate];
          targetY = c.y[mate];
          c.targetX[slot] = targetX;
          c.targetY[slot] = targetY;
          c.hasTarget[slot] = 1;
          hasTarget = true;
          desiredSpeed = walk * 1.25;
        } else {
          c.action[slot] = Action.Mate;
          desiredSpeed = 0;
        }
      } else {
        // Nobody to court after all: keep looking with a wide-ranging search.
        c.action[slot] = Action.Wander;
        desiredSpeed = walk * 0.7;
      }
      break;
    }
    case Action.Mate: {
      let mate = p_mate(world, slot);
      if (mate < 0) mate = c.findMate(slot, 240);
      if (mate >= 0 && Math.hypot(c.x[mate] - x, c.y[mate] - y) < 7) {
        const female = c.sex[slot] === 1 ? slot : mate;
        const male = c.sex[slot] === 0 ? slot : mate;
        world.beginPregnancy(female, male);
      } else {
        c.action[slot] = Action.Court;
      }
      desiredSpeed = 0;
      break;
    }
    case Action.Patrol: {
      const intruder = p_intruder(world, slot);
      if (intruder >= 0) {
        targetX = c.x[intruder];
        targetY = c.y[intruder];
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
        const dist = Math.hypot(targetX - x, targetY - y);
        desiredSpeed = run * 0.85;
        if (dist < Math.max(3, sp.bodyLength * 1.2)) {
          // A challenge: display, then fight if the intruder holds its ground.
          const myStrength = c.bodyScale(slot) * c.health[slot] * (1 + c.personality_(slot, P.Aggression));
          const theirStrength = c.bodyScale(intruder) * c.health[intruder] * (1 + c.personality_(intruder, P.Aggression));
          if (world.rng.next() < clamp01(myStrength / (myStrength + theirStrength)) && world.rng.chance(0.5)) {
            c.injury[intruder] = Math.min(1, c.injury[intruder] + 0.25);
            c.energy[intruder] = Math.max(0, c.energy[intruder] - 0.12);
            // The loser retreats; the winner marks the line.
            const t = world.social.groupFor(c, intruder);
            if (t) t.killFreshness = 0;
            c.remember(intruder, MemKind.Danger, c.x[slot], c.y[slot], 1);
          } else {
            c.injury[slot] = Math.min(1, c.injury[slot] + 0.2);
          }
          c.attackTimer[slot] = 30;
          c.action[slot] = Action.Wander;
        }
      } else {
        const group = world.social.groupFor(c, slot);
        const cx = group ? group.territoryX : c.territoryX[slot];
        const cy = group ? group.territoryY : c.territoryY[slot];
        const radius = group ? group.territoryRadius : c.territoryR[slot];
        const angle = world.rng.range(0, TAU);
        targetX = cx + Math.cos(angle) * radius * 0.85;
        targetY = cy + Math.sin(angle) * radius * 0.85;
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
        desiredSpeed = walk * 0.8;
        if (Math.hypot(x - cx, y - cy) > radius * 1.4) {
          c.action[slot] = Action.Wander;
        }
      }
      break;
    }
    case Action.Socialize: {
      const group = world.social.groupFor(c, slot);
      if (!group) {
        world.social.join(c, slot, world.clock.day);
        c.action[slot] = Action.Wander;
        break;
      }
      const gx = group.centerX;
      const gy = group.centerY;
      const dist = Math.hypot(gx - x, gy - y);
      targetX = gx;
      targetY = gy;
      c.targetX[slot] = gx;
      c.targetY[slot] = gy;
      c.hasTarget[slot] = 1;
      hasTarget = true;
      // Stay in the middle of the group rather than on top of its centre.
      const slack = Math.max(6, SPECIES[group.speciesIdx].bodyLength * 3);
      desiredSpeed = dist > slack ? walk * 0.85 : 0;
      // Group members feed as they go — herds graze while they walk.
      if (sp.plantDiet.some((v) => v > 0.05)) {
        const taken = world.vegetation.consume(x, y, sp.plantDiet, plantIntakePerMinute(world, slot) * dt * 0.4);
        if (taken > 0) {
          applyFood(world, slot, (taken / FORAGE_PER_MEAL) * clamp(sp.plantNutrition + 0.2, 0.4, 1.2), 'plants');
          world.vegetation.recordGraze(x, y, taken);
        }
      }
      break;
    }
    case Action.Migrate: {
      const group = world.social.groupFor(c, slot);
      let tx = c.targetX[slot];
      let ty = c.targetY[slot];
      if (group?.migrating) {
        tx = group.migrateX;
        ty = group.migrateY;
      } else if (!c.hasTarget[slot]) {
        const dest = world.migrationTarget(c.speciesIdx[slot], x, y);
        tx = dest.x;
        ty = dest.y;
      }
      c.targetX[slot] = tx;
      c.targetY[slot] = ty;
      c.hasTarget[slot] = 1;
      hasTarget = true;
      desiredSpeed = walk * 1.35;
      // Fish filter-feed on the move; a spawning run is not a fast.
      if (sp.locomotion === 'fish' || sp.shelter === 'shoal') {
        const filtered = world.aggregates.consume('plankton', x, y, intakePerMinute(world, slot) * dt * 0.6);
        const picked = world.aggregates.consume('insect', x, y, intakePerMinute(world, slot) * dt * 0.3);
        if (filtered > 0) applyFood(world, slot, (filtered / PATCH_PER_MEAL) * sp.meatNutrition, 'fish');
        if (picked > 0) applyFood(world, slot, (picked / PATCH_PER_MEAL) * sp.meatNutrition, 'insects');
      }
      if (Math.hypot(tx - x, ty - y) < 12) {
        c.hasTarget[slot] = 0;
        c.action[slot] = Action.Forage;
      }
      break;
    }
    case Action.Bask: {
      const tooCold = c.warmth[slot] < 0.6;
      const spot = tooCold ? world.findSun(x, y) : world.findShade(x, y);
      if (spot) {
        targetX = spot.x;
        targetY = spot.y;
        c.targetX[slot] = targetX;
        c.targetY[slot] = targetY;
        c.hasTarget[slot] = 1;
        hasTarget = true;
        const dist = Math.hypot(targetX - x, targetY - y);
        desiredSpeed = dist > 3 ? walk * 0.7 : 0;
        if (dist <= 3) {
          c.warmth[slot] = clamp01(c.warmth[slot] + dt / 60 * (tooCold ? 0.16 : 0.1));
          if (c.warmth[slot] > 0.85) c.action[slot] = Action.Forage;
        }
      } else {
        c.action[slot] = Action.Wander;
      }
      break;
    }
    case Action.Investigate: {
      const carcass = p_carcass(world, slot);
      let tx = carcass >= 0 ? world.carcasses.nearest(x, y, 60)?.x ?? x : x;
      let ty = carcass >= 0 ? world.carcasses.nearest(x, y, 60)?.y ?? y : y;
      const presence = world.playerPresence;
      if (presence && Math.hypot(presence.x - x, presence.y - y) < 60) {
        tx = presence.x;
        ty = presence.y;
      }
      targetX = tx;
      targetY = ty;
      c.targetX[slot] = tx;
      c.targetY[slot] = ty;
      desiredSpeed = Math.hypot(tx - x, ty - y) > 8 ? walk * 0.8 : 0;
      if (Math.hypot(tx - x, ty - y) < 12) c.action[slot] = Action.Wander;
      break;
    }
    case Action.Cache: {
      const home = c.hasHome[slot] ? { x: c.homeX[slot], y: c.homeY[slot] } : { x: c.territoryX[slot], y: c.territoryY[slot] };
      targetX = home.x;
      targetY = home.y;
      c.targetX[slot] = targetX;
      c.targetY[slot] = targetY;
      hasTarget = true;
      desiredSpeed = Math.hypot(targetX - x, targetY - y) > 6 ? walk : 0;
      if (Math.hypot(targetX - x, targetY - y) <= 6) {
        c.remember(slot, MemKind.Cache, x, y, 1);
        c.action[slot] = Action.Wander;
      }
      break;
    }
    case Action.Die:
      desiredSpeed = 0;
      break;
  }

  move(world, slot, dt, targetX, targetY, desiredSpeed, hasTarget);
  void sp;
}

/** Convert biomass into hunger/energy, and note the meal for the timeline. */
/**
 * Feeding. `satisfaction` is measured in "meals": 1.0 is a full belly, so an
 * animal can eat for a couple of hours to go from starving to fed, and a wolf
 * that brings down a deer gets more than one. Everything that eats — grass,
 * insects, carrion, fish — is converted into these units first, which keeps
 * the hunger bar meaningful no matter how big the animal is.
 */
function applyFood(world: World, slot: number, satisfaction: number, kind: string): void {
  if (!(satisfaction > 0)) return;
  const c = world.creatures;
  const before = c.hunger[slot];
  c.hunger[slot] = clamp01(c.hunger[slot] - satisfaction);
  c.energy[slot] = clamp01(c.energy[slot] + satisfaction * 0.45);
  feedStats.calls++;
  const skey = SPECIES[c.speciesIdx[slot]].key;
  feedStats.perSpecies[skey] = (feedStats.perSpecies[skey] ?? 0) + satisfaction;
  if (kind === 'plants') feedStats.plants += satisfaction;
  else if (kind === 'meat') feedStats.meat += satisfaction;
  else if (kind === 'carrion') feedStats.carrion += satisfaction;
  else if (kind === 'fish') feedStats.fish += satisfaction;
  else feedStats.insects += satisfaction;
  c.health[slot] = clamp01(c.health[slot] + satisfaction * 0.06);
  c.lastMealHours[slot] = 0;
  c.lastMealDay[slot] = world.clock.day;
  // A "meal" is a bellyful, however it was gathered: count it when the animal
  // has eaten about its own daily requirement.
  c.mealsFraction[slot] += satisfaction;
  while (c.mealsFraction[slot] >= 1) {
    c.mealsFraction[slot] -= 1;
    c.mealsTotal[slot]++;
  }
  if (before > 0.55 && c.hunger[slot] <= 0.55) world.creatures.onMeal?.(slot, kind, satisfaction);
}

/* Feeding rates. Picked so that an animal that feeds for roughly half its
 * waking hours holds its condition, and one that cannot feed starves in about a
 * day — which is what makes hunger a real pressure rather than a display. */

/** Meals per minute while actively feeding (scaled by the species' gut). */
function feedRatePerMinute(world: World, slot: number): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const gut = 1 / Math.max(4, sp.hungerHours);
  const metabolism = 0.7 + c.trait(slot, 'metabolism') * 0.4;
  // Feeding for roughly a third of the animal's waking hours covers its needs,
  // which leaves the rest of the day for travelling, watching, courting and
  // being chased. Set this too low and every herbivore lives on the edge of
  // starvation no matter how green the ground beneath it is.
  return clamp(0.05 * gut * metabolism * (1 - c.anorexia[slot] * 0.8), 0.00008, 0.016);
}

/** Plant biomass (field units) a grazer strips per minute while foraging. */
function plantIntakePerMinute(world: World, slot: number): number {
  return feedRatePerMinute(world, slot) * FORAGE_PER_MEAL;
}

/** Patch prey (aggregate biomass) taken per minute. */
function intakePerMinute(world: World, slot: number): number {
  return feedRatePerMinute(world, slot) * PATCH_PER_MEAL;
}

/**
 * Best nearby forage patch: a handful of samples on an expanding spiral, which
 * is cheap and gives the animal a real reason to walk in a particular direction.
 */
function bestPatchNear(world: World, x: number, y: number, range: number, diet: number[]): { x: number; y: number; amount: number } | null {
  let best: { x: number; y: number; amount: number } | null = null;
  const rng = world.creatures.rng;
  for (let i = 0; i < 10; i++) {
    const ang = rng.range(0, TAU);
    const dist = rng.range(range * 0.2, range);
    const px = x + Math.cos(ang) * dist;
    const py = y + Math.sin(ang) * dist;
    const f = world.vegetation.forageAt(px, py, diet);
    if (f.amount > 0.02 && (!best || f.amount > best.amount)) best = { x: px, y: py, amount: f.amount };
  }
  return best;
}

/** Movement speed for this animal right now, after terrain and condition. */
export function speedFor(world: World, slot: number, running: boolean): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const condition = clamp01(c.energy[slot] * 0.5 + c.health[slot] * 0.5);
  const base = running ? sp.runSpeed : sp.walkSpeed;
  const genetic = c.trait(slot, 'speed');
  const injury = 1 - clamp01(c.injury[slot]) * 0.4;
  const load = c.pregnantLeft[slot] > 0 ? 0.82 : 1;
  const fatigue = 1 - clamp01(c.fatigue[slot]) * (running ? 0.45 : 0.15);
  const terrain = terrainSpeedFactor(world, slot);
  return base * genetic * (0.55 + condition * 0.5) * injury * load * fatigue * terrain;
}

/** How much the ground slows this animal down (slope, mud, snow, water). */
function terrainSpeedFactor(world: World, slot: number): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const x = c.x[slot];
  const y = c.y[slot];
  const slope = world.terrain.slopeAtWorld(x, y);
  const mud = world.terrain.mudAtWorld(x, y);
  const snow = world.terrain.snowAtWorld(x, y);
  const water = world.terrain.waterAtWorld(x, y);
  const agility = sp.terrainAgility;
  let factor = 1 - clamp01(slope * (1.6 - agility * 0.8));
  factor *= 1 - clamp01(mud * (0.5 - agility * 0.25));
  factor *= 1 - clamp01(snow * (0.6 - agility * 0.35));
  if (water > 0.05) {
    factor *= sp.locomotion === 'fish' ? 1 : sp.swims ? 0.55 : 0.3;
  }
  if (sp.locomotion === 'bird' && c.flying[slot]) factor = 1;
  return clamp(factor, 0.15, 1.05);
}

/* ------------------------------------------------------------------ */
/* Movement                                                            */
/* ------------------------------------------------------------------ */

/** Integrate motion toward a target with steering, terrain limits and cohesion. */
export function move(world: World, slot: number, dt: number, targetX: number, targetY: number, speed: number, hasTarget: boolean): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const x = c.x[slot];
  const y = c.y[slot];

  let desiredHeading = c.heading[slot];
  if (hasTarget) {
    const dx = targetX - x;
    const dy = targetY - y;
    desiredHeading = Math.atan2(dy, dx);
    if (Math.hypot(dx, dy) < 1.5) speed *= 0.2;
  }

  // Separation from neighbours keeps animals from merging into one blob.
  const sep = c.grid.queryRadius(x, y, 6, c.scratch);
  let sepX = 0;
  let sepY = 0;
  let sepCount = 0;
  for (let i = 0; i < sep; i++) {
    const other = c.scratch[i];
    if (other === slot || !c.alive[other]) continue;
    if (c.speciesIdx[other] !== c.speciesIdx[slot]) continue;
    const dx = x - c.x[other];
    const dy = y - c.y[other];
    const d2 = dx * dx + dy * dy;
    if (d2 < 0.01) continue;
    sepX += dx / d2;
    sepY += dy / d2;
    sepCount++;
  }
  if (sepCount > 0) {
    const sepLen = Math.hypot(sepX, sepY);
    if (sepLen > 0.001) {
      const sepHeading = Math.atan2(sepY, sepX);
      const strength = clamp01(sepLen * 2.5) * 0.6;
      desiredHeading += wrapAngle(sepHeading - desiredHeading) * strength;
    }
  }

  // React to ground conditions ahead: turn away from deep water and cliffs.
  if (c.inWater[slot] === 0 && sp.locomotion !== 'fish') {
    const look = Math.max(3, sp.bodyLength);
    const aheadX = x + Math.cos(desiredHeading) * look;
    const aheadY = y + Math.sin(desiredHeading) * look;
    const depth = world.terrain.waterAtWorld(aheadX, aheadY);
    if (depth > (sp.swims ? 1.2 : 0.35)) {
      const leftDepth = world.terrain.waterAtWorld(x + Math.cos(desiredHeading + 1.1) * look, y + Math.sin(desiredHeading + 1.1) * look);
      const rightDepth = world.terrain.waterAtWorld(x + Math.cos(desiredHeading - 1.1) * look, y + Math.sin(desiredHeading - 1.1) * look);
      desiredHeading += (leftDepth < rightDepth ? 1 : -1) * 1.4 * (dt / 30 + 0.5);
    }
  }

  // Turning is limited by how tightly the animal can physically arc, not by a
  // time constant: a stepping simulation must not make an animal take minutes
  // to come about, or no predator can ever run anything down.
  const previousSpeed = c.speed[slot];
  const stepTravel = Math.max(0.02, previousSpeed * dt);
  const turnRadius = Math.max(0.7, sp.bodyLength * 0.85);
  const maxTurn = clamp(stepTravel / turnRadius, 0.08, 2.6);
  const headingError = wrapAngle(desiredHeading - c.heading[slot]);
  c.heading[slot] = wrapAngle(c.heading[slot] + clamp(headingError, -maxTurn, maxTurn));

  // Travel speed after terrain. Acceleration takes a few seconds of game time,
  // which is instant at this step size; slowing down is a little quicker.
  const terrainSpeed = speed * terrainSpeedFactor(world, slot);
  const accelMinutes = clamp(0.02 + sp.bodyLength * 0.02, 0.02, 0.2);
  const blend = clamp01(dt / (terrainSpeed > previousSpeed ? accelMinutes : accelMinutes * 0.6));
  c.speed[slot] = lerp(previousSpeed, terrainSpeed, blend);
  if (c.speed[slot] < 0.01) c.speed[slot] = 0;

  const stepDistance = c.speed[slot] * dt;
  if (stepDistance > 0.0001) {
    let nx = x + Math.cos(c.heading[slot]) * stepDistance;
    let ny = y + Math.sin(c.heading[slot]) * stepDistance;
    // World bounds: the map edge is a hard limit, the sea is not crossable for
    // land animals unless they swim.
    const limit = world.terrain.half * 0.98;
    nx = clamp(nx, -limit, limit);
    ny = clamp(ny, -limit, limit);
    // Tree trunks are solid for anything on foot. Crowns are not: animals walk
    // beneath them. A step into a trunk is refused and the animal turns away
    // from it, so it skirts the trunk rather than passing through.
    if (sp.locomotion !== 'fish' && !c.flying[slot]) {
      const trunk = trunkInWay(world, nx, ny, Math.max(0.25, sp.bodyLength * 0.2));
      if (trunk >= 0) {
        const tx = world.forest.store.x[trunk] - x;
        const ty = world.forest.store.y[trunk] - y;
        // Positive cross product: the trunk is on the left, so turn right.
        const cross = Math.cos(c.heading[slot]) * ty - Math.sin(c.heading[slot]) * tx;
        c.heading[slot] = wrapAngle(c.heading[slot] + (cross > 0 ? -0.9 : 0.9));
        c.speed[slot] = Math.min(c.speed[slot], sp.walkSpeed * 0.3);
        nx = x;
        ny = y;
      }
    }
    const depth = world.terrain.waterAtWorld(nx, ny);
    if (sp.locomotion === 'fish') {
      if (depth < 0.15) {
        // A fish in water too shallow to swim in makes for deeper water: it
        // needs a pool, not a puddle, or it will beach itself and die.
        const deep = world.findDeepWater(nx, ny, Math.max(0.3, depth + 0.15), 84);
        const water = deep ?? world.findWater(nx, ny);
        if (water) {
          c.heading[slot] = Math.atan2(water.y - ny, water.x - nx);
          c.speed[slot] = Math.max(sp.walkSpeed * 0.6, Math.min(c.speed[slot], sp.runSpeed * 0.7));
        } else {
          c.speed[slot] = 0;
        }
      } else {
        c.inWater[slot] = 1;
      }
    } else if (depth > 0.02) {
      c.inWater[slot] = 1;
      if (depth > 1.1 && !sp.swims) {
        // Non-swimmers cannot enter deep water: stay put at the edge.
        nx = x;
        ny = y;
        c.speed[slot] = 0;
        c.heading[slot] += dt / 6;
      }
    } else {
      c.inWater[slot] = 0;
    }
    c.x[slot] = nx;
    c.y[slot] = ny;
  }

  settleVertical(world, slot, dt, stepDistance);

  // Fatigue from exertion.
  const exertion = c.speed[slot] / Math.max(1, sp.runSpeed);
  c.fatigue[slot] = clamp01(c.fatigue[slot] + (exertion * exertion * dt) / (60 * Math.max(2, sp.sleepHours)) * 1.6);
  c.movementActivity[slot] = clamp01(exertion * 1.2);
  c.animSpeed[slot] = c.speed[slot];

  // Wandering tracks, so the ground remembers where animals walked.
  if (sp.bodyLength > 0.25 && stepDistance > 0.2 && world.rng.chance(clamp01(stepDistance / 8))) {
    world.recordTrack(slot);
  }
}

/** Gravity, m/s². */
const GRAVITY = 9.81;
const trunkScratch = new Int32Array(64);
const trunkOut = new Int32Array(32);

/**
 * The closest live tree whose trunk would be entered by a body at (x, y) with
 * the given clearance, or -1. Only trunks are solid; the crown is not.
 */
function trunkInWay(world: World, x: number, y: number, clearance: number): number {
  const store = world.forest.store;
  const n = store.queryNear(x, y, clearance + 1.5, trunkOut, trunkScratch);
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < n; i++) {
    const t = trunkOut[i];
    const trunk = Math.min(0.6, Math.max(0.1, store.height[t] * 0.035));
    const gap = Math.hypot(store.x[t] - x, store.y[t] - y) - trunk - clearance;
    if (gap < 0 && gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best;
}

/**
 * Vertical placement. Ground animals stand on the terrain: they never sit below
 * it, they climb it at once, and when they are above it they fall with real
 * gravity. Swimmers ride the surface; birds climb and glide to altitude.
 */
function settleVertical(world: World, slot: number, dt: number, stepDistance: number): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const x = c.x[slot];
  const y = c.y[slot];
  const ground = world.terrain.elevationAtWorld(x, y);
  const water = world.terrain.waterAtWorld(x, y);

  if (sp.locomotion === 'fish') {
    c.z[slot] = ground + Math.max(0.05, water * 0.55);
    c.flying[slot] = 0;
    return;
  }

  if (sp.locomotion === 'bird') {
    // Birds fly when travelling or fleeing, and land to feed or rest.
    const wantsFlight = c.action[slot] === Action.Hunt || c.action[slot] === Action.Migrate || c.action[slot] === Action.Flee || (c.action[slot] === Action.Wander && c.speed[slot] > sp.walkSpeed * 0.6);
    c.flying[slot] = wantsFlight ? 1 : 0;
    if (wantsFlight) {
      const altitude = clamp(12 + stepDistance * 0.4, 6, 55);
      const target = ground + Math.max(water * 0.6, 0) + altitude;
      c.z[slot] = Math.max(ground + 0.5, lerp(c.z[slot], target, clamp01(dt / 8)));
      return;
    }
    // Landed birds are on the ground like anything else.
  } else {
    c.flying[slot] = 0;
  }

  const standing = ground + Math.max(0, water * 0.35);
  if (c.z[slot] > standing) {
    // Free fall from rest over this step; never below the surface it lands on.
    const seconds = dt * 60;
    c.z[slot] = Math.max(standing, c.z[slot] - 0.5 * GRAVITY * seconds * seconds);
  } else {
    c.z[slot] = standing;
  }
}

/* ------------------------------------------------------------------ */
/* Combat                                                              */
/* ------------------------------------------------------------------ */

/** Resolve an attack on a specific prey animal. */
export function resolveAttack(world: World, predator: number, prey: number): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[predator]];
  const preySp = SPECIES[c.speciesIdx[prey]];
  if (c.attackTimer[predator] > 0) {
    feedStats.cooldownDenied++;
    feedStats.cooldownSum += c.attackTimer[predator];
    const key = sp.key + '/' + Math.round(c.attackTimer[predator]);
    if (feedStats.trace.length < 40) {
      feedStats.trace.push(`${sp.key}#${predator} t=${c.attackTimer[predator].toFixed(1)} min=${world.clock.minutes.toFixed(0)} act=${Action[c.action[predator]]} anim=${Action[c.animState[predator]]}`);
    }
    feedStats.cooldownBySpecies[key] = (feedStats.cooldownBySpecies[key] ?? 0) + 1;
    return;
  }
  // A hunting attempt is not one lunge: it is a stalk, a chase, and then a
  // long recovery. Big hunters can only try a few times a day, so a failed
  // chase genuinely costs them and the herd gets breathing room between raids.
  c.attackTimer[predator] = clamp(22 + sp.massKg * 3.2, 22, 170);

  const pack = sp.groupHunter ? packStrength(world, predator) : 1;
  const predatorPower =
    Math.pow(sp.massKg * c.bodyScale(predator), 0.6) *
    (1 + c.trait(predator, 'aggression') * 0.5) *
    clamp01(c.energy[predator] * 0.6 + c.health[predator] * 0.4 + 0.3) *
    pack;
  const preyDefence =
    Math.pow(preySp.massKg * c.bodyScale(prey), 0.6) *
    (0.6 + c.speed[prey] / Math.max(1, preySp.runSpeed) * 0.6) *
    clamp01(c.health[prey] * 0.7 + c.energy[prey] * 0.3 + 0.35) *
    (1 + c.trait(prey, 'camouflage') * 0.2);
  // Hunt outcomes are decided by two things above all: can the hunter outrun
  // its quarry, and is it big enough to bring it down? A wolf on a hare has
  // the first and not the second; that is why hares survive wolves in numbers.
  const sizeRatio = (sp.massKg * c.bodyScale(predator)) / Math.max(0.05, preySp.massKg * c.bodyScale(prey));
  const speedEdge = clamp01((sp.runSpeed / Math.max(0.6, preySp.runSpeed) - 0.85) / 0.9);
  const massEdge = clamp01((Math.log(sizeRatio) - Math.log(2.2)) / Math.log(9));
  // Condition decides the stragglers: the old, the sick, the very young and
  // the starving are the ones a predator actually catches.
  const frail = clamp(1.35 - c.health[prey] * 0.55 - c.energy[prey] * 0.25 - (1 - c.bodyScale(prey)) * 0.5, 0.45, 1.5);
  // Ambush: an unaware prey animal is far easier to take; a fleeing one is not.
  const unaware = c.alerted[prey] <= 0 && c.action[prey] !== Action.Flee;
  const surprise = unaware ? 1.5 : 0.65;
  const packEdge = clamp(1 + (pack - 1) * 0.16, 1, 1.45);
  feedStats.ambush += unaware ? 1 : 0;
  const pSuccess = clamp(
    (0.09 + 0.5 * speedEdge * (0.35 + 0.65 * massEdge)) * frail * surprise * packEdge,
    0.02,
    0.85,
  );
  feedStats.pSum += pSuccess;
  const pairKey = `${sp.key}>${preySp.key}`;
  feedStats.attackPairs[pairKey] = (feedStats.attackPairs[pairKey] ?? 0) + 1;

  if (world.rng.chance(pSuccess)) {
    // The kill. `recordPredation` kills the prey, which leaves a carcass, and
    // the hunter eats its fill at the site — the rest feeds scavengers.
    const preyMass = preySp.massKg * c.bodyScale(prey);
    const killX = c.x[prey];
    const killY = c.y[prey];
    world.recordPredation(predator, prey, preyMass);
    // A meal is worth the prey's mass relative to the hunter, shared out if
    // this is a pack. Small prey are a snack, big prey a feast.
    const hunters = sp.groupHunter ? Math.max(1, Math.round(pack)) : 1;
    // A meal is a share of the predator's own body mass: a rabbit is a full
    // belly for a fox, a mouthful for a bear.
    feedStats.kills++;
    const feast = clamp(preyMass / Math.max(0.4, sp.massKg * 0.32) / hunters, 0.2, 1.8);
    applyFood(world, predator, feast, 'meat');
    if (sp.groupHunter && hunters > 1) {
      // Pack members close enough to have taken part share the kill.
      const n = c.grid.queryRadius(killX, killY, 45, c.scratch);
      for (let i = 0; i < n && i < 64; i++) {
        const other = c.scratch[i];
        if (other === predator || !c.alive[other]) continue;
        if (c.speciesIdx[other] !== c.speciesIdx[predator]) continue;
        applyFood(world, other, feast * 0.7, 'meat');
      }
    }
    c.remember(predator, MemKind.Kill, killX, killY, 1);
    // Scavengers learn about kills: memory only, not telepathy.
    world.broadcastKill(killX, killY, c.speciesIdx[predator]);
  } else {
    // Failed attack: most escapes cost the prey nothing but a fright. A clean
    // getaway is the common case, a real wound the exception — otherwise a
    // hunted population simply accumulates fatal injuries within days.
    if (world.rng.chance(0.4)) c.injury[prey] = Math.min(1, c.injury[prey] + 0.06 + world.rng.next() * 0.1);
    c.fear[prey] = 1;
    c.alerted[prey] = 3;
    c.action[prey] = Action.Flee;
    c.targetX[prey] = c.x[prey] + (c.x[prey] - c.x[predator]) * 2;
    c.targetY[prey] = c.y[prey] + (c.y[prey] - c.y[predator]) * 2;
    c.hasTarget[prey] = 1;
    // Hoofed prey can hurt a predator.
    if (preySp.massKg > sp.massKg * 0.8 && world.rng.chance(0.22)) {
      c.injury[predator] = Math.min(1, c.injury[predator] + 0.18);
      c.energy[predator] = Math.max(0, c.energy[predator] - 0.08);
    }
    c.energy[predator] = Math.max(0, c.energy[predator] - 0.02);
    world.raiseAlarm(prey, c.x[prey], c.y[prey], 1);
  }
}

function packStrength(world: World, slot: number): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const group = world.social.groupFor(c, slot);
  let strength = 1;
  if (!group) return strength;
  const n = c.grid.queryRadius(c.x[slot], c.y[slot], 40, c.scratch);
  for (let i = 0; i < n; i++) {
    const other = c.scratch[i];
    if (other === slot || !c.alive[other]) continue;
    if (c.speciesIdx[other] !== c.speciesIdx[slot]) continue;
    if (c.groupId[other] !== group.id) continue;
    strength += 0.22;
  }
  return Math.min(2.6, strength);
}

/* ------------------------------------------------------------------ */
/* Helpers used by act()                                               */
/* ------------------------------------------------------------------ */

function p_prey(world: World, slot: number): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const p = c.recall(slot, MemKind.Kill);
  void p;
  // The AI stores the current target in goalId when hunting.
  const stored = c.goalId[slot];
  if (stored >= 0) {
    const found = c.findByLivingId(stored);
    if (found >= 0) return found;
  }
  // Otherwise pick the nearest valid prey in range. Hunters can smell further
  // than they can see, so the fallback search matches the scent channel.
  const scentPrey = sp.dietKind === 'predator' || sp.dietKind === 'omnivore' || sp.dietKind === 'piscivore';
  const range = scentPrey ? Math.max(sp.visionRange * 1.1, sp.smellRange * 1.6) : sp.visionRange * 1.1;
  const n = c.grid.queryRadius(c.x[slot], c.y[slot], range, c.scratch);
  let best = -1;
  let bestD = range * range;
  for (let i = 0; i < n; i++) {
    const other = c.scratch[i];
    if (other === slot || !c.alive[other]) continue;
    const otherSp = SPECIES[c.speciesIdx[other]];
    if (!sp.preySpecies.includes(otherSp.key)) continue;
    if (otherSp.massKg < sp.preyMass[0] * 0.6 || otherSp.massKg > sp.preyMass[1]) continue;
    const d = (c.x[other] - c.x[slot]) ** 2 + (c.y[other] - c.y[slot]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  if (best >= 0) c.goalId[slot] = c.id[best];
  return best;
}

function p_threat(world: World, slot: number): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const n = c.grid.queryRadius(c.x[slot], c.y[slot], sp.visionRange * 1.2, c.scratch);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const other = c.scratch[i];
    if (other === slot || !c.alive[other]) continue;
    if (!c.predatorsOf[c.speciesIdx[slot]].includes(c.speciesIdx[other])) continue;
    const d = Math.hypot(c.x[other] - c.x[slot], c.y[other] - c.y[slot]);
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  return best;
}

function p_mate(world: World, slot: number): number {
  const c = world.creatures;
  const stored = c.goalId[slot];
  if (stored >= 0 && c.action[slot] === Action.Court) {
    const found = c.findByLivingId(stored);
    if (found >= 0 && canBreed(world, found)) return found;
  }
  const found = c.findMate(slot, 90);
  if (found >= 0) c.goalId[slot] = c.id[found];
  return found;
}

function p_intruder(world: World, slot: number): number {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const group = world.social.groupFor(c, slot);
  if (!group) return -1;
  const n = c.grid.queryRadius(c.x[slot], c.y[slot], group.territoryRadius, c.scratch);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const other = c.scratch[i];
    if (other === slot || !c.alive[other]) continue;
    if (c.speciesIdx[other] === c.speciesIdx[slot]) continue;
    const otherSp = SPECIES[c.speciesIdx[other]];
    if (otherSp.territoryDefence <= 0) continue;
    // Only challenge animals from the same guild (predators of similar size).
    if (Math.abs(otherSp.massKg - sp.massKg) > sp.massKg * 1.5) continue;
    const d = Math.hypot(c.x[other] - c.x[slot], c.y[other] - c.y[slot]);
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  return best;
}

function p_carcass(world: World, slot: number): number {
  const c = world.creatures;
  const car = world.carcasses.nearest(c.x[slot], c.y[slot], 70);
  if (!car) return -1;
  return car.id;
}

function p_hasShelterTarget(world: World, slot: number): boolean {
  const c = world.creatures;
  if (c.hasHome[slot]) {
    c.targetX[slot] = c.homeX[slot];
    c.targetY[slot] = c.homeY[slot];
    return true;
  }
  const spot = world.findCover(c.x[slot], c.y[slot]);
  if (spot) {
    c.targetX[slot] = spot.x;
    c.targetY[slot] = spot.y;
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Condition, disease and death                                        */
/* ------------------------------------------------------------------ */

/**
 * Needs drift, condition falls, and eventually something kills the animal.
 * This is where hunger, thirst, cold, disease and old age actually bite.
 */
export function updateNeeds(world: World, slot: number, dt: number): void {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[slot]];
  const hours = dt / 60;
  let temp = world.climate.temperatureAt(c.x[slot], c.y[slot]);
  const night = world.clock.isNight;
  const moving = c.speed[slot] / Math.max(1, sp.runSpeed);

  // Water buffers temperature: an animal in a lake or river is not exposed to
  // the air, it is held near the seasonal mean of the water it swims in.
  if (c.inWater[slot] === 1 || sp.locomotion === 'fish' || sp.shelter === 'shoal') {
    const tcx = clamp(Math.round(world.terrain.worldToCellX(c.x[slot])), 0, world.terrain.last);
    const tcy = clamp(Math.round(world.terrain.worldToCellY(c.y[slot])), 0, world.terrain.last);
    const seasonal = world.terrain.tempMean.data[tcy * world.terrain.size + tcx];
    temp = lerp(temp, seasonal + (temp - seasonal) * 0.25, 0.85);
  }

  // Hunger and thirst.
  c.hunger[slot] = clamp01(c.hunger[slot] + c.hungerRate(slot) * hours * (1 - c.anorexia[slot]));
  const thirstRate = 1 / Math.max(2, sp.thirstHours) * (0.7 + moving * 1.1) * (1 + clamp01((temp - 18) / 24) * 0.8);
  c.thirst[slot] = clamp01(c.thirst[slot] + thirstRate * hours * (sp.waterIndependent ? 0.15 : 1));

  // Energy reserves. Food is the only source: an animal whose belly is full
  // builds fat, an animal that cannot find food burns it, and when the fat is
  // gone the body starts consuming itself (that is when health falls).
  //
  // Fat is a buffer measured in days, not hours: a mammal that misses a meal
  // keeps working. This is what makes hunger a pressure with time to react to.
  const balance = (1 - c.hunger[slot]) * 0.55 - c.hunger[slot] * 0.4;
  const metabolic = c.metabolicRate(slot) * 0.000012 * hours * (0.4 + moving * 1.8) * 0.06;
  const bodyScale = Math.max(0.5, Math.pow(Math.max(0.05, sp.massKg), 0.12));
  c.energy[slot] = clamp01(c.energy[slot] + ((balance * 0.5 - metabolic) * hours * 0.1) / bodyScale);

  // Thermoregulation. Comfort is a window, not a point: cold and heat are
  // tracked separately, tolerance is heritable, and shelter (a den, deep cover,
  // or a snow cave) genuinely reduces heat loss.
  const [comfortLo, comfortHi] = sp.tempComfort;
  const band = Math.max(8, comfortHi - comfortLo);
  const effLo = comfortLo - (c.trait(slot, 'coldTol') - 1) * band * 0.9;
  const effHi = comfortHi + (c.trait(slot, 'heatTol') - 1) * band * 0.9;
  const sheltered =
    c.hiding[slot] === 1 ||
    c.sleeping[slot] === 1 ||
    (c.hasHome[slot] === 1 && Math.hypot(c.homeX[slot] - c.x[slot], c.homeY[slot] - c.y[slot]) < 10);
  const snow = world.terrain.snowAtWorld(c.x[slot], c.y[slot]);
  const exposure = 1 - clamp01((sheltered ? 0.55 : 0) + snow * 0.2);
  const coldRaw = clamp01((effLo - temp) / Math.max(6, band * 0.6)) * (0.65 + exposure * 0.5);
  const heatRaw = clamp01((temp - effHi) / Math.max(6, band * 0.6)) * (sheltered ? 0.6 : 1);
  const targetWarmth = clamp01(1 - Math.max(coldRaw, heatRaw));
  // Warmth moves slowly: a mammal holds its temperature for hours.
  c.warmth[slot] = lerp(c.warmth[slot], targetWarmth, clamp01(hours / 2.5));
  // Stress only bites when comfort is genuinely low.
  const coldStress = clamp01((0.55 - c.warmth[slot]) / 0.55);
  const heatStress = clamp01((0.5 - c.warmth[slot]) / 0.5) * 0.8;
  // Keeping warm costs energy; overheating costs water.
  c.energy[slot] = Math.max(0, c.energy[slot] - (coldStress * 0.6 + heatStress * 0.4) * hours * 0.012);
  if (heatStress > 0) c.thirst[slot] = clamp01(c.thirst[slot] + heatStress * hours * 0.02);

  // Health responds to the accumulated insults. Reserves cushion starvation:
  // an animal lives on its fat for a while before the body gives out, which is
  // what makes the hunger bar a warning rather than a countdown.
  let healthDelta = 0;
  const starving = clamp01((c.hunger[slot] - 0.8) * 5) * (1 - clamp01(c.energy[slot] * 1.6));
  const parched = clamp01((c.thirst[slot] - 0.8) * 5);
  // Terminal starvation costs about a day and a half of condition; thirst bites
  // much faster, as it does in life.
  healthDelta -= starving * hours * 0.028;
  healthDelta -= parched * hours * 0.11;
  healthDelta -= coldStress * hours * 0.055;
  healthDelta -= heatStress * hours * 0.045;
  healthDelta -= clamp01(c.injury[slot]) * hours * 0.02;
  // Illness runs its course. An infected animal is weakened for the duration of
  // the pathogen's infectious period and then, most of the time, recovers and
  // carries immunity; only the frailest go into a decline they cannot leave.
  if (c.infection[slot] === 1) {
    const pathogen = world.disease.forSpecies(c.speciesIdx[slot]);
    const virulence = pathogen ? pathogen.virulence : 0.5;
    const resistance = clamp01(c.diseaseResistance(slot));
    const frailty = 0.4 + Math.pow(1 - clamp01(c.health[slot] * 0.6 + c.energy[slot] * 0.4), 1.5);
    healthDelta -= hours * 0.028 * virulence * frailty * (1 - resistance * 0.7);
    c.anorexia[slot] = Math.max(c.anorexia[slot], 0.22 * virulence);
    c.infectionDays[slot] += hours / 24;
    // The illness ends when the body clears it — faster for a resistant host,
    // and never sooner than a few days.
    const course = Math.max(3, pathogen ? pathogen.infectiousDays : 12);
    const clearChance = ((hours / 24) * (0.55 + resistance * 0.9)) / Math.max(1, course / 2);
    if (c.infectionDays[slot] > course * 0.35 && world.rng.chance(clamp01(clearChance))) {
      c.infection[slot] = 2;
      c.infectionDays[slot] = 0;
    }
  } else if (c.infection[slot] === 2) {
    // Immunity is not permanent: it fades over months, so an outbreak can
    // return to a population that has since grown careless.
    c.infectionDays[slot] += hours / 24;
    if (c.infectionDays[slot] > 120 + world.rng.next() * 180) {
      c.infection[slot] = 0;
      c.infectionDays[slot] = 0;
    }
  }
  // Recovery needs food, water and rest.
  const wellbeing = clamp01(1 - Math.max(c.hunger[slot], c.thirst[slot]) * 0.9) * clamp01(0.4 + c.fatigue[slot] * 0.0 + 0.6);
  if (c.hunger[slot] < 0.5 && c.thirst[slot] < 0.5) {
    // A well-fed animal heals; a sick one heals more slowly, because the body
    // is spending what it has on the infection.
    const sickDrag = c.infection[slot] === 1 ? 0.45 : 1;
    healthDelta += hours * 0.045 * wellbeing * sickDrag;
    // Wounds mend over days when the animal is fed and watered.
    c.injury[slot] = Math.max(0, c.injury[slot] - hours * 0.035);
  }
  if (c.injury[slot] > 0 && c.hunger[slot] >= 0.5) c.injury[slot] = Math.max(0, c.injury[slot] - hours * 0.012);
  c.health[slot] = clamp01(c.health[slot] + healthDelta);

  // Stress is the summary of everything wrong, used by disease and behaviour.
  c.stress[slot] = clamp01(
    Math.max(starving, parched, coldStress, heatStress, clamp01(c.injury[slot]), c.fear[slot] * 0.8, c.infection[slot] === 1 ? 0.5 : 0) * 0.9 +
      (1 - c.energy[slot]) * 0.25,
  );

  // Fear and alertness decay on their own.
  c.fear[slot] = Math.max(0, c.fear[slot] - hours * 0.5);
  c.alerted[slot] = Math.max(0, c.alerted[slot] - hours);
  if (c.action[slot] !== Action.Hide) c.hiding[slot] = 0;
  if (c.action[slot] !== Action.Rest) c.sleeping[slot] = 0;
  void night;

  // Death.
  let cause: string | null = null;
  if (c.health[slot] <= 0.001) {
    if (starving > 0.35) cause = 'starvation';
    else if (parched > 0.35) cause = 'dehydration';
    else if (coldStress > 0.4) cause = 'cold';
    else if (heatStress > 0.4) cause = 'heat';
    else if (c.infection[slot] === 1) cause = 'disease';
    else if (c.injury[slot] > 0.3) cause = 'injury';
    else cause = 'exhaustion';
  }
  // Old age: probability rises past 75% of the species' maximum lifespan.
  const ageFrac = c.ageDays[slot] / (sp.maxAgeYears * TIME.daysPerYear * c.trait(slot, 'lifespan'));
  if (!cause && ageFrac > 0.75) {
    const risk = Math.pow((ageFrac - 0.75) / 0.25, 2.2) * 0.02 * hours * 24;
    if (world.rng.chance(clamp01(risk))) cause = 'old age';
  }
  // Fire kills.
  const heat = world.fire.heatAt(c.x[slot], c.y[slot]);
  if (!cause && heat > 0.6) {
    c.health[slot] = Math.max(0, c.health[slot] - heat * hours * 0.5);
    if (c.health[slot] <= 0.01 || world.rng.chance(heat * hours * 0.25)) cause = 'wildfire';
  }
  // Drowning: exhausted animals in deep water.
  if (!cause && c.inWater[slot] && sp.locomotion !== 'fish' && !sp.swims) {
    const depth = world.terrain.waterAtWorld(c.x[slot], c.y[slot]);
    if (depth > 1.2 && world.rng.chance(clamp01(depth - 1.2) * hours * 0.6)) cause = 'drowning';
  }
  // A severe untreated wound can kill, but slowly: infection, not the wound.
  if (!cause && c.injury[slot] > 0.85) {
    c.health[slot] = Math.max(0, c.health[slot] - hours * 0.02);
    if (c.health[slot] <= 0.01) cause = 'injury';
  }

  if (cause) {
    c.knownCauseOfDeath[slot] = cause;
    c.pendingDeath[slot] = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Reproduction                                                        */
/* ------------------------------------------------------------------ */

/** Gestation completes: produce a litter. */
export function giveBirth(world: World, mother: number): number[] {
  const c = world.creatures;
  const sp = SPECIES[c.speciesIdx[mother]];
  const born: number[] = [];
  const fetusCount = Math.max(1, c.fetusCount[mother]);
  const father = c.mateId[mother] >= 0 ? c.findByLivingId(c.mateId[mother]) : -1;
  const motherGenome = c.genome[mother];
  for (let i = 0; i < fetusCount; i++) {
    const fatherGenome = father >= 0 ? c.genome[father] : null;
    const genome = motherGenome
      ? fatherGenome
        ? Genome.cross(motherGenome, fatherGenome, world.rng)
        : Genome.mutate(motherGenome, world.rng, 0.12)
      : null;
    const personality = new Float32Array(P_TRAITS);
    const mBase = mother * P_TRAITS;
    const fBase = father >= 0 ? father * P_TRAITS : -1;
    for (let p = 0; p < P_TRAITS; p++) {
      const a = c.personality[mBase + p];
      const b = fBase >= 0 ? c.personality[fBase + p] : 0.5;
      personality[p] = clamp01(lerp(a, b, 0.5) + world.rng.gauss() * 0.07);
    }
    const homeX = c.hasHome[mother] ? c.homeX[mother] : c.x[mother];
    const homeY = c.hasHome[mother] ? c.homeY[mother] : c.y[mother];
    const slot = c.spawn({
      speciesIdx: c.speciesIdx[mother],
      x: homeX + world.rng.range(-2, 2),
      y: homeY + world.rng.range(-2, 2),
      genome,
      ageDays: 0,
      motherId: c.id[mother],
      fatherId: father >= 0 ? c.id[father] : -1,
      personality,
      generation: Math.max(c.generation[mother], father >= 0 ? c.generation[father] : 0) + 1,
      groupId: c.groupId[mother] >= 0 ? c.groupId[mother] : -1,
      homeX,
      homeY,
      homeKind: c.homeKind[mother],
      energy: 0.7,
    });
    if (slot < 0) break;
    c.weaned[slot] = 0;
    c.fetusCount[slot] = 0;
    born.push(c.id[slot]);
  }
  c.litters[mother]++;
  c.pregnancyCount[mother]++;
  c.nursingMinutes[mother] = sp.parentalCareDays;
  c.breedCooldown[mother] = Math.max(30, 365 / Math.max(1, sp.littersPerYear));
  c.energy[mother] = Math.max(0.15, c.energy[mother] - 0.18 * fetusCount);
  c.hunger[mother] = clamp01(c.hunger[mother] + 0.22);
  c.fetusCount[mother] = 0;
  c.mateId[mother] = -1;
  // Mothers remember their den.
  if (c.hasHome[mother]) c.remember(mother, MemKind.Den, c.homeX[mother], c.homeY[mother], 1);
  c.birthsTotal += born.length;
  return born;
}

/** Convenience: every living child of this animal that still depends on it. */
export function dependentYoung(world: World, mother: number): number[] {
  const c = world.creatures;
  const out: number[] = [];
  const ids = c.childrenIds[mother];
  if (!ids) return out;
  for (const id of ids) {
    const slot = c.findByLivingId(id);
    if (slot < 0) continue;
    if (c.dependentOf[slot] === c.id[mother] || !c.weaned[slot]) out.push(slot);
  }
  return out;
}

export { MemKind, Stage, wrapAngle, isWaterBiome };
