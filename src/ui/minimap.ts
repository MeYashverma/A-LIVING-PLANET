import type { World } from '../world/world';

/**
 * Minimap with compass. The terrain is drawn once per world into an offscreen
 * canvas (sampled from the height field, water tinted), then each HUD update only
 * redraws the focus marker and the heading arrow. Cheap enough to run every frame
 * the HUD updates, and nothing in it depends on the window size: the canvas is
 * a fixed CSS size and scales with the UI scale variable.
 */
export class Minimap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private baseWorld: World | null = null;
  private compassLabel: HTMLElement;
  private coordsLabel: HTMLElement;
  private readonly px = 160;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'minimap';
    this.root.className = 'hud-minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.px;
    this.canvas.height = this.px;
    this.canvas.className = 'minimap-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.base.width = this.px;
    this.base.height = this.px;
    this.compassLabel = document.createElement('div');
    this.compassLabel.className = 'minimap-compass';
    this.coordsLabel = document.createElement('div');
    this.coordsLabel.className = 'minimap-coords mono';
    this.root.append(this.canvas, this.compassLabel, this.coordsLabel);
    // The HUD mounts this inside the dock row (see hud.ts), so it never sits over the side panels.
  }

  /**
   * Compass bearing of the camera's view direction. The camera looks along
   * (cos yaw, sin yaw) in world x/z; north is -z (top of the map), east is +x.
   */
  static cardinal(yaw: number): string {
    const deg = (Math.atan2(Math.cos(yaw), -Math.sin(yaw)) * 180) / Math.PI;
    const d = (deg + 360) % 360;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return `${names[Math.round(d / 45) % 8]} ${Math.round(d)}°`;
  }

  private bakeTerrain(world: World): void {
    const t = world.terrain;
    const h = t.height;
    const n = h.size;
    const ctx = this.base.getContext('2d')!;
    const img = ctx.createImageData(this.px, this.px);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < h.data.length; i++) {
      const v = h.data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = Math.max(1e-6, hi - lo);
    const water = (t.params.seaLevel ?? lo) as number;
    for (let py = 0; py < this.px; py++) {
      for (let px = 0; px < this.px; px++) {
        const cx = Math.min(n - 1, Math.floor((px / this.px) * n));
        const cy = Math.min(n - 1, Math.floor((py / this.px) * n));
        const v = h.data[cy * n + cx];
        const k = (py * this.px + px) * 4;
        const shade = (v - lo) / span;
        if (v < water) {
          const depth = Math.min(1, (water - v) / span * 4);
          img.data[k] = 24 + 20 * (1 - depth);
          img.data[k + 1] = 70 + 40 * (1 - depth);
          img.data[k + 2] = 120 + 60 * (1 - depth);
        } else {
          img.data[k] = 70 + 110 * shade;
          img.data[k + 1] = 100 + 90 * shade;
          img.data[k + 2] = 58 + 60 * shade;
        }
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.baseWorld = world;
  }

  /** Redraw for the current camera. `focus` is in world units, `yaw` in radians. */
  update(world: World, focus: { x: number; z: number }, yaw: number): void {
    if (this.baseWorld !== world) this.bakeTerrain(world);
    const ctx = this.ctx;
    const half = world.terrain.half;
    ctx.drawImage(this.base, 0, 0);
    // Focus marker, mapped from world x/z to canvas.
    const mx = ((focus.x + half) / (2 * half)) * this.px;
    const my = ((focus.z + half) / (2 * half)) * this.px;
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mx, my, 4, 0, Math.PI * 2);
    ctx.stroke();
    // Heading arrow from the focus marker.
    ctx.fillStyle = '#ffd27a';
    ctx.beginPath();
    // Canvas x follows world x and canvas y follows world z (north is up).
    const dx = Math.cos(yaw);
    const dy = Math.sin(yaw);
    ctx.moveTo(mx + dx * 12, my + dy * 12);
    ctx.lineTo(mx - dy * 4, my + dx * 4);
    ctx.lineTo(mx + dy * 4, my - dx * 4);
    ctx.closePath();
    ctx.fill();
    // Compass rose: the map is north-up, so the N needle is fixed.
    const cx = this.px - 14;
    const cy = 14;
    ctx.fillStyle = 'rgba(12,16,20,0.7)';
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff7a6b';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx - 3.5, cy + 1);
    ctx.lineTo(cx + 3.5, cy + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e8e2d0';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', cx, cy + 6);
    this.compassLabel.textContent = Minimap.cardinal(yaw);
    this.coordsLabel.textContent = `${Math.round(focus.x)}, ${Math.round(focus.z)}`;
  }
}
