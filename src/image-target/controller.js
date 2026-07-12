import {memory,nextFrame} from '@tensorflow/tfjs';

const tf = {memory,nextFrame};
import ControllerWorker  from "./controller.worker.js?worker&inline";
import {Tracker} from './tracker/tracker.js';
import {CropDetector} from './detector/crop-detector.js';
import {Compiler} from './compiler.js';
import {InputLoader} from './input-loader.js';
import {WhiteBorderTracker} from './white-border-tracker.js';
import WhiteBorderTrackerWorker from './white-border-tracker.worker.js?worker&inline';
import {FpsGovernor} from './fps-governor.js';
import {OneEuroFilter} from '../libs/one-euro-filter.js';

const DEFAULT_FILTER_CUTOFF = 0.001; // 1Hz. time period in milliseconds
const DEFAULT_FILTER_BETA = 1000;
const DEFAULT_WARMUP_TOLERANCE = 5;
const DEFAULT_MISS_TOLERANCE = 5;
// marker width in marker units for white-border targets (no compiled image to take the
// pixel size from); same order of magnitude as typical compiled target images
const WHITE_BORDER_MARKER_WIDTH = 1000;
const TRACKING_METHOD_FEATURES = 'features';
const TRACKING_METHOD_WHITE_BORDER = 'whiteBorder';
// default target frame rate of the white-border loop (see maxFps option / FpsGovernor)
const DEFAULT_WHITE_BORDER_MAX_FPS = 30;

class Controller {
  constructor({inputWidth, inputHeight, onUpdate=null, debugMode=false, maxTrack=1,
    warmupTolerance=null, missTolerance=null, filterMinCF=null, filterBeta=null,
      frameDetection = { top: 0, right: 0, bottom: 0, left: 0 },
      simThreshold = -1,
      trackingMethod = TRACKING_METHOD_FEATURES,
      maxFps = -1,
      workerOffload = false
  }) {

    this.inputWidth = inputWidth;
    this.inputHeight = inputHeight;
    this.maxTrack = maxTrack;
    this.frameDetection = frameDetection;
    this.simThreshold = simThreshold;
    this.trackingMethod = trackingMethod;
    this.whiteBorderTracker = null;
    this.maxFps = (maxFps === null || maxFps <= 0)? DEFAULT_WHITE_BORDER_MAX_FPS: maxFps;
    this.workerOffload = workerOffload;
    this.fpsGovernor = null; // created per processVideo run (whiteBorder mode)
    this.filterMinCF = filterMinCF === null? DEFAULT_FILTER_CUTOFF: filterMinCF;
    this.filterBeta = filterBeta === null? DEFAULT_FILTER_BETA: filterBeta;
    this.warmupTolerance = warmupTolerance === null? DEFAULT_WARMUP_TOLERANCE: warmupTolerance;
    this.missTolerance = missTolerance === null? DEFAULT_MISS_TOLERANCE: missTolerance;
    if (this.trackingMethod !== TRACKING_METHOD_WHITE_BORDER) { // white-border mode has no use for the feature detector / tfjs input pipeline
      this.cropDetector = new CropDetector(this.inputWidth, this.inputHeight, debugMode, frameDetection);
      this.inputLoader = new InputLoader(this.inputWidth, this.inputHeight);
    }
    this.markerDimensions = null;
    this.onUpdate = onUpdate;
    this.debugMode = debugMode;
    this.processingVideo = false;
    this.interestedTargetIndex = -1;
    this.trackingStates = [];

    const near = 10;
    const far = 100000;
    const fovy = 45.0 * Math.PI / 180; // 45 in radian. field of view vertical
    const f = (this.inputHeight/2) / Math.tan(fovy/2);
    //     [fx  s cx]
    // K = [ 0 fx cy]
    //     [ 0  0  1]
    this.projectionTransform = [
      [f, 0, this.inputWidth / 2],
      [0, f, this.inputHeight / 2],
      [0, 0, 1]
    ];

    this.projectionMatrix = this._glProjectionMatrix({
      projectionTransform: this.projectionTransform,
      width: this.inputWidth,
      height: this.inputHeight,
      near: near,
      far: far,
    });

    this.worker = null;
    if (this.trackingMethod !== TRACKING_METHOD_WHITE_BORDER) { // white-border pose estimation is cheap enough to run on the main thread
      this.worker = new ControllerWorker()//new Worker(new URL('./controller.worker.js', import.meta.url));
      this.workerMatchDone = null;
      this.workerTrackDone = null;
      this.worker.onmessage = (e) => {
        if (e.data.type === 'matchDone' && this.workerMatchDone !== null) {
          this.workerMatchDone(e.data);
        }
        if (e.data.type === 'trackUpdateDone' && this.workerTrackDone !== null) {
          this.workerTrackDone(e.data);
        }
      }
    }
  }

