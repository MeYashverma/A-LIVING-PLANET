import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { Action } from '../src/life/organism';

const seed = process.argv[2] ?? 'feed2';
const w = new World(defaultParams(seed, 'Feed'));
const c = w.creatures;

const watch: { key: string; slot: number }[] = [];
for (const key of ['rabbit', 'deer', 'bison', 'wolf', 'trout']) {
  const s = SPECIES.findIndex((sp) => sp.key === key);
  for (let i = 0; i < c.capacity; i++) if (c.alive[i] && c.speciesIdx[i] === s) { watch.push({ key, slot: i }); break; }
}

const actionName = (a: number) => Object.entries(Action).find(([, v]) => v === a)?.[0] ?? String(a);

for (let hour = 0; hour <= 36; hour += 3) {
  const parts: string[] = [];
  for (const { key, slot } of watch) {
    if (!c.alive[slot]) { parts.push(`${key}:dead`); continue; }
    const sp = SPECIES[c.speciesIdx[slot]];
    const forage = w.vegetation.forageAt(c.x[slot], c.y[slot], sp.plantDiet);
    parts.push(
      `${key} h${c.hunger[slot].toFixed(2)} e${c.energy[slot].toFixed(2)} hp${c.health[slot].toFixed(2)} ` +
        `${actionName(c.action[slot])}${c.hasTarget[slot] ? '>' : ''} bite${forage.amount.toFixed(3)} q${forage.quality.toFixed(2)}`,
    );
  }
  console.log(`h${String(hour).padStart(2)} ${parts.join(' | ')}`);
  for (let i = 0; i < 12; i++) w.step(15);
}
console.log('diets', watch.map(({ key }) => `${key}:${JSON.stringify(SPECIES.find((s) => s.key === key)!.plantDiet)}`).join(' '));
console.log('hungerHours', SPECIES.map((s) => `${s.key}:${s.hungerHours}`).join(' '));
