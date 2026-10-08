import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { BIOMES } from '../src/world/biomes';
import { ECOLOGY } from '../src/core/config';
import { clamp01 } from '../src/core/math';

const w = new World(defaultParams('grow', 'Grow'));
const t = w.terrain as any;
const v = w.vegetation as any;
console.log('lightFactor', v.lightFactor, 'tempFactor', v.tempFactor, 'pollination', v.pollination);
v.refreshConditions();
console.log('after refresh lightFactor', v.lightFactor, 'tempFactor', v.tempFactor, 'clock day', w.clock.day, 'dayOfYear', w.clock.dayOfYear, 'lightLevel', w.climate.lightLevel);
// sample 10 vegetated cells and compute the growth terms exactly as update() does
const n = t.size;
const picks = [0, 1, 2, 3, 4, 5].map(() => Math.round(Math.random() * (n * n - 1)));
for (const i of picks) {
  const cy = (i / n) | 0, cx = i % n;
  const def = BIOMES[t.biome.data[i]];
  const suit = def?.plants[0] ?? 0;
  const soil = t.fertility.data[i];
  const m = t.soilMoisture.data[i];
  const localTemp = t.tempMean.data[i];
  const canopied = t.canopy.data[i];
  const light = w.climate.lightLevel;
  const shade = clamp01(1 - canopied * 0.85);
  const frozen = clamp01((localTemp - 0.5) / 4);
  const lightHere = clamp01(light * 1.15) * shade * (1 - 0);
  const wetOK = clamp01(m * (1.35 - m * 0.25) * 1.5);
  const nutriOK = clamp01(0.2 + soil * 1.25);
  const waterFactor = wetOK;
  const tempFactor = clamp01(0.15 + (localTemp + 6) / 26) * (0.35 + 0.65 * frozen);
  const capacity = clamp01(suit * waterFactor * nutriOK * tempFactor * (0.35 + 0.65 * lightHere)) * 1.1;
  const b = v.plants.layers[0].data[i];
  const hours = 0.1;
  const growthRate = ECOLOGY.grassGrowthPerHour * hours * v.lightFactor;
  const room = clamp01(1 - b / Math.max(0.02, capacity));
  const growth = capacity > 0.01 && b > 0.0005 ? growthRate * b * (0.35 + room * 1.5) * 3.2 : 0;
  console.log(`cell ${cx},${cy} biome=${def?.name} suit=${suit.toFixed(2)} m=${m.toFixed(2)} soil=${soil.toFixed(2)} temp=${localTemp.toFixed(1)} lightHere=${lightHere.toFixed(2)} capacity=${capacity.toFixed(3)} b=${b.toFixed(3)} growth/update=${growth.toExponential(2)}`);
}
// how many cells have capacity > 0.01 for grass?
let ok = 0, total = 0, bsum = 0, capsum = 0;
for (let i = 0; i < n * n; i += 13) {
  const def = BIOMES[t.biome.data[i]];
  const suit = def?.plants[0] ?? 0;
  if (suit <= 0.001) continue;
  total++;
  const m = t.soilMoisture.data[i];
  const wetOK = clamp01(m * (1.35 - m * 0.25) * 1.5);
  const nutriOK = clamp01(0.2 + t.fertility.data[i] * 1.25);
  const localTemp = t.tempMean.data[i];
  const frozen = clamp01((localTemp - 0.5) / 4);
  const tempFactor = clamp01(0.15 + (localTemp + 6) / 26) * (0.35 + 0.65 * frozen);
  const capacity = clamp01(suit * wetOK * nutriOK * tempFactor * 0.85) * 1.1;
  if (capacity > 0.01) ok++;
  bsum += v.plants.layers[0].data[i]; capsum += capacity;
}
console.log('cells with grass suitability', total, 'capacity>0.01', ok, 'mean b', (bsum / total).toFixed(3), 'mean capacity', (capsum / total).toFixed(3));
console.log('unused?', ECOLOGY.grazeRate);
