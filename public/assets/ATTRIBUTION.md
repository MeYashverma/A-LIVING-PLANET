# Asset attribution

Everything the simulation and the renderer use at runtime is either generated
procedurally in this repository or downloaded from a public-domain source listed
below. There are no assets with unclear provenance and nothing is fetched from a
third party at runtime — the app works offline once loaded.

## Generated in this repository

| Asset | Generator | Notes |
| --- | --- | --- |
| Terrain, biome colour, snow, fire scars | `src/world/terrain.ts`, `src/render/terrainMesh.ts` | derived from the simulation |
| Bark (pine, oak, birch), colour + normal + roughness | `tools/gen-tex.mjs` | tileable, anisotropic fibre noise |
| Foliage cards (broadleaf, conifer, willow) | `tools/gen-tex.mjs` | RGBA cutout sprites drawn leaf by leaf |
| Grass, dry grass and reed cards | `tools/gen-tex.mjs` | RGBA cutout blade fans |
| Water normal map, foam | `tools/gen-tex.mjs` | analytic travelling-wave normals |
| Trees, animals, rocks, logs, nests, carcasses | `src/render/props.ts`, `src/render/creatureRenderer.ts` | procedural geometry |
| Sky, clouds, stars, lightning | `src/render/sky.ts` | procedural shaders |
| Birdsong, wind, water, weather, insect ambience | `src/audio/ambience.ts` | synthesised from noise and oscillators |

Run `node tools/gen-tex.mjs` to rebuild the generated set, or
`node tools/fetch-assets.mjs` to rebuild the downloaded set.

## Downloaded — ground materials

All of the following are **CC0 1.0 Universal** (public domain dedication) from
[ambientCG](https://ambientcg.com), fetched through GitHub mirrors by
`tools/fetch-assets.mjs` and transcoded to the sizes the renderer binds
(albedo 1024², normal 1024², roughness 512²). Attribution is not required by the
licence; it is given here as a courtesy to the authors.

| File in `public/assets/ground/` | ambientCG asset | Fetched from | Licence |
| --- | --- | --- | --- |
| `grass_color/normal/rough.jpg` | Grass | `Dev2150/KyberPlanet` | CC0-1.0 |
| `sand_color/normal/rough.jpg` | Sand | `Dev2150/KyberPlanet` | CC0-1.0 |
| `rock_color/normal/rough.jpg` | Rock | `Dev2150/KyberPlanet` | CC0-1.0 |
| `snow_color/normal/rough.jpg` | Snow | `Dev2150/KyberPlanet` | CC0-1.0 |
| `dirt_color/normal/rough.jpg` | DryGroundRocks | `ashalluf/rando-game` | CC0-1.0 |
| `moss_color/normal/rough.jpg` | AerialGrassRock | `ashalluf/rando-game` | CC0-1.0 |
| `cliff_color/normal/rough.jpg` | Rock064 | `ashalluf/rando-game` | CC0-1.0 |
| `gravel_color/normal.jpg` | Gravel029 | `fazil47/tiny-planet` | CC0-1.0 |

The ambientCG licence statement for CC0 assets reads, in full: *"You can use
these assets for free in any project, including commercial ones. You do not need
to give attribution, though it is appreciated."* The CC0 1.0 deed is at
<https://creativecommons.org/publicdomain/zero/1.0/>.

## Downloaded — animal models

| File in `public/assets/models/quaternius/` | Model | Source | Licence |
| --- | --- | --- | --- |
| `stag.glb` (game species: deer) | Stag, rigged, clips Walk, Gallop, Idle, Eating, Idle_Headlow, Attack_Headbutt, Death | Quaternius, *Ultimate Animated Animal Pack* (<https://quaternius.com/packs/ultimateanimatedanimals.html>). Copy taken from `postojomierz-lang/postojomierz` (`rysy/models/animals/stag.glb`), recoloured there | CC0-1.0 (`QUATERNIUS-LICENSE.txt`) |
| `wolf.glb` (wolf) | Wolf, rigged, clips Walk, Gallop, Idle, Eating, Attack, Death | As above, `rysy/models/animals/wolf.glb` | CC0-1.0 |
| `reyneke/goat.glb` (game species: goat) | Goat, realistic mesh by **hendrikReyneke** on Sketchfab (<https://sketchfab.com/3d-models/goat-2624ac2ce2364930ba2d5f70eb7aa1ea>), rigged and animated in this repository (`tools/animal_models/rig_goat.py`: skeleton, skin weights, clips Idle, Walk, Gallop, Eating, Death). Mesh and texture unchanged. Source copy taken from `tot-ra/rebel-reval` (`assets/animals/hendrik_reyneke/goat/goat.glb`) | CC BY 4.0 (attribution required; changes: rigged and animated) |
| `molochdadev/bear.glb` (game species: bear) | Bear, low-poly mesh by **molochdadev**, Poly Pizza (<https://poly.pizza/u/molochdadev>), copy from `yinasaurus/hack-for-humanity` (`mobile/assets/characters/bear.glb`). Rigged and animated in this repository (`tools/animal_models/rig_goat.py`, `RIG_TARGET=bear`): skeleton, skin weights, clips Idle, Walk, Gallop, Eating, Death | CC BY 4.0 (attribution required; changes: rigged and animated) |

The Quaternius licence is in `public/assets/models/quaternius/QUATERNIUS-LICENSE.txt`.

Generated animal models (`public/assets/models/animals/`: rabbit, deer, wolf, lynx,
bison, goat, bear) come from `tools/animal_models/build_animals.py` in this repository.
They are procedural, and are the fallback when a Quaternius model fails to load.

## Third-party software

| Package | Licence |
| --- | --- |
| [three.js](https://threejs.org) | MIT |
| [Vite](https://vite.dev) | MIT |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 |
| WebGL Water by Evan Wallace (algorithm and shader logic, adapted in `src/render/waterSim.ts`) | MIT, Copyright 2011 Evan Wallace, <http://madebyevan.com/webgl-water/> |
| Fox skinned model and animations (`assets/models/mesh2motion-fox.glb`) | Mesh2Motion fox model, rig and clips (Walk, Run, Idle, Sit, Bite, Death) | `Mesh2Motion/mesh2motion-app` (`static/animations/fox-animations.glb`) | CC0-1.0 |
