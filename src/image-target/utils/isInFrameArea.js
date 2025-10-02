/**
 * Check if a point (x, y) is within the frame border area
 */
const isInFrameArea = (x, y, width, height, frameBorder) => {
    if (frameBorder.top === 0 && frameBorder.right === 0 &&
        frameBorder.bottom === 0 && frameBorder.left === 0) return true;

    const topPixels = Math.floor(height * frameBorder.top);
    const bottomPixels = height - Math.floor(height * frameBorder.bottom);
    const leftPixels = Math.floor(width * frameBorder.left);
    const rightPixels = width - Math.floor(width * frameBorder.right);

    return x < leftPixels || x > rightPixels || y < topPixels || y > bottomPixels;
};

export {
    isInFrameArea
}

