import {Matrix, inverse} from 'ml-matrix';
import {Estimator} from './estimation/estimator.js';
import {solveHomography} from './utils/homography.js';
import {whiteMask, quadComponents} from './white-border-pixels.js';

// Alternative tracking system: instead of matching pre-compiled (.mind) image features,
// it detects the outer quad of a white border/contour surrounding the target image and
// estimates the pose from the 4 corners. Works with any image content (photo, drawing,
// even large white zones) as long as the physical target has a white border, and does
// not require any compilation step. The expected image ratio (height/width) is used to
// resolve the quad orientation and to reject wrongly-shaped white regions.

// analysis resolution: the camera frame is downscaled so that its largest side is WORK_SIZE
const WORK_SIZE = 480;
// the ROI fast pass (tracking) is analyzed at a lower cap: the card fills most of the ROI,
// so 320 still samples the border denser than the full-frame pass while bounding the cost
const ROI_WORK_SIZE = 320;
// white/quad pixel-stage thresholds (MIN_WHITE_LUMA, WHITE_RELATIVE, MAX_CHROMA_RATIO,
// MIN_COMPONENT_AREA_RATIO, MIN_QUAD_FILL...) live in white-border-pixels.js, shared with
// the offload worker.
// pose quality: ratio of the two rotation column norms of K^-1*H (1 = perfect ratio match,
// invariant to tilt). Used to resolve 90deg orientation and reject wrong aspect ratios.
const MIN_NORM_RATIO_QUALITY = 0.65;

class WhiteBorderTracker {
  // `worker` (optional): a Worker running white-border-tracker.worker.js, created by the
  // caller (Controller) — the Vite `?worker&inline` import lives there so this module stays
  // importable in plain Node (tests)
  constructor(inputWidth, inputHeight, markerDimensions, projectionTransform, {debugMode = false, worker = null} = {}) {
    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;
    this.markerDimensions = markerDimensions; // [[w, h], ...] in marker units
    this.debugMode = debugMode;
    this.estimator = new Estimator(projectionTransform);
    this.kInv = inverse(new Matrix(projectionTransform));

    this.workScale = Math.min(1, WORK_SIZE / Math.max(inputWidth, inputHeight));
    this.workWidth = Math.max(1, Math.round(inputWidth * this.workScale));
    this.workHeight = Math.max(1, Math.round(inputHeight * this.workScale));
    this.canvas = document.createElement('canvas');
    // square-capable canvas: an ROI (fast tracking pass) can be portrait even on a landscape input
    this.canvas.width = Math.max(this.workWidth, ROI_WORK_SIZE);
    this.canvas.height = Math.max(this.workHeight, ROI_WORK_SIZE);
    this.context = this.canvas.getContext('2d', {willReadFrequently: true});

    // optional offload: the pixel stage (mask + components + quad) runs in a worker so a
    // slow frame never blocks the main thread / 3D renderer
    this.worker = worker;
    this.workerRequestId = 0;
    this.workerDetectDone = null;
    if (this.worker !== null) {
      this.worker.onmessage = (msg) => {
        if (msg.data.type === 'detectDone' && this.workerDetectDone !== null && msg.data.requestId === this.workerRequestId) {
          this.workerDetectDone(msg.data.quads);
        }
      };
    }
  }

