import type { Random } from '../core/rng';
import { clamp, clamp01 } from '../core/math';

/**
 * A genome is a small vector of heritable traits. Traits are deliberately
 * continuous (0..1) and trade off against each other through the energy budget
 * rather than through hard-coded rules: nothing stops a lineage from becoming
 * enormous and fast, it just starves trying.
 */
export interface TraitDef {
  key: string;
  label: string;
  /** Human-readable range for the inspector. */
  lo: number;
  hi: number;
  unit?: string;
  /** Per-generation mutation magnitude (as a fraction of the range). */
  mutation: number;
  /** How strongly the trait is expressed in the offspring (heritability). */
  heritability: number;
  desc: string;
  /** Traits the UI hides from the "primary" list. */
  secondary?: boolean;
}

export const ANIMAL_TRAITS: TraitDef[] = [
  { key: 'size', label: 'Size', lo: 0.6, hi: 1.75, mutation: 0.05, heritability: 0.85, desc: 'Body mass. Carries strength and cold tolerance, costs energy and speed.' },
  { key: 'speed', label: 'Speed', lo: 0.55, hi: 1.7, mutation: 0.05, heritability: 0.8, desc: 'Top sprint and travel speed.' },
  { key: 'stamina', label: 'Endurance', lo: 0.5, hi: 1.7, mutation: 0.05, heritability: 0.78, desc: 'How long exertion can be sustained before exhaustion.' },
  { key: 'vision', label: 'Vision', lo: 0.5, hi: 1.7, mutation: 0.05, heritability: 0.8, desc: 'Detection range for food, water and danger.' },
  { key: 'metabolism', label: 'Efficiency', lo: 0.6, hi: 1.5, mutation: 0.05, heritability: 0.7, desc: 'Metabolic efficiency — low values burn less for the same work.' },
  { key: 'coldTol', label: 'Cold tolerance', lo: 0.4, hi: 1.75, mutation: 0.06, heritability: 0.75, desc: 'Survival below freezing; frostbite risk and winter activity.' },
  { key: 'heatTol', label: 'Heat tolerance', lo: 0.4, hi: 1.75, mutation: 0.06, heritability: 0.75, desc: 'Tolerance of heat and water loss in arid conditions.' },
  { key: 'diseaseResist', label: 'Immunity', lo: 0.3, hi: 1.8, mutation: 0.07, heritability: 0.65, desc: 'Resistance to infection and faster recovery.' },
  { key: 'fertility', label: 'Fecundity', lo: 0.55, hi: 1.6, mutation: 0.05, heritability: 0.7, desc: 'Offspring count and conception chance.' },
  { key: 'lifespan', label: 'Longevity', lo: 0.6, hi: 1.6, mutation: 0.05, heritability: 0.72, desc: 'Maximum age and the rate of senescence.' },
  { key: 'camouflage', label: 'Camouflage', lo: 0.4, hi: 1.8, mutation: 0.07, heritability: 0.78, desc: 'How hard it is for predators or prey to spot this animal.' },
  { key: 'senseSmell', label: 'Scent', lo: 0.5, hi: 1.6, mutation: 0.06, heritability: 0.75, desc: 'Track detection, carcass finding and mate location by smell.' },
  { key: 'aggression', label: 'Aggression', lo: 0.2, hi: 1.8, mutation: 0.07, heritability: 0.6, desc: 'Willingness to fight, contest kills and defend territory.' },
  { key: 'socialness', label: 'Sociality', lo: 0.2, hi: 1.8, mutation: 0.06, heritability: 0.6, desc: 'Attraction to conspecifics and group cohesion.' },
  { key: 'boldness', label: 'Boldness', lo: 0.2, hi: 1.8, mutation: 0.07, heritability: 0.55, desc: 'Risk tolerance near predators and people-shaped things.' },
  { key: 'metabolicRange', label: 'Diet breadth', lo: 0.3, hi: 1.7, mutation: 0.06, heritability: 0.6, desc: 'Ability to extract energy from marginal or unfamiliar food.', secondary: true },
  { key: 'reproAge', label: 'Maturity', lo: 0.7, hi: 1.5, mutation: 0.05, heritability: 0.7, desc: 'Age at first breeding (low = earlier).', secondary: true },
];

