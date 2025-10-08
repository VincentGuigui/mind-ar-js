import {Cumsum} from '../utils/cumsum.js';
import { isInFrameArea } from '../utils/isInFrameArea.js';

const SEARCH_SIZE1 = 10;
const SEARCH_SIZE2 = 2;

//const TEMPLATE_SIZE = 22 // DEFAULT
const TEMPLATE_SIZE = 6;
const TEMPLATE_SD_THRESH = 5.0;
const MAX_SIM_THRESH = 0.95;

const MAX_THRESH = 0.9;
//const MIN_THRESH = 0.55;
const MIN_THRESH = 0.2;
const SD_THRESH = 8.0;
const OCCUPANCY_SIZE = 24 * 2 / 3;

// Detection mode constants
const DETECTION_MODES = {
  CORNER: 'corner',
  COLOR: 'color',
  LINES: 'lines'
};

// Default detection options
const DEFAULT_DETECTION_OPTIONS = {
  modes: [DETECTION_MODES.CORNER], // Default to existing corner detection
  cornerOptions: {
    // Existing corner detection parameters (already in constants above)
  },
  colorOptions: {
    numClusters: 5,           // Number of color clusters to detect
    minRegionSize: 50,        // Minimum region size in pixels
    colorThreshold: 30        // Color similarity threshold (0-255)
  },
  linesOptions: {
    edgeThreshold: 50,        // Threshold for edge detection
    houghThreshold: 50,       // Hough transform threshold
    minLineLength: 30,        // Minimum line length
    maxLineGap: 10            // Maximum gap between line segments
  }
};

/*
 * Input image is in grey format. the imageData array size is width * height. value range from 0-255
 * pixel value at row r and c = imageData[r * width + c]
 *
 * @param {object} image - Image object with {data, width, height, scale}
 * @param {object} frameDetection - {top, right, bottom, left} - percentage of height (top/bottom) or width (left/right)
 * @param {object} detectionOptions - Detection options with modes and mode-specific parameters
 * @returns {Array} Array of detected features {x, y, type, ...modeSpecificData}
 */
const extract = (image, frameDetection = {top: 0, right: 0, bottom: 0, left: 0}, detectionOptions = DEFAULT_DETECTION_OPTIONS) => {
  const {data: imageData, width, height, scale} = image;
  
  // Merge with default options
  const options = {
    ...DEFAULT_DETECTION_OPTIONS,
    ...detectionOptions,
    cornerOptions: {...DEFAULT_DETECTION_OPTIONS.cornerOptions, ...(detectionOptions.cornerOptions || {})},
    colorOptions: {...DEFAULT_DETECTION_OPTIONS.colorOptions, ...(detectionOptions.colorOptions || {})},
    linesOptions: {...DEFAULT_DETECTION_OPTIONS.linesOptions, ...(detectionOptions.linesOptions || {})}
  };
  
  // Ensure modes is an array
  const modes = Array.isArray(options.modes) ? options.modes : [options.modes];
  
  let allFeatures = [];
  
  // Run each enabled detection mode
  for (const mode of modes) {
    let features = [];
    
    switch(mode) {
      case DETECTION_MODES.CORNER:
        features = _extractCornerFeatures(image, frameDetection, options.cornerOptions);
        break;
      case DETECTION_MODES.COLOR:
        features = _extractColorFeatures(image, frameDetection, options.colorOptions);
        break;
      case DETECTION_MODES.LINES:
        features = _extractLineFeatures(image, frameDetection, options.linesOptions);
        break;
      default:
        console.warn(`Unknown detection mode: ${mode}`);
    }
    
    // Add type to each feature
    features.forEach(f => f.type = mode);
    allFeatures = allFeatures.concat(features);
  }
  
  return allFeatures;
}

/**
 * Extract corner features using gradient-based method (original implementation)
 */
