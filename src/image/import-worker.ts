/// <reference lib="webworker" />
/**
 * Import worker: decode, size-check, trim and re-encode one image at a time, off the main
 * thread so an 8000 px image does not freeze the editor.
 *
 * Every import is re-encoded through a canvas as an 8-bit sRGB PNG on purpose: PNGs with colour
 * profiles, gamma chunks or 16-bit channels then decode identically for the screen, the PNG
 * export and the PDF export. (Cost: JPGs grow into larger PNGs; very faint pixels round.) A
 * near-invisible haze (alpha 10 or less) is cleared before trimming (see FAINT_ALPHA_MAX).
 */
import { clearFaintPixels, hasTransparentPixelsIn, trimBounds } from '@/image/trim';

export interface ImportRequest {
  id: number;
  file: Blob;
  name: string;
}

export type ImportResponse =
  | {
      id: number;
      ok: true;
      blob: Blob;
      widthPx: number;
      heightPx: number;
      hasTransparency: boolean;
      hash: string;
    }
  | { id: number; ok: false; message: string };

/**
 * Largest image accepted. Chromium returns blank pixels past 16384 px on a side; 100 megapixels
 * keeps the decoded copies (about 400 MB each) within what a browser tab can hold.
 */
export const MAX_IMPORT_SIDE = 16384;
export const MAX_IMPORT_AREA = 100_000_000;

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest).subarray(0, 12), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

async function importOne(
  file: Blob,
  name: string,
): Promise<Omit<Extract<ImportResponse, { ok: true }>, 'id' | 'ok'>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    });
  } catch {
    throw new Error(`"${name}" could not be read as an image. Use a PNG, JPG or WebP file.`);
  }
  try {
    const { width, height } = bitmap;
    if (width > MAX_IMPORT_SIDE || height > MAX_IMPORT_SIDE || width * height > MAX_IMPORT_AREA) {
      throw new Error(
        `"${name}" is ${width} × ${height} px, larger than this tool can handle (at most ${MAX_IMPORT_SIDE} px on a side and 100 megapixels). Make it smaller and try again.`,
      );
    }
    const full = new OffscreenCanvas(width, height);
    const ctx = full.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser cannot process images here.');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, width, height);
    const pixels = image.data;
    // A near-invisible haze would stop the trim and could print as white dust: clear it first.
    clearFaintPixels(pixels);
    const box = trimBounds(pixels, width, height);
    if (!box) throw new Error(`"${name}" is fully transparent, so there is nothing to print.`);

    const trimmed = new OffscreenCanvas(box.w, box.h);
    const tctx = trimmed.getContext('2d');
    if (!tctx) throw new Error('This browser cannot process images here.');
    // Draw from the cleaned pixels (not the original bitmap), so the haze inside the box goes too.
    tctx.putImageData(image, -box.x, -box.y, box.x, box.y, box.w, box.h);
    // Check transparency on the pixels already read, instead of copying the crop again.
    const hasTransparency = hasTransparentPixelsIn(pixels, width, box);
    // Free the full-size canvas before encoding: large images hold several copies at once.
    full.width = 0;
    full.height = 0;
    const blob = await trimmed.convertToBlob({ type: 'image/png' });
    return {
      blob,
      widthPx: box.w,
      heightPx: box.h,
      hasTransparency,
      hash: await sha256(blob),
    };
  } finally {
    bitmap.close();
  }
}

self.addEventListener('message', (event: MessageEvent<ImportRequest>) => {
  const { id, file, name } = event.data;
  importOne(file, name).then(
    (result) => self.postMessage({ id, ok: true, ...result } satisfies ImportResponse),
    (error: unknown) =>
      self.postMessage({
        id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ImportResponse),
  );
});
