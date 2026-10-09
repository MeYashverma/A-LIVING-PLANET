import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math';
import { BIOMES, Biome, PLANT_INDEX } from '../world/biomes';
import type { World } from '../world/world';
import type { TextureLibrary } from './textures';
import { createGroundMaterial, type SplatUniforms } from './terrainGround';
import { WaterSim } from './waterSim';
import { SPECIES } from '../life/species';

interface TerrainOptions {
  resolution: number;
  shadows: boolean;
  textures: TextureLibrary;
  triplanar: boolean;
}

interface WaterUniforms {
  [key: string]: THREE.IUniform;
}

/**
 * The ground and the water.
 *
 * The ground mesh carries a splat weight per vertex for the materials the world
 * is built from, computed from the simulation rather than painted: live plant
 * biomass decides where grass gives way to bare soil, slope decides where rock
 * takes over, snow cover and soil moisture and fire scars all feed in. The
 * shader turns those weights into triplanar PBR samples of real scanned
 * materials, so the ground under an animal is an honest picture of the ground
 * the model says it is standing on.
 */
/** A 1x1 zero height field, bound while there is no ripple simulation. */
function blankFlowTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

function blankField(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  return tex;
}

export class TerrainMesh {
  readonly group = new THREE.Group();
  readonly ground: THREE.Mesh;
  readonly water: THREE.Mesh;

  private step: number;
  private res: number;
  private geo: THREE.BufferGeometry;
  private waterGeo: THREE.BufferGeometry;
  private tintAttr: THREE.BufferAttribute;
  private splatA: THREE.BufferAttribute;
  private splatB: THREE.BufferAttribute;
  private plantAttr: THREE.BufferAttribute;
  private aoAttr: THREE.BufferAttribute;
  private groundUniforms: SplatUniforms;
  private waterAttr!: THREE.BufferAttribute;
  private flowTex: THREE.DataTexture | null = null;
  private uniforms: WaterUniforms;
  private lastRefresh = -1e9;
  /** GPU ripple simulation, present only where float render targets exist. */
  private sim: WaterSim | null = null;
  /** Index of every wet cell, for rain to fall on. */
  private wetCells = new Int32Array(0);
  /** Per-creature state for splashes: was in water last frame, last disturbance point. */
  private wasInWater = new Uint8Array(0);
  private lastDisturbX = new Float32Array(0);
  private lastDisturbY = new Float32Array(0);

  constructor(private world: World, opts: TerrainOptions) {
    const t = world.terrain;
    this.step = Math.max(1, Math.floor((t.size - 1) / (opts.resolution - 1)));
    this.res = Math.floor((t.size - 1) / this.step) + 1;

    const verts = this.res * this.res;
    const position = new Float32Array(verts * 3);
    this.tintAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.plantAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aoAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.splatA = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    this.splatB = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    this.waterAttr = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);