const _extractCornerFeatures = (image, frameDetection, cornerOptions) => {
  const {data: imageData, width, height, scale} = image;

  // Step 1 - filter out interesting points. Interesting points have strong pixel value changed across neighbours
  const isPixelSelected = [width * height];
  for (let i = 0; i < isPixelSelected.length; i++) isPixelSelected[i] = false;

  // Step 1.1 consider a pixel at position (x, y). compute:
  //   dx = ((data[x+1, y-1] - data[x-1, y-1]) + (data[x+1, y] - data[x-1, y]) + (data[x+1, y+1] - data[x-1, y-1])) / 256 / 3
  //   dy = ((data[x+1, y+1] - data[x+1, y-1]) + (data[x, y+1] - data[x, y-1]) + (data[x-1, y+1] - data[x-1, y-1])) / 256 / 3
  //   dValue =  sqrt(dx^2 + dy^2) / 2;
  const dValue = new Float32Array(imageData.length);
  for (let i = 0; i < width; i++) {
    dValue[i] = -1;
    dValue[width * (height-1) + i] = -1;
  }
  for (let j = 0; j < height; j++) {
    dValue[j*width] = -1;
    dValue[j*width + width-1] = -1;
  }

  for (let i = 1; i < width-1; i++) {
    for (let j = 1; j < height-1; j++) {
      let pos = i + width * j;

        // Skip if not in frame area when frame mode is enabled
        if (!isInFrameArea(i, j, width, height, frameDetection)) {
        continue;
      }

      let dx = 0.0;
      let dy = 0.0;
      for (let k = -1; k <= 1; k++) {
        dx += (imageData[pos + width*k + 1] - imageData[pos + width*k -1]);
        dy += (imageData[pos + width + k] - imageData[pos - width + k]);
      }
      dx /= (3 * 256);
      dy /= (3 * 256);
      dValue[pos] = Math.sqrt( (dx * dx + dy * dy) / 2);
    }
  }

  // Step 1.2 - select all pixel which is dValue largest than all its neighbour as "potential" candidate
  //  the number of selected points is still too many, so we use the value to further filter (e.g. largest the dValue, the better)
  const dValueHist = new Uint32Array(1000); // histogram of dvalue scaled to [0, 1000)
  for (let i = 0; i < 1000; i++) dValueHist[i] = 0;
  const neighbourOffsets = [-1, 1, -width, width];
  let allCount = 0;
  for (let i = 1; i < width-1; i++) {
    for (let j = 1; j < height-1; j++) {
      let pos = i + width * j;
      
      // Skip if not in frame area when frame mode is enabled
      if (!isInFrameArea(i, j, width, height, frameDetection)) {
        continue;
      }
      
      let isMax = true;
      for (let d = 0; d < neighbourOffsets.length; d++) {
        if (dValue[pos] <= dValue[pos + neighbourOffsets[d]]) {
          isMax = false;
          break;
        }
      }
      if (isMax) {
        let k = Math.floor(dValue[pos] * 1000);
        if (k > 999) k = 999; // k>999 should not happen if computaiton is correction
        if (k < 0) k = 0; // k<0 should not happen if computaiton is correction
        dValueHist[k] += 1;
        allCount += 1;
        isPixelSelected[pos] = true;
      }
    }
  }

  // reduce number of points according to dValue.
  // actually, the whole Step 1. might be better to just sort the dvalues and pick the top (0.02 * width * height) points
  const maxPoints = 0.02 * width * height;
  let k = 999;
  let filteredCount = 0;
  while (k >= 0) {
    filteredCount += dValueHist[k];
    if (filteredCount > maxPoints) break;
    k--;
  }

  //console.log("image size: ", width * height);
  //console.log("extracted featues: ", allCount);
  //console.log("filtered featues: ", filteredCount);

  for (let i = 0; i < isPixelSelected.length; i++) {
    if (isPixelSelected[i]) {
      if (dValue[i] * 1000 < k) isPixelSelected[i] = false;
    }
  }

  //console.log("selected count: ", isPixelSelected.reduce((a, b) => {return a + (b?1:0);}, 0));

  // Step 2
  // prebuild cumulative sum matrix for fast computation
  const imageDataSqr = [];
  for (let i = 0; i < imageData.length; i++) {
    imageDataSqr[i] = imageData[i] * imageData[i];
  }
  const imageDataCumsum = new Cumsum(imageData, width, height);
  const imageDataSqrCumsum = new Cumsum(imageDataSqr, width, height);

  // holds the max similariliy value computed within SEARCH area of each pixel
  //   idea: if there is high simliarity with another pixel in nearby area, then it's not a good feature point
  //         next step is to find pixel with low similarity
  const featureMap = new Float32Array(imageData.length);

  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      const pos = j * width + i;
      if (!isPixelSelected[pos]) {
        featureMap[pos] = 1.0;
        continue;
      }

      const vlen = _templateVar({image, cx: i, cy: j, sdThresh: TEMPLATE_SD_THRESH, imageDataCumsum, imageDataSqrCumsum});
      if (vlen === null) {
        featureMap[pos] = 1.0;
        continue;
      }

      let max = -1.0;
      for (let jj = -SEARCH_SIZE1; jj <= SEARCH_SIZE1; jj++) {
        for (let ii = -SEARCH_SIZE1; ii <= SEARCH_SIZE1; ii++) {
          if (ii * ii + jj * jj <= SEARCH_SIZE2 * SEARCH_SIZE2) continue;
          const sim = _getSimilarity({image, cx: i+ii, cy: j+jj, vlen: vlen, tx: i, ty: j, imageDataCumsum, imageDataSqrCumsum});

          if (sim === null) continue;

          if (sim > max) {
            max = sim;
            if (max > MAX_SIM_THRESH) break;
          }
        }
        if (max > MAX_SIM_THRESH) break;
      }
      featureMap[pos] = max;
    }
  }

  // Step 2.2 select feature
  const coords = _selectFeature({image, featureMap, templateSize: TEMPLATE_SIZE, searchSize: SEARCH_SIZE2, occSize: OCCUPANCY_SIZE, maxSimThresh: MAX_THRESH, minSimThresh: MIN_THRESH, sdThresh: SD_THRESH, imageDataCumsum, imageDataSqrCumsum, frameDetection});

  return coords;
}

