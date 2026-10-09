import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/math';
import type { World } from '../world/world';
import type { Settings } from '../core/events';
import { QUALITY_PRESETS } from '../core/config';

/**
 * Sky, sun, weather-driven atmosphere. The clouds are not decoration: their
 * coverage is read from the climate simulation's cloud field, so when the
 * simulation says it is overcast over the northern forest, it is.
 */
export interface Atmosphere {
  fogDensity: number;
  fogColor: THREE.Color;
  sunDir: THREE.Vector3;
  sunUp: number;
  night: number;
  cloudMean: number;
}

export class Sky {
  readonly dome: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly moon: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly cloudTexture: THREE.DataTexture;

  private uniforms: Record<string, THREE.IUniform>;
  private readonly cloudRes = 36;
  private cloudData: Uint8Array;

  constructor(scene: THREE.Scene, world: World) {
    this.cloudData = new Uint8Array(this.cloudRes * this.cloudRes * 4);
    this.cloudTexture = new THREE.DataTexture(this.cloudData, this.cloudRes, this.cloudRes, THREE.RGBAFormat);
    this.cloudTexture.minFilter = THREE.LinearFilter;
    this.cloudTexture.magFilter = THREE.LinearFilter;
    this.cloudTexture.wrapS = THREE.RepeatWrapping;
    this.cloudTexture.wrapT = THREE.RepeatWrapping;
    this.cloudTexture.needsUpdate = true;

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.4) },
      uSunColor: { value: new THREE.Color(0xfff2d0) },
      uZenith: { value: new THREE.Color(0x2a5da8) },
      uHorizon: { value: new THREE.Color(0xa8c4de) },
      uGround: { value: new THREE.Color(0x3a3a34) },
      uCloudCover: { value: 0.3 },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.1, 0.05) },
      uCloudTex: { value: this.cloudTexture },
      uStorm: { value: 0 },
      uSunElevation: { value: 0.5 },
      uNight: { value: 0 },
      uStarSeed: { value: Math.random() * 10 },
      uRain: { value: 0 },
    };

    const geo = new THREE.SphereGeometry(1, 40, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        varying vec3 vWorld;
        void main() {
          vDir = normalize(position);
          vWorld = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uGround;
        uniform float uCloudCover, uTime, uStorm, uSunElevation, uNight, uStarSeed, uRain;
        uniform vec2 uWind;
        uniform sampler2D uCloudTex;
        varying vec3 vDir;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 6; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float elevation = dir.y;
          float sunAmount = max(dot(dir, normalize(uSunDir)), 0.0);

          // Base sky gradient: horizon haze to zenith blue, reddened near the sun.
          float t = pow(clamp(elevation, 0.0, 1.0), 0.55);
          vec3 sky = mix(uHorizon, uZenith, t);
          // Dawn/dusk reddening near the horizon.
          float lowSun = 1.0 - clamp(uSunElevation * 3.0, 0.0, 1.0);
          vec3 duskColor = vec3(0.95, 0.5, 0.28);
          sky = mix(sky, mix(duskColor, sky, 0.35), lowSun * pow(1.0 - clamp(elevation, 0.0, 1.0), 2.2) * 0.85);

          // Sun disc + glow.
          float disc = smoothstep(0.9986, 0.9994, sunAmount);
          float glow = pow(sunAmount, 220.0) * 0.8 + pow(sunAmount, 12.0) * 0.22;
          sky += uSunColor * glow * (1.0 - uCloudCover * 0.85) * clamp(uSunElevation * 4.0 + 0.15, 0.0, 1.4);

          // Stars at night.
          if (uNight > 0.02) {
            vec2 sp = dir.xz / max(0.06, abs(dir.y) + 0.15) * 3.0;
            float star = hash(floor(sp * 26.0) + uStarSeed);
            float bright = smoothstep(0.9955, 1.0, star) * (0.6 + 0.4 * sin(uTime * 0.4 + star * 30.0));
            sky += vec3(0.85, 0.9, 1.0) * bright * uNight * smoothstep(0.0, 0.25, elevation);
          }

          // Clouds: sample the simulation's own cloud field, then add procedural
          // structure so the deck has texture instead of being a flat average.
          vec2 uv = dir.xz / max(0.12, elevation + 0.25);
          vec2 drift = uWind * uTime * 0.006;
          float sim = texture2D(uCloudTex, fract(uv * 0.12 + drift * 0.4)).r;
          float cover = clamp(uCloudCover * 0.55 + sim * 0.75, 0.0, 1.2);
          float base = fbm(uv * 1.6 + drift * 2.2) * 0.6 + fbm(uv * 5.5 - drift * 3.0) * 0.4;
          float shaped = smoothstep(1.02 - cover, 1.5 - cover, base * 1.35);
          // Vertical fade: clouds thin toward the horizon.
          shaped *= smoothstep(-0.02, 0.22, elevation);
          vec3 cloudLight = mix(vec3(0.42, 0.44, 0.48), vec3(1.02, 1.0, 0.97), clamp(uSunElevation * 2.4, 0.15, 1.0));
          cloudLight = mix(cloudLight, vec3(0.28, 0.29, 0.33), uStorm * 0.7);
          vec3 cloudColor = mix(cloudLight * 0.65, cloudLight, smoothstep(0.2, 0.9, base));
          sky = mix(sky, cloudColor, clamp(shaped * (0.55 + uStorm * 0.45), 0.0, 1.0));
          // Rain shafts below heavy cloud.
          sky = mix(sky, mix(cloudColor, vec3(0.6, 0.65, 0.72), 0.4), clamp(uRain * 0.25 * shaped, 0.0, 0.4));

          // Ground haze below the horizon (the world is a finite landmass).
          float below = smoothstep(0.02, -0.25, elevation);
          sky = mix(sky, uGround, below * 0.9);

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.45);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 700;
    const s = 150;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    // Terrain is a big, shallow-sloped surface seen at grazing angles: it needs
    // a generous normal bias or the shadow map acne-patterns across every hill.
    this.sun.shadow.bias = -0.004;
    this.sun.shadow.normalBias = 2.4;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.moon = new THREE.DirectionalLight(0x9fb4d8, 0.22);
    scene.add(this.moon);
    this.hemi = new THREE.HemisphereLight(0x9fb6d8, 0x4a4436, 0.55);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.06);
    scene.add(this.ambient);
    void world;
  }

  /** Update the sun position, lighting and the cloud field texture. */
  update(world: World, cameraPos: THREE.Vector3, settings: Settings): Atmosphere {
    const clock = world.clock;
    const season = clock.yearFraction;
    // Sun rises in the east, sets in the west, leaning with the season.
    const dayPhase = (clock.hour / 24) * Math.PI * 2 - Math.PI / 2;
    const declination = clock.seasonalSolar * 0.38;
    const elevation = Math.sin(dayPhase) * (0.62 + declination);
    const azimuth = clock.hour / 24 * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(azimuth) * 0.85, elevation, Math.sin(azimuth) * 0.3 + 0.25).normalize();
    const sunUp = clamp01(elevation * 1.6 + 0.12);

    const u = this.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(dir);
    u.uSunElevation.value = clamp01(sunUp);
    u.uNight.value = clamp01(1 - smoothstep(-0.05, 0.22, elevation));

    // Light colours shift with elevation (warm near the horizon).
    const warm = new THREE.Color(0xffd9a0);
    const noon = new THREE.Color(0xfff4e0);
    const sunColor = warm.clone().lerp(noon, clamp01(sunUp * 1.5));
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    this.sun.color.copy(sunColor);
    this.sun.intensity = lerp(0.09, 2.0, clamp01(sunUp)) * (1 - clamp01(world.climate.globalDimming) * 0.65);
    this.sun.position.copy(cameraPos).addScaledVector(dir, 300);
    this.sun.target.position.copy(cameraPos);
    this.sun.target.updateMatrixWorld();
    this.moon.intensity = (1 - clamp01(sunUp)) * 0.30;
    this.moon.position.copy(cameraPos).addScaledVector(dir, -300);

    const cloudMean = world.climate.cloud.stats().mean;
    u.uCloudCover.value = clamp01(cloudMean * 1.1 + (world.climate.state === 'storm' ? 0.35 : 0));
    u.uStorm.value = clamp01(world.fire.smoke * 0.4 + (world.climate.state === 'storm' ? world.climate.intensity : 0));
    u.uRain.value = clamp01(world.climate.rainIntensity.stats().mean / 1.5);
    u.uTime.value = world.smoothMinutes * 0.02;
    (u.uWind.value as THREE.Vector2).set(Math.cos(world.climate.windDirection) * world.climate.windSpeed, Math.sin(world.climate.windDirection) * world.climate.windSpeed);

    // Sky colours: cool at night, warm at dawn, hazy in fog.
    const night = clamp01(1 - smoothstep(-0.1, 0.25, elevation));
    const zenithDay = new THREE.Color(0x2f63b0);
    const zenithNight = new THREE.Color(0x05070f);
    const horizonDay = new THREE.Color(0xb6cddf);
    const horizonNight = new THREE.Color(0x121a2c);
    const fogAmount = clamp01(world.climate.fog.stats().mean * 1.6);
    const zenith = zenithNight.clone().lerp(zenithDay, 1 - night);
    const horizon = horizonNight.clone().lerp(horizonDay, 1 - night).lerp(new THREE.Color(0xaab0b6), fogAmount);
    (u.uZenith.value as THREE.Color).copy(zenith);
    (u.uHorizon.value as THREE.Color).copy(horizon);
    (u.uGround.value as THREE.Color).copy(horizon.clone().multiplyScalar(0.55));
    this.hemi.color.copy(horizon).lerp(new THREE.Color(0xffffff), 0.3);
    this.hemi.intensity = lerp(0.24, 0.62, clamp01(sunUp)) * (1 - clamp01(cloudMean) * 0.32);
    this.ambient.intensity = lerp(0.07, 0.1, clamp01(sunUp));
    this.hemi.position.copy(cameraPos).add(new THREE.Vector3(0, 60, 0));

    // Cloud field → texture (cheap: 36×36 bytes).
    const cloud = world.climate.cloud.data;
    const n = Math.round(Math.sqrt(cloud.length));
    for (let i = 0; i < n * n; i++) {
      const v = Math.round(clamp01(cloud[i]) * 255);
      this.cloudData[i * 4 + 0] = v;
      this.cloudData[i * 4 + 1] = v;
      this.cloudData[i * 4 + 2] = v;
      this.cloudData[i * 4 + 3] = 255;
    }
    this.cloudTexture.needsUpdate = true;

    // Fog: exponential, denser in rain/fog and at dawn; reduced for clarity in low quality.
    const preset = QUALITY_PRESETS[settings.quality];
    void preset;
    const fogDensity = clamp(0.0009 + world.climate.fog.stats().mean * 0.02 + clamp01(world.climate.rainIntensity.stats().mean * 0.06) * 0.004, 0.0005, 0.03);
    const fogColor = horizon.clone().lerp(new THREE.Color(0xffffff), 0.15);
    return { fogDensity, fogColor, sunDir: dir, sunUp, night, cloudMean };
  }

  /** Dispose GPU resources. */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.dome);
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    this.cloudTexture.dispose();
  }
}
