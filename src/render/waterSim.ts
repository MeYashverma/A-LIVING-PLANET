/*
 * Water ripple simulation, ported from WebGL Water by Evan Wallace
 * (http://madebyevan.com/webgl-water/, MIT licence, Copyright 2011 Evan Wallace).
 *
 * A height field is stepped on the GPU, one texel per terrain cell, so the
 * simulation grid is the same grid the hydrology uses. The data layout is the
 * original's: (height, velocity, normal.x, normal.z).
 *
 * The disturbances are real sim events, not decoration: rain falls on wet
 * cells at the simulated rain intensity, and animals that enter water or move
 * through it push the surface where they are. Ripples are damped and confined
 * to water cells, so they never spread onto dry land.
 */
import * as THREE from 'three';

const MAX_DROPS = 16;

const VERT = /* glsl */ `
  varying vec2 coord;
  void main() {
    coord = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const DROP_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform int uCount;
  uniform vec4 uDrops[${MAX_DROPS}]; // centre.xy in 0..1 texture space, radius (texture space), strength
  varying vec2 coord;
  const float PI = 3.141592653589793;
  void main() {
    vec4 info = texture2D(uTex, coord);
    for (int i = 0; i < ${MAX_DROPS}; i++) {
      if (i >= uCount) break;
      vec4 d = uDrops[i];
      float drop = max(0.0, 1.0 - length(d.xy - coord) / d.z);
      drop = 0.5 - cos(drop * PI) * 0.5;
      info.r += drop * d.w;
    }
    gl_FragColor = info;
  }
`;

const UPDATE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform sampler2D uMask;
  uniform vec2 uDelta;
  varying vec2 coord;
  void main() {
    vec4 info = texture2D(uTex, coord);
    vec2 dx = vec2(uDelta.x, 0.0);
    vec2 dy = vec2(0.0, uDelta.y);
    float average = (
      texture2D(uTex, coord - dx).r +
      texture2D(uTex, coord - dy).r +
      texture2D(uTex, coord + dx).r +
      texture2D(uTex, coord + dy).r
    ) * 0.25;
    info.g += (average - info.r) * 2.0;
    info.g *= 0.995;
    info.r += info.g;
    // Only water cells carry ripples. Dry land and the shore stay flat.
    float wet = texture2D(uMask, coord).r;
    gl_FragColor = info * wet;
  }
`;

const NORMAL_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uDelta;
  varying vec2 coord;
  void main() {
    vec4 info = texture2D(uTex, coord);
    vec3 dx = vec3(uDelta.x, texture2D(uTex, vec2(coord.x + uDelta.x, coord.y)).r - info.r, 0.0);
    vec3 dy = vec3(0.0, texture2D(uTex, vec2(coord.x, coord.y + uDelta.y)).r - info.r, uDelta.y);
    info.ba = normalize(cross(dy, dx)).xz;
    gl_FragColor = info;
  }
`;

export class WaterSim {
  readonly n: number;
  /** Current height field: r = height, ba = surface normal (x, z). */
  get texture(): THREE.Texture {
    return this.a.texture;
  }

  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private mask: THREE.DataTexture;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private dropMat: THREE.ShaderMaterial;
  private updateMat: THREE.ShaderMaterial;
  private normalMat: THREE.ShaderMaterial;
  private pending: { x: number; y: number; r: number; s: number }[] = [];

  constructor(private renderer: THREE.WebGLRenderer, n: number, wet: Uint8Array) {
    this.n = n;
    const opts: THREE.RenderTargetOptions = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    this.a = new THREE.WebGLRenderTarget(n, n, opts);
    this.b = new THREE.WebGLRenderTarget(n, n, opts);
    this.mask = new THREE.DataTexture(wet, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
    const delta = new THREE.Vector2(1 / n, 1 / n);
    this.dropMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DROP_FRAG,
      uniforms: {
        uTex: { value: null },
        uCount: { value: 0 },
        uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.updateMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: UPDATE_FRAG,
      uniforms: { uTex: { value: null }, uMask: { value: this.mask }, uDelta: { value: delta } },
      depthTest: false,
      depthWrite: false,
    });
    this.normalMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: NORMAL_FRAG,
      uniforms: { uTex: { value: null }, uDelta: { value: delta } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.updateMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Whether this GPU can render to float targets, which the simulation needs. */
  static supported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
  }

  /** Replace the wet-cell mask after the hydrology has changed. */
  setMask(wet: Uint8Array): void {
    (this.mask.image as { data: Uint8Array }).data.set(wet);
    this.mask.needsUpdate = true;
  }

  /**
   * Queue a disturbance: a smooth bump of `radius` cells at (cx, cy) in
   * texel coordinates. Negative strength pushes the surface down.
   */
  disturb(cx: number, cy: number, radius: number, strength: number): void {
    this.pending.push({ x: cx, y: cy, r: radius, s: strength });
  }

  /** Apply queued disturbances, then advance the wave equation by `steps`. */
  step(steps: number): void {
    const prev = this.renderer.getRenderTarget();
    const n = this.n;
    // Drops are applied in batches of MAX_DROPS, in one pass each.
    while (this.pending.length) {
      const batch = this.pending.splice(0, MAX_DROPS);
      const uniforms = this.dropMat.uniforms;
      const drops = uniforms.uDrops.value as THREE.Vector4[];
      batch.forEach((d, i) => drops[i].set((d.x + 0.5) / n, (d.y + 0.5) / n, Math.max(0.5, d.r) / n, d.s));
      uniforms.uCount.value = batch.length;
      this.pass(this.dropMat);
    }
    for (let i = 0; i < steps; i++) this.pass(this.updateMat);
    this.pass(this.normalMat);
    this.renderer.setRenderTarget(prev);
  }

  /** One GPU pass: read the current target, write the other, then swap. */
  private pass(mat: THREE.ShaderMaterial): void {
    (mat.uniforms.uTex as { value: THREE.Texture }).value = this.a.texture;
    this.quad.material = mat;
    this.renderer.setRenderTarget(this.b);
    this.renderer.render(this.scene, this.camera);
    const t = this.a;
    this.a = this.b;
    this.b = t;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.mask.dispose();
    this.dropMat.dispose();
    this.updateMat.dispose();
    this.normalMat.dispose();
  }
}
