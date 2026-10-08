import * as THREE from 'three';
import { clamp, clamp01, lerp, TAU } from '../core/math';
import type { Creatures } from '../life/organism';
import { SPECIES, type Morphology } from '../life/species';
import { SkinnedAnimals } from './skinnedAnimals';
import { buildRiggedAnimal } from './proceduralRig';
import { RENDER } from '../core/config';
import type { World } from '../world/world';

/** Body parts the vertex shader animates. */
const PART = {
  body: 0,
  legFL: 1,
  legFR: 2,
  legRL: 3,
  legRR: 4,
  head: 5,
  tail: 6,
  wingL: 7,
  wingR: 8,
  fin: 9,
  earL: 10,
  earR: 11,
}

interface Piece {
  geo: THREE.BufferGeometry;
  part: number;
  pivot: THREE.Vector3;
  color: [number, number, number];
}

function paint(geo: THREE.BufferGeometry, color: [number, number, number], variance = 0.06, seed = 1): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // A little per-vertex variation keeps flat colours from looking plastic.
    const v = 1 + (Math.sin(i * 12.9898 + seed * 78.233) % 1) * variance * 2 - variance;
    colors[i * 3] = clamp01(color[0] * v);
    colors[i * 3 + 1] = clamp01(color[1] * v);
    colors[i * 3 + 2] = clamp01(color[2] * v);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function tag(geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const parts = new Float32Array(pos.count).fill(part);
  const pivots = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    pivots[i * 3] = pivot.x;
    pivots[i * 3 + 1] = pivot.y;
    pivots[i * 3 + 2] = pivot.z;
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  geo.setAttribute('aPivot', new THREE.BufferAttribute(pivots, 3));
  return geo;
}

