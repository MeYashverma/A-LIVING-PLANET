import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES, } from '../src/life/species';
import { TIME } from '../src/core/config';

const w = new World(defaultParams(process.argv[2] ?? 'births', 'Births'));
const c = w.creatures;
const name = (i: number) => SPECIES[c.speciesIdx[i]].key;
const causes: Record<string, number> = {};
const causeBySpecies: Record<string, number> = {};
c.onDeath = (slot, speciesIdx, cause) => {
  causes[cause] = (causes[cause] ?? 0) + 1;
  const k = `${SPECIES[speciesIdx].key}:${cause}`;
  causeBySpecies[k] = (causeBySpecies[k] ?? 0) + 1;
};

let mating = 0;
const origBegin = w.beginPregnancy.bind(w);
w.beginPregnancy = (female: number, male: number) => {
  mating++;
  console.log(`  MATING ${name(female)}#${c.id[female]} x ${name(male)}#${c.id[male]} at min ${w.clock.minutes.toFixed(0)}`);
  origBegin(female, male);
};
c.onBirth = (slot, mateId, born) => console.log(`  BIRTH ${name(slot)}#${c.id[slot]} litter ${born.length} at day ${w.clock.day}`);

for (let day = 0; day < 30; day++) {
  for (let i = 0; i < 720; i++) w.step(2);
  if (day % 5 === 0 || day < 3) {
    const pregnant: string[] = [];
    for (let i = 0; i < c.capacity; i++) {
      if (c.alive[i] && c.pregnantLeft[i] > 0) pregnant.push(`${name(i)}#${c.id[i]}:${c.pregnantLeft[i].toFixed(1)}d`);
    }
    const breedable: string[] = [];
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const sp = SPECIES[c.speciesIdx[i]];
      const seasonOk = !sp.breedingSeasons.length || sp.breedingSeasons.includes(w.clock.seasonIndex);
      const mature = c.ageDays[i] >= sp.maturityYears * TIME.daysPerYear;
      if (seasonOk && mature && c.health[i] > 0.4 && c.energy[i] > 0.4) breedable.push(name(i));
    }
    const counts: Record<string, number> = {};
    for (const k of breedable) counts[k] = (counts[k] ?? 0) + 1;
    const alive: Record<string, number> = {};
    for (let i = 0; i < c.capacity; i++) if (c.alive[i]) alive[name(i)] = (alive[name(i)] ?? 0) + 1;
    console.log(`day ${day} ${w.clock.season} alive ${c.count} matings ${mating} births ${c.birthsTotal} pregnant ${pregnant.length} | ${JSON.stringify(alive)}`);
    console.log(`      deaths ${JSON.stringify(causes)}`);
    console.log(`      ${JSON.stringify(causeBySpecies)}`);
  }
}
console.log('total matings', mating, 'births', c.birthsTotal);
