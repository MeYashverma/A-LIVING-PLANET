import * as THREE from 'three';
import { clamp, clamp01, TAU } from '../core/math';
import { BIOMES, Biome, isWaterBiome } from '../world/biomes';
import { TREE_SPECIES, TreeState } from '../world/trees';
import { HomeKind } from '../life/organism';
import { QUALITY_PRESETS, RENDER } from '../core/config';
import { SPECIES } from '../life/species';
import type { World } from '../world/world';
import type { MaterialSet, TextureLibrary } from './textures';

interface InstancedSet {
  mesh: THREE.InstancedMesh;
  phase: THREE.InstancedBufferAttribute;
  foliage: THREE.InstancedBufferAttribute;
  burn: THREE.InstancedBufferAttribute;
  snow: THREE.InstancedBufferAttribute;
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * Everything that is not terrain, water or an animal: trees, understorey
 * snags, boulders, carcasses, nests, burrows and track decals. All of it is
 * drawn instanced from simulation state, so a tree that dies really does
 * disappear from the scene and a carcass really does shrink as it is eaten.
 */
export class Props {
  readonly group = new THREE.Group();
  private trees: InstancedSet[] = [];
  private saplings: InstancedSet;
  private logs: InstancedSet;
  private rocks: InstancedSet;
  private carcasses: InstancedSet;
  private nests: InstancedSet;
  private burrows: InstancedSet;
  private tracks: InstancedSet;
  private lastTreeRefresh = -1e9;
  private lastCenter = new THREE.Vector2(1e9, 1e9);
  private rockList: { x: number; y: number; z: number; scale: number; yaw: number }[] = [];
  private treeCap: number[];
  private dummy = new THREE.Object3D();
  private timeUniforms: Record<string, THREE.IUniform>[] = [];

  constructor(private world: World, quality: 'low' | 'medium' | 'high' | 'ultra', private textures?: TextureLibrary) {
    const preset = QUALITY_PRESETS[quality];
    const treeCap = Math.max(200, Math.round(3400 * preset.trees));

    // Two tree species, each with a detailed and a distant geometry.
    for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
      for (const detail of [true, false]) {
        const geo = sp === 0 ? buildBroadleaf(detail) : buildConifer(detail);
        const barkSet = textures?.bark?.[sp === 0 ? 'oak' : 'pine'];
        const set = this.makeSet(geo, treeCap, 'tree', detail, barkSet);
        this.trees.push(set);
        this.group.add(set.mesh);
      }
    }
    this.treeCap = this.trees.map((t) => t.mesh.instanceMatrix.count);

    this.saplings = this.makeSet(buildBroadleaf(false, true), Math.round(treeCap * 0.5), 'sapling', true);
    this.logs = this.makeSet(buildLog(), Math.round(treeCap * 0.25), 'log', true);
    this.rocks = this.makeSet(buildRock(), Math.round(420 * preset.trees), 'rock', true, textures?.ground?.cliff);
    void this.textures;
    this.carcasses = this.makeSet(buildCarcass(), 90, 'carcass', true);
    this.nests = this.makeSet(buildNest(), 120, 'nest', true);
    this.burrows = this.makeSet(buildBurrow(), 160, 'burrow', true);
    this.tracks = this.makeSet(buildTrack(), 260, 'track', true);
    this.group.add(this.saplings.mesh, this.logs.mesh, this.rocks.mesh, this.carcasses.mesh, this.nests.mesh, this.burrows.mesh, this.tracks.mesh);

    this.generateRocks();
    void TREE_SPECIES;
  }

