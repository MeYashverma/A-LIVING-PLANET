/**
 * Procedural texture generator.
 *
 * The ground materials in this project are real CC0 photogrammetry (see
 * public/assets/ATTRIBUTION.md). Bark, foliage, grass cards and the water
 * normal map are generated here instead: they need to tile seamlessly, match
 * the simulation's own palettes, and carry alpha cutouts that no scanned
 * texture would give us at the right silhouette.
 *
 * Run with:  node tools/gen-tex.mjs [outdir]
 *
 * Everything is written from raw typed arrays so the result is deterministic
 * and the generator has no dependency beyond sharp's PNG encoder.
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/* ---------------------------------------------------------------- noise -- */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise: the lattice wraps at `period` so edges match. */
function valueNoise(seed, period) {
  const rnd = mulberry32(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const at = (x, y) => grid[((y % period) + period) % period * period + (((x % period) + period) % period)];
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

/** Fractal sum of tileable noise octaves. Returns a sampler over [0,1) space. */
function fbm(seed, baseFreq = 4, octaves = 5, gain = 0.5, lacunarity = 2) {
  const layers = [];
  for (let o = 0; o < octaves; o++) {
    const p = Math.max(2, Math.round(baseFreq * Math.pow(lacunarity, o)));
    layers.push({ n: valueNoise(seed + o * 7919, p), p, amp: Math.pow(gain, o) });
  }
  const norm = layers.reduce((s, l) => s + l.amp, 0);
  return (u, v) => {
    let sum = 0;
    for (const l of layers) sum += l.n(u * l.p, v * l.p) * l.amp;
    return sum / norm;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------- plumbing -- */

function canvas(size) {
  return { w: size, h: size, rgb: new Float32Array(size * size * 3), a: new Float32Array(size * size) };
}

/** Sobel height -> tangent-space normal, written into a copy of `rgb` layout. */
function normalsFromHeight(c, height, strength) {
  const { w, h } = c;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = height[((y) % h) * w + ((x - 1 + w) % w)];
      const r = height[((y) % h) * w + ((x + 1) % w)];
      const u = height[(((y - 1 + h) % h)) * w + x];
      const d = height[(((y + 1) % h)) * w + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * w + x) * 3;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
    }
  }
  return out;
}

function toRgbBuffer(values) {
  const out = Buffer.allocUnsafe(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] < 0 ? 0 : values[i] > 255 ? 255 : Math.round(values[i]);
  return out;
}

function toRgbaBuffer(rgb, alpha) {
  const n = rgb.length / 3;
  const out = Buffer.allocUnsafe(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.max(0, Math.min(255, Math.round(rgb[i * 3])));
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(rgb[i * 3 + 1])));
    out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(rgb[i * 3 + 2])));
    out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(alpha[i] * 255)));
  }
  return out;
}

