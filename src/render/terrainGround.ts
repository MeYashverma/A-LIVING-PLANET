import * as THREE from 'three';
import type { MaterialSet } from './textures';

/**
 * The ground material.
 *
 * The terrain is one mesh carrying a splat weight per vertex for the four
 * surface materials the world is made of — grass, sand, rock and snow — plus a
 * second pair (dirt, moss) that contribute colour only. Those weights are not
 * painted: they are computed from the simulation (biomass, slope, moisture,
 * fertility, snow depth, fire scars), which is why a drought yellows the
 * pasture and a burn leaves grey ground for a season.
 *
 * Maps are sampled triplanar-ly so cliffs do not smear, the blended tangent
 * normals use the whiteout technique, and macro variation hides both the
 * tiling of the textures and the coarseness of the mesh.
 */

export interface SplatUniforms {
  [key: string]: THREE.IUniform;
}

export interface GroundTextures {
  /** Materials carrying albedo, normal and roughness. */
  core: [MaterialSet, MaterialSet, MaterialSet, MaterialSet];
  /** Materials contributing colour only, for soil and moss. */
  tint: [MaterialSet, MaterialSet];
}

const CORE = ['uGrass', 'uSand', 'uRock', 'uSnow'];
const TINT = ['uDirt', 'uMoss'];

/** The whiteout blend: the correct way to mix triplanar normals. */
const TRIPLANAR_NORMAL = /* glsl */ `
  vec2 triplanarUV(vec3 p, vec3 n) {
    float ax = abs(n.x), ay = abs(n.y), az = abs(n.z);
    if (ay >= ax && ay >= az) return p.xz * uScale;
    if (ax >= az) return p.zy * uScale;
    return p.xy * uScale;
  }

  /**
   * A blended world-space normal from the three axis projections. The swizzles
   * map each projection's tangent axes onto world axes, and the whiteout blend
   * combines them without the flattening a naive average gives on 45-degree
   * slopes.
   */
  vec3 triplanarNormal(sampler2D map, vec3 p, vec3 N) {
    vec3 w = pow(abs(N), vec3(4.0));
    w /= max(1e-4, w.x + w.y + w.z);
    vec3 nX = texture2D(map, p.zy * uScale).xyz * 2.0 - 1.0;
    vec3 nY = texture2D(map, p.xz * uScale).xyz * 2.0 - 1.0;
    vec3 nZ = texture2D(map, p.xy * uScale).xyz * 2.0 - 1.0;
    nX = vec3(nX.z, nX.y, nX.x);
    nY = vec3(nY.x, nY.z, nY.y);
    nZ = vec3(nZ.x, nZ.y, nZ.z);
    vec3 rX = vec3(nX.xy + N.zy, abs(nX.z) * N.x);
    vec3 rY = vec3(nY.xz + N.xz, abs(nY.y) * N.y);
    vec3 rZ = vec3(nZ.xy + N.xy, abs(nZ.z) * N.z);
    return normalize(rX * w.x + rY * w.y + rZ * w.z);
  }
`;

