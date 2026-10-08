import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { Action } from '../src/life/organism';
import { feedStats } from '../src/life/ai';

const w = new World(defaultParams('births', 'Rab'));
const c = w.creatures;
const ri = SPECIES.findIndex((s) => s.key === 'rabbit');
const name = (a: number) => Object.entries(Action).find(([, v]) => v === a)?.[0] ?? String(a);
let last = 0;
for (let hour = 0; hour <= 48; hour += 6) {
  let n = 0, hunger = 0, energy = 0, q = 0, by = 0, hungry = 0, act: Record<string, number> = {};
  for (let i = 0; i < c.capacity; i++) {
    if (!c.alive[i] || c.speciesIdx[i] !== ri) continue;
    n++; hunger += c.hunger[i]; energy += c.energy[i];
    if (c.hunger[i] > 0.7) hungry++;
    const f = w.vegetation.forageAt(c.x[i], c.y[i], SPECIES[ri].plantDiet);
    q += f.quality; by += f.amount;
    const a = name(c.action[i]);
    act[a] = (act[a] ?? 0) + 1;
  }
  const eaten = (feedStats.perSpecies['rabbit'] ?? 0) - last;
  last = feedStats.perSpecies['rabbit'] ?? 0;
  console.log(`h${hour} n${n} hunger ${(hunger / n).toFixed(2)} energy ${(energy / n).toFixed(2)} hungry ${hungry} q ${(q / n).toFixed(2)} bite ${(by / n).toFixed(3)} atePerHour ${(eaten / n / 6).toFixed(3)}`);
  console.log(`     ${Object.entries(act).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  for (let i = 0; i < 6 * 60; i++) w.step(1);
}
