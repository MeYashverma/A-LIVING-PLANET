import { World } from '../src/world/world';
import { defaultParams } from '../src/world/terrain';
const w = new World(defaultParams(process.argv[2] ?? 'births', 'Agg'));
const agg = w.aggregates as unknown as { species: { key: string }[]; means: Record<string, number>; patches: { key?: string; avail: Float32Array }[] };
const keys = agg.species.map((s) => s.key);
for (let day = 0; day < 12; day++) {
  for (let i = 0; i < 720; i++) w.step(2);
  const disease = w.disease.summary(0);
  const pathogens = w.disease.pathogens.map((p) => `${p.key ?? '?'}`).join(',');
  console.log(
    `day ${day} alive ${w.creatures.count} agg ${keys.map((k) => `${k}=${agg.means[k].toFixed(3)}`).join(' ')} disease pressure ${(w.disease as unknown as { pressure: number }).pressure.toFixed(2)} pathogens [${pathogens}]`,
  );
  void disease;
}