export const TREE_TRAITS: TraitDef[] = [
  { key: 'growth', label: 'Growth rate', lo: 0.55, hi: 1.7, mutation: 0.06, heritability: 0.8, desc: 'Height gained per growing season.' },
  { key: 'droughtTol', label: 'Drought tolerance', lo: 0.4, hi: 1.8, mutation: 0.06, heritability: 0.78, desc: 'Survives dry soil without losing canopy.' },
  { key: 'coldTol', label: 'Cold tolerance', lo: 0.4, hi: 1.8, mutation: 0.06, heritability: 0.8, desc: 'Avoids frost die-back and winterkill.' },
  { key: 'shadeTol', label: 'Shade tolerance', lo: 0.3, hi: 1.7, mutation: 0.06, heritability: 0.7, desc: 'Can establish and persist under a closed canopy.' },
  { key: 'seedOutput', label: 'Seed output', lo: 0.5, hi: 1.8, mutation: 0.06, heritability: 0.75, desc: 'Seeds produced per year at maturity.' },
  { key: 'seedRange', label: 'Seed range', lo: 0.5, hi: 1.8, mutation: 0.07, heritability: 0.65, desc: 'Dispersal distance of offspring.' },
  { key: 'flammability', label: 'Flammability', lo: 0.4, hi: 1.7, mutation: 0.07, heritability: 0.7, desc: 'How readily it burns (some lineages are fire-adapted).' },
  { key: 'longevity', label: 'Longevity', lo: 0.6, hi: 1.6, mutation: 0.05, heritability: 0.7, desc: 'Maximum standing age.' },
];

export interface GenomeTemplate {
  traits: TraitDef[];
  keys: string[];
  index: Record<string, number>;
}

export function makeTemplate(traits: TraitDef[]): GenomeTemplate {
  const index: Record<string, number> = {};
  traits.forEach((t, i) => (index[t.key] = i));
  return { traits, keys: traits.map((t) => t.key), index };
}

export const ANIMAL_TEMPLATE = makeTemplate(ANIMAL_TRAITS);
export const TREE_TEMPLATE = makeTemplate(TREE_TRAITS);

/** Mid-range values for a template (a "neutral" individual). */
export function neutralValues(tpl: GenomeTemplate, rng?: Random, spread = 0): Float32Array {
  const v = new Float32Array(tpl.traits.length);
  for (let i = 0; i < v.length; i++) {
    const t = tpl.traits[i];
    const mid = (t.lo + t.hi) / 2;
    v[i] = rng && spread > 0 ? clamp(mid + rng.gauss() * spread * (t.hi - t.lo), t.lo, t.hi) : mid;
  }
  return v;
}

export class Genome {
  tpl: GenomeTemplate;
  values: Float32Array;
  /** Monotonic id of the lineage's mutation history, for the discovery feed. */
  generation: number;

  constructor(tpl: GenomeTemplate, values: Float32Array, generation = 1) {
    this.tpl = tpl;
    this.values = values;
    this.generation = generation;
  }

  get(key: string): number {
    const i = this.tpl.index[key];
    return i === undefined ? 0 : this.values[i];
  }

  getIndex(i: number): number {
    return this.values[i];
  }

  clone(): Genome {
    return new Genome(this.tpl, this.values.slice(), this.generation);
  }

