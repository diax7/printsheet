/**
 * PNG row filtering (filter type 4, "Paeth"), shared by the PNG export and the PDF's lossless
 * images (PDF reads the same rows through its Predictor 15). Each byte is stored as its
 * difference from a guess made from the bytes left, above and above-left of it, which turns
 * smooth artwork into long runs of small numbers that deflate compresses several times better.
 * Lossless: the reader reverses it exactly.
 */

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Filters `rows` rows of `width` pixels of `bpp` bytes each. Every output row starts with its
 * filter type byte (4).
 *
 * Args:
 *   data: The rows, packed with no padding.
 *   width: Pixels per row.
 *   rows: Number of rows in `data`.
 *   bpp: Bytes per pixel (1 grey, 3 RGB, 4 RGBA or CMYK).
 *   above: The unfiltered row just above the first one, when this is a later strip of a larger
 *     image; null for the image's first row, which PNG treats as having zeros above it.
 */
export function filterPaeth(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  rows: number,
  bpp: number,
  above: Uint8Array | Uint8ClampedArray | null,
): Uint8Array<ArrayBuffer> {
  const stride = width * bpp;
  if (data.length < rows * stride) {
    throw new Error(`Row data has ${data.length} bytes, expected ${rows * stride}`);
  }
  const out = new Uint8Array(rows * (stride + 1));
  for (let y = 0; y < rows; y++) {
    const row = y * stride;
    const prev = y > 0 ? data.subarray(row - stride, row) : above;
    const target = y * (stride + 1);
    out[target] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (data[row + x - bpp] ?? 0) : 0;
      const b = prev ? (prev[x] ?? 0) : 0;
      const c = prev && x >= bpp ? (prev[x - bpp] ?? 0) : 0;
      out[target + 1 + x] = ((data[row + x] ?? 0) - paeth(a, b, c)) & 255;
    }
  }
  return out;
}
