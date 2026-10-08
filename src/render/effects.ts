import * as THREE from 'three';
import { clamp01, TAU } from '../core/math';
import { QUALITY_PRESETS } from '../core/config';
import type { World } from '../world/world';

/** A soft radial sprite, generated at runtime (no external assets). */
function makePuffTexture(size = 64, hardness = 0.35): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const a = clamp01(1 - (d - hardness) / (1 - hardness));
      const v = a * a * (3 - 2 * a);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(v * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** A vertical streak (rain), generated at runtime. */
function makeStreakTexture(w = 8, h = 64): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const fade = Math.sin(t * Math.PI) ** 0.6;
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - (w - 1) / 2) / ((w - 1) / 2);
      const a = clamp01(1 - dx) * fade;
      const i = (y * w + x) * 4;
      data[i] = 235;
      data[i + 1] = 245;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 215);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

interface ParticleSet {
  points: THREE.Points;
  count: number;
  capacity: number;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  size: Float32Array;
  opacity: Float32Array;
  cursor: number;
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * Weather and local-effect particles: rain, snow, drifting leaves, ash and
 * smoke from fires, insects in summer, dust in the dry season. They are driven
 * by the climate simulation's own numbers, not by a weather mood board.
 */
export class Effects {
  readonly group = new THREE.Group();
  private rain: ParticleSet;
  private snow: ParticleSet;
  private leaves: ParticleSet;
  private smoke: ParticleSet;
  private insects: ParticleSet;
  private dust: ParticleSet;
  private fireMesh: THREE.InstancedMesh;
  private fireUniforms: Record<string, THREE.IUniform>;
  private rainEnabled = true;
  private rngState = 12345;