  dispose() {
    if (this.worker !== null) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  // padded bounding box around previously tracked quads: the fast-pass search
  // neighborhood for the next frame (in input coords)
  roiAround(cornersList, padFrac = 0.25) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const corners of cornersList) {
      for (const c of corners) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x > maxX) maxX = c.x;
        if (c.y > maxY) maxY = c.y;
      }
    }
    const pad = padFrac * Math.max(maxX - minX, maxY - minY);
    return {x: minX - pad, y: minY - pad, width: (maxX - minX) + 2 * pad, height: (maxY - minY) + 2 * pad};
  }

  // detect white-border quad candidates in the current frame.
  // returns an array (possibly empty) of 4-corner quads ordered clockwise
  // (image coords, full input resolution), biggest first.
  // Passing an `roi` ({x, y, width, height} in input coords, from roiAround) restricts the
  // analysis to that neighborhood — the fast tracking pass: fewer pixels to read and scan,
  // and since the ROI is analyzed at up to WORK_SIZE too, precision even improves up close.
  findQuadCandidates(input, roi = null) {
    const view = this._readAnalysisPixels(input, roi);
    if (view === null) return [];
    const mask = whiteMask(view.data, view.dw, view.dh);
    const quads = quadComponents(mask, view.dw, view.dh);
    return this._toInputCoords(quads, view);
  }

  // same as findQuadCandidates but the pixel stage runs in the offload worker (when
  // enabled); the canvas readback stays on the main thread since the video element and
  // 2d context live there
  async findQuadCandidatesAsync(input, roi = null) {
    if (this.worker === null) return this.findQuadCandidates(input, roi);
    const view = this._readAnalysisPixels(input, roi);
    if (view === null) return [];
    const quads = await new Promise((resolve) => {
      this.workerRequestId++;
      this.workerDetectDone = resolve;
      this.worker.postMessage(
        {type: 'detect', requestId: this.workerRequestId, buffer: view.data.buffer, width: view.dw, height: view.dh},
        [view.data.buffer]);
    });
    return this._toInputCoords(quads, view);
  }

  // downscale the (optionally ROI-cropped) input into the analysis canvas and read it back
  _readAnalysisPixels(input, roi) {
    let sx = 0, sy = 0, sw = this.inputWidth, sh = this.inputHeight;
    let scale = this.workScale, dw = this.workWidth, dh = this.workHeight;
    if (roi !== null) {
      sx = Math.max(0, Math.floor(roi.x));
      sy = Math.max(0, Math.floor(roi.y));
      sw = Math.min(this.inputWidth - sx, Math.ceil(roi.width));
      sh = Math.min(this.inputHeight - sy, Math.ceil(roi.height));
      if (sw < 8 || sh < 8) return null;
      scale = Math.min(1, ROI_WORK_SIZE / Math.max(sw, sh));
      dw = Math.max(1, Math.round(sw * scale));
      dh = Math.max(1, Math.round(sh * scale));
    }
    this.context.drawImage(input, sx, sy, sw, sh, 0, 0, dw, dh);
    const {data} = this.context.getImageData(0, 0, dw, dh);
    return {data, sx, sy, scale, dw, dh};
  }

  _toInputCoords(quads, {sx, sy, scale}) {
    return quads.map((quad) => quad.map((p) => ({x: sx + p.x / scale, y: sy + p.y / scale})));
  }

  // initial detection: among the candidate quads, find which one matches a (non-tracked)
  // target, and its pose. Orientation is chosen by pose quality (aspect ratio consistency),
  // with ties broken towards the marker being upright on screen.
  matchQuad(quadCandidates, targetIndexes) {
    let best = null;
    for (const corners of quadCandidates) {
      for (const targetIndex of targetIndexes) {
        const candidate = this._bestOrientation(corners, targetIndex);
        if (candidate === null) continue;
        if (best === null || candidate.quality > best.quality) {
          best = {targetIndex, ...candidate};
        }
      }
    }
    if (best === null || best.quality < MIN_NORM_RATIO_QUALITY) return null;
    const modelViewTransform = this.estimator.estimate({
      screenCoords: best.corners,
      worldCoords: this._worldCorners(best.targetIndex),
    });
    return {targetIndex: best.targetIndex, modelViewTransform, corners: best.corners};
  }

  // tracking update: pick the candidate quad and corner assignment temporally consistent
  // with the previous frame
  trackQuad(quadCandidates, targetIndex, lastCorners) {
    let best = null;
    for (const corners of quadCandidates) {
      for (let shift = 0; shift < 4; shift++) {
        let dist = 0;
        for (let i = 0; i < 4; i++) {
          const c = corners[(i + shift) % 4];
          const dx = c.x - lastCorners[i].x;
          const dy = c.y - lastCorners[i].y;
          dist += dx * dx + dy * dy;
        }
        if (best === null || dist < best.dist) {
          best = {corners, shift, dist};
        }
      }
    }
    if (best === null) return null;
    const shifted = this._shiftCorners(best.corners, best.shift);
    if (this._quality(shifted, targetIndex) < MIN_NORM_RATIO_QUALITY) return null;
    const modelViewTransform = this.estimator.estimate({
      screenCoords: shifted,
      worldCoords: this._worldCorners(targetIndex),
    });
    return {modelViewTransform, corners: shifted};
  }

  // marker corners TL, TR, BR, BL (clockwise, y pointing down like image coords)
  _worldCorners(targetIndex) {
    const [w, h] = this.markerDimensions[targetIndex];
    return [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}];
  }

  _shiftCorners(corners, shift) {
    return [0, 1, 2, 3].map((i) => corners[(i + shift) % 4]);
  }

  // pose quality in [0,1]: with the correct world rectangle ratio the two rotation columns
  // of K^-1 * H have equal norms regardless of tilt; a 90deg-wrong assignment (or a white
  // region with a very different aspect ratio) unbalances them.
  _quality(corners, targetIndex) {
    const world = this._worldCorners(targetIndex);
    const H = solveHomography(world.map((p) => [p.x, p.y]), corners.map((p) => [p.x, p.y]));
    if (H === null) return 0;
    const KInvH = this.kInv.mmul(new Matrix([
      [H[0], H[1], H[2]],
      [H[3], H[4], H[5]],
      [H[6], H[7], H[8]],
    ])).to1DArray();
    const norm1 = Math.sqrt(KInvH[0] * KInvH[0] + KInvH[3] * KInvH[3] + KInvH[6] * KInvH[6]);
    const norm2 = Math.sqrt(KInvH[1] * KInvH[1] + KInvH[4] * KInvH[4] + KInvH[7] * KInvH[7]);
    if (norm1 === 0 || norm2 === 0) return 0;
    return Math.min(norm1, norm2) / Math.max(norm1, norm2);
  }

  // try the 4 cyclic corner assignments; keep the best quality, ties (0deg vs 180deg give
  // identical quality) broken by whichever puts the marker top edge upward on screen
  _bestOrientation(corners, targetIndex) {
    let best = null;
    for (let shift = 0; shift < 4; shift++) {
      const shifted = this._shiftCorners(corners, shift);
      const quality = this._quality(shifted, targetIndex);
      const upright = this._uprightScore(shifted);
      if (best === null || quality > best.quality + 1e-3 ||
        (Math.abs(quality - best.quality) <= 1e-3 && upright > best.upright)) {
        best = {corners: shifted, quality, upright};
      }
    }
    return best;
  }

  // how much the vector from the bottom edge midpoint to the top edge midpoint points up on screen
  _uprightScore(corners) {
    const topX = (corners[0].x + corners[1].x) / 2;
    const topY = (corners[0].y + corners[1].y) / 2;
    const bottomX = (corners[2].x + corners[3].x) / 2;
    const bottomY = (corners[2].y + corners[3].y) / 2;
    const dx = topX - bottomX;
    const dy = topY - bottomY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return 0;
    return -dy / len; // image y goes down, so "up" is negative dy
  }

  // thin delegates to the shared pixel stage (white-border-pixels.js) — kept as methods
  // so tests can drive the pipeline without a canvas
  _whiteMask(rgba, width = this.workWidth, height = this.workHeight) {
    return whiteMask(rgba, width, height);
  }

  _quadComponents(mask, width = this.workWidth, height = this.workHeight) {
    return quadComponents(mask, width, height);
  }
}

export {
  WhiteBorderTracker,
}
