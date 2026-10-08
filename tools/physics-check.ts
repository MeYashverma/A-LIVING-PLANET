// Physics regression check: ground animals must never sit below the terrain
// and must never end a step inside a tree trunk. Run with:
//   npx esbuild tools/physics-check.ts --bundle --platform=node --format=esm --outfile=/tmp/physics-check.mjs
//   node /tmp/physics-check.mjs [days]
import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

const days = Number(process.argv[2] ?? 3);
const w = new World(defaultParams('physics', 'Physics'));
const c = w.creatures;
const t = w.terrain;
const store = w.forest.store;
const trunkBuf = new Int32Array(32);
const trunkScratch = new Int32Array(256);

let samples = 0;
let belowGround = 0;
let worstBelow = 0;
let inTrunk = 0;
const perSpecies: Record<string, { below: number; trunk: number }> = {};

for (let day = 0; day < days; day++) {
  for (let i = 0; i < 720; i++) {
    w.step(2);
    for (let s = 0; s < c.capacity; s++) {
      if (!c.alive[s]) continue;
      const sp = SPECIES[c.speciesIdx[s]];
      const key = sp.key;
      perSpecies[key] ??= { below: 0, trunk: 0 };
      samples++;
      if (sp.locomotion !== 'fish' && !c.flying[s]) {
        const ground = t.elevationAtWorld(c.x[s], c.y[s]);
        const gap = ground - c.z[s];
        if (gap > 0.005) {
          belowGround++;
          perSpecies[key].below++;
          worstBelow = Math.max(worstBelow, gap);
        }
        const near = store.queryNear(c.x[s], c.y[s], 2, trunkBuf, trunkScratch);
        for (let k = 0; k < near; k++) {
          const tr = trunkBuf[k];
          const trunk = Math.min(0.6, Math.max(0.1, store.height[tr] * 0.035));
          const d = Math.hypot(store.x[tr] - c.x[s], store.y[tr] - c.y[s]);
          if (d < trunk * 0.6) {
            inTrunk++;
            perSpecies[key].trunk++;
            break;
          }
        }
      }
    }
  }
}
console.log(`samples=${samples} belowGround=${belowGround} worstBelowM=${worstBelow.toFixed(3)} inTrunk=${inTrunk}`);
console.log(JSON.stringify(perSpecies));
