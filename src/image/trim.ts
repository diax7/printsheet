/**
 * Pixel scans on raw RGBA data (4 bytes per pixel). Pure, so they run in Node tests, the main
 * thread and workers alike.
 */

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The smallest box holding every pixel with alpha above 0. Any visible pixel counts, even a faint
 * one, because DTF prints white ink under it. Null when the image is fully transparent.
 */
export function trimBounds(rgba: Uint8ClampedArray, w: number, h: number): PixelBox | null {
  if (rgba.length !== w * h * 4) {
    throw new Error(`Pixel data size ${rgba.length} does not match ${w}×${h} RGBA`);
  }
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if ((rgba[row + x * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** True when a pixel inside `box` (of an image `width` pixels wide) is not fully opaque. */
export function hasTransparentPixelsIn(
  rgba: Uint8ClampedArray,
  width: number,
  box: PixelBox,
): boolean {
  for (let y = box.y; y < box.y + box.h; y++) {
    const row = y * width * 4;
    for (let x = box.x; x < box.x + box.w; x++) {
      if ((rgba[row + x * 4 + 3] ?? 255) < 255) return true;
    }
  }
  return false;
}
