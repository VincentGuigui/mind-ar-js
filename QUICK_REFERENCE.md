# Quick Reference Guide - Feature Detection Modes

## Quick Start

```javascript
import { extract, DETECTION_MODES } from './src/image-target/tracker/extract.js';

// Detect corners (default)
const corners = extract(image);

// Detect colors
const colors = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.COLOR]
});

// Detect lines
const lines = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.LINES]
});

// Detect all
const all = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.CORNER, DETECTION_MODES.COLOR, DETECTION_MODES.LINES]
});
```

## Detection Modes

| Mode | Type | Returns | Use Case |
|------|------|---------|----------|
| `CORNER` | Gradient-based | `{x, y, type}` | Corner points, edges |
| `COLOR` | Clustering | `{x, y, type, intensity, regionSize}` | Color regions, blobs |
| `LINES` | Hough Transform | `{x, y, type, theta, rho, votes}` | Straight lines, edges |

## Common Options

### Color Detection
```javascript
colorOptions: {
  numClusters: 5,      // 3-10 recommended
  minRegionSize: 50,   // Minimum pixels
  colorThreshold: 30   // 0-255, lower = stricter
}
```

### Line Detection
```javascript
linesOptions: {
  edgeThreshold: 50,   // Edge sensitivity
  houghThreshold: 50,  // Line detection threshold
  minLineLength: 30,   // Minimum line length
  maxLineGap: 10       // Max gap in line
}
```

## Examples

### Detect Color Regions
```javascript
const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.COLOR],
  colorOptions: {
    numClusters: 8,
    minRegionSize: 100,
    colorThreshold: 25
  }
});

// Filter large regions
const largeRegions = features.filter(f => f.regionSize > 500);
```

### Detect Strong Lines
```javascript
const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.LINES],
  linesOptions: {
    edgeThreshold: 30,
    houghThreshold: 80,  // Higher = only strong lines
  }
});

// Get horizontal lines (theta near 0 or π)
const horizontal = features.filter(f => 
  Math.abs(f.theta) < 0.1 || Math.abs(f.theta - Math.PI) < 0.1
);
```

### Multi-Mode Detection
```javascript
const features = extract(image, {top: 0, right: 0, bottom: 0, left: 0}, {
  modes: [DETECTION_MODES.CORNER, DETECTION_MODES.COLOR]
});

// Separate by type
const corners = features.filter(f => f.type === 'corner');
const colors = features.filter(f => f.type === 'color');
```

### Frame Detection (Border Only)
```javascript
// Detect only in 10% border area
const borderFeatures = extract(
  image,
  {top: 0.1, right: 0.1, bottom: 0.1, left: 0.1},
  {modes: [DETECTION_MODES.COLOR]}
);
```

## Tuning Tips

### For Better Color Detection
- Increase `numClusters` for more detailed color separation
- Increase `minRegionSize` to filter out small noise
- Decrease `colorThreshold` for stricter color matching

### For Better Line Detection
- Decrease `edgeThreshold` to detect more edges
- Increase `houghThreshold` to filter out weak lines
- Adjust both together to find sweet spot

### For Better Performance
- Use `frameDetection` to limit search area
- Reduce `numClusters` for color detection
- Increase thresholds to reduce feature count

## Return Structure

```javascript
// Corner features
{x: 145, y: 203, type: 'corner'}

// Color features
{x: 100, y: 150, type: 'color', intensity: 128, regionSize: 523}

// Line features
{x: 150, y: 100, type: 'lines', theta: 1.57, rho: 150.5, votes: 89}
```

## Common Patterns

```javascript
// Pattern 1: Get feature count by type
const counts = features.reduce((acc, f) => {
  acc[f.type] = (acc[f.type] || 0) + 1;
  return acc;
}, {});

// Pattern 2: Find features near a point
const nearPoint = (px, py, radius) => 
  features.filter(f => 
    Math.sqrt((f.x - px)**2 + (f.y - py)**2) < radius
  );

// Pattern 3: Get strongest line features
const strongestLines = features
  .filter(f => f.type === 'lines')
  .sort((a, b) => b.votes - a.votes)
  .slice(0, 10);

// Pattern 4: Get largest color regions
const largestRegions = features
  .filter(f => f.type === 'color')
  .sort((a, b) => b.regionSize - a.regionSize)
  .slice(0, 5);
```

## See Also

- `FEATURE_DETECTION.md` - Full documentation
- `extract-examples.js` - 8 detailed examples
- `ARCHITECTURE.md` - Technical architecture
- `IMPLEMENTATION_SUMMARY.md` - Implementation details
