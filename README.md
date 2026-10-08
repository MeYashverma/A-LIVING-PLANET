# A Living Planet

A real-time procedural ecosystem that runs entirely in the browser. Terrain,
weather, soil, plants and every individual animal are generated from a seed and
then simulated — nothing is scripted and nothing is painted on. There is no
backend and no network access is required after the page loads.

Leave it running and it keeps living: animals are born, grow, hunt, sicken,
wander, starve and die, vegetation is grazed down and grows back, populations
rise and crash, and the world writes its own history of what happened.

```
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc --noEmit && vite build
```

## What is simulated

**World.** Elevation, relief and climate noise produce continents, mountain
ranges, valleys, cliffs and coastal shelves. Temperature comes from latitude,
altitude and noise; moisture comes from a prevailing wind that loses rain over
mountains, so rain shadows, lake microclimates and wetland basins appear on
their own. Rivers flow downhill to the sea and carve their valleys; lakes fill
closed basins. Biomes — tundra, boreal forest, temperate forest, grassland,
steppe, desert, marsh, coast, alpine, snow — are *derived* from elevation,
moisture, temperature and fertility, so no biome is ever placed directly.

**Ecology.** Sunlight to plants to herbivores to predators, then carcasses to
scavengers to soil nutrients and back to plants. Species compete for forage,
predators compete for prey, scavengers compete for carcasses, and the nutrient
cycle closes the loop. Carrying capacity per patch comes from real water depth,
soil fertility and canopy cover, not from a lookup table.

**Individuals.** Every animal has an id, species, sex, age, size, health,
energy, hunger, thirst, warmth, fatigue, injury, infection, stress, personality
traits, a genome, a family (parents, mate, offspring), a home range, memories
and a current goal. Its needs drive its behaviour, so the bars in the inspector
are the actual reasons the animal is doing what it is doing.

**Behaviour.** A utility AI with steering and reaction: wander, graze, browse,
hunt, scavenge, drink, flee, hide, sleep, rest, court, mate, nurse, patrol a
territory, follow the group, migrate, investigate, cache food. Perception is
limited to an animal's own vision, hearing and smell ranges, with camouflage,
wind and the prey's alertness deciding what is noticed. Animals remember food,
water, danger and kills, and forget stale ones.

**Reproduction and genetics.** Maturity, seasonal breeding, gestation, litters,
weaning and parental care, with juveniles that are genuinely smaller and worse
at everything than adults. Traits — speed, size, metabolism, vision, aggression,
temperature tolerance, disease resistance, fertility, lifespan, camouflage — are
heritable with mutation, and selection acts on them through survival and
mating. Family trees and the generations view are computed from that data.

**Disturbance.** Four seasons drive growth, breeding and migration. Weather runs
from clear to storm to heatwave to cold snap with real effects on water, growth,
fire risk and animal behaviour. Wildfires ignite, spread with wind, consume
fuel and leave a burn scar that recovers over the following seasons. Pathogens
emerge, spread between nearby hosts, build immunity in the survivors and fade —
classic SIR dynamics, run per individual.

## Interface

- **Scales** — planet, region, local, organism, micro, each with its own camera
  behaviour, from cinematic orbits down to a single animal.
- **Inspector** — full profile, traits, genome, memories, known locations,
  family tree, recent events; follow, centre on, compare or favourite an animal.
- **Encyclopedia** — every species with live population, diet, habitat and
  evolving notes; an interactive food web drawn from real predation events; and
  a biodiversity index computed from the simulation.
- **World history** — an automatic timeline of births, kills, fires, outbreaks,
  droughts and discoveries, and a "While You Were Away" expedition report after
  a reload.
- **Sandbox tools** — spawn, remove, clone and relocate animals; plant and clear
  vegetation; raise and lower terrain; create and drain water; inject weather;
  start fires, floods, outbreaks or a meteor.
- **Persistence** — worlds are saved to IndexedDB with terrain, animals,
  genomes, weather, time, event history and settings, with autosave, plus
  export and import.

### Controls

| key | action |
| --- | --- |
| `Space` | pause / resume |
| `1`–`7` | 1×, 2×, 5×, 10×, 25×, 50×, 100× |
| `J` / `Shift+J` | jump a day or a week / a month |
| `W` `A` `S` `D` | fly forward, back and sideways |
| `←` `→` `↑` `↓` | the same, for one-handed flying |
| `Q` `E` | turn the camera |
| `F` `G` `C` `O` `V` | free, follow, cinematic, overhead, organism camera |
| `P` | cycle scale |
| `D` | documentary mode |
| `L` | world library |
| `Tab` | show or hide panels |
| `?` | help |
| `Esc` | clear selection |

Drag with the left button to orbit, with the right or middle button to pan, and
with `Shift` held to pan. The wheel zooms — hold `Shift` for a fine step, `Ctrl`
for a coarse one. Click selects; double-click selects an animal and follows it.

## Repository layout

```
src/core/       seeded RNG, math, config, event bus, clock
src/world/      terrain, climate, hydrology, soil, vegetation, trees, fire,
                aggregates, disease, census, history, world (the simulation host)
src/life/       genome, spatial index, species definitions, organism store,
                carcass store, AI, creature simulation
src/render/     renderer, triplanar terrain material, texture library,
                vegetation and creature instancing, props, effects, sky,
                selection, camera rig, overlay
src/sim/        host loop, timing, persistence store
src/ui/         HUD, panels, styles
src/audio/      reactive ambience
tools/          headless probes for testing the simulation (see tools/README.md),
                plus the asset pipeline: gen-tex.mjs, fetch-assets.mjs, texstats.mjs
public/assets/  CC0 ground materials and generated bark, foliage and water maps
```

## Testing

There is no unit-test suite; the simulation is tested by running it. `tools/`
contains probes that execute the real world headlessly and print what happened,
which is how the ecology is balanced. See `tools/README.md`.

## Assets

The ground is made of eight real scanned materials — grass, sand, rock, snow,
dry ground, mossy stone, cliff rock and gravel — all of them **CC0 1.0** from
[ambientCG](https://ambientcg.com), fetched through pinned GitHub mirrors and
normalised to consistent brightness by `tools/fetch-assets.mjs`. Everything
else is generated in this repository: bark, foliage, grass and reed cards, the
water normal map and the foam map by `tools/gen-tex.mjs`, and terrain, plants,
animals and sky procedurally at runtime.

Full provenance and licence for every file is in
[`public/assets/ATTRIBUTION.md`](public/assets/ATTRIBUTION.md). Nothing is
fetched from a third party when the app runs; the only runtime dependency is
[three.js](https://threejs.org) (MIT).

## Hosting

The build is a static bundle with relative asset paths, so it works from a
subdirectory. `.github/workflows/deploy-pages.yml` builds and publishes it to
GitHub Pages on every push to `main`; there is no server component and no
backend to run.
