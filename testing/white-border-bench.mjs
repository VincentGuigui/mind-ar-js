// White-border tracking performance benchmark.
// Run: node testing/white-border-bench.mjs   (after `npm run build`; needs playwright-core +
// Chromium, see CHROMIUM_PATH)
//
// Measures, in real Chromium through the full canvas pipeline (drawImage + getImageData +
// mask + components + quad + pose), the per-frame cost of:
//   - full-frame detection (the acquisition pass, and the old per-frame cost)
//   - the ROI fast pass (tracking pass: only the padded neighborhood of the last quad)
// at CPU throttling 1x (desktop), 4x (~mid-range phone) and 6x (~low-end phone), for a
// medium and a close-up card. Also asserts the ROI pass finds the same quad as the full pass.

import {createServer} from 'http';
import {readFile} from 'fs/promises';
import {extname, join, dirname} from 'path';
import {fileURLToPath} from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const {chromium} = await import('playwright-core');

const MIME = {'.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript'};
const server = createServer(async (req, res) => {
  try {
    const data = await readFile(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {'Content-Type': MIME[extname(req.url)] || 'application/octet-stream'});
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8125, r));

const browser = await chromium.launch({executablePath: CHROMIUM, headless: true});
const page = await browser.newPage();
await page.goto('http://localhost:8125/testing/white-border-interactive.html');
await page.waitForFunction('window.__ready === true', null, {timeout: 20000});
const cdp = await page.context().newCDPSession(page);

const SCENES = [
  ['card medium (~35% of frame width)', {distance: 180, rotZ: 20, tiltX: 15, noise: 8}],
  ['card close-up (~50% of frame width)', {distance: 140, rotZ: 20, tiltX: 15, noise: 8}], // largest pose that still fully fits the rotated card in frame
  ['card far (~15% of frame width)', {distance: 420, rotZ: 20, tiltX: 15, noise: 8}],
];
const THROTTLES = [[1, 'desktop-class'], [4, '~mid-range phone'], [6, '~low-end phone']];

let failures = 0;
console.log('frame 480x270 analysis (WORK_SIZE=480), 200 iterations each, mean [p90] in ms\n');
for (const [rate, label] of THROTTLES) {
  await cdp.send('Emulation.setCPUThrottlingRate', {rate});
  console.log(`--- CPU throttle ${rate}x (${label}) ---`);
  for (const [name, scene] of SCENES) {
    await page.evaluate((s) => window.__setParams(s), scene);
    const r = await page.evaluate(() => window.__bench(200));
    const accurate = r.detected && r.fullErrPx !== null && r.fullErrPx <= 3 && r.roiErrPx !== null && r.roiErrPx <= 3;
    if (!accurate) failures++;
    const fps = (ms) => (1000 / ms).toFixed(0);
    console.log(
      `${name.padEnd(40)} full ${String(r.fullMs.mean).padStart(6)} [${r.fullMs.p90}] ${fps(r.fullMs.mean)}/s err ${r.fullErrPx}px | ` +
      `ROI ${String(r.roiMs.mean).padStart(6)} [${r.roiMs.p90}] ${fps(r.roiMs.mean)}/s err ${r.roiErrPx}px${accurate ? '' : '  <-- INACCURATE'}`);
  }
}
await browser.close();
server.close();
console.log(failures === 0 ? '\nALL CONSISTENT' : `\n${failures} INCONSISTENCY(IES)`);
process.exit(failures ? 1 : 0);
