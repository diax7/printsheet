/**
 * Main-thread side of importing: hands files to the import worker one at a time and turns the
 * results into assets. One bad file never stops the others; each failure becomes a message.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ImportWorker from '@/image/import-worker?worker&inline';
import type { ImportRequest, ImportResponse } from '@/image/import-worker';
import { withSum, type ShapeMask } from '@/model/mask';
import type { ImageAsset } from '@/model/types';
import { detectFormat, FORMAT_HEAD_BYTES, type FileFormat } from '@/image/format';

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
}

/**
 * Import files in order. Identical images (same trimmed pixels) share one asset id, so the PDF
 * embeds them once.
 */
export async function importFiles(
  files: ReadonlyArray<{ blob: Blob; name: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const assets: ImageAsset[] = [];
  const masks = new Map<string, ShapeMask>();
  const errors: string[] = [];
  let done = 0;
  for (const { blob, name } of files) {
    const format = detectFormat(
      new Uint8Array(await blob.slice(0, FORMAT_HEAD_BYTES).arrayBuffer()),
      name,
    );
    if (typeof format === 'object') {
      errors.push(`"${name}": ${format.refuse}`);
      onProgress?.(++done, files.length);
      continue;
    }
    const response = await process(blob, name);
    if (response.ok && !('maskOnly' in response)) {
      masks.set(`img-${response.hash}`, withSum(response.mask));
      assets.push({
        id: `img-${response.hash}`,
        name: nameFromFile(name),
        blob: response.blob,
        widthPx: response.widthPx,
        heightPx: response.heightPx,
        hasTransparency: response.hasTransparency,
        ...badge(format),
      });
    } else if (!response.ok) {
      errors.push(response.message);
    }
    onProgress?.(++done, files.length);
  }
  return { assets, masks, errors };
}
