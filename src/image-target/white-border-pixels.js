// Pure pixel stage of the white-border tracker: adaptive white mask + connected components
// + quad extraction. No DOM and no class state, so it runs identically on the main thread
// (WhiteBorderTracker) and inside the offload worker (white-border-tracker.worker.js).

// white threshold = max(MIN_WHITE_LUMA, WHITE_RELATIVE * <WHITE_PERCENTILE brightness>)
// relative to the brightest pixels so that a non-pure white (camera exposure, warm
// lighting, shadows) is still classified as white
const MIN_WHITE_LUMA = 100;
const WHITE_PERCENTILE = 0.98;
const WHITE_RELATIVE = 0.85;
// a white pixel must also be near-grey: chroma (max-min channel) below this fraction of brightness
const MAX_CHROMA_RATIO = 0.3;
// candidate white component must cover at least this fraction of the analysis frame
const MIN_COMPONENT_AREA_RATIO = 0.01;
// quad area / convex hull area: how "quadrilateral" the white region must be
const MIN_QUAD_FILL = 0.85;

// strict "core-white" mask, used only to snap the quad EDGES to the true frame boundary
// (not for discovery). The physical white frame is near-pure-white everywhere — very high
// luminance, almost no chroma — whereas even a bright hazy background keeps some chroma or
// falls short of pure white. Discovery still runs on the loose mask above (robust to warm/
// dim light); this just pulls the sub-pixel edges off any bright-background bleed.
const STRICT_MIN_LUMA = 235;
const STRICT_RELATIVE = 0.95;
const STRICT_MAX_CHROMA_RATIO = 0.08;
// edge snap: how far (analysis px) to search inward from the coarse edge for the strict frame
// boundary, how many consecutive strict pixels confirm the frame band (reject speckle), and
// the minimum boundary points an edge needs before we trust the snapped line over the loose fit
const REFINE_BAND = 48;
const REFINE_RUN = 3;
const REFINE_MIN_POINTS = 8;

// build a binary mask of "white" pixels using an adaptive threshold:
// brightness relative to the frame's brightest percentile + low chroma (near-grey)
const whiteMask = (rgba, width, height) => {
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
};

// build the strict "core-white" mask (see STRICT_* constants): near-pure-white pixels only,
// used by the edge-snap in refineCorners. Same adaptive-brightness idea as whiteMask but a
// much tighter luminance floor and chroma cap, so bright low-contrast background is excluded.
const strictWhiteMask = (rgba, width, height) => {
  const n = width * height;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    histogram[Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])]++;
  }
  let count = 0;
  let percentileBrightness = 255;
  const percentileTarget = n * WHITE_PERCENTILE;
  for (let v = 0; v < 256; v++) {
    count += histogram[v];
    if (count >= percentileTarget) { percentileBrightness = v; break; }
  }
  const threshold = Math.max(STRICT_MIN_LUMA, percentileBrightness * STRICT_RELATIVE);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const max = Math.max(r, g, b);
    if (max >= threshold && (max - Math.min(r, g, b)) <= STRICT_MAX_CHROMA_RATIO * max) {
      mask[i] = 1;
    }
  }
  return mask;
};

// find connected white components, keep quad-like ones, return their corner quads
// (analysis coords, clockwise), biggest first — several white regions can coexist in the
// frame (the card plus e.g. a white sheet of paper), the pose-quality gate picks the
// one matching the target ratio
const quadComponents = (mask, width, height, strictMask = null) => {
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
    const hull = convexHull(points);
    if (hull.length < 4) continue;

    const quad = simplifyToQuad(hull);
    const quadArea = Math.abs(polygonArea(quad));
    const hullArea = Math.abs(polygonArea(hull));
    if (hullArea === 0 || quadArea / hullArea < MIN_QUAD_FILL) continue;
    // reject a fully white view (e.g. white wall): all 4 corners on the frame boundary
    const onBorder = quad.filter(([x, y]) => x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2);
    if (onBorder.length === 4) continue;

    candidates.push({area: quadArea, corners: orderClockwise(refineCorners(hull, quad, strictMask, width, height))});
  }

  candidates.sort((a, b) => b.area - a.area);
  return candidates.slice(0, 5).map((c) => c.corners);
};

// Andrew monotone chain, returns hull vertices in counter-clockwise order (math coords)
const convexHull = (points) => {
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
};

// reduce a convex polygon to 4 vertices by repeatedly removing the vertex whose
// neighbour triangle has the smallest area (least significant corner)
const simplifyToQuad = (hull) => {
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
};

const polygonArea = (polygon) => {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
};