/**
 * Extract color features using color clustering
 */
const _extractColorFeatures = (image, frameDetection, colorOptions) => {
  const {data: imageData, width, height} = image;
  const {numClusters, minRegionSize, colorThreshold} = colorOptions;
  
  const features = [];
  
  // Simple color clustering based on intensity
  // Group pixels by intensity ranges
  const clusters = new Array(numClusters).fill(0).map(() => ({
    pixels: [],
    centerIntensity: 0
  }));
  
  // Initialize cluster centers evenly across intensity range
  for (let i = 0; i < numClusters; i++) {
    clusters[i].centerIntensity = (i + 0.5) * (255 / numClusters);
  }
  
  // Assign pixels to nearest cluster
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Skip if not in frame area
      if (!isInFrameArea(x, y, width, height, frameDetection)) {
        continue;
      }
      
      const pos = y * width + x;
      const intensity = imageData[pos];
      
      // Find nearest cluster
      let minDist = Infinity;
      let clusterIdx = 0;
      for (let i = 0; i < numClusters; i++) {
        const dist = Math.abs(intensity - clusters[i].centerIntensity);
        if (dist < minDist) {
          minDist = dist;
          clusterIdx = i;
        }
      }
      
      if (minDist < colorThreshold) {
        clusters[clusterIdx].pixels.push({x, y, intensity});
      }
    }
  }
  
  // Extract feature points from clusters
  for (let i = 0; i < numClusters; i++) {
    const cluster = clusters[i];
    
    if (cluster.pixels.length < minRegionSize) {
      continue;
    }
    
    // Compute centroid of cluster
    let sumX = 0, sumY = 0;
    for (const pixel of cluster.pixels) {
      sumX += pixel.x;
      sumY += pixel.y;
    }
    
    const cx = Math.round(sumX / cluster.pixels.length);
    const cy = Math.round(sumY / cluster.pixels.length);
    
    features.push({
      x: cx,
      y: cy,
      intensity: cluster.centerIntensity,
      regionSize: cluster.pixels.length
    });
  }
  
  return features;
}

