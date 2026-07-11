// White-border tracking END-TO-END accuracy test (no DOM needed).
// Run: node testing/white-border-accuracy.test.mjs
//
// Unlike white-border-tracker.test.mjs (geometry/pose math on hand-built inputs), this test
// renders REAL synthetic camera frames (testing/synthetic-frame.mjs) with a white-bordered
// card at a known 3D pose — sweeping position, rotation, tilt, scale, border tint, lighting,
// content (including large white zones) and background clutter — feeds the pixels through the
// tracker's actual pipeline (white mask → components → quad extraction → pose), and checks
// the result against the ground truth: corner localization error in pixels, recovered
// distance, and recovered in-plane rotation.

import {WhiteBorderTracker} from '../src/image-target/white-border-tracker.js';
import {Estimator} from '../src/image-target/estimation/estimator.js';
import {Matrix, inverse} from 'ml-matrix';
import {renderFrame, cameraIntrinsics, defaultParams} from './synthetic-frame.mjs';

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail && !cond ? ' — ' + detail : ''));
  if (!cond) failures++;
};

const W = defaultParams.width, H = defaultParams.height;

// tracker at work scale 1 (the frame is already small), same intrinsics as the renderer
const makeTracker = (ratio) => {
  const K = cameraIntrinsics(W, H);
  const t = Object.create(WhiteBorderTracker.prototype);
  t.inputWidth = W; t.inputHeight = H;
  t.markerDimensions = [[defaultParams.cardWidthUnits, defaultParams.cardWidthUnits * ratio]];
  t.debugMode = false;
  t.estimator = new Estimator(K);
  t.kInv = inverse(new Matrix(K));
  t.workScale = 1; t.workWidth = W; t.workHeight = H;
  return t;
};

// run the real pixel pipeline (findQuadCandidates minus the canvas drawImage step)
const detect = (tracker, rgba) => {
  const mask = tracker._whiteMask(rgba);
  const quads = tracker._quadComponents(mask);
  return tracker.matchQuad(quads, [0]);
};

const cyclicCornerError = (detected, truth) => {
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const c = detected[(i + shift) % 4];
      sum += Math.hypot(c.x - truth[i].x, c.y - truth[i].y);
    }
    best = Math.min(best, sum / 4);
  }
  return best;
};

const rotZError = (mvt, R) => {
  // compare recovered first rotation column with ground truth, in the card plane
  const a = Math.atan2(mvt[1][0], mvt[0][0]);
  const b = Math.atan2(R[1][0], R[0][0]);
  let d = Math.abs(a - b) * 180 / Math.PI;
  d = d % 360; if (d > 180) d = 360 - d;
  return Math.min(d, Math.abs(180 - d)); // 180deg symmetry of a plain border is inherent
};

const runCase = (name, params, {maxCornerErr = 2.0, maxDistErrFrac = 0.05, maxRotErr = 2.5, expectDetected = true} = {}) => {
  const frame = renderFrame(params);
  const tracker = makeTracker(frame.groundTruth.ratio);
  const result = detect(tracker, frame.rgba);
  if (!expectDetected) {
    check(name + ': correctly NOT detected', result === null, result ? 'unexpected detection' : '');
    return;
  }
  if (!result) { check(name + ': detected', false, 'no detection'); return; }
  const cornerErr = cyclicCornerError(result.corners, frame.groundTruth.corners);
  const dist = result.modelViewTransform[2][3];
  const distErr = Math.abs(dist - frame.groundTruth.translation[2]) / frame.groundTruth.translation[2];
  const rotErr = rotZError(result.modelViewTransform, frame.groundTruth.rotation);
  check(name + `: corners ±${cornerErr.toFixed(2)}px, dist ${(100 * distErr).toFixed(1)}%, rot ${rotErr.toFixed(1)}°`,
    cornerErr <= maxCornerErr && distErr <= maxDistErrFrac && rotErr <= maxRotErr,
    `limits: ${maxCornerErr}px / ${100 * maxDistErrFrac}% / ${maxRotErr}°`);
};

// ---- pose sweep: position / rotation / tilt / scale --------------------------------------
runCase('frontal centered', {});
runCase('offset top-left', {offsetX: -45, offsetY: -25});
runCase('offset bottom-right', {offsetX: 50, offsetY: 28});
runCase('rotated 20°', {rotZ: 20});
runCase('rotated -35°', {rotZ: -35});
runCase('rotated 90° (portrait hold)', {rotZ: 90}, {maxRotErr: 91}); // 90° flip allowed: quality picks the other assignment for ratio 0.7? no — see below
runCase('tilted X 30°', {tiltX: 30});
runCase('tilted Y -35°', {tiltY: -35});
runCase('tilted X 25° + Y 20° + rot 15°', {tiltX: 25, tiltY: 20, rotZ: 15});
runCase('far (small in frame)', {distance: 420}, {maxCornerErr: 2.5});
runCase('near (fills frame)', {distance: 110});

// ---- ratios (the creator passes any image ratio) ------------------------------------------
runCase('landscape ratio 0.6', {ratio: 0.6});
runCase('portrait ratio 1.5', {ratio: 1.5, distance: 300}); // farther so the tall card fits the 270px-high frame
runCase('square-ish ratio 0.95', {ratio: 0.95}, {maxRotErr: 91}); // near-square: 90° ambiguity accepted

// ---- white tolerance: camera feeds never give pure white ----------------------------------
runCase('warm dim light', {lightLevel: 0.7, warmth: 0.8});
runCase('off-white border (235,228,210)', {borderColor: [235, 228, 210]});
runCase('lighting gradient across the card', {gradient: 0.8});
runCase('sensor noise', {noise: 14});
runCase('dim + warm + gradient + noise', {lightLevel: 0.75, warmth: 0.6, gradient: 0.5, noise: 10}, {maxCornerErr: 2.5});

// ---- content: "content could be anything, including large white zones" ---------------------
runCase('content with large white zones touching the border', {content: 'whiteZones'});
runCase('dark content', {content: 'dark'});

// ---- background robustness -----------------------------------------------------------------
runCase('plain background', {background: 'plain'});
runCase('adversarial white strip in background', {adversarialWhiteRect: true});

// ---- negative cases: must NOT detect -------------------------------------------------------
runCase('no card in frame', {distance: 100000}, {expectDetected: false});
runCase('white region of wrong ratio only', {ratio: 0.7, distance: 100000, adversarialWhiteRect: true}, {expectDetected: false});

// the 90° case for a non-square ratio: quality metric must force the correct orientation,
// so rotZ=90 on ratio 0.7 must recover ±90° (mod 180), not 0°
{
  const frame = renderFrame({rotZ: 90});
  const tracker = makeTracker(frame.groundTruth.ratio);
  const result = detect(tracker, frame.rgba);
  const rotErr = result ? rotZError(result.modelViewTransform, frame.groundTruth.rotation) : 999;
  check('rotated 90°: orientation resolved by ratio quality (±' + rotErr.toFixed(1) + '°)', result !== null && rotErr < 2.5);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
