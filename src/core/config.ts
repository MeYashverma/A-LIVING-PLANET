/**
 * Central tuning table. Everything a player can feel is a number here, so the
 * ecosystem can be rebalanced without hunting through the simulation code.
 */

export const WORLD = {
  /** Terrain grid resolution (cells per side). Power of two keeps noise cheap. */
  defaultGrid: 288,
  minGrid: 192,
  maxGrid: 384,
  /** World units per terrain cell. */
  cellUnits: 2.5,
  /** Vertical exaggeration of the height field in world units. */
  heightScale: 62,
  /** Sea level as a fraction of normalised height. */
  seaLevel: 0.34,
};

export const TERRAIN = {
  /**
   * Hypsometric exponent: 1 leaves raw noise relief, higher values flatten the
   * lowlands and keep the ridges tall, so plains and valleys dominate.
   */
  hypsometricExponent: 2.6,
  /** Minimum p97 land relief in elevation units: no world is perfectly flat. */
  minRelief: 26,
  /** Rain-out from orographic lift. Flat ground still gets frontal rain. */
  rainBase: 0.1,
  rainLift: 1.25,
};

export const TIME = {
  minutesPerDay: 1440,
  daysPerSeason: 90,
  seasons: 4,
  get daysPerYear() {
    return TIME.daysPerSeason * TIME.seasons;
  },
  /** Real seconds for one in-game day at 1× speed (1 s real = 1 min game). */
  realSecondsPerDayAt1x: 1440,
  speedSteps: [0, 1, 2, 5, 10, 25, 50, 100] as const,
  /** Hard cap on simulation minutes advanced per rendered frame. */
  maxMinutesPerFrame: 240,
};

export const SIM = {
  /** Fixed simulation step, in in-game minutes. */
  stepMinutes: 1,
  /** Field layers (vegetation, soil, water) update on a slower cadence. */
  vegetationEveryMinutes: 10,
  hydrologyEveryMinutes: 5,
  soilEveryMinutes: 30,
  /** Aggregate (field) animal populations update once per simulated hour. */
  aggregateEveryMinutes: 60,
  censusEveryMinutes: 60,
  /** Spatial hash cell size in world units for neighbour queries. */
  hashCell: 12,
  /** Behaviour decision cadence per organism (minutes), jittered per individual. */
  thinkMin: 0.5,
  thinkMax: 2.5,
};

export const ECOLOGY = {
  /**
   * Photosynthesis scale: growth per hour of standing biomass at ideal light,
   * water and nutrients. Tuned so a grazed-down meadow recovers over a couple
   * of simulated days — fast enough to watch, slow enough to overgraze.
   */
  grassGrowthPerHour: 0.26,
  shrubGrowthPerHour: 0.07,
  treeGrowthPerHour: 0.012,
  /** Seed dispersal radius in cells. */
  grassSeedRadius: 3,
  treeSeedRadius: 7,
  /** Tree seed production requires maturity; children start small. */
  treeMaturityYears: 12,
  treeMaxAgeYears: 260,
  coniferMaturityYears: 18,
  /** Nutrient consumption by plants and return by decomposition. */
  nutrientPerGrowth: 0.55,
  decompositionPerHour: 0.02,
  /** Organic matter released per unit of dead biomass. */
  detritusYield: 0.85,
  /** Soil fertility regeneration from organic matter. */
  humification: 0.24,
  /** Erosion of bare soil (fertility loss) per hour. */
  erosionBase: 0.0018,
  /** Herbivory pressure per unit of grazer biomass per hour. */
  grazeRate: 0.02,
  /** Unit conversions between body-mass intake (kg) and plant biomass.
   *  One kilogram of forage removes this much of a cell's plant biomass. */
  grazeConversion: 0.18,
  /** Kilogram of animal matter eaten -> patch-prey biomass units removed. */
  meatConversion: 0.35,
  /** Pollination bonus from insect activity (0..1 extra seed set). */
  pollinationWeight: 0.6,
};