  // register white-border targets without any compiled (.mind) data: only the expected
  // image ratios (height/width) are needed, the white contour provides the geometry
  addWhiteBorderTargets(ratios) {
    const dimensions = ratios.map((ratio) => [WHITE_BORDER_MARKER_WIDTH, Math.round(WHITE_BORDER_MARKER_WIDTH * ratio)]);
    const worker = this.workerOffload? new WhiteBorderTrackerWorker(): null;
    this.whiteBorderTracker = new WhiteBorderTracker(this.inputWidth, this.inputHeight, dimensions, this.projectionTransform, {debugMode: this.debugMode, worker});
    this.markerDimensions = dimensions;
    return {dimensions};
  }

  // current (possibly throttled) target frame rate of the white-border loop
  getCurrentTargetFps() {
    return this.fpsGovernor !== null? this.fpsGovernor.targetFps: this.maxFps;
  }

  showTFStats() {
    console.log(tf.memory().numTensors);
    console.table(tf.memory());
  }

  addImageTargets(fileURL) {
    return new Promise(async (resolve, reject) => {
      const content = await fetch(fileURL);
      const buffer = await content.arrayBuffer();
      const result = this.addImageTargetsFromBuffer(buffer);
      resolve(result);
    });
  }

  addImageTargetsFromBuffer(buffer) {
    const compiler = new Compiler();
    const dataList = compiler.importData(buffer);

    const trackingDataList = [];
    const matchingDataList = [];
    const imageListList = [];
    const dimensions = [];
    for (let i = 0; i < dataList.length; i++) {
      matchingDataList.push(dataList[i].matchingData);
      trackingDataList.push(dataList[i].trackingData);
      dimensions.push([dataList[i].targetImage.width, dataList[i].targetImage.height]);
    }

      this.tracker = new Tracker(dimensions, trackingDataList, this.projectionTransform, this.inputWidth, this.inputHeight,
          this.debugMode, this.frameDetection, this.simThreshold);

    this.worker.postMessage({
      type: 'setup',
      inputWidth: this.inputWidth,
      inputHeight: this.inputHeight,
      projectionTransform: this.projectionTransform,
      debugMode: this.debugMode,
      matchingDataList,
    });

    this.markerDimensions = dimensions;

    return {dimensions: dimensions, matchingDataList, trackingDataList};
  }

  dispose() {
    this.stopProcessVideo();
    if (this.whiteBorderTracker !== null) {
      this.whiteBorderTracker.dispose();
    }
    if (this.worker !== null) {
      this.worker.postMessage({
        type: "dispose"
      });
    }
  }

  // warm up gpu - build kernels is slow
  dummyRun(input) {
    if (this.trackingMethod === TRACKING_METHOD_WHITE_BORDER) {
      this.whiteBorderTracker.findQuadCandidates(input);
      return;
    }
    const inputT = this.inputLoader.loadInput(input);
    this.cropDetector.detect(inputT);
    this.tracker.dummyRun(inputT);
    inputT.dispose();
  }

  getProjectionMatrix() {
    return this.projectionMatrix;
  }

  getRotatedZ90Matrix(m) { // rotate 90 degree along z-axis
    // rotation matrix
    // |  0  -1  0  0 |
    // |  1   0  0  0 |
    // |  0   0  1  0 |
    // |  0   0  0  1 |
    const rotatedMatrix = [
      -m[1], m[0], m[2], m[3],
      -m[5], m[4], m[6], m[7],
      -m[9], m[8], m[10], m[11],
      -m[13], m[12], m[14], m[15]
    ];
    return rotatedMatrix;
  }

  getWorldMatrix(modelViewTransform, targetIndex) {
    return this._glModelViewMatrix(modelViewTransform, targetIndex);
  }

  async _detectAndMatch(inputT, targetIndexes) {
    const {featurePoints} = this.cropDetector.detectMoving(inputT);
    const {targetIndex: matchedTargetIndex, modelViewTransform} = await this._workerMatch(featurePoints, targetIndexes);
    return {targetIndex: matchedTargetIndex, modelViewTransform}
  }
  async _trackAndUpdate(inputT, lastModelViewTransform, targetIndex) {
    const {worldCoords, screenCoords} = this.tracker.track(inputT, lastModelViewTransform, targetIndex);
    if (worldCoords.length < 4) return null;
    const modelViewTransform = await this._workerTrackUpdate(lastModelViewTransform, {worldCoords, screenCoords});
    return modelViewTransform;
  }