  constructor(private world: World, quality: 'low' | 'medium' | 'high' | 'ultra') {
    const preset = QUALITY_PRESETS[quality];
    const scale = preset.particles;
    this.rain = this.makeParticles(Math.round(4200 * scale), makeStreakTexture(), 0.7);
    this.snow = this.makeParticles(Math.round(2200 * scale), makePuffTexture(32, 0.2), 0.5);
    this.leaves = this.makeParticles(Math.round(500 * scale), makePuffTexture(32, 0.3), 0.5);
    this.smoke = this.makeParticles(Math.round(900 * scale), makePuffTexture(64, 0.1), 1.6);
    this.insects = this.makeParticles(Math.round(700 * scale), makePuffTexture(16, 0.25), 0.3);
    this.dust = this.makeParticles(Math.round(600 * scale), makePuffTexture(24, 0.2), 0.5);
    this.group.add(this.rain.points, this.snow.points, this.leaves.points, this.smoke.points, this.insects.points, this.dust.points);

    // Fire: billboarded quads, additive, animated in the vertex shader.
    const fireGeo = new THREE.PlaneGeometry(1, 1);
    const fireUniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uColorHot: { value: new THREE.Color(1.0, 0.86, 0.42) },
      uColorCold: { value: new THREE.Color(0.85, 0.16, 0.03) },
    };
    this.fireUniforms = fireUniforms;
    const fireMat = new THREE.ShaderMaterial({
      uniforms: fireUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aPhase;
        attribute float aSize;
        uniform float uTime;
        varying vec2 vUv;
        varying float vFlicker;
        void main() {
          vUv = uv;
          float t = uTime * 9.0 + aPhase * 6.2831;
          vFlicker = 0.65 + 0.35 * sin(t) * sin(t * 0.7 + aPhase);
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position * aSize, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uColorHot, uColorCold;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vFlicker;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          // A flame shape: wide at the base, tapering as it rises.
          float taper = 1.0 - clamp(vUv.y, 0.0, 1.0) * 0.72;
          float shape = 1.0 - smoothstep(0.0, taper, abs(p.x));
          float body = pow(clamp(shape, 0.0, 1.0), 1.4) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          float core = pow(clamp(shape, 0.0, 1.0), 3.0) * (1.0 - smoothstep(0.2, 0.6, vUv.y));
          vec3 col = mix(uColorCold, uColorHot, core);
          float a = (body * 0.75 + core) * vFlicker * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(col * (0.7 + core), a);
        }
      `,
    });
    this.fireMesh = new THREE.InstancedMesh(fireGeo, fireMat, Math.round(1400 * scale) + 40);
    this.fireMesh.frustumCulled = false;
    this.fireMesh.count = 0;
    this.fireMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const phase = new THREE.InstancedBufferAttribute(new Float32Array(this.fireMesh.instanceMatrix.count), 1);
    phase.setUsage(THREE.DynamicDrawUsage);
    fireGeo.setAttribute('aPhase', phase);
    this.fireMesh.userData.phase = phase;
    this.group.add(this.fireMesh);
  }

  private makeParticles(capacity: number, texture: THREE.Texture, sizeScale: number): ParticleSet {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(capacity * 3);
    const opacity = new Float32Array(capacity);
    const size = new Float32Array(capacity);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    const uniforms = {
      uTex: { value: texture },
      uScale: { value: sizeScale },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uPixelRatio: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aOpacity;
        attribute float aSize;
        uniform float uScale;
        uniform float uPixelRatio;
        varying float vOpacity;
        void main() {
          vOpacity = aOpacity;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale * uPixelRatio * (300.0 / max(1.0, -mv.z));
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D uTex;
        uniform vec3 uColor;
        varying float vOpacity;
        void main() {
          vec4 tex = texture2D(uTex, gl_PointCoord);
          float a = tex.a * vOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * tex.rgb, a);
        }
      `,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 10;
    geo.setDrawRange(0, 0);
    return {
      points,
      count: capacity,
      capacity,
      pos,
      vel: new Float32Array(capacity * 3),
      life: new Float32Array(capacity),
      size,
      opacity,
      cursor: 0,
      uniforms,
    };
  }

  private rand(): number {
    // A cheap deterministic stream so particles do not perturb the simulation RNG.
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  private spawn(set: ParticleSet, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, opacity: number): void {
    const i = set.cursor % set.capacity;
    set.cursor++;
    set.pos[i * 3] = x;
    set.pos[i * 3 + 1] = y;
    set.pos[i * 3 + 2] = z;
    set.vel[i * 3] = vx;
    set.vel[i * 3 + 1] = vy;
    set.vel[i * 3 + 2] = vz;
    set.life[i] = life;
    set.size[i] = size;
    set.opacity[i] = opacity;
  }

  /** Advance all effects. `dt` is real seconds. */
  update(cameraPos: THREE.Vector3, cameraQuat: THREE.Quaternion, dt: number, pixelRatio: number, night = 0): void {
    const world = this.world;
    const climate = world.climate;
    const rainHere = climate.rainAt(cameraPos.x, cameraPos.z);
    const tempHere = climate.temperatureAt(cameraPos.x, cameraPos.z);
    const snowFall = tempHere < 1 ? clamp01(rainHere / 0.6) : 0;
    const rainIntensity = tempHere >= 1 ? clamp01(rainHere / 1.4) : 0;
    const windSpeed = climate.windSpeed;
    const windDir = climate.windDirection;
    const windX = Math.cos(windDir) * windSpeed;
    const windZ = Math.sin(windDir) * windSpeed;
    const storm = clamp01(world.climate.state === 'storm' ? climate.intensity : 0);

    for (const set of [this.rain, this.snow, this.leaves, this.smoke, this.insects, this.dust]) {
      set.uniforms.uPixelRatio.value = pixelRatio;
    }
    (this.rain.uniforms.uColor.value as THREE.Color).setRGB(0.78, 0.85, 0.95);
    (this.snow.uniforms.uColor.value as THREE.Color).setRGB(0.96, 0.97, 1.0);
    (this.smoke.uniforms.uColor.value as THREE.Color).setRGB(0.32 + storm * 0.05, 0.31, 0.3);
    (this.insects.uniforms.uColor.value as THREE.Color).setRGB(0.85, 0.85, 0.7);
    (this.dust.uniforms.uColor.value as THREE.Color).setRGB(0.78, 0.7, 0.55);
    (this.leaves.uniforms.uColor.value as THREE.Color).setRGB(0.55, 0.36, 0.15);

    const spawnRadius = 70;
    const camX = cameraPos.x;
    const camY = cameraPos.y;
    const camZ = cameraPos.z;

    // Rain: falls in the camera's neighbourhood where it is actually raining.
    const rainCount = Math.round(this.rain.capacity * clamp01(rainIntensity * 1.4) * dt * 60);
    for (let i = 0; i < Math.min(rainCount, 900); i++) {
      const a = this.rand() * TAU;
      const r = Math.sqrt(this.rand()) * spawnRadius;
      this.spawn(
        this.rain,
        camX + Math.cos(a) * r,
        camY + 26 + this.rand() * 12,
        camZ + Math.sin(a) * r,
        windX * 0.35,
        -34 - this.rand() * 12,
        windZ * 0.35,
        1.0 + this.rand() * 0.5,
        0.9 + this.rand() * 0.9,
        clamp01(0.45 + rainIntensity * 0.5),
      );
    }
    const snowCount = Math.round(this.snow.capacity * clamp01(snowFall) * dt * 24);
    for (let i = 0; i < Math.min(snowCount, 400); i++) {
      const a = this.rand() * TAU;
      const r = Math.sqrt(this.rand()) * spawnRadius;
      this.spawn(
        this.snow,
        camX + Math.cos(a) * r,
        camY + 22 + this.rand() * 10,
        camZ + Math.sin(a) * r,
        windX * 0.5 + (this.rand() - 0.5) * 1.2,
        -1.6 - this.rand() * 1.4,
        windZ * 0.5 + (this.rand() - 0.5) * 1.2,
        9 + this.rand() * 6,
        0.2 + this.rand() * 0.3,
        0.8,
      );
    }

    // Fire: draw flame quads at burning cells near the camera, and spawn smoke.
    const fire = world.fire;
    const heat = fire.intensity.data;
    const size = world.terrain.size;
    const cellUnits = world.terrain.cellUnits;
    let flames = 0;
    const fireCap = this.fireMesh.instanceMatrix.count;
    const dummy = new THREE.Object3D();
    const cx0 = Math.round(world.terrain.worldToCellX(camX));
    const cy0 = Math.round(world.terrain.worldToCellY(camZ));
    const fireRadius = 60;
    for (let dy = -fireRadius; dy <= fireRadius && flames < fireCap; dy += 1) {
      const cy = cy0 + dy;
      if (cy < 0 || cy >= size) continue;
      for (let dx = -fireRadius; dx <= fireRadius && flames < fireCap; dx += 1) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= size) continue;
        // Stride sampling: flames are small, we do not need every cell.
        if ((dx + dy) % 2 !== 0) continue;
        const idx = cy * size + cx;
        const intensity = heat[idx];
        if (intensity < 0.12) continue;
        const wx = world.terrain.cellToWorldX(cx);
        const wz = world.terrain.cellToWorldY(cy);
        const wy = world.terrain.elevationOf(world.terrain.height.data[idx]);
        const n = intensity > 1.4 ? 2 : 1;
        for (let k = 0; k < n && flames < fireCap; k++) {
          const s = (1.1 + intensity * 1.6) * (0.7 + this.rand() * 0.5);
          dummy.position.set(wx + (this.rand() - 0.5) * cellUnits, wy + s * 0.45, wz + (this.rand() - 0.5) * cellUnits);
          dummy.quaternion.copy(cameraQuat);
          dummy.scale.set(s * 0.8, s, 1);
          dummy.updateMatrix();
          this.fireMesh.setMatrixAt(flames, dummy.matrix);
          (this.fireMesh.userData.phase as THREE.InstancedBufferAttribute).setX(flames, this.rand());
          flames++;
        }
        if (this.rand() < intensity * 0.35) {
          this.spawn(this.smoke, wx, wy + 2, wz, windX * 0.25 + (this.rand() - 0.5), 1.6 + this.rand() * 1.6, windZ * 0.25, 18 + this.rand() * 10, 3 + this.rand() * 4, 0.5);
        }
      }
    }
    this.fireMesh.count = flames;
    (this.fireMesh.instanceMatrix as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.fireMesh.userData.phase as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.fireUniforms.uTime.value += dt;

    // Insects: swarms where the aggregate insect field is active, in the warm months.
    const warmth = clamp01((climate.temperatureAt(camX, camZ) - 6) / 18);
    const insectActivity = world.aggregates.insectActivityAt(camX, camZ) * warmth * (1 - night * 0.85);
    const insectCount = Math.round(140 * insectActivity * dt * 12);
    for (let i = 0; i < Math.min(insectCount, 60); i++) {
      const a = this.rand() * TAU;
      const r = this.rand() * 34;
      this.spawn(
        this.insects,
        camX + Math.cos(a) * r,
        world.terrain.elevationAtWorld(camX + Math.cos(a) * r, camZ + Math.sin(a) * r) + 0.6 + this.rand() * 2.4,
        camZ + Math.sin(a) * r,
        (this.rand() - 0.5) * 1.4,
        (this.rand() - 0.5) * 0.5,
        (this.rand() - 0.5) * 1.4,
        3 + this.rand() * 4,
        0.12 + this.rand() * 0.16,
        0.55,
      );
    }

    // Dust in dry, windy weather.
    const dryness = clamp01(1 - world.terrain.soilMoisture.sample(world.terrain.worldToCellX(camX), world.terrain.worldToCellY(camZ)) * 2);
    const dustCount = Math.round(120 * dryness * clamp01(windSpeed / 12) * dt * 20);
    for (let i = 0; i < Math.min(dustCount, 40); i++) {
      const a = this.rand() * TAU;
      const r = this.rand() * 40;
      this.spawn(
        this.dust,
        camX + Math.cos(a) * r,
        camY - 1 + this.rand() * 4,
        camZ + Math.sin(a) * r,
        windX * 0.8,
        0.3 + this.rand() * 0.4,
        windZ * 0.8,
        4 + this.rand() * 4,
        0.5 + this.rand() * 0.8,
        0.16 + this.rand() * 0.12,
      );
    }

    // Autumn leaves fall from trees near the camera.
    const leafFall = clamp01(1 - Math.abs(world.clock.yearFraction - 0.55) * 5);
    if (leafFall > 0.05) {
      const leafCount = Math.round(90 * leafFall * dt * 8);
      for (let i = 0; i < Math.min(leafCount, 30); i++) {
        const a = this.rand() * TAU;
        const r = this.rand() * 30;
        const x = camX + Math.cos(a) * r;
        const z = camZ + Math.sin(a) * r;
        this.spawn(this.leaves, x, world.terrain.elevationAtWorld(x, z) + 6 + this.rand() * 8, z, windX * 0.4 + (this.rand() - 0.5), -0.9, windZ * 0.4 + (this.rand() - 0.5), 7, 0.16, 0.75);
      }
    }

    for (const set of [this.rain, this.snow, this.leaves, this.smoke, this.insects, this.dust]) {
      this.simulate(set, dt, windX, windZ, camX, camZ);
    }
  }

  private simulate(set: ParticleSet, dt: number, windX: number, windZ: number, camX: number, camZ: number): void {
    const pos = set.pos;
    const vel = set.vel;
    const life = set.life;
    let visible = 0;
    for (let i = 0; i < set.capacity; i++) {
      if (life[i] <= 0) {
        set.opacity[i] = 0;
        continue;
      }
      life[i] -= dt;
      const i3 = i * 3;
      const drag = set === this.smoke ? 0.6 : 0.2;
      vel[i3] += (windX * drag - vel[i3] * 0.4) * dt;
      vel[i3 + 2] += (windZ * drag - vel[i3 + 2] * 0.4) * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      if (set === this.smoke) {
        set.size[i] += dt * 0.9;
        set.opacity[i] = Math.max(0, set.opacity[i] - dt * 0.028);
      }
      if (set === this.rain || set === this.snow) {
        // Recycle particles that fall to the ground near the camera.
        const groundY = this.world.terrain.elevationAtWorld(pos[i3], pos[i3 + 2]);
        if (pos[i3 + 1] < groundY) {
          life[i] = 0;
          set.opacity[i] = 0;
          continue;
        }
      }
      // Keep particles near the camera so the budget is spent on what is visible.
      if (Math.abs(pos[i3] - camX) > 120 || Math.abs(pos[i3 + 2] - camZ) > 120) {
        life[i] = 0;
        set.opacity[i] = 0;
        continue;
      }
      visible++;
    }
    (set.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (set.points.geometry.getAttribute('aOpacity') as THREE.BufferAttribute).needsUpdate = true;
    (set.points.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    set.points.geometry.setDrawRange(0, set.capacity);
    void visible;
  }

  /** Whether weather particles are currently drawn. */
  get weatherVisible(): boolean {
    return this.rainEnabled;
  }

  /** Turn rain off entirely (used when the player hides weather effects). */
  setRainEnabled(enabled: boolean): void {
    this.rainEnabled = enabled;
    this.rain.points.visible = enabled;
    this.snow.points.visible = enabled;
  }

  get particlesVisible(): number {
    let n = 0;
    for (const set of [this.rain, this.snow, this.leaves, this.smoke, this.insects, this.dust]) {
      if (set.points.visible) n += set.capacity;
    }
    return n + this.fireMesh.count;
  }

  dispose(): void {
    for (const set of [this.rain, this.snow, this.leaves, this.smoke, this.insects, this.dust]) {
      set.points.geometry.dispose();
      (set.points.material as THREE.Material).dispose();
      (set.uniforms.uTex.value as THREE.Texture).dispose();
    }
    this.fireMesh.geometry.dispose();
    (this.fireMesh.material as THREE.Material).dispose();
  }
}
