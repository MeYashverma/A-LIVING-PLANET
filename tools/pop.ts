import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { TIME } from '../src/core/config';

const days = Number(process.argv[2] ?? 10);
const w = new World(defaultParams(process.argv[3] ?? 'pop', 'Population'));
const c = w.creatures;
const causes: Record<string, number> = {};
c.onDeath = (_s, _sp, cause) => { causes[cause] = (causes[cause] ?? 0) + 1; };
const steps = Math.ceil((days * TIME.minutesPerDay) / 2);
const log: string[] = [];
for (let i = 0; i < steps; i++) {
  w.step(2);
  if (i % 720 === 0) {
    w.census.update(w, true);
    const row = SPECIES.map((sp) => `${sp.tag}${String(w.census.get(sp.key)?.count ?? 0).padStart(3)}`).join(' ');
    log.push(`day ${String(Math.round(w.clock.day)).padStart(3)} | ${row} | veg ${w.vegetation.stats.biomass.toFixed(3)} | births ${c.birthsTotal} | ${JSON.stringify(causes)}`);
  }
}
console.log(log.join('\n'));
console.log('alive', c.count, 'gen max', Math.max(...SPECIES.map((sp) => w.census.get(sp.key)?.maxGeneration ?? 0)));