  processVideo(input) {
    if (this.processingVideo) return;

    this.processingVideo = true;

    this.trackingStates = [];
    for (let i = 0; i < this.markerDimensions.length; i++) {
      this.trackingStates.push({
	showing: false,
	isTracking: false,
	currentModelViewTransform: null,
	lastCorners: null,
	trackCount: 0,
	trackMiss: 0,
	filter: new OneEuroFilter({minCutOff: this.filterMinCF, beta: this.filterBeta})
      });
      //console.log("filterMinCF", this.filterMinCF, this.filterBeta);
    }

    if (this.trackingMethod === TRACKING_METHOD_WHITE_BORDER) {
      this._processVideoWhiteBorder(input);
      return;
    }

    const startProcessing = async() => {
      while (true) {
	if (!this.processingVideo) break;

	const inputT = this.inputLoader.loadInput(input);

	const nTracking = this.trackingStates.reduce((acc, s) => {
	  return acc + (!!s.isTracking? 1: 0);
	}, 0);

	// detect and match only if less then maxTrack
	if (nTracking < this.maxTrack) {

	  const matchingIndexes = [];
	  for (let i = 0; i < this.trackingStates.length; i++) {
	    const trackingState = this.trackingStates[i];
	    if (trackingState.isTracking === true) continue;
	    if (this.interestedTargetIndex !== -1 && this.interestedTargetIndex !== i) continue;

	    matchingIndexes.push(i);
	  }

	  const {targetIndex: matchedTargetIndex, modelViewTransform} = await this._detectAndMatch(inputT, matchingIndexes);

	  if (matchedTargetIndex !== -1) {
	    this.trackingStates[matchedTargetIndex].isTracking = true;
	    this.trackingStates[matchedTargetIndex].currentModelViewTransform = modelViewTransform;
	  }
	}

	// tracking update
	for (let i = 0; i < this.trackingStates.length; i++) {
	  const trackingState = this.trackingStates[i];

	  if (trackingState.isTracking) {
	    let modelViewTransform = await this._trackAndUpdate(inputT, trackingState.currentModelViewTransform, i);
	    if (modelViewTransform === null) {
	      trackingState.isTracking = false;
	    } else {
	      trackingState.currentModelViewTransform = modelViewTransform;
	    }
	  }

	  this._updateTrackingVisibility(input, i);
	}

	inputT.dispose();
        this.onUpdate && this.onUpdate({type: 'processDone'});
	await tf.nextFrame();
      }
    }
    startProcessing();
  }

