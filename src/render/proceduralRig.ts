/*
 * Procedural rig for hand-built quadruped meshes.
 *
 * The creature builders tag every vertex with the body part it belongs to
 * (aPart) and that part's pivot (aPivot). Here each part becomes a bone at its
 * pivot, every vertex is skinned fully to its part's bone, and a set of clips
 * (idle, walk, run, rest, death, bite) is generated as keyframes. The result
 * has the same shape as a loaded GLB, so it can go through the same skinned
 * animal pool as the fox.
 *
 * Geometry is built facing +X (head at +X). It is rotated to face +Z, which is
 * the convention the skinned pool uses.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Part ids from creatureRenderer's PART table. */
const PART_NAMES: Record<number, string> = {
  0: 'body',
  1: 'legFL',
  2: 'legFR',
  3: 'legRL',
  4: 'legRR',
  5: 'head',
  6: 'tail',
  10: 'earL',
  11: 'earR',
};

const SAMPLES = 16;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface Gait {
  /** Phase offsets for the four legs (radians). */
  phase: { FL: number; FR: number; RL: number; RR: number };
  /** Stride period in seconds at walk and at run. */
  walkPeriod: number;
  runPeriod: number;
}

/** Bound gait (rabbit): front pair together, hind pair together. */
export const BOUND_GAIT: Gait = {
  phase: { FL: 0, FR: 0, RL: Math.PI, RR: Math.PI },
  walkPeriod: 0.7,
  runPeriod: 0.4,
};

/** Trot gait (deer): diagonal pairs together. */
export const TROT_GAIT: Gait = {
  phase: { FL: 0, FR: Math.PI, RL: Math.PI, RR: 0 },
  walkPeriod: 0.9,
  runPeriod: 0.5,
};

export interface RiggedAnimal {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/** Sample f over one period at SAMPLES+1 keys, closing the loop. */
function sample(period: number, f: (ph: number) => number): { times: number[]; vals: number[] } {
  const times: number[] = [];
  const vals: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    times.push((i * period) / SAMPLES);
    vals.push(f((2 * Math.PI * i) / SAMPLES));
  }
  return { times, vals };
}

function rotTrack(bone: string, times: number[], angles: number[], axis: THREE.Vector3): THREE.QuaternionKeyframeTrack {
  const values: number[] = [];
  for (const a of angles) {
    const q = new THREE.Quaternion().setFromAxisAngle(axis, a);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}

function posTrack(bone: string, times: number[], ys: number[], baseY: number): THREE.VectorKeyframeTrack {
  const values: number[] = [];
  for (const y of ys) values.push(0, baseY + y, 0);
  return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values);
}

const AX = new THREE.Vector3(1, 0, 0); // lateral: legs and head swing in the Z-Y plane
const AZ = new THREE.Vector3(0, 0, 1);
const AY = Y_AXIS;

