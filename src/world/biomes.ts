/**
 * Biomes are *emergent*: a cell's biome is classified from its temperature,
 * moisture, elevation, slope and hydrological context rather than painted on.
 * Each biome then carries the ecological properties the rest of the simulation
 * reads (what can grow there, how fast animals move, what it looks like).
 */

export enum Biome {
  Ocean = 0,
  Coast = 1,
  Marsh = 2,
  Grassland = 3,
  Steppe = 4,
  TemperateForest = 5,
  BorealForest = 6,
  Alpine = 7,
  Snow = 8,
  Desert = 9,
  Tundra = 10,
  Lake = 11,
  River = 12,
}

export const PLANT_LAYERS = ['grass', 'shrub', 'reed', 'algae', 'moss', 'xeric'] as const;
export type PlantKind = (typeof PLANT_LAYERS)[number];
export const PLANT_INDEX: Record<PlantKind, number> = {
  grass: 0,
  shrub: 1,
  reed: 2,
  algae: 3,
  moss: 4,
  xeric: 5,
};

export interface BiomeDef {
  id: Biome;
  key: string;
  name: string;
  blurb: string;
  /** Ground colour when vegetation is absent. */
  soil: [number, number, number];
  /** Colour modulation applied by latitude/temperature/altitude. */
  tint: [number, number, number];
  /** How well each plant layer grows here (0..1 ability multiplier). */
  plants: number[];
  /** Tree suitability: [broadleaf, conifer]. */
  trees: [number, number];
  /** Terrain roughness multiplier for animal movement speed. */
  roughness: number;
  /** Baseline soil fertility. */
  fertility: number;
  /** Habitat quality multiplier for animals with matching preference. */
  habitat?: number;
}

const D: BiomeDef[] = [];

function def(d: BiomeDef): void {
  D[d.id] = d;
}

def({
  id: Biome.Ocean,
  key: 'ocean',
  name: 'Ocean',
  blurb: 'Salt water. Algae blooms feed the fish, which feed everything with wings or claws.',
  soil: [0.24, 0.28, 0.3],
  tint: [0.6, 0.75, 0.9],
  plants: [0, 0, 0, 0.85, 0, 0],
  trees: [0, 0],
  roughness: 1.0,
  fertility: 0.05,
});

def({
  id: Biome.Coast,
  key: 'coast',
  name: 'Coast',
  blurb: 'Sand and shingle where land meets water. Wrack and tide pools concentrate life.',
  soil: [0.74, 0.68, 0.52],
  tint: [1.05, 1.0, 0.9],
  plants: [0.16, 0.1, 0.35, 0.2, 0.08, 0.05],
  trees: [0.05, 0.02],
  roughness: 0.9,
  fertility: 0.3,
});

def({
  id: Biome.Marsh,
  key: 'marsh',
  name: 'Wetland',
  blurb: 'Saturated ground. Reed beds and nesting waterfowl — the most productive soil in the world.',
  soil: [0.3, 0.32, 0.19],
  tint: [0.85, 1.0, 0.8],
  plants: [0.55, 0.3, 1.0, 0.35, 0.5, 0.05],
  trees: [0.22, 0.05],
  roughness: 1.35,
  fertility: 0.86,
});

def({
  id: Biome.Grassland,
  key: 'grassland',
  name: 'Grassland',
  blurb: 'Deep-rooted grasses, seasonal growth. Grazing herds built these plains.',
  soil: [0.42, 0.35, 0.22],
  tint: [1.0, 0.98, 0.9],
  plants: [1.0, 0.35, 0.1, 0.02, 0.15, 0.3],
  trees: [0.1, 0.04],
  roughness: 0.95,
  fertility: 0.62,
});

def({
  id: Biome.Steppe,
  key: 'steppe',
  name: 'Steppe',
  blurb: 'Dry short grasses and thorn scrub. Rain is scarce and unreliable.',
  soil: [0.53, 0.44, 0.28],
  tint: [1.05, 0.95, 0.82],
  plants: [0.45, 0.4, 0.05, 0, 0.12, 0.55],
  trees: [0.04, 0.02],
  roughness: 0.95,
  fertility: 0.34,
});

