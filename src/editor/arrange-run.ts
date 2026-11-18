/**
 * Running Arrange from the editor: the search takes a few seconds in a worker, so a dialog shows
 * how it is going, with a Stop button that keeps the best layout found so far. The result is one
 * commit (one undo step), and it is dropped when the sheet changed while the search ran.
 */
import { startArrange } from '@/arrange/client';
import type { MaskLoader } from '@/image/masks';
import { findIssues } from '@/model/checks';
import { filmLengthMm } from '@/model/pages';
import { DEFAULT_BUDGET_MS } from '@/model/smart-arrange';
import type { Design, Sheet } from '@/model/types';
import { byId, el, toast } from '@/editor/dom';
import type { Store } from '@/store/store';

export interface ArrangeDeps {
  store: Store;
  masks: MaskLoader;
  getAllowRotate(): boolean;
}

export interface ArrangeRunner {
  /** Arrange the given designs, or all of them. Does nothing while a run is going. */
  run(ids: readonly string[] | 'all'): Promise<void>;
}

/** A quick run should not flash a dialog: it only opens when the search takes this long. */
const DIALOG_AFTER_MS = 300;

const metres = (mm: number): string => `${(mm / 1000).toFixed(2)} m`;

interface Progress {
  dialog: HTMLDialogElement;
  status: HTMLElement;
  bar: HTMLProgressElement;
  stop: HTMLButtonElement;
}

function buildDialog(): Progress {
  const dialog = byId<HTMLDialogElement>('arrange-dialog');
  const status = el('p', { class: 'lead', id: 'arrange-status', role: 'status' });
  const bar = el('progress', { max: '1', value: '0' });
  const stop = el('button', {
    class: 'btn btn-outline',
    type: 'button',
    id: 'arrange-stop',
    text: 'Stop and use the best so far',
  });
  dialog.replaceChildren(
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'arrange-title', text: 'Arranging' }),
      status,
      bar,
    ),
    el('div', { class: 'dialog-actions' }, stop),
  );
  return { dialog, status, bar, stop };
}

/**
 * What Stop and Escape do. Before the worker starts (while the shapes are still being read)
 * there is no job to stop yet, so they only mark the run as stopped.
 */
interface Control {
  stop: (() => void) | null;
  stoppedEarly: boolean;
}

/** Problems that would spoil the print, counted on the designs Arrange moved. */
const SERIOUS = new Set(['too-close', 'outside', 'off-sheet']);

function seriousCount(sheet: Sheet, ids: ReadonlySet<string>, store: Store): number {
  const { assets, masks } = store.get();
  let count = 0;
  for (const [id, list] of findIssues(sheet, assets, masks)) {
    if (ids.has(id)) count += list.filter((i) => SERIOUS.has(i.kind)).length;
  }
  return count;
}

/**
 * True when the arranged sheet has more placement problems on the moved designs than the sheet
 * had before. The worker checks a finished search itself, but a result taken with Stop is the
 * best layout so far, never checked; this guards it on the main thread (one memoised check).
 */
function introducesProblems(sent: Sheet, next: Sheet, store: Store): boolean {
  const moved = new Set(next.designs.filter((d, i) => d !== sent.designs[i]).map((d) => d.id));
  if (moved.size === 0) return false;
  return seriousCount(next, moved, store) > seriousCount(sent, moved, store);
}

const samePlace = (a: Design, b: Design): boolean =>
  a.xMm === b.xMm && a.yMm === b.yMm && a.angleDeg === b.angleDeg;

/**
 * The arranged sheet as a change to the sheet that was sent: designs that did not move stay the
 * same objects, so the undo history shares them.
 */
function merged(sent: Sheet, arranged: Sheet): Sheet {
  const placed = new Map(arranged.designs.map((d) => [d.id, d]));
  return {
    ...sent,
    designs: sent.designs.map((d) => {
      const next = placed.get(d.id);
      if (!next || samePlace(d, next)) return d;
      return { ...d, xMm: next.xMm, yMm: next.yMm, angleDeg: next.angleDeg };
    }),
  };
}