export function createGroundMaterial(tex: GroundTextures, opts: { triplanar: boolean }): {
  material: THREE.MeshStandardMaterial;
  uniforms: SplatUniforms;
} {
  const uniforms: SplatUniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(0, 0) },
    uAsh: { value: 0 },
    // World units per texture tile. Small values tile more often; the macro
    // noise is what stops that reading as a repeating pattern.
    uScale: { value: 0.075 },
    uNormalStrength: { value: 1.0 },
    uWetness: { value: 0 },
    // Scanned albedo is darker than the flat colours it replaced, so the ground
    // is lifted slightly. The per-material gains in fetch-assets.mjs are what
    // keep biomes consistent with each other; this is the final trim.
    uExposure: { value: 1.12 },
  };
  tex.core.forEach((set, i) => {
    uniforms[`${CORE[i]}C`] = { value: set.color };
    uniforms[`${CORE[i]}N`] = { value: set.normal };
    uniforms[`${CORE[i]}R`] = { value: set.rough };
  });
  tex.tint.forEach((set, i) => {
    uniforms[`${TINT[i]}C`] = { value: set.color };
  });

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec3 aPlant;
        attribute float aAO;
        attribute vec4 aSplatA;
        attribute vec4 aSplatB;
        varying vec3 vPlant;
        varying float vAO;
        varying vec3 vWorld;
        varying vec3 vWNormal;
        varying vec4 vSplatA;
        varying vec4 vSplatB;
      `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        // A little geometric relief so the silhouette of a hill is not a
        // perfectly smooth plane.
        float macro = sin(position.x * 0.043 + position.z * 0.031) * 0.5 + sin(position.x * 0.011 - position.z * 0.017) * 0.5;
        transformed.y += macro * 0.35;
        vPlant = aPlant;
        vAO = aAO;
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * normal);
        vSplatA = aSplatA;
        vSplatB = aSplatB;
      `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vPlant;
        varying float vAO;
        varying vec3 vWorld;
        varying vec3 vWNormal;
        varying vec4 vSplatA;
        varying vec4 vSplatB;
        uniform float uTime;
        uniform float uScale;
        uniform float uNormalStrength;
        uniform float uWetness;
        uniform float uExposure;
        uniform float uAsh;
        uniform vec2 uWind;
        ${CORE.map((n) => `uniform sampler2D ${n}C;\nuniform sampler2D ${n}N;\nuniform sampler2D ${n}R;`).join('\n')}
        ${TINT.map((n) => `uniform sampler2D ${n}C;`).join('\n')}

        float hash21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

        /** Value noise, used for macro variation that hides texture tiling. */
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbm2(vec2 p) {
          return vnoise(p) * 0.55 + vnoise(p * 2.3) * 0.28 + vnoise(p * 5.1) * 0.17;
        }

        ${TRIPLANAR_NORMAL}

        /** Albedo sampled in the three axis projections and blended by slope. */
        vec3 triplanarColor(sampler2D map, vec3 p, vec3 n) {
          vec3 w = pow(abs(n), vec3(4.0));
          w /= max(1e-4, w.x + w.y + w.z);
          return texture2D(map, p.zy * uScale).rgb * w.x
               + texture2D(map, p.xz * uScale).rgb * w.y
               + texture2D(map, p.xy * uScale).rgb * w.z;
        }
      `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          vec3 N = vWNormal;
          vec4 sa = max(vSplatA, vec4(0.0));
          vec4 sb = max(vSplatB, vec4(0.0));
          float sum = sa.x + sa.y + sa.z + sa.w + sb.x + sb.y;
          if (sum < 1e-3) { sa = vec4(0.0, 0.0, 1.0, 0.0); sum = 1.0; }
          sa /= sum; sb /= sum;

          vec3 albedo = vec3(0.0);
          albedo += triplanarColor(uGrassC, vWorld, N) * sa.x;
          albedo += triplanarColor(uSandC, vWorld, N) * sa.y;
          albedo += triplanarColor(uRockC, vWorld, N) * sa.z;
          albedo += triplanarColor(uSnowC, vWorld, N) * sa.w;
          albedo += triplanarColor(uDirtC, vWorld, N) * sb.x;
          albedo += triplanarColor(uMossC, vWorld, N) * sb.y;

          // Macro variation: a slow noise field shifting hue and value, so the
          // eye cannot lock onto the repeat of a tiled scan.
          float macro = fbm2(vWorld.xz * 0.0055);
          float macro2 = fbm2(vWorld.xz * 0.019 + 13.7);
          albedo *= mix(0.84, 1.16, macro);
          albedo *= mix(vec3(0.94, 0.99, 0.90), vec3(1.07, 1.02, 0.95), macro2);

          // The simulation's own state tints the material. It arrives as the
          // mesh's vertex colour, which three multiplies into diffuseColor
          // after this chunk, so it is deliberately not applied twice here:
          // live biomass greens it, damp ground darkens it, a burn scar greys
          // it out. The textures supply the material, the model supplies the
          // condition.
          albedo *= mix(1.0, 0.74, uWetness * 0.6);
          albedo = mix(albedo, vec3(0.26, 0.25, 0.24), uAsh * 0.5);
          albedo *= mix(1.0, 0.52, clamp(vAO, 0.0, 1.0));

          diffuseColor.rgb *= albedo * uExposure;
        }
      `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        {
          vec3 N = vWNormal;
          vec4 sa = max(vSplatA, vec4(0.0));
          float sum = sa.x + sa.y + sa.z + sa.w;
          if (sum > 1e-3) {
            sa /= sum;
            float r = 0.0;
            vec2 uv = triplanarUV(vWorld, N);
            r += texture2D(uGrassR, uv).r * sa.x;
            r += texture2D(uSandR, uv).r * sa.y;
            r += texture2D(uRockR, uv).r * sa.z;
            r += texture2D(uSnowR, uv).r * sa.w;
            // Wet ground is smoother, snow reflects more evenly.
            roughnessFactor = clamp(r * 1.12 - uWetness * 0.20 - sa.w * 0.08, 0.05, 1.0);
          }
        }
      `,
      );

    if (opts.triplanar) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        {
          vec3 N = normalize(vWNormal);
          vec4 sa = max(vSplatA, vec4(0.0));
          float sum = sa.x + sa.y + sa.z + sa.w;
          if (sum > 1e-3) {
            sa /= sum;
            vec3 nW = vec3(0.0);
            nW += triplanarNormal(uGrassN, vWorld, N) * sa.x;
            nW += triplanarNormal(uSandN, vWorld, N) * sa.y;
            nW += triplanarNormal(uRockN, vWorld, N) * sa.z;
            nW += triplanarNormal(uSnowN, vWorld, N) * sa.w;
            nW = normalize(mix(N, normalize(nW), uNormalStrength));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          }
        }
      `,
      );
    }
  };
  material.customProgramCacheKey = () => `terrain-ground-v2-${opts.triplanar ? 'tri' : 'planar'}`;

  return { material, uniforms };
}
