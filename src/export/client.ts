/**
 * Main-thread side of exporting: one worker per export, so cancelling is just terminating it.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ExportWorker from '@/export/worker?worker&inline';
import type { ExportMessage, ExportRequest } from '@/export/worker';

export interface RunningExport {
  result: Promise<Blob>;
  cancel(): void;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

export function startExport(
  request: ExportRequest,
  onProgress: (done: number, total: number, stage: string) => void,
): RunningExport {
  const worker = new ExportWorker();
  let settle: { resolve: (b: Blob) => void; reject: (e: Error) => void } | null = null;
  const result = new Promise<Blob>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (outcome: Blob | Error): void => {
    if (!settle) return;
    const s = settle;
    settle = null;
    worker.terminate();
    if (outcome instanceof Blob) s.resolve(outcome);
    else s.reject(outcome);
  };
  worker.addEventListener('message', (event: MessageEvent<ExportMessage>) => {
    const message = event.data;
    if (message.type === 'progress') onProgress(message.done, message.total, message.stage);
    else if (message.type === 'done') finish(message.blob);
    else finish(new Error(message.message));
  });
  // An error event from a failed worker can carry no message at all.
  worker.addEventListener('error', (event) =>
    finish(
      new Error(
        `The export stopped unexpectedly${event.message ? `: ${event.message}` : ''}. Try again, or try a lower resolution.`,
      ),
    ),
  );
  worker.addEventListener('messageerror', () =>
    finish(new Error('The export could not send its result back. Try again.')),
  );
  worker.postMessage(request);
  return { result, cancel: () => finish(new ExportCancelled()) };
}

/** Save a blob as a download with the given file name. */
export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
