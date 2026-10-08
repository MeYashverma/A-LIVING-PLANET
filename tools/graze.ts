// Grazing budget probe: plant biomass vs herbivore condition, plus deaths by cause.
// Run: npx esbuild tools/graze.ts --bundle --platform=node --format=esm --outfile=/tmp/graze.mjs && node /tmp/graze.mjs <seed> <days>
import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

const seed = process.argv[2] ?? 'births';
const days = Number(process.argv[3] ?? 10);
const w = new World(defaultParams(seed, 'Graze'));
const c = w.creatures as any;
const herb = new Set(['rabbit', 'deer', 'bison', 'goat']);

const deaths: Record<string, number> = {};
const prev = c.onDeath;
c.onDeath = (slot: number, spIdx: number, cause: string) => {
  const k = SPECIES[spIdx].key;
  if (herb.has(k)) {
    deaths[`${k}:${cause}`] = (deaths[`${k}:${cause}`] ?? 0) + 1;
    if (cause === 'starvation') {
      const age = c.ageDays[slot] < 60 ? 'juv<60d' : c.ageDays[slot] < 365 ? 'sub<1y' : 'adult';
      const key = `${k}:starve:${age}`;
      deaths[key] = (deaths[key] ?? 0) + 1;
      deaths[`${k}:starve:lastMealH`] = Math.round(c.lastMealHours[slot]);
      const m = c.dependentOf[slot];
      const detail = `age=${c.ageDays[slot].toFixed(0)} weaned=${c.weaned[slot]} dep=${m} stage=${c.stage[slot]} act=${c.action[slot]} hunger=${c.hunger[slot].toFixed(2)} energy=${c.energy[slot].toFixed(2)} fat=${c.energy[slot].toFixed(2)} lastMealH=${c.lastMealHours[slot].toFixed(0)} motherAlive=${m >= 0 && c.findByLivingId(m) >= 0}`;
      if (process.env.DETAIL && Object.keys(deaths).length < 200) console.log('STARVE', k, detail);
    }
  }
  prev?.(slot, spIdx, cause);
};

const cons = { calls: 0, zero: 0, taken: 0, requested: 0 };
const origConsume = w.vegetation.consume.bind(w.vegetation);
(w.vegetation as any).consume = (x: number, y: number, diet: number[], req: number) => {
  const r = origConsume(x, y, diet, req);
  cons.calls++; cons.requested += req; cons.taken += r; if (r <= 0) cons.zero++;
  return r;
};
for (let day = 0; day < days; day++) {
  for (let i = 0; i < 720; i++) w.step(2);
  const s = w.vegetation.stats;
  const rows: string[] = [];
  for (const k of herb) {
    const cls: Record<string, { n: number; hunger: number; energy: number; forage: number; forageAct: number; act: Record<string, number> }> = {};
    let n = 0, hunger = 0, thin = 0, forage = 0;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const sp = SPECIES[c.speciesIdx[i]];
      if (sp.key !== k) continue;
      n++;
      hunger += c.hunger[i];
      const f = w.vegetation.forageAt(c.x[i], c.y[i], sp.plantDiet);
      forage += f.amount;
      if (f.amount < 0.05) thin++;
      const g = c.ageDays[i] < 146 ? 'juv' : 'adult';
      const e = (cls[g] ??= { n: 0, hunger: 0, energy: 0, forage: 0, forageAct: 0, act: {} });
      e.n++; e.hunger += c.hunger[i]; e.energy += c.energy[i]; e.forage += f.amount;
      const an = String(c.action[i]);
      e.act[an] = (e.act[an] ?? 0) + 1;
    }
    for (const g of Object.keys(cls)) {
      const e = cls[g];
      const top = Object.entries(e.act).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, v]) => `${a}:${v}`).join(',');
      rows.push(`  ${k}/${g} n=${e.n} hunger=${(e.hunger / e.n).toFixed(2)} energy=${(e.energy / e.n).toFixed(2)} forage=${(e.forage / e.n).toFixed(3)} actions[${top}]`);
    }
    if (n) rows.push(`${k} n=${n} hunger=${(hunger / n).toFixed(2)} forage=${(forage / n).toFixed(3)} thin=${thin}`);
  }
  if (process.env.HUNGRY && day === days - 1) {
    let shown = 0;
    for (let i = 0; i < c.capacity && shown < 25; i++) {
      if (!c.alive[i] || SPECIES[c.speciesIdx[i]].key !== 'rabbit') continue;
      if (c.lastMealHours[i] < 30) continue;
      shown++;
      const f = w.vegetation.forageAt(c.x[i], c.y[i], SPECIES[c.speciesIdx[i]].plantDiet);
      console.log('HUNGRY', `age=${c.ageDays[i].toFixed(0)} act=${c.action[i]} lastMealH=${c.lastMealHours[i].toFixed(0)} hunger=${c.hunger[i].toFixed(2)} energy=${c.energy[i].toFixed(2)} fear=${c.fear[i].toFixed(2)} sleep=${c.sleepiness?.[i]?.toFixed?.(2) ?? '-'} inWater=${c.inWater[i]} forageHere=${f.amount.toFixed(3)} q=${f.quality.toFixed(2)} hasTarget=${c.hasTarget[i]} tgtDist=${Math.hypot(c.targetX[i]-c.x[i], c.targetY[i]-c.y[i]).toFixed(1)}`);
    }
  }
  console.log(`day ${day} grass ${s.grass.toFixed(3)} | ${rows.join(' | ')}`);
}
console.log('CONSUME', JSON.stringify(cons));
console.log('deaths (count; lastMealH = last starved animal)', JSON.stringify(deaths));
