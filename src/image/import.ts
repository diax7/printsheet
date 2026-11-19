/**
 * Main-thread side of importing: hands files to the import worker one at a time and turns the
 * results into assets. One bad file never stops the others; each failure becomes a message.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ImportWorker from '@/image/import-worker?worker&inline';
import type { ImportRequest, ImportResponse } from '@/image/import-worker';
import { withSum, type ShapeMask } from '@/model/mask';
import type { FileFormat, ImageAsset } from '@/model/types';
import { detectFormat, FORMAT_HEAD_BYTES } from '@/image/format';
import { sha256 } from '@/image/hash';
import { svgSize } from '@/vector/svg-size';
import { BlankRenderError, baseRenderSize, renderSvg, svgWarnings } from '@/vector/svg';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (response: ImportResponse) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  const created = new ImportWorker();
  created.addEventListener('message', (event: MessageEvent<ImportResponse>) => {
    pending.get(event.data.id)?.(event.data);
    pending.delete(event.data.id);
  });
  const fail = (message: string): void => {
    for (const [id, resolve] of pending) resolve({ id, ok: false, message });
    pending.clear();
    created.terminate();
    worker = null;
  };
  created.addEventListener('error', (event) =>
    fail(`The image reader stopped: ${event.message || 'unknown error'}`),
  );
  created.addEventListener('messageerror', () =>
    fail('The image reader could not receive the file.'),
  );
  worker = created;
  return created;
}

function process(
  file: Blob,
  name: string,
  kind: ImportRequest['kind'] = 'import',
): Promise<ImportResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, file, name, kind } satisfies ImportRequest);
  });
}

/**
 * The ink mask of an image that has none yet (one restored from a saved sheet), worked out in
 * the import worker from the full image.
 */
export async function readMask(asset: ImageAsset): Promise<ShapeMask> {
  const response = await process(asset.blob, asset.name, 'mask');
  if (!response.ok) throw new Error(response.message);
  if (!('maskOnly' in response)) throw new Error('The image reader answered the wrong question.');
  return withSum(response.mask);
}

/** A readable design name from a file name: no extension, no path. */
export function nameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExtension = base.replace(/\.[a-z0-9]{2,5}$/i, '');
  return (withoutExtension.trim() || 'Image').slice(0, 120);
}

/** The badge field for a decoded image: only formats the browser decodes as pixels get one. */
function badge(format: FileFormat | 'unknown'): Pick<ImageAsset, 'format'> {
  return format === 'png' || format === 'jpg' || format === 'webp' || format === 'gif'
    ? { format }
    : {};
}

export interface ImportResult {
  assets: ImageAsset[];
  /** Ink masks of the imported images, by asset id. */
  masks: Map<string, ShapeMask>;
  errors: string[];
  /** Vector files that may not print as designed: live text, or images linked by path. */
  warnings: { liveText: string[]; linkedImages: string[] };
}

type Imported = { asset: ImageAsset; mask: ShapeMask } | { error: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A PNG of a canvas, then the canvas freed: a base render can be 16 megapixels. */
async function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!png) throw new Error('This browser could not keep the drawn image.');
  return png;
}

/** A PNG, JPG, WebP or other image the browser decodes: trimmed and masked in the worker. */
async function importRaster(
  blob: Blob,
  name: string,
  format: FileFormat | 'unknown',
): Promise<Imported> {
  const response = await process(blob, name);
  if (!response.ok) return { error: response.message };
  if ('maskOnly' in response) return { error: 'The image reader answered the wrong question.' };
  return {
    mask: withSum(response.mask),
    asset: {
      id: `img-${response.hash}`,
      name: nameFromFile(name),
      blob: response.blob,
      widthPx: response.widthPx,
      heightPx: response.heightPx,
      hasTransparency: response.hasTransparency,
      ...badge(format),
    },
  };
}

/**
 * An SVG: drawn once at a base size so the worker can trim and mask it like any image, with the
 * original kept for drawing afresh at print size. The trimmed border is kept as a crop of the
 * page, so every later drawing is of the inked area only.
 */
async function importSvg(blob: Blob, name: string): Promise<Imported> {
  const text = await blob.text();
  const size = svgSize(text);
  if (!size) {
    return {
      error: `"${name}" has no size. Give the SVG a width and height or a viewBox and add it again.`,
    };
  }
  const base = baseRenderSize(size.widthMm, size.heightMm);
  let png: Blob;
  try {
    png = await canvasToPng(await renderSvg(text, size.viewBox, base.widthPx, base.heightPx, name));
  } catch (error) {
    if (error instanceof BlankRenderError)
      return { error: `"${name}" is fully transparent, so there is nothing to print.` };
    return { error: messageOf(error) };
  }
  const response = await process(png, name);
  if (!response.ok) return { error: response.message };
  if ('maskOnly' in response) return { error: 'The image reader answered the wrong question.' };
  const sourceId = await sha256(blob);
  const { box, fullWidthPx, fullHeightPx } = response;
  const crop = {
    x: box.x / fullWidthPx,
    y: box.y / fullHeightPx,
    w: box.w / fullWidthPx,
    h: box.h / fullHeightPx,
  };
  return {
    mask: withSum(response.mask),
    asset: {
      id: `vec-${sourceId}-p1`,
      name: nameFromFile(name),
      blob: response.blob,
      widthPx: response.widthPx,
      heightPx: response.heightPx,
      hasTransparency: response.hasTransparency,
      format: 'svg',
      vector: {
        type: 'svg',
        sourceId,
        blob: new Blob([blob], { type: 'image/svg+xml' }),
        page: 1,
        crop,
        sizeMm: { w: size.widthMm * crop.w, h: size.heightMm * crop.h },
      },
    },
  };
}

/**
 * Import files in order. Identical images (same trimmed pixels) share one asset id, so the PDF
 * embeds them once; so do identical vector files.
 */
export async function importFiles(
  files: ReadonlyArray<{ blob: Blob; name: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = {
    assets: [],
    masks: new Map(),
    errors: [],
    warnings: { liveText: [], linkedImages: [] },
  };
  let done = 0;
  for (const { blob, name } of files) {
    const format = detectFormat(
      new Uint8Array(await blob.slice(0, FORMAT_HEAD_BYTES).arrayBuffer()),
      name,
    );
    let imported: Imported;
    if (typeof format === 'object') imported = { error: `"${name}": ${format.refuse}` };
    else if (format === 'svg') imported = await importSvg(blob, name);
    else imported = await importRaster(blob, name, format);
    if ('error' in imported) {
      result.errors.push(imported.error);
    } else {
      result.assets.push(imported.asset);
      result.masks.set(imported.asset.id, imported.mask);
      if (format === 'svg') {
        const found = svgWarnings(await blob.text());
        if (found.liveText) result.warnings.liveText.push(imported.asset.name);
        if (found.linkedImages) result.warnings.linkedImages.push(imported.asset.name);
      }
    }
    onProgress?.(++done, files.length);
  }
  return result;
}
