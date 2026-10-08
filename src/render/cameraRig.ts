import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, TAU, wrapAngle } from '../core/math';
import { SPECIES } from '../life/species';
import type { World } from '../world/world';

export type CameraMode = 'free' | 'follow' | 'cinematic' | 'overhead' | 'organism';

export type ScaleLevel = 'planet' | 'region' | 'local' | 'organism' | 'micro';

const SCALE_DISTANCE: Record<ScaleLevel, number> = {
  planet: 900,
  region: 300,
  local: 110,
  organism: 16,
  micro: 4.5,
};

interface Shot {
  kind: 'orbit' | 'follow' | 'establish' | 'event';
  targetId?: number;
  x: number;
  y: number;
  distance: number;
  height: number;
  yaw: number;
  duration: number;
  elapsed: number;
}

/**
 * The camera. Handles free flight, following an animal, the cinematic director
 * and the overhead map view, with smooth transitions between all of them.
 * Cinematic mode watches whatever the simulation currently considers
 * interesting — a hunt, a fire, a migration — rather than a fixed tour.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'free';
  focus = new THREE.Vector3(0, 0, 0);
  distance = 220;
  yaw = 0.6;
  pitch = 0.85;
  private targetDistance = 220;
  private targetYaw = 0.6;
  private targetPitch = 0.85;
  private targetFocus = new THREE.Vector3();
  private shake = 0;
  private shot: Shot | null = null;
  private shotTimer = 0;
  private transition = 0;
  private lastSubject: { id: number; kind: string } | null = null;
  followId: number | null = null;
  private followOffset = new THREE.Vector3(0, 2, 0);
  private cinematicPaused = false;
  private skyFollowNeeded = true;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.35, 6000);
    this.camera.position.set(0, 200, 400);
    this.camera.lookAt(0, 0, 0);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Switch mode. Transitions are eased rather than cut. */
  setMode(mode: CameraMode, world: World, subjectId: number | null = null): void {
    if (mode === this.mode && mode !== 'follow') return;
    this.mode = mode;
    this.transition = 1;
    if (mode === 'follow' && subjectId !== null) {
      this.followId = subjectId;
      this.trackSubject(world, subjectId, 34);
    } else if (mode === 'cinematic') {
      this.shot = null;
      this.shotTimer = 0;
    } else if (mode === 'overhead') {
      this.targetDistance = 620;
      this.targetPitch = Math.PI / 2 - 0.02;
      const focus = this.focusInto(world);
      this.targetFocus.copy(focus);
    }
  }

  private focusInto(world: World): THREE.Vector3 {
    const t = world.terrain;
    const limit = t.half * 0.92;
    return new THREE.Vector3(
      clamp(this.focus.x, -limit, limit),
      t.elevationAtWorld(clamp(this.focus.x, -limit, limit), clamp(this.focus.z, -limit, limit)),
      clamp(this.focus.z, -limit, limit),
    );
  }

  /** Point the camera at a specific animal and keep it framed. */
  trackSubject(world: World, id: number, distance = 26): void {
    const slot = world.creatures.findByLivingId(id);
    if (slot < 0) return;
    const c = world.creatures;
    const sp = SPECIES[c.speciesIdx[slot]];
    this.followId = id;
    this.targetFocus.set(c.x[slot], c.z[slot] + sp.bodyLength * 0.4, c.y[slot]);
    this.targetDistance = clamp(Math.max(distance, sp.bodyLength * 3.2), 3, 500);
    this.targetPitch = sp.locomotion === 'bird' ? 0.55 : 1.15;
  }

  /** Jump to a scale level, keeping the current focus point. */
  /** Frame a wide establishing view without changing the camera mode. */
  openWide(distance: number, pitch: number): void {
    this.distance = distance;
    this.targetDistance = distance;
    this.pitch = pitch;
    this.targetPitch = pitch;
  }

  setScale(level: ScaleLevel, world: World): void {
    this.mode = 'free';
    this.transition = 1;
    this.targetDistance = SCALE_DISTANCE[level];
    this.targetFocus.copy(this.focusInto(world));
    if (level === 'organism' || level === 'micro') this.targetPitch = 1.42;
    else if (level === 'planet') this.targetPitch = 1.18;
    else this.targetPitch = 1.0;
  }

  /** Cinematic director: choose what to watch next. */
  private nextShot(world: World): void {
    const rng = world.rng;
    const roll = rng.next();
    const subject = this.pickSubject(world);
    if (subject && roll < 0.45) {
      this.shot = { kind: 'follow', targetId: subject.id, x: subject.x, y: subject.y, distance: subject.distance, height: 0, yaw: this.yaw, duration: rng.range(22, 46), elapsed: 0 };
    } else if (subject && roll < 0.62) {
      this.shot = { kind: 'orbit', targetId: subject.id, x: subject.x, y: subject.y, distance: subject.distance * 1.6, height: rng.range(4, 20), yaw: this.yaw, duration: rng.range(18, 32), elapsed: 0 };
    } else if (roll < 0.8) {
      // Establishing shot: sweep a wide view of the region.
      const focus = this.pickInterestingPlace(world);
      this.shot = { kind: 'establish', x: focus.x, y: focus.y, distance: rng.range(180, 420), height: rng.range(30, 120), yaw: rng.range(0, TAU), duration: rng.range(16, 30), elapsed: 0 };
    } else {
      const ev = this.pickEvent(world);
      if (ev) {
        this.shot = { kind: 'event', x: ev.x, y: ev.y, distance: rng.range(30, 90), height: rng.range(6, 26), yaw: rng.range(0, TAU), duration: rng.range(14, 24), elapsed: 0 };
      } else {
        this.shot = { kind: 'establish', x: this.focus.x, y: this.focus.z, distance: 320, height: 60, yaw: rng.range(0, TAU), duration: 20, elapsed: 0 };
      }
    }
    if (this.shot) {
      this.lastSubject = { id: this.shot.targetId ?? -1, kind: this.shot.kind };
    }
  }

  /** Score animals by how interesting they are to watch right now. */
  private pickSubject(world: World): { id: number; x: number; y: number; distance: number } | null {
    const c = world.creatures;
    const candidates: { id: number; score: number; x: number; y: number; dist: number }[] = [];
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const sp = SPECIES[c.speciesIdx[i]];
      let score = 0;
      const urgency = clamp01(c.urgency[i]);
      score += urgency * 3;
      score += c.groupId[i] >= 0 ? 0.6 : 0;
      score += sp.massKg > 60 ? 1.4 : sp.massKg > 12 ? 0.8 : 0.2;
      if (c.infection[i] === 1) score += 0.6;
      const hunted = c.pursuitId[i] >= 0 ? 1.6 : 0;
      score += hunted;
      const isCalf = c.ageDays[i] / 365 < sp.maturityYears ? 0.4 : 0;
      score += isCalf;
      const rate = score * world.rng.range(0.5, 1.5);
      const dist = Math.hypot(c.x[i] - this.focus.x, c.y[i] - this.focus.z);
      candidates.push({ id: c.id[i], score: rate, x: c.x[i], y: c.y[i], dist });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[world.rng.int(0, Math.min(6, candidates.length - 1))];
    const sp = SPECIES[c.speciesIdx[c.findByLivingId(pick.id)]];
    return { id: pick.id, x: pick.x, y: pick.y, distance: clamp(sp.bodyLength * 6, 8, 120) };
  }

  private pickInterestingPlace(world: World): { x: number; y: number } {
    // Prefer water, fire, or a herd.
    if (world.fire.fronts.length && world.rng.chance(0.5)) {
      const f = world.fire.fronts[world.rng.int(0, world.fire.fronts.length - 1)];
      return { x: f.x, y: f.y };
    }
    const lakes = world.terrain.lakes;
    if (lakes.length) {
      const lake = lakes[world.rng.int(0, lakes.length - 1)];
      return { x: lake.x, y: lake.y };
    }
    const t = world.terrain;
    const cx = world.rng.int(4, t.size - 5);
    const cy = world.rng.int(4, t.size - 5);
    return { x: t.cellToWorldX(cx), y: t.cellToWorldY(cy) };
  }

  private pickEvent(world: World): { x: number; y: number } | null {
    const withPos = world.history.events.filter((e) => Math.abs(e.x ?? 0) > 0.001 || Math.abs(e.y ?? 0) > 0.001);
    if (!withPos.length) return null;
    const recent = withPos.slice(-6);
    const ev = recent[world.rng.int(0, recent.length - 1)];
    if (!ev) return null;
    return { x: ev.x ?? 0, y: ev.y ?? 0 };
  }

  /** Input handlers (called by the input layer). */
  orbit(dx: number, dy: number): void {
    this.mode = 'free';
    this.targetYaw = wrapAngle(this.targetYaw - dx * 0.005);
    this.targetPitch = clamp(this.targetPitch + dy * 0.004, 0.08, 1.52);
  }

  pan(dx: number, dy: number, world: World): void {
    this.mode = 'free';
    const speed = this.targetDistance * 0.0016;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    this.targetFocus.x += (-dx * sin - dy * cos) * speed;
    this.targetFocus.z += (dx * cos - dy * sin) * speed;
    const limit = world.terrain.half * 0.95;
    this.targetFocus.x = clamp(this.targetFocus.x, -limit, limit);
    this.targetFocus.z = clamp(this.targetFocus.z, -limit, limit);
  }

  zoom(delta: number, world: World): void {
    // Exponential step: one wheel notch (delta ~0.25) is about a 28% change in
    // distance. The old 1.0016^delta form changed distance by ~0.04% per notch,
    // so the wheel did almost nothing.
    this.targetDistance = clamp(this.targetDistance * Math.exp(delta), 3.5, 1400);
    const limit = world.terrain.half * 0.95;
    this.targetFocus.x = clamp(this.targetFocus.x, -limit, limit);
    this.targetFocus.z = clamp(this.targetFocus.z, -limit, limit);
  }

  /** Keyboard flight relative to the camera's heading. */
  moveInput(forward: number, strafe: number, world: World, dt: number): void {
    if (forward === 0 && strafe === 0) return;
    const speed = clamp(this.distance * 0.9, 12, 420) * dt;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    // The camera sits at focus - (cos, sin) * distance, so the view direction is
    // (cos, sin) and screen-right is (-sin, cos). Forward and strafe must use
    // those; they were swapped, which made W slide sideways and D run forward.
    this.targetFocus.x += (cos * forward - sin * strafe) * speed;
    this.targetFocus.z += (sin * forward + cos * strafe) * speed;
    const limit = world.terrain.half * 0.95;
    this.targetFocus.x = clamp(this.targetFocus.x, -limit, limit);
    this.targetFocus.z = clamp(this.targetFocus.z, -limit, limit);
    if (forward !== 0 || strafe !== 0) this.mode = this.mode === 'cinematic' ? 'cinematic' : 'free';
  }

  /** Smoothly move the camera to a specific point of interest. */
  glideTo(x: number, y: number, distance: number): void {
    this.targetFocus.set(x, 0, y);
    this.targetDistance = distance;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.6, this.shake + amount);
  }

  get zoomDistance(): number {
    return this.distance;
  }

  get currentSubjectId(): number | null {
    if (this.mode === 'follow') return this.followId;
    if (this.mode === 'cinematic' && this.shot?.targetId) return this.shot.targetId;
    return null;
  }

  update(world: World, dt: number, reducedMotion: boolean): void {
    const t = world.terrain;
    if (this.mode === 'cinematic' && !this.cinematicPaused) {
      this.shotTimer -= dt;
      if (!this.shot || this.shotTimer <= 0) {
        this.nextShot(world);
        this.shotTimer = this.shot ? this.shot.duration : 10;
        this.transition = 1;
      }
      if (this.shot) {
        this.shot.elapsed += dt;
        if (this.shot.kind === 'follow' && this.shot.targetId) {
          const slot = world.creatures.findByLivingId(this.shot.targetId);
          if (slot >= 0) {
            const c = world.creatures;
            const sp = SPECIES[c.speciesIdx[slot]];
            this.shot.x = c.x[slot];
            this.shot.y = c.y[slot];
            this.targetFocus.set(c.x[slot], c.z[slot] + sp.bodyLength * 0.35, c.y[slot]);
            this.targetDistance = this.shot.distance;
            this.targetPitch = clamp(1.3 - c.speed[slot] / Math.max(1, sp.runSpeed) * 0.5, 0.5, 1.45);
            // Keep a trailing angle behind the animal's heading.
            this.targetYaw = wrapAngle(-c.heading[slot] + Math.PI * 0.5 + Math.sin(this.shot.elapsed * 0.06) * 0.6);
          } else {
            this.shotTimer = 0;
          }
        } else if (this.shot.kind === 'orbit') {
          this.targetYaw = this.shot.yaw + this.shot.elapsed * 0.09;
          this.targetFocus.set(this.shot.x, t.elevationAtWorld(this.shot.x, this.shot.y) + this.shot.height * 0.4, this.shot.y);
          this.targetDistance = this.shot.distance;
          this.targetPitch = 1.05;
        } else {
          this.targetFocus.set(this.shot.x, t.elevationAtWorld(this.shot.x, this.shot.y) + this.shot.height * 0.35, this.shot.y);
          this.targetDistance = this.shot.distance;
          this.targetYaw = this.shot.yaw + this.shot.elapsed * 0.02;
          this.targetPitch = 1.05;
        }
      }
      this.transition = Math.max(0, this.transition - dt * 0.8);
    }

    if (this.mode === 'follow' && this.followId !== null) {
      const slot = world.creatures.findByLivingId(this.followId);
      if (slot >= 0) {
        const c = world.creatures;
        const sp = SPECIES[c.speciesIdx[slot]];
        this.targetFocus.set(c.x[slot], c.z[slot] + sp.bodyLength * 0.4, c.y[slot]);
        this.targetDistance = clamp(Math.max(this.targetDistance, sp.bodyLength * 2.6), 3, 400);
        // Trail behind the animal's heading.
        const desiredYaw = wrapAngle(-c.heading[slot] + Math.PI * 0.5);
        this.targetYaw = wrapAngle(this.targetYaw + wrapAngle(desiredYaw - this.targetYaw) * Math.min(1, dt * 2.2));
      }
    }

    // Ease everything toward its target.
    const ease = this.transition > 0 ? Math.min(1, dt * 3.0) : Math.min(1, dt * 5.5);
    this.distance = lerp(this.distance, this.targetDistance, ease);
    this.yaw = wrapAngle(this.yaw + wrapAngle(this.targetYaw - this.yaw) * ease);
    this.pitch = lerp(this.pitch, this.targetPitch, ease);
    this.focus.x = lerp(this.focus.x, this.targetFocus.x, ease);
    this.focus.y = lerp(this.focus.y, this.targetFocus.y, ease);
    this.focus.z = lerp(this.focus.z, this.targetFocus.z, ease);

    // Keep the camera above the terrain.
    const groundY = t.elevationAtWorld(this.focus.x, this.focus.z);
    const minHeight = groundY + 1.4;
    const camX = this.focus.x - Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance;
    const camZ = this.focus.z - Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance;
    let camY = this.focus.y + Math.sin(this.pitch) * this.distance;
    const camGround = t.elevationAtWorld(camX, camZ) + 1.2;
    if (camY < camGround) camY = camGround;
    if (camY < minHeight) camY = minHeight;

    // Subtle handheld drift for cinematic/organism views.
    const drift = reducedMotion ? 0 : this.mode === 'cinematic' || this.mode === 'organism' ? 1 : 0.25;
    const time = world.clock.minutes * 0.01;
    const shake = this.shake;
    this.shake = Math.max(0, this.shake - dt * 1.4);
    this.camera.position.set(
      camX + Math.sin(time * 0.7) * 0.28 * drift + (Math.random() - 0.5) * shake * 1.4,
      camY + Math.sin(time * 0.43) * 0.22 * drift + (Math.random() - 0.5) * shake * 1.4,
      camZ + Math.cos(time * 0.61) * 0.28 * drift + (Math.random() - 0.5) * shake * 1.4,
    );
    const look = this.focus.clone();
    look.y += smoothstep(0, 1, this.pitch) * 0.5;
    this.camera.lookAt(look);
    this.skyFollowNeeded = true;
  }

  /** Ray-cast from a screen position to the terrain surface (for tools/picking). */
  screenToGround(world: World, ndcX: number, ndcY: number): THREE.Vector3 | null {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    dir.set(ndcX, ndcY, 0.5).unproject(this.camera).sub(origin).normalize();
    const maxDist = this.distance * 4 + 2000;
    let prev = 0;
    let step = 4;
    const p = new THREE.Vector3();
    for (let d = 0; d < maxDist; d += step) {
      p.copy(origin).addScaledVector(dir, d);
      const ground = world.terrain.elevationAtWorld(p.x, p.z);
      if (p.y <= ground) {
        // Refine between prev and d.
        let lo = prev;
        let hi = d;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) / 2;
          p.copy(origin).addScaledVector(dir, mid);
          if (p.y <= world.terrain.elevationAtWorld(p.x, p.z)) hi = mid;
          else lo = mid;
        }
        p.copy(origin).addScaledVector(dir, hi);
        return p.clone();
      }
      prev = d;
      step = Math.min(24, step * 1.06);
      if (Math.abs(p.x) > world.terrain.half * 1.5 && Math.abs(p.z) > world.terrain.half * 1.5) break;
    }
    return null;
  }

  /** Which animal is under this screen point (if any)? */
  pickOrganism(world: World, ndcX: number, ndcY: number, maxDistance = 200): number | null {
    const c = world.creatures;
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    dir.set(ndcX, ndcY, 0.5).unproject(this.camera).sub(origin).normalize();
    let best: { id: number; score: number } | null = null;
    const camPos = this.camera.position;
    for (let i = 0; i < c.capacity; i++) {
      if (!c.alive[i]) continue;
      const dx = c.x[i] - origin.x;
      const dz = c.y[i] - origin.z;
      const dy = c.z[i] + 1 - origin.y;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > maxDistance * 6) continue;
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / Math.max(0.001, dist);
      if (dot < 0.985) continue;
      const perp = Math.sqrt(Math.max(0, dist * dist - (dot * dist) * (dot * dist)));
      const radius = Math.max(1.2, SPECIES[c.speciesIdx[i]].bodyLength * c.bodyScale(i) * 0.9);
      if (perp > radius) continue;
      const score = perp / radius + dist / 4000;
      if (!best || score < best.score) best = { id: c.id[i], score };
    }
    void camPos;
    return best ? best.id : null;
  }

  dispose(): void {
    // nothing to dispose; ownership of the camera lies with the renderer
  }
}

export { SCALE_DISTANCE };
void smoothstep;