    const spacing = this.step * t.cellUnits;
    const origin = -t.half;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const idx = j * this.res + i;
        position[idx * 3] = origin + i * spacing;
        position[idx * 3 + 1] = 0;
        position[idx * 3 + 2] = origin + j * spacing;
      }
    }

    const indices = new Uint32Array((this.res - 1) * (this.res - 1) * 6);
    let k = 0;
    for (let j = 0; j < this.res - 1; j++) {
      for (let i = 0; i < this.res - 1; i++) {
        const a = j * this.res + i;
        const b = a + 1;
        const c = a + this.res;
        const d = c + 1;
        indices[k++] = a;
        indices[k++] = c;
        indices[k++] = b;
        indices[k++] = b;
        indices[k++] = c;
        indices[k++] = d;
      }
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geo.setAttribute('color', this.tintAttr);
    this.geo.setAttribute('aPlant', this.plantAttr);
    this.geo.setAttribute('aAO', this.aoAttr);
    this.geo.setAttribute('aSplatA', this.splatA);
    this.geo.setAttribute('aSplatB', this.splatB);
    this.geo.setAttribute('aWater', this.waterAttr);
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const { material, uniforms } = createGroundMaterial(
      {
        core: [opts.textures.ground.grass, opts.textures.ground.sand, opts.textures.ground.rock, opts.textures.ground.snow],
        tint: [opts.textures.ground.dirt, opts.textures.ground.moss],
      },
      { triplanar: opts.triplanar },
    );
    this.groundUniforms = uniforms;
    this.ground = new THREE.Mesh(this.geo, material);
    this.ground.castShadow = opts.shadows;
    this.ground.receiveShadow = true;
    this.ground.frustumCulled = false;
    this.group.add(this.ground);

    /* ---------------- water ---------------- */

    this.waterGeo = new THREE.BufferGeometry();
    this.uniforms = {
      // A ShaderMaterial does not inherit the fog uniforms, but the shader
      // includes the fog chunks, so they have to be supplied here.
      ...(THREE.UniformsLib.fog as Record<string, THREE.IUniform>),
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.2) },
      uSunColor: { value: new THREE.Color(0xfff3d6) },
      uSkyColor: { value: new THREE.Color(0x8fb6dd) },
      uShallow: { value: new THREE.Color(0x3f7a78) },
      uDeep: { value: new THREE.Color(0x081c2c) },
      uWave: { value: 0.7 },
      uWind: { value: new THREE.Vector2(0.4, 0.2) },
      uFoam: { value: 0.6 },
      uRain: { value: 0 },
      uOpacity: { value: 0.9 },
      uNormalMap: { value: opts.textures.waterNormal },
      uFoamMap: { value: opts.textures.foam },
      uFlow: { value: new THREE.Vector2(0.03, 0.02) },
      // Per-cell downhill direction (RG) and steepness (B) for water that runs downhill.
      uFlowTex: { value: blankFlowTexture() },
      uFlowHalf: { value: 1 },
      uTint: { value: new THREE.Color(0xffffff) },
      // Until a GPU simulation is attached, the sampler reads a blank field.
      uSim: { value: blankField() },
      uSimOrigin: { value: new THREE.Vector2() },
      uSimSize: { value: 1 },
      uSimCell: { value: 1 },
      uSimTexel: { value: 1 },
      uSimAmp: { value: 1.0 },
    };

    const waterMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aDepth;
        uniform float uTime;
        uniform vec2 uWind;
        uniform float uWave;
        uniform sampler2D uSim;
        uniform vec2 uSimOrigin;
        uniform float uSimSize;
        uniform float uSimAmp;
        varying vec2 vSimUv;
        varying float vDepth;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying vec2 vUv;
        void main() {
          vec3 p = position;
          // Three wave trains from long swell to short chop. Wavelengths of
          // roughly 3 to 12 m make the surface read as water from a distance;
          // the earlier 15 to 60 m swells were too long to see at play scale.
          // Amplitude grows with depth, so the shallows stay calm.
          float amp = uWave * (0.05 + clamp(aDepth, 0.0, 3.0) * 0.05);
          vec2 dir = normalize(uWind + vec2(0.001));
          vec2 dirB = vec2(-dir.y, dir.x);
          vec2 dirC = normalize(dir + vec2(0.55, -0.8));
          float k1 = dot(p.xz, dir) * 0.9 + uTime * 1.6;
          float k2 = dot(p.xz, dirB) * 1.3 - uTime * 1.1;
          float k3 = dot(p.xz, dirC) * 2.4 + uTime * 2.3;
          float a1 = amp;
          float a2 = amp * 0.6;
          float a3 = amp * 0.3;
          p.y += sin(k1) * a1 + sin(k2) * a2 + sin(k3) * a3;
          // Ripples from the simulation, faded out at the shoreline so the
          // edge of the water stays on the bank.
          vSimUv = (position.xz - uSimOrigin) / uSimSize;
          float simShore = smoothstep(0.0, 0.25, aDepth);
          p.y += (texture2D(uSim, vSimUv).r * uSimAmp) * simShore;
          // Analytic slope of the same sum gives the surface normal.
          float dhdx = cos(k1) * a1 * 0.9 * dir.x + cos(k2) * a2 * 1.3 * dirB.x + cos(k3) * a3 * 2.4 * dirC.x;
          float dhdz = cos(k1) * a1 * 0.9 * dir.y + cos(k2) * a2 * 1.3 * dirB.y + cos(k3) * a3 * 2.4 * dirC.y;
          vec3 n = normalize(vec3(-dhdx, 1.0, -dhdz));
          vDepth = aDepth;
          vWorld = p;
          vNormalW = n;
          vUv = p.xz;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uSunDir, uSunColor, uSkyColor, uShallow, uDeep, uTint;
        uniform float uTime, uFoam, uRain, uOpacity;
        uniform vec2 uWind, uFlow;
        uniform sampler2D uFlowTex;
        uniform float uFlowHalf;
        uniform sampler2D uNormalMap;
        uniform sampler2D uFoamMap;
        uniform sampler2D uSim;
        uniform float uSimAmp, uSimCell, uSimTexel;
        varying vec2 vSimUv;
        varying float vDepth;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying vec2 vUv;

        /**
         * Two scrolling layers of the same normal map at different scales and
         * directions. Detail that is not near the camera is faded out so the
         * surface of a lake a kilometre away does not alias into noise.
         */
        vec3 rippleNormal(vec3 N, vec3 viewDir) {
          float dist = length(cameraPosition - vWorld);
          float fade = 1.0 - smoothstep(90.0, 320.0, dist);
          // Downhill flow from the terrain under this fragment: the surface
          // detail is carried along the slope, faster where it is steeper.
          // Flat water (lakes) has no slope and keeps the global drift.
          vec4 fl = texture2D(uFlowTex, (vWorld.xz + uFlowHalf) / (2.0 * uFlowHalf));
          vec2 fdir = fl.rg * 2.0 - 1.0;
          vec2 flow = uWind * 0.004 + uFlow + fdir * fl.b * 0.12;
          vec2 uv1 = vUv * 0.32 + flow * uTime * 3.0;
          vec2 uv2 = vUv * 0.11 - flow * uTime * 1.7 + vec2(0.37, 0.11);
          vec3 n1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
          vec3 detail = normalize(vec3(n1.xy * 0.75 + n2.xy * 0.5, 1.0));
          float scale = clamp(vDepth * 1.2, 0.15, 1.0) * fade;
          N = normalize(N + vec3(detail.x, 0.0, detail.y) * scale * 0.9);
          // Real ripple slope: the height field differenced over one cell
          // (2.5 m) and scaled from sim units to metres.
          float hx = texture2D(uSim, vSimUv + vec2(uSimTexel, 0.0)).r - texture2D(uSim, vSimUv - vec2(uSimTexel, 0.0)).r;
          float hz = texture2D(uSim, vSimUv + vec2(0.0, uSimTexel)).r - texture2D(uSim, vSimUv - vec2(0.0, uSimTexel)).r;
          vec2 slope = vec2(hx, hz) * uSimAmp / (2.0 * uSimCell);
          float shoreK = smoothstep(0.0, 0.25, vDepth);
          return normalize(N + vec3(-slope.x, 0.0, -slope.y) * shoreK);
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 N = rippleNormal(normalize(vNormalW), viewDir);

          // Depth-based absorption: shallow water shows the bed, deep water
          // swallows every colour except blue-green, as water actually does.
          // vDepth is the water thickness in metres. Light is absorbed with
          // depth, so a few metres of water already reads as deep.
          float depth = 1.0 - exp(-vDepth * 0.35);
          vec3 base = mix(uShallow, uDeep, depth);

          // Fresnel, with water's real reflectance at normal incidence.
          float cosI = clamp(dot(viewDir, N), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
          // Reflection: a sky gradient that is paler at the horizon and a sun
          // disc where the reflected ray meets the sun, as on a real lake.
          vec3 R = reflect(-viewDir, N);
          vec3 zenith = uSkyColor * 0.85;
          vec3 horizon = mix(uSkyColor, vec3(0.92, 0.94, 0.95), 0.55);
          vec3 sky = mix(horizon, zenith, pow(clamp(R.y, 0.0, 1.0), 0.45));
          float sunHit = max(dot(R, normalize(uSunDir)), 0.0);
          sky += uSunColor * (pow(sunHit, 900.0) * 6.0 + pow(sunHit, 60.0) * 0.25);
          vec3 colour = mix(base, sky, clamp(fres * 1.15 + 0.08, 0.0, 0.92));

          // Flow made visible: light streaks carried downhill on wet slopes.
          // They are stretched along the flow and stronger where it is steep.
          vec4 flw = texture2D(uFlowTex, (vWorld.xz + uFlowHalf) / (2.0 * uFlowHalf));
          vec2 fd = flw.rg * 2.0 - 1.0;
          vec2 fdn = fd / max(length(fd), 1e-3);
          vec2 fAcross = vec2(-fdn.y, fdn.x);
          float streakNoise = texture2D(uFoamMap, vec2(dot(vWorld.xz, fAcross) * 0.045, dot(vWorld.xz, fdn) * 0.012 - uTime * 0.22)).r;
          float streakMask = smoothstep(0.5, 0.8, streakNoise) * flw.b * smoothstep(0.02, 0.15, vDepth);
          colour = mix(colour, colour * 1.35 + vec3(0.07, 0.08, 0.08), streakMask * 0.7);

          // Sun glint from a tight highlight lobe, widened when the wind
          // roughens the surface.
          vec3 h = normalize(normalize(uSunDir) + viewDir);
          float rough = mix(0.06, 0.22, clamp(length(uWind) / 14.0, 0.0, 1.0));
          float spec = pow(max(dot(N, h), 0.0), 1.0 / max(0.004, rough * rough));
          colour += uSunColor * spec * 2.4;

          // Foam belongs to the waterline, plus wind-blown crests offshore.
          float shore = 1.0 - smoothstep(0.01, 0.19, vDepth);
          vec2 foamUv = vUv * 0.09 + uWind * 0.004 * uTime * 0.5;
          float foamMask = texture2D(uFoamMap, foamUv).r;
          float crest = smoothstep(0.55, 0.95, foamMask) * smoothstep(0.25, 0.9, length(uWind) / 16.0);
          float foam = clamp(shore * uFoam * (0.45 + foamMask * 0.75), 0.0, 1.0) + crest * 0.4;
          colour = mix(colour, vec3(0.94, 0.96, 0.97), clamp(foam, 0.0, 1.0));

          // Rain dimples and dulls the surface.
          colour = mix(colour, vec3(0.5, 0.56, 0.62), uRain * 0.3);
          colour *= uTint;

          // Shallow water is clear enough to show the bed; deep water is opaque.
          // (Was inverted: deep water came out more transparent than shallow.)
          float alpha = mix(uOpacity * 0.55, min(0.97, uOpacity + 0.06), 1.0 - exp(-vDepth * 0.5));
          // The water's edge is a depth contour, but the mesh is still built on
          // a grid. Fading alpha over the first few centimetres of depth hides
          // that grid: the water thins into the bank rather than ending on it.
          alpha *= smoothstep(0.015, 0.2, vDepth);
          gl_FragColor = vec4(colour, clamp(alpha + foam * 0.4, 0.0, 1.0));
          #include <fog_fragment>
        }
      `,
    });

    this.water = new THREE.Mesh(this.waterGeo, waterMat);
    this.water.frustumCulled = false;
    this.water.renderOrder = 2;
    this.group.add(this.water);

    this.rebuildWater();
    this.refresh(true);
  }

  /**
   * Recompute splat weights, state tint and heights from the simulation.
   *
   * Nothing here is authored per location: every weight is a function of what
   * the world model says about that cell, so the picture changes when the model
   * does — as a drought spreads, as a fire scar ages, as a glacier retreats.
   */
  refresh(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastRefresh < 4000) return;
    this.lastRefresh = now;

    const world = this.world;
    const t = world.terrain;
    const layers = world.vegetation.plants.layers;
    const scar = world.fire.scar;
    const res = this.res;
    const step = this.step;
    const posAttr = this.geo.getAttribute('position') as THREE.BufferAttribute;

    const grass = layers[PLANT_INDEX.grass];
    const shrub = layers[PLANT_INDEX.shrub];
    const reed = layers[PLANT_INDEX.reed];
    const algae = layers[PLANT_INDEX.algae];
    const moss = layers[PLANT_INDEX.moss];
    const xeric = layers[PLANT_INDEX.xeric];

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const vi = j * res + i;
        const cx = Math.min(i * step, t.last);
        const cy = Math.min(j * step, t.last);
        const ci = cy * t.size + cx;
        const def = BIOMES[t.biome.data[ci] as Biome];

        posAttr.setY(vi, t.elevationOf(t.height.data[ci]));

        const snow = clamp01(t.snow.data[ci]);
        const mud = clamp01(t.mud.data[ci]);
        const ash = clamp01(scar.data[ci] * 1.2);
        const fertility = clamp01(t.fertility.data[ci]);
        const detritus = clamp01(t.detritus.data[ci]);
        const moisture = clamp01(t.soilMoisture.data[ci]);
        const biota = clamp01(t.soilBiota.data[ci]);
        const canopy = clamp01(t.canopy.data[ci]);
        const slope = clamp01(t.slope.data[ci] * 1.8);

        const gGrass = clamp01(grass.at(cx, cy));
        const gShrub = clamp01(shrub.at(cx, cy));
        const gReed = clamp01(reed.at(cx, cy));
        const gAlgae = clamp01(algae.at(cx, cy));
        const gMoss = clamp01(moss.at(cx, cy));
        const gXeric = clamp01(xeric.at(cx, cy));
        const biomass = clamp01(gGrass * 1.1 + gShrub * 0.8 + gReed * 0.9 + gXeric * 0.5);

        /* ---- which material is this ground made of? ---- */
        const snowW = clamp01(snow * 1.4);
        const rockW = clamp01((slope - 0.42) * 2.6) * (1 - snowW * 0.7);
        const bare = Math.max(0, 1 - rockW) * Math.max(0, 1 - snowW);
        const beach = def.id === Biome.Coast || def.id === Biome.Desert ? 0.85 : def.id === Biome.Steppe ? 0.25 : 0;
        const sandW = clamp01(beach * (1 - biomass * 1.3) * bare + clamp01(t.mud.data[ci] * 0.5) * bare * 0.3);
        const grassW = clamp01(biomass * 1.5) * bare;
        const dirtW = clamp01((1 - biomass * 1.6) * (1 - fertility) * 0.9 + detritus * 0.25) * bare;
        const mossW = clamp01(gMoss * 0.8 + moisture * fertility * (0.35 + canopy) * 1.1) * bare * (1 - snowW);

        this.splatA.setXYZW(vi, grassW, sandW, rockW, snowW);
        this.splatB.setXYZW(vi, dirtW, mossW, 0, 0);

        /* ---- what condition is that material in? ---- */
        // Drought yellows the pasture, water darkens it, mud browns it, and a
        // canopy above it quietly shades it.
        const dryness = clamp01(1 - moisture * 2.0);
        let tr = lerp(0.97, 1.14, dryness * 0.8);
        let tg = lerp(1.0, 1.06, dryness * 0.6);
        let tb = lerp(1.02, 0.72, dryness * 0.85);
        // Fertile, organic soil reads richer.
        const rich = 0.94 + fertility * 0.12 + biota * 0.06;
        tr *= rich;
        tg *= rich;
        tb *= rich * 0.98;
        // Mud and standing water.
        tr = lerp(tr, 0.86, mud * 0.6);
        tg = lerp(tg, 0.8, mud * 0.6);
        tb = lerp(tb, 0.72, mud * 0.6);
        // A burn scar is grey and lifeless for a long time.
        tr = lerp(tr, 0.62, ash * 0.8);
        tg = lerp(tg, 0.6, ash * 0.8);
        tb = lerp(tb, 0.58, ash * 0.8);
        // Waterlogged ground is darker and greener.
        const wet = clamp01((gAlgae + gReed) * 0.6 + moisture * 0.5);
        tr = lerp(tr, 0.78, wet * 0.35);
        tg = lerp(tg, 0.86, wet * 0.35);
        tb = lerp(tb, 0.76, wet * 0.35);

        // Deterministic per-cell jitter keeps neighbouring vertices from
        // reading as a flat wash once the texture is multiplied in.
        const jitter = 1 + ((Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1) * 0.06 - 0.03;
        this.tintAttr.setXYZ(vi, clamp(tr * jitter, 0, 2), clamp(tg * jitter, 0, 2), clamp(tb * jitter, 0, 2));
        this.plantAttr.setXYZ(vi, gGrass, detritus, gReed + gMoss * 0.5);
        this.aoAttr.setX(vi, canopy * 0.7);
      }
    }

    this.tintAttr.needsUpdate = true;
    this.plantAttr.needsUpdate = true;
    this.aoAttr.needsUpdate = true;
    this.splatA.needsUpdate = true;
    this.splatB.needsUpdate = true;
    posAttr.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }

  /**
   * Water surface height and thickness at a terrain position, in world units.
   * Sea cells are filled to sea level, which is the real surface of the sea.
   * Lakes and rivers sit on their bed plus the depth the hydrology holds, which
   * is in metres. Returns the surface height; thickness is surface minus bed.
   */
  surfaceAt(height: number, depthM: number): number {
    const t = this.world.terrain;
    const sea = t.params.seaLevel;
    if (height < sea) return t.elevationOf(sea);
    return t.elevationOf(height) + Math.max(0, depthM);
  }

  /** Wet mask for the simulation: 255 where a cell holds water, sea included. */
  private wetMask(): Uint8Array {
    const t = this.world.terrain;
    const sea = t.params.seaLevel;
    const h = t.height.data;
    const d = t.waterDepth.data;
    const mask = new Uint8Array(h.length);
    for (let i = 0; i < h.length; i++) mask[i] = h[i] < sea || d[i] > 0.012 ? 255 : 0;
    return mask;
  }

  /**
   * Per-cell water surface for the ground shader: R = wet, G = surface height
   * mapped into [yMin, yMax]. Sea and lakes both count; dry land is R = 0.
   */
  private updateWaterSurface(): void {
    const t = this.world.terrain;
    const n = t.size;
    const sea = t.params.seaLevel;
    const h = t.height.data;
    const d = t.waterDepth.data;
    const surf = new Float32Array(n * n);
    const wet = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      let s = 0;
      if (h[i] < sea) {
        s = t.elevationOf(sea);
        wet[i] = 1;
      } else if (d[i] > 0.012) {
        s = t.elevationOf(h[i]) + d[i];
        wet[i] = 1;
      }
      if (wet[i]) {
        surf[i] = s;
      }
    }
    this.updateFlow(wet, h);
    // Per-vertex copy for the ground shader, using the same vertex-to-cell map as
    // the terrain build. A vertex attribute costs no texture unit.
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const cx = Math.min(i * this.step, t.last);
        const cy = Math.min(j * this.step, t.last);
        const c = cy * n + cx;
        this.waterAttr.setXY(j * this.res + i, wet[c], surf[c]);
      }
    }
    this.waterAttr.needsUpdate = true;
  }

  /** Downhill direction and steepness per cell, for the water surface shader. */
  private updateFlow(wet: Uint8Array, h: Float32Array | Float64Array | ArrayLike<number>): void {
    const t = this.world.terrain;
    const n = t.size;
    const down = t.downhill;
    const bytes = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      let r = 128;
      let g = 128;
      let b = 0;
      const j = down.length ? down[i] : -1;
      if (wet[i] && j >= 0) {
        const dx = (j % n) - (i % n);
        const dy = Math.floor(j / n) - Math.floor(i / n);
        const len = Math.hypot(dx, dy) || 1;
        const grade = (t.elevationOf(h[i]) - t.elevationOf(h[j])) / (t.cellUnits * len);
        r = Math.round((dx / len) * 0.5 * 255 + 127.5);
        g = Math.round((dy / len) * 0.5 * 255 + 127.5);
        // Every wet cell that drains somewhere flows, even on gentle rivers:
        // the floor keeps the direction visible; steeper cells flow faster.
        b = Math.round(Math.min(1, Math.max(0.3, grade * 40)) * 255);
      }
      bytes[i * 4] = r;
      bytes[i * 4 + 1] = g;
      bytes[i * 4 + 2] = b;
      bytes[i * 4 + 3] = 255;
    }
    if (!this.flowTex) {
      this.flowTex = new THREE.DataTexture(bytes, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
      this.flowTex.magFilter = THREE.LinearFilter;
      this.flowTex.minFilter = THREE.LinearFilter;
      this.flowTex.wrapS = THREE.ClampToEdgeWrapping;
      this.flowTex.wrapT = THREE.ClampToEdgeWrapping;
      this.flowTex.generateMipmaps = false;
    } else {
      this.flowTex.image = { data: bytes, width: n, height: n };
    }
    this.flowTex.needsUpdate = true;
    this.uniforms.uFlowTex.value = this.flowTex;
    this.uniforms.uFlowHalf.value = t.half;
  }

  /** Rebuild the water surface geometry from the hydrology fields. */
  rebuildWater(): void {
    this.updateWaterSurface();
    const t = this.world.terrain;
    const n = t.size;
    const sea = t.params.seaLevel;
    const depthData = t.waterDepth.data;
    const heightData = t.height.data;
    // Each simulation cell is split into SUB x SUB quads. Surface height and
    // ground are interpolated between cell centres, so the shoreline follows a
    // smooth contour instead of stepping along the 2.5 m grid.
    const SUB = 3;
    const at = (data: ArrayLike<number>, x: number, y: number): number => {
      const cx = Math.min(n - 1, Math.max(0, x));
      const cy = Math.min(n - 1, Math.max(0, y));
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(n - 1, x0 + 1);
      const y1 = Math.min(n - 1, y0 + 1);
      const fx = cx - x0;
      const fy = cy - y0;
      const a = data[y0 * n + x0] * (1 - fx) + data[y0 * n + x1] * fx;
      const b = data[y1 * n + x0] * (1 - fx) + data[y1 * n + x1] * fx;
      return a * (1 - fy) + b * fy;
    };
    const isWetCell = (i: number) => heightData[i] < sea || depthData[i] > 0.012;
    const pos: number[] = [];
    const dep: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const c00 = j * n + i;
        const c10 = c00 + 1;
        const c01 = c00 + n;
        const c11 = c01 + 1;
        const wet = [isWetCell(c00), isWetCell(c10), isWetCell(c01), isWetCell(c11)];
        if (!wet.some(Boolean)) continue;
        const d00 = depthData[c00];
        const d10 = depthData[c10];
        const d01 = depthData[c01];
        const d11 = depthData[c11];
        // Coastlines and banks are subdivided. Open sea and deep, even lakes
        // stay one quad per cell, which keeps the mesh affordable.
        const coast = !wet.every(Boolean);
        const lo = Math.min(d00, d10, d01, d11);
        const hi = Math.max(d00, d10, d01, d11);
        const sub = coast || hi - lo > 0.05 ? SUB : 1;
        const stepN = 1 / sub;
        for (let sj = 0; sj < sub; sj++) {
          for (let si = 0; si < sub; si++) {
            const x0 = i + si * stepN;
            const y0 = j + sj * stepN;
            const x1 = x0 + stepN;
            const y1 = y0 + stepN;
            const quad: [number, number][] = [
              [x0, y0],
              [x1, y0],
              [x0, y1],
              [x1, y1],
            ];
            const base = pos.length / 3;
            quad.forEach(([x, y]) => {
              const bedH = at(heightData, x, y);
              const depthM = at(depthData, x, y);
              const surf = this.surfaceAt(bedH, depthM);
              const bedY = t.elevationOf(bedH);
              pos.push(t.cellToWorldX(x), surf, t.cellToWorldY(y));
              // Thickness of water over the bed, in metres. Drives absorption,
              // foam and the shoreline fade in the shader.
              dep.push(Math.max(0, surf - bedY));
            });
            idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          }
        }
      }
    }
    this.waterGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    this.waterGeo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    this.waterGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    this.waterGeo.computeBoundingSphere();

    // Keep the ripple simulation's wet mask and the rain targets in step.
    const mask = this.wetMask();
    const cells: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) cells.push(i);
    this.wetCells = Int32Array.from(cells);
    this.sim?.setMask(mask);
  }

  /**
   * Attach the GPU ripple simulation. Called once the renderer exists. Without
   * float render targets the water keeps its analytic waves and nothing else.
   */
  attachRenderer(renderer: THREE.WebGLRenderer): void {
    if (!WaterSim.supported(renderer)) return;
    const t = this.world.terrain;
    this.sim = new WaterSim(renderer, t.size, this.wetMask());
    const u = this.uniforms;
    u.uSim.value = this.sim.texture;
    u.uSimOrigin.value = new THREE.Vector2(-t.half, -t.half);
    u.uSimSize.value = t.worldSize;
    u.uSimCell.value = t.cellUnits;
    u.uSimTexel.value = 1 / t.size;
    this.wasInWater = new Uint8Array(this.world.creatures.capacity);
    this.lastDisturbX = new Float32Array(this.world.creatures.capacity);
    this.lastDisturbY = new Float32Array(this.world.creatures.capacity);
  }

  /**
   * Feed the ripple simulation with real events and advance it. Rain falls on
   * wet cells at the simulated rainfall rate. Animals that enter water make a
   * splash, and swimmers push the surface as they move. Nothing here is random
   * beyond where the rain lands, and that is drawn from the rain rate.
   */
  stepWater(rain: number, dt: number): void {
    const sim = this.sim;
    if (!sim) return;
    const t = this.world.terrain;
    const c = this.world.creatures;

    // Rain: expected drops this frame scale with the simulated rainfall rate.
    const expected = clamp01(rain) * 40 * dt;
    let drops = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    if (this.wetCells.length) {
      while (drops-- > 0) {
        const cell = this.wetCells[Math.floor(Math.random() * this.wetCells.length)];
        sim.disturb(cell % t.size, Math.floor(cell / t.size), 1.2, -0.03);
      }
    }

    // Animals: splash on entry, ripple while moving through the water.
    let budget = 48;
    for (let s = 0; s < c.capacity && budget > 0; s++) {
      if (!c.alive[s]) {
        this.wasInWater[s] = 0;
        continue;
      }
      const sp = SPECIES[c.speciesIdx[s]];
      const cx = t.worldToCellX(c.x[s]);
      const cy = t.worldToCellY(c.y[s]);
      const ci = Math.min(t.size - 1, Math.max(0, Math.round(cx)));
      const cj = Math.min(t.size - 1, Math.max(0, Math.round(cy)));
      const cell = cj * t.size + ci;
      const bedH = t.height.data[cell];
      const depthM = t.waterDepth.data[cell];
      const surf = this.surfaceAt(bedH, depthM);
      const thickness = surf - t.elevationOf(bedH);
      // In water if the surface is above the body and the water is at least
      // a few centimetres deep here. Flyers never touch the surface.
      const inWater = !c.flying[s] && thickness > 0.05 && c.z[s] < surf + 0.05;
      const radius = clamp(sp.bodyLength * 0.5 / t.cellUnits, 0.8, 4);
      const size = clamp(sp.bodyLength / 2, 0.2, 2);
      if (inWater && !this.wasInWater[s]) {
        sim.disturb(cx, cy, radius * 1.4, -0.12 * size);
        this.lastDisturbX[s] = c.x[s];
        this.lastDisturbY[s] = c.y[s];
        budget--;
      } else if (inWater) {
        const dx = c.x[s] - this.lastDisturbX[s];
        const dy = c.y[s] - this.lastDisturbY[s];
        if (dx * dx + dy * dy > 1.5 * 1.5) {
          sim.disturb(cx, cy, radius, -0.04 * size);
          this.lastDisturbX[s] = c.x[s];
          this.lastDisturbY[s] = c.y[s];
          budget--;
        }
      }
      this.wasInWater[s] = inWater ? 1 : 0;
    }

    sim.step(2);
    this.uniforms.uSim.value = sim.texture;
  }

  /** Per-frame water and ground animation, driven by the real wind and rain. */
  update(sunDir: THREE.Vector3, sunColor: THREE.Color, skyColor: THREE.Color, windSpeed: number, windDir: number, rain: number, dtSeconds: number, ash: number): void {
    const u = this.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    (u.uSkyColor.value as THREE.Color).copy(skyColor);
    u.uTime.value += dtSeconds;
    (u.uWind.value as THREE.Vector2).set(Math.cos(windDir) * windSpeed, Math.sin(windDir) * windSpeed);
    u.uWave.value = 0.35 + clamp(windSpeed, 0, 20) * 0.09;
    u.uFoam.value = 0.42 + clamp01(windSpeed / 18) * 0.5;
    u.uRain.value = clamp01(rain);
    // Rain and wind stir the surface; the ripples run downstream of the wind.
    (u.uFlow.value as THREE.Vector2).set(Math.cos(windDir) * 0.02, Math.sin(windDir) * 0.02);
    (u.uTint.value as THREE.Color).setRGB(lerp(1, 0.9, clamp01(rain)), lerp(1, 0.93, clamp01(rain)), lerp(1, 0.98, clamp01(rain)));

    const g = this.groundUniforms;
    g.uTime.value += dtSeconds;
    (g.uWind.value as THREE.Vector2).set(Math.cos(windDir) * windSpeed * 0.6, Math.sin(windDir) * windSpeed * 0.6);
    g.uAsh.value = clamp01(ash);
    // Wetness is the actual rainfall over the ground plus the standing soil
    // moisture, so ground darkens where it has really rained.
    const here = this.world.climate.rainAt(0, 0);
    g.uWetness.value = clamp01(rain * 1.4 + here * 0.6);
    // Very bright or very dark weather is compensated for, so a grey day still
    // shows the material rather than a flat wash of shadow.
    g.uExposure.value = clamp(1.12 + (1 - clamp01(rain)) * 0.08, 1.0, 1.25);
  }

  dispose(): void {
    this.geo.dispose();
    this.waterGeo.dispose();
    (this.ground.material as THREE.Material).dispose();
    (this.water.material as THREE.Material).dispose();
  }
}

export type { TerrainOptions };
