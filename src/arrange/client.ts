/**
 * Main-thread side of Arrange: one worker per run, so stopping is just ending it. A stopped run
 * still gives the best layout it had reported.
 */
// oxlint-disable-next-line import/default -- Vite's ?worker import is a virtual module with a default export.
import ArrangeWorker from '@/arrange/worker?worker&inline';
import type { ArrangeMessage, ArrangeRequest } from '@/arrange/worker';
import type { Sheet } from '@/model/types';

export interface RunningArrange {
  /** The arranged sheet, or null when the layout on the sheet is already the best one found. */
  result: Promise<Sheet | null>;
  /** Ends the search now; `result` resolves with the best layout reported so far. */
  stop(): void;
}

export function startArrange(
  request: ArrangeRequest,
  onProgress: (passes: number, filmMm: number) => void,
): RunningArrange {
  const worker = new ArrangeWorker();
  let best: Sheet | null = null;
  let settle: { resolve: (sheet: Sheet | null) => void; reject: (e: Error) => void } | null = null;
  const result = new Promise<Sheet | null>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (outcome: Sheet | null | Error): void => {
    if (!settle) return;
    const s = settle;
    settle = null;
    worker.terminate();
    if (outcome instanceof Error) s.reject(outcome);
    else s.resolve(outcome);
  };
  worker.addEventListener('message', (event: MessageEvent<ArrangeMessage>) => {
    const message = event.data;
    if (message.type === 'progress') {
      best = message.sheet ?? best;
      onProgress(message.passes, message.filmMm);
    } else if (message.type === 'done') finish(message.sheet);
    else finish(new Error(message.message));
  });
  // An error event from a failed worker can carry no message at all.
  worker.addEventListener('error', (event) =>
    finish(new Error(`Arrange stopped unexpectedly${event.message ? `: ${event.message}` : ''}.`)),
  );
  worker.addEventListener('messageerror', () =>
    finish(new Error('Arrange could not send its result back. Try again.')),
  );
  worker.postMessage(request);
  return { result, stop: () => finish(best) };
}
