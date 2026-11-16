/**
 * The export dialog: format, colour, resolution, mirror and file name, with a summary of what
 * will be produced. Problems that would spoil the print block the export with the reason.
 */
import { exportBlocker, findIssues } from '@/model/checks';
import { contentLengthMm, sheetLengthMm } from '@/model/geometry';
import { formatCm } from '@/model/units';
import type { ExportOptions, ImageAsset, Sheet } from '@/model/types';
import { download, ExportCancelled, startExport, type RunningExport } from '@/export/client';
import { pngBlocker, pngSize } from '@/export/png';
import { byId, el, toast } from '@/editor/dom';
import type { Prefs } from '@/prefs';
import type { Store } from '@/store/store';

function defaultFileName(sheet: Sheet): string {
  const length = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
  const date = new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `printsheet-${formatCm(sheet.settings.sheetWidthMm).replace('.0', '')}cm-${(length / 1000).toFixed(2)}m-${day}`;
}

/** File names keep letters, digits, spaces, dots, dashes and underscores. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ._-]+/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.replace(/\.(pdf|png)$/i, '') || 'printsheet';
}

/** One line describing the file that will be made. */
function summaryText(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
  opts: ExportOptions,
): string {
  const length = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
  const count = sheet.designs.length;
  let text = `${formatCm(sheet.settings.sheetWidthMm)} × ${formatCm(length)} cm (${(length / 1000).toFixed(2)} m), ${count} design${count === 1 ? '' : 's'}`;
  if (opts.format === 'png') {
    const px = pngSize(sheet, opts.pngDpi);
    text += `, ${px.widthPx} × ${px.heightPx} px`;
  }
  const warned = [...findIssues(sheet, assets).values()].filter((l) =>
    l.some((i) => i.kind !== 'ok-dpi'),
  ).length;
  return text + (warned ? `. ${warned} with warnings.` : '.');
}

/** Advice for the current choices. */
function notesText(sheet: Sheet, opts: ExportOptions): string {
  const notes = ['The background is always transparent, so only your designs are printed.'];
  const content = contentLengthMm(sheet.designs);
  if (sheet.settings.lengthMode === 'fixed' && content > sheet.settings.fixedLengthMm) {
    notes.push(`Designs go past the fixed length, so the file is ${formatCm(content)} cm long.`);
  }
  if (opts.format === 'pdf' && opts.color === 'cmyk') {
    notes.push(
      "CMYK uses a standard press profile (FOGRA39), not your printer's. RGB lets the print shop's software use its own printer profile, which usually gives better colour.",
    );
  }
  notes.push(
    opts.format === 'png'
      ? 'PNG files are always RGB.'
      : 'Many DTF shops prefer PNG; ask yours which they want.',
  );
  return notes.join(' ');
}

function radioGroup<T extends string | number>(
  name: string,
  label: string,
  options: Array<[T, string]>,
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const group = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const [v, text] of options) {
    const button = el('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(v === value),
      'data-value': String(v),
      'data-group': name,
      text,
    });
    button.addEventListener('click', () => {
      for (const b of group.querySelectorAll('button'))
        b.setAttribute('aria-checked', String(b === button));
      onChange(v);
    });
    group.append(button);
  }
  return group;
}

interface OptionRow {
  label: HTMLElement;
  control: HTMLElement;
  setVisible(visible: boolean): void;
}

function optionRow(label: string, ...control: Node[]): OptionRow {
  const labelEl = el('span', { class: 'label', text: label });
  const controlEl = el('div', {}, ...control);
  return {
    label: labelEl,
    control: controlEl,
    setVisible(visible) {
      labelEl.hidden = !visible;
      controlEl.hidden = !visible;
    },
  };
}

/** The option controls; `changed` runs after any of them changes `opts`. */
function buildOptions(
  opts: ExportOptions,
  changed: () => void,
): { rows: OptionRow[]; byFormat(): void } {
  const set =
    <K extends keyof ExportOptions>(key: K) =>
    (v: ExportOptions[K]): void => {
      opts[key] = v;
      changed();
    };
  const format = optionRow(
    'Format',
    radioGroup(
      'format',
      'Format',
      [
        ['pdf', 'PDF'],
        ['png', 'PNG'],
      ],
      opts.format,
      set('format'),
    ),
  );
  const color = optionRow(
    'Colour',
    radioGroup(
      'color',
      'Colour',
      [
        ['rgb', 'RGB'],
        ['cmyk', 'CMYK'],
      ],
      opts.color,
      set('color'),
    ),
  );
  const quality = optionRow(
    'Image quality',
    radioGroup<ExportOptions['pdfMaxDpi']>(
      'quality',
      'Image quality',
      [
        ['original', 'Original'],
        [600, 'Up to 600 DPI'],
        [300, 'Up to 300 DPI'],
      ],
      opts.pdfMaxDpi,
      set('pdfMaxDpi'),
    ),
    el('p', {
      class: 'hint',
      text: 'Lowering it makes big files smaller. Images already below the limit are not changed.',
    }),
  );
  const dpi = optionRow(
    'Resolution (DPI)',
    radioGroup<ExportOptions['pngDpi']>(
      'dpi',
      'Resolution',
      [
        [150, '150'],
        [300, '300'],
        [360, '360'],
        [600, '600'],
      ],
      opts.pngDpi,
      set('pngDpi'),
    ),
    el('p', { class: 'hint', text: 'Pixels per inch. 300 is the usual print quality.' }),
  );
  const mirrorBox = el('input', { type: 'checkbox', id: 'export-mirror', checked: opts.mirror });
  mirrorBox.addEventListener('change', () => set('mirror')(mirrorBox.checked));
  const mirror = optionRow(
    'Mirror',
    el('label', { class: 'checkbox' }, mirrorBox, 'Flip the whole sheet left to right'),
  );
  const byFormat = (): void => {
    color.setVisible(opts.format === 'pdf');
    quality.setVisible(opts.format === 'pdf');
    dpi.setVisible(opts.format === 'png');
  };
  return { rows: [format, color, quality, dpi, mirror], byFormat };
}