/**
 * Extract line features using edge detection and Hough transform
 */
const _extractLineFeatures = (image, frameDetection, linesOptions) => {
  const {data: imageData, width, height} = image;
  const {edgeThreshold, houghThreshold, minLineLength, maxLineGap} = linesOptions;
  
  const features = [];
  
  // Step 1: Edge detection using gradient magnitude
  const edges = new Uint8Array(width * height);
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Skip if not in frame area
      if (!isInFrameArea(x, y, width, height, frameDetection)) {
        continue;
      }
      
      const pos = y * width + x;
      
      // Sobel operator for edge detection
      const gx = (
        -imageData[pos - width - 1] - 2 * imageData[pos - 1] - imageData[pos + width - 1] +
        imageData[pos - width + 1] + 2 * imageData[pos + 1] + imageData[pos + width + 1]
      );
      
      const gy = (
        -imageData[pos - width - 1] - 2 * imageData[pos - width] - imageData[pos - width + 1] +
        imageData[pos + width - 1] + 2 * imageData[pos + width] + imageData[pos + width + 1]
      );
      
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      
      edges[pos] = magnitude > edgeThreshold ? 255 : 0;
    }
  }
  
  // Step 2: Simple Hough transform for line detection
  // We'll use a simplified approach: detect dominant orientations in edge pixels
  const maxRho = Math.sqrt(width * width + height * height);
  const thetaSteps = 180; // 1 degree resolution
  const rhoSteps = Math.ceil(maxRho);
  
  // Hough accumulator
  const accumulator = new Uint32Array(thetaSteps * rhoSteps);
  
  // Vote for lines
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = y * width + x;
      
      if (edges[pos] === 0) continue;
      
      // Vote for all possible lines through this edge pixel
      for (let thetaIdx = 0; thetaIdx < thetaSteps; thetaIdx++) {
        const theta = (thetaIdx * Math.PI) / thetaSteps;
        const rho = x * Math.cos(theta) + y * Math.sin(theta);
        const rhoIdx = Math.round(rho + maxRho / 2);
        
        if (rhoIdx >= 0 && rhoIdx < rhoSteps) {
          accumulator[thetaIdx * rhoSteps + rhoIdx]++;
        }
      }
    }
  }
  
  // Find peaks in accumulator (lines)
  const detectedLines = [];
  for (let thetaIdx = 0; thetaIdx < thetaSteps; thetaIdx++) {
    for (let rhoIdx = 0; rhoIdx < rhoSteps; rhoIdx++) {
      const votes = accumulator[thetaIdx * rhoSteps + rhoIdx];
      
      if (votes > houghThreshold) {
        const theta = (thetaIdx * Math.PI) / thetaSteps;
        const rho = rhoIdx - maxRho / 2;
        
        detectedLines.push({theta, rho, votes});
      }
    }
  }
  
  // Convert lines to feature points (sample points along the line)
  for (const line of detectedLines) {
    const {theta, rho} = line;
    
    // Calculate line endpoints within image bounds
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    
    // Sample a point on the line as feature
    let x0, y0;
    
    if (Math.abs(sinTheta) > 0.5) {
      // More vertical line
      x0 = Math.round(width / 2);
      y0 = Math.round((rho - x0 * cosTheta) / sinTheta);
    } else {
      // More horizontal line
      y0 = Math.round(height / 2);
      x0 = Math.round((rho - y0 * sinTheta) / cosTheta);
    }
    
    // Validate point is within image
    if (x0 >= 0 && x0 < width && y0 >= 0 && y0 < height) {
      features.push({
        x: x0,
        y: y0,
        theta: theta,
        rho: rho,
        votes: line.votes
      });
    }
  }
  
  return features;
}

