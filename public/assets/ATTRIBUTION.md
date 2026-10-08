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

## Third-party software

| Package | Licence |
| --- | --- |
| [three.js](https://threejs.org) | MIT |
| [Vite](https://vite.dev) | MIT |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 |
| WebGL Water by Evan Wallace (algorithm and shader logic, adapted in `src/render/waterSim.ts`) | MIT, Copyright 2011 Evan Wallace, <http://madebyevan.com/webgl-water/> |
| Fox skinned model and animations (`assets/models/mesh2motion-fox.glb`) | Mesh2Motion fox model, rig and clips (Walk, Run, Idle, Sit, Bite, Death) | `Mesh2Motion/mesh2motion-app` (`static/animations/fox-animations.glb`) | CC0-1.0 |
| Horse skinned model and animations (`assets/models/mesh2motion-horse.glb`) | Mesh2Motion horse model, rig and clips | `Mesh2Motion/mesh2motion-app` (`static/animations/horse-animations.glb`) | CC0-1.0 |
| Bird skinned model and animations (`assets/models/mesh2motion-bird.glb`) | Mesh2Motion bird model, rig and clips | `Mesh2Motion/mesh2motion-app` (`static/animations/bird-animations.glb`) | CC0-1.0 |
| Shark skinned model and animations (`assets/models/mesh2motion-shark.glb`) | Mesh2Motion shark model, rig and clips | `Mesh2Motion/mesh2motion-app` (`static/animations/shark-animations.glb`) | CC0-1.0 |