async function write(file, values, alpha, w, h) {
  if (alpha) {
    await sharp(toRgbaBuffer(values, alpha), { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(file);
  } else {
    await sharp(toRgbBuffer(values), { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toFile(file);
  }
  console.log('  wrote', path.basename(file), `${w}x${h}`);
}

/* ---------------------------------------------------------- bark (x3) ---- */

/**
 * Bark. Vertical fibres dominate every species, so the height field is
 * anisotropic noise stretched along the trunk (v), with a species-specific
 * crack pattern laid over it: deep furrows for oak, wide plates for pine,
 * smooth pale skin with lenticels for birch.
 */
async function bark(out, name, opts) {
  const S = 512;
  const c = canvas(S);
  const fibre = fbm(opts.seed, 3, 5, 0.55, 2.1);
  const fine = fbm(opts.seed + 101, 24, 3, 0.5, 2.4);
  const patch = fbm(opts.seed + 202, 2, 3, 0.6, 2);
  const cracks = fbm(opts.seed + 303, 5, 4, 0.62, 2.2);
  const height = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // Fibres: many octaves across x, few along y.
      const f = fibre(u * 1.0, v * 0.18);
      const strands = fbm(opts.seed + 404, 40, 2, 0.5, 2)(u, v * 0.12);
      // Cracks are stretched hard along the trunk, so a crevice is a long
      // vertical furrow rather than an isotropic blob.
      const crackField = cracks(u * 1.35, v * 0.16);
      let h = f * 0.55 + strands * 0.28 + fine(u * 2, v) * 0.1;
      if (opts.crackDepth > 0) {
        // Crevices are narrow bands where the crack field crosses its midpoint.
        const d = Math.abs(crackField - 0.5);
        h -= (1 - smoothstep(0, opts.crackWidth, d)) * opts.crackDepth;
        h += smoothstep(opts.crackWidth, opts.crackWidth * 3.2, d) * opts.ridge * 0.5;
      }
      h += patch(u, v) * opts.mottle;
      height[y * S + x] = h;

      const shade = 0.55 + h * 0.75;
      const i = (y * S + x) * 3;
      const t = clamp01((h - 0.25) * 1.6);
      let r = lerp(opts.dark[0], opts.light[0], t) * shade;
      let g = lerp(opts.dark[1], opts.light[1], t) * shade;
      let b = lerp(opts.dark[2], opts.light[2], t) * shade;
      if (opts.lenticels) {
        // Horizontal dashes, denser than they are tall.
        const n = fbm(opts.seed + 909, 30, 2, 0.5, 2)(u * 1.4, v * 7);
        if (n > 0.72) { const k = 0.35; r *= k; g *= k; b *= k; }
      }
      c.rgb[i] = r; c.rgb[i + 1] = g; c.rgb[i + 2] = b;
    }
  }
  const nrm = normalsFromHeight(c, height, opts.normalStrength);
  await write(path.join(out, `${name}_color.png`), c.rgb, null, S, S);
  await write(path.join(out, `${name}_normal.png`), nrm, null, S, S);
  // Roughness: cracks hold shadow and damp, ridges are smoother.
  const rough = new Float32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) {
    const v = 168 + (height[i] - 0.5) * -90;
    rough[i * 3] = rough[i * 3 + 1] = rough[i * 3 + 2] = v;
  }
  await write(path.join(out, `${name}_rough.png`), rough, null, S, S);
}

/* ---------------------------------------------------- leaf cluster (x2) -- */

/**
 * Foliage cards. A card is a cluster of leaves drawn into an RGBA sprite that
 * the tree renderer scatters through the canopy; alpha cutout gives the
 * silhouette that makes a canopy read as leaves rather than as a green ball.
 */
async function leafCluster(out, name, opts) {
  const S = 512;
  const rgb = new Float32Array(S * S * 3);
  const alpha = new Float32Array(S * S);
  const height = new Float32Array(S * S);
  const rnd = mulberry32(opts.seed);

  // Needles and catkins grow along twigs, not out of thin air: a handful of
  // twigs radiate from the middle of the card and every leaf is pinned to one
  // of them, which is what makes a conifer card read as a branch rather than
  // as scattered confetti.
  const twigs = [];
  if (opts.twigs) {
    for (let t = 0; t < opts.twigs; t++) {
      const ang = (t / opts.twigs) * Math.PI * 2 + rnd() * 1.9;
      twigs.push({
        ang,
        len: 0.16 + rnd() * 0.34,
        bend: (rnd() - 0.5) * 0.9,
        // Twigs spring from scattered points along a central stem instead of
        // all from the middle, so the card is not symmetric.
        ox: (rnd() - 0.5) * 0.3,
        oy: (rnd() - 0.5) * 0.3,
      });
    }
  }
  const leafCount = opts.count;
  for (let n = 0; n < leafCount; n++) {
    let cx, cy, ang;
    if (twigs.length) {
      const tw = twigs[(rnd() * twigs.length) | 0];
      const t = 0.25 + rnd() * 0.75;
      const a2 = tw.ang + tw.bend * t;
      const r = tw.len * t * S;
      cx = S * (0.5 + tw.ox) + Math.cos(a2) * r;
      cy = S * (0.5 + tw.oy) + Math.sin(a2) * r;
      // Leaves sit roughly along the twig, angled off it.
      ang = a2 + opts.lean + (rnd() - 0.5) * 1.1;
      if (cx < 2 || cx > S - 2 || cy < 2 || cy > S - 2) continue;
    } else {
      // Cluster density falls off from the middle so the card edge is ragged.
      for (let attempt = 0; attempt < 8; attempt++) {
        cx = S * (0.5 + (rnd() - 0.5) * 0.96);
        cy = S * (0.5 + (rnd() - 0.5) * 0.96);
        const d = Math.hypot(cx / S - 0.5, cy / S - 0.5) * 2;
        if (rnd() > d * d * 0.9) break;
      }
      ang = rnd() * Math.PI * 2 + opts.lean;
    }
    const size = opts.leafSize * (0.55 + rnd() * 0.85) * S;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const shade = 0.62 + rnd() * 0.5;
    const [cr, cg, cb] = opts.palette[(rnd() * opts.palette.length) | 0];
    const x0 = Math.max(0, Math.floor(cx - size)), x1 = Math.min(S - 1, Math.ceil(cx + size));
    const y0 = Math.max(0, Math.floor(cy - size)), y1 = Math.min(S - 1, Math.ceil(cy + size));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const lx = (dx * ca + dy * sa) / (size * 0.5);
        const ly = (-dx * sa + dy * ca) / (size * opts.aspect);
        const d2 = lx * lx + ly * ly;
        if (d2 > 1) continue;
        const edgeI = (y * S + x) * 3;
        const a = alpha[y * S + x];
        // Leaves are opaque in the middle, frayed at the tip.
        const cover = smoothstep(1.0, 0.82, d2);
        if (cover <= 0) continue;
        const vein = 1 - Math.abs(lx) * 0.5;
        const light = shade * (0.85 + vein * 0.25) * (1 - d2 * 0.18);
        rgb[edgeI] = cr * light;
        rgb[edgeI + 1] = cg * light;
        rgb[edgeI + 2] = cb * light;
        height[y * S + x] = Math.max(height[y * S + x], cover * 0.7);
        if (cover >= a) alpha[y * S + x] = cover;
      }
    }
  }
  // Punch the alpha through as premultiplication-free cutout; RGB in cut regions
  // is filled from the nearest leaf colour by a cheap dilation so mipmaps don't
  // bleed black into the edges.
  const filled = rgb.slice();
  for (let pass = 0; pass < 3; pass++) {
    const src = filled.slice();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (alpha[i] > 0.03) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = ((y + oy + S) % S) * S + ((x + ox + S) % S);
          if (alpha[j] > 0.03) { r += src[j * 3]; g += src[j * 3 + 1]; b += src[j * 3 + 2]; n++; }
        }
        if (n) { filled[i * 3] = r / n; filled[i * 3 + 1] = g / n; filled[i * 3 + 2] = b / n; alpha[i] = 0.035; }
      }
    }
  }
  await write(path.join(out, `${name}_color.png`), filled, alpha, S, S);
}

