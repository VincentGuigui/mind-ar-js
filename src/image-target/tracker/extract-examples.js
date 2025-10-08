/**
 * Example: Using Multiple Feature Detection Modes with extract()
 * 
 * This example demonstrates how to use the new feature detection options
 * in the extract function to detect corners, colors, and lines.
 */

import { extract, DETECTION_MODES, DEFAULT_DETECTION_OPTIONS } from './extract.js';

// Example 1: Backward Compatibility - Default Corner Detection
// The extract function maintains backward compatibility. When called without
// detection options, it defaults to corner detection (the original behavior).
function example1_backwardCompatibility(image) {
  const features = extract(image);
  // Returns: Array of features with {x, y, type: 'corner'}
  console.log('Corner features (default):', features.length);
  return features;
}

// Example 2: Explicit Corner Detection
// You can explicitly request corner detection for clarity
function example2_explicitCorner(image) {
  const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
    modes: [DETECTION_MODES.CORNER]
  });
  console.log('Corner features (explicit):', features.length);
  return features;
}

// Example 3: Color Detection
// Detect regions with similar colors/intensities
function example3_colorDetection(image) {
  const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
    modes: [DETECTION_MODES.COLOR],
    colorOptions: {
      numClusters: 5,        // Number of color clusters
      minRegionSize: 50,     // Minimum pixels in a region
      colorThreshold: 30     // Color similarity threshold (0-255)
    }
  });
  
  // Returns: Array of features with {x, y, type: 'color', intensity, regionSize}
  features.forEach(f => {
    console.log(`Color feature at (${f.x}, ${f.y}), intensity: ${f.intensity}, size: ${f.regionSize}`);
  });
  return features;
}

// Example 4: Line Detection (Edges Only)
// Detect straight lines along edges using Hough transform
function example4_lineDetection(image) {
  const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
    modes: [DETECTION_MODES.LINES],
    linesOptions: {
      edgeThreshold: 50,     // Threshold for edge detection
      houghThreshold: 50,    // Hough transform voting threshold
      minLineLength: 30,     // Minimum line length (currently unused)
      maxLineGap: 10         // Maximum gap in line (currently unused)
    }
  });
  
  // Returns: Array of features with {x, y, type: 'lines', theta, rho, votes}
  features.forEach(f => {
    console.log(`Line at (${f.x}, ${f.y}), angle: ${f.theta}, distance: ${f.rho}`);
  });
  return features;
}

// Example 5: Multiple Detection Modes Combined
// Run multiple detection modes simultaneously
function example5_combinedDetection(image) {
  const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
    modes: [DETECTION_MODES.CORNER, DETECTION_MODES.COLOR, DETECTION_MODES.LINES]
  });
  
  // Features from all modes are combined into a single array
  const cornerFeatures = features.filter(f => f.type === DETECTION_MODES.CORNER);
  const colorFeatures = features.filter(f => f.type === DETECTION_MODES.COLOR);
  const lineFeatures = features.filter(f => f.type === DETECTION_MODES.LINES);
  
  console.log(`Total: ${features.length} features`);
  console.log(`  Corners: ${cornerFeatures.length}`);
  console.log(`  Colors: ${colorFeatures.length}`);
  console.log(`  Lines: ${lineFeatures.length}`);
  
  return features;
}

// Example 6: Using Frame Detection
// Detect features only in specific regions of the image
function example6_frameDetection(image) {
  // Only detect in the border area (10% margin on all sides)
  const features = extract(
    image,
    {top: 0.1, right: 0.1, bottom: 0.1, left: 0.1}, // Frame detection
    {modes: [DETECTION_MODES.COLOR]}
  );
  
  console.log('Features in border area:', features.length);
  return features;
}

// Example 7: Custom Options for Each Mode
// Fine-tune detection parameters for specific use cases
function example7_customOptions(image) {
  const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
    modes: [DETECTION_MODES.COLOR, DETECTION_MODES.LINES],
    colorOptions: {
      numClusters: 10,       // Detect more color clusters
      minRegionSize: 100,    // Only large regions
      colorThreshold: 20     // Stricter color similarity
    },
    linesOptions: {
      edgeThreshold: 100,    // More sensitive edge detection
      houghThreshold: 30,    // Lower voting threshold for more lines
      minLineLength: 50,
      maxLineGap: 5
    }
  });
  
  return features;
}

// Example 8: Check Available Detection Modes
function example8_checkModes() {
  console.log('Available detection modes:', DETECTION_MODES);
  // Output: { CORNER: 'corner', COLOR: 'color', LINES: 'lines' }
  
  console.log('Default detection options:', DEFAULT_DETECTION_OPTIONS);
  // Shows all default parameters
}

// Common Feature Structure:
// All features have at minimum: {x, y, type}
// 
// Corner features: {x, y, type: 'corner'}
// Color features:  {x, y, type: 'color', intensity, regionSize}
// Line features:   {x, y, type: 'lines', theta, rho, votes}

export {
  example1_backwardCompatibility,
  example2_explicitCorner,
  example3_colorDetection,
  example4_lineDetection,
  example5_combinedDetection,
  example6_frameDetection,
  example7_customOptions,
  example8_checkModes
};