function mergePieces(pieces: Piece[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const p of pieces) {
    const n = (p.geo.getAttribute('position') as THREE.BufferAttribute).count;
    vCount += n;
    iCount += p.geo.index ? p.geo.index.count : n;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const part = new Float32Array(vCount);
  const piv = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of pieces) {
    const g = p.geo;
    const pp = g.getAttribute('position') as THREE.BufferAttribute;
    const pn = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const pc = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const pa = g.getAttribute('aPart') as THREE.BufferAttribute | undefined;
    const pv = g.getAttribute('aPivot') as THREE.BufferAttribute | undefined;
    pos.set(pp.array as Float32Array, vo * 3);
    if (pn) nor.set(pn.array as Float32Array, vo * 3);
    // A piece may arrive unpainted/untagged (raw merged primitives); fall back
    // to its own colour and pivot so nothing has to know how it was built.
    if (pc) col.set(pc.array as Float32Array, vo * 3);
    else for (let i = 0; i < pp.count; i++) {
      col[(vo + i) * 3] = p.color[0];
      col[(vo + i) * 3 + 1] = p.color[1];
      col[(vo + i) * 3 + 2] = p.color[2];
    }
    if (pa) part.set(pa.array as Float32Array, vo);
    else part.fill(p.part, vo, vo + pp.count);
    if (pv) piv.set(pv.array as Float32Array, vo * 3);
    else for (let i = 0; i < pp.count; i++) {
      piv[(vo + i) * 3] = p.pivot.x;
      piv[(vo + i) * 3 + 1] = p.pivot.y;
      piv[(vo + i) * 3 + 2] = p.pivot.z;
    }
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
  out.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  out.setAttribute('aPivot', new THREE.BufferAttribute(piv, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Simple capsule-ish body: a stretched low-poly sphere with a rounded back. */
function bodyGeo(rx: number, ry: number, rz: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.max(4, seg / 2));
  g.scale(rx, ry, rz);
  return g;
}

function legGeo(from: THREE.Vector3, to: THREE.Vector3, thickness: number, segments = 2, radial = 5): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(thickness * 0.75, thickness * 0.5, 1, radial, segments);
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  g.translate(0, 0.5, 0);
  g.scale(1, len, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate(from.x, from.y, from.z);
  // A hoof/foot pad.
  const foot = new THREE.SphereGeometry(thickness * 0.75, radial, Math.max(3, Math.round(radial * 0.6)));
  foot.scale(1, 0.6, 1.1);
  foot.translate(to.x, to.y - thickness * 0.3, to.z);
  return mergeRaw([g, foot]);
}

/** Merge sub-geometries that may not yet carry colour/part attributes. */
function mergeRaw(geos: THREE.BufferGeometry[], color: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  const pivot = new THREE.Vector3();
  const pieces: Piece[] = geos.map((g) => {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('color')) paint(g, color, 0.05, 71);
    if (!g.getAttribute('aPart')) tag(g, PART.body, pivot);
    return { geo: g, part: PART.body, pivot, color };
  });
  return mergePieces(pieces);
}

/** Quadruped: body, neck, head, ears, four legs, tail, optional headgear. */
/**
 * Per-species features on top of the shared quadruped template. Each entry
 * adds geometry that no other species has, so no two quadrupeds share the same
 * silhouette details.
 */
function addQuadrupedSignature(
  key: string,
  pieces: Piece[],
  m: Morphology,
  headPos: THREE.Vector3,
  neckPivot: THREE.Vector3,
  bodyY: number,
): void {
  const hs = m.headSize;
  const bl = m.bodyLength;
  const girth = m.bodyGirth;
  const add = (geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3, color: [number, number, number]) =>
    pieces.push({ geo: tag(geo, part, pivot), part, pivot: pivot.clone(), color });
  const headPivot = neckPivot;
  switch (key) {
    case 'rabbit': {
      // Long upright ears, pale inside.
      for (const side of [-1, 1]) {
        const ear = paint(bodyGeo(hs * 0.22, hs * 1.15, hs * 0.1, 12), m.fur, 0.05, 61);
        ear.translate(headPos.x - hs * 0.15, headPos.y + hs * 1.0, side * hs * 0.3);
        add(ear, PART.head, headPivot, m.fur);
      }
      break;
    }
    case 'bison': {
      // Shoulder hump and a beard under the chin.
      const hump = paint(bodyGeo(bl * 0.22, girth * 0.55, girth * 0.85, 16), m.fur, 0.06, 63);
      hump.translate(bl * 0.22, bodyY + girth * 0.62, 0);
      add(hump, PART.body, new THREE.Vector3(bl * 0.22, bodyY + girth * 0.62, 0), m.fur);
      const beard = paint(bodyGeo(hs * 0.3, hs * 0.55, hs * 0.22, 10), m.accent, 0.05, 65);
      beard.translate(headPos.x + hs * 0.35, headPos.y - hs * 0.55, 0);
      add(beard, PART.head, headPivot, m.accent);
      break;
    }
    case 'goat': {
      // Chin beard.
      const beard = paint(bodyGeo(hs * 0.14, hs * 0.5, hs * 0.14, 8), m.accent, 0.05, 67);
      beard.translate(headPos.x + hs * 0.55, headPos.y - hs * 0.6, 0);
      add(beard, PART.head, headPivot, m.accent);
      break;
    }
    case 'lynx': {
      // Ear tufts and cheek ruff.
      for (const side of [-1, 1]) {
        const tuft = paint(new THREE.ConeGeometry(hs * 0.12, hs * 0.45, 8, 1), m.accent, 0.04, 69);
        tuft.translate(headPos.x - hs * 0.1, headPos.y + hs * 1.05, side * hs * 0.42);
        add(tuft, PART.head, headPivot, m.accent);
        const ruff = paint(bodyGeo(hs * 0.3, hs * 0.45, hs * 0.2, 10), m.accent, 0.05, 71);
        ruff.translate(headPos.x - hs * 0.1, headPos.y - hs * 0.15, side * hs * 0.55);
        add(ruff, PART.head, headPivot, m.accent);
      }
      break;
    }
    case 'wolf': {
      // Thick neck ruff.
      const ruff = paint(bodyGeo(hs * 0.7, hs * 0.75, hs * 0.75, 14), m.accent, 0.06, 73);
      ruff.translate(neckPivot.x + (headPos.x - neckPivot.x) * 0.55, neckPivot.y + (headPos.y - neckPivot.y) * 0.55, 0);
      add(ruff, PART.head, headPivot, m.accent);
      break;
    }
    case 'deer': {
      // Pale rump patch.
      const rump = paint(bodyGeo(bl * 0.12, girth * 0.5, girth * 0.7, 12), [0.93, 0.91, 0.85], 0.03, 75);
      rump.translate(-bl * 0.45, bodyY + girth * 0.15, 0);
      add(rump, PART.body, new THREE.Vector3(-bl * 0.45, bodyY, 0), [0.93, 0.91, 0.85]);
      break;
    }
    default:
      break;
  }
}

/**
 * Deer, built by hand: a slender barrel body, a long neck carrying a narrow
 * head, large ears, a branched antler pair, long slender legs with fine feet,
 * a pale rump patch and a short tail.
 */
export function buildDeer(m: Morphology, detail: boolean): THREE.BufferGeometry {
  const L = m.bodyLength;
  const G = m.bodyGirth;
  const S = m.standHeight;
  const H = m.headSize;
  const pieces: Piece[] = [];
  const add = (geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3, color: [number, number, number]) => {
    pieces.push({ geo: tag(geo, part, pivot), part, pivot: pivot.clone(), color });
  };
  const seg = detail ? 18 : 6;
  // Legs take a darker shade of the coat, so they do not read as bare sticks.
  const legCol: [number, number, number] = [m.fur[0] * 0.78, m.fur[1] * 0.78, m.fur[2] * 0.78];
  const origin = new THREE.Vector3();
  const sph = (rx: number, ry: number, rz: number, x: number, y: number, z: number, color: [number, number, number], seed: number, part = PART.body, pivot = origin) => {
    const g = paint(bodyGeo(rx, ry, rz, seg), color, 0.05, seed);
    g.translate(x, y, z);
    add(g, part, pivot, color);
  };

  // Barrel body, slightly deeper at the chest.
  sph(L * 0.42, G * 0.5, G * 0.52, 0, S, 0, m.fur, 3);
  sph(L * 0.22, G * 0.46, G * 0.5, L * 0.22, S - G * 0.02, 0, m.fur, 5);
  sph(L * 0.3, G * 0.28, G * 0.36, L * 0.02, S - G * 0.3, 0, m.belly, 7);
  // Pale rump patch.
  sph(L * 0.12, G * 0.36, G * 0.5, -L * 0.42, S + G * 0.02, 0, [0.93, 0.91, 0.85], 9);

  // Long neck and narrow head.
  const neckPivot = new THREE.Vector3(L * 0.36, S + G * 0.2, 0);
  const headC = new THREE.Vector3(L * 0.66, S + G * 0.85, 0);
  add(tube(neckPivot, headC, G * 0.36, H * 0.48, detail ? 14 : 6), PART.head, neckPivot, m.fur);
  sph(H * 0.85, H * 0.5, H * 0.5, headC.x, headC.y, 0, m.fur, 13, PART.head, neckPivot);
  sph(H * 0.9, H * 0.42, H * 0.4, headC.x + H * 0.55, headC.y - H * 0.18, 0, m.fur, 15, PART.head, neckPivot);
  sph(H * 0.32, H * 0.28, H * 0.3, headC.x + H * 1.1, headC.y - H * 0.25, 0, m.accent, 17, PART.head, neckPivot);
  if (detail) {
    for (const side of [-1, 1]) {
      sph(H * 0.12, H * 0.12, H * 0.12, headC.x + H * 0.2, headC.y + H * 0.22, side * H * 0.42, m.eye, 19, PART.head, neckPivot);
    }
  }

  // Large ears that flare sideways from the back of the head.
  for (const side of [-1, 1]) {
    const part = side < 0 ? PART.earL : PART.earR;
    const base = new THREE.Vector3(headC.x - H * 0.25, headC.y + H * 0.15, side * H * 0.35);
    const ear = paint(bodyGeo(H * 0.14, H * 0.55, H * 0.45, detail ? 10 : 5), m.fur, 0.05, 21 + side);
    ear.rotateZ(side * 0.5);
    ear.translate(base.x, base.y + H * 0.1, base.z + side * H * 0.35);
    add(ear, part, base, m.fur);
  }

  // Antlers: a beam with two tines on each side.
  if (detail) {
    for (const side of [-1, 1]) {
      const root = new THREE.Vector3(headC.x - H * 0.2, headC.y + H * 0.45, side * H * 0.22);
      const tip = new THREE.Vector3(root.x - H * 0.3, root.y + H * 2.0, side * H * 0.5);
      add(tube(root, tip, H * 0.12, H * 0.07, 6), PART.head, neckPivot, m.accent);
      for (const t of [0.45, 0.7]) {
        const at = new THREE.Vector3().lerpVectors(root, tip, t);
        const tine = new THREE.Vector3(at.x + H * 0.55, at.y + H * 0.45, at.z + side * H * 0.12);
        add(tube(at, tine, H * 0.06, H * 0.03, 5), PART.head, neckPivot, m.accent);
      }
    }
  }

  // Legs: long and slender, from shoulder and hip to small hooves.
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(L * 0.32, S - G * 0.3, side * G * 0.36);
    const hoof = new THREE.Vector3(L * 0.34, 0.02, side * G * 0.36);
    add(paint(mergeRaw([legGeo(shoulder.clone(), hoof.clone(), G * 0.1, 3, detail ? 10 : 5)]), legCol, 0.05, 45 + side), side < 0 ? PART.legFL : PART.legFR, shoulder, legCol);
    const hip = new THREE.Vector3(-L * 0.3, S - G * 0.3, side * G * 0.36);
    const hindHoof = new THREE.Vector3(-L * 0.32, 0.02, side * G * 0.36);
    add(paint(mergeRaw([legGeo(hip.clone(), hindHoof.clone(), G * 0.1, 3, detail ? 10 : 5)]), legCol, 0.05, 47 + side), side < 0 ? PART.legRL : PART.legRR, hip, legCol);
  }

  // Short tail.
  const tailPivot = new THREE.Vector3(-L * 0.5, S + G * 0.3, 0);
  sph(G * 0.12, G * 0.14, G * 0.12, -L * 0.52, S + G * 0.24, 0, m.belly, 41, PART.tail, tailPivot);

  const merged = mergePieces(pieces);
  applyPattern(merged, m);
  return merged;
}

/**
 * Rabbit, built by hand rather than from the shared quadruped template: a
 * haunched rump, a short neck, a muzzle with a pink nose, long ears with pale
 * insides, folded forelegs, long hind feet and a white scut.
 */
export function buildRabbit(m: Morphology, detail: boolean): THREE.BufferGeometry {
  const L = m.bodyLength;
  const G = m.bodyGirth;
  const S = m.standHeight;
  const H = m.headSize;
  const pieces: Piece[] = [];
  const add = (geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3, color: [number, number, number]) => {
    pieces.push({ geo: tag(geo, part, pivot), part, pivot: pivot.clone(), color });
  };
  const seg = detail ? 18 : 6;
  // Legs take a darker shade of the coat, so they do not read as bare sticks.
  const legCol: [number, number, number] = [m.fur[0] * 0.78, m.fur[1] * 0.78, m.fur[2] * 0.78];
  const origin = new THREE.Vector3();
  const sph = (rx: number, ry: number, rz: number, x: number, y: number, z: number, color: [number, number, number], seed: number, part = PART.body, pivot = origin) => {
    const g = paint(bodyGeo(rx, ry, rz, seg), color, 0.06, seed);
    g.translate(x, y, z);
    add(g, part, pivot, color);
  };

  // Torso: a rounded body with the haunch at the rear.
  sph(L * 0.38, G * 0.6, G * 0.64, 0, S, 0, m.fur, 3);
  sph(L * 0.26, G * 0.7, G * 0.74, -L * 0.18, S + G * 0.04, 0, m.fur, 5);
  sph(L * 0.22, G * 0.52, G * 0.55, L * 0.22, S - G * 0.03, 0, m.fur, 7);
  sph(L * 0.3, G * 0.3, G * 0.4, L * 0.02, S - G * 0.34, 0, m.belly, 9);

  // Neck and head.
  const neckPivot = new THREE.Vector3(L * 0.34, S + G * 0.15, 0);
  const headC = new THREE.Vector3(L * 0.5 + H * 0.2, S + G * 0.3 + H * 0.15, 0);
  add(tube(neckPivot, headC, G * 0.42, H * 0.6, detail ? 14 : 6), PART.head, neckPivot, m.fur);
  sph(H * 0.9, H * 0.78, H * 0.72, headC.x, headC.y, 0, m.fur, 13, PART.head, neckPivot);
  sph(H * 0.5, H * 0.42, H * 0.5, headC.x + H * 0.08, headC.y - H * 0.25, 0, m.fur, 15, PART.head, neckPivot);

  // Muzzle and nose.
  sph(H * 0.42, H * 0.34, H * 0.36, headC.x + H * 0.7, headC.y - H * 0.18, 0, m.accent, 17, PART.head, neckPivot);
  sph(H * 0.13, H * 0.11, H * 0.13, headC.x + H * 1.1, headC.y - H * 0.1, 0, [0.86, 0.55, 0.55], 19, PART.head, neckPivot);

  // Eyes.
  if (detail) {
    for (const side of [-1, 1]) {
      sph(H * 0.17, H * 0.17, H * 0.17, headC.x + H * 0.46, headC.y + H * 0.14, side * H * 0.6, m.eye, 21, PART.head, neckPivot);
    }
  }

  // Long ears, pale inside. Each ear pivots at the top of the head.
  for (const side of [-1, 1]) {
    const part = side < 0 ? PART.earL : PART.earR;
    const base = new THREE.Vector3(headC.x - H * 0.2, headC.y + H * 0.6, side * H * 0.32);
    const ear = paint(bodyGeo(H * 0.2, H * 1.15, H * 0.1, detail ? 12 : 5), m.fur, 0.05, 23 + side);
    ear.rotateZ(-0.18);
    ear.translate(base.x, base.y + H * 1.0, base.z);
    add(ear, part, base, m.fur);
    const inner = paint(bodyGeo(H * 0.09, H * 0.95, H * 0.03, detail ? 10 : 4), m.accent, 0.04, 29 + side);
    inner.rotateZ(-0.18);
    inner.translate(base.x + H * 0.02, base.y + H * 0.95, base.z + side * H * 0.07);
    add(inner, part, base, m.accent);
  }

  // Front legs, folded under the chest.
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(L * 0.3, S - G * 0.4, side * G * 0.4);
    const paw = new THREE.Vector3(L * 0.34, 0.03, side * G * 0.4);
    const part = side < 0 ? PART.legFL : PART.legFR;
    add(paint(mergeRaw([legGeo(shoulder.clone(), paw.clone(), G * 0.13, 2, detail ? 10 : 5)]), legCol, 0.05, 45 + part), part, shoulder, legCol);
  }

  // Hind legs: a big thigh at the hip and a long hind foot.
  for (const side of [-1, 1]) {
    const hip = new THREE.Vector3(-L * 0.22, S - G * 0.1, side * G * 0.5);
    const part = side < 0 ? PART.legRL : PART.legRR;
    const thigh = paint(bodyGeo(G * 0.42, G * 0.46, G * 0.36, detail ? 14 : 5), m.fur, 0.05, 31 + side);
    thigh.translate(hip.x, hip.y, hip.z);
    add(thigh, part, hip, m.fur);
    const shin = paint(legGeo(hip.clone(), new THREE.Vector3(-L * 0.12, 0.05, side * G * 0.5), G * 0.14, 2, detail ? 10 : 5), legCol, 0.05, 37 + side);
    add(shin, part, hip, m.accent);
    const foot = paint(bodyGeo(L * 0.2, G * 0.1, G * 0.2, detail ? 12 : 5), legCol, 0.04, 41 + side);
    foot.translate(-L * 0.08, 0.05, side * G * 0.5);
    add(foot, part, hip, m.accent);
  }

  // Scut.
  const tailPivot = new THREE.Vector3(-L * 0.5, S, 0);
  sph(G * 0.3, G * 0.3, G * 0.3, -L * 0.52, S + G * 0.05, 0, m.belly, 43, PART.tail, tailPivot);

  const merged = mergePieces(pieces);
  applyPattern(merged, m);
  return merged;
}

