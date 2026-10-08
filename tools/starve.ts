import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

const w = new World(defaultParams(process.argv[2] ?? 'starve', 'Star'));
const c = w.creatures;
const buckets: Record<string, number> = {};
const orig = c.onDeath;
const key = (si: number) => SPECIES[si].key;
c.onDeath = (slot, si, cause) => {
  if (cause === 'starvation') {
    const sp = SPECIES[si];
    const yrs = c.ageDays[slot] / 365;
    const stage = c.ageDays[slot] < sp.weaningDays ? 'unweaned' : yrs < sp.maturityYears ? 'juvenile' : yrs > sp.maxAgeYears * 0.75 ? 'old' : 'adult';
    const k = `${key(si)}:${stage}`;
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  orig?.(slot, si, cause);
};
for (let day = 0; day < 30; day++) {
  for (let i = 0; i < 480; i++) w.step(3);
  if (day % 10 === 9) console.log(`day ${day + 1} alive ${c.count} ${JSON.stringify(buckets)}`);
}
console.log('starvation by stage', JSON.stringify(buckets));
