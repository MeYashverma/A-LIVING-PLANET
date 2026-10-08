import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { Action } from '../src/life/organism';
import { feedStats } from '../src/life/ai';

const w = new World(defaultParams('simtest', 'Trout'));
const c = w.creatures;
const agg = w.aggregates as any;
const ti = SPECIES.findIndex((s) => s.key === 'trout');
const ids: number[] = [];
for (let i = 0; i < c.capacity && ids.length < 3; i++) if (c.alive[i] && c.speciesIdx[i] === ti) ids.push(i);
console.log('trout slots', ids.join(','));
let prev = feedStats.perSpecies.trout ?? 0;
for (let step = 0; step <= 300; step++) {
  if (step % 25 === 0) {
    const ate = (feedStats.perSpecies.trout ?? 0) - prev;
    prev = feedStats.perSpecies.trout ?? 0;
    const parts = ids
      .filter((i) => c.alive[i])
      .map((i) => {
        const x = c.x[i];
        const y = c.y[i];
        const depth = w.terrain.waterAtWorld(x, y);
        return (
          '#' + i + ' hung=' + c.hunger[i].toFixed(2) + ' hp=' + c.health[i].toFixed(2) +
          ' warm=' + c.warmth[i].toFixed(2) + ' en=' + c.energy[i].toFixed(2) +
          ' d=' + depth.toFixed(2) + ' plank=' + agg.availableAt('plankton', x, y).toFixed(2) +
          ' ' + Action[c.action[i]]
        );
      });
    console.log('min ' + Math.round(w.clock.minutes) + ' (ate ' + ate.toFixed(2) + ') ' + parts.join(' | '));
  }
  w.step(2);
}
console.log('fed total', (feedStats.perSpecies.trout ?? 0).toFixed(2), 'kills', feedStats.kills);
