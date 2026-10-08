/**
 * GitHub Pages deployment check.
 *
 * Serves the built site under the subdirectory a project site actually lives at
 * (`/<repo>/`) and then walks everything the page needs: the asset references in
 * index.html, the module graph the bundle imports, and the texture paths the
 * runtime builds with `new URL(..., document.baseURI)`. A build that only works
 * from the site root passes every other check and still 404s on Pages, so this is
 * the test that matters.
 *
 *   node tools/check-pages.mjs [repo-name]
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'dist');
const PREFIX = `/${process.argv[2] ?? 'A-LIVING-PLANET'}`;
const PORT = 5199;

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(404).end('outside the project site');
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
  if (rel === '' || rel === '/') rel = '/index.html';
  // Pages serves the 404 page for unknown paths; mirror that.
  const file = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, '0.0.0.0', r));

const base = `http://localhost:${PORT}${PREFIX}/`;
let failures = 0;
const check = async (label, url) => {
  const res = await fetch(url);
  const ok = res.status === 200;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(res.status)}  ${label}`);
  return res;
};

console.log(`serving dist at ${base}\n`);

/* 1. The page itself, and everything it references. */
const index = await check('index.html', base);
const html = await index.text();

// References may be relative ("./assets/x.js"), root-relative ("/assets/x.js") or
// absolute. Only relative survives a project subdirectory, so flag the others.
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
console.log(`\n  ${refs.length} references in index.html:`);
for (const ref of refs) {
  if (/^(https?:)?\/\//.test(ref)) {
    console.log(`  --   external, left alone  ${ref}`);
    continue;
  }
  if (ref.startsWith('/')) {
    console.log(`  FAIL root-absolute path, breaks on a project site: ${ref}`);
    failures++;
    continue;
  }
  await check(ref, new URL(ref, base).href);
}

/* 2. Every texture the loader will actually ask for. */
//
// Most of these filenames are built at runtime from template literals, so they
// cannot be found by scanning the bundle. The list is derived from the loader's
// own key arrays instead, which means this check fails if the asset pipeline and
// the loader ever disagree — exactly the drift that ships a world with missing
// materials.
const source = await readFile(join(import.meta.dirname, '..', 'src/render/textures.ts'), 'utf8');
const keysOf = (decl) => {
  const m = source.match(new RegExp(`${decl}\\s*:[^=]*=\\s*\\[([^\\]]+)\\]`));
  return m ? m[1].split(',').map((k) => k.trim().replace(/['"]/g, '')).filter(Boolean) : null;
};

const expected = [];
const groundKeys = keysOf('groundKeys');
const barkKeys = keysOf('barkKeys');
const leafKeys = keysOf('leafKeys');
const cardKeys = keysOf('cardKeys');
if (!groundKeys || !barkKeys || !leafKeys || !cardKeys) {
  console.log('\n  FAIL could not read the key lists from src/render/textures.ts');
  failures++;
} else {
  for (const k of groundKeys) for (const part of ['color', 'normal', 'rough']) expected.push(`assets/ground/${k}_${part}.jpg`);
  for (const k of barkKeys) for (const part of ['color', 'normal', 'rough']) expected.push(`assets/gen/bark_${k}_${part}.png`);
  for (const k of leafKeys) expected.push(`assets/gen/leaf_${k}_color.png`);
  for (const k of cardKeys) expected.push(`assets/gen/${k}_color.png`);
  expected.push('assets/gen/water_normal.png', 'assets/gen/foam.png');
}

console.log(`\n  ${expected.length} textures the loader requests:`);
for (const path of expected) await check(path, new URL(path, base).href);

/* 3. Nothing shipped that the loader will never use. */
const shippedGround = (await readdir(join(ROOT, 'assets/ground'))).map((f) => `assets/ground/${f}`);
const shippedGen = (await readdir(join(ROOT, 'assets/gen'))).map((f) => `assets/gen/${f}`);
const unused = [...shippedGround, ...shippedGen].filter((f) => !expected.includes(f) && !f.includes('ATTRIBUTION'));
if (unused.length) console.log(`\n  note: ${unused.length} shipped file(s) the loader does not request: ${unused.join(', ')}`);

server.close();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} problem(s)`}`);
process.exit(failures === 0 ? 0 : 1);
