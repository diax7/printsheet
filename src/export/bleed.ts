/**
 * Colour under transparency, for the compact (JPEG) PDF. The browser returns fully transparent
 * pixels as black. JPEG codes 8×8 blocks, so a block holding both a design edge and that black
 * would smear dark into the edge pixels that do get ink. Giving each transparent pixel the colour
 * of the nearest visible pixel keeps every block that touches the design smooth. Only colour
 * changes; the soft mask keeps the exact alpha, so nothing transparent starts to print.
 */

/**
 * How far (in 4-connected steps) colour spreads into transparency. Two pixels in the same 8×8
 * block are at most 14 steps apart, so 16 covers every block that holds a visible pixel; pixels
 * farther out sit in fully transparent blocks, which JPEG codes on their own.
 */
export const BLEED_DEPTH = 16;

function copyColour(data: Uint8ClampedArray, from: number, to: number): void {
  data[to * 4] = data[from * 4] ?? 0;
  data[to * 4 + 1] = data[from * 4 + 1] ?? 0;
  data[to * 4 + 2] = data[from * 4 + 2] ?? 0;
}

/**
 * Spreads visible colour into fully transparent pixels, in place, up to BLEED_DEPTH steps out.
 *
 * Args:
 *   rgba: Pixels, 4 bytes each, not premultiplied. Alpha is never changed.
 *   width: Image width in pixels.
 *   height: Image height in pixels.
 */
export function bleedTransparent(rgba: Uint8ClampedArray, width: number, height: number): void {
  const count = width * height;
  if (rgba.length !== count * 4) {
    throw new Error(`Pixel data size ${rgba.length} does not match ${width}×${height} RGBA`);
  }
  const reached = new Uint8Array(count);
  let frontier: number[] = [];
  for (let p = 0; p < count; p++) {
    if ((rgba[p * 4 + 3] ?? 0) > 0) {
      reached[p] = 1;
      frontier.push(p);
    }
  }
  for (let step = 0; step < BLEED_DEPTH && frontier.length > 0; step++) {
    const next: number[] = [];
    const visit = (from: number, to: number): void => {
      if (reached[to]) return;
      reached[to] = 1;
      copyColour(rgba, from, to);
      next.push(to);
    };
    for (const p of frontier) {
      const x = p % width;
      if (x > 0) visit(p, p - 1);
      if (x < width - 1) visit(p, p + 1);
      if (p >= width) visit(p, p - width);
      if (p + width < count) visit(p, p + width);
    }
    frontier = next;
  }
}
