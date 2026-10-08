import { clamp01 } from '../core/math';
import { TIME } from '../core/config';
import { Action, Stage, activityFactor, MemKind } from './organism';
import { act, decide, giveBirth, newPerceived, perceive, updateNeeds } from './ai';
import type { World } from '../world/world';

/**
 * The per-individual step: physiology, growth, family life and the think/act
 * cycle. This file is deliberately thin — the behaviour lives in `ai.ts` and the
 * data in `organism.ts` — because it runs for every animal on every tick and is
 * the hottest loop in the simulation.
 */

/** A single reusable perception scratchpad (the sim is single threaded). */
const perceived = newPerceived();

export function simulateCreature(w: World, slot: number, dtMinutes: number): void {
  const c = w.creatures;
  if (!c.alive[slot]) return;
  const sp = c.species(slot);

  c.savePrevious(slot);

  try {
    // 1. Physiology. Needs drift, the body responds, and extreme states can
    //    flag the animal for death (handled before it acts).
    updateNeeds(w, slot, dtMinutes);
    if (c.pendingDeath[slot]) {
      c.kill(slot, c.knownCauseOfDeath[slot] ?? 'unknown');
      return;
    }

    // 2. Reproduction: gestation, nursing, recovery between litters.
    updatePregnancy(w, slot, dtMinutes);

    // 3. Growth and family life.
    updateGrowth(w, slot, dtMinutes);
    updateFamily(w, slot, dtMinutes);

    // 4. Think, then act. Thinking is staggered across individuals.
    if (c.thinkTimer[slot] <= 0) {
      perceive(w, slot, perceived);
      decide(w, slot, perceived);
    } else {
      c.thinkTimer[slot] -= dtMinutes;
    }

    // Goals expire: an animal that has been walking the same way for a long
    // time without arriving picks a new destination on the next decision.
    if (c.hasTarget[slot] === 1 && c.goalMinutes[slot] > 0) {
      c.goalMinutes[slot] -= dtMinutes;
      if (c.goalMinutes[slot] <= 0) c.clearTarget(slot);
    }

    c.actionMinutes[slot] += dtMinutes;
    act(w, slot, dtMinutes);
    updateAnimation(w, slot, dtMinutes);
  } catch (err) {
    // One broken animal must never take the world down with it.
    console.error('[sim] creature error', err, { slot, species: sp.key });
    w.reportError('creature:simulate', err);
    c.action[slot] = Action.Idle;
    c.thinkTimer[slot] = 2;
    c.speed[slot] = 0;
    c.hasTarget[slot] = 0;
  }

  // 5. Bookkeeping that must happen even if the animal errored.
  c.recordTrail(slot, dtMinutes);
  c.forgetWeakMemories(slot, dtMinutes);
}

/* ------------------------------------------------------------------ */
/* Reproduction                                                        */
/* ------------------------------------------------------------------ */

export function updatePregnancy(w: World, slot: number, dtMinutes: number): void {
  const c = w.creatures;
  const sp = c.species(slot);
  const days = dtMinutes / TIME.minutesPerDay;

  if (c.breedCooldown[slot] > 0) c.breedCooldown[slot] = Math.max(0, c.breedCooldown[slot] - days);
  if (c.nursingMinutes[slot] > 0) c.nursingMinutes[slot] = Math.max(0, c.nursingMinutes[slot] - dtMinutes);

  if (c.pregnantLeft[slot] <= 0) return;
  // Pregnancy is expensive: the mother burns reserves and eats more.
  c.energy[slot] = Math.max(0, c.energy[slot] - days * 0.004 * Math.max(1, c.fetusCount[slot]));
  c.hunger[slot] = clamp01(c.hunger[slot] + days * 0.02);
  c.pregnantLeft[slot] -= days;
  if (c.pregnantLeft[slot] > 0) return;

  // Birth. Females return to their den if they have one; otherwise they drop
  // the litter where they are, which is exactly when predators do well.
  const born = giveBirth(w, slot);
  c.pregnancyCount[slot]++;
  for (const id of born) {
    const child = c.findByLivingId(id);
    if (child < 0) continue;
    c.dependentOf[child] = c.id[slot];
    c.weaned[child] = 0;
    c.hasTarget[child] = 0;
    if (c.hasHome[slot]) {
      c.homeX[child] = c.homeX[slot];
      c.homeY[child] = c.homeY[slot];
      c.homeKind[child] = c.homeKind[slot];
      c.hasHome[child] = 1;
    }
  }
  if (born.length) {
    c.birthsTotal += born.length;
    for (let i = 0; i < born.length; i++) w.census.recordBirth(c.speciesIdx[slot]);
    w.onBirth?.(slot, c.mateId[slot], born);
    w.pushEvent({
      kind: 'birth',
      title: `${born.length} ${born.length === 1 ? sp.name.toLowerCase() : `${sp.name.toLowerCase()}s`} born`,
      detail: `A litter was born in the ${w.terrain.regionNameAt(c.x[slot], c.y[slot])}. The mother will nurse for about ${Math.round(sp.parentalCareDays)} days.`,
      weight: sp.massKg > 40 ? 2 : 1,
      speciesId: sp.key,
      organismId: c.id[slot],
      x: c.x[slot],
      y: c.y[slot],
    });
  }
}

/* ------------------------------------------------------------------ */
/* Growth and family                                                   */
/* ------------------------------------------------------------------ */

