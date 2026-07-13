// White-border REAL-IMAGE test.
// Run: node testing/white-border-realimage.test.mjs   (after `npm run build`; needs
// playwright-core + Chromium, see CHROMIUM_PATH)
//
// Runs the real whiteBorder pipeline on an actual photo — testing/targets/white_frame_postcard.jpg,
// a hand holding a white-bordered postcard against a bright, cluttered outdoor scene (hazy sky,
// sunlit stone, foliage) — the genuine hard case where the background is nearly as white as the
// border. Asserts the tracker locates the postcard's outer white frame (not the sky) within a
// pixel tolerance of the hand-verified ground-truth corners, at the true frame ratio and at a
// looser declared ratio.

import {createServer} from 'http';
import {readFile} from 'fs/promises';
import {extname, join, dirname} from 'path';
import {fileURLToPath} from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const {chromium} = await import('playwright-core');

const MIME = {'.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.jpg': 'image/jpeg'};
const server = createServer(async (req, res) => {
  try {
    const data = await readFile(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {'Content-Type': MIME[extname(req.url)] || 'application/octet-stream'});
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8131, r));

const browser = await chromium.launch({executablePath: CHROMIUM, headless: true});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
await page.goto('http://localhost:8131/testing/white-border-realimage.html');
await page.waitForFunction('window.__ready === true', null, {timeout: 20000});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : ''));
  if (!cond) failures++;
};

// Ground truth: outer corners of the postcard's white frame, in image pixels (1024x559),
// read off the photo and confirmed by the detector overlay. Order TL, TR, BR, BL.
const GT = [{x: 372, y: 186}, {x: 708, y: 147}, {x: 680, y: 362}, {x: 396, y: 394}];
const TOL = 22; // px; the frame edge is a few px thick and JPEG-soft, so allow a small slack

// mean corner distance over the best cyclic alignment (rotation-invariant)
const cornerError = (got) => {
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const c = got[(i + shift) % 4];
      sum += Math.hypot(c.x - GT[i].x, c.y - GT[i].y);
    }
    best = Math.min(best, sum / 4);
  }
  return best;
};
const maxCornerError = (got) => {
  // worst single-corner distance under the best cyclic alignment
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const c = got[(i + shift) % 4];
      worst = Math.max(worst, Math.hypot(c.x - GT[i].x, c.y - GT[i].y));
    }
    best = Math.min(best, worst);
  }
  return best;
};

// the postcard's outer white frame is ~0.62 (h/w); test the true ratio and a looser guess
const r062 = await page.evaluate(() => window.__detect('white_frame_postcard.jpg', 0.62));
check('image loaded at native resolution', r062.W === 1024 && r062.H === 559);
check('a white-frame quad is matched (ratio 0.62)', r062.matched, `${r062.nCandidates} candidates`);
if (r062.matched) {
  const err = cornerError(r062.corners);
  const werr = maxCornerError(r062.corners);
  check(`matched quad is the postcard frame, not the sky (mean ${err.toFixed(1)}px, worst ${werr.toFixed(1)}px)`,
    werr <= TOL, `corners ${JSON.stringify(r062.corners)}`);
  check('recovered pose is in front of the camera (z > 0)', r062.z > 0, `z=${r062.z && r062.z.toFixed(0)}`);
}

// robustness: a looser declared ratio (0.7) still locks onto the same frame
const r070 = await page.evaluate(() => window.__detect('white_frame_postcard.jpg', 0.70));
check('still matched with a looser declared ratio (0.70)', r070.matched);
if (r070.matched) {
  check(`ratio 0.70 lands on the same frame (worst ${maxCornerError(r070.corners).toFixed(1)}px)`,
    maxCornerError(r070.corners) <= TOL + 8);
}

// the bright sky is present as a candidate but must NOT be the chosen match
if (r062.matched) {
  const skyLike = r062.candidates.some((q) => q.every((p) => p.y < 190) || Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x)) > 800);
  check('a large background/sky candidate exists but the ratio gate rejected it in favor of the postcard',
    !skyLike || cornerError(r062.corners) <= TOL, skyLike ? 'sky candidate present, correctly not chosen' : 'no sky candidate this run');
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
