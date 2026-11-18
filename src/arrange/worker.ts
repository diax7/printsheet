/// <reference lib="webworker" />
/**
 * Arrange worker: the search for the shortest layout runs here, off the main thread, so the
 * editor stays responsive for the seconds it takes and Stop can simply end the worker. Loaded
 * as an inline classic worker, like the export worker.
 */
import { withSum, type MaskCells } from '@/model/mask';
import { smartArrange } from '@/model/smart-arrange';
import type { Sheet } from '@/model/types';

export interface ArrangeRequest {
  sheet: Sheet;
  /** The designs to move, or 'all'. */
  ids: string[] | 'all';
  allowRotate: boolean;
  /** Ink masks by asset id, for Real shape spacing. */
  masks: Array<[string, MaskCells]>;
  budgetMs: number;
  seed: number;
}

export type ArrangeMessage =
  /** `sheet` is the best layout so far when it changed since the last message. */
  | { type: 'progress'; passes: number; filmMm: number; sheet: Sheet | null }
  /** `sheet` is null when the layout on the sheet is already the best one found. */
  | { type: 'done'; sheet: Sheet | null }
  | { type: 'error'; message: string };

/** Least time between two progress messages: a search tries thousands of layouts a second. */
const REPORT_EVERY_MS = 100;

const post = (message: ArrangeMessage): void => self.postMessage(message);

function run(request: ArrangeRequest): void {
  const masks = new Map(request.masks.map(([id, cells]) => [id, withSum(cells)]));
  let lastReport = performance.now();
  let unsent: Sheet | null = null;
  const result = smartArrange(request.sheet, request.ids, {
    allowRotate: request.allowRotate,
    masks,
    budgetMs: request.budgetMs,
    seed: request.seed,
    onProgress: ({ passes, filmMm, sheet }) => {
      unsent = sheet ?? unsent;
      const now = performance.now();
      if (now - lastReport < REPORT_EVERY_MS) return;
      lastReport = now;
      post({ type: 'progress', passes, filmMm, sheet: unsent });
      unsent = null;
    },
  });
  post({ type: 'done', sheet: result === request.sheet ? null : result });
}

self.addEventListener('message', (event: MessageEvent<ArrangeRequest>) => {
  try {
    run(event.data);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