def({
  id: Biome.TemperateForest,
  key: 'temperate_forest',
  name: 'Temperate Forest',
  blurb: 'Mixed broadleaf woodland. Deep litter, closed canopy, layered understorey.',
  soil: [0.31, 0.25, 0.16],
  tint: [0.9, 1.0, 0.86],
  plants: [0.62, 0.8, 0.12, 0.02, 0.7, 0.02],
  trees: [1.0, 0.35],
  roughness: 1.12,
  fertility: 0.78,
});

def({
  id: Biome.BorealForest,
  key: 'boreal_forest',
  name: 'Boreal Forest',
  blurb: 'Cold conifer taiga. Slow growth, long memory, snow-locked winters.',
  soil: [0.28, 0.26, 0.2],
  tint: [0.85, 0.95, 0.95],
  plants: [0.4, 0.5, 0.1, 0, 0.85, 0.03],
  trees: [0.18, 1.0],
  roughness: 1.16,
  fertility: 0.5,
});

def({
  id: Biome.Alpine,
  key: 'alpine',
  name: 'Alpine',
  blurb: 'Bare rock and scree above the treeline. Wind-scoured, thin soil, hardy specialists only.',
  soil: [0.45, 0.43, 0.42],
  tint: [0.9, 0.92, 1.0],
  plants: [0.12, 0.06, 0.02, 0, 0.35, 0.06],
  trees: [0.02, 0.12],
  roughness: 1.4,
  fertility: 0.16,
});

def({
  id: Biome.Snow,
  key: 'snow',
  name: 'Snowfield',
  blurb: 'Permanent ice and névé. Almost nothing lives here, but the meltwater feeds the valleys.',
  soil: [0.9, 0.92, 0.97],
  tint: [0.86, 0.9, 1.0],
  plants: [0.01, 0, 0, 0, 0.06, 0],
  trees: [0, 0],
  roughness: 1.25,
  fertility: 0.05,
});

def({
  id: Biome.Desert,
  key: 'desert',
  name: 'Desert',
  blurb: 'Arid ground. Life retreats to shaded refuges and waits for rare rain.',
  soil: [0.76, 0.63, 0.42],
  tint: [1.08, 0.98, 0.82],
  plants: [0.05, 0.12, 0.01, 0, 0.03, 0.85],
  trees: [0.01, 0.01],
  roughness: 0.92,
  fertility: 0.12,
});

def({
  id: Biome.Tundra,
  key: 'tundra',
  name: 'Tundra',
  blurb: 'Frozen ground, mosses and lichen. Brief explosive summers, brutal winters.',
  soil: [0.44, 0.4, 0.34],
  tint: [0.88, 0.94, 1.0],
  plants: [0.3, 0.14, 0.18, 0, 0.9, 0.08],
  trees: [0.01, 0.05],
  roughness: 1.1,
  fertility: 0.28,
});

def({
  id: Biome.Lake,
  key: 'lake',
  name: 'Lake',
  blurb: 'Standing fresh water. Thermal refuge, drinking hole and nursery for aquatic life.',
  soil: [0.22, 0.26, 0.24],
  tint: [0.7, 0.85, 0.95],
  plants: [0, 0, 0.55, 1.0, 0.02, 0],
  trees: [0, 0],
  roughness: 1.0,
  fertility: 0.55,
});

def({
  id: Biome.River,
  key: 'river',
  name: 'River',
  blurb: 'Flowing water. Everything in the valley must come here eventually.',
  soil: [0.36, 0.33, 0.26],
  tint: [0.75, 0.9, 0.95],
  plants: [0.3, 0.14, 0.5, 0.5, 0.12, 0.02],
  trees: [0.3, 0.12],
  roughness: 1.05,
  fertility: 0.72,
});

export const BIOMES = D;

export function biomeName(id: number): string {
  return BIOMES[id]?.name ?? 'Unknown';
}

/** Water biomes are not walkable land for terrestrial animals. */
export function isWaterBiome(id: number): boolean {
  return id === Biome.Ocean || id === Biome.Lake || id === Biome.River;
}
