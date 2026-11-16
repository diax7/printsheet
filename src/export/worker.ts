/// <reference lib="webworker" />
/**
 * Export worker: builds the PDF or PNG off the main thread, so the editor stays responsive and
 * a Cancel button can simply stop the worker. Loaded as an inline classic worker (a module
 * worker failed to start from file:// in testing).
 */
import { buildPdf, type PixelSource } from '@/export/pdf';
import { createCmykConverter, type CmykConverter } from '@/export/cmyk';
import { renderPng } from '@/export/png';
import { exportBlocker } from '@/model/checks';
import type { ExportOptions, ImageAsset, Sheet } from '@/model/types';
import profileDataUrl from '@/assets/cmyk-profile.icc?inline';

export interface ExportRequest {
  sheet: Sheet;
  assets: ImageAsset[];
  options: ExportOptions;
}

export type ExportMessage =
  | { type: 'progress'; done: number; total: number; stage: string }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string };

const post = (message: ExportMessage): void => self.postMessage(message);

/** The bundled profile is inlined as a data URL; decode it without any network request. */
function profileBytes(): Uint8Array {
  const base64 = profileDataUrl.slice(profileDataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const pixels: PixelSource = async (asset, width, height) => {
  const resize = width !== asset.widthPx || height !== asset.heightPx;
  const bitmap = await createImageBitmap(
    asset.blob,
    resize
      ? {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
          premultiplyAlpha: 'none',
        }
      : { premultiplyAlpha: 'none' },
  );
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser cannot read image pixels here.');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    // Sentinel against silent canvas failures: a non-empty image must not come back blank.
    if (!data.some((v, i) => i % 4 === 3 && v > 0)) {
      throw new Error(
        `"${asset.name}" could not be read back (${width} × ${height} px). Try a smaller image.`,
      );
    }
    return data;
  } finally {
    bitmap.close();
  }
};

async function run({ sheet, assets, options }: ExportRequest): Promise<Blob> {
  const blocker = exportBlocker(sheet);
  if (blocker) throw new Error(blocker);
  const map = new Map(assets.map((a) => [a.id, a]));
  if (options.format === 'png') {
    return renderPng(sheet, map, { dpi: options.pngDpi, mirror: options.mirror }, (done, total) =>
      post({ type: 'progress', done, total, stage: 'Drawing the PNG' }),
    );
  }
  let toCmyk: CmykConverter | undefined;
  if (options.color === 'cmyk') toCmyk = await createCmykConverter(profileBytes());
  const bytes = await buildPdf(sheet, map, options, {
    pixels,
    ...(toCmyk ? { toCmyk } : {}),
    onProgress: (done, total) =>
      post({ type: 'progress', done, total, stage: 'Adding images to the PDF' }),
  });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

self.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
  run(event.data).then(
    (blob) => post({ type: 'done', blob }),
    (error: unknown) =>
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  );
});
