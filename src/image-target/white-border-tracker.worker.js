// Offload worker for the white-border tracker (workerOffload option): runs the heavy pixel
// stage (white mask + connected components + quad extraction) off the main thread so a slow
// frame never janks the render loop. The RGBA buffer arrives as a transferable, quads go
// back in analysis coords (the main thread maps them to input coords).

import {whiteMask, quadComponents} from './white-border-pixels.js';

onmessage = (msg) => {
  const {data} = msg;
  if (data.type === 'detect') {
    const rgba = new Uint8ClampedArray(data.buffer);
    const mask = whiteMask(rgba, data.width, data.height);
    const quads = quadComponents(mask, data.width, data.height);
    postMessage({type: 'detectDone', requestId: data.requestId, quads});
  }
};
