import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp01, TAU } from '../core/math';
import { PLANT_INDEX } from '../world/biomes';
import type { World } from '../world/world';

/**
 * Visible flora beyond grass, shrubs and reeds. Each kind is driven by a
 * simulation field, so a meadow blooms where the ecosystem puts its grass, a
 * desert scrubs over where the xeric layer is, and mushrooms come up where
 * shade and moisture meet. Nothing here is scripted scenery.
 *
 * Placement is deterministic from the cell index and a per-slot salt, not from
 * the world RNG: drawing from the simulation's RNG while rendering would make
 * the simulation depend on how often the camera moved.
 */

const RADIUS = 24; // cells around the camera that are sampled
const CAPS = { flower: 2600, scrub: 480, mushroom: 900 };

function hash(i: number, salt: number): number {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // Merging needs identical attributes on every part: no uvs, and every part
  // non-indexed (polyhedra are non-indexed, cylinders and spheres are not).
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}

/** A blossom: a thin stem with a small head. Head and stem share one tint. */
function flowerGeometry(): THREE.BufferGeometry {
  const stem = strip(new THREE.CylinderGeometry(0.008, 0.01, 0.34, 4, 1)).translate(0, 0.17, 0);
  const head = strip(new THREE.IcosahedronGeometry(0.065, 0)).translate(0, 0.36, 0);
  const petal = strip(new THREE.IcosahedronGeometry(0.04, 0)).translate(0.05, 0.3, 0.02);
  return mergeGeometries([stem, head, petal]);
}

/** Low desert scrub: a cluster of squashed domes, base at y = 0. */
function scrubGeometry(): THREE.BufferGeometry {
  const parts = [
    strip(new THREE.IcosahedronGeometry(0.34, 1)).scale(1, 0.6, 1).translate(0, 0.2, 0),
    strip(new THREE.IcosahedronGeometry(0.2, 1)).scale(1, 0.7, 1).translate(0.3, 0.13, 0.12),
    strip(new THREE.IcosahedronGeometry(0.18, 1)).scale(1, 0.7, 1).translate(-0.24, 0.11, -0.18),
  ];
  return mergeGeometries(parts);
}

/** A fruiting body: stalk and domed cap. */
function mushroomGeometry(): THREE.BufferGeometry {
  const stalk = strip(new THREE.CylinderGeometry(0.018, 0.024, 0.1, 6, 1)).translate(0, 0.05, 0);
  const cap = strip(new THREE.SphereGeometry(0.09, 8, 4, 0, TAU, 0, Math.PI / 2)).scale(1, 0.55, 1).translate(0, 0.1, 0);
  return mergeGeometries([stalk, cap]);
}

const MEADOW = [0xf2efe4, 0xe8c547, 0x9c7fc4, 0xe07a9a, 0xd9643a];
const SCRUB = [0x7d8a58, 0x6e7c4e, 0x94904f, 0x5f6b45];
const CAP = [0xefe6d2, 0xc9a77a, 0x8a5a3a, 0xb94a3a];

export class Flora {
  readonly group = new THREE.Group();
  private flowers: THREE.InstancedMesh;
  private scrub: THREE.InstancedMesh;
  private mushrooms: THREE.InstancedMesh;
  private colour = new THREE.Color();