/* ------------------------------------------------------ grass cards (x2) -- */

/**
 * Grass and reed cards. Each card is a fan of broad, tapering, drooping blades
 * rising from a common base. The blades are deliberately wide — a card covers
 * roughly half a metre of ground, and grass at that scale is not a hairline —
 * and they overlap so the resulting billboard is a dense tuft rather than a
 * handful of strokes.
 */
async function grassCard(out, name, opts) {
  const S = 512;
  const rgb = new Float32Array(S * S * 3);
  const height = new Float32Array(S * S);
  const alpha = new Float32Array(S * S);
  const rnd = mulberry32(opts.seed);

  const blades = opts.blades;
  for (let b = 0; b < blades; b++) {
    const baseX = S * (0.5 + (rnd() - 0.5) * opts.spread);
    const h = S * (opts.height[0] + rnd() * (opts.height[1] - opts.height[0]));
    const lean = (rnd() - 0.5) * opts.lean;
    const curve = lean + (rnd() - 0.5) * opts.curve;
    const w0 = S * (opts.width[0] + rnd() * (opts.width[1] - opts.width[0]));
    const shade = 0.6 + rnd() * 0.6;
    const [cr, cg, cb] = opts.palette[(rnd() * opts.palette.length) | 0];
    const tip = opts.tipPalette ? opts.tipPalette[(rnd() * opts.tipPalette.length) | 0] : null;
    // A blade is darkest at the base (it is in its own shadow) and lightens
    // toward the tip, which is what gives a tuft its readable silhouette.
    const steps = 110;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = baseX + curve * t * t * S * 0.42 + lean * t * S * 0.12;
      const y = S - h * t;
      const w = w0 * Math.pow(1 - t, opts.taper) * 0.5 + 0.6;
      const light = shade * (0.55 + t * 0.62);
      const mix = tip ? t * t : 0;
      const r0 = lerp(cr, tip ? tip[0] : cr, mix) * light;
      const g0 = lerp(cg, tip ? tip[1] : cg, mix) * light;
      const b0 = lerp(cb, tip ? tip[2] : cb, mix) * light;
      const x0 = Math.floor(x - w) - 1, x1 = Math.ceil(x + w) + 1;
      for (let px = x0; px <= x1; px++) {
        if (px < 0) continue;
        const xx = px % S;
        const cov = 1 - Math.abs(px - x) / Math.max(0.5, w);
        if (cov <= 0) continue;
        const a = clamp01(cov * 1.6);
        // Feather vertically too, so a blade is not a stair-stepped line.
        for (let oy = -1; oy <= 1; oy++) {
          const yy = Math.floor(y) + oy;
          if (yy < 0 || yy >= S) continue;
          const rowA = oy === 0 ? a : a * 0.42;
          const i = yy * S + xx;
          if (rowA > alpha[i]) {
            alpha[i] = rowA;
            rgb[i * 3] = r0; rgb[i * 3 + 1] = g0; rgb[i * 3 + 2] = b0;
            height[i] = Math.max(height[i], rowA);
          }
        }
      }
    }
  }
  const filled = rgb.slice();
  for (let pass = 0; pass < 3; pass++) {
    const src = filled.slice();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (alpha[i] > 0.05) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = ((y + oy + S) % S) * S + ((x + ox + S) % S);
          if (alpha[j] > 0.05) { r += src[j * 3]; g += src[j * 3 + 1]; b += src[j * 3 + 2]; n++; }
        }
        if (n) { filled[i * 3] = r / n; filled[i * 3 + 1] = g / n; filled[i * 3 + 2] = b / n; alpha[i] = 0.03; }
      }
    }
  }
  await write(path.join(out, `${name}_color.png`), filled, alpha, S, S);
}

