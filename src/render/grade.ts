import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Final picture grade, applied to display-referred colour after the output pass:
 * a gentle filmic S-curve, a little saturation so greens and browns read as
 * living land rather than grey, a warm highlight / cool shadow split, and a
 * soft vignette that pulls the eye to the middle of the view.
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.06 },
    uVignette: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      // Warm highlights, cool shadows.
      float hi = smoothstep(0.5, 1.0, luma);
      float lo = 1.0 - smoothstep(0.0, 0.5, luma);
      c += vec3(0.012, 0.006, -0.012) * hi;
      c += vec3(-0.006, 0.0, 0.014) * lo;
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVignette * smoothstep(0.35, 0.95, dot(d, d) * 2.0);
      c *= v;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }
  `,
};

export function createGradePass(): ShaderPass {
  return new ShaderPass(GradeShader);
}
