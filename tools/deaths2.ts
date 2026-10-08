import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';

const seed = process.argv[2] ?? 'births';
const w = new World(defaultParams(seed, 'Deaths'));
const c = w.creatures;
const name = (i: number) => SPECIES[c.speciesIdx[i]].key;

let deaths = 0;
const byCause: Record<string, number> = {};
const bySpecies: Record<string, number> = {};
const samples: { hunger: number; energy: number; thirst: number; n: number }[] = [];
c.onDeath = (slot, speciesIdx, cause) => {
  deaths++;
  byCause[cause] = (byCause[cause] ?? 0) + 1;
  bySpecies[name(slot)] = (bySpecies[name(slot)] ?? 0) + 1;
  if (cause === 'dehydration' && byCause[cause] <= 4) {
    const reach = w.hydrology.waterReach(c.x[slot], c.y[slot]);
    console.log(
      `  THIRST ${SPECIES[speciesIdx].key} at ${c.x[slot].toFixed(0)},${c.y[slot].toFixed(0)} thirst=${c.thirst[slot].toFixed(2)} reach=${reach ? `${Math.hypot(reach.x - c.x[slot], reach.y - c.y[slot]).toFixed(0)}m` : 'none'} act=${c.action[slot]} hasTarget=${c.hasTarget[slot]} goal=${c.goalKind?.[slot]} inWater=${c.inWater[slot]} depth=${w.terrain.waterAtWorld(c.x[slot], c.y[slot]).toFixed(2)}`,
    );
  }
  if (deaths <= 12 || deaths % 25 === 0) {
    console.log(
      `  min ${w.clock.minutes.toFixed(0)} ${SPECIES[speciesIdx].key} cause=${cause} hunger=${c.hunger[slot].toFixed(2)} thirst=${c.thirst[slot].toFixed(2)} energy=${c.energy[slot].toFixed(2)} hp=${c.health[slot].toFixed(2)} inj=${c.injury[slot].toFixed(2)} age=${(c.ageDays[slot] / 365).toFixed(2)}y act=${c.action[slot]}`,
    );
  }
};

for (let hour = 0; hour < 72; hour++) {
  for (let i = 0; i < 60; i++) w.step(1);
  if (hour % 6 === 0) {
    let n = 0, hunger = 0, energy = 0, thirst = 0, hp = 0;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      n++; hunger += c.hunger[i]; energy += c.energy[i]; thirst += c.thirst[i]; hp += c.health[i];
    }
    console.log(
      `h${String(hour).padStart(2)} alive ${n} mean hunger ${(hunger / n).toFixed(2)} thirst ${(thirst / n).toFixed(2)} energy ${(energy / n).toFixed(2)} hp ${(hp / n).toFixed(2)} | temp ${w.climate.temperatureAt(0, 0).toFixed(1)} rain ${w.climate.rainIntensity.stats().mean.toFixed(2)} | deaths ${deaths} ${JSON.stringify(byCause)}`,
    );
    void samples;
  }
}
console.log('by species', JSON.stringify(bySpecies));
