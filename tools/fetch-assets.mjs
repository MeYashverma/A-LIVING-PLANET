/**
 * Asset fetch and optimise.
 *
 * Downloads the CC0 ground materials this project uses, transcodes them to the
 * sizes the renderer actually binds, and writes them into `public/assets`.
 * Requires network access; it is a development tool, not part of the build.
 *
 *   node tools/fetch-assets.mjs [--force]
 *
 * Every source is CC0 (public domain dedication) or MIT, verified per file in
 * `public/assets/ATTRIBUTION.md`. The repositories below are mirrors of
 * ambientCG (CC0) material scans hosted on GitHub; `git` is used rather than the
 * asset host directly so the exact bytes are pinned by commit.
 *
 * Generated bark, foliage, grass cards, the water normal map and the foam map
 * come from `tools/gen-tex.mjs` instead — see that file for why.
 */
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, access, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/assets/ground');
const TMP = '/tmp/lp-assets';

/**
 * Each entry names a source triple (albedo, normal, roughness) and the name it
 * takes in the material set the terrain shader blends between.
 */
const SOURCES = [
  {
    repo: 'https://github.com/Dev2150/KyberPlanet.git',
    tag: 'kyberplanet',
    dir: 'textures',
    // Grass, sand, rock and snow from one consistent set, so the blend between
    // biome layers never disagrees about exposure or scale.
    files: {
      grass: ['Grass_1K-JPG_Color.jpg', 'Grass_1K-JPG_NormalGL.jpg', 'Grass_1K-JPG_Roughness.jpg'],
      sand: ['Sand_1K-JPG_Color.jpg', 'Sand_1K-JPG_NormalGL.jpg', 'Sand_1K-JPG_Roughness.jpg'],
      rock: ['Rock_1K-JPG_Color.jpg', 'Rock_1K-JPG_NormalGL.jpg', 'Rock_1K-JPG_Roughness.jpg'],
      snow: ['Snow_1K-JPG_Color.jpg', 'Snow_1K-JPG_NormalGL.jpg', 'Snow_1K-JPG_Roughness.jpg'],
    },
  },
  {
    repo: 'https://github.com/ashalluf/rando-game.git',
    tag: 'rando',
    dir: 'assets/textures',
    // Dry ground, gravel, mossy stone and a second rock: the material set a
    // single grass texture cannot cover when the biome is steppe or alpine.
    files: {
      dirt: [
        'DryGroundRocks/DryGroundRocks_1K-JPG_Color.jpg',
        'DryGroundRocks/DryGroundRocks_1K-JPG_NormalGL.jpg',
        'DryGroundRocks/DryGroundRocks_1K-JPG_Roughness.jpg',
      ],
      moss: [
        'AerialGrassRock/AerialGrassRock_1K-JPG_Color.jpg',
        'AerialGrassRock/AerialGrassRock_1K-JPG_NormalGL.jpg',
        'AerialGrassRock/AerialGrassRock_1K-JPG_Roughness.jpg',
      ],
      cliff: ['Rock064/Rock064_1K-JPG_Color.jpg', 'Rock064/Rock064_1K-JPG_NormalGL.jpg', 'Rock064/Rock064_1K-JPG_Roughness.jpg'],
    },
  },
  {
    repo: 'https://github.com/fazil47/tiny-planet.git',
    tag: 'tinyplanet',
    dir: 'textures/ambient_cg',
    files: {
      gravel: ['Gravel029_1K-PNG_Color.png', 'Gravel029_1K-PNG_NormalGL.png', null],
    },
  },
];

const SIZES = { color: 1024, normal: 1024, rough: 512 };
const QUALITY = { color: 82, normal: 84, rough: 76 };

/**
 * Per-material albedo gain, applied in the encoded (sRGB) domain.
 *
 * These maps come from different scans with different exposure, and several of
 * them are far darker than the ground they stand for would read on a sunlit
 * afternoon — the rock scan in particular averages a linear luminance of about
 * 0.09, which renders as near-black under this scene's lighting. Rather than
 * compensating in the shader (which would also lift the snow), each material is
 * normalised here to the brightness its biome should have. Re-measure with
 * `tools/texstats.mjs` after changing these.
 *
 * The gain is applied to the encoded (sRGB) values, so its effect on linear
 * light is the gain raised to about 2.2. A gain of 1.5 is a linear boost of
 * 2.4x, not 1.5x — pick accordingly.
 */
const GAIN = {
  grass: 1.0,
  sand: 1.0,
  rock: 1.5,
  snow: 1.05,
  dirt: 1.15,
  moss: 1.2,
  cliff: 1.15,
  gravel: 1.1,
};

async function clone(repo, tag) {
  const dest = path.join(TMP, tag);
  if (existsSync(dest)) return dest;
  await mkdir(TMP, { recursive: true });
  process.stdout.write(`  cloning ${repo}\n`);
  await run('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', repo, dest], { maxBuffer: 1 << 28 });
  return dest;
}

/** Sparse-checkout only the files we need, then leave the working tree alone. */
async function checkout(repoDir, files) {
  const patterns = files.map((f) => `--no-cone`) && files;
  await run('git', ['-C', repoDir, 'sparse-checkout', 'set', '--no-cone', ...patterns], { maxBuffer: 1 << 28 });
}

async function optimise(src, out, kind, name) {
  const size = SIZES[kind];
  const img = sharp(src).resize(size, size, { fit: 'cover' });
  if (kind === 'color') {
    const gain = GAIN[name] ?? 1;
    if (gain !== 1) img.linear(gain, 0);
  }
  if (kind === 'normal') {
    // Normals must not be colour-space converted; three samples them as raw
    // vectors, so any gamma applied here tilts every surface in the world.
    await img.jpeg({ quality: QUALITY.normal, chromaSubsampling: '4:4:4' }).toFile(out);
  } else if (kind === 'rough') {
    await img.greyscale().jpeg({ quality: QUALITY.rough }).toFile(out);
  } else {
    await img.jpeg({ quality: QUALITY.color }).toFile(out);
  }
  const bytes = (await stat(out)).size;
  return bytes;
}

const force = process.argv.includes('--force');
if (force) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let total = 0;
for (const src of SOURCES) {
  const repo = await clone(src.repo, src.tag);
  const needed = Object.values(src.files).flat().filter(Boolean).map((f) => `${src.dir}/${f}`);
  await checkout(repo, needed);
  for (const [name, [color, normal, rough]] of Object.entries(src.files)) {
    const pairs = [
      [color, 'color'],
      [normal, 'normal'],
      [rough, 'rough'],
    ];
    for (const [file, kind] of pairs) {
      if (!file) continue;
      const from = path.join(repo, src.dir, file);
      try {
        await access(from);
      } catch {
        console.warn(`  MISSING ${from}`);
        continue;
      }
      const out = path.join(OUT, `${name}_${kind}.jpg`);
      const bytes = await optimise(from, out, kind, name);
      total += bytes;
      console.log(`  ${name}_${kind}.jpg  ${(bytes / 1024).toFixed(0)} KB`);
    }
  }
}
console.log(`ground materials: ${(total / 1024 / 1024).toFixed(2)} MB`);
