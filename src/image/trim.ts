/**
 * Pixel scans on raw RGBA data (4 bytes per pixel). Pure, so they run in Node tests, the main
 * thread and workers alike.
 */

/**
 * Pixels at or below this alpha (10 of 255, under 4% visible) are cleared on import. Background
 * removal and AI tools often leave a near-invisible haze around a design; it cannot be seen on
 * screen, but it stops the trim (the design keeps a huge empty box) and a DTF printer can lay
 * white ink under it, printing a dusty halo. Owner's choice (2026-11-18): clean it automatically.
 */
export const FAINT_ALPHA_MAX = 10;

/**
 * Makes nearly invisible pixels fully transparent, in place.
 *
 * Args:
 *   rgba: Pixels, 4 bytes each, not premultiplied.
 *
 * Returns:
 *   How many pixels were cleared.
 */
export function clearFaintPixels(rgba: Uint8ClampedArray): number {
  let cleared = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i] ?? 0;
    if (alpha === 0 || alpha > FAINT_ALPHA_MAX) continue;
    rgba[i - 3] = 0;
    rgba[i - 2] = 0;
    rgba[i - 1] = 0;
    rgba[i] = 0;
    cleared++;
  }
  return cleared;
}

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
