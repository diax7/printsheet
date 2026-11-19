/**
 * Main-thread side of importing: hands files to the import worker one at a time and turns the
 * results into assets. One bad file never stops the others; each failure becomes a message.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ImportWorker from '@/image/import-worker?worker&inline';
import type { ImportRequest, ImportResponse } from '@/image/import-worker';
import { withSum, type ShapeMask } from '@/model/mask';
import type { FileFormat, ImageAsset, VectorSource } from '@/model/types';
import { formatCm } from '@/model/units';
import { detectFormat, FORMAT_HEAD_BYTES } from '@/image/format';
import { sha256 } from '@/image/hash';
import { openPdf, type PdfFile } from '@/vector/pdf';
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
  /**
   * Vector designs that may not print as designed: live text (SVG), images linked by path (SVG),
   * or fonts the file does not carry (PDF).
   */
  warnings: { liveText: string[]; linkedImages: string[]; missingFonts: string[] };
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
  return trimVector(png, name, {
    name: nameFromFile(name),
    format: 'svg',
    type: 'svg',
    source: blob,
    sourceId: await sha256(blob),
    page: 1,
    pageMm: { w: size.widthMm, h: size.heightMm },
  });
}

/** What a vector's base render becomes once trimmed: where it came from and its page's size. */
interface VectorOrigin {
  name: string;
  format: 'svg' | 'pdf' | 'ai';
  type: VectorSource['type'];
  source: Blob;
  sourceId: string;
  page: number;
  pageMm: { w: number; h: number };
}

/**
 * Trim and mask a vector's base render in the worker, and keep the trimmed box as a crop of the
 * page, so every later drawing is of the inked area only.
 */
async function trimVector(png: Blob, fileName: string, origin: VectorOrigin): Promise<Imported> {
  const response = await process(png, fileName);
  if (!response.ok) return { error: response.message };
  if ('maskOnly' in response) return { error: 'The image reader answered the wrong question.' };
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
      id: `vec-${origin.sourceId}-p${origin.page}`,
      name: origin.name,
      blob: response.blob,
      widthPx: response.widthPx,
      heightPx: response.heightPx,
      hasTransparency: response.hasTransparency,
      format: origin.format,
      vector: {
        type: origin.type,
        sourceId: origin.sourceId,
        blob: new Blob([origin.source], { type: SOURCE_TYPE[origin.type] }),
        page: origin.page,
        crop,
        sizeMm: { w: origin.pageMm.w * crop.w, h: origin.pageMm.h * crop.h },
      },
    },
  };
}

const SOURCE_TYPE: Record<VectorSource['type'], string> = {
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};
const FULL_PAGE = { x: 0, y: 0, w: 1, h: 1 };
const THUMB_SIDE = 112;
const NO_PDF_CONTENT_MESSAGE =
  'This Illustrator file was saved without PDF content. In Illustrator, save it with "Create PDF Compatible File" ticked, or as SVG or PDF.';

/** One page of a PDF or Illustrator file as a vector design; `missingFonts` asks for a warning. */
async function importPdfPage(
  file: PdfFile,
  page: number,
  fileName: string,
  origin: Omit<VectorOrigin, 'page' | 'pageMm' | 'name'>,
): Promise<Imported & { missingFonts?: boolean }> {
  const size = await file.pageSize(page);
  const base = baseRenderSize(size.widthMm, size.heightMm);
  let png: Blob;
  try {
    png = await canvasToPng(await file.render(page, FULL_PAGE, base.widthPx, base.heightPx));
  } catch (error) {
    if (error instanceof BlankRenderError)
      return {
        error: `Page ${page} of "${fileName}" came out empty, so there is nothing to print.`,
      };
    return { error: messageOf(error) };
  }
  const name =
    file.pageCount > 1 ? `${nameFromFile(fileName)} - page ${page}` : nameFromFile(fileName);
  const imported = await trimVector(png, fileName, {
    ...origin,
    name,
    page,
    pageMm: { w: size.widthMm, h: size.heightMm },
  });
  return 'error' in imported
    ? imported
    : { ...imported, missingFonts: await file.hasMissingFonts(page) };
}

