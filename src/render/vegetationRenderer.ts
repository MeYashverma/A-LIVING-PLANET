import * as THREE from 'three';
import { clamp, clamp01, TAU } from '../core/math';
import { BIOMES, Biome, PLANT_INDEX } from '../world/biomes';
import type { World } from '../world/world';
import { QUALITY_PRESETS } from '../core/config';

interface Blade {
  pos: number[];
  blade: number[];
  index: number[];
}

/** A tuft of grass: three tapered blades crossing at the base. */
function makeTuftGeometry(blades = 3, height = 1, spread = 0.35, width = 0.055): THREE.BufferGeometry {
  const pos: number[] = [];
  const bladeAttr: number[] = [];
  const idx: number[] = [];
  const segments = 3;
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI + 0.4;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const lean = (b % 2 === 0 ? 1 : -1) * spread * 0.5;
    const h = height * (0.7 + (b % 3) * 0.16);
    const base = pos.length / 3;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const w = width * (1 - t * 0.9);
      const x = dx * lean * t * t;
      const z = dz * lean * t * t;
      const y = t * h;
      pos.push(x - dz * w, y, z + dx * w);
      bladeAttr.push(t);
      pos.push(x + dz * w, y, z - dx * w);
      bladeAttr.push(t);
    }
    for (let s = 0; s < segments; s++) {
      const i0 = base + s * 2;
      idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(bladeAttr, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) {
    n.setXYZ(i, n.getX(i) * 0.25, Math.abs(n.getY(i)) * 0.25 + 0.75, n.getZ(i) * 0.25);
  }
  g.setIndex(idx);
  return g;
}

/** A low-poly shrub: three overlapping icosahedra. */
function makeShrubGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const offsets: [number, number, number, number][] = [
    [0, 0.25, 0, 0.45],
    [0.28, 0.18, 0.12, 0.32],
    [-0.22, 0.15, -0.16, 0.3],
  ];
  for (const [x, y, z, r] of offsets) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.translate(x, y + r * 0.6, z);
    const b = 0.18 + (offsets.indexOf([x, y, z, r]) === 1 ? 0.06 : 0.12);
    const colors = new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = b * 0.6;
      colors[i + 1] = b;
      colors[i + 2] = b * 0.5;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  return merged;
}