export function openExportDialog(
  store: Store,
  getPrefs: () => Prefs,
  savePrefs: (p: Prefs) => void,
): void {
  const dialog = byId<HTMLDialogElement>('export-dialog');
  const { sheet, assets } = store.get();
  const opts: ExportOptions = { ...getPrefs().exportOptions, fileName: defaultFileName(sheet) };
  let running: RunningExport | null = null;

  const summary = el('p', { class: 'summary-line' });
  const blockNotice = el('p', { class: 'notice danger', role: 'alert' });
  const infoNotice = el('p', { class: 'notice' });
  const progress = el('progress', { max: '1', value: '0', hidden: true });
  const progressText = el('p', { class: 'hint', hidden: true });
  const fileName = el('input', {
    type: 'text',
    id: 'export-name',
    value: opts.fileName,
    'aria-label': 'File name',
  });
  const extension = el('span', { class: 'hint' });
  const exportButton = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    id: 'export-go',
    text: 'Export',
  });
  const cancelButton = el('button', { class: 'btn btn-outline', type: 'button', text: 'Cancel' });

  const refresh = (): void => {
    summary.textContent = summaryText(sheet, assets, opts);
    const blocker =
      exportBlocker(sheet) ?? (opts.format === 'png' ? pngBlocker(sheet, opts.pngDpi) : null);
    blockNotice.textContent = blocker ?? '';
    blockNotice.hidden = !blocker;
    exportButton.disabled = blocker !== null || running !== null;
    infoNotice.textContent = notesText(sheet, opts);
    extension.textContent = `.${opts.format}`;
    options.byFormat();
  };
  const options = buildOptions(opts, refresh);
  const fileRow = optionRow('File name', el('div', { class: 'row' }, fileName, extension));

  dialog.replaceChildren(
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'export-title', text: 'Export for printing' }),
      el('p', {
        class: 'lead',
        text: 'One file at the exact print size, ready for the print shop.',
      }),
      summary,
      blockNotice,
      el(
        'div',
        { class: 'option-grid' },
        ...[...options.rows, fileRow].flatMap((r) => [r.label, r.control]),
      ),
      infoNotice,
      progress,
      progressText,
    ),
    el('div', { class: 'dialog-actions' }, cancelButton, exportButton),
  );

  // Listeners on the shared dialog element are removed when it closes, so they never pile up.
  const listeners = new AbortController();
  dialog.addEventListener('close', () => listeners.abort(), { once: true });
  dialog.addEventListener(
    'cancel',
    (event) => {
      if (running) {
        event.preventDefault();
        running.cancel();
      }
    },
    { signal: listeners.signal },
  );
  cancelButton.addEventListener('click', () => (running ? running.cancel() : dialog.close()));

  exportButton.addEventListener('click', async () => {
    opts.fileName = safeFileName(fileName.value);
    const { fileName: _name, ...remembered } = opts;
    savePrefs({ ...getPrefs(), exportOptions: remembered });
    progress.hidden = false;
    progressText.hidden = false;
    progress.removeAttribute('value');
    progressText.textContent = 'Preparing…';
    const current = store.get();
    const used = [...current.assets.values()].filter((a) =>
      current.sheet.designs.some((d) => d.assetId === a.id),
    );
    running = startExport(
      { sheet: current.sheet, assets: used, options: { ...opts } },
      (done, total, stage) => {
        progress.max = total;
        progress.value = done;
        progressText.textContent = `${stage}: ${Math.round((done / total) * 100)}%`;
      },
    );
    refresh();
    cancelButton.textContent = 'Stop export';
    try {
      const blob = await running.result;
      download(blob, `${opts.fileName}.${opts.format}`);
      dialog.close();
      toast(
        `Exported ${opts.fileName}.${opts.format} (${(blob.size / 1024 / 1024).toFixed(1)} MB).`,
      );
    } catch (error) {
      if (!(error instanceof ExportCancelled))
        toast(error instanceof Error ? error.message : String(error), 'error');
      progress.hidden = true;
      progressText.hidden = true;
    } finally {
      running = null;
      cancelButton.textContent = 'Cancel';
      refresh();
    }
  });

  refresh();
  dialog.showModal();
  exportButton.focus();
}