  // white-border processing loop: one quad detection per frame (plain canvas pixels;
  // pixel stage optionally in the offload worker), pose from the 4 corners; same
  // trackingStates / warmup / miss / filter behavior as the feature loop.
  // The loop is paced to maxFps and gracefully throttled by the FpsGovernor: when the
  // device cannot sustain the target rate, the target drops by 1/6 of maxFps at a time
  // (and climbs back when there is sustained headroom).
  _processVideoWhiteBorder(input) {
    this.fpsGovernor = new FpsGovernor(this.maxFps);

    const startProcessing = async() => {
      while (true) {
	if (!this.processingVideo) break;

	const frameStart = performance.now();

	const nTracking = this.trackingStates.reduce((acc, s) => {
	  return acc + (!!s.isTracking? 1: 0);
	}, 0);

	// fast pass: while every wanted target is already tracked, only search the padded
	// neighborhood of the previous frame's quads instead of the full frame; if the fast
	// pass comes back empty (fast motion), fall back to a full-frame scan right away so
	// it costs one extra pass instead of a miss
	let quadCandidates;
	const trackedCorners = this.trackingStates
	  .filter((s) => s.isTracking && s.lastCorners !== null)
	  .map((s) => s.lastCorners);
	if (nTracking >= this.maxTrack && trackedCorners.length > 0) {
	  quadCandidates = await this.whiteBorderTracker.findQuadCandidatesAsync(input, this.whiteBorderTracker.roiAround(trackedCorners));
	  if (quadCandidates.length === 0) {
	    quadCandidates = await this.whiteBorderTracker.findQuadCandidatesAsync(input);
	  }
	} else {
	  quadCandidates = await this.whiteBorderTracker.findQuadCandidatesAsync(input);
	}

	// detect and match only if less then maxTrack
	if (quadCandidates.length > 0 && nTracking < this.maxTrack) {
	  const matchingIndexes = [];
	  for (let i = 0; i < this.trackingStates.length; i++) {
	    const trackingState = this.trackingStates[i];
	    if (trackingState.isTracking === true) continue;
	    if (this.interestedTargetIndex !== -1 && this.interestedTargetIndex !== i) continue;

	    matchingIndexes.push(i);
	  }

	  const matchResult = this.whiteBorderTracker.matchQuad(quadCandidates, matchingIndexes);
	  if (matchResult !== null) {
	    const trackingState = this.trackingStates[matchResult.targetIndex];
	    trackingState.isTracking = true;
	    trackingState.currentModelViewTransform = matchResult.modelViewTransform;
	    trackingState.lastCorners = matchResult.corners;
	  }
	}

	// tracking update
	for (let i = 0; i < this.trackingStates.length; i++) {
	  const trackingState = this.trackingStates[i];

	  if (trackingState.isTracking) {
	    const trackResult = quadCandidates.length === 0? null: this.whiteBorderTracker.trackQuad(quadCandidates, i, trackingState.lastCorners);
	    if (trackResult === null) {
	      trackingState.isTracking = false;
	    } else {
	      trackingState.currentModelViewTransform = trackResult.modelViewTransform;
	      trackingState.lastCorners = trackResult.corners;
	    }
	  }

	  this._updateTrackingVisibility(input, i);
	}

        this.onUpdate && this.onUpdate({type: 'processDone'});

	// pace to the governed target fps: report this frame's busy time, then wait
	// (in rAF ticks, so we never process more often than the display refreshes)
	// until the frame budget has elapsed
	const busyMs = performance.now() - frameStart;
	const previousTargetFps = this.fpsGovernor.targetFps;
	const targetFps = this.fpsGovernor.sample(busyMs);
	if (targetFps !== previousTargetFps) {
	  this.onUpdate && this.onUpdate({type: 'targetFpsChanged', targetFps});
	}
	const nextDue = frameStart + 1000 / targetFps;
	do {
	  await new Promise((resolve) => requestAnimationFrame(resolve));
	} while (this.processingVideo && performance.now() < nextDue - 1); // -1ms: don't idle a whole extra rAF tick for a rounding sliver
      }
    }
    startProcessing();
  }

  // shared per-target warmup / miss-tolerance / smoothing / onUpdate logic
  _updateTrackingVisibility(input, i) {
    const trackingState = this.trackingStates[i];

    // if not showing, then show it once it reaches warmup number of frames
    if (!trackingState.showing) {
      if (trackingState.isTracking) {
	trackingState.trackMiss = 0;
	trackingState.trackCount += 1;
	if (trackingState.trackCount > this.warmupTolerance) {
	  trackingState.showing = true;
	  trackingState.trackingMatrix = null;
	  trackingState.filter.reset();
	}
      }
    }

    // if showing, then count miss, and hide it when reaches tolerance
    if (trackingState.showing) {
      if (!trackingState.isTracking) {
	trackingState.trackCount = 0;
	trackingState.trackMiss += 1;

	if (trackingState.trackMiss > this.missTolerance) {
	  trackingState.showing = false;
	  trackingState.trackingMatrix = null;
	  this.onUpdate && this.onUpdate({type: 'updateMatrix', targetIndex: i, worldMatrix: null});
	}
      } else {
	trackingState.trackMiss = 0;
      }
    }

    // if showing, then call onUpdate, with world matrix
    if (trackingState.showing) {
      const worldMatrix = this._glModelViewMatrix(trackingState.currentModelViewTransform, i);
      trackingState.trackingMatrix = trackingState.filter.filter(Date.now(), worldMatrix);

      let clone = [];
      for (let j = 0; j < trackingState.trackingMatrix.length; j++) {
	clone[j] = trackingState.trackingMatrix[j];
      }

      const isInputRotated = input.width === this.inputHeight && input.height === this.inputWidth;
      if (isInputRotated) {
	clone = this.getRotatedZ90Matrix(clone);
      }

      this.onUpdate && this.onUpdate({type: 'updateMatrix', targetIndex: i, worldMatrix: clone});
    }
  }

  stopProcessVideo() {
    this.processingVideo = false;
  }

  async detect(input) {
    const inputT = this.inputLoader.loadInput(input);
    const {featurePoints, debugExtra} = await this.cropDetector.detect(inputT);
    inputT.dispose();
    return {featurePoints, debugExtra};
  }

  async match(featurePoints, targetIndex) {
    const {modelViewTransform, debugExtra} = await this._workerMatch(featurePoints, [targetIndex]);
    return {modelViewTransform, debugExtra};
  }