export function buildQuadruped(m: Morphology, detail: boolean, key?: string): THREE.BufferGeometry {
  if (key === 'rabbit') return buildRabbit(m, detail);
  if (key === 'deer') return buildDeer(m, detail);
  const pieces: Piece[] = [];
  const stand = m.standHeight;
  const bl = m.bodyLength;
  const girth = m.bodyGirth;
  const bodyY = stand;

  const body = paint(bodyGeo(bl * 0.5, girth * 0.75, girth, detail ? 26 : 6), m.fur, 0.08, 3);
  body.translate(0, bodyY, 0);
  pieces.push({ geo: tag(body, PART.body, new THREE.Vector3(0, bodyY, 0)), part: PART.body, pivot: new THREE.Vector3(0, bodyY, 0), color: m.fur });

  // Chest and belly shading.
  const belly = paint(bodyGeo(bl * 0.42, girth * 0.55, girth * 0.9, detail ? 16 : 6), m.belly, 0.05, 7);
  belly.translate(bl * 0.06, bodyY - girth * 0.28, 0);
  pieces.push({ geo: tag(belly, PART.body, new THREE.Vector3()), part: PART.body, pivot: new THREE.Vector3(), color: m.belly });

  // Neck + head pivot at the shoulders.
  const neckPivot = new THREE.Vector3(bl * 0.42, bodyY + girth * 0.35, 0);
  const neckLen = m.neck + m.headSize * 0.5;
  const neck = paint(new THREE.CylinderGeometry(m.headSize * 0.32, girth * 0.5, 1, detail ? 18 : 5, detail ? 6 : 1), m.fur, 0.06, 11);
  // Orient the neck about its own centre first, then move it so its base sits
  // on the shoulder pivot and its far end reaches the head. Translating before
  // rotating swings the neck around the world origin and detaches the head.
  neck.scale(1, neckLen, 1);
  const neckDir = new THREE.Vector3(1, 0.45, 0).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), neckDir);
  neck.applyQuaternion(q);
  neck.translate(neckPivot.x + neckDir.x * neckLen * 0.5, neckPivot.y + neckDir.y * neckLen * 0.5, 0);
  pieces.push({ geo: tag(neck, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.fur });

  const headPos = new THREE.Vector3(neckPivot.x + neckDir.x * neckLen, neckPivot.y + neckDir.y * neckLen, 0);
  const head = paint(bodyGeo(m.headSize * 0.85, m.headSize * 0.7, m.headSize * 0.7, detail ? 22 : 5), m.fur, 0.06, 13);
  head.translate(headPos.x, headPos.y, 0);
  pieces.push({ geo: tag(head, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.fur });

  // Muzzle.
  const muzzle = paint(new THREE.CylinderGeometry(m.headSize * 0.3, m.headSize * 0.42, m.headSize * 0.8, detail ? 16 : 6, detail ? 4 : 1), m.accent, 0.05, 17);
  const mq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, -0.15, 0).normalize());
  muzzle.applyQuaternion(mq);
  muzzle.translate(headPos.x + m.headSize * 0.85, headPos.y - m.headSize * 0.1, 0);
  pieces.push({ geo: tag(muzzle, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.accent });

  // Eyes and nose. Small, dark and strongly contrasting: nothing else at this
  // size makes an animal read as looking at something rather than as a shape
  // pointed in a direction.
  if (detail) {
    const eyeR = Math.max(0.012, m.headSize * 0.16);
    for (const side of [-1, 1]) {
      const eye = paint(new THREE.SphereGeometry(eyeR, 16, 12), m.eye, 0.02, 37);
      eye.translate(headPos.x + m.headSize * 0.42, headPos.y + m.headSize * 0.2, side * m.headSize * 0.36);
      pieces.push({ geo: tag(eye, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.eye });
      // A hint of brow above the eye, which is what gives a face expression.
      const brow = paint(new THREE.BoxGeometry(eyeR * 2.2, eyeR * 0.5, eyeR * 1.6), m.accent, 0.03, 41);
      brow.rotateZ(-0.25);
      brow.translate(headPos.x + m.headSize * 0.4, headPos.y + m.headSize * 0.42, side * m.headSize * 0.36);
      pieces.push({ geo: tag(brow, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.accent });
    }
    const nose = paint(new THREE.SphereGeometry(m.headSize * 0.16, 12, 9), m.eye, 0.02, 43);
    nose.translate(headPos.x + m.headSize * 1.24, headPos.y - m.headSize * 0.14, 0);
    pieces.push({ geo: tag(nose, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.eye });
  }

  // Ears.
  if (m.earSize > 0.03 && detail) {
    for (const side of [-1, 1]) {
      const ear = paint(new THREE.ConeGeometry(m.earSize * 0.32, m.earSize * 1.5, 12, 3), m.fur, 0.06, 19);
      ear.rotateZ(-0.25 * side);
      ear.rotateX(0.3);
      ear.translate(headPos.x - m.headSize * 0.1, headPos.y + m.headSize * 0.7, side * m.headSize * 0.42);
      pieces.push({ geo: tag(ear, side < 0 ? PART.earL : PART.earR, neckPivot), part: side < 0 ? PART.earL : PART.earR, pivot: neckPivot, color: m.fur });
    }
  }

  // Headgear: antlers, horns, mane.
  if (m.headgear === 'antlers' && detail) {
    for (const side of [-1, 1]) {
      for (let branch = 0; branch < 2; branch++) {
        const tine = paint(new THREE.CylinderGeometry(0.045, 0.06, m.headSize * 2.4, 8, 3), m.accent, 0.05, 23);
        tine.translate(0, m.headSize * 1.2, 0);
        tine.rotateZ(side * (0.5 + branch * 0.35));
        tine.rotateX(branch === 0 ? 0.2 : -0.5);
        tine.translate(headPos.x - m.headSize * 0.2, headPos.y + m.headSize * 0.75, side * m.headSize * 0.28);
        pieces.push({ geo: tag(tine, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.accent });
      }
    }
  } else if (m.headgear === 'horns' && detail) {
    for (const side of [-1, 1]) {
      const horn = paint(new THREE.CylinderGeometry(0.05, 0.08, m.headSize * 1.2, 5), m.accent, 0.05, 29);
      horn.translate(0, m.headSize * 0.6, 0);
      horn.rotateZ(side * 0.7);
      horn.translate(headPos.x - m.headSize * 0.2, headPos.y + m.headSize * 0.5, side * m.headSize * 0.4);
      pieces.push({ geo: tag(horn, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.accent });
    }
  } else if (m.headgear === 'mane' && detail) {
    const mane = paint(bodyGeo(m.headSize * 1.15, m.headSize * 0.9, m.headSize * 1.05, 18), m.accent, 0.08, 31);
    mane.translate(headPos.x - m.headSize * 0.1, headPos.y, 0);
    pieces.push({ geo: tag(mane, PART.head, neckPivot), part: PART.head, pivot: neckPivot, color: m.accent });
  }

  // Species signature: features that make this animal recognisable at a glance.
  // Shared body templates alone made many species look alike.
  if (detail && key) addQuadrupedSignature(key, pieces, m, headPos, neckPivot, bodyY);

  // Legs.
  const shoulder = new THREE.Vector3(bl * 0.33, bodyY - girth * 0.25, girth * 0.72);
  const hip = new THREE.Vector3(-bl * 0.33, bodyY - girth * 0.3, girth * 0.72);
  const legs: [number, THREE.Vector3][] = [
    [PART.legFL, new THREE.Vector3(shoulder.x, shoulder.y, shoulder.z)],
    [PART.legFR, new THREE.Vector3(shoulder.x, shoulder.y, -shoulder.z)],
    [PART.legRL, new THREE.Vector3(hip.x, hip.y, hip.z)],
    [PART.legRR, new THREE.Vector3(hip.x, hip.y, -hip.z)],
  ];
  const lowerLen = Math.max(0.04, bodyY - girth * 0.45);
  for (const [part, start] of legs) {
    const mid = new THREE.Vector3(start.x, start.y - lowerLen * 0.5, start.z);
    const end = new THREE.Vector3(start.x, 0.02, start.z);
    if (detail) {
      const upper = paint(legGeo(start.clone(), mid.clone(), girth * 0.16, 4, 12), m.accent, 0.05, part * 3);
      const lower = paint(legGeo(mid.clone(), end.clone(), girth * 0.12, 4, 12), m.accent, 0.05, part * 5);
      pieces.push({ geo: tag(mergeRaw([upper]), part, start.clone()), part, pivot: start.clone(), color: m.accent });
      // The lower leg rotates with the whole limb from the hip, which is
      // visually correct at the distances this world is watched from.
      pieces.push({ geo: tag(mergeRaw([lower]), part, start.clone()), part, pivot: start.clone(), color: m.accent });
    } else {
      const leg = paint(legGeo(start.clone(), end.clone(), girth * 0.15, 1), m.accent, 0.05, part * 7);
      pieces.push({ geo: tag(mergeRaw([leg]), part, start.clone()), part, pivot: start.clone(), color: m.accent });
    }
  }

  // Tail.
  if (m.tailLength > 0.02) {
    const tailPivot = new THREE.Vector3(-bl * 0.5, bodyY + girth * 0.2, 0);
    const tail = paint(new THREE.CylinderGeometry(m.headSize * 0.14, m.headSize * 0.2, m.tailLength, detail ? 12 : 5, detail ? 6 : 1), m.fur, 0.06, 37);
    tail.translate(0, m.tailLength * 0.5, 0);
    tail.rotateZ(-1.1);
    tail.translate(tailPivot.x, tailPivot.y, 0);
    pieces.push({ geo: tag(tail, PART.tail, tailPivot), part: PART.tail, pivot: tailPivot, color: m.fur });
  }

  const merged = mergePieces(pieces);
  applyPattern(merged, m);
  return merged;
}

/**
 * A thin panel with a real outline (fin, wing, tail fan): the closed polygon
 * is extruded by `thickness`, so the panel has a true edge and a visible
 * thickness instead of a rectangle.
 */
function flatPanel(outline: [number, number][], thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  outline.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -thickness / 2);
  g.computeVertexNormals();
  return g;
}

/**
 * A tapered tube from `from` to `to`. The cylinder is oriented about its own
 * centre first and only then moved to the midpoint, so its ends land exactly on
 * the two points. Translating before rotating moves it off the points.
 */
function tube(from: THREE.Vector3, to: THREE.Vector3, rFrom: number, rTo: number, radial: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = Math.max(0.001, dir.length());
  const g = new THREE.CylinderGeometry(rTo, rFrom, len, radial, 4);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return g;
}


/** Bird-only features, per species. */
function addBirdSignature(key: string, pieces: Piece[], m: Morphology, headPivot: THREE.Vector3): void {
  const hs = m.headSize;
  const add = (geo: THREE.BufferGeometry, color: [number, number, number]) => pieces.push({ geo: tag(geo, PART.head, headPivot), part: PART.head, pivot: headPivot.clone(), color });
  switch (key) {
    case 'eagle': {
      // Pale head and a hooked tip on the bill.
      const cap = paint(bodyGeo(hs * 0.7, hs * 0.55, hs * 0.6, 14), [0.96, 0.95, 0.92], 0.02, 81);
      cap.translate(headPivot.x + hs * 0.1, headPivot.y + hs * 0.15, 0);
      add(cap, [0.96, 0.95, 0.92]);
      const hook = paint(new THREE.ConeGeometry(hs * 0.12, hs * 0.35, 8), m.accent, 0.03, 83);
      hook.rotateZ(-Math.PI / 2 + 0.6);
      hook.translate(headPivot.x + hs * 1.15, headPivot.y - hs * 0.22, 0);
      add(hook, m.accent);
      break;
    }
    case 'owl': {
      // Facial disc and ear tufts.
      const disc = paint(bodyGeo(hs * 0.2, hs * 0.85, hs * 0.85, 14), m.accent, 0.03, 85);
      disc.translate(headPivot.x + hs * 0.5, headPivot.y, 0);
      add(disc, m.accent);
      for (const side of [-1, 1]) {
        const tuft = paint(new THREE.ConeGeometry(hs * 0.16, hs * 0.7, 8), m.fur, 0.04, 87);
        tuft.translate(headPivot.x - hs * 0.1, headPivot.y + hs * 0.75, side * hs * 0.35);
        add(tuft, m.fur);
      }
      break;
    }
    case 'raven': {
      // Heavy bill and throat bristles.
      const bill = paint(new THREE.ConeGeometry(hs * 0.3, hs * 1.1, 10), m.accent, 0.02, 89);
      bill.rotateZ(-Math.PI / 2);
      bill.translate(headPivot.x + hs * 1.0, headPivot.y - hs * 0.05, 0);
      add(bill, m.accent);
      const bristle = paint(bodyGeo(hs * 0.3, hs * 0.35, hs * 0.4, 8), m.fur, 0.03, 91);
      bristle.translate(headPivot.x + hs * 0.55, headPivot.y - hs * 0.45, 0);
      add(bristle, m.fur);
      break;
    }
    case 'heron': {
      // Dagger bill and two crest plumes.
      const bill = paint(new THREE.ConeGeometry(hs * 0.1, hs * 2.2, 8), m.accent, 0.02, 93);
      bill.rotateZ(-Math.PI / 2 + 0.05);
      bill.translate(headPivot.x + hs * 1.2, headPivot.y - hs * 0.02, 0);
      add(bill, m.accent);
      for (const side of [-1, 1]) {
        const plume = paint(new THREE.ConeGeometry(hs * 0.06, hs * 1.2, 6), m.accent, 0.03, 95);
        plume.rotateZ(0.9);
        plume.translate(headPivot.x - hs * 0.4, headPivot.y + hs * 0.55, side * hs * 0.1);
        add(plume, m.accent);
      }
      break;
    }
    default:
      break;
  }
}

/** Fish-only features, per species. */
function addFishSignature(key: string, pieces: Piece[], m: Morphology, bl: number, girth: number): void {
  const origin = new THREE.Vector3();
  const add = (geo: THREE.BufferGeometry, color: [number, number, number]) => pieces.push({ geo: tag(geo, PART.body, origin), part: PART.body, pivot: origin.clone(), color });
  switch (key) {
    case 'trout': {
      // Red lateral stripe along each flank.
      for (const side of [-1, 1]) {
        const stripe = paint(bodyGeo(bl * 0.38, girth * 0.12, girth * 0.08, 10), [0.78, 0.22, 0.2], 0.04, 97);
        stripe.translate(bl * 0.02, girth * 0.05, side * girth * 0.6);
        add(stripe, [0.78, 0.22, 0.2]);
      }
      break;
    }
    case 'perch': {
      // Spiny front dorsal: a row of short spines.
      for (let k = 0; k < 7; k++) {
        const spine = paint(new THREE.ConeGeometry(girth * 0.1, girth * 0.55, 5), m.accent, 0.03, 99 + k);
        spine.translate(bl * (-0.12 + k * 0.05), girth * 0.62, 0);
        add(spine, m.accent);
      }
      break;
    }
    default:
      break;
  }
}

/** Bird: body, head+beak, tail fan, wings. */
export function buildBird(m: Morphology, detail: boolean, key?: string): THREE.BufferGeometry {
  const pieces: Piece[] = [];
  const stand = m.standHeight;
  const bl = m.bodyLength;
  const girth = m.bodyGirth;

  const body = paint(bodyGeo(bl * 0.5, girth * 0.85, girth, detail ? 24 : 6), m.fur, 0.07, 41);
  body.translate(0, stand, 0);
  pieces.push({ geo: tag(body, PART.body, new THREE.Vector3()), part: PART.body, pivot: new THREE.Vector3(), color: m.fur });

  const belly = paint(bodyGeo(bl * 0.4, girth * 0.6, girth * 0.85, detail ? 14 : 6), m.belly, 0.05, 43);
  belly.translate(bl * 0.04, stand - girth * 0.3, 0);
  pieces.push({ geo: tag(belly, PART.body, new THREE.Vector3()), part: PART.body, pivot: new THREE.Vector3(), color: m.belly });

  // The head sits at the far end of the neck, at the species' own neck length,
  // so a heron's head is carried high and a finch's barely clears its back.
  const neckBase = new THREE.Vector3(bl * 0.3, stand + girth * 0.2, 0);
  const neckDir = new THREE.Vector3(0.35, 1, 0).normalize();
  const neckLen = Math.max(0.03, m.neck);
  const headPivot = new THREE.Vector3(neckBase.x + neckDir.x * neckLen, neckBase.y + neckDir.y * neckLen, 0);
  const head = paint(bodyGeo(m.headSize * 0.8, m.headSize * 0.75, m.headSize * 0.75, detail ? 18 : 5), m.fur, 0.05, 47);
  head.translate(headPivot.x + m.headSize * 0.3, headPivot.y, 0);
  pieces.push({ geo: tag(head, PART.head, headPivot), part: PART.head, pivot: headPivot, color: m.fur });

  // Neck: a tapered tube from the chest up to the head. Every bird gets one;
  // without it a heron's head sits on its body like a bead.
  const neckGeo = tube(neckBase, headPivot, girth * 0.42, m.headSize * 0.32, detail ? 14 : 6);
  pieces.push({ geo: tag(paint(neckGeo, m.fur, 0.05, 49), PART.head, headPivot), part: PART.head, pivot: headPivot, color: m.fur });

  // Birds get the same eyes-and-nose treatment as mammals: at close range a
  // dark eye is what makes a hawk read as watching something.
  if (detail) {
    const eyeR = Math.max(0.01, m.headSize * 0.18);
    for (const side of [-1, 1]) {
      const eye = paint(new THREE.SphereGeometry(eyeR, 14, 10), m.eye, 0.02, 61);
      eye.translate(headPivot.x + m.headSize * 0.42, headPivot.y + m.headSize * 0.12, side * m.headSize * 0.34);
      pieces.push({ geo: tag(eye, PART.head, headPivot), part: PART.head, pivot: headPivot, color: m.eye });
    }
  }

  if (detail && key) addBirdSignature(key, pieces, m, headPivot);

  const beak = paint(new THREE.ConeGeometry(m.headSize * 0.22, m.headSize * 0.9, detail ? 12 : 5), m.accent, 0.04, 53);
  beak.rotateZ(-Math.PI / 2);
  beak.translate(headPivot.x + m.headSize * 1.1, headPivot.y, 0);
  pieces.push({ geo: tag(beak, PART.head, headPivot), part: PART.head, pivot: headPivot, color: m.accent });

  // Tail fan.
  const tailPivot = new THREE.Vector3(-bl * 0.45, stand + girth * 0.1, 0);
  // Tail fan: a rounded outline, laid flat behind the body.
  const TL = m.tailLength * 1.6;
  const TW = m.tailLength * 1.5;
  const fan: [number, number][] = [
    [TL * 0.5, -TW * 0.1],
    [TL * 0.1, -TW * 0.5],
    [-TL * 0.4, -TW * 0.55],
    [-TL * 0.5, -TW * 0.2],
    [-TL * 0.5, TW * 0.2],
    [-TL * 0.4, TW * 0.55],
    [TL * 0.1, TW * 0.5],
  ];
  const tail = paint(flatPanel(fan, 0.03), m.fur, 0.06, 59);
  tail.rotateX(-Math.PI / 2);
  tail.rotateZ(0.12);
  tail.translate(tailPivot.x - m.tailLength * 0.8, tailPivot.y, 0);
  pieces.push({ geo: tag(tail, PART.tail, tailPivot), part: PART.tail, pivot: tailPivot, color: m.fur });

  // Wings: inner and outer panels so the flap reads clearly.
  const span = m.wingSpan * 0.5;
  for (const side of [-1, 1]) {
    const part = side < 0 ? PART.wingL : PART.wingR;
    const pivot = new THREE.Vector3(bl * 0.05, stand + girth * 0.2, side * girth * 0.5);
    const c = bl * 0.5;
    const S1 = span * 0.55;
    // Root section: broad at the body, narrowing toward the mid-wing.
    const innerOutline: [number, number][] = [
      [-c * 0.5, 0],
      [c * 0.5, 0],
      [c * 0.3, S1 * 0.7],
      [-c * 0.35, S1],
    ];
    const inner = paint(flatPanel(innerOutline, 0.035), m.accent, 0.06, part * 9);
    inner.rotateX(side < 0 ? -Math.PI / 2 : Math.PI / 2);
    inner.translate(pivot.x - bl * 0.1, pivot.y, side * girth * 0.5);
    pieces.push({ geo: tag(inner, part, pivot), part, pivot, color: m.accent });
    if (detail) {
      // Primary feathers: a narrower tip section continuing the span.
      const c2 = bl * 0.44;
      const S2 = span * 0.5;
      const outerOutline: [number, number][] = [
        [-c2 * 0.5, S1 * 0.9],
        [c2 * 0.4, S1 * 0.9],
        [c2 * 0.25, S1 + S2 * 0.6],
        [-c2 * 0.1, S1 + S2],
        [-c2 * 0.5, S1 + S2 * 0.8],
      ];
      const outer = paint(flatPanel(outerOutline, 0.03), m.accent, 0.06, part * 11);
      outer.rotateX(side < 0 ? -Math.PI / 2 : Math.PI / 2);
      outer.translate(pivot.x - bl * 0.3, pivot.y, side * girth * 0.5);
      pieces.push({ geo: tag(outer, part, pivot), part, pivot, color: m.accent });
    }
  }

  const merged = mergePieces(pieces);
  applyPattern(merged, m);
  return merged;
}

/** Fish: fusiform body, tail fin, dorsal fin, side fins. */
export function buildFish(m: Morphology, detail: boolean, key?: string): THREE.BufferGeometry {
  const pieces: Piece[] = [];
  const bl = m.bodyLength;
  const girth = m.bodyGirth;
  const body = paint(bodyGeo(bl * 0.5, girth * 0.6, girth * 0.7, detail ? 24 : 6), m.fur, 0.07, 61);
  pieces.push({ geo: tag(body, PART.body, new THREE.Vector3()), part: PART.body, pivot: new THREE.Vector3(), color: m.fur });

  const belly = paint(bodyGeo(bl * 0.35, girth * 0.4, girth * 0.6, 6), m.belly, 0.05, 67);
  belly.translate(0, -girth * 0.28, 0);
  pieces.push({ geo: tag(belly, PART.body, new THREE.Vector3()), part: PART.body, pivot: new THREE.Vector3(), color: m.belly });

  const headPivot = new THREE.Vector3(bl * 0.35, 0, 0);
  const head = paint(bodyGeo(m.headSize * 0.6, m.headSize * 0.5, m.headSize * 0.55, detail ? 14 : 6), m.fur, 0.05, 71);
  head.translate(bl * 0.32, 0, 0);
  pieces.push({ geo: tag(head, PART.head, headPivot), part: PART.head, pivot: headPivot, color: m.fur });
  if (detail && key) addFishSignature(key, pieces, m, bl, girth);

  // Eyes, set high on the head as they are on a trout.
  if (detail) {
    const eyeR = Math.max(0.008, m.headSize * 0.22);
    for (const side of [-1, 1]) {
      const eye = paint(new THREE.SphereGeometry(eyeR, 12, 9), m.eye, 0.02, 79);
      eye.translate(bl * 0.38, m.headSize * 0.22, side * m.headSize * 0.3);
      pieces.push({ geo: tag(eye, PART.head, headPivot), part: PART.head, pivot: headPivot, color: m.eye });
    }
  }

  // Tail fin.
  const tailPivot = new THREE.Vector3(-bl * 0.42, 0, 0);
  // Forked caudal fin: a crescent outline, its base on the body's rear end.
  const H = girth * 0.8;
  const L = bl * 0.2;
  const tailOutline: [number, number][] = [
    [0, -0.25 * H],
    [-0.5 * L, -H],
    [-L, -0.85 * H],
    [-0.8 * L, 0],
    [-L, 0.85 * H],
    [-0.5 * L, H],
    [0, 0.25 * H],
    [-0.25 * L, 0],
  ];
  const tail = paint(flatPanel(tailOutline, 0.02), m.accent, 0.06, 73);
  tail.translate(-bl * 0.5, 0, 0);
  pieces.push({ geo: tag(tail, PART.tail, tailPivot), part: PART.tail, pivot: tailPivot, color: m.accent });

  if (m.finStyle !== 'none') {
    const finPivot = new THREE.Vector3(0, girth * 0.5, 0);
    const B = bl * 0.28;
    const D = girth * 0.9;
    const dorsal: [number, number][] = [
      [0, 0],
      [B, 0],
      [B * 0.65, D * 0.45],
      [B * 0.3, D],
      [0, D * 0.4],
    ];
    const fin = paint(flatPanel(dorsal, 0.02), m.accent, 0.06, 79);
    fin.translate(-B * 0.4, girth * 0.45, 0);
    pieces.push({ geo: tag(fin, PART.fin, finPivot), part: PART.fin, pivot: finPivot, color: m.accent });
  }
  if (detail) {
    for (const side of [-1, 1]) {
      const L2 = bl * 0.16;
      const W2 = girth * 0.6;
      const paddle: [number, number][] = [
        [0, 0],
        [L2 * 0.55, W2 * 0.5],
        [L2, W2 * 0.2],
        [L2 * 0.9, 0],
        [L2, -W2 * 0.2],
        [L2 * 0.55, -W2 * 0.5],
      ];
      const fin = paint(flatPanel(paddle, 0.02), m.accent, 0.05, side * 83 + 90);
      fin.rotateX(side < 0 ? -Math.PI / 2 : Math.PI / 2);
      fin.rotateY(side * 0.4);
      fin.translate(bl * 0.12, -girth * 0.1, side * girth * 0.5);
      pieces.push({ geo: tag(fin, PART.fin, new THREE.Vector3(0, 0, 0)), part: PART.fin, pivot: new THREE.Vector3(), color: m.accent });
    }
  }

  const merged = mergePieces(pieces);
  applyPattern(merged, m);
  return merged;
}

/** Paint species patterns onto the merged body. */
function applyPattern(geo: THREE.BufferGeometry, m: Morphology): void {
  if (m.pattern === 'plain') return;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let r = col.getX(i);
    let g = col.getY(i);
    let b = col.getZ(i);
    if (m.pattern === 'spotted') {
      const s = Math.sin(x * 21.3) * Math.cos(z * 18.7) * Math.sin(y * 15.1);
      if (s > 0.55) {
        r *= 0.55;
        g *= 0.5;
        b *= 0.45;
      }
    } else if (m.pattern === 'striped') {
      if (Math.sin(x * 26.0) > 0.4) {
        r *= 0.6;
        g *= 0.55;
        b *= 0.5;
      }
    } else if (m.pattern === 'dark-ends') {
      const tip = clamp01((x - m.bodyLength * 0.25) / (m.bodyLength * 0.35));
      const t = Math.max(tip, clamp01((-x - m.bodyLength * 0.25) / (m.bodyLength * 0.35)));
      r = lerp(r, r * 0.4, t);
      g = lerp(g, g * 0.4, t);
      b = lerp(b, b * 0.42, t);
    } else if (m.pattern === 'belly-light') {
      const t = clamp01((0.2 - y) * 1.4);
      r = lerp(r, 0.85, t * 0.5);
      g = lerp(g, 0.83, t * 0.5);
      b = lerp(b, 0.8, t * 0.5);
    }
    col.setXYZ(i, clamp01(r), clamp01(g), clamp01(b));
  }
}

/* ------------------------------------------------------------------ */
/* Shader animation                                                    */
/* ------------------------------------------------------------------ */

const ANIM_COMMON = /* glsl */ `
  attribute float aPart;
  attribute vec3 aPivot;
  attribute float aPhase;
  attribute vec4 aAnim; // x = speed01, y = action id, z = health, w = age01
  uniform float uTime;
  uniform float uWindLen;
  uniform float uSnow;
  uniform float uMoon; // 0 day, 1 night — animals are less active/visible
  varying vec3 vFur;
  varying float vHealth;
  varying float vSnowMix;

  vec3 rotAxis(vec3 p, vec3 pivot, vec3 axis, float angle) {
    vec3 d = p - pivot;
    float c = cos(angle);
    float s = sin(angle);
    float t = 1.0 - c;
    vec3 a = normalize(axis);
    vec3 r = vec3(
      (t * a.x * a.x + c) * d.x + (t * a.x * a.y - s * a.z) * d.y + (t * a.x * a.z + s * a.y) * d.z,
      (t * a.x * a.y + s * a.z) * d.x + (t * a.y * a.y + c) * d.y + (t * a.y * a.z - s * a.x) * d.z,
      (t * a.x * a.z - s * a.y) * d.x + (t * a.y * a.z + s * a.x) * d.y + (t * a.z * a.z + c) * d.z
    );
    return pivot + r;
  }
`;

const ANIM_BODY = /* glsl */ `
  vec3 p = transformed;
  float speed01 = aAnim.x;
  float ac = aAnim.y;
  float phase = aPhase * 6.2831 + uTime * (1.2 + speed01 * 7.0);
  float gait = 0.15 + speed01 * 0.95;

  // Walking / running: legs alternate in diagonal pairs, body bobs and rolls.
  if (aPart > 0.5 && aPart < 4.5) {
    float front = (aPart < 2.5) ? 0.0 : 3.1416;
    float side = (abs(aPart - floor(aPart) - 0.0) < 0.01) ? 0.0 : 3.1416;
    vec2 pairOffset = vec2(0.0, 3.1416);
    float off = pairOffset[int(mod(aPart - 1.0, 2.0))];
    float swing = sin(phase * (0.5 + speed01 * 0.5) + off + front * 0.35 + side * 0.5) * gait * 0.7;
    p = rotAxis(p, aPivot, vec3(0.0, 0.0, 1.0), swing);
    // Knee tuck on the back half of the stride.
    p = rotAxis(p, aPivot + vec3(0.0, -0.25, 0.0), vec3(0.0, 0.0, 1.0), max(0.0, -swing) * 0.8);
  } else if (aPart > 6.5 && aPart < 8.5) {
    // Wings.
    float flap = sin(phase * (0.6 + speed01 * 1.4)) * (0.25 + speed01 * 0.75) * (ac > 1.5 ? 1.0 : 0.35);
    float side = (aPart < 7.5) ? 1.0 : -1.0;
    p = rotAxis(p, aPivot, vec3(1.0, 0.0, 0.0), side * flap * 0.9);
  } else if (aPart > 5.5 && aPart < 6.5) {
    // Tail sway.
    p = rotAxis(p, aPivot, vec3(0.0, 1.0, 0.0), sin(phase * 0.7) * 0.25 * (0.4 + speed01));
  } else if (aPart > 4.5 && aPart < 5.5) {
    // Head bob and grazing dip: a downward nod that deepens when feeding.
    float graze = (ac > 3.5 && ac < 5.5) ? 0.55 : 0.0;
    float nod = sin(phase * 0.6) * 0.08 * (1.0 + speed01) + graze * 0.5;
    p = rotAxis(p, aPivot, vec3(0.0, 0.0, 1.0), -nod);
    p = rotAxis(p, aPivot, vec3(0.0, 1.0, 0.0), sin(uTime * 0.5 + aPhase * 6.0) * 0.12);
  } else if (aPart > 8.5 && aPart < 9.5) {
    // Fins ripple.
    p = rotAxis(p, aPivot, vec3(0.0, 0.0, 1.0), sin(phase * 1.4) * 0.2);
  } else {
    // Body: bob, lean into the movement, and crouch while resting.
    float crouch = (ac > 1.5 && ac < 3.0) ? 0.25 : 0.0;
    p.y += sin(phase * 2.0) * 0.035 * speed01;
    p.y -= crouch * 0.3;
    p = rotAxis(p, vec3(0.0, aPivot.y, 0.0), vec3(0.0, 0.0, 1.0), sin(phase) * 0.03 * speed01);
  }
  transformed = p;
  vFur = color;
  vHealth = aAnim.z;
  // Winter camouflage blends animals into snow.
  vSnowMix = uSnow * (1.0 - abs(aAnim.w - 0.45)) * 0.6;
`;

const ANIM_FRAGMENT = /* glsl */ `
  // Individual condition: sick, starving or injured animals look it.
  vec3 sick = vec3(0.55, 0.52, 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, sick, clamp(1.0 - vHealth, 0.0, 1.0) * 0.55);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), clamp(vSnowMix, 0.0, 1.0));
  // Night desaturation so animals do not glow in the dark.
  diffuseColor.rgb *= mix(1.0, 0.55, uMoon * 0.7);
`;

/** A per-species pool of instanced animals, with a near/far LOD split. */
class SpeciesMesh {
  readonly near: THREE.InstancedMesh;
  readonly far: THREE.InstancedMesh;
  private nearCount = 0;
  private farCount = 0;
  private nearAnim: THREE.InstancedBufferAttribute;
  private farAnim: THREE.InstancedBufferAttribute;
  private nearPhase: THREE.InstancedBufferAttribute;
  private farPhase: THREE.InstancedBufferAttribute;

  constructor(readonly speciesIdx: number, geoNear: THREE.BufferGeometry, geoFar: THREE.BufferGeometry, nearCap: number, farCap: number) {
    const material = (geo: THREE.BufferGeometry) => {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        shader.uniforms.uSnow = { value: 0 };
        shader.uniforms.uMoon = { value: 0 };
        shader.uniforms.uWindLen = { value: 0 };
        mesh.uniforms.push(shader.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${ANIM_COMMON}`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ANIM_BODY}`);
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>\nvarying vec3 vFur;\nvarying float vHealth;\nvarying float vSnowMix;\nuniform float uMoon;`,
          )
          .replace('#include <color_fragment>', `#include <color_fragment>\n${ANIM_FRAGMENT}`);
      };
      mat.customProgramCacheKey = () => 'creature-v1';
      void geo;
      return mat;
    };
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uSnow = { value: 0 };
      shader.uniforms.uMoon = { value: 0 };
      shader.uniforms.uWindLen = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${ANIM_COMMON}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ANIM_BODY}`);
    };
    depth.customProgramCacheKey = () => 'creature-depth-v1';

    const attach = (mesh: THREE.InstancedMesh, cap: number, detail: boolean) => {
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const phase = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      anim.setUsage(THREE.DynamicDrawUsage);
      phase.setUsage(THREE.DynamicDrawUsage);
      const g = detail ? geoNear : geoFar;
      g.setAttribute('aAnim', anim);
      g.setAttribute('aPhase', phase);
      mesh.castShadow = detail;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return { anim, phase };
    };

    const mesh = this;
    this.near = new THREE.InstancedMesh(geoNear, material(geoNear), nearCap);
    this.far = new THREE.InstancedMesh(geoFar, material(geoFar), farCap);
    this.near.customDepthMaterial = depth.clone();
    const nearAttrs = attach(this.near, nearCap, true);
    const farAttrs = attach(this.far, farCap, false);
    this.nearAnim = nearAttrs.anim;
    this.nearPhase = nearAttrs.phase;
    this.farAnim = farAttrs.anim;
    this.farPhase = farAttrs.phase;
  }

  uniforms: Record<string, THREE.IUniform>[] = [];
  private dummy = new THREE.Object3D();

  begin(): void {
    this.nearCount = 0;
    this.farCount = 0;
  }

  /** Place one animal. Size is already in world units. */
  add(pos: THREE.Vector3, heading: number, length: number, height: number, speed01: number, action: number, health: number, age01: number, phase: number, near: boolean): void {
    const d = this.dummy;
    d.position.copy(pos);
    d.rotation.set(0, -heading, 0);
    d.scale.set(length, height, height);
    d.updateMatrix();
    if (near && this.nearCount < this.near.instanceMatrix.count) {
      this.near.setMatrixAt(this.nearCount, d.matrix);
      this.nearAnim.setXYZW(this.nearCount, speed01, action, health, age01);
      this.nearPhase.setX(this.nearCount, phase);
      this.nearCount++;
    } else if (this.farCount < this.far.instanceMatrix.count) {
      this.far.setMatrixAt(this.farCount, d.matrix);
      this.farAnim.setXYZW(this.farCount, speed01, action, health, age01);
      this.farPhase.setX(this.farCount, phase);
      this.farCount++;
    }
  }

  end(): void {
    this.near.count = this.nearCount;
    this.far.count = this.farCount;
    (this.near.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.far.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.nearAnim.needsUpdate = true;
    this.farAnim.needsUpdate = true;
    this.nearPhase.needsUpdate = true;
    this.farPhase.needsUpdate = true;
  }

  updateUniforms(time: number, snow: number, moon: number): void {
    for (const u of this.uniforms) {
      u.uTime.value = time;
      u.uSnow.value = snow;
      u.uMoon.value = moon;
      u.uWindLen.value = 0;
    }
  }

  dispose(): void {
    this.near.geometry.dispose();
    this.far.geometry.dispose();
    (this.near.material as THREE.Material).dispose();
    (this.far.material as THREE.Material).dispose();
  }
}

/**
 * Draws the individually simulated animals. The geometry is procedural and the
 * animation is a function of the simulation's own state: gait length follows
 * real speed, posture follows the current action, colour follows health, and
 * winter snow cover bleaches animals that evolved pale fur.
 */
export class CreatureRenderer {
  readonly group = new THREE.Group();
  private meshes: SpeciesMesh[] = [];
  private nearCap: number;
  private farCap: number;
  private scratch: THREE.Vector3[] = [];
  private lastPhaseRefresh = 0;
  private skinned: SkinnedAnimals;
  private lastNow = 0;
  private skinnedSkip = new Set<number>();

  constructor(private world: World, quality: 'low' | 'medium' | 'high' | 'ultra') {
    const detailScale = quality === 'low' ? 0.35 : quality === 'medium' ? 0.6 : 1;
    this.skinned = new SkinnedAnimals(this.group, quality === 'low' ? 4 : 12);
    this.skinned.load();
    // Hand-built species get a procedural rig from their own mesh, so their
    // close-ups are animated like the fox.
    for (const key of ['rabbit', 'deer'] as const) {
      const sp = SPECIES.find((x) => x.key === key);
      if (!sp) continue;
      const geo = key === 'rabbit' ? buildRabbit(sp.morphology, true) : buildDeer(sp.morphology, true);
      const rig = buildRiggedAnimal(geo, sp.morphology.standHeight, key === 'rabbit');
      this.skinned.addRigged(key, rig.scene, rig.animations);
    }
    this.nearCap = Math.max(24, Math.round(70 * detailScale));
    this.farCap = Math.max(120, Math.round(320 * detailScale));
    for (let i = 0; i < SPECIES.length; i++) {
      const m = SPECIES[i].morphology;
      const key = SPECIES[i].key;
      const build = (mm: Morphology, d: boolean) => (SPECIES[i].locomotion === 'bird' ? buildBird(mm, d, key) : SPECIES[i].locomotion === 'fish' ? buildFish(mm, d, key) : buildQuadruped(mm, d, key));
      const near = build(m, true);
      const far = quality === 'low' ? near : build(m, false);
      const mesh = new SpeciesMesh(i, near, far, this.nearCap, this.farCap);
      this.meshes.push(mesh);
      // Separate meshes per LOD so the shadow pass can skip distant animals.
      this.group.add(mesh.near, mesh.far);
      this.scratch.push(new THREE.Vector3());
    }
  }

  /** Rebuild the instance lists for this frame. */
  update(cameraPos: THREE.Vector3, night: number, snowCover: number): void {
    const world = this.world;
    const c: Creatures = world.creatures;
    const now = performance.now();
    if (now - this.lastPhaseRefresh > 5000) {
      this.lastPhaseRefresh = now;
    }
    for (const m of this.meshes) m.begin();

    // Rigged species: the nearest few are drawn as skinned models and left out
    // of the instanced pass. Everything else takes the instanced path below.
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    this.skinned.beginFrame();
    const alpha = world.frameAlpha;
    for (const key of this.skinned.species()) {
      if (!this.skinned.isReady(key)) continue;
      const spIdx = SPECIES.findIndex((sp) => sp.key === key);
      if (spIdx < 0) continue;
      const dist = (i: number) => Math.hypot(c.x[i] - cameraPos.x, c.y[i] - cameraPos.z);
      const picks: number[] = [];
      for (let i = 0; i < c.capacity; i++) {
        if (!c.alive[i] || c.speciesIdx[i] !== spIdx) continue;
        if (dist(i) < RENDER.creatureAnimDistance) picks.push(i);
      }
      picks.sort((a, b) => dist(a) - dist(b));
      this.skinned.place(
        key,
        picks.slice(0, 12),
        c,
        SPECIES[spIdx].morphology.bodyLength,
        (i) => lerpAngle(c.prevHeading[i], c.heading[i], alpha),
        (i) => new THREE.Vector3(lerp(c.prevX[i], c.x[i], alpha), c.z[i], lerp(c.prevY[i], c.y[i], alpha)),
      );
      for (const i of this.skinned.consumed()) this.skinnedSkip.add(i);
    }
    this.skinned.update(dt);

    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      if (this.skinnedSkip.has(i)) continue;
      const spIdx = c.speciesIdx[i];
      const sp = SPECIES[spIdx];
      const mesh = this.meshes[spIdx];
      const scale = c.bodyScale(i);
      const dist = Math.hypot(c.x[i] - cameraPos.x, c.y[i] - cameraPos.z);
      const near = dist < RENDER.creatureAnimDistance;
      // Interpolate between sim steps so movement looks continuous.
      const alpha = world.frameAlpha;
      const ix = lerp(c.prevX[i], c.x[i], alpha);
      const iy = lerp(c.prevY[i], c.y[i], alpha);
      const heading = lerpAngle(c.prevHeading[i], c.heading[i], alpha);
      const pos = this.scratch[spIdx];
      pos.set(ix, c.z[i], iy);
      const speedMax = Math.max(0.001, sp.runSpeed);
      const speed01 = clamp01(c.speed[i] / speedMax);
      const age01 = clamp01(c.ageDays[i] / (sp.maxAgeYears * 365));
      const health = clamp01(c.health[i]);
      const actionId = c.action[i];
      mesh.add(pos, heading, scale, scale, speed01, actionId, health, age01, c.animPhase[i], near);
    }

    for (const m of this.meshes) {
      m.end();
      m.updateUniforms(world.clock.minutes * 0.02, snowCover, night);
    }
    this.skinnedSkip.clear();
  }

  countInstances(): { near: number; far: number } {
    let near = 0;
    let far = 0;
    for (const m of this.meshes) {
      near += m.near.count;
      far += m.far.count;
    }
    return { near, far };
  }

  dispose(): void {
    this.skinned.dispose();
    for (const m of this.meshes) m.dispose();
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
}