/* ------------------------------------------------------------ water ------ */

/**
 * Water surface normal map. Four travelling wave trains at different angles
 * and wavelengths, summed analytically so the normals are exact and the map
 * tiles at any repeat.
 */
async function waterNormal(out, name) {
  const S = 512;
  const out3 = new Float32Array(S * S * 3);
  const height = new Float32Array(S * S);
  const waves = [
    { ax: 1, ay: 0, len: 1, amp: 1.0 },
    { ax: 0.62, ay: 0.78, len: 2, amp: 0.62 },
    { ax: -0.83, ay: 0.56, len: 3, amp: 0.38 },
    { ax: 0.31, ay: -0.95, len: 5, amp: 0.22 },
    { ax: 0.95, ay: 0.31, len: 8, amp: 0.14 },
    { ax: -0.42, ay: -0.91, len: 13, amp: 0.09 },
  ];
  const f1 = fbm(9001, 6, 3, 0.5, 2);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      let h = 0;
      for (const wv of waves) {
        const k = 2 * Math.PI * wv.len;
        h += Math.sin((u * wv.ax + v * wv.ay) * k) * wv.amp;
      }
      h += (f1(u, v) - 0.5) * 0.5;
      height[y * S + x] = h * 0.14 + 0.5;
    }
  }
  const nrm = normalsFromHeight({ w: S, h: S }, height, 0.9);
  for (let i = 0; i < S * S * 3; i++) out3[i] = nrm[i];
  await write(path.join(out, `${name}.png`), out3, null, S, S);
}