const _selectFeature = (options) => {
  let {image, featureMap, templateSize, searchSize, occSize, maxSimThresh, minSimThresh, sdThresh, imageDataCumsum, imageDataSqrCumsum, frameDetection} = options;
  const {data: imageData, width, height, scale} = image;

  //console.log("params: ", templateSize, templateSize, occSize, maxSimThresh, minSimThresh, sdThresh);

  //occSize *= 2;
  occSize = Math.floor(Math.min(image.width, image.height) / 10);

  const divSize = (templateSize * 2 + 1) * 3;
  const xDiv = Math.floor(width / divSize);
  const yDiv = Math.floor(height / divSize);

  let maxFeatureNum = Math.floor(width / occSize) * Math.floor(height / occSize) + xDiv * yDiv;
  //console.log("max feature num: ", maxFeatureNum);

  const coords = [];
  const image2 = new Float32Array(imageData.length);
  for (let i = 0; i < image2.length; i++) {
    image2[i] = featureMap[i];
  }

  let num = 0;
  while (num < maxFeatureNum) {
    let minSim = maxSimThresh;
    let cx = -1;
    let cy = -1;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        // Skip if not in frame area when frame mode is enabled
        if (!isInFrameArea(i, j, width, height, frameDetection)) {
          continue;
        }
        
        if (image2[j*width+i] < minSim) {
          minSim = image2[j*width+i];
          cx = i;
          cy = j;
        }
      }
    }
    if (cx === -1) break;

    const vlen = _templateVar({image, cx: cx, cy: cy, sdThresh: 0, imageDataCumsum, imageDataSqrCumsum});
    if (vlen === null) {
      image2[ cy * width + cx ] = 1.0;
      continue;
    }
    if (vlen / (templateSize * 2 + 1) < sdThresh) {
      image2[ cy * width + cx ] = 1.0;
      continue;
    }

    let min = 1.0;
    let max = -1.0;

    for (let j = -searchSize; j <= searchSize; j++) {
      for (let i = -searchSize; i <= searchSize; i++) {
        if (i*i + j*j > searchSize * searchSize) continue;
        if (i === 0 && j === 0) continue;

        const sim = _getSimilarity({image, vlen, cx: cx+i, cy: cy+j, tx: cx, ty:cy, imageDataCumsum, imageDataSqrCumsum});
        if (sim === null) continue;

        if (sim < min) {
          min = sim;
          if (min < minSimThresh && min < minSim) break;
        }
        if (sim > max) {
          max = sim;
          if (max > 0.99) break;
        }
      }
      if( (min < minSimThresh && min < minSim) || max > 0.99 ) break;
    }

    if( (min < minSimThresh && min < minSim) || max > 0.99 ) {
        image2[ cy * width + cx ] = 1.0;
        continue;
    }

    coords.push({x: cx, y: cy});
    //coords.push({
      //mx: 1.0 * cx / scale,
      //my: 1.0 * (height - cy) / scale,
    //})

    num += 1;
    //console.log(num, '(', cx, ',', cy, ')', minSim, 'min = ', min, 'max = ', max, 'sd = ', vlen/(templateSize*2+1));

    // no other feature points within occSize square
    for (let j = -occSize; j <= occSize; j++) {
      for (let i = -occSize; i <= occSize; i++) {
        if (cy + j < 0 || cy + j >= height || cx + i < 0 || cx + i >= width) continue;
        image2[ (cy+j)*width + (cx+i) ] = 1.0;
      }
    }
  }
  return coords;
}

