/**
 * Mean albedo of the ground materials, in both encoded and linear light.
 *
 * The terrain blends these maps together and lights them with one sun, so if
 * one of them is far darker than the rest the biome it represents renders as a
 * hole in the landscape. This prints the numbers used to set the gains in
 * `fetch-assets.mjs`, next to the flat palette they replaced.
 *
 *   node tools/texstats.mjs
 */
import sharp from 'sharp';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '../public/assets/ground');
const KEYS = ['grass', 'sand', 'rock', 'snow', 'dirt', 'moss', 'cliff', 'gravel'];
const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

console.log('material    mean sRGB             mean linear');
for (const key of KEYS) {
  const { data, info } = await sharp(path.join(DIR, `${key}_color.jpg`))
    .resize(64, 64, { fit: 'cover' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  r /= n; g /= n; b /= n;
  console.log(
    `${key.padEnd(11)} (${r.toFixed(0).padStart(3)},${g.toFixed(0).padStart(3)},${b.toFixed(0).padStart(3)})` +
      `            (${toLinear(r).toFixed(3)},${toLinear(g).toFixed(3)},${toLinear(b).toFixed(3)})`,
  );
}
console.log('\nflat palette this replaced (linear):');
console.log('  grass (0.16,0.27,0.08)  dry grass (0.34,0.31,0.14)  rock (0.36,0.35,0.33)  snow (0.93,0.95,0.99)');