/* ------------------------------------------------------------ foam ------- */

/** Sea foam: cellular bubbles, used only at the waterline. */
async function foam(out, name) {
  const S = 512;
  const c = canvas(S);
  const a = fbm(4242, 8, 4, 0.55, 2.1);
  const b = fbm(777, 20, 3, 0.5, 2.2);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // Bubble cells: a ridged noise field reads as froth at grazing angles.
      const n = 1 - Math.abs(a(u, v) * 2 - 1);
      const m = 1 - Math.abs(b(u, v) * 2 - 1);
      const f = clamp01(Math.pow(n, 2.2) * 0.85 + Math.pow(m, 3) * 0.4);
      const i = (y * S + x) * 3;
      const val = 235 - (1 - f) * 90;
      c.rgb[i] = val; c.rgb[i + 1] = val; c.rgb[i + 2] = val * 0.98;
    }
  }
  await write(path.join(out, `${name}.png`), c.rgb, null, S, S);
}

/* ------------------------------------------------------------ driver ----- */

const out = process.argv[2] ?? 'public/assets/gen';
await mkdir(out, { recursive: true });
console.log('procedural textures ->', out);

await bark(out, 'bark_pine', {
  seed: 11, crackDepth: 0.42, crackWidth: 0.075, ridge: 1.0, mottle: 0.16, normalStrength: 5.5,
  dark: [58, 38, 26], light: [138, 106, 74],
});
await bark(out, 'bark_oak', {
  seed: 23, crackDepth: 0.5, crackWidth: 0.055, ridge: 1.2, mottle: 0.2, normalStrength: 6.5,
  dark: [46, 34, 26], light: [124, 102, 78],
});
await bark(out, 'bark_birch', {
  seed: 37, crackDepth: 0.08, crackWidth: 0.02, ridge: 0.2, mottle: 0.3, normalStrength: 2.2,
  dark: [176, 170, 158], light: [238, 236, 228], lenticels: true,
});

await leafCluster(out, 'leaf_broadleaf', {
  seed: 61, count: 190, leafSize: 0.085, aspect: 0.78, lean: 0.4,
  palette: [[74, 108, 38], [96, 124, 44], [58, 88, 32], [110, 132, 50], [82, 112, 40]],
});
await leafCluster(out, 'leaf_conifer', {
  seed: 83, count: 900, leafSize: 0.030, aspect: 3.6, lean: 1.3, twigs: 16,
  palette: [[38, 66, 40], [46, 78, 46], [30, 56, 34], [52, 86, 50]],
});
await leafCluster(out, 'leaf_willow', {
  seed: 97, count: 420, leafSize: 0.046, aspect: 0.30, lean: 1.5, twigs: 14,
  palette: [[120, 140, 62], [138, 154, 74], [104, 126, 54], [146, 160, 86]],
});

await grassCard(out, 'grass_lush', {
  seed: 131, blades: 120, spread: 0.88, height: [0.4, 1.0], lean: 0.45, curve: 0.55,
  width: [0.016, 0.038], taper: 1.25,
  palette: [[64, 100, 34], [78, 116, 40], [52, 84, 30], [88, 124, 44], [70, 106, 36]],
  tipPalette: [[110, 142, 56], [96, 128, 48]],
  tipGlow: true,
});
await grassCard(out, 'grass_dry', {
  seed: 151, blades: 105, spread: 0.9, height: [0.35, 0.95], lean: 0.65, curve: 0.85,
  width: [0.014, 0.032], taper: 1.45,
  palette: [[132, 122, 58], [150, 138, 70], [112, 104, 50], [162, 148, 84]],
});
await grassCard(out, 'reed', {
  seed: 173, blades: 40, spread: 0.6, height: [0.7, 1.0], lean: 0.22, curve: 0.3,
  width: [0.013, 0.024], taper: 1.05,
  palette: [[74, 102, 46], [88, 116, 54], [62, 88, 40]],
  tipPalette: [[150, 140, 92]],
});

await waterNormal(out, 'water_normal');
await foam(out, 'foam');

console.log('done');