/** The picker rows for a PDF's pages, each with a small preview drawn when shown. */
async function pageItems(file: PdfFile): Promise<PickItem[]> {
  const items: PickItem[] = [];
  for (let page = 1; page <= file.pageCount; page++) {
    const size = await file.pageSize(page);
    const scale = THUMB_SIDE / Math.max(size.widthMm, size.heightMm);
    items.push({
      id: String(page),
      label: `Page ${page}`,
      detail: `${formatCm(size.widthMm)} × ${formatCm(size.heightMm)} cm`,
      checked: true,
      thumb: async () => {
        const canvas = await file.render(
          page,
          FULL_PAGE,
          Math.max(1, Math.round(size.widthMm * scale)),
          Math.max(1, Math.round(size.heightMm * scale)),
        );
        return canvas.toDataURL('image/png');
      },
    });
  }
  return items;
}

/**
 * A PDF or a PDF-compatible Illustrator file: each chosen page becomes a vector design. A file
 * with several pages asks which ones through `pick`; without `pick` every page is added.
 */
async function importPdf(
  blob: Blob,
  name: string,
  format: 'pdf' | 'ai',
  options: ImportOptions,
): Promise<Array<Imported & { missingFonts?: boolean }>> {
  let file: PdfFile;
  try {
    file = await openPdf(blob, name);
  } catch (error) {
    return [{ error: messageOf(error) }];
  }
  try {
    if (format === 'ai' && (await file.isIllustratorPlaceholder()))
      return [{ error: `"${name}": ${NO_PDF_CONTENT_MESSAGE}` }];
    let pages = Array.from({ length: file.pageCount }, (_, i) => i + 1);
    if (pages.length > 1 && options.pick) {
      const chosen = await options.pick(
        `Add pages from "${nameFromFile(name)}"`,
        'Each page you tick becomes its own design.',
        await pageItems(file),
      );
      if (!chosen) return [];
      pages = chosen.map(Number);
    }
    const origin = { format, type: 'pdf' as const, source: blob, sourceId: await sha256(blob) };
    const results: Array<Imported & { missingFonts?: boolean }> = [];
    for (const page of pages) results.push(await importPdfPage(file, page, name, origin));
    return results;
  } finally {
    await file.close();
  }
}

/** A row in the "choose what to add" list (shown by the editor, so this code stays UI-free). */
export interface PickItem {
  id: string;
  label: string;
  /** A short second line, such as the size. */
  detail: string;
  /** A note shown under the row, such as what will be left out. */
  note?: string;
  checked: boolean;
  /** Draws the row's preview, as an image URL. */
  thumb?: () => Promise<string>;
}

export interface ImportOptions {
  /**
   * Asks which of a file's pages to add, for a file with several. Resolves with the ticked ids,
   * or null to add nothing from that file.
   */
  pick?: (title: string, lead: string, items: PickItem[]) => Promise<string[] | null>;
}

/** The designs one file becomes: one image, one SVG, or the chosen pages of a PDF. */
async function importOne(
  blob: Blob,
  name: string,
  options: ImportOptions,
): Promise<Array<Imported & { missingFonts?: boolean }>> {
  const format = detectFormat(
    new Uint8Array(await blob.slice(0, FORMAT_HEAD_BYTES).arrayBuffer()),
    name,
  );
  if (typeof format === 'object') return [{ error: `"${name}": ${format.refuse}` }];
  if (format === 'svg') return [await importSvg(blob, name)];
  if (format === 'pdf' || format === 'ai') return importPdf(blob, name, format, options);
  return [await importRaster(blob, name, format)];
}

/**
 * Import files in order. Identical images (same trimmed pixels) share one asset id, so the PDF
 * embeds them once; so do identical vector files.
 */
export async function importFiles(
  files: ReadonlyArray<{ blob: Blob; name: string }>,
  onProgress?: (done: number, total: number) => void,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const result: ImportResult = {
    assets: [],
    masks: new Map(),
    errors: [],
    warnings: { liveText: [], linkedImages: [], missingFonts: [] },
  };
  let done = 0;
  for (const { blob, name } of files) {
    for (const imported of await importOne(blob, name, options)) {
      if ('error' in imported) {
        result.errors.push(imported.error);
        continue;
      }
      result.assets.push(imported.asset);
      result.masks.set(imported.asset.id, imported.mask);
      if (imported.missingFonts) result.warnings.missingFonts.push(imported.asset.name);
      if (imported.asset.format === 'svg') {
        const found = svgWarnings(await blob.text());
        if (found.liveText) result.warnings.liveText.push(imported.asset.name);
        if (found.linkedImages) result.warnings.linkedImages.push(imported.asset.name);
      }
    }
    onProgress?.(++done, files.length);
  }
  return result;
}
