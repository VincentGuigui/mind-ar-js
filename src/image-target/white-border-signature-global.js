// Global (IIFE) entry that exposes the white-border content-signature helpers so an authoring
// tool (e.g. the POPcard creator) can compute the SAME signature the tracker compares against
// at run time — one canonical implementation, no duplication across repos.
//
// Built to dist/mindar-white-border.prod.js (tiny, no tfjs/three) and attaches
// window.MINDAR.WHITE_BORDER = { computeSignatureFromImage, computeSignature, signatureDistance }.

import {computeSignature, signatureDistance, SIGNATURE_LENGTH} from './white-border-signature.js';

// Compute the signature from a flat image/canvas (the composed target the camera will see).
// `source` is a canvas or an <img>/ImageBitmap; `borderWidth` is the white-frame thickness as
// a fraction of the card side. Returns a plain Array (rounded to 1 decimal for compact
// storage) in the same 27-number layout as computeSignature, or null if too little is sampled.
const computeSignatureFromImage = (source, borderWidth) => {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  if (!w || !h) return null;
  let canvas = source;
  if (typeof source.getContext !== 'function') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  }
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const sample = (nu, nv) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(nu * w)));
    const y = Math.min(h - 1, Math.max(0, Math.round(nv * h)));
    const o = (y * w + x) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const sig = computeSignature(sample, borderWidth);
  if (sig === null) return null;
  return Array.from(sig, (v) => Math.round(v * 10) / 10);
};

if (typeof window !== 'undefined') {
  window.MINDAR = window.MINDAR || {};
  window.MINDAR.WHITE_BORDER = {computeSignatureFromImage, computeSignature, signatureDistance, SIGNATURE_LENGTH};
}

export {computeSignatureFromImage, computeSignature, signatureDistance, SIGNATURE_LENGTH};
