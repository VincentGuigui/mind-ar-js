// White-border REAL-IMAGE + CONTENT-SIGNATURE test.
// Run: node testing/white-border-realimage-signature.test.mjs  (after `npm run build`; needs
// playwright-core + Chromium, see CHROMIUM_PATH)
//
// Like white-border-realimage.test.mjs, but exercises the full signature path on the real
// postcard photo: the reference signature is computed the AUTHORING way (creator bundle
// MINDAR.WHITE_BORDER.computeSignatureFromImage) from a flat rectification of the detected
// quad, then the tracker matches the ORIGINAL (perspective) photo against it. Asserts the
// correct card is accepted and correctly oriented, and a WRONG (colour-inverted) signature is
// rejected. Writes the tracking overlay + the rectified flat target to testing/.tmp/.

import {createServer} from 'http';
import {existsSync, mkdirSync, writeFileSync} from 'fs';
import {readFile} from 'fs/promises';
import {extname, join, dirname} from 'path';
import {fileURLToPath} from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'testing/.tmp');
const {chromium} = await import('playwright-core');
const LINUX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROMIUM = process.env.CHROMIUM_PATH || (existsSync(LINUX_CHROMIUM) ? LINUX_CHROMIUM : chromium.executablePath());

const MIME = {'.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.jpg': 'image/jpeg'};
const server = createServer(async (req, res) => {
  try {
    const data = await readFile(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {'Content-Type': MIME[extname(req.url)] || 'application/octet-stream'});
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8132, r));

const browser = await chromium.launch({executablePath: CHROMIUM, headless: true});
const page = await browser.newPage({viewport: {width: 1100, height: 640}});
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));
await page.goto('http://localhost:8132/testing/white-border-realimage-signature.html');
await page.waitForFunction('window.__ready === true', null, {timeout: 20000});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? `  (${detail})` : ''));
  if (!cond) failures++;
};

// same postcard, same hand-verified outer white-frame corners (TL, TR, BR, BL), ratio ~0.62
const GT = [{x: 372, y: 186}, {x: 708, y: 147}, {x: 680, y: 362}, {x: 396, y: 394}];
const BORDER = 0.06;
const worstCornerError = (got) => {
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    let worst = 0;
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(got[(i + shift) % 4].x - GT[i].x, got[(i + shift) % 4].y - GT[i].y));
    best = Math.min(best, worst);
  }
  return best;
};
// corner 0 must sit near the true top-left, not the 180deg-opposite corner
const orientedCorrectly = (got) =>
  Math.hypot(got[0].x - GT[0].x, got[0].y - GT[0].y) < Math.hypot(got[0].x - GT[2].x, got[0].y - GT[2].y);

const r = await page.evaluate(([b]) => window.__run('white_frame_postcard.jpg', 0.62, b), [BORDER]);

check('baseline (no signature) locates the postcard frame', r.baseline && r.baseline.matched);
check('reference signature computed via the authoring bundle (27 numbers)', Array.isArray(r.reference) && r.reference.length === 27);
check('WITH correct signature: still matched on the real photo', r.withSig && r.withSig.matched,
  r.withSig ? `${r.withSig.nCandidates} candidates` : 'no result');
if (r.withSig && r.withSig.matched) {
  check(`WITH signature: lands on the postcard frame (worst ${worstCornerError(r.withSig.corners).toFixed(1)}px)`, worstCornerError(r.withSig.corners) <= 24);
  check('WITH signature: correct orientation (corner 0 at true top-left, not 180deg-flipped)', orientedCorrectly(r.withSig.corners));
  check('WITH signature: pose in front of the camera (z > 0)', r.withSig.z > 0);
}
check('WRONG (colour-inverted) signature: the postcard is rejected as a false positive', r.wrongSig && r.wrongSig.matched === false);

// save artifacts for visual inspection
mkdirSync(OUT, {recursive: true});
await page.locator('#c').screenshot({path: join(OUT, 'postcard-signature-tracked.png')});
const flat = await page.evaluate(() => window.__flatDataURL());
writeFileSync(join(OUT, 'postcard-signature-flat-reference.png'), Buffer.from(flat.split(',')[1], 'base64'));
console.log('tracking overlay: testing/.tmp/postcard-signature-tracked.png');
console.log('flat reference:   testing/.tmp/postcard-signature-flat-reference.png');

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
