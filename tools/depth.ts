import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
const w = new World(defaultParams('simtest', 'Depth'));
const t = w.terrain;
const lake = t.lakeDepth.data;
const river = t.riverDepth.data;
const bands = [0.0004, 0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1];
for (const f of ['lakeDepth', 'riverDepth'] as const) {
  const a = f === 'lakeDepth' ? lake : river;
  let max = 0;
  const counts = bands.map(() => 0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] > max) max = a[i];
    for (let b = 0; b < bands.length; b++) if (a[i] > bands[b]) counts[b]++;
  }
  console.log(f, 'max', max.toFixed(4), 'counts>', bands.map((b, i) => `${b}:${counts[i]}`).join(' '));
}
console.log('rivers', t.rivers.length, 'lakes', (t as any).lakes?.length ?? 'n/a', 'seaLevel', t.params.seaLevel, 'size', t.size);
