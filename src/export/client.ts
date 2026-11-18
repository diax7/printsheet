/**
 * Main-thread side of exporting: one worker per export, so cancelling is just terminating it.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ExportWorker from '@/export/worker?worker&inline';
import type { ExportFile, ExportMessage, ExportRequest } from '@/export/worker';

export interface RunningExport {
  /** The finished files: one, or one per sheet when separate files were chosen. */
  result: Promise<ExportFile[]>;
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
  let settle: { resolve: (f: ExportFile[]) => void; reject: (e: Error) => void } | null = null;
  const result = new Promise<ExportFile[]>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (outcome: ExportFile[] | Error): void => {
    if (!settle) return;
    const s = settle;
    settle = null;
    worker.terminate();
    if (outcome instanceof Error) s.reject(outcome);
    else s.resolve(outcome);
  };
  worker.addEventListener('message', (event: MessageEvent<ExportMessage>) => {
    const message = event.data;
    if (message.type === 'progress') onProgress(message.done, message.total, message.stage);
    else if (message.type === 'done') finish(message.files);
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
