import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { PLANT_LAYERS } from '../src/world/biomes';

const w = new World(defaultParams('veg', 'Veg'));
const t = w.terrain as any;
console.log('initial plant density per layer:', t.initialPlantDensity.map((f: any, i: number) => {
  let sum = 0, n = 0, max = 0;
  for (const v of f.data) { sum += v; if (v > max) max = v; n++; }
  return `${PLANT_LAYERS[i]}=${(sum / n).toFixed(3)}/max${max.toFixed(2)}`;
}).join(' '));
console.log('vegetation.stats at t0', JSON.stringify(w.vegetation.stats));

function sampleForage(label: string) {
  const rng = w.rng;
  let sum = 0, n = 0, nz = 0;
  const per: Record<string, number> = {};
  for (const sp of SPECIES) {
    let s = 0, c = 0;
    for (let i = 0; i < 300; i++) {
      const x = rng.range(-t.half + 20, t.half - 20);
      const y = rng.range(-t.half + 20, t.half - 20);
      const f = w.vegetation.forageAt(x, y, sp.plantDiet);
      sum += f.amount; n++; if (f.amount > 0.02) nz++;
      s += f.amount; c++;
    }
    per[sp.key] = s / c;
  }
  console.log(label, 'mean forage', (sum / n).toFixed(4), 'frac>0.02', (nz / n).toFixed(2), JSON.stringify(Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +(v as number).toFixed(3)]))));
}
sampleForage('t0 ');
// Freeze the animals and watch the plants.
for (let i = 0; i < w.creatures.capacity; i++) w.creatures.alive[i] = 0;
w.creatures.count = 0;
for (let h = 0; h < 24; h++) {
  for (let s = 0; s < 30; s++) w.step(2);
  if (h % 6 === 5) {
    for (let k = 0; k < w.vegetation.plants.count; k++) {
      const arr = w.vegetation.plants.layers[k].data;
      let sum = 0;
      for (let i = 0; i < arr.length; i += 41) sum += arr[i];
      console.log(`  hour ${h + 1} layer ${PLANT_LAYERS[k]} mean(sampled) ${(sum / (arr.length / 41)).toFixed(4)}`);
    }
    sampleForage(`  hour ${h + 1}`);
  }
}
