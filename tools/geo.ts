import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { BIOMES } from '../src/world/biomes';

const seed = process.argv[2] ?? 'geo';
const w = new World(defaultParams(seed, 'Geo'));
const t = w.terrain;
const n = t.size;
const N = n * n;

function pct(arr: Float32Array | Uint8Array, mask?: Uint8Array): number[] {
  const vals: number[] = [];
  for (let i = 0; i < arr.length; i++) if (!mask || mask[i]) vals.push(arr[i]);
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
  return [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)].map((v) => +v.toFixed(3));
}

const land = t.land;
const elev = new Float32Array(N);
for (let i = 0; i < N; i++) elev[i] = t.elevationOf(t.height.data[i]);

console.log('seed', seed, 'size', n, 'landPct', +(t.land.reduce((a, b) => a + b, 0) / N).toFixed(3));
console.log('elev  [5,25,50,75,95] land:', pct(elev, land), 'all:', pct(elev));
console.log('slope land:', pct(t.slope.data, land));
console.log('moist land:', pct(t.moistureMean.data, land));
console.log('temp  land:', pct(t.tempMean.data, land));
console.log('fert  land:', pct(t.fertility.data, land));
console.log('rain  land:', pct(t.rainfall.data, land));

const counts = new Map<number, number>();
for (let i = 0; i < N; i++) counts.set(t.biome.data[i], (counts.get(t.biome.data[i]) ?? 0) + 1);
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([b, c]) => `${BIOMES[b]?.name ?? b}:${c}(${((c / N) * 100).toFixed(1)}%)`);
console.log('biomes:', rows.join(' '));
const moistP = pct(t.moistureMean.data, land);
console.log('moist land p5..p95:', moistP, 'min', Math.min(...Array.from(t.moistureMean.data).filter((_, i) => land[i])).toFixed(3));

// Fraction of land that is high ground / steep.
let high = 0, steep = 0, alpine = 0;
for (let i = 0; i < N; i++) {
  if (!land[i]) continue;
  if (elev[i] > 13) high++;
  if (t.slope.data[i] > 0.62 && elev[i] > 8) steep++;
  if (t.biome.data[i] === 7) alpine++;
}
const landCount = land.reduce((a, b) => a + b, 0);
console.log('land elev>13:', (high / landCount * 100).toFixed(1) + '%', 'steep>0.62:', (steep / landCount * 100).toFixed(1) + '%', 'alpine:', (alpine / landCount * 100).toFixed(1) + '%');

// Vegetation: land-only layer means.
const names = ['grass', 'shrub', 'reed', 'algae', 'moss', 'xeric'];
const means = w.vegetation.plants.layers.map((l) => {
  let s = 0;
  for (let i = 0; i < N; i++) if (land[i]) s += l.data[i];
  return +(s / landCount).toFixed(3);
});
console.log('land veg means', names.map((k, i) => `${k}:${means[i]}`).join(' '));
console.log('trees', w.forest?.store?.statsAlive?.() ?? 'n/a', 'rivers', t.rivers.length, 'lakes', t.lakes.length);
