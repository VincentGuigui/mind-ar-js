// Synthetic camera-frame renderer for white-border tracking QA.
//
// Renders an RGBA frame containing a white-bordered card at a configurable 3D pose
// (position, distance, in-plane rotation, tilt), with configurable border color/thickness,
// card content (photo-like, large white zones, dark), background (plain, cluttered, with an
// adversarial white rectangle), lighting (dimming, warm tint, gradient) and sensor noise.
// Returns the frame plus the ground truth: the projected outer corners of the card and the
// expected marker pose, so a tracker's output can be checked numerically.
//
// Pure JS (no DOM, no dependency): usable from Node tests and from a browser page
// (putImageData). Uses the same camera intrinsics convention as MindAR's Controller
// (vertical fov 45deg, principal point at the frame center; x right, y down, z forward).

// deterministic PRNG so tests are reproducible
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

const DEG = Math.PI / 180;

const matMul3 = (A, B) => {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
  return C;
};

const inv3 = (m) => {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
};

const rotationMatrix = (rotZDeg, tiltXDeg, tiltYDeg) => {
  const cz = Math.cos(rotZDeg * DEG), sz = Math.sin(rotZDeg * DEG);
  const cx = Math.cos(tiltXDeg * DEG), sx = Math.sin(tiltXDeg * DEG);
  const cy = Math.cos(tiltYDeg * DEG), sy = Math.sin(tiltYDeg * DEG);
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  return matMul3(Ry, matMul3(Rx, Rz)); // in-plane rotation first, then tilts
};

// same convention as MindAR Controller
export const cameraIntrinsics = (width, height) => {
  const f = (height / 2) / Math.tan((45 / 2) * DEG);
  return [[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]];
};

// content color at card-relative coordinates (nu, nv in 0..1), 0..255 per channel
const contentColor = (kind, nu, nv) => {
  switch (kind) {
    case 'whiteZones': {
      // photo-like pattern with a big white blob touching the border (worst case allowed by spec)
      if ((nu - 0.35) * (nu - 0.35) + (nv - 0.2) * (nv - 0.2) < 0.09) return [250, 250, 248];
      if (nu > 0.75 && nv > 0.55) return [252, 250, 250];
      // fallthrough to photo pattern
    }
    case 'photo': {
      const r = 110 + 90 * Math.sin(nu * 9.3) * Math.cos(nv * 6.1);
      const g = 100 + 80 * Math.sin(nu * 5.7 + 1.3) * Math.sin(nv * 8.2);
      const b = 120 + 90 * Math.cos(nu * 7.7) * Math.sin(nv * 4.9 + 0.6);
      return [r, g, b];
    }
    case 'dark':
    default:
      return [55, 50, 60];
  }
};

export const defaultParams = {
  width: 480,
  height: 270,
  ratio: 0.7,          // card outer height/width
  cardWidthUnits: 100, // card width in world units (arbitrary)
  distance: 180,       // camera→card distance in world units
  offsetX: 0,          // world units, right of the optical axis
  offsetY: 0,          // world units, below the optical axis
  rotZ: 0,             // in-plane rotation, degrees
  tiltX: 0,            // tilt around the horizontal axis, degrees
  tiltY: 0,            // tilt around the vertical axis, degrees
  borderFrac: 0.08,    // white border thickness relative to the card width
  borderColor: [255, 255, 255],
  content: 'photo',    // 'photo' | 'whiteZones' | 'dark'
  background: 'clutter', // 'plain' | 'clutter'
  adversarialWhiteRect: false, // add a bright white rectangle of a very different ratio
  lightLevel: 1.0,     // global brightness multiplier
  warmth: 0,           // 0..1 warm tint (lowers blue, slightly lowers green)
  gradient: 0,         // 0..1 left-to-right lighting falloff
  noise: 0,            // 0..N gaussian-ish noise amplitude (in 0..255 units)
  seed: 1234,
};

