/**
 * Left panel: the film length (the number that costs money), the sheet settings with width
 * presets, and the list of every design with its size, sharpness and warnings.
 */
import { findIssues, type Issue } from '@/model/checks';
import { dpiLevel, effectiveDpi, sheetLengthMm, contentLengthMm } from '@/model/geometry';
import { formatCm } from '@/model/units';
import {
  MAX_SHEET_LENGTH_MM,
  MAX_WIDTH_MM,
  MIN_WIDTH_MM,
  type Design,
  type ImageAsset,
  type Settings,
} from '@/model/types';
import { readyPreview } from '@/image/previews';
import { byId, el, icon, readNumber, setInputValue } from '@/editor/dom';
import { allPresets, type Prefs } from '@/prefs';
import type { AppState, Store } from '@/store/store';

export const ISSUE_TEXT: Record<Issue['kind'], string> = {
  'low-dpi': 'Too blurry at this size (under 150 DPI). Make it smaller or use a bigger image.',
  'ok-dpi': 'Acceptable sharpness (150 to 299 DPI). 300 DPI or more looks best.',
  'no-transparency': 'No transparent background: it will print as a solid rectangle.',
  outside: 'Goes past the edge of the sheet and would be cut off.',
  'too-close': 'Closer than the cutting gap to another design.',
  'past-length': 'Goes past the fixed sheet length.',
};

export function isSerious(kind: Issue['kind']): boolean {
  return kind === 'low-dpi' || kind === 'outside' || kind === 'past-length';
}

export interface PanelHandlers {
  onPresetMenu(): void;
}

/** Commit a typed number when it is in range; mark the field invalid otherwise. */
function bindNumber(
  input: HTMLInputElement,
  min: number,
  max: number,
  apply: (value: number) => void,
): void {
  input.addEventListener('change', () => {
    const value = readNumber(input);
    if (value === null || value < min || value > max) {
      input.setAttribute('aria-invalid', 'true');
      input.title = `Enter a number from ${min} to ${max}`;
      return;
    }
    input.removeAttribute('aria-invalid');
    input.title = '';
    apply(value);
  });
}

function renderRow(
  d: Design,
  asset: ImageAsset | undefined,
  issues: Issue[],
  selected: boolean,
): HTMLLIElement {
  const preview = readyPreview(d.assetId);
  const thumb = preview
    ? el('img', { class: 'thumb', src: preview.thumbUrl, alt: '' })
    : el('span', { class: 'thumb' });
  const flags = el('span', { class: 'design-flags' });
  if (asset) {
    const level = dpiLevel(effectiveDpi(d, asset));
    flags.append(
      el('span', {
        class: `dpi dpi-${level}`,
        text: `${Math.round(effectiveDpi(d, asset))} DPI`,
        title: level === 'good' ? 'Sharp' : ISSUE_TEXT[level === 'ok' ? 'ok-dpi' : 'low-dpi'],
      }),
    );
  }
  const warnings = issues.filter((i) => i.kind !== 'ok-dpi' && i.kind !== 'low-dpi');
  if (warnings.length) {
    const serious = warnings.some((i) => isSerious(i.kind));
    const flag = el(
      'span',
      {
        class: `flag${serious ? ' danger' : ''}`,
        title: [...new Set(warnings.map((w) => ISSUE_TEXT[w.kind]))].join('\n'),
      },
      icon('warning'),
    );
    flags.append(flag);
  }
  return el(
    'li',
    {
      class: 'design-item',
      role: 'option',
      'aria-selected': selected ? 'true' : 'false',
      tabindex: 0,
      'data-id': d.id,
    },
    thumb,
    el(
      'div',
      {},
      el('div', { class: 'design-name', text: d.name }),
      el('div', {
        class: 'design-meta',
        text: `${formatCm(d.widthMm)} × ${formatCm(d.heightMm)} cm${d.locked ? ', locked' : ''}`,
      }),
    ),
    flags,
  );
}

