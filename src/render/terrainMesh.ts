import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math';
import { BIOMES, Biome, PLANT_INDEX } from '../world/biomes';
import type { World } from '../world/world';

interface TerrainOptions {
  resolution: number;
  shadows: boolean;
}

interface GrassUniforms {
  [key: string]: THREE.IUniform;
}

/**
 * The ground. A single mesh whose colour is derived from the simulation: live
 * plant biomass per layer, soil moisture and fertility, snow, mud, fire scars
 * and canopy shading all feed the vertex colours, which are re-uploaded as the
 * ecosystem changes. A GPU detail layer adds grass clumps and wind above them.
 */
export class TerrainMesh {
  readonly group = new THREE.Group();
  readonly ground: THREE.Mesh;
  readonly water: THREE.Mesh;

  private step: number;
  private res: number;
  private geo: THREE.BufferGeometry;
  private waterGeo: THREE.BufferGeometry;
  private colorAttr: THREE.BufferAttribute;
  private plantAttr: THREE.BufferAttribute;
  private aoAttr: THREE.BufferAttribute;
  private groundUniforms: GrassUniforms | null = null;
  private uniforms: Record<string, THREE.IUniform>;
  private lastRefresh = -1e9;

  constructor(private world: World, opts: TerrainOptions) {
    const t = world.terrain;
    this.step = Math.max(1, Math.floor((t.size - 1) / (opts.resolution - 1)));
    this.res = Math.floor((t.size - 1) / this.step) + 1;

    const verts = this.res * this.res;
    const position = new Float32Array(verts * 3);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.plantAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.aoAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);

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
    this.geo.setAttribute('color', this.colorAttr);
    this.geo.setAttribute('aPlant', this.plantAttr);
    this.geo.setAttribute('aAO', this.aoAttr);
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uWind = { value: new THREE.Vector2(0, 0) };
      shader.uniforms.uAsh = { value: 0 };
      this.groundUniforms = shader.uniforms as GrassUniforms;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec3 aPlant;
          attribute float aAO;
          varying vec3 vPlant;
          varying float vAO;
          varying vec3 vPos;
        `,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          float micro = sin(position.x * 1.7 + position.z * 2.3) * 0.5 + sin(position.x * 0.31 - position.z * 0.57) * 0.5;
          transformed.y += micro * 0.12;
          vPlant = aPlant;
          vAO = aAO;
          vPos = position;
        `,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying vec3 vPlant;
          varying float vAO;
          varying vec3 vPos;
          uniform float uTime;
          uniform vec2 uWind;
          uniform float uAsh;

          float hash21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

