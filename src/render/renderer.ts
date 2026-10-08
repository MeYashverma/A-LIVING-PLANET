import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp, clamp01, lerp } from '../core/math';
import { QUALITY_PRESETS, RENDER } from '../core/config';
import type { Settings } from '../core/events';
import type { World } from '../world/world';
import { Sky } from './sky';
import { TerrainMesh } from './terrainMesh';
import { GroundCover } from './vegetationRenderer';
import { CreatureRenderer } from './creatureRenderer';
import { Props } from './props';
import { Effects } from './effects';
import { SelectionVisuals } from './selection';
import { CameraRig, type CameraMode, type ScaleLevel } from './cameraRig';
import { TextureLibrary } from './textures';

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  nearAnimals: number;
  farAnimals: number;
  grass: number;
  trees: number;
  gpuMemory: number;
}

export interface ViewOptions {
  showLabels: boolean;
  showTrails: boolean;
  showTerritories: boolean;
  cameraMode: CameraMode;
}

/**
 * The renderer: one window onto the world. Owns the scene graph, the sky and
 * lighting, and every visual subsystem, and keeps them all in step with the
 * simulation. It never invents state — if the model does not know about it, it
 * does not get drawn.
 */
export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly sky: Sky;
  readonly terrainMesh: TerrainMesh;
  readonly groundCover: GroundCover;
  readonly creatures: CreatureRenderer;
  readonly props: Props;
  readonly effects: Effects;
  readonly selection: SelectionVisuals;
  readonly textures: TextureLibrary;

  stats: RenderStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, programs: 0, nearAnimals: 0, farAnimals: 0, grass: 0, trees: 0, gpuMemory: 0 };

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private container: HTMLElement;
  private lastFrame = performance.now();
  private fpsAccum = 0;
  private fpsFrames = 0;
  private quality: 'low' | 'medium' | 'high' | 'ultra';
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private time = 0;
  private settings: Settings;
  private view: ViewOptions = { showLabels: true, showTrails: true, showTerritories: true, cameraMode: 'free' };
  private sunColor = new THREE.Color(0xfff0d0);

  constructor(container: HTMLElement, world: World, settings: Settings, textures: TextureLibrary) {
    this.container = container;
    this.settings = settings;
    this.quality = settings.quality;
    const preset = QUALITY_PRESETS[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    // A shader that fails to compile renders black and says so only in the
    // browser console. Print the compiler's own log with the source, because a
    // silent black world is impossible to diagnose from the outside.
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const info = gl.getProgramInfoLog(program) ?? '';
      const vlog = gl.getShaderInfoLog(vs) ?? '';
      const flog = gl.getShaderInfoLog(fs) ?? '';
      console.error('[shader] program failed to link\n', info, '\nvertex:\n', vlog, '\nfragment:\n', flog);
    };
    this.renderer.setClearColor(0x0a0d12, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = preset.shadow > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.textures = textures;
    this.rig = new CameraRig(1);
    this.scene.fog = new THREE.FogExp2(0xa8bcd0, 0.0022);

    this.sky = new Sky(this.scene, world);
    this.terrainMesh = new TerrainMesh(world, {
      resolution: this.terrainResolution(),
      shadows: preset.shadow > 0,
      textures: this.textures,
      triplanar: this.quality === 'high' || this.quality === 'ultra',
    });
    this.scene.add(this.terrainMesh.group);
    this.terrainMesh.attachRenderer(this.renderer);
    this.groundCover = new GroundCover(world, this.quality, textures);
    this.scene.add(this.groundCover.group);
    this.props = new Props(world, this.quality, textures);
    this.scene.add(this.props.group);
    this.creatures = new CreatureRenderer(world, this.quality);
    this.scene.add(this.creatures.group);
    this.effects = new Effects(world, this.quality);
    this.scene.add(this.effects.group);
    this.selection = new SelectionVisuals(world);
    this.scene.add(this.selection.group);

    this.setupComposer();
    this.resize();
    // Open on the landscape: a region-scale view of the middle of the map, so
    // the first thing anyone sees is a whole living valley, not a patch of dirt.
    this.rig.focus.set(0, world.terrain.elevationAtWorld(0, 0), 0);
    this.rig.focus.y = Math.max(this.rig.focus.y, 6);
    this.rig.openWide(300, 0.62);
  }

  private terrainResolution(): number {
    const preset = QUALITY_PRESETS[this.quality];
    return Math.round(300 * preset.terrain);
  }

  private setupComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    const preset = QUALITY_PRESETS[this.quality];
    if (this.quality === 'low') return;
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.rig.camera));
    if (preset.bloom > 0) {
      // Barely-there bloom: enough to make fire and water read as bright, not
      // enough to look like a neon arcade.
      const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.6, 0.92);
      composer.addPass(bloom);
      this.bloom = bloom;
    }
    const output = new OutputPass();
    composer.addPass(output);
    composer.setPixelRatio(this.pixelRatio);
    this.composer = composer;
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    const preset = QUALITY_PRESETS[this.quality];
    // Adapt the pixel ratio to the frame time so weak GPUs stay fluid.
    const base = Math.min(window.devicePixelRatio || 1, RENDER.maxPixelRatio);
    const adaptive = clamp(this.adaptiveRatio, 0.62, 1);
    this.pixelRatio = clamp(base * preset.pixelRatio * adaptive, 0.6, RENDER.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.composer?.setSize(this.width, this.height);
    this.composer?.setPixelRatio(this.pixelRatio);
    this.rig.setAspect(this.width / this.height);
  }

  private adaptiveRatio = 1;

  applySettings(settings: Settings): void {
    const qualityChanged = settings.quality !== this.quality;
    this.settings = settings;
    this.quality = settings.quality;
    const preset = QUALITY_PRESETS[this.quality];
    this.renderer.shadowMap.enabled = preset.shadow > 0;
    if (this.sky.sun.shadow.mapSize.width !== preset.shadow && preset.shadow > 0) {
      this.sky.sun.shadow.mapSize.set(preset.shadow, preset.shadow);
      this.sky.sun.shadow.map?.dispose();
      this.sky.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    if (qualityChanged) {
      this.setupComposer();
      this.resize();
    }
    this.selection.group.visible = true;
  }

  setViewOptions(view: Partial<ViewOptions>, world: World): void {
    this.view = { ...this.view, ...view };
    if (view.cameraMode) this.rig.setMode(view.cameraMode, world, null);
  }

  get viewOptions(): ViewOptions {
    return this.view;
  }

  /** Per-frame update: advance visuals to match the simulation. */
  update(world: World, dt: number): void {
    const started = performance.now();
    this.time += dt;
    this.rig.update(world, dt, this.settings.reducedMotion);
    const camera = this.rig.camera;

    // Sky: sun position, clouds, fog and lighting all come from the climate.
    const atmosphere = this.sky.update(world, camera.position, this.settings);
    this.sky.dome.position.copy(camera.position);
    this.sky.dome.scale.setScalar(2600);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(atmosphere.fogColor);
      // Fog thickens with rain/fog and thins with altitude.
      this.scene.fog.density = atmosphere.fogDensity * lerp(1, 0.55, clamp01(camera.position.y / 420));
    }
    this.sunColor.copy(this.sky.sun.color);

    // Ground colour tracks vegetation, snow, moisture and fire scars.
    this.terrainMesh.refresh();
    const rainHere = world.climate.rainIntensityAt(camera.position.x, camera.position.z) / 1.4;
    // Ripples: rain and the animals in the water drive the surface simulation.
    this.terrainMesh.stepWater(rainHere, dt);
    this.terrainMesh.update(
      atmosphere.sunDir,
      this.sunColor,
      atmosphere.fogColor,
      world.climate.windSpeed,
      world.climate.windDirection,
      rainHere,
      dt,
      clamp01(world.fire.smoke * 0.4 + world.climate.globalDimming),
    );

    const snowCover = clamp01(world.terrain.snowAtWorld(camera.position.x, camera.position.z));
    this.groundCover.update(camera.position, dt, world.clock.yearFraction, snowCover);
    this.groundCover.updateUniforms(world.climate.windDirection, world.climate.windSpeed, world.clock.yearFraction, snowCover);
    this.props.update(camera.position, dt, world.clock.yearFraction, snowCover, atmosphere.night);
    this.creatures.update(camera.position, atmosphere.night, snowCover);
    this.effects.update(camera.position, camera.quaternion, dt, this.pixelRatio, atmosphere.night);

    const selected = this.selectedId;
    this.selection.update(camera.position, this.rig.distance, selected, dt, this.view.showTrails, this.view.showLabels);
    if (!this.view.showTerritories) this.selection['territoryLines'].visible = false;
    // Wind and rain feel: a slight shake during storms near the ground.
    if (world.climate.state === 'storm' && this.settings.reducedMotion === false) {
      this.rig.addShake(dt * 0.05 * clamp01(world.climate.intensity));
    }
    this.stats.frameMs = performance.now() - started;
  }

  selectedId: number | null = null;

  render(): void {
    const started = performance.now();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.rig.camera);
    const now = performance.now();
    this.fpsAccum += now - this.lastFrame;
    this.fpsFrames++;
    if (this.fpsAccum > 500) {
      this.stats.fps = Math.round((this.fpsFrames * 1000) / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      // Adaptive resolution: if we are below 45 fps, drop the render scale a
      // little; if we are comfortably above 58, claw it back.
      if (this.stats.fps < 42 && this.adaptiveRatio > 0.62) {
        this.adaptiveRatio = Math.max(0.62, this.adaptiveRatio - 0.08);
        this.resize();
      } else if (this.stats.fps > 58 && this.adaptiveRatio < 1) {
        this.adaptiveRatio = Math.min(1, this.adaptiveRatio + 0.05);
        this.resize();
      }
    }
    const info = this.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
    this.stats.gpuMemory = info.memory.geometries + info.memory.textures;
    const instances = this.creatures.countInstances();
    this.stats.nearAnimals = instances.near;
    this.stats.farAnimals = instances.far;
    const cover = this.groundCover.counts;
    this.stats.grass = cover.grass + cover.shrub + cover.reed;
    this.stats.trees = this.props['trees'].reduce((n: number, t: { mesh: THREE.InstancedMesh }) => n + t.mesh.count, 0);
    this.lastFrame = now;
    this.stats.frameMs += performance.now() - started;
  }

  /** After terrain changes: rebuild water and mark the ground for a re-colour. */
  terrainChanged(): void {
    this.terrainMesh.rebuildWater();
    this.terrainMesh.refresh(true);
    this.props.markDirty();
  }

  setScale(level: ScaleLevel, world: World): void {
    this.rig.setScale(level, world);
  }

  setWeatherParticles(visible: boolean): void {
    this.effects.setRainEnabled(visible);
  }

  /** A short screen-space flash for lightning, drawn as a light bounce. */
  lightningFlash(strength: number): void {
    this.sky.ambient.intensity += strength * 1.4;
    this.rig.addShake(strength * 0.25);
  }

  screenToGround(ndcX: number, ndcY: number, world: World): THREE.Vector3 | null {
    return this.rig.screenToGround(world, ndcX, ndcY);
  }

  pickOrganism(ndcX: number, ndcY: number, world: World): number | null {
    return this.rig.pickOrganism(world, ndcX, ndcY);
  }

  dispose(): void {
    this.sky.dispose(this.scene);
    this.terrainMesh.dispose();
    this.groundCover.dispose();
    this.props.dispose();
    this.creatures.dispose();
    this.effects.dispose();
    this.selection.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get timeSeconds(): number {
    return this.time;
  }
}
