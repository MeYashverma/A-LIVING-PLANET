/*
 * Skinned, animated animals for the nearest creatures.
 *
 * Far animals are drawn as instances of a procedural mesh (creatureRenderer).
 * The closest few of a species that has a rig are drawn here instead, with a
 * real skeleton. A rig is either a loaded GLB (the fox) or a procedural rig
 * built from a hand-made mesh (rabbit, deer; see proceduralRig.ts). The clip
 * is chosen from the simulation's own action and speed.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Action } from '../life/organism';
import type { Creatures } from '../life/organism';

/** Simulated state to clip name. */
type Clips = Partial<Record<'idle' | 'walk' | 'run' | 'rest' | 'die' | 'bite', string>>;

/** The clip names every rig uses. */
const STANDARD_CLIPS: Clips = { idle: 'Idle', walk: 'Walk', run: 'Run', rest: 'Sit', die: 'Death', bite: 'Bite' };

interface Loaded {
  size: THREE.Vector3;
  minY: number;
}

interface Slot {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<string, THREE.AnimationAction>>;
  current: string;
}

interface Def {
  model: Loaded;
  clips: Clips;
}

const FOX_URL = 'assets/models/mesh2motion-fox.glb';

export class SkinnedAnimals {
  private defs = new Map<string, Def>();
  private pools = new Map<string, Slot[]>();
  private taken = new Set<number>();

  constructor(private readonly group: THREE.Group, private readonly poolSize = 12) {}

  /** Load the GLB rigs. Procedural rigs are added with addRigged(). */
  load(): void {
    new GLTFLoader().load(
      FOX_URL,
      (gltf) => this.attach('fox', gltf.scene, gltf.animations, STANDARD_CLIPS),
      undefined,
      (err) => console.warn(`[skinned] could not load ${FOX_URL}`, err),
    );
  }

  /** Register a procedural rig (scene plus clips) for a species. */
  addRigged(species: string, scene: THREE.Object3D, animations: THREE.AnimationClip[], clips: Clips = STANDARD_CLIPS): void {
    this.attach(species, scene, animations, clips);
  }

  /** Skinned animals per species that can be drawn at once. */
  capacity(): number {
    return this.poolSize;
  }

  /** Species that currently have a rig. */
  species(): string[] {
    return [...this.pools.keys()];
  }

  isReady(species: string): boolean {
    return this.pools.has(species);
  }

  private attach(species: string, scene: THREE.Object3D, animations: THREE.AnimationClip[], clipNames: Clips): void {
    const box = new THREE.Box3().setFromObject(scene);
    this.defs.set(species, { model: { size: box.getSize(new THREE.Vector3()), minY: box.min.y }, clips: clipNames });
    const pool: Slot[] = [];
    const clips = new Map(animations.map((a) => [a.name, a] as const));
    for (let i = 0; i < this.poolSize; i++) {
      const root = SkeletonUtils.clone(scene);
      root.visible = false;
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          (o as THREE.Mesh).castShadow = true;
          (o as THREE.Mesh).frustumCulled = false;
        }
      });
      this.group.add(root);
      const mixer = new THREE.AnimationMixer(root);
      const actions: Partial<Record<string, THREE.AnimationAction>> = {};
      for (const [state, clipName] of Object.entries(clipNames)) {
        const clip = clips.get(clipName as string);
        if (clip) actions[state] = mixer.clipAction(clip);
      }
      pool.push({ root, mixer, actions, current: '' });
    }
    this.pools.set(species, pool);
  }

  /**
   * Place the nearest animals of a species on skinned slots. The creature slots
   * drawn here are recorded so the instanced pass can skip them.
   */
  place(species: string, picks: number[], c: Creatures, bodyLength: number, heading: (i: number) => number, pos: (i: number) => THREE.Vector3): void {
    const pool = this.pools.get(species);
    const def = this.defs.get(species);
    if (!pool || !def) return;
    const model = def.model;
    const modelLen = Math.max(model.size.x, model.size.z);
    const k = (bodyLength * 2.0) / modelLen;
    for (let s = 0; s < pool.length; s++) {
      const slot: Slot = pool[s];
      if (s >= picks.length) {
        slot.root.visible = false;
        continue;
      }
      const i = picks[s];
      this.taken.add(i);
      slot.root.visible = true;
      slot.root.scale.setScalar(k);
      const p = pos(i);
      // Feet at the creature's ground height: lift by the model's lowest point.
      slot.root.position.set(p.x, p.y - model.minY * k, p.z);
      // The model faces +Z. The instanced meshes face +X and use
      // rotation.y = -heading, so this offset makes the two agree.
      slot.root.rotation.set(0, Math.PI / 2 - heading(i), 0);
      const state = this.pickState(i, c, def.clips);
      if (slot.current !== state) {
        const next = slot.actions[state];
        const prev = slot.actions[slot.current];
        if (next) {
          if (state === 'die') {
            next.setLoop(THREE.LoopOnce, 1);
            next.clampWhenFinished = true;
          }
          next.reset().fadeIn(0.2).play();
          if (prev) prev.fadeOut(0.2);
          slot.current = state;
        }
      }
    }
  }

  /** Map the simulation's action and speed to a state with a clip. */
  private pickState(i: number, c: Creatures, clips: Clips): string {
    const speed = c.speed[i];
    const action = c.action[i];
    let state = 'idle';
    if (action === Action.Die) state = 'die';
    else if (action === Action.Hunt && speed < 0.2) state = 'bite';
    else if (speed > 3.5) state = 'run';
    else if (speed > 0.15) state = 'walk';
    else if (action === Action.Rest) state = 'rest';
    if (!clips[state as keyof Clips]) state = 'idle';
    return state;
  }

  /** Advance every visible mixer. */
  update(dt: number): void {
    for (const pool of this.pools.values()) {
      for (const slot of pool) if (slot.root.visible) slot.mixer.update(dt);
    }
  }

  /** Creature slots drawn this frame by the skinned layer. */
  consumed(): Set<number> {
    return this.taken;
  }

  beginFrame(): void {
    this.taken.clear();
  }

  dispose(): void {
    for (const pool of this.pools.values()) {
      for (const slot of pool) {
        slot.mixer.stopAllAction();
        this.group.remove(slot.root);
      }
    }
    this.pools.clear();
    this.defs.clear();
  }
}

/**
 * A death clip for a rig that has none: the body rolls onto its side about the
 * forward (+Z) axis and sinks a little into the ground, then holds. The rig's
 * root bone is named `bone`; its children (legs, head, tail) follow it.
 */
export function addDeathClip(animations: THREE.AnimationClip[], bone: string, duration = 0.9): void {
  if (animations.some((a) => a.name === 'Death')) return;
  const times = [0, duration];
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const start = new THREE.Quaternion();
  const end = start.clone().multiply(roll);
  const rot = new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, [
    start.x, start.y, start.z, start.w,
    end.x, end.y, end.z, end.w,
  ]);
  const pos = new THREE.VectorKeyframeTrack(`${bone}.position`, times, [0, 0.193, 0, 0, 0.12, 0]);
  animations.push(new THREE.AnimationClip('Death', duration, [rot, pos]));
}