          vec3 groundDetail(vec3 albedo) {
            vec2 cell = vPos.xz * 0.7;
            vec2 f = fract(cell);
            vec2 id = floor(cell);
            float r = hash21(id);
            float clump = 0.88 + r * 0.26;
            vec3 c = albedo * clump;
            // Blade streaks bending with the real wind vector.
            float sway = dot(uWind, vec2(0.02, 0.013)) * sin(uTime * 0.8 + r * 6.28);
            float blade = smoothstep(0.32, 0.96, f.y + sin((f.x + r) * 9.0 + sway) * 0.14);
            float vigour = clamp(vPlant.x + vPlant.z * 0.7 + vPlant.y * 0.5, 0.0, 1.5);
            c = mix(c * 0.92, c * 1.16, blade * clamp(0.3 + vigour, 0.0, 1.0));
            // Litter dulls the space between tufts.
            c *= 1.0 - clamp(vPlant.y - vPlant.x, 0.0, 1.0) * 0.16;
            return c;
          }
        `,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          diffuseColor.rgb = groundDetail(diffuseColor.rgb);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.29, 0.28), uAsh * 0.55);
          diffuseColor.rgb *= mix(1.0, 0.6, clamp(vAO, 0.0, 1.0));
        `,
        );
    };
    material.customProgramCacheKey = () => 'terrain-ground-v1';

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
      uDeep: { value: new THREE.Color(0x0a2233) },
      uShallow: { value: new THREE.Color(0x2f6f74) },
      uWave: { value: 0.35 },
      uWind: { value: new THREE.Vector2(0.4, 0.2) },
      uFoam: { value: 0.6 },
      uRain: { value: 0 },
      uOpacity: { value: 0.86 },
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
        void main() {
          vec3 p = position;
          float w = uWave * (0.05 + clamp(aDepth, 0.0, 2.0) * 0.045);
          float phase = p.x * 0.22 + p.z * 0.31 + uTime * 1.1;
          float phase2 = p.x * -0.13 + p.z * 0.44 + uTime * 0.7;
          p.y += sin(phase) * w + sin(phase2) * w * 0.7;
          vec3 n = normalize(vec3(
            -cos(phase) * w * 0.22 - cos(phase2) * w * 0.13,
            1.0,
            -cos(phase) * w * 0.31 + cos(phase2) * w * 0.44
          ));
          vDepth = aDepth;
          vWorld = p;
          vNormalW = n;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uSunDir, uSunColor, uSkyColor, uDeep, uShallow;
        uniform float uTime, uFoam, uRain, uOpacity;
        uniform vec2 uWind;
        varying float vDepth;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float depthFade = clamp(vDepth * 1.5, 0.0, 1.0);
          vec3 base = mix(uShallow, uDeep, depthFade);
          float ripple = sin(vWorld.x * 2.4 + uTime * 3.1) * cos(vWorld.z * 2.1 - uTime * 2.4) * 0.5 + 0.5;
          vec3 n = normalize(vNormalW + vec3(ripple - 0.5, 0.0, ripple - 0.5) * 0.25 * clamp(vDepth, 0.0, 1.0));
          float fres = pow(clamp(1.0 - max(dot(viewDir, n), 0.0), 0.0, 1.0), 3.0);
          vec3 colour = mix(base, uSkyColor, clamp(fres * 1.25, 0.0, 0.85));
          vec3 h = normalize(normalize(uSunDir) + viewDir);
          colour += uSunColor * pow(max(dot(n, h), 0.0), 260.0) * 1.6;
          // Foam belongs to the waterline only: a river a few centimetres deep
          // must not read as a ribbon of surf.
          float shore = 1.0 - smoothstep(0.004, 0.13, vDepth);
          float crest = smoothstep(0.86, 1.0, ripple) * clamp(length(uWind) * 0.06, 0.0, 0.35);
          colour = mix(colour, vec3(0.9, 0.93, 0.95), clamp(shore * uFoam * 0.85 + crest, 0.0, 1.0));
          colour = mix(colour, vec3(0.55, 0.6, 0.66), uRain * 0.25);
          gl_FragColor = vec4(colour, mix(uOpacity, 0.95, clamp(shore, 0.0, 1.0)));
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

  /** Recompute vertex colours and heights from the current simulation state. */
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

    const coverColor = new THREE.Color();
    const green = new THREE.Color(0.24, 0.42, 0.14);
    const dryGreen = new THREE.Color(0.5, 0.48, 0.22);
    const shrubColor = new THREE.Color(0.19, 0.3, 0.13);
    const reedColor = new THREE.Color(0.42, 0.46, 0.2);
    const algaeColor = new THREE.Color(0.2, 0.34, 0.22);
    const mossColor = new THREE.Color(0.24, 0.33, 0.17);
    const xericColor = new THREE.Color(0.44, 0.42, 0.22);
    const rockColor = new THREE.Color(0.36, 0.35, 0.33);
    const snowColor = new THREE.Color(0.93, 0.95, 0.99);
    const mudColor = new THREE.Color(0.25, 0.2, 0.14);
    const ashColor = new THREE.Color(0.19, 0.18, 0.17);
    const tmp = new THREE.Color();

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

        const posY = t.elevationOf(t.height.data[ci]);
        posAttr.setY(vi, posY);

        const snow = clamp01(t.snow.data[ci]);
        const mud = clamp01(t.mud.data[ci]);
        const ash = clamp01(scar.data[ci] * 1.2);
        const fertility = clamp01(t.fertility.data[ci]);
        const detritus = clamp01(t.detritus.data[ci]);
        const moisture = clamp01(t.soilMoisture.data[ci]);
        const biota = clamp01(t.soilBiota.data[ci]);
        const canopy = clamp01(t.canopy.data[ci]);

        const gGrass = clamp01(grass.at(cx, cy));
        const gShrub = clamp01(shrub.at(cx, cy));
        const gReed = clamp01(reed.at(cx, cy));
        const gAlgae = clamp01(algae.at(cx, cy));
        const gMoss = clamp01(moss.at(cx, cy));
        const gXeric = clamp01(xeric.at(cx, cy));

        // Soil base colour, darkened by organic matter and damped where wet.
        let r = def.soil[0];
        let g = def.soil[1];
        let b = def.soil[2];
        const organic = clamp01(detritus * 0.7 + biota * 0.5);
        r *= lerp(1, 0.62, organic * 0.8);
        g *= lerp(1, 0.58, organic * 0.8);
        b *= lerp(1, 0.55, organic * 0.8);
        const wet = clamp01(moisture * 1.1);
        r *= lerp(1.06, 0.72, wet);
        g *= lerp(1.04, 0.74, wet);
        b *= lerp(1.0, 0.78, wet);
        const fertBoost = 0.86 + fertility * 0.22;
        r *= fertBoost;
        g *= fertBoost;
        b *= fertBoost;

        // Live vegetation paint.
        const vigour = clamp01(gGrass * 1.2);
        coverColor.copy(green).lerp(dryGreen, clamp01(1 - moisture * 1.6) * 0.8);
        r = lerp(r, coverColor.r * 0.95, vigour * 0.82);
        g = lerp(g, coverColor.g, vigour * 0.82);
        b = lerp(b, coverColor.b * 0.9, vigour * 0.82);
        r = lerp(r, shrubColor.r, gShrub * 0.55);
        g = lerp(g, shrubColor.g, gShrub * 0.55);
        b = lerp(b, shrubColor.b, gShrub * 0.55);
        r = lerp(r, reedColor.r, gReed * 0.6);
        g = lerp(g, reedColor.g, gReed * 0.6);
        b = lerp(b, reedColor.b, gReed * 0.6);
        r = lerp(r, algaeColor.r, gAlgae * 0.5);
        g = lerp(g, algaeColor.g, gAlgae * 0.5);
        b = lerp(b, algaeColor.b, gAlgae * 0.5);
        r = lerp(r, mossColor.r, gMoss * 0.5);
        g = lerp(g, mossColor.g, gMoss * 0.5);
        b = lerp(b, mossColor.b, gMoss * 0.5);
        r = lerp(r, xericColor.r, gXeric * 0.4);
        g = lerp(g, xericColor.g, gXeric * 0.4);
        b = lerp(b, xericColor.b, gXeric * 0.4);

        // Bare rock on steep ground.
        const slope = clamp01(t.slope.data[ci] * 1.6);
        const rock = clamp01(slope * 1.1 + (def.id === Biome.Alpine ? 0.45 : 0) + (def.id === Biome.Snow ? 0.3 : 0)) * 0.7;
        r = lerp(r, rockColor.r, rock);
        g = lerp(g, rockColor.g, rock);
        b = lerp(b, rockColor.b, rock);

        // Snow, mud and burn scars on top of everything.
        r = lerp(r, snowColor.r, snow);
        g = lerp(g, snowColor.g, snow);
        b = lerp(b, snowColor.b, snow);
        r = lerp(r, mudColor.r, mud * 0.75);
        g = lerp(g, mudColor.g, mud * 0.75);
        b = lerp(b, mudColor.b, mud * 0.75);
        r = lerp(r, ashColor.r, ash * 0.85);
        g = lerp(g, ashColor.g, ash * 0.85);
        b = lerp(b, ashColor.b, ash * 0.85);

        // Break up any tiling with a deterministic per-cell variation.
        const jitter = 1 + ((Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453) % 1) * 0.07 - 0.035;
        tmp.setRGB(Math.max(0, r * jitter), Math.max(0, g * jitter), Math.max(0, b * jitter));
        tmp.convertSRGBToLinear();
        this.colorAttr.setXYZ(vi, tmp.r, tmp.g, tmp.b);
        this.plantAttr.setXYZ(vi, gGrass, detritus, gReed + gMoss * 0.5);
        this.aoAttr.setX(vi, canopy * 0.7);
      }
    }

    this.colorAttr.needsUpdate = true;
    this.plantAttr.needsUpdate = true;
    this.aoAttr.needsUpdate = true;
    posAttr.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }

  /** Rebuild the water surface geometry from the hydrology fields. */
  rebuildWater(): void {
    const t = this.world.terrain;
    const pos: number[] = [];
    const dep: number[] = [];
    const idx: number[] = [];
    const map = new Map<number, number>();
    for (let j = 0; j < t.size - 1; j++) {
      for (let i = 0; i < t.size - 1; i++) {
        const d00 = t.waterDepth.data[j * t.size + i];
        const d10 = t.waterDepth.data[j * t.size + i + 1];
        const d01 = t.waterDepth.data[(j + 1) * t.size + i];
        const d11 = t.waterDepth.data[(j + 1) * t.size + i + 1];
        if (d00 < 0.012 && d10 < 0.012 && d01 < 0.012 && d11 < 0.012) continue;
        const corners: [number, number][] = [
          [i, j],
          [i + 1, j],
          [i, j + 1],
          [i + 1, j + 1],
        ];
        const ids: number[] = [];
        for (const [ci, cj] of corners) {
          const key = cj * t.size + ci;
          let id = map.get(key);
          if (id === undefined) {
            id = dep.length;
            map.set(key, id);
            const depth = Math.max(0.02, t.waterDepth.data[key]);
            pos.push(t.cellToWorldX(ci), t.elevationOf(t.height.data[key]) + depth, t.cellToWorldY(cj));
            dep.push(depth);
          }
          ids.push(id);
        }
        idx.push(ids[0], ids[2], ids[1], ids[1], ids[2], ids[3]);
      }
    }
    this.waterGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    this.waterGeo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    this.waterGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    this.waterGeo.computeBoundingSphere();
  }

  /** Per-frame water/grass animation. */
  update(sunDir: THREE.Vector3, sunColor: THREE.Color, skyColor: THREE.Color, windSpeed: number, windDir: number, rain: number, dtSeconds: number, ash: number): void {
    const u = this.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    (u.uSkyColor.value as THREE.Color).copy(skyColor);
    u.uTime.value += dtSeconds;
    (u.uWind.value as THREE.Vector2).set(Math.cos(windDir) * windSpeed, Math.sin(windDir) * windSpeed);
    u.uWave.value = 0.18 + clamp(windSpeed, 0, 20) * 0.05;
    u.uFoam.value = 0.45 + clamp01(windSpeed / 18) * 0.5;
    u.uRain.value = clamp01(rain);
    if (this.groundUniforms) {
      this.groundUniforms.uTime.value += dtSeconds;
      (this.groundUniforms.uWind.value as THREE.Vector2).set(Math.cos(windDir) * windSpeed * 0.6, Math.sin(windDir) * windSpeed * 0.6);
      this.groundUniforms.uAsh.value = clamp01(ash);
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.waterGeo.dispose();
    (this.ground.material as THREE.Material).dispose();
    (this.water.material as THREE.Material).dispose();
  }
}

export type { TerrainOptions };
