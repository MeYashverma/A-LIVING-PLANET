import { Biome } from '../world/biomes';
import { PLANT_INDEX } from '../world/biomes';

export type Locomotion = 'quadruped' | 'bird' | 'fish';
export type DietKind = 'grazer' | 'browser' | 'mixed' | 'predator' | 'piscivore' | 'insectivore' | 'omnivore' | 'scavenger';
export type SocialStructure = 'solitary' | 'pair' | 'herd' | 'pack' | 'flock' | 'school';
export type ActivityPattern = 'diurnal' | 'nocturnal' | 'crepuscular' | 'cathemeral';
export type ShelterKind = 'burrow' | 'den' | 'nest' | 'cave' | 'roost' | 'shoal' | 'none';

/** Procedural anatomy parameters consumed by the creature renderer. */
export interface Morphology {
  bodyLength: number;
  bodyGirth: number;
  neck: number;
  legLength: number;
  headSize: number;
  earSize: number;
  tailLength: number;
  /** 'none' | 'antlers' | 'horns' | 'mane' */
  headgear: 'none' | 'antlers' | 'horns' | 'mane' | 'snout';
  pattern: 'plain' | 'spotted' | 'striped' | 'dark-ends' | 'belly-light';
  fur: [number, number, number];
  belly: [number, number, number];
  accent: [number, number, number];
  /** Eye and nose colour. Almost always dark; a few species have pale ones. */
  eye: [number, number, number];
  wingSpan: number;
  wingStyle: 'none' | 'soaring' | 'flapping' | 'short';
  finStyle: 'none' | 'dorsal' | 'paddle';
  /** World units off the ground for the body centre. */
  standHeight: number;
}

export interface SpeciesDef {
  key: string;
  name: string;
  latin: string;
  blurb: string;
  /** One-line ecological role, shown in the encyclopedia. */
  role: string;
  locomotion: Locomotion;
  dietKind: DietKind;
  social: SocialStructure;
  activity: ActivityPattern;
  shelter: ShelterKind;

  massKg: number;
  /** Metres-ish reference used by the renderer and for size comparisons. */
  bodyLength: number;

  walkSpeed: number;
  runSpeed: number;
  swims: boolean;
  flies: boolean;
  /** Multiplier on terrain movement cost (0.5 = very agile on rough ground). */
  terrainAgility: number;

  visionRange: number;
  smellRange: number;
  hearingRange: number;
  /** 0..1 — how well it sees at night (1 = as good as day). */
  nightVision: number;

  /** Hours from fully fed to starving, at rest. */
  hungerHours: number;
  thirstHours: number;
  /** Hours of sleep needed per day. */
  sleepHours: number;
  /** Comfortable temperature window in °C. */
  tempComfort: [number, number];
  waterIndependent: boolean;

  /** Preference weight per plant layer (index → 0..1). */
  plantDiet: number[];
  /** Individual species it hunts. */
  preySpecies: string[];
  /** Aggregate (patch) prey it hunts. */
  aggregatePrey: string[];
  /** Size window of prey it can tackle. */
  preyMass: [number, number];
  /** Eats carcasses — a critical food-web role. */
  scavenges: boolean;
  /** Stores food caches. */
  caches: boolean;
  /** Attacks prey larger than itself in groups (wolves, packs). */
  groupHunter: boolean;

  /** Habitat affinity per biome (multiplier on suitability). */
  habitat: Partial<Record<Biome, number>>;
  /** Elevation preference (world units) — used for altitudinal migration. */
  elevationRange: [number, number];

  maturityYears: number;
  maxAgeYears: number;
  gestationDays: number;
  litterSize: [number, number];
  littersPerYear: number;
  /** Seasons in which mating occurs (0=spring..3=winter); empty = year round. */
  breedingSeasons: number[];
  parentalCareDays: number;
  /** Requires a nest/den to raise young. */
  nestRequired: boolean;
  /** Days a newborn needs before it can forage alone. */
  weaningDays: number;

  groupSize: [number, number];
  /** Territory radius in world units (0 = nomadic). */
  territoryRadius: number;
  territoryDefence: number;

  /** Biomass eaten per hour while feeding successfully. */
  intakePerHour: number;
  /** Nutrition multiplier of ingested plant matter (meat is richer). */
  plantNutrition: number;
  meatNutrition: number;
  /** Energy cost multiplier on movement (calves, big bodies...). */
  moveCost: number;
  /** Disease susceptibility multiplier. */
  diseaseSusceptibility: number;
  /** How attractive this species is to parasites/vectors (ticks, mosquitoes). */
  vectorAttraction: number;

  /** Behavioural weighting: how strongly each drive is felt. */
  drives: {
    fear: number;
    hungerWeight: number;
    socialWeight: number;
    curiosity: number;
    aggression: number;
    territorial: number;
    parenting: number;
    thermoregulation: number;
  };

  /** Typical trait values — the founding population's genome centre. */
  baseTraits: Record<string, number>;
  /** Maximum individuals before the species stops reproducing. */
  softCap: number;
  morphology: Morphology;
  /** Sound character used by the procedural audio engine. */
  voice?: { baseFreq: number; style: 'howl' | 'chirp' | 'caw' | 'bugle' | 'hoot' | 'scream' | 'splash' | 'bellow' };
  /** Letter used to build readable individual tags (e.g. W-1847). */
  tag: string;
}

