# Feature Detection Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     extract(image, frameDetection,              │
│                              detectionOptions)                   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ├─── Parse & Merge Options
                                 │
                    ┌────────────┴────────────┐
                    │   Loop over modes       │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│ DETECTION_MODES.   │  │ DETECTION_MODES.   │  │ DETECTION_MODES.   │
│     CORNER         │  │     COLOR          │  │     LINES          │
└────────────────────┘  └────────────────────┘  └────────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│_extractCorner      │  │_extractColor       │  │_extractLine        │
│Features()          │  │Features()          │  │Features()          │
│                    │  │                    │  │                    │
│ • Gradient calc    │  │ • K-means cluster  │  │ • Sobel edges      │
│ • Local maxima     │  │ • Pixel grouping   │  │ • Hough transform  │
│ • Template match   │  │ • Centroid calc    │  │ • Peak detection   │
│ • Feature select   │  │ • Size filtering   │  │ • Point sampling   │
└────────────────────┘  └────────────────────┘  └────────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│{x, y,              │  │{x, y,              │  │{x, y,              │
│ type: 'corner'}    │  │ type: 'color',     │  │ type: 'lines',     │
│                    │  │ intensity,         │  │ theta, rho,        │
│                    │  │ regionSize}        │  │ votes}             │
└────────────────────┘  └────────────────────┘  └────────────────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  Combine all features  │
                    │  (tagged with type)    │
                    └────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   Return feature array │
                    └────────────────────────┘
```

## Data Flow

### Input
```javascript
image: {
  data: Uint8Array,    // Grayscale pixel data
  width: number,       // Image width
  height: number,      // Image height
  scale: number        // Scale factor
}

frameDetection: {
  top: number,         // 0.0 - 1.0 (percentage)
  right: number,
  bottom: number,
  left: number
}

detectionOptions: {
  modes: ['corner' | 'color' | 'lines'],
  cornerOptions: { /* built-in */ },
  colorOptions: {
    numClusters: number,
    minRegionSize: number,
    colorThreshold: number
  },
  linesOptions: {
    edgeThreshold: number,
    houghThreshold: number,
    minLineLength: number,
    maxLineGap: number
  }
}
```

### Output
```javascript
[
  {x: number, y: number, type: 'corner'},
  {x: number, y: number, type: 'color', intensity: number, regionSize: number},
  {x: number, y: number, type: 'lines', theta: number, rho: number, votes: number},
  ...
]
```

## Integration Points

```
┌─────────────────────────────────────────┐
│     extractTrackingFeatures()           │
│     (extract-utils.js)                  │
└─────────────────────────────────────────┘
                  │
                  ├── For each image in imageList
                  │
                  ▼
         ┌────────────────────┐
         │  extract(image,    │
         │   frameDetection,  │
         │   detectionOptions)│
         └────────────────────┘
                  │
                  ▼
         ┌────────────────────┐
         │  Feature points    │
         │  {x, y, type, ...} │
         └────────────────────┘
                  │
                  ▼
         ┌────────────────────┐
         │   featureSet =     │
         │   {data, scale,    │
         │    width, height,  │
         │    points}         │
         └────────────────────┘
                  │
                  ▼
         ┌────────────────────┐
         │  Used by Tracker   │
         │  for AR tracking   │
         └────────────────────┘
```

## Algorithm Details

### Corner Detection (Original)
```
1. Compute gradient (dx, dy) for all pixels
2. Calculate dValue = sqrt(dx² + dy²) / 2
3. Select local maxima
4. Filter by top 2% strongest gradients
5. Build feature map using template matching
6. Select features with low similarity in neighborhood
7. Apply occupancy constraints
```

### Color Detection (New)
```
1. Initialize N cluster centers evenly across [0, 255]
2. For each pixel:
   a. Find nearest cluster center
   b. If distance < colorThreshold, assign to cluster
3. For each cluster:
   a. If cluster.size >= minRegionSize:
      - Compute centroid (average x, y)
      - Create feature at centroid
```

### Line Detection (New)
```
1. Apply Sobel operator for edge detection:
   - Compute Gx and Gy gradients
   - Calculate magnitude = sqrt(Gx² + Gy²)
   - Threshold to binary edge map

2. Hough Transform:
   - For each edge pixel (x, y):
     - Vote for all lines passing through it
     - rho = x*cos(theta) + y*sin(theta)
   - Accumulate votes in (theta, rho) space

3. Extract peaks from accumulator:
   - If votes > houghThreshold:
     - Convert (theta, rho) to feature point
     - Sample point on line within image bounds
```

## Configuration Strategy

### Default Configuration (Backward Compatible)
```javascript
{
  modes: [DETECTION_MODES.CORNER],
  cornerOptions: {},
  colorOptions: {numClusters: 5, minRegionSize: 50, colorThreshold: 30},
  linesOptions: {edgeThreshold: 50, houghThreshold: 50, minLineLength: 30, maxLineGap: 10}
}
```

### Custom Configuration Example
```javascript
{
  modes: [DETECTION_MODES.COLOR, DETECTION_MODES.LINES],
  colorOptions: {
    numClusters: 10,      // More detailed color detection
    minRegionSize: 100,   // Only large regions
    colorThreshold: 20    // Stricter color matching
  },
  linesOptions: {
    edgeThreshold: 30,    // More sensitive edges
    houghThreshold: 40    // More permissive line detection
  }
}
```
