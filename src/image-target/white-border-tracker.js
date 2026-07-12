import {Matrix, inverse} from 'ml-matrix';
import {Estimator} from './estimation/estimator.js';
import {solveHomography} from './utils/homography.js';

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
// white threshold = max(MIN_WHITE_LUMA, WHITE_RELATIVE * <WHITE_PERCENTILE brightness>)
// relative to the brightest pixels so that a non-pure white (camera exposure, warm
// lighting, shadows) is still classified as white
const MIN_WHITE_LUMA = 100;
const WHITE_PERCENTILE = 0.98;
const WHITE_RELATIVE = 0.75;
// a white pixel must also be near-grey: chroma (max-min channel) below this fraction of brightness
const MAX_CHROMA_RATIO = 0.3;
// candidate white component must cover at least this fraction of the analysis frame
const MIN_COMPONENT_AREA_RATIO = 0.01;
// quad area / convex hull area: how "quadrilateral" the white region must be
const MIN_QUAD_FILL = 0.85;
// pose quality: ratio of the two rotation column norms of K^-1*H (1 = perfect ratio match,
// invariant to tilt). Used to resolve 90deg orientation and reject wrong aspect ratios.
const MIN_NORM_RATIO_QUALITY = 0.65;

class WhiteBorderTracker {
  constructor(inputWidth, inputHeight, markerDimensions, projectionTransform, {debugMode = false} = {}) {
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
    let sx = 0, sy = 0, sw = this.inputWidth, sh = this.inputHeight;
    let scale = this.workScale, dw = this.workWidth, dh = this.workHeight;
    if (roi !== null) {
      sx = Math.max(0, Math.floor(roi.x));
      sy = Math.max(0, Math.floor(roi.y));
      sw = Math.min(this.inputWidth - sx, Math.ceil(roi.width));
      sh = Math.min(this.inputHeight - sy, Math.ceil(roi.height));
      if (sw < 8 || sh < 8) return [];
      scale = Math.min(1, ROI_WORK_SIZE / Math.max(sw, sh));
      dw = Math.max(1, Math.round(sw * scale));
      dh = Math.max(1, Math.round(sh * scale));
    }
    this.context.drawImage(input, sx, sy, sw, sh, 0, 0, dw, dh);
    const {data} = this.context.getImageData(0, 0, dw, dh);
    const mask = this._whiteMask(data, dw, dh);
    const quads = this._quadComponents(mask, dw, dh);
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

  // build a binary mask of "white" pixels using an adaptive threshold:
  // brightness relative to the frame's brightest percentile + low chroma (near-grey)
  _whiteMask(rgba, width = this.workWidth, height = this.workHeight) {
    const n = width * height;
    const brightness = new Uint8Array(n);
    const chroma = new Uint8Array(n);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      brightness[i] = max;
      chroma[i] = max - min;
      histogram[max]++;
    }
    let count = 0;
    let percentileBrightness = 255;
    const percentileTarget = n * WHITE_PERCENTILE;
    for (let v = 0; v < 256; v++) {
      count += histogram[v];
      if (count >= percentileTarget) {
        percentileBrightness = v;
        break;
      }
    }
    const threshold = Math.max(MIN_WHITE_LUMA, percentileBrightness * WHITE_RELATIVE);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (brightness[i] >= threshold && chroma[i] <= MAX_CHROMA_RATIO * brightness[i]) {
        mask[i] = 1;
      }
    }
    return mask;
  }

  // find connected white components, keep quad-like ones, return their corner quads
  // (work coords, clockwise), biggest first — several white regions can coexist in the
  // frame (the card plus e.g. a white sheet of paper), the pose-quality gate picks the
  // one matching the target ratio
  _quadComponents(mask, width = this.workWidth, height = this.workHeight) {
    const n = width * height;
    const minArea = n * MIN_COMPONENT_AREA_RATIO;
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    // per-row horizontal extents of the current component: enough to build its convex hull
    const rowMin = new Int32Array(height);
    const rowMax = new Int32Array(height);

    const candidates = [];

    for (let start = 0; start < n; start++) {
      if (mask[start] === 0 || visited[start] === 1) continue;

      rowMin.fill(width);
      rowMax.fill(-1);
      let area = 0;
      let stackSize = 0;
      stack[stackSize++] = start;
      visited[start] = 1;
      while (stackSize > 0) {
        const index = stack[--stackSize];
        const x = index % width;
        const y = (index / width) | 0;
        area++;
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
        if (x > 0 && mask[index - 1] === 1 && visited[index - 1] === 0) { visited[index - 1] = 1; stack[stackSize++] = index - 1; }
        if (x < width - 1 && mask[index + 1] === 1 && visited[index + 1] === 0) { visited[index + 1] = 1; stack[stackSize++] = index + 1; }
        if (y > 0 && mask[index - width] === 1 && visited[index - width] === 0) { visited[index - width] = 1; stack[stackSize++] = index - width; }
        if (y < height - 1 && mask[index + width] === 1 && visited[index + width] === 0) { visited[index + width] = 1; stack[stackSize++] = index + width; }
      }
      if (area < minArea) continue;

      const points = [];
      for (let y = 0; y < height; y++) {
        if (rowMax[y] < 0) continue;
        points.push([rowMin[y], y]);
        if (rowMax[y] !== rowMin[y]) points.push([rowMax[y], y]);
      }
      const hull = this._convexHull(points);
      if (hull.length < 4) continue;

      const quad = this._simplifyToQuad(hull);
      const quadArea = Math.abs(this._polygonArea(quad));
      const hullArea = Math.abs(this._polygonArea(hull));
      if (hullArea === 0 || quadArea / hullArea < MIN_QUAD_FILL) continue;
      // reject a fully white view (e.g. white wall): all 4 corners on the frame boundary
      const onBorder = quad.filter(([x, y]) => x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2);
      if (onBorder.length === 4) continue;

      candidates.push({area: quadArea, corners: this._orderClockwise(this._refineCorners(hull, quad))});
    }

    candidates.sort((a, b) => b.area - a.area);
    return candidates.slice(0, 5).map((c) => c.corners);
  }

  // Andrew monotone chain, returns hull vertices in counter-clockwise order (math coords)
  _convexHull(points) {
    points.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    if (points.length <= 3) return points.slice();
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of points) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // reduce a convex polygon to 4 vertices by repeatedly removing the vertex whose
  // neighbour triangle has the smallest area (least significant corner)
  _simplifyToQuad(hull) {
    const polygon = hull.slice();
    while (polygon.length > 4) {
      let minTriangleArea = Infinity;
      let minIndex = 0;
      for (let i = 0; i < polygon.length; i++) {
        const prev = polygon[(i + polygon.length - 1) % polygon.length];
        const current = polygon[i];
        const next = polygon[(i + 1) % polygon.length];
        const triangleArea = Math.abs(
          (current[0] - prev[0]) * (next[1] - prev[1]) - (current[1] - prev[1]) * (next[0] - prev[0])
        );
        if (triangleArea < minTriangleArea) {
          minTriangleArea = triangleArea;
          minIndex = i;
        }
      }
      polygon.splice(minIndex, 1);
    }
    return polygon;
  }

  _polygonArea(polygon) {
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const [x1, y1] = polygon[i];
      const [x2, y2] = polygon[(i + 1) % polygon.length];
      area += x1 * y2 - x2 * y1;
    }
    return area / 2;
  }

  // sub-pixel corner refinement: fit a total-least-squares line to the hull points of each
  // quad edge and intersect adjacent lines (hull corners are quantized to the work grid)
  _refineCorners(hull, quad) {
    const cornerIndexes = quad.map((corner) => hull.findIndex((p) => p === corner));
    if (cornerIndexes.includes(-1)) return quad;
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const from = cornerIndexes[i];
      const to = cornerIndexes[(i + 1) % 4];
      const edgePoints = [];
      for (let j = from; ; j = (j + 1) % hull.length) {
        edgePoints.push(hull[j]);
        if (j === to) break;
      }
      lines.push(this._fitLine(edgePoints));
    }
    const refined = [];
    for (let i = 0; i < 4; i++) {
      const intersection = this._intersectLines(lines[(i + 3) % 4], lines[i]);
      refined.push(intersection !== null ? intersection : quad[i]);
    }
    return refined;
  }

  // total least squares line fit, returns {px, py, dx, dy} (point + unit direction)
  _fitLine(points) {
    let meanX = 0, meanY = 0;
    for (const [x, y] of points) { meanX += x; meanY += y; }
    meanX /= points.length;
    meanY /= points.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of points) {
      const dx = x - meanX;
      const dy = y - meanY;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return {px: meanX, py: meanY, dx: Math.cos(angle), dy: Math.sin(angle)};
  }

  _intersectLines(l1, l2) {
    const denominator = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(denominator) < 1e-9) return null;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / denominator;
    return [l1.px + t * l1.dx, l1.py + t * l1.dy];
  }

  // order the 4 corners clockwise in image coords (y down), starting from the top-left-most
  _orderClockwise(quad) {
    const centerX = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
    const centerY = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
    const sorted = quad.slice().sort((a, b) =>
      Math.atan2(a[1] - centerY, a[0] - centerX) - Math.atan2(b[1] - centerY, b[0] - centerX)
    );
    // atan2 ascending = clockwise when y points down; start at the corner closest to top-left
    let startIndex = 0;
    let minSum = Infinity;
    for (let i = 0; i < 4; i++) {
      const sum = sorted[i][0] + sorted[i][1];
      if (sum < minSum) {
        minSum = sum;
        startIndex = i;
      }
    }
    const ordered = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = sorted[(startIndex + i) % 4];
      ordered.push({x, y});
    }
    return ordered;
  }
}

export {
  WhiteBorderTracker,
}