  constructor() {
    const mat = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.flowers = new THREE.InstancedMesh(flowerGeometry(), mat(), CAPS.flower);
    this.scrub = new THREE.InstancedMesh(scrubGeometry(), mat(), CAPS.scrub);
    this.mushrooms = new THREE.InstancedMesh(mushroomGeometry(), mat(), CAPS.mushroom);
    for (const m of [this.flowers, this.scrub, this.mushrooms]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
  }

  /** Re-place flora around the camera from the current simulation fields. */
  resample(world: World, cameraPos: THREE.Vector3): void {
    const t = world.terrain;
    const layers = world.vegetation.plants.layers;
    const grass = layers[PLANT_INDEX.grass];
    const xeric = layers[PLANT_INDEX.xeric];
    const cx0 = Math.round(t.worldToCellX(cameraPos.x));
    const cy0 = Math.round(t.worldToCellY(cameraPos.z));
    const dummy = new THREE.Object3D();
    let nF = 0;
    let nS = 0;
    let nM = 0;

    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        if (cx < 1 || cy < 1 || cx >= t.size - 1 || cy >= t.size - 1) continue;
        const i = cy * t.size + cx;
        if (!t.land[i]) continue;
        const canopy = t.canopy.data[i];
        const snow = t.snow.data[i];
        if (snow > 0.5) continue;
        const wy = t.elevationOf(t.height.data[i]);
        const wx = t.cellToWorldX(cx);
        const wz = t.cellToWorldY(cy);
        const jx = (hash(i, 1) - 0.5) * t.cellUnits;
        const jz = (hash(i, 2) - 0.5) * t.cellUnits;
        const moisture = t.soilMoisture.data[i];

        // Meadow flowers: open grassland with a healthy grass layer.
        const open = clamp01(1 - canopy * 1.6) * (1 - snow);
        const meadow = clamp01(grass.data[i]) * open;
        if (meadow > 0.4 && hash(i, 3) < meadow * 0.42 && nF < CAPS.flower) {
          const n = 1 + Math.floor(hash(i, 4) * 3);
          for (let k = 0; k < n && nF < CAPS.flower; k++) {
            dummy.position.set(wx + jx + (hash(i, 10 + k) - 0.5) * 0.9, wy - 0.02, wz + jz + (hash(i, 20 + k) - 0.5) * 0.9);
            const s = 0.7 + hash(i, 30 + k) * 0.7;
            dummy.scale.set(s, s * (0.8 + hash(i, 40 + k) * 0.5), s);
            dummy.rotation.set(0, hash(i, 50 + k) * TAU, 0);
            dummy.updateMatrix();
            this.flowers.setMatrixAt(nF, dummy.matrix);
            this.flowers.setColorAt(nF, this.colour.setHex(MEADOW[Math.floor(hash(i, 60 + k) * MEADOW.length)]));
            nF++;
          }
        }

        // Desert scrub where the xeric layer is dense and the ground is open.
        // The xeric layer peaks well below 1 in practice, so it is rescaled to
        // its working range before thresholding.
        const xr = clamp01(xeric.data[i] * 3.5) * open * clamp01(1 - moisture);
        if (xr > 0.2 && hash(i, 5) < xr * 0.5 && nS < CAPS.scrub) {
          dummy.position.set(wx + jx, wy - 0.04, wz + jz);
          const s = (0.7 + hash(i, 6) * 0.8) * (0.6 + xr * 0.5);
          dummy.scale.set(s, s * (0.8 + hash(i, 7) * 0.5), s);
          dummy.rotation.set(0, hash(i, 8) * TAU, 0);
          dummy.updateMatrix();
          this.scrub.setMatrixAt(nS, dummy.matrix);
          this.scrub.setColorAt(nS, this.colour.setHex(SCRUB[Math.floor(hash(i, 9) * SCRUB.length)]));
          nS++;
        }

        // Mushrooms on the shaded, damp forest floor.
        const shade = clamp01((canopy - 0.3) * 2);
        const damp = clamp01((moisture - 0.35) * 2);
        const fungi = shade * damp;
        if (fungi > 0.15 && hash(i, 11) < fungi * 0.22 && nM < CAPS.mushroom) {
          const n = 1 + Math.floor(hash(i, 12) * 2);
          for (let k = 0; k < n && nM < CAPS.mushroom; k++) {
            dummy.position.set(wx + jx + (hash(i, 70 + k) - 0.5) * 0.6, wy - 0.02, wz + jz + (hash(i, 80 + k) - 0.5) * 0.6);
            const s = 0.6 + hash(i, 90 + k) * 0.9;
            dummy.scale.set(s, s, s);
            dummy.rotation.set(0, hash(i, 100 + k) * TAU, 0);
            dummy.updateMatrix();
            this.mushrooms.setMatrixAt(nM, dummy.matrix);
            this.mushrooms.setColorAt(nM, this.colour.setHex(CAP[Math.floor(hash(i, 110 + k) * CAP.length)]));
            nM++;
          }
        }
      }
    }

    for (const [m, n] of [
      [this.flowers, nF],
      [this.scrub, nS],
      [this.mushrooms, nM],
    ] as const) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  get counts(): { flowers: number; scrub: number; mushrooms: number } {
    return { flowers: this.flowers.count, scrub: this.scrub.count, mushrooms: this.mushrooms.count };
  }

  dispose(): void {
    for (const m of [this.flowers, this.scrub, this.mushrooms]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