/** Clips for a quadruped. `S` is the body centre height, `bound` picks the gait. */
function buildClips(S: number, gait: Gait): THREE.AnimationClip[] {
  const clips: THREE.AnimationClip[] = [];
  const legTracks = (period: number, amp: number) =>
    (['FL', 'FR', 'RL', 'RR'] as const).map((leg) => {
      const name = leg === 'FL' ? 'legFL' : leg === 'FR' ? 'legFR' : leg === 'RL' ? 'legRL' : 'legRR';
      const s = sample(period, (ph) => amp * Math.sin(ph + gait.phase[leg]));
      return rotTrack(name, s.times, s.vals, AX);
    });

  // Idle: slow breathing, head and ears twitch.
  {
    const T = 3.2;
    const head = sample(T, (ph) => 0.04 * Math.sin(ph));
    const bob = sample(T, (ph) => 0.003 * S * Math.sin(ph));
    const earL = sample(T, (ph) => 0.1 * Math.sin(ph * 2));
    const earR = sample(T, (ph) => 0.1 * Math.sin(ph * 2 + 0.5));
    clips.push(new THREE.AnimationClip('Idle', T, [
      rotTrack('head', head.times, head.vals, AX),
      posTrack('body', bob.times, bob.vals, S),
      rotTrack('earL', earL.times, earL.vals, AX),
      rotTrack('earR', earR.times, earR.vals, AX),
    ]));
  }

  // Walk and run: the legs cycle, the body bobs, the tail sways.
  for (const [name, period, amp, bobAmp] of [
    ['Walk', gait.walkPeriod, 0.35, 0.01],
    ['Run', gait.runPeriod, 0.8, 0.03],
  ] as const) {
    const tracks = legTracks(period, amp);
    const head = sample(period, (ph) => amp * 0.12 * Math.sin(ph));
    const bob = sample(period, (ph) => bobAmp * S * Math.cos(2 * ph));
    const tail = sample(period, (ph) => 0.2 * Math.sin(ph));
    const ear = sample(period, (ph) => amp * 0.3 * Math.sin(ph + 0.8));
    tracks.push(
      rotTrack('head', head.times, head.vals, AX),
      posTrack('body', bob.times, bob.vals, S),
      rotTrack('tail', tail.times, tail.vals, AY),
      rotTrack('earL', ear.times, ear.vals, AX),
      rotTrack('earR', ear.times, ear.vals, AX),
    );
    clips.push(new THREE.AnimationClip(name, period, tracks));
  }

  // Rest: lowered body, head down.
  {
    const T = 4;
    const bob = sample(T, () => -0.12 * S);
    const head = sample(T, (ph) => 0.25 + 0.03 * Math.sin(ph));
    clips.push(new THREE.AnimationClip('Sit', T, [
      posTrack('body', bob.times, bob.vals, S),
      rotTrack('head', head.times, head.vals, AX),
    ]));
  }

  // Death: roll onto the side and stay there.
  {
    const times = [0, 1];
    clips.push(new THREE.AnimationClip('Death', 1, [
      rotTrack('body', times, [0, Math.PI / 2], AZ),
      posTrack('body', times, [0, -0.5 * S], S),
    ]));
  }

  // Bite: head snaps down and up.
  {
    const T = 1.2;
    const head = sample(T, (ph) => 0.6 * (0.5 - 0.5 * Math.cos(ph)));
    clips.push(new THREE.AnimationClip('Bite', T, [rotTrack('head', head.times, head.vals, AX)]));
  }

  return clips;
}

/**
 * Turn a tagged quadruped geometry into a skinned rig with clips. The geometry
 * is modified in place (rotated to face +Z).
 */