/** Tall reeds: crossed vertical ribbons with a seed head. */
function makeReedGeometry(): THREE.BufferGeometry {
  const g = makeTuftGeometry(4, 1.7, 0.5, 0.05);
  return g;
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  let hasColor = true;
  for (const p of parts) {
    const n = (p.getAttribute('position') as THREE.BufferAttribute).count;
    vCount += n;
    iCount += p.index ? p.index.count : n;
    if (!p.getAttribute('color')) hasColor = false;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = hasColor ? new Float32Array(vCount * 3) : null;
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position') as THREE.BufferAttribute;
    const pn = p.getAttribute('normal') as THREE.BufferAttribute;
    const pc = p.getAttribute('color') as THREE.BufferAttribute | undefined;
    pos.set(pp.array as Float32Array, vo * 3);
    if (pn) nor.set(pn.array as Float32Array, vo * 3);
    if (col && pc) col.set(pc.array as Float32Array, vo * 3);
    if (p.index) {
      for (let i = 0; i < p.index.count; i++) idx[io + i] = p.index.getX(i) + vo;
      io += p.index.count;
    } else {
      for (let i = 0; i < pp.count; i++) idx[io + i] = i + vo;
      io += pp.count;
    }
    vo += pp.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Close-range ground cover. These are *not* the simulation — the simulation
 * keeps biomass fields — they are a visual sample of those fields around the
 * camera, so what you see always matches what the ecosystem calculates.
 */
export class GroundCover {
  readonly group = new THREE.Group();
  private grass: THREE.InstancedMesh;
  private shrub: THREE.InstancedMesh;
  private reed: THREE.InstancedMesh;
  private grassGeo: THREE.BufferGeometry;
  private shrubGeo: THREE.BufferGeometry;
  private reedGeo: THREE.BufferGeometry;
  private grassCount: number;
  private shrubCount: number;
  private reedCount: number;
  private grassCap: number;
  private shrubCap: number;
  private reedCap: number;
  private lastCenter = new THREE.Vector2(1e9, 1e9);
  private lastRefresh = -1e9;
  private uniforms: THREE.IUniform[] = [];

  constructor(private world: World, quality: 'low' | 'medium' | 'high' | 'ultra') {
    const preset = QUALITY_PRESETS[quality];
    this.grassCap = Math.round(3400 * preset.grass);
    this.shrubCap = Math.round(520 * preset.grass);
    this.reedCap = Math.round(820 * preset.grass);
    this.grassCount = 0;
    this.shrubCount = 0;
    this.reedCount = 0;

    this.grassGeo = makeTuftGeometry(3, 0.85, 0.5, 0.05);
    this.shrubGeo = makeShrubGeometry();
    this.reedGeo = makeReedGeometry();

    this.grass = this.makeMesh(this.grassGeo, this.grassCap, 'grass');
    this.shrub = this.makeMesh(this.shrubGeo, this.shrubCap, 'shrub');
    this.reed = this.makeMesh(this.reedGeo, this.reedCap, 'reed');
    this.group.add(this.grass, this.shrub, this.reed);
  }

  private makeMesh(geo: THREE.BufferGeometry, capacity: number, kind: 'grass' | 'shrub' | 'reed'): THREE.InstancedMesh {
    const material = new THREE.MeshLambertMaterial({
      vertexColors: kind === 'shrub',
      side: THREE.DoubleSide,
      transparent: false,
      color: kind === 'shrub' ? 0xffffff : 0xffffff,
    });
    const uniforms: { uTime: THREE.IUniform; uWind: THREE.IUniform; uSeason: THREE.IUniform; uSnow: THREE.IUniform } = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0, 0) },
      uSeason: { value: 0 },
      uSnow: { value: 0 },
    };
    this.uniforms.push(uniforms.uTime, uniforms.uWind, uniforms.uSeason, uniforms.uSnow);
    const useBlade = kind !== 'shrub';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      shader.uniforms.uSeason = uniforms.uSeason;
      shader.uniforms.uSnow = uniforms.uSnow;
      if (useBlade) {
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            /* glsl */ `
            #include <common>
            attribute float aBlade;
            attribute float aHealth;
            attribute float aPhase;
            uniform float uTime;
            uniform vec2 uWind;
            varying float vBlade;
            varying float vHealth;
          `,
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `
            #include <begin_vertex>
            vBlade = aBlade;
            vHealth = aHealth;
            // Bending: stiffness near the base, full motion at the tip.
            float bend = aBlade * aBlade;
            float gust = sin(uTime * 0.7 + aPhase * 6.28) * 0.5 + sin(uTime * 1.9 + aPhase * 12.0) * 0.2;
            vec2 windDir = normalize(uWind + vec2(0.001));
            float strength = (length(uWind) * 0.12 + 0.25) * bend;
            transformed.x += windDir.x * gust * strength + abs(gust) * bend * 0.12;
            transformed.z += windDir.y * gust * strength;
            transformed.y -= abs(gust) * bend * 0.25;
          `,
          )
          .replace(
            '#include <color_fragment>',
            /* glsl */ `
            #include <color_fragment>
            // Dry, snow-pressed or overgrazed plants lose their colour. Tips
            // catch the light, roots sit in shade: the albedo is bounded, so
            // a sunlit meadow never blows out to white.
            vec3 lush = vec3(0.16, 0.27, 0.08);
            vec3 dry = vec3(0.34, 0.31, 0.14);
            vec3 base = mix(dry, lush, clamp(aHealth, 0.0, 1.0));
            diffuseColor.rgb *= mix(base * 0.62, base, clamp(vBlade, 0.0, 1.0));
          `,
          );
      } else {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vCoverage;')
          .replace(
            '#include <color_fragment>',
            /* glsl */ `
          #include <color_fragment>
          diffuseColor.rgb *= 0.7 + clamp(vCoverage, 0.0, 1.0) * 0.35;
        `,
          );
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            /* glsl */ `
            #include <common>
            attribute float aHealth;
            attribute float aPhase;
            uniform vec2 uWind;
            uniform float uTime;
            varying float vCoverage;
          `,
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `
            #include <begin_vertex>
            vCoverage = aHealth;
            transformed.x += sin(uTime * 0.9 + aPhase * 6.28) * 0.035 * clamp(length(uWind), 0.0, 1.0);
          `,
          );
      }
    };
    material.customProgramCacheKey = () => `ground-cover-${kind}-v1`;
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;

    const bladeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const healthAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const phaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    bladeAttr.setUsage(THREE.DynamicDrawUsage);
    healthAttr.setUsage(THREE.DynamicDrawUsage);
    phaseAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBlade', bladeAttr);
    geo.setAttribute('aHealth', healthAttr);
    geo.setAttribute('aPhase', phaseAttr);
    return mesh;
  }

  /** Resample ground cover around the camera. Cheap enough to do every few seconds. */
  update(cameraPos: THREE.Vector3, dtSeconds: number, season: number, snow: number): void {
    for (const u of this.uniforms) {
      if (u.value instanceof THREE.Vector2) continue;
      if (typeof u.value === 'number') u.value += dtSeconds;
    }
    const now = performance.now();
    const moved = this.lastCenter.distanceTo(new THREE.Vector2(cameraPos.x, cameraPos.z)) > 6;
    if (!moved && now - this.lastRefresh < 2000) return;
    this.lastCenter.set(cameraPos.x, cameraPos.z);
    this.lastRefresh = now;
    this.resample(cameraPos);
    this.updateUniforms(this.world.climate.windDirection, this.world.climate.windSpeed, season, snow);
  }

  private resample(cameraPos: THREE.Vector3): void {
    const world = this.world;
    const t = world.terrain;
    const layers = world.vegetation.plants.layers;
    const canopyField = t.canopy;
    const snowField = t.snow;
    const grassField = layers[PLANT_INDEX.grass];
    const shrubField = layers[PLANT_INDEX.shrub];
    const reedField = layers[PLANT_INDEX.reed];
    const xericField = layers[PLANT_INDEX.xeric];
    const mossField = layers[PLANT_INDEX.moss];

    const cx0 = Math.round(t.worldToCellX(cameraPos.x));
    const cy0 = Math.round(t.worldToCellY(cameraPos.z));
    // Radii in cells. Grass hugs the camera; shrubs and reeds reach further out.
    const grassR = 26;
    const shrubR = 34;
    const reedR = 30;

    let grassN = 0;
    let shrubN = 0;
    let reedN = 0;
    const rng = world.rng;
    const dummy = new THREE.Object3D();
    const grassHealth = this.grassGeo.getAttribute('aHealth') as THREE.InstancedBufferAttribute;
    const grassPhase = this.grassGeo.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    const shrubHealth = this.shrubGeo.getAttribute('aHealth') as THREE.InstancedBufferAttribute;
    const shrubPhase = this.shrubGeo.getAttribute('aPhase') as THREE.InstancedBufferAttribute;
    const reedBlade = this.reedGeo.getAttribute('aBlade') as THREE.InstancedBufferAttribute;
    const reedHealth = this.reedGeo.getAttribute('aHealth') as THREE.InstancedBufferAttribute;
    const reedPhase = this.reedGeo.getAttribute('aPhase') as THREE.InstancedBufferAttribute;

    for (let ring = 0; ring <= grassR; ring++) {
      const samples = ring === 0 ? 1 : ring * 8;
      for (let s = 0; s < samples; s++) {
        const ang = (s / samples) * TAU + ring * 0.7;
        const rad = ring;
        const cx = Math.round(cx0 + Math.cos(ang) * rad);
        const cy = Math.round(cy0 + Math.sin(ang) * rad);
        if (cx < 1 || cy < 1 || cx >= t.size - 1 || cy >= t.size - 1) continue;
        const i = cy * t.size + cx;
        if (!t.land[i]) continue;
        const canopy = canopyField.data[i];
        const snow = snowField.data[i];
        const biome = t.biome.data[i] as Biome;
        const def = BIOMES[biome];
        const jitterX = rng.next();
        const jitterY = rng.next();
        const wx = t.cellToWorldX(cx) + (jitterX - 0.5) * t.cellUnits;
        const wz = t.cellToWorldY(cy) + (jitterY - 0.5) * t.cellUnits;
        const wy = t.elevationOf(t.height.data[i]);
        const underCanopy = 1 - clamp01(canopy * 1.4);

        const grassDensity = clamp01(grassField.data[i]) * underCanopy * clamp01(1 - snow * 0.9);
        const tufts = Math.min(3, Math.round(grassDensity * 2.6));
        const viewDist = Math.hypot(cx - cx0, cy - cy0);
        for (let k = 0; k < tufts && grassN < this.grassCap; k++) {
          if (viewDist > grassR - 4 && rng.next() < 0.5) continue;
          dummy.position.set(wx + (rng.next() - 0.5) * t.cellUnits * 0.8, wy - 0.03, wz + (rng.next() - 0.5) * t.cellUnits * 0.8);
          const scale = (0.55 + rng.next() * 0.8) * (0.7 + grassDensity * 0.6);
          dummy.scale.set(scale, scale * (0.8 + rng.next() * 0.6), scale);
          dummy.rotation.y = rng.next() * TAU;
          dummy.updateMatrix();
          this.grass.setMatrixAt(grassN, dummy.matrix);
          grassHealth.setX(grassN, clamp01(0.35 + grassDensity + t.soilMoisture.data[i] * 0.3));
          grassPhase.setX(grassN, rng.next());
          grassN++;
        }

        // Shrubs prefer moister, more fertile ground and open sites.
        const shrubDensity = clamp01(shrubField.data[i]) * clamp01(1 - canopy * 0.9) * clamp01(1 - snow);
        if (shrubDensity > 0.22 && rng.next() < shrubDensity * 0.9 && shrubN < this.shrubCap) {
          dummy.position.set(wx, wy - 0.05, wz);
          const scale = (0.7 + rng.next() * 0.9) * clamp01(0.5 + (def.plants[1] ?? 1));
          dummy.scale.set(scale, scale * (0.8 + rng.next() * 0.5), scale);
          dummy.rotation.y = rng.next() * TAU;
          dummy.updateMatrix();
          this.shrub.setMatrixAt(shrubN, dummy.matrix);
          shrubHealth.setX(shrubN, clamp01(shrubDensity + 0.2));
          shrubPhase.setX(shrubN, rng.next());
          shrubN++;
        }

        // Reeds stand in shallow water and wet ground; moss and xeric plants
        // are part of the ground colour rather than geometry.
        const wet = t.waterDepth.data[i];
        const reedDensity = clamp01(reedField.data[i]) * (wet > 0.02 && wet < 0.7 ? 1 : 0.25);
        if (reedDensity > 0.2 && rng.next() < reedDensity * 0.8 && reedN < this.reedCap) {
          dummy.position.set(wx, Math.max(wy, wy + Math.min(wet, 0.6)) - 0.1, wz);
          const scale = (0.7 + rng.next() * 0.7) * (0.8 + reedDensity * 0.5);
          dummy.scale.set(scale, scale * (0.9 + rng.next() * 0.7), scale);
          dummy.rotation.y = rng.next() * TAU;
          dummy.updateMatrix();
          this.reed.setMatrixAt(reedN, dummy.matrix);
          reedHealth.setX(reedN, clamp01(reedDensity + 0.2));
          reedPhase.setX(reedN, rng.next());
          reedN++;
        }
        void mossField;
        void xericField;
      }
      if (grassN >= this.grassCap && shrubN >= this.shrubCap && reedN >= this.reedCap) break;
    }

    this.grassCount = grassN;
    this.shrubCount = shrubN;
    this.reedCount = reedN;
    this.grass.count = grassN;
    this.shrub.count = shrubN;
    this.reed.count = reedN;
    this.grass.instanceMatrix.needsUpdate = true;
    this.shrub.instanceMatrix.needsUpdate = true;
    this.reed.instanceMatrix.needsUpdate = true;
    grassHealth.needsUpdate = true;
    grassPhase.needsUpdate = true;
    shrubHealth.needsUpdate = true;
    shrubPhase.needsUpdate = true;
    reedHealth.needsUpdate = true;
    reedPhase.needsUpdate = true;
  }

  updateUniforms(windDir: number, windSpeed: number, season: number, snow: number): void {
    void season;
    void snow;
    // uniform layout: [time, wind, season, snow] per mesh, then health uniform
    for (let i = 0; i < this.uniforms.length; i += 4) {
      (this.uniforms[i + 1].value as THREE.Vector2).set(Math.cos(windDir) * windSpeed, Math.sin(windDir) * windSpeed);
    }
  }

  get counts(): { grass: number; shrub: number; reed: number } {
    return { grass: this.grassCount, shrub: this.shrubCount, reed: this.reedCount };
  }

  dispose(): void {
    for (const m of [this.grass, this.shrub, this.reed]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
