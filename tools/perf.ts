import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

function populate(w: World, per: number) {
  for (let s = 0; s < SPECIES.length; s++) {
    const sp = SPECIES[s];
    if (['plankton', 'mouse', 'insect'].includes(sp.key)) continue;
    for (let k = 0; k < per * 3; k++) {
      const x = w.rng.range(-w.terrain.half + 30, w.terrain.half - 30);
      const y = w.rng.range(-w.terrain.half + 30, w.terrain.half - 30);
      const ci = Math.round(w.terrain.worldToCellY(y)) * w.terrain.size + Math.round(w.terrain.worldToCellX(x));
      if (!w.terrain.land[ci]) continue;
      const slot = w.creatures.spawn({ speciesIdx: s, x, y, ageDays: w.rng.range(sp.maturityYears, sp.maturityYears * 2.2) * 365, energy: 0.85 });
      if (slot >= 0) w.creatures.grid.insert(slot, x, y);
      if (w.creatures.census.count[s] >= per) break;
    }
  }
}

function bench(label: string, perSpecies: number, steps: number) {
  const w = new World(defaultParams('bench' + perSpecies, 'Bench'));
  populate(w, perSpecies);
  for (let i = 0; i < 30; i++) w.step(2);
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) w.step(2);
  const ms = (performance.now() - t0) / steps;
  console.log(`${label.padEnd(22)} animals ${String(w.creatures.count).padStart(4)}  ${ms.toFixed(2)} ms/step  (sim days/s at 1x = ${(1000 / ms * 2 / 1440 * 60).toFixed(1)})`);
  return ms;
}
bench('light (10/species)', 10, 70);
bench('medium (40/species)', 40, 70);
bench('heavy (120/species)', 120, 70);
