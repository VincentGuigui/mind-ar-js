// White-border tracking smoke test (no DOM needed). Run: node testing/white-border-tracker.test.mjs
import {WhiteBorderTracker} from '../src/image-target/white-border-tracker.js';
import {Estimator} from '../src/image-target/estimation/estimator.js';
import {Matrix, inverse} from 'ml-matrix';

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };

// build a tracker instance without touching the DOM (skip constructor)
const K = [[800, 0, 640], [0, 800, 360], [0, 0, 1]];
const t = Object.create(WhiteBorderTracker.prototype);
t.inputWidth = 1280; t.inputHeight = 720;
t.markerDimensions = [[1000, 600]]; // ratio 0.6 (landscape card)
t.debugMode = false;
t.estimator = new Estimator(K);
t.kInv = inverse(new Matrix(K));
t.workScale = 1; t.workWidth = 1280; t.workHeight = 720;

// --- pose path: project a known pose, recover it ---
const project = (X, Y, Z) => ({x: 800 * X / Z + 640, y: 800 * Y / Z + 360});
// marker at Z=2000, centered-ish, top-left of marker at (-500,-300)
const world = [[0, 0], [1000, 0], [1000, 600], [0, 600]];
const corners = world.map(([x, y]) => project(x - 500, y - 300, 2000));

const match = t.matchQuad(corners, [0]);
check('matchQuad finds target', match !== null && match.targetIndex === 0);
if (match) {
  const mvt = match.modelViewTransform;
  check('recovered Z ~2000', Math.abs(mvt[2][3] - 2000) < 20);
  check('recovered X ~-500', Math.abs(mvt[0][3] - -500) < 10);
  check('rotation ~identity', Math.abs(mvt[0][0] - 1) < 0.02 && Math.abs(mvt[1][1] - 1) < 0.02);
}

// wrong orientation (corners rotated by one) must be corrected by _bestOrientation
const rotated = [corners[1], corners[2], corners[3], corners[0]];
const match2 = t.matchQuad(rotated, [0]);
check('matchQuad fixes 90deg corner shift', match2 !== null && Math.abs(match2.modelViewTransform[2][3] - 2000) < 20);

// a quad with a very different ratio must be rejected (quality gate)
const badWorld = [[0, 0], [1000, 0], [1000, 3000], [0, 3000]];
const badCorners = badWorld.map(([x, y]) => project(x - 500, y - 1500, 4000));
check('wrong-ratio quad rejected', t.matchQuad(badCorners, [0]) === null);

// trackQuad keeps assignment stable vs lastCorners
const track = t.trackQuad(rotated, 0, match.corners);
check('trackQuad temporal lock', track !== null && Math.abs(track.modelViewTransform[2][3] - 2000) < 20);

// --- mask path: synthetic white ring on a small work frame ---
t.workWidth = 160; t.workHeight = 120; t.workScale = 160 / 1280;
const mask = new Uint8Array(160 * 120);
// white ring: outer rect (30,20)-(130,80), 6px thick border
for (let y = 20; y <= 80; y++) {
  for (let x = 30; x <= 130; x++) {
    const inner = x >= 36 && x <= 124 && y >= 26 && y <= 74;
    if (!inner) mask[y * 160 + x] = 1;
  }
}
// content has a large white zone touching the border
for (let y = 26; y <= 50; y++) for (let x = 60; x <= 90; x++) mask[y * 160 + x] = 1;
// small white noise blob elsewhere
for (let y = 100; y <= 104; y++) for (let x = 10; x <= 14; x++) mask[y * 160 + x] = 1;

const quad = t._largestQuadComponent(mask);
check('quad found from ring mask', quad !== null);
if (quad) {
  const xs = quad.map(p => p.x).sort((a, b) => a - b);
  const ys = quad.map(p => p.y).sort((a, b) => a - b);
  check('outer quad extents', Math.abs(xs[0] - 30) <= 1.5 && Math.abs(xs[3] - 130) <= 1.5 && Math.abs(ys[0] - 20) <= 1.5 && Math.abs(ys[3] - 80) <= 1.5);
  check('first corner is top-left', Math.abs(quad[0].x - 30) <= 1.5 && Math.abs(quad[0].y - 20) <= 1.5);
}

// full-white frame must be rejected
const full = new Uint8Array(160 * 120).fill(1);
check('full-white frame rejected', t._largestQuadComponent(full) === null);

// adaptive threshold: warm/dim "white" (200,190,160) vs grey content (120,120,120)
const w = 40, h = 30;
t.workWidth = w; t.workHeight = h;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) {
  const x = i % w, y = (i / w) | 0;
  const border = x < 5 || x >= w - 5 || y < 4 || y >= h - 4;
  const [r, g, b] = border ? [200, 190, 160] : [120, 120, 120];
  rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
}
const m2 = t._whiteMask(rgba);
check('warm white detected as white', m2[2 * w + 2] === 1);
check('grey content not white', m2[15 * w + 20] === 0);

process.exit(failures ? 1 : 0);
