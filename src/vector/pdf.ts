/**
 * Reading and drawing PDF pages (and Illustrator files saved with PDF content) with pdf.js.
 *
 * pdf.js loads on first use, so opening the app does not pay for it. It runs with no network:
 * no font, character map or WebAssembly downloads (the page's security policy allows none), so
 * fonts a PDF does not embed are replaced by system fonts, and `stopAtErrors` turns any part of a
 * page pdf.js cannot draw into an error instead of a page with a hole in it.
 */
import { clearFaintPixels } from '@/image/trim';
import { MAX_IMPORT_SIDE } from '@/image/limits';
import { BlankRenderError } from '@/vector/svg';
import type { Crop } from '@/model/types';

type PdfJs = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

const MM_PER_POINT = 25.4 / 72;
/** The sentence Illustrator writes on the only page of a file saved without PDF content. */
const NO_PDF_CONTENT = /saved without PDF Content/i;

let engine: Promise<PdfJs> | null = null;

/** pdf.js, loaded once, with its worker started from the inlined copy. */
function pdfjs(): Promise<PdfJs> {
  engine ??= (async () => {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('@/vector/pdf-worker?worker&inline'),
    ]);
    lib.GlobalWorkerOptions.workerPort = new worker.default();
    return lib;
  })();
  engine.catch(() => {
    engine = null;
  });
  return engine;
}

export interface PdfFile {
  pageCount: number;
  /** The page's print size, after its rotation and user unit. */
  pageSize(page: number): Promise<{ widthMm: number; heightMm: number }>;
  /** Draw `crop` of a page at an exact pixel size, haze cleared, transparent where it is empty. */
  render(page: number, crop: Crop, widthPx: number, heightPx: number): Promise<HTMLCanvasElement>;
  /** True when this is an Illustrator file saved without PDF content (a placeholder page). */
  isIllustratorPlaceholder(): Promise<boolean>;
  /** True when a page drawn earlier uses a font the file does not carry (a system font stood in). */
  hasMissingFonts(page: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Open a PDF, or throw a message that says what to do instead. */
export async function openPdf(blob: Blob, name: string): Promise<PdfFile> {
  const lib = await pdfjs();
  let doc: PdfDocument;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
      useSystemFonts: true,
      useWasm: false,
      stopAtErrors: true,
    }).promise;
  } catch (error) {
    if (error instanceof lib.PasswordException) {
      throw new Error(
        `"${name}" is protected by a password. Save a copy without the password and add it again.`,
        { cause: error },
      );
    }
    throw new Error(`"${name}" could not be read as a PDF.`, { cause: error });
  }
  return pdfFile(lib, doc, name);
}

function pdfFile(lib: PdfJs, doc: PdfDocument, name: string): PdfFile {
  return {
    pageCount: doc.numPages,

    async pageSize(page) {
      const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
      return { widthMm: viewport.width * MM_PER_POINT, heightMm: viewport.height * MM_PER_POINT };
    },

    async render(page, crop, widthPx, heightPx) {
      if (widthPx > MAX_IMPORT_SIDE || heightPx > MAX_IMPORT_SIDE) {
        throw new Error(`"${name}" cannot be drawn this large (${widthPx} × ${heightPx} px).`);
      }
      const proxy = await doc.getPage(page);
      const viewport = proxy.getViewport({ scale: 1 });
      // Stretch the crop to the exact size wanted, on each axis.
      const sx = widthPx / (crop.w * viewport.width);
      const sy = heightPx / (crop.h * viewport.height);
      const canvas = document.createElement('canvas');
      canvas.width = widthPx;
      canvas.height = heightPx;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('This browser cannot draw images here.');
      try {
        await proxy.render({
          canvas,
          canvasContext: ctx,
          viewport,
          intent: 'print',
          background: 'rgba(0,0,0,0)',
          transform: [sx, 0, 0, sy, -crop.x * viewport.width * sx, -crop.y * viewport.height * sy],
          optionalContentConfigPromise: doc.getOptionalContentConfig({ intent: 'print' }),
        }).promise;
      } catch (error) {
        throw new Error(
          `Page ${page} of "${name}" could not be drawn completely: ${error instanceof Error ? error.message : String(error)}.`,
          { cause: error },
        );
      }
      const pixels = ctx.getImageData(0, 0, widthPx, heightPx);
      clearFaintPixels(pixels.data);
      if (!pixels.data.some((v, i) => i % 4 === 3 && v > 0)) throw new BlankRenderError(name);
      ctx.putImageData(pixels, 0, 0);
      return canvas;
    },

    async isIllustratorPlaceholder() {
      const text = await (await doc.getPage(1)).getTextContent();
      return text.items.some((item) => 'str' in item && NO_PDF_CONTENT.test(item.str));
    },

    async hasMissingFonts(page) {
      const proxy = await doc.getPage(page);
      const { fnArray, argsArray } = await proxy.getOperatorList({ intent: 'print' });
      const names = new Set<string>();
      fnArray.forEach((fn, i) => {
        const fontName: unknown = (argsArray[i] as unknown[] | undefined)?.[0];
        if (fn === lib.OPS.setFont && typeof fontName === 'string') names.add(fontName);
      });
      // A font is loaded once the page has been drawn; one that is not is skipped, not guessed.
      return [...names].some((fontName) => {
        try {
          return Boolean((proxy.commonObjs.get(fontName) as { missingFile?: unknown }).missingFile);
        } catch {
          return false;
        }
      });
    },

    close: () => doc.loadingTask.destroy(),
  };
}
