import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { Action } from '../src/life/organism';
import { perceive, newPerceived, decide } from '../src/life/ai';

const p0 = newPerceived();
let probed = false;

const w = new World(defaultParams(process.argv[2] ?? 'births', 'Thirst'));
const c = w.creatures;
const name = (i: number) => SPECIES[c.speciesIdx[i]].key;
const act = (a: number) => Object.entries(Action).find(([, v]) => v === a)?.[0] ?? String(a);

// Ring buffer of the last few hours for every living animal.
const HIST = 24;
const hist: Map<number, string[]> = new Map();
const note = (i: number, line: string) => {
  const arr = hist.get(i) ?? [];
  arr.push(line);
  if (arr.length > HIST) arr.shift();
  hist.set(i, arr);
};

c.onDeath = (slot, speciesIdx, cause) => {
  if (cause !== 'dehydration') return;
  const reach = w.hydrology.waterReach(c.x[slot], c.y[slot]);
  console.log(`\n=== ${SPECIES[speciesIdx].key}#${c.id[slot]} died of thirst at minute ${w.clock.minutes.toFixed(0)}`);
  console.log(`    pos ${c.x[slot].toFixed(0)},${c.y[slot].toFixed(0)} reach ${reach ? reach.distance.toFixed(1) + 'm' : 'none'} juvenile=${c.stage[slot] === 0} dependent=${c.dependentOf[slot]}`);
  for (const line of hist.get(slot) ?? []) console.log('    ' + line);
};

for (let step = 0; step < 24 * 20; step++) {
  for (let i = 0; i < c.capacity; i++) {
    if (!c.alive[i]) continue;
    const reach = w.hydrology.waterReach(c.x[i], c.y[i]);
    if (!probed && c.thirst[i] > 0.97 && c.action[i] === Action.Forage) {
      probed = true;
      perceive(w, i, p0);
      const before = c.action[i];
      console.log(
        `PROBE ${name(i)}#${c.id[i]} action ${act(before)} thirst ${c.thirst[i].toFixed(2)} hasWater=${p0.hasWater} water=${p0.waterX.toFixed(0)},${p0.waterY.toFixed(0)} hasFood=${p0.hasFood} foodQ=${p0.foodQuality.toFixed(2)} threat=${p0.threatSlot}`,
      );
      decide(w, i, p0);
      console.log(`      decide() -> ${act(c.action[i])} (was ${act(before)})`);
      probed = false;
    }
    note(
      i,
      `t=${w.clock.minutes.toFixed(0)} ${name(i)}#${c.id[i]} thirst=${c.thirst[i].toFixed(2)} hp=${c.health[i].toFixed(2)} ${act(c.action[i])}${c.hasTarget[i] ? '>' : ''} goal=${c.goalKind?.[i]} target=${c.targetX[i].toFixed(0)},${c.targetY[i].toFixed(0)} reach=${reach ? reach.distance.toFixed(0) : 'none'}`,
    );
  }
  w.step(15);
  if (w.clock.minutes > 3 * 1440) break;
}
console.log('survivors', c.count, 'deaths by thirst recorded above');