export function renderFrame(userParams = {}) {
  const p = {...defaultParams, ...userParams};
  const {width, height} = p;
  const K = cameraIntrinsics(width, height);
  const R = rotationMatrix(p.rotZ, p.tiltX, p.tiltY);
  const W = p.cardWidthUnits;
  const Hc = W * p.ratio;
  const t = [p.offsetX, p.offsetY, p.distance];

  // homography card(0..W, 0..Hc, y down) -> pixels: H = K * [r1, r2, t'] with the card
  // centered on its own origin (t' places the card's top-left corner)
  const r1 = [R[0][0], R[1][0], R[2][0]];
  const r2 = [R[0][1], R[1][1], R[2][1]];
  const tPrime = [
    t[0] - r1[0] * W / 2 - r2[0] * Hc / 2,
    t[1] - r1[1] * W / 2 - r2[1] * Hc / 2,
    t[2] - r1[2] * W / 2 - r2[2] * Hc / 2,
  ];
  const Rt = [
    [r1[0], r2[0], tPrime[0]],
    [r1[1], r2[1], tPrime[1]],
    [r1[2], r2[2], tPrime[2]],
  ];
  const H = matMul3(K, Rt);
  const Hinv = inv3(H);

  const project = (u, v) => {
    const x = H[0][0] * u + H[0][1] * v + H[0][2];
    const y = H[1][0] * u + H[1][1] * v + H[1][2];
    const w = H[2][0] * u + H[2][1] * v + H[2][2];
    return {x: x / w, y: y / w};
  };
  const cornersGT = [project(0, 0), project(W, 0), project(W, Hc), project(0, Hc)]; // TL,TR,BR,BL

  const rand = mulberry32(p.seed);
  // background clutter: deterministic colored rectangles, some bright but none white+big
  const clutterRects = [];
  if (p.background === 'clutter') {
    for (let i = 0; i < 18; i++) {
      const bright = rand() < 0.3;
      clutterRects.push({
        x: rand() * width, y: rand() * height,
        w: (0.03 + rand() * 0.1) * width, h: (0.03 + rand() * 0.1) * height,
        color: bright
          ? [200 + rand() * 30, 190 + rand() * 30, 170 + rand() * 30]
          : [rand() * 180, rand() * 180, rand() * 180],
      });
    }
  }
  if (p.adversarialWhiteRect) {
    // a pure-white rectangle with a very different aspect ratio (e.g. a strip of paper)
    clutterRects.push({x: width * 0.05, y: height * 0.75, w: width * 0.5, h: height * 0.08, color: [255, 255, 255]});
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const bw = p.borderFrac * W; // border thickness in card units
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c;
      // card?
      const u = Hinv[0][0] * x + Hinv[0][1] * y + Hinv[0][2];
      const v = Hinv[1][0] * x + Hinv[1][1] * y + Hinv[1][2];
      const w = Hinv[2][0] * x + Hinv[2][1] * y + Hinv[2][2];
      const cu = u / w, cv = v / w;
      if (w !== 0 && cu >= 0 && cu <= W && cv >= 0 && cv <= Hc) {
        if (cu < bw || cu > W - bw || cv < bw || cv > Hc - bw) {
          c = p.borderColor.slice();
        } else {
          c = contentColor(p.content, (cu - bw) / (W - 2 * bw), (cv - bw) / (Hc - 2 * bw));
        }
      } else {
        // background
        c = [90 + 40 * (y / height), 88 + 35 * (y / height), 95 + 30 * (y / height)];
        for (const r of clutterRects) {
          if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { c = r.color.slice(); break; }
        }
      }
      // lighting: global level, warm tint, left-to-right gradient
      const grad = 1 - p.gradient * (x / width) * 0.5;
      const level = p.lightLevel * grad;
      c[0] *= level;
      c[1] *= level * (1 - 0.08 * p.warmth);
      c[2] *= level * (1 - 0.35 * p.warmth);
      if (p.noise > 0) {
        const n = (rand() + rand() - 1) * p.noise;
        c[0] += n; c[1] += n; c[2] += n;
      }
      const o = (y * width + x) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
  }

  return {
    rgba, width, height,
    groundTruth: {
      corners: cornersGT,           // outer white-border quad TL,TR,BR,BL in pixels
      rotation: R,                  // marker rotation
      translation: tPrime,          // marker (top-left corner) translation, world units
      cardWidthUnits: W,
      ratio: p.ratio,
    },
  };
}
