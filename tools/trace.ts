import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

const seed = process.argv[2] ?? 'trace';
const w = new World(defaultParams(seed, 'Trace'));
const c = w.creatures;

// Follow one individual of a few species.
const watch: Record<string, number> = {};
for (let s = 0; s < SPECIES.length; s++) {
  for (let i = 0; i < c.capacity; i++) {
    if (c.alive[i] && c.speciesIdx[i] === s) {
      watch[SPECIES[s].key] = i;
      break;
    }
  }
}

const deathTally: Record<string, number> = {};
const perSpeciesDeath: Record<string, Record<string, number>> = {};
c.onDeath = (slot, speciesIdx, cause) => {
  deathTally[cause] = (deathTally[cause] ?? 0) + 1;
  const key = SPECIES[speciesIdx].key;
  perSpeciesDeath[key] = perSpeciesDeath[key] ?? {};
  perSpeciesDeath[key][cause] = (perSpeciesDeath[key][cause] ?? 0) + 1;
  if (cause === 'starvation' && deathTally[cause] <= 6) {
    const sp = SPECIES[speciesIdx];
    const forage = w.vegetation.forageAt(c.x[slot], c.y[slot], sp.plantDiet);
    const agg = sp.aggregatePrey.map((k) => `${k}:${w.aggregates.availableAt(k, c.x[slot], c.y[slot]).toFixed(2)}`).join(' ');
    const stage = ['juv', 'sub', 'ad', 'aged'][c.stage?.[slot] ?? 2];
    console.log(
      `  starvation: ${key} age=${(c.ageDays[slot] / 365).toFixed(2)}y ${stage} hp=${c.health[slot].toFixed(2)} last meal ${c.lastMealHours[slot]?.toFixed(1) ?? '?'}h act=${c.action[slot]} target=${c.hasTarget[slot]} dep=${c.dependentOf[slot]} forage=${forage.amount.toFixed(3)} agg[${agg}] at ${c.x[slot].toFixed(0)},${c.y[slot].toFixed(0)}`,
    );
  }
  if (cause === 'disease' && deathTally[cause] <= 3) {
    console.log(`  disease: ${key} load=${c.immuneLoad?.[slot] ?? '?'} at ${c.x[slot].toFixed(0)},${c.y[slot].toFixed(0)}`);
  }
};
const birthTally: Record<string, number> = {};
c.onBirth = (slot) => {
  const key = SPECIES[c.speciesIdx[slot]].key;
  birthTally[key] = (birthTally[key] ?? 0) + 1;
};

console.log('species        slot hp hunger thirst energy warmth age(d) sex  aimed');
for (let day = 0; day <= 20; day++) {
  if (day % 2 === 0) {
    for (const [key, slot] of Object.entries(watch)) {
      if (!c.alive[slot]) { console.log(`${key.padEnd(14)} dead`); delete watch[key]; continue; }
      const i = slot;
      console.log(
        `${key.padEnd(14)} ${String(i).padStart(4)} ${c.health[i].toFixed(2)} ${c.hunger[i].toFixed(2)}  ${c.thirst[i].toFixed(2)}  ${c.energy[i].toFixed(2)}  ${c.warmth[i].toFixed(2)}  ${(c.ageDays[i] / 365).toFixed(2)}  ${c.sex[i] === 1 ? 'F' : 'M'}  ${(c.reason[i] ?? '').slice(0, 22)}`,
      );
    }
    const alive = c.count;
    const dis = w.disease.pathogens.map((p) => `${SPECIES[p.speciesIdx]?.key}:${p.infected ?? '?'}`).join(' ');
    console.log(`--- day ${day} alive ${alive} veg ${w.vegetation.stats.biomass.toFixed(3)} diseasePressure ${w.disease.pressure.toFixed(2)} [${dis}] births ${JSON.stringify(birthTally)} deaths ${JSON.stringify(deathTally)}`);
    if (day <= 4) console.log('    by species:', JSON.stringify(perSpeciesDeath));
  }
  for (let i = 0; i < 120; i++) w.step(12);
}