  /** Blend two parents, then mutate. */
  static cross(a: Genome, b: Genome, rng: Random, mutationScale = 1): Genome {
    const tpl = a.tpl;
    const n = tpl.traits.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = tpl.traits[i];
      const av = a.values[i];
      const bv = b.values[i];
      // Blend with a random weight, then push toward an extreme occasionally
      // (recombination is not just averaging).
      let v = rng.chance(0.5) ? av : bv;
      if (rng.chance(0.35)) v = (av + bv) * 0.5 + rng.gauss() * 0.03;
      if (rng.chance(0.06)) v = rng.chance(0.5) ? av : bv;
      // Mutation.
      if (rng.chance(0.34 * mutationScale)) {
        const mag = t.mutation * (t.hi - t.lo) * (0.35 + rng.next() * 1.5) * mutationScale;
        v += rng.chance(0.5) ? mag : -mag;
        if (rng.chance(0.02)) v += rng.gauss() * t.mutation * (t.hi - t.lo) * 4;
      }
      out[i] = clamp(v, t.lo, t.hi);
    }
    return new Genome(tpl, out, Math.max(a.generation, b.generation) + 1);
  }

  /** Asexual/clonal offspring (used by plants and for clone tools). */
  static mutate(g: Genome, rng: Random, mutationScale = 1): Genome {
    const tpl = g.tpl;
    const out = g.values.slice();
    for (let i = 0; i < out.length; i++) {
      const t = tpl.traits[i];
      if (rng.chance(0.22 * mutationScale)) {
        out[i] = clamp(out[i] + (rng.chance(0.5) ? 1 : -1) * t.mutation * (t.hi - t.lo) * (0.3 + rng.next()), t.lo, t.hi);
      }
    }
    return new Genome(tpl, out, g.generation + 1);
  }

  static random(tpl: GenomeTemplate, rng: Random): Genome {
    const v = new Float32Array(tpl.traits.length);
    for (let i = 0; i < v.length; i++) {
      const t = tpl.traits[i];
      const mid = (t.lo + t.hi) / 2;
      const sd = (t.hi - t.lo) * 0.22;
      v[i] = clamp(mid + rng.gauss() * sd, t.lo, t.hi);
    }
    return new Genome(tpl, v, 1);
  }

  /** Distance used for the "genetic diversity" indicator. */
  static distance(a: Genome, b: Genome): number {
    let s = 0;
    for (let i = 0; i < a.values.length; i++) {
      const d = (a.values[i] - b.values[i]) / (a.tpl.traits[i].hi - a.tpl.traits[i].lo);
      s += d * d;
    }
    return Math.sqrt(s / a.values.length);
  }

  serialise(): number[] {
    return Array.from(this.values);
  }

  static deserialise(tpl: GenomeTemplate, arr: number[], generation: number): Genome {
    const v = new Float32Array(tpl.traits.length);
    for (let i = 0; i < v.length; i++) v[i] = clamp(arr[i] ?? 0.5, tpl.traits[i].lo, tpl.traits[i].hi);
    return new Genome(tpl, v, generation);
  }

  /** 0..1 "how remarkable" this individual is: distance from the population mean. */
  static anomaly(mean: Float32Array, g: Genome): { trait: string; z: number; dir: number } | null {
    let best: { trait: string; z: number; dir: number } | null = null;
    for (let i = 0; i < g.values.length; i++) {
      const t = g.tpl.traits[i];
      if (t.secondary) continue;
      const range = t.hi - t.lo;
      const z = (g.values[i] - mean[i]) / (range * 0.5);
      if (Math.abs(z) < 1.35) continue;
      if (!best || Math.abs(z) > Math.abs(best.z)) best = { trait: t.label, z, dir: Math.sign(z) };
    }
    return best;
  }
}

/** Human-facing colour of a genome's expression (used for coat/foliage tint). */
export function phenotypeTint(values: Float32Array, tpl: GenomeTemplate): [number, number, number] {
  const size = values[tpl.index['size']] ?? 1;
  const camo = values[tpl.index['camouflage']] ?? 1;
  const cold = values[tpl.index['coldTol']] ?? 1;
  const v = clamp01(0.55 + (camo - 1) * -0.18);
  return [
    clamp01(v * (1.05 - (cold - 1) * 0.06) * (1.0 + (size - 1) * 0.03)),
    clamp01(v * 1.0),
    clamp01(v * (0.92 - (size - 1) * 0.02)),
  ];
}