/** Says what Arrange did to the film length. */
function report(sent: Sheet, next: Sheet): void {
  const before = filmLengthMm(sent);
  const after = filmLengthMm(next);
  const change = `${(Math.abs(before - after) / 10).toFixed(0)} cm`;
  if (after < before) {
    toast(`Arranged. The film is now ${metres(after)}, ${change} shorter.`);
  } else if (after > before) {
    // Arrange only lengthens a sheet to repair it; say so, or it looks like a bad result.
    const hint =
      sent.settings.spacing === 'box'
        ? ' To let designs sit in the empty corners of others, set "Gap measured between" to Real shapes.'
        : '';
    toast(
      `Arranged. The film is now ${metres(after)}, ${change} longer: some designs were closer than the cutting gap or off the sheet.${hint}`,
      'info',
      12000,
    );
  } else {
    toast(`Arranged. The film is ${metres(after)}.`);
  }
}

/** Stop and Escape work from the moment the dialog exists, also while shapes are read. */
function listen(ui: Progress, control: Control): void {
  const stop = (): void => {
    if (control.stop) control.stop();
    else control.stoppedEarly = true;
  };
  ui.stop.addEventListener('click', stop, { once: true });
  ui.dialog.addEventListener('cancel', (event) => {
    // Escape would close the dialog and leave the run going unseen; here it means Stop.
    event.preventDefault();
    stop();
  });
}

export function mountArrange(deps: ArrangeDeps): ArrangeRunner {
  const { store } = deps;
  let running = false;

  async function search(
    sent: Sheet,
    ids: readonly string[] | 'all',
    ui: Progress,
    control: Control,
  ): Promise<Sheet | null | 'stopped'> {
    const shape = sent.settings.spacing === 'shape';
    if (shape) {
      ui.status.textContent = 'Reading the shapes of the designs…';
      await deps.masks.ready();
    }
    if (control.stoppedEarly) return 'stopped';
    const used = new Set(sent.designs.map((d) => d.assetId));
    const masks = shape ? [...store.get().masks].filter(([id]) => used.has(id)) : [];
    const startedAt = performance.now();
    const job = startArrange(
      {
        sheet: sent,
        ids: ids === 'all' ? 'all' : [...ids],
        allowRotate: deps.getAllowRotate(),
        masks: masks.map(([id, m]) => [id, { cols: m.cols, rows: m.rows, cells: m.cells }]),
        budgetMs: DEFAULT_BUDGET_MS,
        seed: Math.floor(Math.random() * 2 ** 31),
      },
      (passes, filmMm) => {
        ui.status.textContent = `Tried ${passes} layouts. Shortest so far: ${metres(filmMm)}.`;
        ui.bar.value = Math.min(1, (performance.now() - startedAt) / DEFAULT_BUDGET_MS);
      },
    );
    control.stop = job.stop;
    ui.status.textContent = 'Trying layouts…';
    return job.result;
  }

  /** Applies a finished search, or says why nothing moved. */
  function apply(sent: Sheet, arranged: Sheet | null | 'stopped'): void {
    if (store.get().sheet !== sent) {
      toast('The sheet changed while Arrange was working, so nothing was moved.', 'error');
      return;
    }
    if (arranged === 'stopped') {
      toast('Arrange stopped, so nothing was moved.');
      return;
    }
    if (!arranged) {
      toast(`Arranged. No shorter layout was found: the film stays ${metres(filmLengthMm(sent))}.`);
      return;
    }
    const next = merged(sent, arranged);
    if (introducesProblems(sent, next, store)) {
      toast('Arrange stopped before a safe layout was ready, so nothing was moved.', 'error');
      return;
    }
    store.commit(next);
    report(sent, next);
  }

  async function run(ids: readonly string[] | 'all'): Promise<void> {
    if (running) {
      toast('Arrange is already running.');
      return;
    }
    running = true;
    const sent = store.get().sheet;
    const ui = buildDialog();
    const control: Control = { stop: null, stoppedEarly: false };
    listen(ui, control);
    const opening = window.setTimeout(() => ui.dialog.showModal(), DIALOG_AFTER_MS);
    try {
      apply(sent, await search(sent, ids, ui, control));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      window.clearTimeout(opening);
      if (ui.dialog.open) ui.dialog.close();
      running = false;
    }
  }

  return { run };
}
