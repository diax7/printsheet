/**
 * Main-thread side of importing: hands files to the import worker one at a time and turns the
 * results into assets. One bad file never stops the others; each failure becomes a message.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ImportWorker from '@/image/import-worker?worker&inline';
import type { ImportRequest, ImportResponse } from '@/image/import-worker';
import type { ImageAsset } from '@/model/types';

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

function process(file: Blob, name: string): Promise<ImportResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, file, name } satisfies ImportRequest);
  });
}

/** A readable design name from a file name: no extension, no path. */
export function nameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExtension = base.replace(/\.[a-z0-9]{2,5}$/i, '');
  return (withoutExtension.trim() || 'Image').slice(0, 120);
}

export interface ImportResult {
  assets: ImageAsset[];
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
  const errors: string[] = [];
  let done = 0;
  for (const { blob, name } of files) {
    const response = await process(blob, name);
    if (response.ok) {
      assets.push({
        id: `img-${response.hash}`,
        name: nameFromFile(name),
        blob: response.blob,
        widthPx: response.widthPx,
        heightPx: response.heightPx,
        hasTransparency: response.hasTransparency,
      });
    } else {
      errors.push(response.message);
    }
    onProgress?.(++done, files.length);
  }
  return { assets, errors };
}
