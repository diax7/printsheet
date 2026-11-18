/**
 * JPEG encoding for the compact PDF, with jpeg-js (pure JavaScript, so it runs the same in the
 * export worker and in Node tests). Chosen over the browser's canvas encoder because that one
 * halves colour resolution (4:2:0) at every quality below 100, which softens coloured edges
 * such as red text; jpeg-js keeps full colour resolution (4:4:4).
 */
import { encode } from 'jpeg-js';

/** High enough that the difference cannot be seen in print; about a quarter of lossless size. */
export const JPEG_QUALITY = 92;

/**
 * jpeg-js hands its bytes to `Buffer.from` whenever it sees a CommonJS `module`, which the
 * bundler provides. Browsers have no Buffer, so supply the one call it makes.
 */
function ensureBufferFrom(): void {
  const scope = globalThis as { Buffer?: unknown };
  if (scope.Buffer === undefined) {
    scope.Buffer = { from: (bytes: ArrayLike<number>) => Uint8Array.from(bytes) };
  }
}

/**
 * Encodes RGBA pixels as a baseline JPEG; alpha is ignored (the PDF keeps it in a soft mask).
 *
 * Args:
 *   rgba: Pixels, 4 bytes each.
 *   width: Image width in pixels.
 *   height: Image height in pixels.
 */
export function encodeJpeg(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  ensureBufferFrom();
  const { data } = encode({ data: rgba, width, height }, JPEG_QUALITY);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
