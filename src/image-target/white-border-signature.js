// Zone-color signature for white-border targets: a compact fingerprint of the target's
// interior content, sampled as a 3x3 grid of average colors and normalized by the white
// border (which acts as a built-in white-balance/exposure reference patch). Used to:
//   - reject false positives (a blank white rectangle, or a DIFFERENT card of the same ratio)
//   - resolve the orientation ambiguity a plain rectangular border leaves (180deg, and 90deg
//     for near-square cards) that pose-from-ratio alone cannot.
//
// The signature is 27 numbers: 9 zones in ROW-MAJOR order (TL, T, TR, L, M, R, BL, B, BR),
// each [R, G, B] in 0..255, normalized so the observed border white maps to 255. It is
// computed the SAME way at authoring time (from the flat target image, e.g. by the POPcard
// creator) and at run time (from the camera image through the detected quad's homography):
// both provide a `sample(nu, nv)` callback over the FULL card in normalized [0,1] coordinates
// (the outer white-frame corners are (0,0)..(1,1)), and share the geometry below.

const GRID = 3;                 // 3x3 zones
const SIGNATURE_LENGTH = GRID * GRID * 3;
const ZONE_SAMPLES = 5;         // NxN sub-samples averaged per zone
const WHITE_SAMPLES_PER_EDGE = 5;

// Sample the border ring (inside the margin, at half border-width from each edge) to get the
// observed white reference, then sample the 3x3 interior zones and normalize by it.
// `sample(nu, nv)` returns [r,g,b] (0..255) or null (outside the image); nulls are skipped.
// `borderWidth` is the white-frame thickness as a fraction of the card side (content rect =
// [borderWidth, 1-borderWidth]^2). Returns a Float64Array(27), or null if too little was
// sampled to be meaningful.
const computeSignature = (sample, borderWidth) => {
  const b = Math.min(0.45, Math.max(0, borderWidth));
  const mid = b / 2;

  // observed white from the four margin mid-lines
  let wr = 0, wg = 0, wb = 0, wn = 0;
  const acc = (rgb) => { if (rgb) { wr += rgb[0]; wg += rgb[1]; wb += rgb[2]; wn++; } };
  for (let i = 1; i <= WHITE_SAMPLES_PER_EDGE; i++) {
    const t = i / (WHITE_SAMPLES_PER_EDGE + 1);
    acc(sample(t, mid));         // top edge
    acc(sample(t, 1 - mid));     // bottom edge
    acc(sample(mid, t));         // left edge
    acc(sample(1 - mid, t));     // right edge
  }
  if (wn < 4) return null;
  // guard: a zero/near-zero channel would blow up the normalization
  const white = [Math.max(1, wr / wn), Math.max(1, wg / wn), Math.max(1, wb / wn)];

  const inner = 1 - 2 * b; // content extent in normalized card coords
  if (inner <= 0) return null;

  const sig = new Float64Array(SIGNATURE_LENGTH);
  let k = 0;
  let sampled = 0;
  for (let zy = 0; zy < GRID; zy++) {
    for (let zx = 0; zx < GRID; zx++) {
      let r = 0, g = 0, bl = 0, n = 0;
      for (let sy = 0; sy < ZONE_SAMPLES; sy++) {
        for (let sx = 0; sx < ZONE_SAMPLES; sx++) {
          const nu = b + (zx + (sx + 0.5) / ZONE_SAMPLES) / GRID * inner;
          const nv = b + (zy + (sy + 0.5) / ZONE_SAMPLES) / GRID * inner;
          const rgb = sample(nu, nv);
          if (rgb) { r += rgb[0]; g += rgb[1]; bl += rgb[2]; n++; }
        }
      }
      if (n > 0) {
        sig[k]     = Math.min(255, (r / n) * 255 / white[0]);
        sig[k + 1] = Math.min(255, (g / n) * 255 / white[1]);
        sig[k + 2] = Math.min(255, (bl / n) * 255 / white[2]);
        sampled++;
      } else {
        sig[k] = sig[k + 1] = sig[k + 2] = 255; // treat unseen zone as neutral
      }
      k += 3;
    }
  }
  if (sampled < GRID * GRID - 1) return null; // most of the card must be visible
  return sig;
};

// mean absolute per-channel difference (0..255); lower = more similar
const signatureDistance = (a, b) => {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

export {
  SIGNATURE_LENGTH,
  computeSignature,
  signatureDistance,
}