// compute variances of the pixels, centered at (cx, cy)
const _templateVar = ({image, cx, cy, sdThresh, imageDataCumsum, imageDataSqrCumsum}) => {
  if (cx - TEMPLATE_SIZE < 0 || cx + TEMPLATE_SIZE >= image.width) return null;
  if (cy - TEMPLATE_SIZE < 0 || cy + TEMPLATE_SIZE >= image.height) return null;

  const templateWidth = 2 * TEMPLATE_SIZE + 1;
  const nPixels = templateWidth * templateWidth;

  let average = imageDataCumsum.query(cx - TEMPLATE_SIZE, cy - TEMPLATE_SIZE, cx + TEMPLATE_SIZE, cy+TEMPLATE_SIZE);
  average /= nPixels;

  //v = sum((pixel_i - avg)^2) for all pixel i within the template
  //  = sum(pixel_i^2) - sum(2 * avg * pixel_i) + sum(avg^avg)

  let vlen = imageDataSqrCumsum.query(cx - TEMPLATE_SIZE, cy - TEMPLATE_SIZE, cx + TEMPLATE_SIZE, cy+TEMPLATE_SIZE);
  vlen -= 2 * average * imageDataCumsum.query(cx - TEMPLATE_SIZE, cy - TEMPLATE_SIZE, cx + TEMPLATE_SIZE, cy+TEMPLATE_SIZE);
  vlen += nPixels * average * average;

  if (vlen / nPixels < sdThresh * sdThresh) return null;
  vlen = Math.sqrt(vlen);
  return vlen;
}

const _getSimilarity = (options) => {
  const {image, cx, cy, vlen, tx, ty, imageDataCumsum, imageDataSqrCumsum} = options;
  const {data: imageData, width, height} = image;
  const templateSize = TEMPLATE_SIZE;

  if (cx - templateSize < 0 || cx + templateSize >= width) return null;
  if (cy - templateSize < 0 || cy + templateSize >= height) return null;

  const templateWidth = 2 * templateSize + 1;

  let sx = imageDataCumsum.query(cx-templateSize, cy-templateSize, cx+templateSize, cy+templateSize);
  let sxx = imageDataSqrCumsum.query(cx-templateSize, cy-templateSize, cx+templateSize, cy+templateSize);
  let sxy = 0;

  // !! This loop is the performance bottleneck. Use moving pointers to optimize
  //
  //   for (let i = cx - templateSize, i2 = tx - templateSize; i <= cx + templateSize; i++, i2++) {
  //     for (let j = cy - templateSize, j2 = ty - templateSize; j <= cy + templateSize; j++, j2++) {
  //       sxy += imageData[j*width + i] * imageData[j2*width + i2];
  //     }
  //   }
  //
  let p1 = (cy-templateSize) * width + (cx-templateSize);
  let p2 = (ty-templateSize) * width + (tx-templateSize);
  let nextRowOffset = width - templateWidth;
  for (let j = 0; j < templateWidth; j++) {
    for (let i = 0; i < templateWidth; i++) {
      sxy += imageData[p1] * imageData[p2];
      p1 +=1;
      p2 +=1;
    }
    p1 += nextRowOffset;
    p2 += nextRowOffset;
  }

  let templateAverage = imageDataCumsum.query(tx-templateSize, ty-templateSize, tx+templateSize, ty+templateSize);
  templateAverage /= templateWidth * templateWidth;
  sxy -= templateAverage * sx;

  let vlen2 = sxx - sx*sx / (templateWidth * templateWidth);
  if (vlen2 == 0) return null;
  vlen2 = Math.sqrt(vlen2);

  // covariance between template and current pixel
  const sim = 1.0 * sxy / (vlen * vlen2);
  return sim;
}

export {
  extract,
  DETECTION_MODES,
  DEFAULT_DETECTION_OPTIONS
};
