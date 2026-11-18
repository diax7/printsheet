/**
 * Shape masks: where an image has ink, on a coarse grid. Real shape spacing measures the cutting
 * gap between these outlines instead of between rectangles.
 *
 * A mask is conservative: a cell is set when ANY pixel touching it has alpha above 0, however
 * faint, because DTF prints white ink under every visible pixel. It is therefore built from the
 * full image and never from a scaled preview, where averaging makes faint pixels vanish.
 */

/** Longest side of a mask, in cells. A 50 cm design then has cells of about 1 mm. */
export const MASK_MAX_SIDE = 512;

export interface ShapeMask {
  cols: number;
  rows: number;
  /** One byte per cell, row by row: 1 where the image has ink. */
  cells: Uint8Array;
  /**
   * Summed-area table, (cols + 1) × (rows + 1): the number of ink cells above and left of each
   * corner, so "is there ink in this block of cells" is four lookups.
   */
  sum: Uint32Array;
}

/** The cells of a mask without its table: what a worker sends back. */
export interface MaskCells {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

/** Mask size for an image: the image's shape, at most `MASK_MAX_SIDE` cells on the long side. */
export function maskSize(widthPx: number, heightPx: number): { cols: number; rows: number } {
  const scale = Math.min(1, MASK_MAX_SIDE / Math.max(widthPx, heightPx));
  return {
    cols: Math.max(1, Math.ceil(widthPx * scale)),
    rows: Math.max(1, Math.ceil(heightPx * scale)),
  };
}

/**
 * For each pixel along one axis, the first and last mask cell it touches. A pixel on a cell
 * boundary belongs to both cells, which is what keeps the mask conservative.
 */
function cellSpans(pixels: number, cells: number): { first: Uint16Array; last: Uint16Array } {
  const first = new Uint16Array(pixels);
  const last = new Uint16Array(pixels);
  for (let p = 0; p < pixels; p++) {
    first[p] = Math.min(cells - 1, Math.floor((p * cells) / pixels));
    last[p] = Math.min(cells - 1, Math.ceil(((p + 1) * cells) / pixels) - 1);
  }
  return { first, last };
}

/** Adds the summed-area table to a mask's cells. */
export function withSum(mask: MaskCells): ShapeMask {
  const { cols, rows, cells } = mask;
  const stride = cols + 1;
  const sum = new Uint32Array(stride * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      run += cells[r * cols + c] as number;
      sum[(r + 1) * stride + c + 1] = (sum[r * stride + c + 1] as number) + run;
    }
  }
  return { cols, rows, cells, sum };
}

/**
 * Builds the mask of an image from its alpha values.
 *
 * Args:
 *   widthPx: Image width in pixels.
 *   heightPx: Image height in pixels.
 *   alphaAt: Alpha (0 to 255) of the pixel at column x, row y.
 *
 * Returns:
 *   The mask cells; a cell is set when any pixel touching it has alpha above 0.
 */
export function buildMaskCells(
  widthPx: number,
  heightPx: number,
  alphaAt: (x: number, y: number) => number,
): MaskCells {
  const { cols, rows } = maskSize(widthPx, heightPx);
  const cells = new Uint8Array(cols * rows);
  const xs = cellSpans(widthPx, cols);
  const ys = cellSpans(heightPx, rows);
  for (let y = 0; y < heightPx; y++) {
    const r0 = (ys.first[y] as number) * cols;
    const r1 = (ys.last[y] as number) * cols;
    for (let x = 0; x < widthPx; x++) {
      if (alphaAt(x, y) <= 0) continue;
      const c0 = xs.first[x] as number;
      const c1 = xs.last[x] as number;
      cells[r0 + c0] = 1;
      cells[r0 + c1] = 1;
      cells[r1 + c0] = 1;
      cells[r1 + c1] = 1;
    }
  }
  return { cols, rows, cells };
}

/**
 * The mask of the part of an RGBA image inside `box` (the trimmed image).
 *
 * Args:
 *   rgba: Pixel data of the whole image, 4 bytes per pixel.
 *   width: Width of the whole image in pixels.
 *   box: The trimmed area the mask describes.
 */
export function maskFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  box: { x: number; y: number; w: number; h: number },
): MaskCells {
  return buildMaskCells(
    box.w,
    box.h,
    (x, y) => rgba[((box.y + y) * width + box.x + x) * 4 + 3] as number,
  );
}

/** A mask with ink everywhere: the design's whole rectangle. */
export function fullMask(): ShapeMask {
  return withSum({ cols: 1, rows: 1, cells: new Uint8Array([1]) });
}
