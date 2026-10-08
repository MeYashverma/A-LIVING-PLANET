/*
 * Skinned, animated animals for the nearest creatures.
 *
 * Far animals are drawn as instances of a procedural mesh (creatureRenderer).
 * The closest few of a species that has its own rigged model are drawn here
 * instead, with a real skeleton. The clip is chosen from the simulation's own
 * action, speed and flying state.
 *
 * Only the fox has a rigged model. Mesh2Motion's CC0 fox rig is the only
 * animal model used, so no species shares another species' model.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Action } from '../life/organism';
import type { Creatures } from '../life/organism';

/** Simulated state to clip name, per model. */
type Clips = Partial<Record<'idle' | 'walk' | 'run' | 'rest' | 'die' | 'bite', string>>;

interface ModelDef {
  file: string;
  clips: Clips;
}

const MODELS: Record<string, ModelDef> = {
  fox: {
    file: 'assets/models/mesh2motion-fox.glb',
    clips: { idle: 'Idle', walk: 'Walk', run: 'Run', rest: 'Sit', die: 'Death', bite: 'Bite' },
  },
};

/** Species drawn with a rigged model. Every other species keeps its own procedural mesh. */
export const RIGGED_SPECIES: Record<string, string> = {
  fox: 'fox',
};

interface Slot {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<string, THREE.AnimationAction>>;
  current: string;
}

interface Loaded {
  size: THREE.Vector3;
  minY: number;
}

export class SkinnedAnimals {
  private models = new Map<string, Loaded>();
  private pools = new Map<string, Slot[]>();
  private taken = new Set<number>();

  constructor(private readonly group: THREE.Group, private readonly poolSize = 12) {}

  /** Load each model once. Species fall back to instances until their model is ready. */
  load(): void {
    const loader = new GLTFLoader();
    for (const [key, def] of Object.entries(MODELS)) {
      loader.load(
        def.file,
        (gltf) => {
          const box = new THREE.Box3().setFromObject(gltf.scene);
          this.models.set(key, { size: box.getSize(new THREE.Vector3()), minY: box.min.y });
          for (const [species, model] of Object.entries(RIGGED_SPECIES)) {
            if (model === key) this.buildPool(species, gltf, def.clips);
          }
        },
        undefined,
        (err) => console.warn(`[skinned] could not load ${def.file}`, err),
      );
    }
  }

  isReady(species: string): boolean {
    return this.pools.has(species);
  }

  private buildPool(species: string, gltf: GLTF, clipNames: Clips): void {
    const pool: Slot[] = [];
    const clips = new Map(gltf.animations.map((a) => [a.name, a] as const));
    for (let i = 0; i < this.poolSize; i++) {
      const root = SkeletonUtils.clone(gltf.scene);
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
    if (!pool) return;
    const modelKey = RIGGED_SPECIES[species];
    const model = this.models.get(modelKey);
    const def = MODELS[modelKey];
    if (!model || !def) return;
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
  }
}