  async track(input, modelViewTransform, targetIndex) {
    const inputT = this.inputLoader.loadInput(input);
    const result = this.tracker.track(inputT, modelViewTransform, targetIndex);
    inputT.dispose();
    return result;
  }

  async trackUpdate(modelViewTransform, trackFeatures) {
    if (trackFeatures.worldCoords.length < 4 ) return null;
    const modelViewTransform2 = await this._workerTrackUpdate(modelViewTransform, trackFeatures);
    return modelViewTransform2;
  }

  _workerMatch(featurePoints, targetIndexes) {
    return new Promise(async (resolve, reject) => {
      this.workerMatchDone = (data) => {
        resolve({targetIndex: data.targetIndex, modelViewTransform: data.modelViewTransform, debugExtra: data.debugExtra});
      }
      this.worker.postMessage({type: 'match', featurePoints: featurePoints, targetIndexes});
    });
  }

  _workerTrackUpdate(modelViewTransform, trackingFeatures) {
    return new Promise(async (resolve, reject) => {
      this.workerTrackDone = (data) => {
        resolve(data.modelViewTransform);
      }
      const {worldCoords, screenCoords} = trackingFeatures;
      this.worker.postMessage({type: 'trackUpdate', modelViewTransform, worldCoords, screenCoords});
    });
  }

  _glModelViewMatrix(modelViewTransform, targetIndex) {
    const height = this.markerDimensions[targetIndex][1];

    // Question: can someone verify this interpreation is correct? 
    // I'm not very convinced, but more like trial and error and works......
    //
    // First, opengl has y coordinate system go from bottom to top, while the marker corrdinate goes from top to bottom,
    //    since the modelViewTransform is estimated in marker coordinate, we need to apply this transform before modelViewTransform
    //    I can see why y = h - y*, but why z = z* ? should we intepret it as rotate 90 deg along x-axis and then translate y by h?
    //
    //    [1  0  0  0]
    //    [0 -1  0  h]
    //    [0  0 -1  0]
    //    [0  0  0  1]
    //    
    //    This is tested that if we reverse marker coordinate from bottom to top and estimate the modelViewTransform,
    //    then the above matrix is not necessary.
    //
    // Second, in opengl, positive z is away from camera, so we rotate 90 deg along x-axis after transform to fix the axis mismatch
    //    [1  1  0  0]
    //    [0 -1  0  0]
    //    [0  0 -1  0]
    //    [0  0  0  1]
    //
    // all together, the combined matrix is
    //
    //    [1  1  0  0]   [m00, m01, m02, m03]   [1  0  0  0]
    //    [0 -1  0  0]   [m10, m11, m12, m13]   [0 -1  0  h]
    //    [0  0 -1  0]   [m20, m21, m22, m23]   [0  0 -1  0]
    //    [0  0  0  1]   [  0    0    0    1]   [0  0  0  1]
    //
    //    [ m00,  -m01,  -m02,  (m01 * h + m03) ]
    //    [-m10,   m11,   m12, -(m11 * h + m13) ]
    //  = [-m20,   m21,   m22, -(m21 * h + m23) ]
    //    [   0,     0,     0,                1 ]
    //
    //
    // Finally, in threejs, matrix is represented in col by row, so we transpose it, and get below:
    const openGLWorldMatrix = [
      modelViewTransform[0][0], -modelViewTransform[1][0], -modelViewTransform[2][0], 0,
      -modelViewTransform[0][1], modelViewTransform[1][1], modelViewTransform[2][1], 0,
      -modelViewTransform[0][2], modelViewTransform[1][2], modelViewTransform[2][2], 0,
      modelViewTransform[0][1] * height + modelViewTransform[0][3], -(modelViewTransform[1][1] * height + modelViewTransform[1][3]), -(modelViewTransform[2][1] * height + modelViewTransform[2][3]), 1
    ];
    return openGLWorldMatrix;
  }

  // build openGL projection matrix
  // ref: https://strawlab.org/2011/11/05/augmented-reality-with-OpenGL/
  _glProjectionMatrix({projectionTransform, width, height, near, far}) {
    const proj = [
      [2 * projectionTransform[0][0] / width, 0, -(2 * projectionTransform[0][2] / width - 1), 0],
      [0, 2 * projectionTransform[1][1] / height, -(2 * projectionTransform[1][2] / height - 1), 0],
      [0, 0, -(far + near) / (far - near), -2 * far * near / (far - near)],
      [0, 0, -1, 0]
    ];
    const projMatrix = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
	projMatrix.push(proj[j][i]);
      }
    }
    return projMatrix;
  }
}

export {
 Controller
}
