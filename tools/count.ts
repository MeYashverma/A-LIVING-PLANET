import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';

const w = new World(defaultParams('count', 'Count'));
const cl = w.climate as any;
const counts: Record<string, number> = {};
function instrument(key: string) {
  const orig = cl[key].bind(cl);
  counts[key] = 0;
  cl[key] = (...a: any[]) => { counts[key]++; return orig(...a); };
}
instrument('diurnalAnomaly');
instrument('seasonalAnomaly');
instrument('temperatureAt');
instrument('temperatureAtCellFast');
instrument('precipitationAtCellFast');
const origRefresh = cl['ensureCaches'].bind(cl);
counts['ensureCaches'] = 0;
cl['ensureCaches'] = () => { counts['ensureCaches']++; return origRefresh(); };
const steps = 20;
for (let i = 0; i < steps; i++) w.step(2);
console.log('per step:', Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round(v / steps)])));
console.log('weatherGrid', cl.size, 'cellUnits', cl.cellUnits, 'terrain', w.terrain.size);
