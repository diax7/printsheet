/// <reference lib="webworker" />
/**
 * The import worker's side of Photoshop files. A PSD is read once when it is opened and kept
 * here, under a token, while the list of what to add is shown; each chosen row is then drawn
 * and imported like any image, and the file is dropped when the list is done.
 */
import { initializeCanvas, readPsd, type Psd } from 'ag-psd';
import { hasInk, psdRefusal, psdTree, type PsdNode } from '@/image/psd';
import { renderPsdNode } from '@/image/psd-render';

export type PsdRequest =
  | { id: number; kind: 'psd-open'; file: Blob; name: string }
  | { id: number; kind: 'psd-thumb'; token: number; node: string }
  | { id: number; kind: 'psd-take'; token: number; node: string; name: string }
  | { id: number; kind: 'psd-close'; token: number };

export type PsdOpened = {
  id: number;
  ok: true;
  token: number;
  nodes: PsdNode[];
  /** The whole image as Photoshop saved it, when the file has it ("Maximize Compatibility"). */
  whole: { widthPx: number; heightPx: number } | null;
};

export type PsdThumb = { id: number; ok: true; url: string | null };

const THUMB_SIDE = 112;
const open = new Map<number, Psd>();
let nextToken = 1;

// A worker has no document: ag-psd makes its pixel buffers and canvases this way instead.
initializeCanvas(
  (width, height) => new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
  (width, height) => new ImageData(width, height),
);

/**
 * True when the file holds the whole image as Photoshop drew it. Saved without "Maximize
 * Compatibility", a file still carries a placeholder image, and says so in its version info.
 */
function hasWholeImage(psd: Psd): boolean {
  return psd.imageResources?.versionInfo?.hasRealMergedData !== false && hasInk(psd.imageData);
}

/** Read a PSD: first without its pixels, to refuse what cannot be opened, then in full. */
export async function openPsd(file: Blob, name: string): Promise<Omit<PsdOpened, 'id' | 'ok'>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const options = {
    skipThumbnail: true,
    logMissingFeatures: false,
    throwForMissingFeatures: false,
  };
  let psd: Psd;
  try {
    const structure = readPsd(bytes, {
      ...options,
      skipLayerImageData: true,
      skipCompositeImageData: true,
    });
    const refusal = psdRefusal(structure);
    if (refusal) throw new Error(`"${name}": ${refusal}`);
    psd = readPsd(bytes, { ...options, useImageData: true });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`"${name}"`)) throw error;
    const reason =
      error instanceof RangeError
        ? 'it needs more memory than this browser has'
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`"${name}" could not be read as a Photoshop file (${reason}).`, {
      cause: error,
    });
  }
  const token = nextToken++;
  open.set(token, psd);
  return {
    token,
    nodes: psdTree(psd),
    whole: hasWholeImage(psd) ? { widthPx: psd.width, heightPx: psd.height } : null,
  };
}

function psdFor(token: number): Psd {
  const psd = open.get(token);
  if (!psd) throw new Error('The Photoshop file was closed before its layers were added.');
  return psd;
}

/** A small preview of a row, as a data URL, or null when it draws nothing. */
export async function psdThumb(token: number, node: string): Promise<string | null> {
  const drawn = renderPsdNode(psdFor(token), node);
  if (!drawn) return null;
  const scale = Math.min(1, THUMB_SIDE / Math.max(drawn.width, drawn.height));
  const thumb = new OffscreenCanvas(
    Math.max(1, Math.round(drawn.width * scale)),
    Math.max(1, Math.round(drawn.height * scale)),
  );
  thumb.getContext('2d')?.drawImage(drawn, 0, 0, thumb.width, thumb.height);
  return new FileReaderSync().readAsDataURL(await thumb.convertToBlob({ type: 'image/png' }));
}

/** A row drawn as a PNG, ready to import like any image. */
export async function psdTake(token: number, node: string, name: string): Promise<Blob> {
  const drawn = renderPsdNode(psdFor(token), node);
  if (!drawn) throw new Error(`"${name}" has nothing to print.`);
  return drawn.convertToBlob({ type: 'image/png' });
}

export function psdClose(token: number): void {
  open.delete(token);
}
