import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
const w = new World(defaultParams('births', 'Rab'));
const c = w.creatures;
const ri = SPECIES.findIndex((s) => s.key === 'rabbit');
for (let hour = 0; hour <= 72; hour += 8) {
  let n = 0, hunger = 0, energy = 0, bite = 0, hungry = 0, thin = 0;
  for (let i = 0; i < c.capacity; i++) {
    if (!c.alive[i] || c.speciesIdx[i] !== ri) continue;
    n++;
    hunger += c.hunger[i]; energy += c.energy[i];
    if (c.hunger[i] > 0.7) hungry++;
    const f = w.vegetation.forageAt(c.x[i], c.y[i], SPECIES[ri].plantDiet);
    bite += f.amount;
    if (f.amount < 0.05) thin++;
  }
  console.log(`h${hour} rabbits ${n} hunger ${(hunger / Math.max(1, n)).toFixed(2)} energy ${(energy / Math.max(1, n)).toFixed(2)} hungry ${hungry} bite ${(bite / Math.max(1, n)).toFixed(3)} thinGround ${thin}`);
  for (let i = 0; i < 8 * 60; i++) w.step(1);
}
