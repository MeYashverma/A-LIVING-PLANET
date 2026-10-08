# Development harness

These are headless probes, not part of the shipped app. They run the *same*
`World` the browser runs, with no renderer, so a claim about the simulation can
be checked in seconds instead of by watching a canvas.

Every probe is a standalone TypeScript file with a `main`-style top level, so
bundle and run one at a time:

```bash
npx esbuild tools/deaths2.ts --bundle --platform=node --format=esm --outfile=/tmp/deaths2.mjs
node /tmp/deaths2.mjs <seed>
```

## What each one answers

| probe | question it answers |
| --- | --- |
| `geo.ts` | Does terrain generation make the world we asked for? Land fraction, biome mix, tree counts, river and lake census. Run this first after touching `terrain.ts`. |
| `pop.ts` | Ten-day, 24-step-per-day population census per species. The coarsest health check. |
| `count.ts` | Instant census plus how many animals are within draw distance. Used for performance work. |
| `perf.ts` | Integration cost: simulated minutes per wall-clock second at various population sizes and step sizes. |
| `trace.ts` | Follows a few named individuals for days, printing physiology and action each sample, with birth and death tallies. |
| `deaths2.ts` | Per-death log (minute, species, cause, hunger/thirst/energy/health/injury/age/action) plus six-hourly census and cause tallies. The main tool for "why are they dying". |
| `starve.ts` | Breaks starvation deaths down by life stage, to separate unweaned juvenile losses from adult ones. |
| `die3.ts` | Thirty-day species and hunger census with per-species/per-cause death tallies. |
| `feed2.ts` | Foraging economics: per-animal hunger, energy, action and the quality of the ground underfoot. |
| `rab2.ts` | Rabbit-only variant of the above, with action mix and measured intake per hour. |
| `rab.ts` | Rabbit cohort trend over three days with mean hunger, energy and forage underfoot. |
| `thirst.ts` | Ring-buffers each animal's water situation and prints it on dehydration death, with an injected `perceive()`/`decide()` probe. This is what proved thirst was losing to hunger in the utility scores. |
| `acts.ts` | Action mix per species — what the population is actually doing all day. |
| `births.ts` | Thirty-day run with every mating and birth logged, pregnancy counts, and per-species death causes. The end-to-end ecology test. |
| `agg2.ts` | Daily means for mouse, insect and plankton patches, and the disease layer's pressure and pathogen list. |
| `veg.ts`, `grow.ts` | Vegetation biomass and growth/regrowth rates per patch. |
| `pred.ts`, `trout.ts`, `depth.ts` | Predation counts, trout population and starvation, and water depth at a point. |

## Asset pipeline

Not probes — these build and check the art the renderer uses.

| script | what it does |
| --- | --- |
| `node tools/gen-tex.mjs` | Generates the bark, foliage, grass-card, water-normal and foam textures into `public/assets/gen`. Deterministic, needs only `sharp`. |
| `node tools/fetch-assets.mjs [--force]` | Clones the pinned CC0 sources, transcodes the ground materials to the sizes the renderer binds, and applies the per-material brightness gains. Needs network. |
| `node tools/texstats.mjs` | Prints the mean albedo of each ground material in encoded and linear light, next to the flat palette it replaced. Run this after changing a gain — a material that is far darker than its neighbours renders as a hole in the landscape. |

Both generators need `sharp`, which is deliberately *not* a dependency of the
app. Install it temporarily (`npm i --no-save sharp`) before running them.

## Notes

- Probes are deterministic given a seed, so a fix and its before/after numbers
  refer to the same world.
- A thirty-day run is roughly three minutes of wall clock. Prefer `die3.ts` or
  `rab2.ts` for fast iteration and keep `births.ts` for confirming a change.
- Nested template literals break esbuild's parser; keep string interpolation in
  probe files simple.