  private makeSet(geo: THREE.BufferGeometry, capacity: number, kind: string, detail: boolean, bark?: MaterialSet): InstancedSet {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    const uniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.4, 0.2) },
      uSeason: { value: 0 },
      uAutumn: { value: 0 },
      uSnow: { value: 0 },
      uMoon: { value: 0 },
      uBarkScale: { value: 3.0 },
      uBarkColor: { value: bark ? bark.color : null },
      uBarkNormal: { value: bark ? bark.normal : null },
      uBarkRough: { value: bark ? bark.rough : null },
      uHasBark: { value: bark ? 1 : 0 },
    };
    this.timeUniforms.push(uniforms);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      shader.uniforms.uAutumn = uniforms.uAutumn;
      shader.uniforms.uSnow = uniforms.uSnow;
      shader.uniforms.uMoon = uniforms.uMoon;
      shader.uniforms.uBarkScale = uniforms.uBarkScale;
      shader.uniforms.uBarkColor = uniforms.uBarkColor;
      shader.uniforms.uBarkNormal = uniforms.uBarkNormal;
      shader.uniforms.uBarkRough = uniforms.uBarkRough;
      shader.uniforms.uHasBark = uniforms.uHasBark;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute float aPhase;
          attribute float aFoliage;
          attribute float aBurn;
          attribute float aSnow;
          uniform float uTime;
          uniform vec2 uWind;
          uniform float uSnow;
          varying float vFoliage;
          varying float vBurn;
          varying float vSnow;
          varying float vLocalY;
          varying vec3 vLocalPos;
          uniform float uBarkScale;
          uniform sampler2D uBarkColor;
          uniform sampler2D uBarkNormal;
          uniform sampler2D uBarkRough;
          uniform float uHasBark;
        `,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vFoliage = aFoliage;
          vBurn = aBurn;
          vSnow = aSnow;
          vLocalY = position.y;
          vLocalPos = position;
          // Sway is proportional to height above the base and to wind strength.
          float h = max(position.y, 0.0);
          float bend = h * h * 0.0025;
          float gust = sin(uTime * 0.9 + aPhase * 6.28) * 0.5 + sin(uTime * 2.3 + aPhase * 11.0) * 0.22;
          vec2 wd = normalize(uWind + vec2(0.001));
          float strength = (length(uWind) * 0.06 + 0.06) * bend;
          transformed.x += wd.x * gust * strength + abs(gust) * bend * 0.25;
          transformed.z += wd.y * gust * strength;
          // Leafless trees in winter shrink their canopy toward the branches.
          if (position.y > 0.5) {
            transformed.xz *= mix(0.45, 1.0, aFoliage);
          }
        `,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying float vFoliage;
          varying float vBurn;
          varying float vSnow;
          varying float vLocalY;
          uniform float uAutumn;
          uniform float uSnow;
          uniform float uMoon;
        `,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          // Canopy vertices carry a green colour; trunk vertices a brown one.
          // Autumn turns leaves before they drop.
          vec3 foliage = diffuseColor.rgb;
          bool isCanopy = foliage.g > foliage.r * 1.05 && vLocalY > 0.4;
          if (isCanopy) {
            vec3 autumn = vec3(0.62, 0.33, 0.1);
            vec3 summer = vec3(0.24, 0.42, 0.16);
            vec3 winter = vec3(0.45, 0.38, 0.3);
            vec3 target = mix(summer, autumn, uAutumn);
            target = mix(target, winter, clamp(1.0 - vFoliage, 0.0, 1.0) * 0.5);
            diffuseColor.rgb = mix(target, diffuseColor.rgb * 0.8, 0.35) * (0.85 + vFoliage * 0.3);
          } else if (uHasBark > 0.5 && !isCanopy) {
            // Trunks get real bark, box-projected in object space: a cylinder
            // has no sensible single UV set once several primitives are merged,
            // and a box projection tiles it correctly on every face.
            vec3 p = vLocalPos;
            vec3 n = normalize(vLocalPos + vec3(0.0, 0.001, 0.0));
            vec3 bw = pow(abs(n), vec3(6.0));
            bw /= max(1e-4, bw.x + bw.y + bw.z);
            float s = uBarkScale;
            vec3 tex = texture2D(uBarkColor, p.zy * s).rgb * bw.x
                     + texture2D(uBarkColor, p.xz * s).rgb * bw.y
                     + texture2D(uBarkColor, p.xy * s).rgb * bw.z;
            // Bark is darker and cooler than the flat colour it replaces, and
            // the replace is partial so the per-tree tint still shows through.
            diffuseColor.rgb = mix(diffuseColor.rgb, tex * diffuseColor.rgb * 3.2, 0.72);
            diffuseColor.rgb *= mix(0.86, 1.04, clamp(vLocalY * 0.12, 0.0, 1.0));
          } else {
            // Bark darkens when wet and lightens with snow load.
            diffuseColor.rgb *= mix(0.8, 1.05, clamp(vLocalY * 0.1, 0.0, 1.0));
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.09, 0.09), clamp(vBurn, 0.0, 1.0) * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.98), clamp(vSnow, 0.0, 1.0) * 0.6);
          diffuseColor.rgb *= mix(1.0, 0.6, uMoon * 0.6);
        `,
        );
    };
    material.customProgramCacheKey = () => `prop-${kind}-${detail ? 'hi' : 'lo'}-v1`;

    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.castShadow = detail && kind !== 'track' && kind !== 'burrow';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const phase = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const foliage = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const burn = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const snow = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [phase, foliage, burn, snow]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPhase', phase);
    geo.setAttribute('aFoliage', foliage);
    geo.setAttribute('aBurn', burn);
    geo.setAttribute('aSnow', snow);
    return { mesh, phase, foliage, burn, snow, uniforms };
  }

  /** Deterministic boulder scattering (rocks do not move, so this is done once). */
  private generateRocks(): void {
    const t = this.world.terrain;
    const rng = this.world.rng;
    const target = this.rocks.mesh.instanceMatrix.count;
    let placed = 0;
    let guard = 0;
    while (placed < target && guard++ < target * 30) {
      const cx = rng.int(1, t.size - 2);
      const cy = rng.int(1, t.size - 2);
      const i = cy * t.size + cx;
      if (!t.land[i] || t.waterDepth.data[i] > 0.4) continue;
      const biome = t.biome.data[i] as Biome;
      const slope = t.slope.data[i];
      // Boulders belong to broken ground: scree slopes, ridgelines and burns,
      // not the middle of a grassy plain.
      const rocky =
        isWaterBiome(biome)
          ? 0
          : clamp01(slope * 3.4 - 0.22 + (biome === Biome.Alpine ? 0.85 : biome === Biome.Snow ? 0.6 : 0)) *
            clamp01(1 - t.canopy.data[i]);
      if (rng.next() > rocky * 0.8) continue;
      this.rockList.push({
        x: t.cellToWorldX(cx) + rng.range(-1, 1),
        y: t.cellToWorldY(cy) + rng.range(-1, 1),
        z: t.elevationOf(t.height.data[i]) - 0.2,
        scale: rng.range(0.5, 2.4) * (1 + slope * 1.6),
        yaw: rng.range(0, TAU),
      });
      placed++;
    }
  }

  /** Refresh instance lists. Tree coverage changes slowly, so this is throttled. */
  update(cameraPos: THREE.Vector3, dtSeconds: number, season: number, snowCover: number, night: number): void {
    const now = performance.now();
    const moved = this.lastCenter.distanceTo(new THREE.Vector2(cameraPos.x, cameraPos.z)) > 12;
    const due = now - this.lastTreeRefresh > (moved ? 700 : 2500);
    for (const u of this.timeUniforms) {
      u.uTime.value += dtSeconds;
      u.uMoon.value = night;
      u.uSeason.value = season;
      // Autumn peaks in early autumn, then leaves fall (tracked per tree).
      u.uAutumn.value = clamp01(1 - Math.abs(season - 0.55) * 4);
    }
    if (due) {
      this.lastTreeRefresh = now;
      this.lastCenter.set(cameraPos.x, cameraPos.z);
      this.refreshTrees(cameraPos, season, snowCover);
      this.refreshGroundProps(cameraPos);
    }
    this.refreshDynamicProps();
  }

  private refreshTrees(cameraPos: THREE.Vector3, season: number, snowCover: number): void {
    const world = this.world;
    const store = world.forest.store;
    const counts = this.trees.map(() => 0);
    const caps = this.treeCap;
    const drawDist = RENDER.treeDrawDistance;
    const lodDist = RENDER.treeLodDistance;
    let saplingN = 0;
    let logN = 0;
    const saplingCap = this.saplings.mesh.instanceMatrix.count;
    const logCap = this.logs.mesh.instanceMatrix.count;
    const cameraX = cameraPos.x;
    const cameraZ = cameraPos.z;

    for (let i = 0; i < store.count; i++) {
      if (!store.alive[i]) continue;
      const x = store.x[i];
      const y = store.y[i];
      const dist = Math.hypot(x - cameraX, y - cameraZ);
      if (dist > drawDist) continue;
      const state = store.state[i] as TreeState;
      const sp = store.species[i];
      const height = store.height[i];
      const radius = store.radius[i];
      const health = clamp01(store.health[i]);
      const burn = clamp01(store.burn[i]);
      const decay = clamp01(store.decay[i]);
      const foliage = store.leafDrop ? clamp01(1 - store.leafDrop[i]) : 1;
      const z = world.terrain.elevationAtWorld(x, y);
      if (height < 2.4 || state === TreeState.Fallen) {
        if (logN < logCap && state !== TreeState.Fallen) {
          this.dummy.position.set(x, z, y);
          this.dummy.rotation.set(0, (i * 1.7) % TAU, 0);
          const s = clamp(height * 0.35, 0.25, 1.4);
          this.dummy.scale.set(s, s, s);
          this.dummy.updateMatrix();
          this.logs.mesh.setMatrixAt(logN, this.dummy.matrix);
          this.logs.phase.setX(logN, (i * 0.137) % 1);
          this.logs.foliage.setX(logN, 0);
          this.logs.burn.setX(logN, burn);
          this.logs.snow.setX(logN, clamp01(snowCover * 0.8));
          logN++;
        } else if (saplingN < saplingCap) {
          this.dummy.position.set(x, z, y);
          this.dummy.rotation.set(0, (i * 2.3) % TAU, 0);
          const s = clamp(height * 0.4, 0.2, 1.1);
          this.dummy.scale.set(s, s, s);
          this.dummy.updateMatrix();
          this.saplings.mesh.setMatrixAt(saplingN, this.dummy.matrix);
          this.saplings.phase.setX(saplingN, (i * 0.31) % 1);
          this.saplings.foliage.setX(saplingN, foliage);
          this.saplings.burn.setX(saplingN, burn);
          this.saplings.snow.setX(saplingN, clamp01(snowCover * 0.7));
          saplingN++;
        }
        continue;
      }
      if (state === TreeState.Snag && height < 4) continue;
      const detailWanted = dist < lodDist;
      const setIndex = sp * 2 + (detailWanted ? 0 : 1);
      const set = this.trees[setIndex];
      const n = counts[setIndex];
      if (n >= caps[setIndex]) continue;
      this.dummy.position.set(x, z, y);
      this.dummy.rotation.set(0, (i * 1.37) % TAU, 0);
      // The tree meshes are built about 1 m tall and 0.4 m wide at unit scale.
      // Scaling them by height / maxHeight drew a 26 m tree at about 1 m.
      // Scale to the simulated height and crown radius instead.
      const crown = sp === 0 ? 0.4 : 0.24;
      this.dummy.scale.set(radius / crown, height, radius / crown);
      this.dummy.updateMatrix();
      set.mesh.setMatrixAt(n, this.dummy.matrix);
      set.phase.setX(n, (i * 0.113) % 1);
      set.foliage.setX(n, state === TreeState.Snag ? 0 : foliage * (0.35 + health * 0.65));
      set.burn.setX(n, burn);
      set.snow.setX(n, clamp01(snowCover * (0.4 + (1 - foliage) * 0.6)));
      counts[setIndex] = n + 1;
      void decay;
      void season;
    }

    for (let k = 0; k < this.trees.length; k++) {
      const set = this.trees[k];
      set.mesh.count = counts[k];
      (set.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
      set.phase.needsUpdate = true;
      set.foliage.needsUpdate = true;
      set.burn.needsUpdate = true;
      set.snow.needsUpdate = true;
    }
    this.saplings.mesh.count = saplingN;
    this.saplings.phase.needsUpdate = true;
    this.saplings.foliage.needsUpdate = true;
    this.saplings.burn.needsUpdate = true;
    this.saplings.snow.needsUpdate = true;
    (this.saplings.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.logs.mesh.count = logN;
    this.logs.phase.needsUpdate = true;
    this.logs.burn.needsUpdate = true;
    this.logs.snow.needsUpdate = true;
    (this.logs.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private refreshGroundProps(cameraPos: THREE.Vector3): void {
    // Rocks: only those near the camera are drawn.
    const cap = this.rocks.mesh.instanceMatrix.count;
    let n = 0;
    const radius = 320;
    for (const r of this.rockList) {
      if (n >= cap) break;
      if (Math.abs(r.x - cameraPos.x) > radius || Math.abs(r.y - cameraPos.z) > radius) continue;
      const dist = Math.hypot(r.x - cameraPos.x, r.y - cameraPos.z);
      if (dist > radius) continue;
      this.dummy.position.set(r.x, r.z, r.y);
      this.dummy.rotation.set(r.yaw * 0.3, r.yaw, r.yaw * 0.2);
      this.dummy.scale.set(r.scale, r.scale * 0.75, r.scale);
      this.dummy.updateMatrix();
      this.rocks.mesh.setMatrixAt(n, this.dummy.matrix);
      this.rocks.phase.setX(n, r.yaw % 1);
      this.rocks.foliage.setX(n, 0.4);
      this.rocks.burn.setX(n, 0);
      this.rocks.snow.setX(n, 0.2);
      n++;
    }
    this.rocks.mesh.count = n;
    (this.rocks.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.rocks.phase.needsUpdate = true;
    this.rocks.foliage.needsUpdate = true;
    this.rocks.burn.needsUpdate = true;
    this.rocks.snow.needsUpdate = true;
  }

  /** Carcasses, nests, burrows and tracks change every second. */
  private refreshDynamicProps(): void {
    const world = this.world;
    const t = world.terrain;
    const carcassCap = this.carcasses.mesh.instanceMatrix.count;
    let cn = 0;
    for (const c of world.carcasses.all()) {
      if (cn >= carcassCap) break;
      const z = t.elevationAtWorld(c.x, c.y);
      const spIdx = c.speciesIdx >= 0 ? c.speciesIdx : 0;
      const sp = SPECIES[spIdx];
      const scale = clamp(sp.bodyLength * 0.5 * clamp(0.35 + c.massKg / Math.max(1, sp.massKg), 0.3, 1.2), 0.15, 3);
      this.dummy.position.set(c.x, z + scale * 0.12, c.y);
      this.dummy.rotation.set(0, (c.id * 0.7) % TAU, 0);
      this.dummy.scale.set(scale, scale * 0.45, scale * 0.8);
      this.dummy.updateMatrix();
      this.carcasses.mesh.setMatrixAt(cn, this.dummy.matrix);
      this.carcasses.phase.setX(cn, (c.id * 0.31) % 1);
      this.carcasses.foliage.setX(cn, clamp01(c.massKg / Math.max(1, sp.massKg)));
      this.carcasses.burn.setX(cn, c.cause === 'wildfire' ? 0.7 : 0);
      this.carcasses.snow.setX(cn, 0.1);
      cn++;
    }
    this.carcasses.mesh.count = cn;
    (this.carcasses.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;

    // Nests and burrows come from animal home sites.
    const creatures = world.creatures;
    const nestCap = this.nests.mesh.instanceMatrix.count;
    const burrowCap = this.burrows.mesh.instanceMatrix.count;
    let nn = 0;
    let bn = 0;
    for (let i = 0; i < creatures.capacity; i++) {
      if (!creatures.alive[i] || !creatures.hasHome[i]) continue;
      const kind = creatures.homeKind[i];
      const x = creatures.homeX[i];
      const y = creatures.homeY[i];
      const z = t.elevationAtWorld(x, y);
      if (kind === HomeKind.Nest || kind === HomeKind.Roost || kind === HomeKind.Den) {
        if (nn >= nestCap) continue;
        const sp = SPECIES[creatures.speciesIdx[i]];
        const s = clamp(0.5 + sp.massKg * 0.012, 0.4, 1.6);
        this.dummy.position.set(x, z, y);
        this.dummy.rotation.set(0, (i * 1.1) % TAU, 0);
        this.dummy.scale.set(s, s * 0.7, s);
        this.dummy.updateMatrix();
        this.nests.mesh.setMatrixAt(nn, this.dummy.matrix);
        this.nests.phase.setX(nn, (i * 0.37) % 1);
        this.nests.foliage.setX(nn, 0.3);
        this.nests.burn.setX(nn, 0);
        this.nests.snow.setX(nn, 0.2);
        nn++;
      } else if (kind === HomeKind.Burrow) {
        if (bn >= burrowCap) continue;
        this.dummy.position.set(x, z + 0.05, y);
        this.dummy.rotation.set(0, (i * 0.9) % TAU, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.burrows.mesh.setMatrixAt(bn, this.dummy.matrix);
        this.burrows.phase.setX(bn, (i * 0.53) % 1);
        this.burrows.foliage.setX(bn, 0.2);
        this.burrows.burn.setX(bn, 0);
        this.burrows.snow.setX(bn, 0);
        bn++;
      }
    }
    this.nests.mesh.count = nn;
    (this.nests.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.burrows.mesh.count = bn;
    (this.burrows.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;

    // Track decals.
    const trackCap = this.tracks.mesh.instanceMatrix.count;
    const tracks = world.tracks;
    let tn = 0;
    for (let i = tracks.length - 1; i >= 0 && tn < trackCap; i--) {
      const tr = tracks[i];
      const age = world.clock.day - tr.day;
      if (age > 3) continue;
      const strength = clamp01(tr.strength * (1 - age / 3));
      if (strength < 0.05) continue;
      const z = t.elevationAtWorld(tr.x, tr.y) + 0.03;
      this.dummy.position.set(tr.x, z, tr.y);
      this.dummy.rotation.set(-Math.PI / 2, (i * 0.7) % TAU, 0);
      const s = 0.5 + strength * 0.7;
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.tracks.mesh.setMatrixAt(tn, this.dummy.matrix);
      this.tracks.phase.setX(tn, (i * 0.19) % 1);
      this.tracks.foliage.setX(tn, strength);
      this.tracks.burn.setX(tn, 0);
      this.tracks.snow.setX(tn, 0);
      tn++;
    }
    this.tracks.mesh.count = tn;
    (this.tracks.mesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** Force a refresh of the slow props (after sculpting or a disaster). */
  markDirty(): void {
    this.lastTreeRefresh = -1e9;
    this.lastCenter.set(1e9, 1e9);
  }

  get rockCount(): number {
    return this.rockList.length;
  }

  dispose(): void {
    for (const set of [...this.trees, this.saplings, this.logs, this.rocks, this.carcasses, this.nests, this.burrows, this.tracks]) {
      set.mesh.geometry.dispose();
      (set.mesh.material as THREE.Material).dispose();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function tinted(geo: THREE.BufferGeometry, color: [number, number, number], variance = 0.07, seed = 1): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 1 + ((Math.sin(i * 78.233 + seed * 12.9898) * 43758.5453) % 1) * variance * 2 - variance;
    colors[i * 3] = clamp01(color[0] * v);
    colors[i * 3 + 1] = clamp01(color[1] * v);
    colors[i * 3 + 2] = clamp01(color[2] * v);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
    vCount += n;
    iCount += g.index ? g.index.count : n;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const pp = g.getAttribute('position') as THREE.BufferAttribute;
    const pn = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const pc = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    pos.set(pp.array as Float32Array, vo * 3);
    if (pn) nor.set(pn.array as Float32Array, vo * 3);
    if (pc) col.set(pc.array as Float32Array, vo * 3);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < pp.count; i++) idx[io + i] = i + vo;
      io += pp.count;
    }
    vo += pp.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Broadleaf: tapered trunk, a few branches and 3–5 canopy blobs. */
function buildBroadleaf(detail: boolean, sapling = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = sapling ? 1.2 : 0.42;
  const trunk = tinted(new THREE.CylinderGeometry(0.012, 0.03, trunkH, detail ? 7 : 5), [0.24, 0.19, 0.14], 0.08, 1);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(trunk);
  if (detail) {
    for (let b = 0; b < 4; b++) {
      const ang = (b / 4) * TAU + 0.6;
      const len = 0.2 + (b % 2) * 0.12;
      const br = tinted(new THREE.CylinderGeometry(0.006, 0.014, len, 4), [0.24, 0.19, 0.14], 0.06, b + 3);
      br.translate(0, len / 2, 0);
      br.rotateZ(0.7 + (b % 3) * 0.15);
      br.rotateY(ang);
      br.translate(0, trunkH * (0.62 + (b % 3) * 0.12), 0);
      parts.push(br);
    }
  }
  const blobs = sapling ? 2 : detail ? 5 : 3;
  for (let b = 0; b < blobs; b++) {
    const ang = (b / blobs) * TAU;
    const r = 0.16 + ((b * 7) % 5) * 0.02;
    const blob = tinted(new THREE.IcosahedronGeometry(r, detail ? 1 : 0), [0.22, 0.4, 0.15], 0.12, b * 5 + 2);
    blob.scale(1.1, 0.85, 1.1);
    const rad = sapling ? 0.06 : 0.12 + (b % 3) * 0.06;
    blob.translate(Math.cos(ang) * rad, 0.42 + (b % 4) * 0.12 + trunkH * 0.3, Math.sin(ang) * rad);
    parts.push(blob);
  }
  return mergeGeos(parts);
}

/** Conifer: straight trunk with stacked cones. */
function buildConifer(detail: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = 0.68;
  const trunk = tinted(new THREE.CylinderGeometry(0.008, 0.026, trunkH, detail ? 7 : 5), [0.22, 0.16, 0.11], 0.08, 11);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(trunk);
  const layers = detail ? 5 : 3;
  for (let l = 0; l < layers; l++) {
    const t = l / layers;
    const r = 0.22 * (1 - t * 0.75);
    const h = 0.22 * (1 - t * 0.4);
    const cone = tinted(new THREE.ConeGeometry(r, h, detail ? 8 : 6, 1), [0.14, 0.27, 0.13], 0.1, l * 3 + 5);
    cone.translate(0, 0.16 + t * 0.55 + h * 0.3, 0);
    parts.push(cone);
  }
  parts.push(tinted(new THREE.ConeGeometry(0.07, 0.2, detail ? 7 : 5), [0.15, 0.3, 0.14], 0.08, 21).translate(0, 0.9, 0));
  return mergeGeos(parts);
}

function buildLog(): THREE.BufferGeometry {
  const g = tinted(new THREE.CylinderGeometry(0.09, 0.12, 1.1, 7), [0.26, 0.2, 0.15], 0.1, 31);
  g.rotateZ(Math.PI / 2);
  return g;
}

function buildRock(): THREE.BufferGeometry {
  const g = tinted(new THREE.IcosahedronGeometry(1, 1), [0.34, 0.33, 0.31], 0.16, 41);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  // Rough up the sphere so rocks are angular.
  for (let i = 0; i < pos.count; i++) {
    const n = Math.sin(pos.getX(i) * 7.3) * Math.cos(pos.getY(i) * 5.7) * Math.sin(pos.getZ(i) * 6.1);
    const s = 1 + n * 0.22;
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.75, pos.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

function buildCarcass(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = tinted(new THREE.SphereGeometry(0.5, 8, 6), [0.35, 0.28, 0.24], 0.1, 51);
  body.scale(1, 0.6, 0.75);
  parts.push(body);
  const head = tinted(new THREE.SphereGeometry(0.2, 6, 5), [0.3, 0.24, 0.2], 0.1, 53);
  head.translate(0.48, 0.1, 0);
  parts.push(head);
  return mergeGeos(parts);
}

function buildNest(): THREE.BufferGeometry {
  const g = tinted(new THREE.TorusGeometry(0.5, 0.22, 5, 10), [0.32, 0.24, 0.14], 0.14, 61);
  g.rotateX(Math.PI / 2);
  g.scale(1, 0.5, 1);
  return g;
}

function buildBurrow(): THREE.BufferGeometry {
  const g = tinted(new THREE.CircleGeometry(0.5, 10), [0.12, 0.1, 0.08], 0.2, 71);
  g.rotateX(-Math.PI / 2);
  return g;
}

function buildTrack(): THREE.BufferGeometry {
  const g = tinted(new THREE.PlaneGeometry(0.4, 0.5), [0.18, 0.16, 0.14], 0.25, 81);
  g.rotateX(-Math.PI / 2);
  return g;
}

