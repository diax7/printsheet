/**
 * Sheet layout controls: one long sheet or split into sheets, the sheet length and the last
 * sheet. Switching layout or length moves the designs (model/pages) in the same commit as the
 * settings, so one undo puts everything back.
 */
import { footprint } from '@/model/geometry';
import { changePageLength, offSheetReason, toSingle, toSplit } from '@/model/pages';
import { formatCm } from '@/model/units';
import { MAX_SHEET_LENGTH_MM, MIN_PAGE_LENGTH_MM, type Sheet } from '@/model/types';
import { bindNumber, byId, setInputValue } from '@/editor/dom';
import type { Store } from '@/store/store';

export interface LayoutHandlers {
  /** Designs that now cross a split, so the app can offer to move them onto a sheet. */
  onCrossing(ids: string[]): void;
}

function crossingIds(sheet: Sheet): string[] {
  if (sheet.settings.layout !== 'split') return [];
  return sheet.designs
    .filter((d) => offSheetReason(d, sheet.settings) === 'crossing')
    .map((d) => d.id);
}

function setChecked(buttons: readonly HTMLButtonElement[], key: string, value: string): void {
  for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset[key] === value));
}

export function mountLayoutControls(store: Store, handlers: LayoutHandlers): { render(): void } {
  const layoutButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-layout]')];
  const lastButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-last-page]')];
  const lengthModeField = byId('length-mode-field');
  const fixedField = byId('fixed-length-field');
  const splitFields = byId('split-fields');
  const pageLength = byId<HTMLInputElement>('page-length');
  const hint = byId('page-length-hint');

  const commitMoved = (next: Sheet): void => {
    store.commit(next);
    const crossing = crossingIds(next);
    if (crossing.length > 0) handlers.onCrossing(crossing);
  };

  for (const button of layoutButtons) {
    button.addEventListener('click', () => {
      const sheet = store.get().sheet;
      const layout = button.dataset['layout'] === 'split' ? 'split' : 'single';
      if (layout === sheet.settings.layout) return;
      commitMoved(
        layout === 'split' ? toSplit(sheet, sheet.settings.pageLengthMm) : toSingle(sheet),
      );
    });
  }
  bindNumber(pageLength, MIN_PAGE_LENGTH_MM / 10, MAX_SHEET_LENGTH_MM / 10, (cm) => {
    const sheet = store.get().sheet;
    const mm = Math.round(cm * 100) / 10;
    if (mm !== sheet.settings.pageLengthMm) commitMoved(changePageLength(sheet, mm));
  });
  for (const button of lastButtons) {
    button.addEventListener('click', () => {
      const sheet = store.get().sheet;
      const lastPage = button.dataset['lastPage'] === 'full' ? 'full' : 'trim';
      if (lastPage === sheet.settings.lastPage) return;
      store.commit({ ...sheet, settings: { ...sheet.settings, lastPage } });
    });
  }

  function render(): void {
    const { sheet } = store.get();
    const s = sheet.settings;
    const split = s.layout === 'split';
    setChecked(layoutButtons, 'layout', s.layout);
    setChecked(lastButtons, 'lastPage', s.lastPage);
    // Auto or Fixed length belongs to one long sheet; a split job has a sheet length instead.
    lengthModeField.hidden = split;
    fixedField.hidden = split || s.lengthMode !== 'fixed';
    splitFields.hidden = !split;
    setInputValue(pageLength, formatCm(s.pageLengthMm));
    const tallest = Math.max(0, ...sheet.designs.map((d) => footprint(d).maxY - footprint(d).minY));
    const tooShort = split && tallest > s.pageLengthMm + 0.01;
    hint.hidden = !tooShort;
    hint.textContent = tooShort
      ? `Your tallest design is ${formatCm(tallest)} cm, longer than one sheet.`
      : '';
  }

  return { render };
}