export function mountPanel(
  store: Store,
  getPrefs: () => Prefs,
  handlers: PanelHandlers,
): { render(): void } {
  const meters = byId('film-meters');
  const size = byId('film-size');
  const counts = byId('film-counts');
  const preset = byId<HTMLSelectElement>('preset');
  const width = byId<HTMLInputElement>('sheet-width');
  const gap = byId<HTMLInputElement>('gap');
  const fixedField = byId('fixed-length-field');
  const fixedLength = byId<HTMLInputElement>('fixed-length');
  const lengthButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-length]')];
  const list = byId<HTMLUListElement>('design-list');
  const designCount = byId('design-count');

  const setSettings = (patch: Partial<Settings>): void => {
    const sheet = store.get().sheet;
    store.commit({ ...sheet, settings: { ...sheet.settings, ...patch } });
  };

  bindNumber(width, MIN_WIDTH_MM / 10, MAX_WIDTH_MM / 10, (cm) =>
    setSettings({ sheetWidthMm: Math.round(cm * 10 * 10) / 10 }),
  );
  bindNumber(gap, 0, 100, (mm) => setSettings({ gapMm: mm }));
  bindNumber(fixedLength, 1, MAX_SHEET_LENGTH_MM / 10, (cm) =>
    setSettings({ fixedLengthMm: cm * 10 }),
  );
  preset.addEventListener('change', () => {
    const chosen = allPresets(getPrefs()).find((p) => p.id === preset.value);
    if (chosen) setSettings({ sheetWidthMm: chosen.widthMm });
  });
  byId('preset-menu').addEventListener('click', handlers.onPresetMenu);
  for (const button of lengthButtons) {
    button.addEventListener('click', () => {
      const mode = button.dataset['length'] === 'fixed' ? 'fixed' : 'auto';
      const sheet = store.get().sheet;
      // Switching to Fixed starts from the current content length, rounded up to 10 cm.
      const fixed =
        mode === 'fixed' && sheet.settings.lengthMode === 'auto'
          ? Math.max(100, Math.ceil(contentLengthMm(sheet.designs) / 100) * 100)
          : sheet.settings.fixedLengthMm;
      setSettings({ lengthMode: mode, fixedLengthMm: Math.min(fixed, MAX_SHEET_LENGTH_MM) });
    });
  }

  list.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    const id = row?.dataset['id'];
    if (!id) return;
    const current = store.get().selection;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      store.setSelection(current.includes(id) ? current.filter((s) => s !== id) : [...current, id]);
    } else {
      store.setSelection([id]);
    }
  });
  list.addEventListener('keydown', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      store.setSelection([row.dataset['id'] ?? '']);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      (next as HTMLElement | null)?.focus();
    }
  });

  let lastListKey = '';

  function render(): void {
    const state: AppState = store.get();
    const { sheet, assets, selection } = state;
    const { settings } = sheet;
    const issues = findIssues(sheet, assets);
    const length = sheet.designs.length ? sheetLengthMm(sheet) : 0;

    meters.textContent = (length / 1000).toFixed(2);
    size.textContent = `${formatCm(settings.sheetWidthMm)} × ${formatCm(length)} cm`;
    const serious = [...issues.values()].filter((found) =>
      found.some((i) => isSerious(i.kind)),
    ).length;
    const warned = [...issues.values()].filter((found) =>
      found.some((i) => !isSerious(i.kind) && i.kind !== 'ok-dpi'),
    ).length;
    counts.replaceChildren(
      sheet.designs.length === 0
        ? 'No designs yet'
        : `${sheet.designs.length} design${sheet.designs.length === 1 ? '' : 's'}`,
      ...(serious
        ? [
            ', ',
            el('span', {
              class: 'danger',
              text: `${serious} need${serious === 1 ? 's' : ''} attention`,
            }),
          ]
        : []),
      ...(warned ? [', ', el('span', { class: 'warn', text: `${warned} with warnings` })] : []),
    );

    const presets = allPresets(getPrefs());
    const match = presets.find((p) => Math.abs(p.widthMm - settings.sheetWidthMm) < 0.05);
    const options = [
      ...presets.map((p) => [p.id, `${p.name} (${formatCm(p.widthMm)} cm)`]),
      ['custom', 'Custom width'],
    ];
    if (
      preset.options.length !== options.length ||
      [...preset.options].some((o, i) => o.textContent !== options[i]?.[1])
    ) {
      preset.replaceChildren(
        ...options.map(([value, label]) => el('option', { value: value ?? '', text: label ?? '' })),
      );
    }
    preset.value = match?.id ?? 'custom';
    setInputValue(width, formatCm(settings.sheetWidthMm));
    setInputValue(gap, String(settings.gapMm));
    setInputValue(fixedLength, formatCm(settings.fixedLengthMm));
    fixedField.hidden = settings.lengthMode !== 'fixed';
    for (const button of lengthButtons) {
      button.setAttribute('aria-checked', String(button.dataset['length'] === settings.lengthMode));
    }

    designCount.textContent = String(sheet.designs.length);
    const listKey = JSON.stringify([sheet.designs, selection, [...issues], [...assets.keys()]]);
    if (listKey === lastListKey) return;
    lastListKey = listKey;
    const focusedId = (document.activeElement as HTMLElement | null)
      ?.closest?.('[data-id]')
      ?.getAttribute('data-id');
    const selected = new Set(selection);
    // Top of the stack first, like layers in a design tool.
    const rows = sheet.designs
      .toReversed()
      .map((d) => renderRow(d, assets.get(d.assetId), issues.get(d.id) ?? [], selected.has(d.id)));
    list.replaceChildren(
      ...(rows.length
        ? rows
        : [el('li', { class: 'list-empty', text: 'Designs you add appear here.' })]),
    );
    if (focusedId) list.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  return { render };
}
