import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { Action } from '../src/life/organism';

const w = new World(defaultParams(process.argv[2] ?? 'acts', 'Acts'));
const c = w.creatures;
const name = (a: number) => Object.entries(Action).find(([, v]) => v === a)?.[0] ?? String(a);

const tally: Record<string, Record<string, number>> = {};
const hungerOf: Record<string, { sum: number; n: number; hungry: number }> = {};

for (let day = 0; day < 3; day++) {
  for (let slot = 0; slot < 24; slot++) {
    for (let i = 0; i < 30; i++) w.step(2);
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const key = SPECIES[c.speciesIdx[i]].key;
      tally[key] = tally[key] ?? {};
      tally[key][name(c.action[i])] = (tally[key][name(c.action[i])] ?? 0) + 1;
      const h = (hungerOf[key] = hungerOf[key] ?? { sum: 0, n: 0, hungry: 0 });
      h.sum += c.hunger[i];
      h.n++;
      if (c.hunger[i] > 0.7) h.hungry++;
    }
  }
  for (const key of Object.keys(tally)) {
    const t = tally[key];
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    const top = Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k} ${((v / total) * 100).toFixed(0)}%`)
      .join(' ');
    const h = hungerOf[key];
    console.log(`day ${day} ${key.padEnd(7)} meanHunger ${(h.sum / h.n).toFixed(2)} hungry>0.7 ${((h.hungry / h.n) * 100).toFixed(0)}% | ${top}`);
  }
  console.log('');
}