export function buildRiggedAnimal(geo: THREE.BufferGeometry, S: number, bound: boolean): RiggedAnimal {
  const gait = bound ? BOUND_GAIT : TROT_GAIT;
  const partAttr = geo.getAttribute('aPart') as THREE.BufferAttribute;
  const pivAttr = geo.getAttribute('aPivot') as THREE.BufferAttribute;
  const count = partAttr.count;

  // Face +Z: rotate the geometry, and its pivots, by -90 degrees about Y.
  geo.rotateY(-Math.PI / 2);
  const toForward = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyAxisAngle(AY, -Math.PI / 2);

  const boneIndex = new Map<number, number>();
  const bones: THREE.Bone[] = [];
  const inverses: THREE.Matrix4[] = [];
  const group = new THREE.Group();
  for (let v = 0; v < count; v++) {
    const part = partAttr.getX(v);
    if (boneIndex.has(part)) continue;
    // The body rotates about its centre height, so it pivots at S, not the ground.
    let p: THREE.Vector3;
    if (part === 0) p = new THREE.Vector3(0, S, 0);
    else p = toForward(pivAttr.getX(v), pivAttr.getY(v), pivAttr.getZ(v));
    const bone = new THREE.Bone();
    bone.name = PART_NAMES[part] ?? `part${part}`;
    bone.position.copy(p);
    boneIndex.set(part, bones.length);
    bones.push(bone);
    inverses.push(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    group.add(bone);
  }

  // Each vertex follows its part's bone. Vertices close to a joint are also
  // partly weighted to the body bone, so a bent leg or neck deforms smoothly
  // instead of splitting along the joint.
  const bodyBone = boneIndex.get(0) ?? 0;
  const blend = S * 0.3;
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const own = boneIndex.get(partAttr.getX(v)) ?? 0;
    skinIndex[v * 4] = own;
    skinWeight[v * 4] = 1;
    if (own !== bodyBone) {
      const d = new THREE.Vector3(posAttr.getX(v), posAttr.getY(v), posAttr.getZ(v)).distanceTo(bones[own].position);
      const w = Math.max(0, 1 - d / blend) * 0.5;
      if (w > 0) {
        skinIndex[v * 4 + 1] = bodyBone;
        skinWeight[v * 4] = 1 - w;
        skinWeight[v * 4 + 1] = w;
      }
    }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(geo, material);
  const skeleton = new THREE.Skeleton(bones, inverses);
  group.add(mesh);
  group.updateMatrixWorld(true);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;

  const scene = new THREE.Group();
  scene.add(group);
  return { scene, animations: buildClips(S, gait) };
}

/** Part name to animation part id (same table as creatureRenderer's PART). */
const PART_IDS: Record<string, number> = {
  body: 0,
  legFL: 1,
  legFR: 2,
  legRL: 3,
  legRR: 4,
  head: 5,
  tail: 6,
  earL: 10,
  earR: 11,
};

/**
 * Turn a generated GLB (one mesh per part, named "<part>|<label>") into one
 * tagged geometry: colours from the file, aPart from the part name, aPivot from
 * the sidecar's bone positions. The result feeds buildRiggedAnimal.
 */
export function taggedFromScene(scene: THREE.Object3D, bones: Record<string, [number, number, number]>): THREE.BufferGeometry {
  scene.updateMatrixWorld(true);
  type Chunk = { pos: number[]; nor: number[]; col: number[]; part: number; piv: [number, number, number]; idx: number[] };
  const chunks: Chunk[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = (mesh.name || '').split('|')[0];
    const part = PART_IDS[name];
    if (part === undefined || !bones[name]) return;
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const n = pos.count;
    const c: Chunk = { pos: [], nor: [], col: [], part, piv: bones[name], idx: [] };
    for (let i = 0; i < n; i++) {
      c.pos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) c.nor.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      else c.nor.push(0, 1, 0);
      if (col) c.col.push(col.getX(i), col.getY(i), col.getZ(i));
      else c.col.push(1, 1, 1);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) c.idx.push(index.getX(i));
    else for (let i = 0; i < n; i++) c.idx.push(i);
    chunks.push(c);
  });

  let vCount = 0;
  let iCount = 0;
  for (const c of chunks) {
    vCount += c.pos.length / 3;
    iCount += c.idx.length;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const part = new Float32Array(vCount);
  const piv = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const c of chunks) {
    const n = c.pos.length / 3;
    pos.set(c.pos, vo * 3);
    nor.set(c.nor, vo * 3);
    col.set(c.col, vo * 3);
    part.fill(c.part, vo, vo + n);
    for (let i = 0; i < n; i++) {
      piv[(vo + i) * 3] = c.piv[0];
      piv[(vo + i) * 3 + 1] = c.piv[1];
      piv[(vo + i) * 3 + 2] = c.piv[2];
    }
    for (let i = 0; i < c.idx.length; i++) idx[io + i] = c.idx[i] + vo;
    io += c.idx.length;
    vo += n;
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

/** Load a generated species (GLB plus sidecar JSON) and build its rig. */
export function loadGeneratedRig(key: string): Promise<RiggedAnimal> {
  const base = `assets/models/animals/${key}`;
  return Promise.all([
    new GLTFLoader().loadAsync(`${base}.glb`),
    fetch(`${base}.json`).then((r) => {
      if (!r.ok) throw new Error(`${base}.json ${r.status}`);
      return r.json() as Promise<{ bones: Record<string, [number, number, number]>; standHeight: number }>;
    }),
  ]).then(([gltf, side]) => {
    const geo = taggedFromScene(gltf.scene, side.bones);
    return buildRiggedAnimal(geo, side.standHeight, key === 'rabbit');
  });
}