const H = (biome: Biome, v: number) => [biome, v] as const;

function habitat(entries: (readonly [Biome, number])[]): Partial<Record<Biome, number>> {
  const out: Partial<Record<Biome, number>> = {};
  for (const [b, v] of entries) out[b as Biome] = v;
  return out;
}

const GRASS_FOREST = habitat([
  H(Biome.Grassland, 1),
  H(Biome.Steppe, 0.6),
  H(Biome.TemperateForest, 0.75),
  H(Biome.BorealForest, 0.35),
  H(Biome.Marsh, 0.5),
  H(Biome.Tundra, 0.25),
  H(Biome.Coast, 0.4),
  H(Biome.Alpine, 0.15),
  H(Biome.Desert, 0.08),
]);

export const SPECIES: SpeciesDef[] = [
  /* ------------------------------------------------------------------ */
  {
    key: 'rabbit',
    name: 'Rabbit',
    latin: 'Oryctolagus',
    tag: 'R',
    blurb:
      'A burrowing lagomorph that lives fast and breeds faster. Its whole survival strategy is to be eaten by something bigger than itself and out-breed the losses.',
    role: 'Primary consumer · prey base',
    locomotion: 'quadruped',
    dietKind: 'grazer',
    social: 'pair',
    activity: 'crepuscular',
    shelter: 'burrow',
    massKg: 1.6,
    bodyLength: 0.45,
    walkSpeed: 1.7,
    runSpeed: 22,
    swims: false,
    flies: false,
    terrainAgility: 1.25,
    visionRange: 34,
    smellRange: 26,
    hearingRange: 40,
    nightVision: 0.75,
    hungerHours: 9,
    thirstHours: 26,
    sleepHours: 7,
    tempComfort: [-6, 26],
    waterIndependent: false,
    plantDiet: [1, 0.55, 0.25, 0, 0.1, 0.35],
    preySpecies: [],
    aggregatePrey: [],
    preyMass: [0, 0],
    scavenges: false,
    caches: false,
    groupHunter: false,
    habitat: GRASS_FOREST,
    elevationRange: [-5, 22],
    maturityYears: 0.4,
    maxAgeYears: 5,
    gestationDays: 30,
    litterSize: [3, 6],
    littersPerYear: 4,
    breedingSeasons: [],
    parentalCareDays: 24,
    nestRequired: true,
    weaningDays: 18,
    groupSize: [2, 7],
    territoryRadius: 18,
    territoryDefence: 0.08,
    intakePerHour: 0.1,
    plantNutrition: 1.0,
    meatNutrition: 1.0,
    moveCost: 1.15,
    diseaseSusceptibility: 1.35,
    vectorAttraction: 1.3,
    drives: {
      fear: 1.55,
      hungerWeight: 1.25,
      socialWeight: 0.5,
      curiosity: 0.5,
      aggression: 0.12,
      territorial: 0.2,
      parenting: 0.6,
      thermoregulation: 0.85,
    },
    baseTraits: { size: 0.8, speed: 1.05, stamina: 0.85, vision: 1.05, metabolism: 1.35, fertility: 1.5, lifespan: 0.9, camouflage: 1.15, senseSmell: 1.05 },
    softCap: 220,
    morphology: {
      bodyLength: 0.46,
      bodyGirth: 0.2,
      neck: 0.06,
      legLength: 0.16,
      headSize: 0.15,
      earSize: 0.15,
      tailLength: 0.06,
      headgear: 'none',
      pattern: 'belly-light',
      fur: [0.52, 0.44, 0.36],
      belly: [0.84, 0.8, 0.72],
      accent: [0.24, 0.2, 0.18],
      eye: [0.053, 0.044, 0.043],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'none',
      standHeight: 0.22,
    },
    voice: { baseFreq: 620, style: 'scream' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'deer',
    name: 'Red Deer',
    latin: 'Cervus',
    tag: 'D',
    blurb:
      'A herding browser. Does lead matrilineal groups up and down the slopes with the seasons while stags compete for the rut.',
    role: 'Large herbivore · primary prey',
    locomotion: 'quadruped',
    dietKind: 'mixed',
    social: 'herd',
    activity: 'crepuscular',
    shelter: 'none',
    massKg: 105,
    bodyLength: 1.9,
    walkSpeed: 2.8,
    runSpeed: 33,
    swims: true,
    flies: false,
    terrainAgility: 0.85,
    visionRange: 52,
    smellRange: 48,
    hearingRange: 55,
    nightVision: 0.7,
    hungerHours: 22,
    thirstHours: 38,
    sleepHours: 6,
    tempComfort: [-14, 24],
    waterIndependent: false,
    plantDiet: [0.7, 1, 0.15, 0, 0.05, 0.1],
    preySpecies: [],
    aggregatePrey: [],
    preyMass: [0, 0],
    scavenges: false,
    caches: false,
    groupHunter: false,
    habitat: habitat([
      H(Biome.TemperateForest, 1),
      H(Biome.Grassland, 0.8),
      H(Biome.BorealForest, 0.7),
      H(Biome.Marsh, 0.45),
      H(Biome.Steppe, 0.35),
      H(Biome.Alpine, 0.3),
      H(Biome.Tundra, 0.3),
      H(Biome.Coast, 0.3),
      H(Biome.Desert, 0.05),
    ]),
    elevationRange: [-4, 26],
    maturityYears: 1.8,
    maxAgeYears: 14,
    gestationDays: 210,
    litterSize: [1, 2],
    littersPerYear: 1,
    breedingSeasons: [2],
    parentalCareDays: 200,
    nestRequired: false,
    weaningDays: 150,
    groupSize: [4, 14],
    territoryRadius: 0,
    territoryDefence: 0.15,
    intakePerHour: 1.35,
    plantNutrition: 0.95,
    meatNutrition: 1.1,
    moveCost: 0.85,
    diseaseSusceptibility: 1,
    vectorAttraction: 1.5,
    drives: {
      fear: 1.2,
      hungerWeight: 1.15,
      socialWeight: 1.35,
      curiosity: 0.6,
      aggression: 0.35,
      territorial: 0.45,
      parenting: 0.9,
      thermoregulation: 0.8,
    },
    baseTraits: { size: 1.15, speed: 1.1, stamina: 1.2, vision: 1.1, metabolism: 1.05, fertility: 0.9, lifespan: 1.1, camouflage: 0.85, senseSmell: 1.2 },
    softCap: 130,
    morphology: {
      bodyLength: 1.9,
      bodyGirth: 0.62,
      neck: 0.42,
      legLength: 0.8,
      headSize: 0.3,
      earSize: 0.2,
      tailLength: 0.16,
      headgear: 'antlers',
      pattern: 'plain',
      fur: [0.42, 0.31, 0.21],
      belly: [0.6, 0.52, 0.42],
      accent: [0.3, 0.24, 0.18],
      eye: [0.066, 0.053, 0.043],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'none',
      standHeight: 1.15,
    },
    voice: { baseFreq: 165, style: 'bellow' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'bison',
    name: 'Bison',
    latin: 'Bison',
    tag: 'B',
    blurb:
      'A grazing giant. Herds trample the ground they feed on, opening mud wallows that other species then depend on.',
    role: 'Megaherbivore · ecosystem engineer',
    locomotion: 'quadruped',
    dietKind: 'grazer',
    social: 'herd',
    activity: 'diurnal',
    shelter: 'none',
    massKg: 620,
    bodyLength: 2.8,
    walkSpeed: 1.9,
    runSpeed: 25,
    swims: true,
    flies: false,
    terrainAgility: 0.6,
    visionRange: 48,
    smellRange: 46,
    hearingRange: 45,
    nightVision: 0.5,
    hungerHours: 26,
    thirstHours: 30,
    sleepHours: 5,
    tempComfort: [-24, 22],
    waterIndependent: false,
    plantDiet: [1, 0.2, 0.3, 0, 0.05, 0.05],
    preySpecies: [],
    aggregatePrey: [],
    preyMass: [0, 0],
    scavenges: false,
    caches: false,
    groupHunter: false,
    habitat: habitat([
      H(Biome.Grassland, 1.15),
      H(Biome.Steppe, 0.8),
      H(Biome.Marsh, 0.35),
      H(Biome.Tundra, 0.5),
      H(Biome.TemperateForest, 0.3),
      H(Biome.BorealForest, 0.25),
      H(Biome.Alpine, 0.15),
      H(Biome.Desert, 0.08),
    ]),
    elevationRange: [-4, 18],
    maturityYears: 3.5,
    maxAgeYears: 22,
    gestationDays: 280,
    litterSize: [1, 1],
    littersPerYear: 1,
    breedingSeasons: [1],
    parentalCareDays: 300,
    nestRequired: false,
    weaningDays: 240,
    groupSize: [6, 24],
    territoryRadius: 0,
    territoryDefence: 0.3,
    intakePerHour: 3.2,
    plantNutrition: 0.82,
    meatNutrition: 1.25,
    moveCost: 0.7,
    diseaseSusceptibility: 0.9,
    vectorAttraction: 1.1,
    drives: {
      fear: 0.85,
      hungerWeight: 1.3,
      socialWeight: 1.45,
      curiosity: 0.4,
      aggression: 0.6,
      territorial: 0.7,
      parenting: 0.95,
      thermoregulation: 0.7,
    },
    baseTraits: { size: 1.55, speed: 0.95, stamina: 1.25, vision: 0.95, metabolism: 1.15, fertility: 0.75, lifespan: 1.2, camouflage: 0.6, senseSmell: 1.1 },
    softCap: 70,
    morphology: {
      bodyLength: 2.8,
      bodyGirth: 1.1,
      neck: 0.3,
      legLength: 0.85,
      headSize: 0.5,
      earSize: 0.16,
      tailLength: 0.4,
      headgear: 'horns',
      pattern: 'plain',
      fur: [0.29, 0.22, 0.16],
      belly: [0.36, 0.28, 0.2],
      accent: [0.16, 0.13, 0.11],
      eye: [0.035, 0.029, 0.026],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'none',
      standHeight: 1.35,
    },
    voice: { baseFreq: 95, style: 'bellow' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'wolf',
    name: 'Grey Wolf',
    latin: 'Canis lupus',
    tag: 'W',
    blurb:
      'A pack-hunting canid. Wolves hold territories, raise one litter a year, and will take animals several times their own weight when working together.',
    role: 'Apex predator · keystone',
    locomotion: 'quadruped',
    dietKind: 'predator',
    social: 'pack',
    activity: 'crepuscular',
    shelter: 'den',
    massKg: 42,
    bodyLength: 1.25,
    walkSpeed: 3.3,
    runSpeed: 30,
    swims: true,
    flies: false,
    terrainAgility: 0.95,
    visionRange: 62,
    smellRange: 78,
    hearingRange: 70,
    nightVision: 0.85,
    hungerHours: 34,
    thirstHours: 40,
    sleepHours: 8,
    tempComfort: [-30, 24],
    waterIndependent: false,
    plantDiet: [0, 0, 0, 0, 0, 0],
    preySpecies: ['deer', 'bison', 'rabbit'],
    aggregatePrey: ['mouse'],
    preyMass: [0.5, 900],
    scavenges: true,
    caches: true,
    groupHunter: true,
    habitat: habitat([
      H(Biome.TemperateForest, 1),
      H(Biome.BorealForest, 1),
      H(Biome.Grassland, 0.75),
      H(Biome.Steppe, 0.5),
      H(Biome.Alpine, 0.5),
      H(Biome.Tundra, 0.6),
      H(Biome.Marsh, 0.4),
      H(Biome.Snow, 0.3),
      H(Biome.Desert, 0.15),
    ]),
    elevationRange: [-6, 30],
    maturityYears: 2.2,
    maxAgeYears: 11,
    gestationDays: 63,
    litterSize: [3, 6],
    littersPerYear: 1,
    breedingSeasons: [3],
    parentalCareDays: 300,
    nestRequired: true,
    weaningDays: 60,
    groupSize: [2, 8],
    territoryRadius: 150,
    territoryDefence: 0.85,
    intakePerHour: 1.6,
    plantNutrition: 0.3,
    meatNutrition: 2.4,
    moveCost: 0.9,
    diseaseSusceptibility: 0.85,
    vectorAttraction: 0.8,
    drives: {
      fear: 0.5,
      hungerWeight: 1.5,
      socialWeight: 1.5,
      curiosity: 0.9,
      aggression: 1.2,
      territorial: 1.35,
      parenting: 1.15,
      thermoregulation: 0.75,
    },
    baseTraits: { size: 1.1, speed: 1.15, stamina: 1.35, vision: 1.1, metabolism: 0.95, fertility: 0.95, lifespan: 1.05, camouflage: 0.75, senseSmell: 1.45, aggression: 1.1, socialness: 1.3 },
    softCap: 45,
    morphology: {
      bodyLength: 1.25,
      bodyGirth: 0.42,
      neck: 0.28,
      legLength: 0.55,
      headSize: 0.26,
      earSize: 0.12,
      tailLength: 0.42,
      headgear: 'snout',
      pattern: 'plain',
      fur: [0.38, 0.37, 0.36],
      belly: [0.52, 0.51, 0.48],
      accent: [0.2, 0.19, 0.19],
      eye: [0.044, 0.042, 0.046],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'none',
      standHeight: 0.78,
    },
    voice: { baseFreq: 240, style: 'howl' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'fox',
    name: 'Red Fox',
    latin: 'Vulpes',
    tag: 'F',
    blurb:
      'A solitary mesopredator. Caches surplus food, raids burrows, and prospers wherever larger predators are absent.',
    role: 'Mesopredator · generalist',
    locomotion: 'quadruped',
    dietKind: 'omnivore',
    social: 'pair',
    activity: 'crepuscular',
    shelter: 'den',
    massKg: 6.5,
    bodyLength: 0.72,
    walkSpeed: 2.8,
    runSpeed: 28,
    swims: true,
    flies: false,
    terrainAgility: 1.1,
    visionRange: 42,
    smellRange: 52,
    hearingRange: 60,
    nightVision: 0.9,
    hungerHours: 17,
    thirstHours: 30,
    sleepHours: 9,
    tempComfort: [-18, 28],
    waterIndependent: false,
    plantDiet: [0.1, 0.35, 0.05, 0, 0, 0.1],
    preySpecies: ['rabbit'],
    aggregatePrey: ['mouse', 'insect'],
    preyMass: [0.05, 12],
    scavenges: true,
    caches: true,
    groupHunter: false,
    habitat: habitat([
      H(Biome.TemperateForest, 1),
      H(Biome.Grassland, 0.95),
      H(Biome.Steppe, 0.6),
      H(Biome.Marsh, 0.6),
      H(Biome.BorealForest, 0.8),
      H(Biome.Alpine, 0.4),
      H(Biome.Tundra, 0.45),
      H(Biome.Coast, 0.5),
      H(Biome.Desert, 0.3),
      H(Biome.Snow, 0.2),
    ]),
    elevationRange: [-6, 26],
    maturityYears: 1,
    maxAgeYears: 7,
    gestationDays: 52,
    litterSize: [3, 5],
    littersPerYear: 1,
    breedingSeasons: [3],
    parentalCareDays: 180,
    nestRequired: true,
    weaningDays: 45,
    groupSize: [1, 3],
    territoryRadius: 70,
    territoryDefence: 0.55,
    intakePerHour: 0.45,
    plantNutrition: 0.85,
    meatNutrition: 2.2,
    moveCost: 1.05,
    diseaseSusceptibility: 1.1,
    vectorAttraction: 1.2,
    drives: {
      fear: 0.85,
      hungerWeight: 1.4,
      socialWeight: 0.5,
      curiosity: 1.1,
      aggression: 0.75,
      territorial: 0.95,
      parenting: 1.0,
      thermoregulation: 0.7,
    },
    baseTraits: { size: 0.9, speed: 1.05, stamina: 1.1, vision: 1.05, metabolism: 1.15, fertility: 1.05, lifespan: 1, camouflage: 0.8, senseSmell: 1.3 },
    softCap: 80,
    morphology: {
      bodyLength: 0.72,
      bodyGirth: 0.26,
      neck: 0.14,
      legLength: 0.28,
      headSize: 0.18,
      earSize: 0.13,
      tailLength: 0.42,
      headgear: 'snout',
      pattern: 'plain',
      fur: [0.62, 0.31, 0.14],
      belly: [0.78, 0.74, 0.68],
      accent: [0.24, 0.16, 0.12],
      eye: [0.053, 0.035, 0.029],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'none',
      standHeight: 0.42,
    },
    voice: { baseFreq: 420, style: 'scream' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'eagle',
    name: 'Golden Eagle',
    latin: 'Aquila',
    tag: 'E',
    blurb:
      'A soaring raptor that needs updraughts, cliffs and tall trees. Hunts by day, takes prey up to the size of a young deer, and scavenges in hard winters.',
    role: 'Aerial apex predator',
    locomotion: 'bird',
    dietKind: 'predator',
    social: 'pair',
    activity: 'diurnal',
    shelter: 'nest',
    massKg: 4.5,
    bodyLength: 0.9,
    walkSpeed: 25,
    runSpeed: 83,
    swims: false,
    flies: true,
    terrainAgility: 1,
    visionRange: 120,
    smellRange: 20,
    hearingRange: 40,
    nightVision: 0.2,
    hungerHours: 26,
    thirstHours: 46,
    sleepHours: 10,
    tempComfort: [-20, 30],
    waterIndependent: true,
    plantDiet: [0, 0, 0, 0, 0, 0],
    preySpecies: ['rabbit', 'trout'],
    aggregatePrey: ['mouse'],
    preyMass: [0.2, 22],
    scavenges: true,
    caches: false,
    groupHunter: false,
    habitat: habitat([
      H(Biome.Alpine, 1.1),
      H(Biome.Grassland, 0.7),
      H(Biome.TemperateForest, 0.6),
      H(Biome.BorealForest, 0.6),
      H(Biome.Steppe, 0.55),
      H(Biome.Marsh, 0.4),
      H(Biome.Tundra, 0.5),
      H(Biome.Snow, 0.3),
      H(Biome.Desert, 0.45),
      H(Biome.Coast, 0.45),
    ]),
    elevationRange: [0, 60],
    maturityYears: 4,
    maxAgeYears: 20,
    gestationDays: 43,
    litterSize: [1, 2],
    littersPerYear: 1,
    breedingSeasons: [0],
    parentalCareDays: 150,
    nestRequired: true,
    weaningDays: 70,
    groupSize: [1, 2],
    territoryRadius: 190,
    territoryDefence: 0.9,
    intakePerHour: 0.5,
    plantNutrition: 0.2,
    meatNutrition: 2.6,
    moveCost: 1.5,
    diseaseSusceptibility: 0.7,
    vectorAttraction: 0.6,
    drives: {
      fear: 0.25,
      hungerWeight: 1.35,
      socialWeight: 0.7,
      curiosity: 0.85,
      aggression: 1.05,
      territorial: 1.4,
      parenting: 1.25,
      thermoregulation: 0.55,
    },
    baseTraits: { size: 1.15, speed: 1.2, stamina: 1.3, vision: 1.55, metabolism: 0.9, fertility: 0.7, lifespan: 1.15, camouflage: 0.55, senseSmell: 0.6 },
    softCap: 18,
    morphology: {
      bodyLength: 0.9,
      bodyGirth: 0.26,
      neck: 0.16,
      legLength: 0.22,
      headSize: 0.16,
      earSize: 0.04,
      tailLength: 0.34,
      headgear: 'none',
      pattern: 'dark-ends',
      fur: [0.36, 0.27, 0.17],
      belly: [0.55, 0.48, 0.36],
      accent: [0.16, 0.13, 0.1],
      eye: [0.035, 0.029, 0.024],
      wingSpan: 2.2,
      wingStyle: 'soaring',
      finStyle: 'none',
      standHeight: 0.42,
    },
    voice: { baseFreq: 780, style: 'scream' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'owl',
    name: 'Eagle Owl',
    latin: 'Bubo',
    tag: 'O',
    blurb:
      'A nocturnal hunter with silent flight and asymmetric ears. It takes the small mammals that daytime raptors never see.',
    role: 'Nocturnal mesopredator',
    locomotion: 'bird',
    dietKind: 'predator',
    social: 'pair',
    activity: 'nocturnal',
    shelter: 'roost',
    massKg: 2.6,
    bodyLength: 0.6,
    walkSpeed: 22,
    runSpeed: 40,
    swims: false,
    flies: true,
    terrainAgility: 1,
    visionRange: 70,
    smellRange: 24,
    hearingRange: 90,
    nightVision: 1.35,
    hungerHours: 28,
    thirstHours: 40,
    sleepHours: 11,
    tempComfort: [-22, 28],
    waterIndependent: true,
    plantDiet: [0, 0, 0, 0, 0, 0],
    preySpecies: ['rabbit', 'trout'],
    aggregatePrey: ['mouse', 'insect'],
    preyMass: [0.05, 6],
    scavenges: true,
    caches: true,
    groupHunter: false,
    habitat: habitat([
      H(Biome.TemperateForest, 1),
      H(Biome.BorealForest, 0.95),
      H(Biome.Grassland, 0.6),
      H(Biome.Alpine, 0.55),
      H(Biome.Marsh, 0.5),
      H(Biome.Steppe, 0.45),
      H(Biome.Tundra, 0.4),
      H(Biome.Desert, 0.4),
      H(Biome.Snow, 0.2),
    ]),
    elevationRange: [-6, 40],
    maturityYears: 1.6,
    maxAgeYears: 12,
    gestationDays: 32,
    litterSize: [2, 4],
    littersPerYear: 1,
    breedingSeasons: [3],
    parentalCareDays: 120,
    nestRequired: true,
    weaningDays: 50,
    groupSize: [1, 2],
    territoryRadius: 95,
    territoryDefence: 0.8,
    intakePerHour: 0.34,
    plantNutrition: 0.2,
    meatNutrition: 2.5,
    moveCost: 1.45,
    diseaseSusceptibility: 0.75,
    vectorAttraction: 0.7,
    drives: {
      fear: 0.3,
      hungerWeight: 1.3,
      socialWeight: 0.65,
      curiosity: 0.7,
      aggression: 0.95,
      territorial: 1.3,
      parenting: 1.2,
      thermoregulation: 0.5,
    },
    baseTraits: { size: 1, speed: 1.05, stamina: 1.15, vision: 1.3, metabolism: 0.95, fertility: 0.85, lifespan: 1.1, camouflage: 0.95, senseSmell: 0.5 },
    softCap: 26,
    morphology: {
      bodyLength: 0.6,
      bodyGirth: 0.3,
      neck: 0.08,
      legLength: 0.14,
      headSize: 0.2,
      earSize: 0.06,
      tailLength: 0.2,
      headgear: 'none',
      pattern: 'spotted',
      fur: [0.44, 0.36, 0.26],
      belly: [0.6, 0.55, 0.45],
      accent: [0.2, 0.17, 0.14],
      eye: [0.044, 0.037, 0.034],
      wingSpan: 1.7,
      wingStyle: 'flapping',
      finStyle: 'none',
      standHeight: 0.3,
    },
    voice: { baseFreq: 190, style: 'hoot' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'raven',
    name: 'Raven',
    latin: 'Corvus corax',
    tag: 'C',
    blurb:
      'A wide-ranging corvid. Follows wolves to kills, remembers cache locations for months, and mobs anything that threatens it.',
    role: 'Scavenger · omnivore',
    locomotion: 'bird',
    dietKind: 'scavenger',
    social: 'flock',
    activity: 'diurnal',
    shelter: 'roost',
    massKg: 1.2,
    bodyLength: 0.6,
    walkSpeed: 25,
    runSpeed: 45,
    swims: false,
    flies: true,
    terrainAgility: 1,
    visionRange: 95,
    smellRange: 30,
    hearingRange: 55,
    nightVision: 0.45,
    hungerHours: 14,
    thirstHours: 26,
    sleepHours: 9,
    tempComfort: [-28, 32],
    waterIndependent: false,
    plantDiet: [0.15, 0.3, 0.1, 0, 0, 0.2],
    preySpecies: [],
    aggregatePrey: ['insect', 'mouse'],
    preyMass: [0.02, 2.5],
    scavenges: true,
    caches: true,
    groupHunter: false,
    habitat: habitat([
      H(Biome.TemperateForest, 0.9),
      H(Biome.Grassland, 0.85),
      H(Biome.Alpine, 0.9),
      H(Biome.BorealForest, 0.85),
      H(Biome.Steppe, 0.7),
      H(Biome.Tundra, 0.75),
      H(Biome.Desert, 0.6),
      H(Biome.Marsh, 0.5),
      H(Biome.Snow, 0.4),
      H(Biome.Coast, 0.7),
    ]),
    elevationRange: [-4, 70],
    maturityYears: 3,
    maxAgeYears: 16,
    gestationDays: 21,
    litterSize: [3, 5],
    littersPerYear: 1,
    breedingSeasons: [0],
    parentalCareDays: 90,
    nestRequired: true,
    weaningDays: 40,
    groupSize: [2, 9],
    territoryRadius: 260,
    territoryDefence: 0.35,
    intakePerHour: 0.4,
    plantNutrition: 0.9,
    meatNutrition: 2.1,
    moveCost: 1.35,
    diseaseSusceptibility: 0.6,
    vectorAttraction: 0.5,
    drives: {
      fear: 0.4,
      hungerWeight: 1.45,
      socialWeight: 1.2,
      curiosity: 1.6,
      aggression: 0.9,
      territorial: 0.55,
      parenting: 0.9,
      thermoregulation: 0.45,
    },
    baseTraits: { size: 0.85, speed: 1.1, stamina: 1.45, vision: 1.2, metabolism: 1.1, fertility: 0.9, lifespan: 1.2, camouflage: 0.35, senseSmell: 0.75, boldness: 1.35, curiosity: 1.3 },
    softCap: 60,
    morphology: {
      bodyLength: 0.6,
      bodyGirth: 0.22,
      neck: 0.1,
      legLength: 0.12,
      headSize: 0.14,
      earSize: 0.03,
      tailLength: 0.28,
      headgear: 'none',
      pattern: 'plain',
      fur: [0.1, 0.1, 0.13],
      belly: [0.14, 0.14, 0.17],
      accent: [0.26, 0.26, 0.3],
      eye: [0.057, 0.057, 0.072],
      wingSpan: 1.25,
      wingStyle: 'flapping',
      finStyle: 'none',
      standHeight: 0.26,
    },
    voice: { baseFreq: 520, style: 'caw' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'bear',
    name: 'Brown Bear',
    latin: 'Ursus arctos',
    tag: 'U',
    blurb:
      'An omnivore that eats berries, insects, salmon and carrion with equal enthusiasm. Dens through the winter and wakes thinner than it went in.',
    role: 'Omnivore · seed disperser',
    locomotion: 'quadruped',
    dietKind: 'omnivore',
    social: 'solitary',
    activity: 'cathemeral',
    shelter: 'cave',
    massKg: 320,
    bodyLength: 2.1,
    walkSpeed: 2.5,
    runSpeed: 25,
    swims: true,
    flies: false,
    terrainAgility: 0.8,
    visionRange: 50,
    smellRange: 95,
    hearingRange: 50,
    nightVision: 0.6,
    hungerHours: 40,
    thirstHours: 44,
    sleepHours: 10,
    tempComfort: [-30, 26],
    waterIndependent: false,
    plantDiet: [0.25, 0.75, 0.2, 0, 0, 0.25],
    preySpecies: ['trout', 'deer'],
    aggregatePrey: ['insect', 'mouse'],
    preyMass: [0.1, 260],
    scavenges: true,
    caches: true,
    groupHunter: false,
    habitat: habitat([
      H(Biome.BorealForest, 1.05),
      H(Biome.TemperateForest, 0.95),
      H(Biome.Alpine, 0.8),
      H(Biome.Grassland, 0.6),
      H(Biome.Tundra, 0.7),
      H(Biome.Marsh, 0.65),
      H(Biome.Steppe, 0.45),
      H(Biome.Snow, 0.3),
      H(Biome.Desert, 0.15),
    ]),
    elevationRange: [-4, 34],
    maturityYears: 5,
    maxAgeYears: 26,
    gestationDays: 220,
    litterSize: [1, 2],
    littersPerYear: 0.4,
    breedingSeasons: [1],
    parentalCareDays: 500,
    nestRequired: true,
    weaningDays: 120,
    groupSize: [1, 3],
    territoryRadius: 220,
    territoryDefence: 1.1,
    intakePerHour: 2.6,
    plantNutrition: 1.1,
    meatNutrition: 2.3,
    moveCost: 0.85,
    diseaseSusceptibility: 0.8,
    vectorAttraction: 0.7,
    drives: {
      fear: 0.15,
      hungerWeight: 1.6,
      socialWeight: 0.25,
      curiosity: 1.0,
      aggression: 1.35,
      territorial: 1.2,
      parenting: 1.1,
      thermoregulation: 0.6,
    },
    baseTraits: { size: 1.5, speed: 1.0, stamina: 1.1, vision: 0.9, metabolism: 1.1, fertility: 0.6, lifespan: 1.25, camouflage: 0.5, senseSmell: 1.5, aggression: 1.25 },
    softCap: 22,
    morphology: {
      bodyLength: 2.1,
      bodyGirth: 1.0,
      neck: 0.2,
      legLength: 0.6,
      headSize: 0.42,
      earSize: 0.14,
      tailLength: 0.12,
      headgear: 'snout',
      pattern: 'plain',
      fur: [0.32, 0.23, 0.15],
      belly: [0.4, 0.32, 0.22],
      accent: [0.18, 0.14, 0.1],
      eye: [0.04, 0.031, 0.024],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'none',
      standHeight: 1.15,
    },
    voice: { baseFreq: 120, style: 'bellow' },
  },
  /* ------------------------------------------------------------------ */
  {
    key: 'trout',
    name: 'Brown Trout',
    latin: 'Salmo trutta',
    tag: 'T',
    blurb:
      'A cold-water fish that runs upstream to spawn in spring. It links the aquatic and terrestrial food webs: fish eat insects, and eagles and bears eat fish.',
    role: 'Aquatic predator · energy transfer',
    locomotion: 'fish',
    dietKind: 'piscivore',
    social: 'school',
    activity: 'cathemeral',
    shelter: 'shoal',
    massKg: 1.1,
    bodyLength: 0.42,
    walkSpeed: 0.9,
    runSpeed: 4.4,
    swims: true,
    flies: false,
    terrainAgility: 1,
    visionRange: 26,
    smellRange: 30,
    hearingRange: 24,
    nightVision: 0.8,
    hungerHours: 13,
    thirstHours: 9999,
    sleepHours: 5,
    tempComfort: [2, 19],
    waterIndependent: true,
    plantDiet: [0, 0, 0, 0.2, 0, 0],
    preySpecies: [],
    aggregatePrey: ['plankton', 'insect'],
    preyMass: [0, 0.05],
    scavenges: true,
    caches: false,
    groupHunter: false,
    habitat: habitat([
      H(Biome.Lake, 1),
      H(Biome.River, 1.1),
      H(Biome.Marsh, 0.3),
    ]),
    elevationRange: [-20, 14],
    maturityYears: 2,
    maxAgeYears: 8,
    gestationDays: 25,
    // A trout lays hundreds of eggs; almost none reach a year old. The
    // simulation counts individuals, so the litter here is the number of fry
    // that make it past that bottleneck — not the spawn.
    litterSize: [6, 18],
    littersPerYear: 1,
    breedingSeasons: [0],
    parentalCareDays: 0,
    nestRequired: true,
    weaningDays: 0,
    groupSize: [3, 14],
    territoryRadius: 40,
    territoryDefence: 0.2,
    intakePerHour: 0.16,
    plantNutrition: 0.7,
    meatNutrition: 1.6,
    moveCost: 0.75,
    diseaseSusceptibility: 1.1,
    vectorAttraction: 0.4,
    drives: {
      fear: 1.1,
      hungerWeight: 1.35,
      socialWeight: 0.9,
      curiosity: 0.3,
      aggression: 0.3,
      territorial: 0.5,
      parenting: 0,
      thermoregulation: 1.4,
    },
    baseTraits: { size: 0.95, speed: 1.05, stamina: 0.95, vision: 0.9, metabolism: 1.2, fertility: 1.35, lifespan: 1, camouflage: 1.2, senseSmell: 1.1 },
    softCap: 160,
    morphology: {
      bodyLength: 0.42,
      bodyGirth: 0.13,
      neck: 0.0,
      legLength: 0,
      headSize: 0.08,
      earSize: 0,
      tailLength: 0.18,
      headgear: 'none',
      pattern: 'spotted',
      fur: [0.44, 0.38, 0.26],
      belly: [0.76, 0.72, 0.6],
      accent: [0.5, 0.24, 0.18],
      eye: [0.11, 0.053, 0.043],
      wingSpan: 0,
      wingStyle: 'none',
      finStyle: 'dorsal',
      standHeight: 0.1,
    },
    voice: { baseFreq: 60, style: 'splash' },
  },
];

export const SPECIES_BY_KEY: Record<string, SpeciesDef> = {};
SPECIES.forEach((s, i) => {
  SPECIES_BY_KEY[s.key] = s;
});

export function speciesIndex(key: string): number {
  return SPECIES.findIndex((s) => s.key === key);
}

/** Diet helper: plant-layer preference vector for a species. */
export function plantDietVector(s: SpeciesDef): number[] {
  return s.plantDiet.slice();
}

/** Food-web edges derived from the actual diet configuration. */
export interface FoodWebEdge {
  from: string;
  to: string;
  kind: 'predation' | 'grazing' | 'scavenging' | 'pollination' | 'decomposition' | 'symbiosis';
  weight: number;
}

export function buildFoodWeb(): { nodes: string[]; edges: FoodWebEdge[] } {
  const nodes: string[] = ['sun', 'plant_grass', 'plant_shrub', 'plant_reed', 'plant_algae', 'plant_moss', 'plant_xeric', 'carrion', 'detritus'];
  const edges: FoodWebEdge[] = [];
  for (const s of SPECIES) {
    nodes.push(s.key);
    s.plantDiet.forEach((pref, layer) => {
      if (pref <= 0.02) return;
      edges.push({ from: nodes[1 + layer], to: s.key, kind: 'grazing', weight: pref });
    });
    for (const prey of s.preySpecies) edges.push({ from: prey, to: s.key, kind: 'predation', weight: 0.85 });
    for (const prey of s.aggregatePrey) edges.push({ from: prey, to: s.key, kind: 'predation', weight: 0.55 });
    if (s.scavenges) edges.push({ from: 'carrion', to: s.key, kind: 'scavenging', weight: 0.5 });
  }
  nodes.push('mouse', 'insect', 'plankton');
  edges.push({ from: 'detritus', to: 'insect', kind: 'decomposition', weight: 0.5 });
  edges.push({ from: 'plant_grass', to: 'mouse', kind: 'grazing', weight: 0.6 });
  edges.push({ from: 'plant_shrub', to: 'mouse', kind: 'grazing', weight: 0.35 });
  edges.push({ from: 'plant_algae', to: 'plankton', kind: 'grazing', weight: 0.6 });
  edges.push({ from: 'insect', to: 'detritus', kind: 'decomposition', weight: 0.3 });
  edges.push({ from: 'insect', to: 'plant_grass', kind: 'pollination', weight: 0.4 });
  edges.push({ from: 'detritus', to: 'plant_grass', kind: 'decomposition', weight: 1 });
  edges.push({ from: 'carrion', to: 'detritus', kind: 'decomposition', weight: 1 });
  edges.push({ from: 'plant_grass', to: 'sun', kind: 'pollination', weight: 0 });
  for (const n of ['plant_grass', 'plant_shrub', 'plant_reed', 'plant_algae', 'plant_moss', 'plant_xeric']) {
    edges.push({ from: 'sun', to: n, kind: 'symbiosis', weight: 1 });
  }
  return { nodes, edges };
}

export const PLANT_LABELS: Record<number, string> = {
  [PLANT_INDEX.grass]: 'Grass & herbs',
  [PLANT_INDEX.shrub]: 'Shrubs & saplings',
  [PLANT_INDEX.reed]: 'Reeds',
  [PLANT_INDEX.algae]: 'Algae',
  [PLANT_INDEX.moss]: 'Moss & lichen',
  [PLANT_INDEX.xeric]: 'Xeric scrub',
};
