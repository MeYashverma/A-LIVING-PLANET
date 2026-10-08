import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math';
import { BIOMES, Biome, PLANT_INDEX } from '../world/biomes';
import type { World } from '../world/world';
import type { TextureLibrary } from './textures';
import { createGroundMaterial, type SplatUniforms } from './terrainGround';

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
  private uniforms: WaterUniforms;
  private lastRefresh = -1e9;

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
      uWave: { value: 0.35 },
      uWind: { value: new THREE.Vector2(0.4, 0.2) },
      uFoam: { value: 0.6 },
      uRain: { value: 0 },
      uOpacity: { value: 0.9 },
      uNormalMap: { value: opts.textures.waterNormal },
      uFoamMap: { value: opts.textures.foam },
      uFlow: { value: new THREE.Vector2(0.03, 0.02) },
      uTint: { value: new THREE.Color(0xffffff) },
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
        varying float vDepth;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        varying vec2 vUv;
        void main() {
          vec3 p = position;
          // Long swells travel with the wind; their amplitude grows with fetch
          // and depth so a shallow run is nearly flat and open water is not.
          float amp = uWave * (0.04 + clamp(aDepth, 0.0, 3.0) * 0.05);
          vec2 dir = normalize(uWind + vec2(0.001));
          float k1 = dot(p.xz, dir) * 0.11 + uTime * 0.9;
          float k2 = dot(p.xz, vec2(-dir.y, dir.x)) * 0.17 - uTime * 0.6;
          float k3 = dot(p.xz, dir) * 0.31 + uTime * 1.7;
          p.y += sin(k1) * amp + sin(k2) * amp * 0.6 + sin(k3) * amp * 0.28;
          vec3 n = normalize(vec3(
            -cos(k1) * amp * 0.11 * dir.x - cos(k2) * amp * 0.17 * -dir.y - cos(k3) * amp * 0.31 * dir.x,
            1.0,
            -cos(k1) * amp * 0.11 * dir.y - cos(k2) * amp * 0.17 * dir.x - cos(k3) * amp * 0.31 * dir.y
          ));
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
        uniform sampler2D uNormalMap;
        uniform sampler2D uFoamMap;
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
          float fade = 1.0 - smoothstep(60.0, 240.0, dist);
          vec2 flow = uWind * 0.004 + uFlow;
          vec2 uv1 = vUv * 0.055 + flow * uTime;
          vec2 uv2 = vUv * 0.021 - flow * uTime * 1.7 + vec2(0.37, 0.11);
          vec3 n1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
          vec3 detail = normalize(vec3(n1.xy * 0.75 + n2.xy * 0.5, 1.0));
          float scale = clamp(vDepth * 1.2, 0.15, 1.0) * fade;
          return normalize(N + vec3(detail.x, 0.0, detail.y) * scale * 0.9);
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 N = rippleNormal(normalize(vNormalW), viewDir);

          // Depth-based absorption: shallow water shows the bed, deep water
          // swallows every colour except blue-green, as water actually does.
          float depth = clamp(vDepth, 0.0, 1.0);
          vec3 base = mix(uShallow, uDeep, pow(depth, 0.55));

          // Fresnel, with water's real reflectance at normal incidence.
          float cosI = clamp(dot(viewDir, N), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);
          vec3 sky = uSkyColor;
          vec3 colour = mix(base, sky, clamp(fres * 1.15, 0.0, 0.92));

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
          float alpha = mix(uOpacity * 0.6, min(0.97, uOpacity + 0.06), depth);
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

  /** Rebuild the water surface geometry from the hydrology fields. */
  rebuildWater(): void {
    const t = this.world.terrain;
    const n = t.size;
    const depthData = t.waterDepth.data;
    const heightData = t.height.data;
    // Each simulation cell is split into SUB x SUB quads. Depth and ground are
    // interpolated between cell centres, so the shoreline follows a smooth
    // contour instead of stepping along the 2.5 m grid. The simulation itself
    // is unchanged: this only changes how its fields are drawn.
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
    const pos: number[] = [];
    const dep: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const d00 = depthData[j * n + i];
        const d10 = depthData[j * n + i + 1];
        const d01 = depthData[(j + 1) * n + i];
        const d11 = depthData[(j + 1) * n + i + 1];
        if (d00 < 0.012 && d10 < 0.012 && d01 < 0.012 && d11 < 0.012) continue;
        // Only shorelines and banks need subdividing. Deep, even water and dry
        // ground stay one quad per cell, which keeps the mesh affordable.
        const lo = Math.min(d00, d10, d01, d11);
        const hi = Math.max(d00, d10, d01, d11);
        const shore = lo < 0.012 || hi - lo > 0.05;
        const sub = shore ? SUB : 1;
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
            const depths = quad.map(([x, y]) => at(depthData, x, y));
            if (depths.every((d) => d < 0.012)) continue;
            const base = pos.length / 3;
            quad.forEach(([x, y], k) => {
              const depth = Math.max(0.02, depths[k]);
              const ground = t.elevationOf(at(heightData, x, y));
              pos.push(t.cellToWorldX(x), ground + depth, t.cellToWorldY(y));
              dep.push(depth);
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
  }

  /** Per-frame water and ground animation, driven by the real wind and rain. */
  update(sunDir: THREE.Vector3, sunColor: THREE.Color, skyColor: THREE.Color, windSpeed: number, windDir: number, rain: number, dtSeconds: number, ash: number): void {
    const u = this.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    (u.uSkyColor.value as THREE.Color).copy(skyColor);
    u.uTime.value += dtSeconds;
    (u.uWind.value as THREE.Vector2).set(Math.cos(windDir) * windSpeed, Math.sin(windDir) * windSpeed);
    u.uWave.value = 0.16 + clamp(windSpeed, 0, 20) * 0.055;
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
