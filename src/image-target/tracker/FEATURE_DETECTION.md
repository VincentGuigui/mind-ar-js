# Feature Detection Modes

This document describes the multiple feature detection modes available in the `extract` function.

## Overview

The `extract` function now supports three types of feature detection:

1. **Corner Detection** - Detects corners and strong gradient points (original behavior)
2. **Color Detection** - Detects regions with similar colors/intensities using clustering
3. **Lines Detection** - Detects straight lines along edges using Hough transform

## Usage

### Basic Usage (Backward Compatible)

```javascript
import { extract } from './src/image-target/tracker/extract.js';

// Default behavior (corner detection)
const features = extract(image);
```

### Using Detection Modes

```javascript
import { extract, DETECTION_MODES } from './src/image-target/tracker/extract.js';

// Corner detection
const corners = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.CORNER]
});

// Color detection
const colors = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.COLOR]
});

// Line detection
const lines = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.LINES]
});

// Multiple modes
const allFeatures = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.CORNER, DETECTION_MODES.COLOR, DETECTION_MODES.LINES]
});
```

## Detection Modes

### DETECTION_MODES.CORNER

Detects corner-like features using gradient-based methods. This is the original implementation.

**Returns:** Features with structure `{x, y, type: 'corner'}`

**Options:** Uses existing corner detection parameters (built-in)

### DETECTION_MODES.COLOR

Detects regions with similar colors/intensities using k-means-like clustering.

**Returns:** Features with structure `{x, y, type: 'color', intensity, regionSize}`

**Options:**
```javascript
colorOptions: {
  numClusters: 5,        // Number of color clusters to detect (default: 5)
  minRegionSize: 50,     // Minimum region size in pixels (default: 50)
  colorThreshold: 30     // Color similarity threshold 0-255 (default: 30)
}
```

### DETECTION_MODES.LINES

Detects straight lines along edges using Hough transform.

**Returns:** Features with structure `{x, y, type: 'lines', theta, rho, votes}`

**Options:**
```javascript
linesOptions: {
  edgeThreshold: 50,     // Threshold for edge detection (default: 50)
  houghThreshold: 50,    // Hough transform threshold (default: 50)
  minLineLength: 30,     // Minimum line length (default: 30)
  maxLineGap: 10         // Maximum gap between segments (default: 10)
}
```

## Configuration Examples

### Example 1: Detect Only Strong Color Regions

```javascript
const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.COLOR],
  colorOptions: {
    numClusters: 3,
    minRegionSize: 100,    // Only large regions
    colorThreshold: 20     // Strict similarity
  }
});
```

### Example 2: Detect Lines with High Sensitivity

```javascript
const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.LINES],
  linesOptions: {
    edgeThreshold: 30,     // More sensitive to edges
    houghThreshold: 40,    // Lower voting threshold
  }
});
```

### Example 3: Combined Detection with Custom Settings

```javascript
const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.CORNER, DETECTION_MODES.COLOR],
  colorOptions: {
    numClusters: 10,
    minRegionSize: 50,
    colorThreshold: 25
  }
});

// Filter by type
const corners = features.filter(f => f.type === DETECTION_MODES.CORNER);
const colors = features.filter(f => f.type === DETECTION_MODES.COLOR);
```

## Frame Detection

Frame detection allows you to restrict feature detection to specific regions of the image:

```javascript
// Detect features only in the border area (10% margin)
const borderFeatures = extract(
  image,
  {top: 0.1, right: 0.1, bottom: 0.1, left: 0.1},
  {modes: [DETECTION_MODES.COLOR]}
);

// Detect features everywhere (default)
const allFeatures = extract(
  image,
  {top: 0, right: 0, bottom: 0, left: 0},
  {modes: [DETECTION_MODES.COLOR]}
);
```

**Note:** Frame detection percentages specify the border area where detection occurs. Values are percentages of image width/height (0.0 to 1.0).

## Feature Structure

All features have a common base structure:

```javascript
{
  x: number,      // X coordinate
  y: number,      // Y coordinate
  type: string    // Detection mode: 'corner', 'color', or 'lines'
}
```

### Corner Features
```javascript
{
  x: number,
  y: number,
  type: 'corner'
}
```

### Color Features
```javascript
{
  x: number,           // Centroid X
  y: number,           // Centroid Y
  type: 'color',
  intensity: number,   // Average intensity (0-255)
  regionSize: number   // Number of pixels in region
}
```

### Line Features
```javascript
{
  x: number,      // Sample point X on the line
  y: number,      // Sample point Y on the line
  type: 'lines',
  theta: number,  // Line angle in radians
  rho: number,    // Distance from origin
  votes: number   // Hough accumulator votes
}
```

## Integration with extractTrackingFeatures

The `extractTrackingFeatures` function in `extract-utils.js` now accepts detection options:

```javascript
import { extractTrackingFeatures } from './src/image-target/tracker/extract-utils.js';

const featureSets = extractTrackingFeatures(
  imageList,
  doneCallback,
  frameDetection,
  detectionOptions  // Optional: detection options
);
```

## Default Behavior

When no detection options are provided, the function defaults to corner detection for backward compatibility:

```javascript
// These are equivalent:
const features1 = extract(image);
const features2 = extract(image, {top: 0, right: 0, bottom: 0, left: 0});
const features3 = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.CORNER]
});
```

## Performance Considerations

- **Corner Detection**: Fast, well-optimized (original implementation)
- **Color Detection**: Moderate, scales with numClusters and image size
- **Line Detection**: Can be slower for large images due to Hough transform

For best performance when using multiple modes:
1. Use appropriate thresholds to limit feature count
2. Consider using frame detection to limit search area
3. Adjust numClusters for color detection based on your needs

## See Also

- `extract-examples.js` - Complete usage examples
- Original `extract.js` documentation for corner detection details
