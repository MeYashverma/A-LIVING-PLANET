import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
import { SPECIES } from '../src/life/species';
import { Action } from '../src/life/organism';
import { feedStats } from '../src/life/ai';

const w = new World(defaultParams('simtest', 'Pred'));
const agg = w.aggregates as any;
const c = w.creatures;
const keys = agg.species.map((s: any) => s.key);
console.log('aggregate keys', keys.join(','), 'means', keys.map((k: string) => `${k}=${agg.means[k].toFixed(3)}`).join(' '));
const watchers = ['wolf', 'fox', 'eagle', 'owl', 'raven', 'bear', 'trout', 'deer', 'rabbit'];
const idx = watchers.map((k) => SPECIES.findIndex((s) => s.key === k));
for (let step = 0; step <= 400; step++) {
  if (step % 100 === 0) {
    const lines: string[] = [];
    for (let wi = 0; wi < watchers.length; wi++) {
      let n = 0, h = 0, he = 0, inj = 0, inf = 0, eat = 0;
      for (let i = 0; i < c.capacity; i++) {
        if (!c.alive[i] || c.speciesIdx[i] !== idx[wi]) continue;
        n++; h += c.hunger[i]; he += c.health[i]; inj += c.injury[i]; inf += c.infection[i];
        eat += feedStats.perSpecies[watchers[wi]] ?? 0;
      }
      lines.push(`${watchers[wi]} n=${n} hung=${n ? (h / n).toFixed(2) : '-'} hp=${n ? (he / n).toFixed(2) : '-'} inj=${n ? (inj / n).toFixed(3) : '-'} inf=${n ? (inf / n).toFixed(2) : '-'} ate=${eat.toFixed(2)}`);
    }
    console.log(`--- min ${Math.round(w.clock.minutes)}`);
    console.log('   ' + lines.join('\n   '));
    console.log('   agg means', keys.map((k: string) => `${k}=${agg.means[k].toFixed(3)}`).join(' '), '| carcasses', (w.carcasses as any).all?.length ?? 'n/a');
  }
  w.step(2);
  void Action;
}
console.log('satisfaction by species', JSON.stringify(feedStats.perSpecies));
console.log(feedStats.trace.join('\n'));
console.log('cooldown by species', JSON.stringify(feedStats.cooldownBySpecies));
console.log('cooldown', feedStats.cooldownDenied, feedStats.cooldownSum.toFixed(1));
console.log('hunt stats', JSON.stringify({ sightings: feedStats.sightings, attacks: feedStats.attacks, kills: feedStats.kills, pSum: +feedStats.pSum.toFixed(2) }));
console.log('attack pairs', JSON.stringify(feedStats.attackPairs));
console.log('totals', JSON.stringify({ plants: feedStats.plants, insects: feedStats.insects, meat: feedStats.meat, carrion: feedStats.carrion, fish: feedStats.fish, calls: feedStats.calls }));