function updateGrowth(w: World, slot: number, dtMinutes: number): void {
  const c = w.creatures;
  const sp = c.species(slot);
  const days = dtMinutes / TIME.minutesPerDay;
  c.ageDays[slot] += days;
  // The renderer and the physiology both read this: juveniles are small.
  const scale = c.bodyScale(slot);
  c.size[slot] = scale;
  c.updateStage(slot);
  // Weaning: a juvenile stops depending on its mother once it can forage.
  if (!c.weaned[slot] && c.ageDays[slot] > sp.weaningDays) {
    c.weaned[slot] = 1;
    c.dependentOf[slot] = -1;
  }
  // Juveniles are bad at everything: they tire faster and lose heat faster.
  if (c.stage[slot] === Stage.Juvenile) {
    c.fatigue[slot] = clamp01(c.fatigue[slot] + days * 0.02);
  }
}

function updateFamily(w: World, slot: number, dtMinutes: number): void {
  const c = w.creatures;
  const sp = c.species(slot);

  // Young animals stay with their mother: they follow her, and she stays near
  // the den while they cannot keep up.
  const motherId = c.dependentOf[slot];
  if (motherId >= 0 && c.stage[slot] === Stage.Juvenile) {
    const mother = c.findByLivingId(motherId);
    if (mother < 0) {
      c.dependentOf[slot] = -1;
    } else {
      const d = Math.hypot(c.x[mother] - c.x[slot], c.y[mother] - c.y[slot]);
      if (d > 9 && (c.hasTarget[slot] === 0 || c.action[slot] === Action.Idle || c.action[slot] === Action.Wander)) {
        c.action[slot] = Action.Nurture;
        c.setTarget(slot, c.x[mother], c.y[mother], 12);
      }
      // Nursing: close to mother and she still has milk = a real meal.
      if (c.nursingMinutes[mother] > 0 && d < 6 && c.hunger[slot] > 0.25) {
        c.hunger[slot] = clamp01(c.hunger[slot] - dtMinutes * 0.02);
        c.thirst[slot] = clamp01(c.thirst[slot] - dtMinutes * 0.006);
        c.energy[slot] = clamp01(c.energy[slot] + dtMinutes * 0.004);
        c.nursingMinutes[mother] = Math.max(0, c.nursingMinutes[mother] - dtMinutes * 0.25);
      }
    }
  }

  // Mothers do not abandon young: while nursing, they keep the litter in range.
  if (c.nursingMinutes[slot] > 0 && c.hasHome[slot]) {
    const d = Math.hypot(c.homeX[slot] - c.x[slot], c.homeY[slot] - c.y[slot]);
    if (d > 70 && (c.action[slot] === Action.Wander || c.action[slot] === Action.Idle || c.action[slot] === Action.Forage)) {
      c.action[slot] = Action.ReturnHome;
      c.setTarget(slot, c.homeX[slot], c.homeY[slot], 45);
    }
  }

  // Ageing animals rest more and defend less.
  if (c.stage[slot] === Stage.Aged && c.fatigue[slot] > 0.7 && (c.action[slot] === Action.Hunt || c.action[slot] === Action.Patrol)) {
    c.action[slot] = Action.Rest;
    c.clearTarget(slot);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering support                                                   */
/* ------------------------------------------------------------------ */

function updateAnimation(w: World, slot: number, dtMinutes: number): void {
  const c = w.creatures;
  const sp = c.species(slot);
  // Gait frequency: small legs move faster than big ones.
  const gait = 2.4 / Math.max(0.4, Math.sqrt(Math.max(0.2, sp.bodyLength)));
  const speed01 = clamp01(c.speed[slot] / Math.max(0.01, sp.runSpeed));
  const resting = c.action[slot] === Action.Rest || c.action[slot] === Action.Rest || c.action[slot] === Action.Hide;
  const cadence = resting ? 0.15 : 0.35 + speed01 * 2.6;
  c.animPhase[slot] = (c.animPhase[slot] + dtMinutes * gait * cadence) % (Math.PI * 200);
  c.animSpeed[slot] = speed01;
  // Activity level feeds thermoregulation, disease vectors and the insector.
  const target = clamp01(speed01 * 1.4 + (resting ? 0 : 0.2));
  c.movementActivity[slot] += (target - c.movementActivity[slot]) * Math.min(1, dtMinutes / 30);

  // Sleeping animals pick a sheltered spot; if they are exposed at night, that
  // is a real risk (cold, predation) rather than a cosmetic state.
  if (c.action[slot] === Action.Rest) {
    const cover = w.terrain.canopyAtWorld(c.x[slot], c.y[slot]) + w.vegetation.coverAt(c.x[slot], c.y[slot]);
    c.warmth[slot] = clamp01(c.warmth[slot] + (cover > 0.4 ? dtMinutes * 0.0006 : 0));
    if (c.rng.chance(dtMinutes * 0.00002)) c.remember(slot, MemKind.Den, c.x[slot], c.y[slot], 0.4);
  }

  // A predator that is hunting memorises the ground it just covered so it can
  // work the same area again tomorrow.
  if (c.action[slot] === Action.Hunt && c.rng.chance(dtMinutes * 0.00004)) {
    c.remember(slot, MemKind.Food, c.x[slot], c.y[slot], 0.3);
  }

  void activityFactor;
}
