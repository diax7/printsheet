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
import { splitForExport, type ExportPart } from '@/model/pages';
import { outputKind, partFileName } from '@/export/output';
import { makeZip } from '@/export/zip';
import type { ExportOptions, ImageAsset, Sheet } from '@/model/types';
import profileDataUrl from '@/assets/cmyk-profile.icc?inline';

export interface ExportRequest {
  sheet: Sheet;
  assets: ImageAsset[];
  options: ExportOptions;
}

/** A finished file: what to call it and its content. */
export interface ExportFile {
  name: string;
  blob: Blob;
}

export type ExportMessage =
  | { type: 'progress'; done: number; total: number; stage: string }
  | { type: 'done'; files: ExportFile[] }
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

type Progress = (done: number, total: number, stage: string) => void;

const onProgress: Progress = (done, total, stage) => post({ type: 'progress', done, total, stage });

/** What every file of one export shares: the images, the options and the CMYK converter. */
interface ExportContext {
  map: ReadonlyMap<string, ImageAsset>;
  options: ExportOptions;
  /** Built once per export: parsing the profile for every sheet would repeat the slowest step. */
  toCmyk?: CmykConverter;
}

/** Builds one PDF of the given sheets (one page each). */
async function pdfOf(sheets: Sheet[], context: ExportContext, stage: string): Promise<Blob> {
  const { map, options, toCmyk } = context;
  const bytes = await buildPdf(sheets, map, options, {
    pixels,
    ...(toCmyk ? { toCmyk } : {}),
    onProgress: (done, total) => onProgress(done, total, stage),
  });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

/** One file per part (a PDF or a PNG each), named `<name>-sheet-2-of-3`. */
async function filePerPart(parts: ExportPart[], context: ExportContext): Promise<ExportFile[]> {
  const { map, options } = context;
  const files: ExportFile[] = [];
  for (const part of parts) {
    // "Sheet 2 of 3: adding images" for a split job, "Adding images" for one file.
    const stage = (what: string): string =>
      parts.length > 1
        ? `Sheet ${part.number} of ${part.of}: ${what}`
        : what[0]?.toUpperCase() + what.slice(1);
    const blob =
      options.format === 'png'
        ? await renderPng(
            part.sheet,
            map,
            { dpi: options.pngDpi, mirror: options.mirror },
            (d, t) => onProgress(d, t, stage('drawing the PNG')),
          )
        : await pdfOf([part.sheet], context, stage('adding images'));
    files.push({ name: partFileName(options.fileName, part, options.format), blob });
  }
  return files;
}

async function run({ sheet, assets, options }: ExportRequest): Promise<ExportFile[]> {
  const blocker = exportBlocker(sheet);
  if (blocker) throw new Error(blocker);
  const { parts } = splitForExport(sheet);
  // Every design must reach a file. The blocker above already refuses designs on no sheet; this
  // stops a future change from silently leaving one out of the print.
  if (parts.reduce((n, p) => n + p.sheet.designs.length, 0) !== sheet.designs.length) {
    throw new Error('A design is on no sheet, so nothing was exported. Move it onto a sheet.');
  }
  const context: ExportContext = { map: new Map(assets.map((a) => [a.id, a])), options };
  if (options.format === 'pdf' && options.color === 'cmyk') {
    context.toCmyk = await createCmykConverter(profileBytes());
  }
  const kind = outputKind(options, parts.length);
  if (kind === 'pdf-pages') {
    const blob = await pdfOf(
      parts.map((p) => p.sheet),
      context,
      'Adding images',
    );
    return [{ name: `${options.fileName}.pdf`, blob }];
  }
  const files = await filePerPart(parts, context);
  if (kind !== 'zip') return files;
  onProgress(0, 1, 'Packing the zip');
  return [{ name: `${options.fileName}.zip`, blob: await makeZip(files) }];
}

self.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
  run(event.data).then(
    (files) => post({ type: 'done', files }),
    (error: unknown) =>
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  );
});
