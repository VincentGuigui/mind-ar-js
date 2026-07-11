// White-border tracking LIVE CAMERA MODE test.
// Run: node testing/white-border-camera.test.mjs   (requires `npm run build` first, plus
// playwright-core and a Chromium binary — set CHROMIUM_PATH if not at the default location)
//
// Exercises the real getUserMedia path of testing/white-border-interactive.html: a synthetic
// scene (known card pose, warm light, sensor noise) is rendered to a Y4M video and fed to
// Chromium as a FAKE WEBCAM (--use-file-for-fake-video-capture). The page's "Live camera"
// mode then runs the real pipeline — getUserMedia → <video> → canvas drawImage → tracker —
// and the detected corners are checked against the ground truth of the rendered scene.

import {writeFileSync, mkdirSync} from 'fs';
import {createServer} from 'http';
import {readFile} from 'fs/promises';
import {extname, join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {renderFrame} from './synthetic-frame.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  ({chromium} = await import('playwright-core'));
} catch (e) {
  console.error('SKIP: playwright-core not installed (npm i --no-save --ignore-scripts playwright-core)');
  process.exit(1);
}

// ---- 1. render the fake webcam video (Y4M = uncompressed YUV420, natively supported) ------
const W = 480, H = 270;
const SCENE = {rotZ: 25, tiltX: 15, offsetX: 10, lightLevel: 0.9, warmth: 0.4, noise: 6};

const rgbaToYuv420 = (rgba) => {
  const y = new Uint8Array(W * H), u = new Uint8Array(W * H / 4), v = new Uint8Array(W * H / 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      const [r, g, b] = [rgba[o], rgba[o + 1], rgba[o + 2]];
      y[j * W + i] = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b));
      if (i % 2 === 0 && j % 2 === 0) { // subsample chroma (top-left sample is accurate enough here)
        const c = (j / 2) * (W / 2) + i / 2;
        u[c] = Math.max(0, Math.min(255, -0.169 * r - 0.331 * g + 0.5 * b + 128));
        v[c] = Math.max(0, Math.min(255, 0.5 * r - 0.419 * g - 0.081 * b + 128));
      }
    }
  }
  return [y, u, v];
};

let groundTruth = null;
const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`)];
for (let f = 0; f < 60; f++) {
  const frame = renderFrame({...SCENE, width: W, height: H, seed: 1000 + (f % 10)}); // static pose, varying sensor noise
  groundTruth = frame.groundTruth;
  chunks.push(Buffer.from('FRAME\n'));
  for (const plane of rgbaToYuv420(frame.rgba)) chunks.push(Buffer.from(plane));
}
mkdirSync(join(ROOT, 'testing/.tmp'), {recursive: true});
const y4mPath = join(ROOT, 'testing/.tmp/fake-camera.y4m');
writeFileSync(y4mPath, Buffer.concat(chunks));
console.log('fake webcam video written:', y4mPath);

// ---- 2. serve the repo and drive the page's camera mode -----------------------------------
const MIME = {'.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript'};
const server = createServer(async (req, res) => {
  try {
    const data = await readFile(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {'Content-Type': MIME[extname(req.url)] || 'application/octet-stream'});
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8124, r));

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4mPath}`,
  ],
});
const page = await browser.newPage({viewport: {width: 1400, height: 760}});
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
await page.goto('http://localhost:8124/testing/white-border-interactive.html');
await page.waitForFunction('window.__ready === true', null, {timeout: 20000});

// enable live camera mode (ratio slider already matches the scene's default 0.7)
await page.check('#camera');
await page.waitForTimeout(1500); // let the stream start and the rAF loop settle

// ---- 3. sample the realtime results and compare with the scene's ground truth --------------
const samples = [];
for (let i = 0; i < 6; i++) {
  samples.push(await page.evaluate(() => window.__lastResult));
  await page.waitForTimeout(200);
}
const screenshot = join(ROOT, 'testing/.tmp/camera-mode.png');
await page.screenshot({path: screenshot, clip: {x: 0, y: 0, width: 1400, height: 560}});
await browser.close();
server.close();

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail && !cond ? ' — ' + detail : ''));
  if (!cond) failures++;
};

const detected = samples.filter((s) => s && s.detected);
check(`camera mode: detected in ${detected.length}/6 samples`, detected.length >= 5);

const cornerErr = (corners) => {
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const c = corners[(i + shift) % 4];
      sum += Math.hypot(c.x - groundTruth.corners[i].x, c.y - groundTruth.corners[i].y);
    }
    best = Math.min(best, sum / 4);
  }
  return best;
};
const errs = detected.map((s) => cornerErr(s.corners));
const meanErr = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
// the camera pipeline is softer than the synthetic path (YUV 4:2:0 chroma subsampling +
// stream resampling blur the border edge), so the bound is looser: ~3.4px observed, 4px limit
check(`camera mode: mean corner error ${meanErr.toFixed(2)}px vs ground truth (limit 4px)`, errs.length > 0 && meanErr <= 4);
console.log('screenshot:', screenshot);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