// sub-pixel corner refinement: fit a line to each quad edge and intersect adjacent lines
// (hull corners are quantized to the analysis grid). Each edge line is, in order of
// preference: (1) snapped to the strict core-white frame boundary when a strict mask is
// supplied and enough boundary points are found — this pulls the edge off any bright-
// background bleed that the loose mask merged into the frame; otherwise (2) a robust
// trimmed fit of the loose hull points along that edge.
const refineCorners = (hull, quad, strictMask = null, width = 0, height = 0) => {
  const cornerIndexes = quad.map((corner) => hull.findIndex((p) => p === corner));
  if (cornerIndexes.includes(-1)) return quad;
  const centerX = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
  const centerY = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const from = cornerIndexes[i];
    const to = cornerIndexes[(i + 1) % 4];
    const edgePoints = [];
    for (let j = from; ; j = (j + 1) % hull.length) {
      edgePoints.push(hull[j]);
      if (j === to) break;
    }
    const looseLine = fitLineRobust(edgePoints);
    let line = looseLine;
    if (strictMask !== null) {
      const snapped = snapEdgeToStrict(quad[i], quad[(i + 1) % 4], centerX, centerY, strictMask, width, height);
      if (snapped !== null) line = snapped;
    }
    lines.push(line);
  }
  const refined = [];
  for (let i = 0; i < 4; i++) {
    const intersection = intersectLines(lines[(i + 3) % 4], lines[i]);
    refined.push(intersection !== null ? intersection : quad[i]);
  }
  return refined;
};

// walk along the coarse edge a->b and, at each step, search inward (toward the quad centre)
// for the first run of REFINE_RUN consecutive strict-white pixels: that run's outer pixel is
// a point on the true frame boundary. Robust-fit a line to those points; the few samples that
// latch onto bright background near a corner become residual outliers and are trimmed. Returns
// null (caller keeps the loose fit) when too few boundary points are found — e.g. a genuinely
// off-white/warm frame that leaves the strict mask empty along this edge.
const snapEdgeToStrict = (a, b, centerX, centerY, strictMask, width, height) => {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const edgeLen = Math.hypot(ex, ey);
  if (edgeLen < 1) return null;
  // inward unit normal (perpendicular to the edge, pointing toward the quad centre)
  let nx = -ey / edgeLen;
  let ny = ex / edgeLen;
  const midX = (a[0] + b[0]) / 2;
  const midY = (a[1] + b[1]) / 2;
  if (nx * (centerX - midX) + ny * (centerY - midY) < 0) { nx = -nx; ny = -ny; }
  const samples = Math.max(2, Math.round(edgeLen));
  const boundary = [];
  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    const px = a[0] + ex * t;
    const py = a[1] + ey * t;
    let run = 0;
    for (let d = 0; d <= REFINE_BAND; d++) {
      const qx = Math.round(px + nx * d);
      const qy = Math.round(py + ny * d);
      if (qx < 0 || qy < 0 || qx >= width || qy >= height) break;
      if (strictMask[qy * width + qx] === 1) {
        run++;
        if (run >= REFINE_RUN) {
          const outer = d - REFINE_RUN + 1; // outer pixel of the confirmed strict run
          boundary.push([px + nx * outer, py + ny * outer]);
          break;
        }
      } else {
        run = 0;
      }
    }
  }
  if (boundary.length < REFINE_MIN_POINTS) return null;
  return fitLineRobust(boundary);
};

// total least squares line fit, returns {px, py, dx, dy} (point + unit direction)
const fitLine = (points) => {
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
};

// perpendicular distance from a point to a fitted line
const lineResidual = (line, x, y) => Math.abs((x - line.px) * line.dy - (y - line.py) * line.dx);

// robust edge fit: fit all points, drop those whose perpendicular residual is a clear outlier
// (background bleed / occlusion contaminates one end of an edge), then refit on the inliers.
// Keeps at least 60% of the points and never fewer than 4, so a clean edge is left untouched.
const fitLineRobust = (points) => {
  if (points.length < 4) return fitLine(points);
  let line = fitLine(points);
  for (let pass = 0; pass < 2; pass++) {
    const residuals = points.map(([x, y]) => lineResidual(line, x, y));
    const sorted = residuals.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const cutoff = Math.max(1.5, 3 * median);
    const inliers = points.filter((_, i) => residuals[i] <= cutoff);
    if (inliers.length === points.length) break;
    if (inliers.length < Math.max(4, points.length * 0.6)) break;
    line = fitLine(inliers);
    points = inliers;
  }
  return line;
};

const intersectLines = (l1, l2) => {
  const denominator = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / denominator;
  return [l1.px + t * l1.dx, l1.py + t * l1.dy];
};

// order the 4 corners clockwise in image coords (y down), starting from the top-left-most
const orderClockwise = (quad) => {
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
};

export {
  whiteMask,
  strictWhiteMask,
  quadComponents,
}
