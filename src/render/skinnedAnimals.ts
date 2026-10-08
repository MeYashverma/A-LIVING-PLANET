/*
 * Skinned, animated animals for the nearest creatures.
 *
 * Far animals are drawn as instances of a procedural mesh (creatureRenderer).
 * The closest few of a species that has a rigged model are drawn here instead:
 * a real skeleton, with clips chosen from the simulation's own action and
 * speed. Only foxes have a model so far. The model is Mesh2Motion's fox
 * (CC0), see public/assets/ATTRIBUTION.md.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Action } from '../life/organism';
import type { Creatures } from '../life/organism';

interface Slot {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  current: string;
}

/** Which species have a rigged model, and the clip each simulated state plays. */
export const RIGGED_SPECIES: Record<string, { file: string; clips: Record<string, string> }> = {
  fox: {
    file: 'assets/models/mesh2motion-fox.glb',
    clips: { idle: 'Idle', walk: 'Walk', run: 'Run', rest: 'Sit', die: 'Death', bite: 'Bite' },
  },
};

export class SkinnedAnimals {
  private templates = new Map<string, GLTF>();
  private pools = new Map<string, Slot[]>();
  private taken = new Set<number>();
  private loaded = new Set<string>();
  /** Model bounds in its own units; used to scale and to sit the feet on the ground. */
  private size = new THREE.Vector3(1, 1, 1);
  private minY = 0;

  constructor(private readonly group: THREE.Group, private readonly poolSize = 12) {}

  /** Start loading every rigged species. Animals fall back to instances until ready. */
  load(): void {
    const loader = new GLTFLoader();
    for (const [key, cfg] of Object.entries(RIGGED_SPECIES)) {
      loader.load(
        cfg.file,
        (gltf) => {
          this.templates.set(key, gltf);
          this.buildPool(key, gltf, cfg.clips);
          this.loaded.add(key);
        },
        undefined,
        (err) => console.warn(`[skinned] could not load ${cfg.file}`, err),
      );
    }
  }

  isReady(key: string): boolean {
    return this.loaded.has(key);
  }

  private buildPool(key: string, gltf: GLTF, clipNames: Record<string, string>): void {
    const pool: Slot[] = [];
    const clips = new Map(gltf.animations.map((a) => [a.name, a] as const));
    const box = new THREE.Box3().setFromObject(gltf.scene);
    this.size = box.getSize(new THREE.Vector3());
    this.minY = box.min.y;
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
      const actions: Record<string, THREE.AnimationAction> = {};
      for (const [state, clipName] of Object.entries(clipNames)) {
        const clip = clips.get(clipName);
        if (clip) actions[state] = mixer.clipAction(clip);
      }
      pool.push({ root, mixer, actions, current: '' });
    }
    this.pools.set(key, pool);
  }

  /**
   * Place the nearest animals of `key` on skinned slots. `picks` are creature
   * slots already chosen by the caller; returns the creature slots it consumed,
   * so the instanced pass can skip them.
   */
  place(key: string, picks: number[], c: Creatures, bodyLength: number, heading: (i: number) => number, pos: (i: number) => THREE.Vector3): void {
    const pool = this.pools.get(key);
    if (!pool) return;
    const cfg = RIGGED_SPECIES[key];
    for (let s = 0; s < pool.length; s++) {
      const slot: Slot = pool[s];
      if (s >= picks.length) {
        slot.root.visible = false;
        continue;
      }
      const i = picks[s];
      this.taken.add(i);
      slot.root.visible = true;
      // Scale so the model's length matches the species body length.
      const modelLen = Math.max(this.size.x, this.size.z);
      const k = (bodyLength * 2.0) / modelLen;
      slot.root.scale.setScalar(k);
      const p = pos(i);
      // Feet at the creature's ground height: lift by the model's lowest point.
      slot.root.position.set(p.x, p.y - this.minY * k, p.z);
      // The model faces +Z. The instanced procedural meshes face +X and use
      // rotation.y = -heading, so this offset makes the two agree.
      slot.root.rotation.set(0, Math.PI / 2 - heading(i), 0);
      // Pick the clip from the simulated action and speed.
      const speed = c.speed[i];
      let state = 'idle';
      const action = c.action[i];
      if (action === Action.Die) state = 'die';
      else if (action === Action.Hunt && speed < 0.2) state = 'bite';
      else if (speed > 3.5) state = 'run';
      else if (speed > 0.15) state = 'walk';
      else if (action === Action.Rest) state = 'rest';
      if (!cfg.clips[state] || !slot.actions[state]) state = 'idle';
      if (slot.current !== state) {
        const next: THREE.AnimationAction = slot.actions[state];
        const prev: THREE.AnimationAction | undefined = slot.actions[slot.current];
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
