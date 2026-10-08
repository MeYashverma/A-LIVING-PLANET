import * as THREE from 'three';
import { clamp01, TAU } from '../core/math';
import { SPECIES } from '../life/species';
import { TRAIL_POINTS } from '../life/organism';
import type { World } from '../world/world';

interface LabelEntry {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  text: string;
  sub: string;
}

/**
 * What the observer sees on top of the world: the selection ring, the trail of
 * a tracked animal, its name plate, territorial boundaries, and the names of
 * places. All of it is anchored to real simulation coordinates.
 */
export class SelectionVisuals {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private ringInner: THREE.Mesh;
  private trailLine: THREE.Line;
  private trailPositions: Float32Array;
  private pointer: THREE.Mesh;
  private labels: LabelEntry[] = [];
  private territoryLines: THREE.LineSegments;
  private territoryPositions: Float32Array;
  private landmarkLabels: LabelEntry[] = [];
  private landmarkRefs: { name: string; x: number; y: number; kind: string }[] = [];
  private time = 0;

  constructor(private world: World, labelCount = 22) {
    // Selection ring: two flat rings that pulse.
    const ringGeo = new THREE.RingGeometry(0.9, 1.12, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.visible = false;
    this.ring.renderOrder = 20;
    const innerGeo = new THREE.RingGeometry(0.22, 0.3, 24);
    innerGeo.rotateX(-Math.PI / 2);
    this.ringInner = new THREE.Mesh(innerGeo, new THREE.MeshBasicMaterial({ color: 0xfff4d0, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
    this.ringInner.visible = false;
    this.ringInner.renderOrder = 20;
    this.group.add(this.ring, this.ringInner);

    // Trail of the tracked animal.
    this.trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    trailGeo.setDrawRange(0, 0);
    this.trailLine = new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    this.trailLine.frustumCulled = false;
    this.trailLine.visible = false;
    this.trailLine.renderOrder = 19;
    this.group.add(this.trailLine);

    // A pointer above the selected animal so it can be found when zoomed out.
    const pointerGeo = new THREE.ConeGeometry(0.6, 1.6, 6);
    pointerGeo.rotateZ(Math.PI);
    this.pointer = new THREE.Mesh(pointerGeo, new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85, depthWrite: false }));
    this.pointer.visible = false;
    this.pointer.renderOrder = 21;
    this.group.add(this.pointer);

    // Territory outlines.
    this.territoryPositions = new Float32Array(64 * 3 * 2);
    const terrGeo = new THREE.BufferGeometry();
    terrGeo.setAttribute('position', new THREE.BufferAttribute(this.territoryPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.territoryLines = new THREE.LineSegments(
      terrGeo,
      new THREE.LineBasicMaterial({ color: 0xd88c54, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.territoryLines.frustumCulled = false;
    this.group.add(this.territoryLines);

    for (let i = 0; i < labelCount; i++) this.labels.push(this.makeLabel());
    for (let i = 0; i < 12; i++) this.landmarkLabels.push(this.makeLabel(256, 64, 12));
    this.refreshLandmarks();
  }

  private makeLabel(width = 256, height = 64, fontSize = 22): LabelEntry {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, opacity: 0.92 });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 30;
    sprite.scale.set(6, 1.5, 1);
    this.group.add(sprite);
    return { sprite, canvas, texture, text: '', sub: '' };
  }

  private drawLabel(entry: LabelEntry, text: string, sub: string, color = '#f2ead6'): void {
    if (entry.text === text && entry.sub === sub) return;
    entry.text = text;
    entry.sub = sub;
    const ctx = entry.canvas.getContext('2d');
    if (!ctx) return;
    const w = entry.canvas.width;
    const h = entry.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.font = `600 ${Math.round(h * 0.42)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(12, 14, 12, 0.55)';
    const tw = Math.max(ctx.measureText(text).width, ctx.measureText(sub).width) + 18;
    ctx.fillRect((w - tw) / 2, h * 0.06, tw, h * 0.88);
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h * 0.34);
    ctx.font = `400 ${Math.round(h * 0.28)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(220, 214, 196, 0.8)';
    ctx.fillText(sub, w / 2, h * 0.74);
    entry.texture.needsUpdate = true;
  }

  private refreshLandmarks(): void {
    this.landmarkRefs = [];
    for (const lm of this.world.terrain.landmarks) {
      if (lm.kind === 'peak' || lm.kind === 'lake' || lm.kind === 'forest' || lm.kind === 'marsh' || lm.kind === 'plateau' || lm.kind === 'volcano') {
        this.landmarkRefs.push({ name: lm.name, x: lm.x, y: lm.y, kind: lm.kind });
      }
    }
    for (const lm of this.world.terrain.lakes) {
      this.landmarkRefs.push({ name: lm.name, x: lm.x, y: lm.y, kind: 'lake' });
    }
    this.landmarkRefs = this.landmarkRefs.slice(0, this.landmarkLabels.length);
  }

  update(cameraPos: THREE.Vector3, cameraZoom: number, selectedId: number | null, dt: number, showTrails: boolean, showLabels: boolean): void {
    this.time += dt;
    const world = this.world;
    const c = world.creatures;
    const slot = selectedId !== null ? c.findByLivingId(selectedId) : -1;
    const pulse = 0.85 + Math.sin(this.time * 2.4) * 0.15;

    if (slot >= 0) {
      const sp = SPECIES[c.speciesIdx[slot]];
      const scale = Math.max(1.4, sp.bodyLength * c.bodyScale(slot) * 1.4);
      const y = c.z[slot] + 0.06;
      this.ring.visible = true;
      this.ringInner.visible = true;
      this.ring.position.set(c.x[slot], y, c.y[slot]);
      this.ring.scale.setScalar(scale * pulse);
      this.ringInner.position.set(c.x[slot], y, c.y[slot]);
      this.ringInner.scale.setScalar(scale * (2.0 - pulse * 1.0));
      this.pointer.visible = true;
      this.pointer.position.set(c.x[slot], c.z[slot] + scale * 3.4 + 2.2, c.y[slot]);
      this.pointer.scale.setScalar(1.2);
      this.pointer.rotation.y = this.time * 0.9;
      (this.pointer.material as THREE.MeshBasicMaterial).opacity = clamp01(1.2 - cameraZoom / 400) * 0.9;
    } else {
      this.ring.visible = false;
      this.ringInner.visible = false;
      this.pointer.visible = false;
    }

    // Trail of the selected animal.
    if (slot >= 0 && showTrails) {
      const base = slot * TRAIL_POINTS;
      const fresh: { x: number; y: number; age: number }[] = [];
      for (let k = 0; k < TRAIL_POINTS; k++) {
        const age = c.trailAge[base + k];
        if (age > 0) fresh.push({ x: c.trailX[base + k], y: c.trailY[base + k], age });
      }
      if (fresh.length > 1) {
        // Oldest first so the line reads as a path.
        fresh.sort((a, b) => b.age - a.age);
        const pos = this.trailPositions;
        for (let i = 0; i < fresh.length; i++) {
          const p = fresh[i];
          pos[i * 3] = p.x;
          pos[i * 3 + 1] = world.terrain.elevationAtWorld(p.x, p.y) + 0.25;
          pos[i * 3 + 2] = p.y;
        }
        this.trailLine.geometry.setDrawRange(0, fresh.length);
        (this.trailLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        this.trailLine.visible = true;
      } else {
        this.trailLine.visible = false;
      }
    } else {
      this.trailLine.visible = false;
    }

    // Name plates for notable nearby animals.
    let labelIndex = 0;
    if (showLabels && labelIndex < this.labels.length) {
      const maxDist = 90 + cameraZoom * 0.25;
      const candidates: { slot: number; d: number }[] = [];
      for (let i = 0; i < c.capacity && candidates.length < 60; i++) {
        if (!c.alive[i]) continue;
        const sp = SPECIES[c.speciesIdx[i]];
        // Label the big or interesting animals, and anything the player tracks.
        const interest = sp.massKg > 8 || c.groupId[i] >= 0 || c.id[i] === selectedId ? 1 : 0.35;
        if (interest < 0.5) continue;
        const d = Math.hypot(c.x[i] - cameraPos.x, c.y[i] - cameraPos.z);
        if (d > maxDist) continue;
        candidates.push({ slot: i, d });
      }
      candidates.sort((a, b) => a.d - b.d);
      for (const cand of candidates) {
        if (labelIndex >= this.labels.length) break;
        const entry = this.labels[labelIndex++];
        const i = cand.slot;
        const sp = SPECIES[c.speciesIdx[i]];
        const tag = `${sp.tag}-${c.id[i]}`;
        const age = (c.ageDays[i] / 365).toFixed(1);
        const state = c.reason[i] ? c.reason[i]!.slice(0, 26) : sp.name;
        const sub = `${c.sex[i] === 1 ? '♀' : '♂'} · ${age}y · ${state}`;
        this.drawLabel(entry, tag, sub, c.infection[i] === 1 ? '#e8a06a' : '#f2ead6');
        entry.sprite.visible = true;
        entry.sprite.position.set(c.x[i], c.z[i] + Math.max(1.6, sp.bodyLength * c.bodyScale(i)) + 1.4, c.y[i]);
        const dist = cand.d;
        entry.sprite.scale.set(Math.max(4.5, dist * 0.09), Math.max(1.1, dist * 0.022), 1);
        entry.sprite.material.opacity = clamp01(1.15 - dist / maxDist) * 0.9;
      }
    }
    for (let i = labelIndex; i < this.labels.length; i++) this.labels[i].sprite.visible = false;

    // Landmark names appear when zoomed out enough to see a region, nearest
    // first and kept faint: they annotate the landscape, they do not cover it.
    let li = 0;
    if (showLabels && cameraZoom > 200) {
      const alpha = clamp01((cameraZoom - 200) / 400);
      const near = this.landmarkRefs
        .map((ref) => ({ ref, d: Math.hypot(ref.x - cameraPos.x, ref.y - cameraPos.z) }))
        .filter((r) => r.d < 1100)
        .sort((a, b) => a.d - b.d);
      for (const { ref, d } of near) {
        if (li >= this.landmarkLabels.length) break;
        const entry = this.landmarkLabels[li++];
        this.drawLabel(entry, ref.name, ref.kind, '#ded3b8');
        entry.sprite.visible = true;
        entry.sprite.position.set(ref.x, world.terrain.elevationAtWorld(ref.x, ref.y) + 5, ref.y);
        // A constant on-screen size: a name should not swell as you approach it.
        const w = Math.max(9, d * 0.055);
        entry.sprite.scale.set(w, w * 0.25, 1);
        entry.sprite.material.opacity = alpha * 0.5;
      }
    }
    for (let i = li; i < this.landmarkLabels.length; i++) this.landmarkLabels[i].sprite.visible = false;

    // Territory outlines for social predators.
    let ti = 0;
    const positions = this.territoryPositions;
    for (const group of world.social.groups) {
      if (ti * 64 >= positions.length / 3 - 64) break;
      const sp = SPECIES[group.speciesIdx];
      if (sp.territoryRadius <= 0 || group.members.length === 0) continue;
      const radius = group.territoryRadius || sp.territoryRadius;
      const segs = 24;
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * TAU;
        const a1 = ((s + 1) / segs) * TAU;
        const base = ti * 64 * 3 + s * 6;
        if (base + 6 > positions.length) break;
        positions[base] = group.centerX + Math.cos(a0) * radius;
        positions[base + 1] = world.terrain.elevationAtWorld(positions[base], group.centerY + Math.sin(a0) * radius) + 0.4;
        positions[base + 2] = group.centerY + Math.sin(a0) * radius;
        positions[base + 3] = group.centerX + Math.cos(a1) * radius;
        positions[base + 4] = positions[base + 1];
        positions[base + 5] = group.centerY + Math.sin(a1) * radius;
      }
      ti++;
    }
    this.territoryLines.geometry.setDrawRange(0, ti * 24 * 2);
    (this.territoryLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.territoryLines.visible = ti > 0;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh & { material?: THREE.Material };
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    });
    for (const l of [...this.labels, ...this.landmarkLabels]) l.texture.dispose();
  }
}
