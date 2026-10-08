import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

const w = new World(defaultParams(process.argv[2] ?? 'die3', 'Die'));
const c = w.creatures;
const bySpecies: Record<string, number> = {};
const hunger: Record<string, number[]> = {};
const orig = c.onDeath;
c.onDeath = (slot, si, cause) => {
  const k = `${SPECIES[si].key}:${cause}`;
  bySpecies[k] = (bySpecies[k] ?? 0) + 1;
  orig?.(slot, si, cause);
};
for (let day = 0; day < 30; day++) {
  for (let i = 0; i < 480; i++) w.step(3);
  if (day % 5 === 4) {
    for (const k of Object.keys(hunger)) delete hunger[k];
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const k = SPECIES[c.speciesIdx[i]].key;
      (hunger[k] ??= []).push(c.hunger[i]);
    }
    const alive: Record<string, number> = {};
    for (let i = 0; i < c.capacity; i++) if (c.alive[i]) { const k = SPECIES[c.speciesIdx[i]].key; alive[k] = (alive[k] ?? 0) + 1; }
    const hs = Object.entries(hunger).map(([k, v]) => `${k} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}`).join(' ');
    console.log(`day ${day + 1} alive ${c.count} ${JSON.stringify(alive)}`);
    console.log(`   hunger ${hs}`);
  }
}
console.log('death causes', JSON.stringify(bySpecies));