export const CLIMATE = {
  /** Mean global temperature in °C at sea level, before seasonal/world bias. */
  baseTemp: 14,
  /** Seasonal swing in °C (mid-latitude-ish). */
  seasonalSwing: 11,
  /** Daily swing in °C. */
  diurnalSwing: 7,
  /** Lapse rate: °C lost per world height unit. */
  lapseRate: 0.0055,
  /** Lake/sea thermal buffering (°C pulled toward water temperature). */
  waterBuffer: 3.2,
  /** Rainfall per hour at full cloud cover (mm-ish). */
  rainRate: 0.5,
  /**
   * Open-water evaporation in metres per hour at 28 C, before the temperature
   * factor. Earth loses a few millimetres a day; the world is time-compressed,
   * so this is set to dry a shallow pond over roughly a simulated week without
   * inflow — enough for real drought dynamics without the map turning to dust.
   */
  evaporationPerHour: 0.012,
  /** Cloud formation from humidity + orographic lift. */
  cloudFormation: 0.2,
  cloudDissipation: 0.09,
  /** Wind speed base in world units per minute. */
  windBase: 1.1,
  /** Weather cell grid resolution. */
  weatherGrid: 36,
  /** Days a drought/heatwave/coldwave lasts on average. */
  eventMinDays: 3,
  eventMaxDays: 11,
};

export const FIRE = {
  /** Chance per hour that a dry cell ignites from heat + lightning. */
  ignitionBase: 0.00008,
  /** Spread chance to a neighbouring cell per hour at full fuel/dryness. */
  spreadRate: 0.16,
  /** Fuel consumed per hour while burning. */
  burnRate: 0.5,
  /** Wind multiplier on downwind spread. */
  windBoost: 2.4,
  /** Fuel moisture above which vegetation will not ignite. */
  moistureCutoff: 0.42,
  /** Minimum field fuel to carry fire. */
  fuelThreshold: 0.12,
  /** Heat damage radius to organisms (world units). */
  damageRadius: 6,
  /** Ash nutrients released. */
  ashNutrients: 0.55,
};

export const DISEASE = {
  /** Base transmission probability per hour at close contact, per unit of prevalence. */
  transmission: 0.055,
  /** Recovery chance per hour. */
  recovery: 0.012,
  /** Chance a recovered individual is immune. */
  immunityChance: 0.72,
  /** Mortality multiplier while infected. */
  mortality: 0.055,
  /** Fertility suppression while infected. */
  fertilitySuppression: 0.75,
  /** Spontaneous emergence requires crowding above this local density. */
  emergenceDensity: 6,
  emergenceBase: 2.5e-5,
  /** Mutation chance of virulence per outbreak step. */
  virulenceDrift: 0.04,
};

export const LIFE = {
  /** Detectable biomass floor for a species to be considered extant. */
  extinctionThreshold: 1,
  /** Global cap on individually simulated animals (safety valve). */
  maxIndividuals: 900,
  /** Global cap on individually simulated trees. */
  maxTrees: 5200,
  /** Animals beyond this distance from the camera in a small world still think. */
  alwaysThinkRadius: 400,
};

export const RENDER = {
  /** Grass blades drawn around the camera focus point. */
  grassInstances: 46000,
  grassRadius: 52,
  /** Tree instancing distance culling. */
  treeDrawDistance: 620,
  treeLodDistance: 190,
  shadowMapSize: 2048,
  shadowDistance: 300,
  /** Creature animation update distance in world units. */
  creatureAnimDistance: 260,
  maxPixelRatio: 1.75,
};

export const SAVE = {
  dbName: 'living-planet',
  storeName: 'worlds',
  version: 3,
  /** Autosave interval in real seconds. */
  autosaveSeconds: 90,
  /** Offline catch-up cap in in-game days. */
  offlineCapDays: 365,
};

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export const QUALITY_PRESETS: Record<QualityLevel, Record<string, number>> = {
  low: { pixelRatio: 0.85, shadow: 0, bloom: 0, grass: 0.15, trees: 0.45, particles: 0.3, terrain: 0.6 },
  medium: { pixelRatio: 1, shadow: 1024, bloom: 1, grass: 0.45, trees: 0.75, particles: 0.6, terrain: 0.8 },
  high: { pixelRatio: 1.35, shadow: 2048, bloom: 1, grass: 0.8, trees: 1, particles: 1, terrain: 1 },
  ultra: { pixelRatio: 1.75, shadow: 4096, bloom: 1, grass: 1.2, trees: 1.25, particles: 1.35, terrain: 1.15 },
};
