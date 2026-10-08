/**
 * Screen-space overlay: world-anchored labels, the brush ring, fire and kill
 * markers, a scale bar and a compass. It is a 2D canvas above the WebGL view,
 * so it costs nothing when there is nothing to say.
 */
import * as THREE from 'three';
import { clamp } from '../core/math';
import { SPECIES } from '../life/species';
import { Action } from '../life/organism';
import type { World } from '../world/world';
import type { WorldRenderer } from './renderer';

export interface OverlayState {
  selectedId: number | null;
  followId: number | null;
  brush: { x: number; y: number; radius: number; valid: boolean } | null;
  showLabels: boolean;
  documentaries: boolean;
}

const MARKER_TTL = 12;

export class Overlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 1;
  private height = 1;
  private project = new THREE.Vector3();
  private accum = 0;
  private markers: { x: number; y: number; kind: 'fire' | 'kill' | 'birth' | 'death' | 'water'; ttl: number; label: string }[] = [];
  private lastEventId = 0;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'overlay-canvas';
    container.append(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D overlay context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect?.width ?? window.innerWidth));
    this.height = Math.max(1, Math.floor(rect?.height ?? window.innerHeight));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
  }

  /** World → screen pixels, or null when behind the camera. */
  private toScreen(world: World, camera: THREE.Camera, x: number, y: number, height = 0): { x: number; y: number } | null {
    const ground = world.terrain.elevationAtWorld(x, y);
    this.project.set(x, ground + height, y).project(camera);
    if (this.project.z > 1) return null;
    return {
      x: (this.project.x * 0.5 + 0.5) * this.width,
      y: (-this.project.y * 0.5 + 0.5) * this.height,
    };
  }

  update(world: World, renderer: WorldRenderer, state: OverlayState, dt: number): void {
    // Consume new notable events as transient world markers.
    const events = world.history.events;
    for (let i = events.length - 1; i >= 0 && i > events.length - 40; i--) {
      const e = events[i];
      if (e.id <= this.lastEventId) break;
      if (e.x === undefined || e.y === undefined || (e.x === 0 && e.y === 0)) continue;
      const kind: 'fire' | 'kill' | 'birth' | 'death' | 'water' =
        e.kind === 'hunt' ? 'kill' : e.kind === 'birth' ? 'birth' : e.kind === 'death' ? 'death' : e.kind === 'disaster' ? 'fire' : 'water';
      if (e.kind === 'hunt' || e.kind === 'disaster' || e.kind === 'disease' || e.kind === 'birth') {
        this.markers.push({ x: e.x, y: e.y, kind, ttl: MARKER_TTL, label: e.title });
        if (this.markers.length > 24) this.markers.shift();
      }
    }
    this.lastEventId = events.length ? events[events.length - 1].id : this.lastEventId;

    this.accum += dt;
    if (this.accum < 1 / 30) return;
    this.accum = 0;
    this.draw(world, renderer, state, dt);
  }

  private draw(world: World, renderer: WorldRenderer, state: OverlayState, dt: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const camera = renderer.rig.camera;
    const c = world.creatures;

    // Transient markers first, so labels sit on top.
    for (const m of this.markers) {
      m.ttl -= dt;
      if (m.ttl <= 0) continue;
      const p = this.toScreen(world, camera, m.x, m.y, 1);
      if (!p) continue;
      const alpha = clamp(m.ttl / 3, 0, 1) * 0.94;
      ctx.globalAlpha = alpha;
      const colour = m.kind === 'fire' ? '#c8873c' : m.kind === 'kill' ? '#b4634a' : m.kind === 'birth' ? '#7fa26a' : '#8fa3b0';
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.4;
      const r = 7;
      ctx.beginPath();
      if (m.kind === 'fire') {
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r * 0.7, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r * 0.7, p.y);
        ctx.closePath();
      } else {
        ctx.moveTo(p.x - r, p.y - r);
        ctx.lineTo(p.x + r, p.y + r);
        ctx.moveTo(p.x + r, p.y - r);
        ctx.lineTo(p.x - r, p.y + r);
      }
      ctx.stroke();
      if (m.ttl > MARKER_TTL - 6) {
        ctx.fillStyle = 'rgba(12,15,18,0.72)';
        const text = m.label.slice(0, 42);
        ctx.font = '11px ui-monospace, monospace';
        const w = ctx.measureText(text).width + 10;
        ctx.fillRect(p.x + 10, p.y - 16, w, 16);
        ctx.fillStyle = colour;
        ctx.fillText(text, p.x + 15, p.y - 4);
      }
    }
    this.markers = this.markers.filter((m) => m.ttl > 0);
    ctx.globalAlpha = 1;

    // Brush ring for the armed sandbox tool.
    if (state.brush) {
      const p = this.toScreen(world, camera, state.brush.x, state.brush.y, 0.4);
      if (p) {
        const edge = this.toScreen(world, camera, state.brush.x + state.brush.radius, state.brush.y, 0.4);
        const r = edge ? Math.max(6, Math.hypot(edge.x - p.x, edge.y - p.y)) : 20;
        ctx.strokeStyle = state.brush.valid ? 'rgba(200,135,60,0.85)' : 'rgba(180,99,74,0.9)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (state.showLabels) {
      const labels: { id: number; x: number; y: number; title: string; sub: string; hot: boolean }[] = [];
      const followed = state.followId !== null ? c.findByLivingId(state.followId) : -1;
      if (followed >= 0) {
        const sp = SPECIES[c.speciesIdx[followed]];
        labels.push({
          id: state.followId as number,
          x: c.x[followed],
          y: c.y[followed],
          title: `${sp.name} #${c.id[followed]}`,
          sub: `${Action[c.action[followed]]} · hp ${(c.health[followed] * 100).toFixed(0)}% · ${c.ageDays[followed] / 365 < 1 ? `${Math.round(c.ageDays[followed])} d` : `${(c.ageDays[followed] / 365).toFixed(1)} y`}`,
          hot: true,
        });
      }
      // Nearby notable animals: the ones whose lives are worth watching.
      const camX = camera.position.x;
      const camY = camera.position.z;
      const radius = clamp(renderer.rig.distance * 0.5, 26, 140);
      const scratch = c.grid.queryRadius(camX, camY, radius, c.scratch);
      const limit = renderer.rig.distance < 90 ? 8 : 4;
      for (let i = 0; i < scratch && labels.length < limit; i++) {
        const slot = c.scratch[i];
        if (!c.alive[slot] || slot === followed) continue;
        const sp = SPECIES[c.speciesIdx[slot]];
        const action = Action[c.action[slot]];
        const notable = action === 'Hunt' || action === 'Flee' || action === 'Court' || action === 'Mate' || action === 'Scavenge' || sp.massKg > 200;
        if (!notable && Math.random() > 0.35) continue;
        labels.push({
          id: c.id[slot],
          x: c.x[slot],
          y: c.y[slot],
          title: sp.name,
          sub: action,
          hot: false,
        });
      }
      ctx.font = '11px ui-monospace, monospace';
      for (const l of labels) {
        const p = this.toScreen(world, camera, l.x, l.y, 1.4);
        if (!p || p.x < -40 || p.y < -20 || p.x > this.width + 40 || p.y > this.height + 20) continue;
        const dist = Math.hypot(camera.position.x - l.x, camera.position.z - l.y);
        const fade = clamp(1 - dist / (renderer.rig.distance * 1.9), 0.15, 1);
        ctx.globalAlpha = l.hot ? 1 : fade * 0.92;
        const titleW = ctx.measureText(l.title).width;
        const subW = ctx.measureText(l.sub).width;
        const w = Math.max(titleW, subW) + 12;
        ctx.fillStyle = l.hot ? 'rgba(20,16,10,0.82)' : 'rgba(12,15,18,0.62)';
        ctx.fillRect(p.x - w / 2, p.y - 26, w, 22);
        ctx.strokeStyle = l.hot ? 'rgba(200,135,60,0.8)' : 'rgba(120,132,140,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x - w / 2, p.y - 26, w, 22);
        ctx.fillStyle = l.hot ? '#f0dcbc' : 'rgba(226,222,214,0.92)';
        ctx.textAlign = 'center';
        ctx.fillText(l.title, p.x, p.y - 14);
        ctx.fillStyle = 'rgba(154,163,169,0.92)';
        ctx.fillText(l.sub, p.x, p.y - 7);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x, p.y + 5);
        ctx.strokeStyle = l.hot ? 'rgba(200,135,60,0.85)' : 'rgba(120,132,140,0.4)';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    this.drawInstruments(world, renderer, camera);
  }

  private drawInstruments(world: World, renderer: WorldRenderer, camera: THREE.Camera): void {
    const ctx = this.ctx;
    // Scale bar: pick a round metric length that fits ~110 px.
    const margin = 16;
    const origin = this.toScreen(world, camera, camera.position.x, camera.position.z, 0);
    const ahead = this.toScreen(world, camera, camera.position.x + 40, camera.position.z, 0);
    if (origin && ahead) {
      const pxPerMetre = Math.abs(ahead.x - origin.x) / 40;
      const targets = [5, 10, 20, 50, 100, 200, 500, 1000];
      let chosen = targets[0];
      for (const t of targets) if (t * pxPerMetre <= 130) chosen = t;
      const px = chosen * pxPerMetre;
      const y = this.height - margin;
      ctx.strokeStyle = 'rgba(226,222,214,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(margin + px, y);
      ctx.moveTo(margin, y - 4);
      ctx.lineTo(margin, y + 4);
      ctx.moveTo(margin + px, y - 4);
      ctx.lineTo(margin + px, y + 4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(226,222,214,0.85)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`, margin + px + 8, y + 4);
    }

    // Compass: north is -Z in world space.
    const cx = this.width - 42;
    const cy = 42;
    const dir = new THREE.Vector3(-camera.matrixWorld.elements[8], 0, -camera.matrixWorld.elements[10]);
    const angle = Math.atan2(dir.x, dir.z);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(226,222,214,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(200,135,60,0.9)';
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(226,222,214,0.8)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - 20);
    ctx.textAlign = 'left';

    // Time-of-day tint marker in the corner (a small sun arc).
    const hour = world.clock.hour;
    const arcX = this.width - 118;
    const arcY = 42;
    ctx.strokeStyle = 'rgba(226,222,214,0.28)';
    ctx.beginPath();
    ctx.arc(arcX, arcY + 8, 14, Math.PI, Math.PI * 2);
    ctx.stroke();
    const a = Math.PI + (hour / 24) * Math.PI;
    ctx.fillStyle = 'rgba(200,135,60,0.95)';
    ctx.beginPath();
    ctx.arc(arcX + Math.cos(a) * 14, arcY + 8 + Math.sin(a) * 14, 2.6, 0, Math.PI * 2);
    ctx.fill();
    void renderer;
  }

  dispose(): void {
    this.canvas.remove();
  }
}
