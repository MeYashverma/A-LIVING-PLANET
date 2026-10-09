// Measures real frame intervals and the simulation step time of the running app.
// Usage: npm run dev (in one shell), then:
//   node tools/perf/measure-frames.mjs
// Env: URL (default http://localhost:5173/), W/H viewport (1280x720), SECONDS (15),
//      CHROME_PATH (path to a Chrome/Chromium binary; defaults to puppeteer's own).
// Needs puppeteer-core or puppeteer installed (npm i -D puppeteer-core) and a GPU for
// meaningful numbers. Headless software rendering measures CPU cost, not GPU cost.
import puppeteer from 'puppeteer-core';

const url = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
const SECONDS = Number(process.env.SECONDS ?? 15);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: 'new',
  args: ['--ignore-gpu-blocklist', '--enable-webgl'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await new Promise((r) => setTimeout(r, 8000));

const res = await page.evaluate((seconds) => new Promise((resolve) => {
  const gaps = [];
  const sims = [];
  let last = performance.now();
  const t0 = last;
  const readout = [...document.querySelectorAll('*')].find((e) => /fps ·/.test(e.textContent ?? '') && e.children.length === 0);
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    const m = readout?.textContent?.match(/([\d.]+) ms/);
    if (m) sims.push(parseFloat(m[1]));
    if (now - t0 < seconds * 1000) return requestAnimationFrame(tick);
    const q = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b);
      return s.length ? +s[Math.floor(p * (s.length - 1))].toFixed(2) : null;
    };
    resolve({
      frames: gaps.length,
      fpsMedian: +(1000 / q(gaps, 0.5)).toFixed(1),
      frameMsMedian: q(gaps, 0.5),
      frameMsP95: q(gaps, 0.95),
      frameMsMax: q(gaps, 1),
      simMsMedian: q(sims, 0.5),
      simMsMax: q(sims, 1),
    });
  };
  requestAnimationFrame(tick);
}), SECONDS);

console.log(JSON.stringify(res, null, 2));
await browser.close();
