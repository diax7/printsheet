/**
 * The export dialog: format, colour, file size, resolution, mirror (with a preview of the file),
 * how a split job comes out, and the file name, with a summary of what will be made. Problems
 * that would spoil the print block the export with the reason.
 */
import { exportBlocker, findIssues } from '@/model/checks';
import { contentLengthMm, sheetLengthMm } from '@/model/geometry';
import { filmLengthMm, splitForExport } from '@/model/pages';
import { formatCm, formatM } from '@/model/units';
import type { ExportOptions, Sheet } from '@/model/types';
import { download, ExportCancelled, startExport, type RunningExport } from '@/export/client';
import { defaultFileName, outputKind } from '@/export/output';
import { pngBlocker, pngSize } from '@/export/png';
import type { ExportFile } from '@/export/worker';
import { byId, el, toast } from '@/editor/dom';
import { exportPreview, type ExportPreview } from '@/editor/export-preview';
import type { Prefs } from '@/prefs';
import type { AppState, Store } from '@/store/store';

/** File names keep letters, digits, spaces, dots, dashes and underscores. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ._-]+/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.replace(/\.(pdf|png|zip)$/i, '') || 'printsheet';
}

/** "Sheet 2 is" / "Sheets 2 and 4 are": the empty sheets left out of a split export. */
function emptyText(empty: readonly number[]): string {
  if (empty.length === 0) return '';
  if (empty.length === 1) return `. Sheet ${empty[0]} is empty and is left out`;
  return `. Sheets ${empty.slice(0, -1).join(', ')} and ${empty.at(-1)} are empty and are left out`;
}

/** One line describing what will be made. */
function summaryText(state: AppState, opts: ExportOptions): string {
  const { sheet, assets, masks } = state;
  const count = sheet.designs.length;
  const designs = `${count} design${count === 1 ? '' : 's'}`;
  const { parts, empty } = splitForExport(sheet);
  let text: string;
  if (sheet.settings.layout === 'single') {
    const length = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
    text = `${formatCm(sheet.settings.sheetWidthMm)} × ${formatCm(length)} cm (${formatM(length)}), ${designs}`;
  } else {
    const sheets = `${parts.length} sheet${parts.length === 1 ? '' : 's'}`;
    text = `${sheets}, ${formatM(filmLengthMm(sheet))} of film, ${formatCm(sheet.settings.sheetWidthMm)} cm wide, ${designs}`;
  }
  if (opts.format === 'png') {
    const sizes = parts.map((p) => pngSize(p.sheet, opts.pngDpi));
    const tallest = Math.max(...sizes.map((s) => s.heightPx));
    text += `, ${parts.length > 1 ? 'each up to ' : ''}${sizes[0]?.widthPx ?? 0} × ${tallest} px`;
  }
  text += emptyText(empty);
  const warned = [...findIssues(sheet, assets, masks).values()].filter((l) =>
    l.some((i) => i.kind !== 'ok-dpi'),
  ).length;
  return text + (warned ? `. ${warned} with warnings.` : '.');
}

/** Why the export cannot run with these choices, or null. */
function blockerFor(sheet: Sheet, opts: ExportOptions): string | null {
  const blocker = exportBlocker(sheet);
  if (blocker || opts.format !== 'png') return blocker;
  for (const part of splitForExport(sheet).parts) {
    const png = pngBlocker(part.sheet, opts.pngDpi);
    if (png) return png;
  }
  return null;
}

/** Advice for the current choices. */
function notesText(sheet: Sheet, opts: ExportOptions): string {
  const notes = ['The background is always transparent, so only your designs are printed.'];
  const content = contentLengthMm(sheet.designs);
  const { layout, lengthMode, fixedLengthMm } = sheet.settings;
  if (layout === 'single' && lengthMode === 'fixed' && content > fixedLengthMm) {
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

type Setter = <K extends keyof ExportOptions>(key: K) => (v: ExportOptions[K]) => void;
const hint = (text: string): HTMLElement => el('p', { class: 'hint', text });

function formatRow(opts: ExportOptions, set: Setter): OptionRow {
  const choices: Array<[ExportOptions['format'], string]> = [
    ['pdf', 'PDF'],
    ['png', 'PNG'],
  ];
  return optionRow('Format', radioGroup('format', 'Format', choices, opts.format, set('format')));
}

function colorRow(opts: ExportOptions, set: Setter): OptionRow {
  const choices: Array<[ExportOptions['color'], string]> = [
    ['rgb', 'RGB'],
    ['cmyk', 'CMYK'],
  ];
  return optionRow('Colour', radioGroup('color', 'Colour', choices, opts.color, set('color')));
}

function compressionRow(opts: ExportOptions, set: Setter): OptionRow {
  const choices: Array<[ExportOptions['pdfCompression'], string]> = [
    ['compact', 'Compact'],
    ['lossless', 'Lossless'],
  ];
  return optionRow(
    'File size',
    radioGroup('compression', 'File size', choices, opts.pdfCompression, set('pdfCompression')),
    hint(
      'Compact stores colours as high-quality JPEG and keeps every edge exact: about a quarter of the size, easy to send. Lossless keeps every pixel.',
    ),
  );
}

function qualityRow(opts: ExportOptions, set: Setter): OptionRow {
  const choices: Array<[ExportOptions['pdfMaxDpi'], string]> = [
    ['original', 'Original'],
    [600, 'Up to 600 DPI'],
    [300, 'Up to 300 DPI'],
  ];
  return optionRow(
    'Image quality',
    radioGroup('quality', 'Image quality', choices, opts.pdfMaxDpi, set('pdfMaxDpi')),
    hint('Lowering it makes big files smaller. Images already below the limit are not changed.'),
  );
}

function dpiRow(opts: ExportOptions, set: Setter): OptionRow {
  const choices: Array<[ExportOptions['pngDpi'], string]> = [
    [150, '150'],
    [300, '300'],
    [360, '360'],
    [600, '600'],
  ];
  return optionRow(
    'Resolution (DPI)',
    radioGroup('dpi', 'Resolution', choices, opts.pngDpi, set('pngDpi')),
    hint('Pixels per inch. 300 is the usual print quality.'),
  );
}

function mirrorRow(opts: ExportOptions, set: Setter, preview: ExportPreview): OptionRow {
  const choices: Array<['regular' | 'mirrored', string]> = [
    ['regular', 'Regular'],
    ['mirrored', 'Mirrored'],
  ];
  const value = opts.mirror ? 'mirrored' : 'regular';
  return optionRow(
    'Mirror',
    radioGroup('mirror', 'Mirror', choices, value, (v) => set('mirror')(v === 'mirrored')),
    hint('DTF prints mirrored, but the print shop software usually flips it. Ask your shop.'),
    preview.element,
  );
}

function splitRow(opts: ExportOptions, set: Setter): OptionRow {
  const choices: Array<[ExportOptions['splitOutput'], string]> = [
    ['zip', 'One zip'],
    ['pdf-pages', 'One PDF'],
    ['files', 'Separate files'],
  ];
  return optionRow(
    'Sheets',
    radioGroup('split', 'Sheets', choices, opts.splitOutput, set('splitOutput')),
    hint(
      'One zip holds a file per sheet. One PDF has a page per sheet. Separate files gives a download button per sheet.',
    ),
  );
}

/** PNG has no pages: hide "One PDF" and show the zip it becomes as the choice. */
function showSplitChoice(row: OptionRow, opts: ExportOptions): void {
  const png = opts.format === 'png';
  const kind = outputKind(opts, 2);
  for (const button of row.control.querySelectorAll<HTMLButtonElement>('[data-group="split"]')) {
    button.hidden = png && button.dataset['value'] === 'pdf-pages';
    button.setAttribute('aria-checked', String(button.dataset['value'] === kind));
  }
}

/** The option controls; `changed` runs after any of them changes `opts`. */
function buildOptions(
  opts: ExportOptions,
  changed: () => void,
  context: { parts: number; preview: ExportPreview },
): { rows: OptionRow[]; byFormat(): void } {
  const set: Setter = (key) => (v) => {
    opts[key] = v;
    changed();
  };
  const color = colorRow(opts, set);
  const compression = compressionRow(opts, set);
  const quality = qualityRow(opts, set);
  const dpi = dpiRow(opts, set);
  const split = splitRow(opts, set);
  const byFormat = (): void => {
    color.setVisible(opts.format === 'pdf');
    compression.setVisible(opts.format === 'pdf');
    quality.setVisible(opts.format === 'pdf');
    dpi.setVisible(opts.format === 'png');
    split.setVisible(context.parts > 1);
    showSplitChoice(split, opts);
    context.preview.update(opts.mirror);
  };
  const rows = [formatRow(opts, set), color, compression, quality, dpi, split];
  return { rows: [...rows, mirrorRow(opts, set, context.preview)], byFormat };
}

/** After a "Separate files" export: one download button per file. */
function fileButtons(files: readonly ExportFile[]): HTMLElement {
  return el(
    'div',
    { class: 'export-files', id: 'export-files' },
    el('p', { class: 'hint', text: 'Download each sheet:' }),
    ...files.map((file, i) => {
      const button = el('button', {
        class: 'btn btn-outline',
        type: 'button',
        'data-file': String(i),
        text: `${file.name} (${(file.blob.size / 1024 / 1024).toFixed(1)} MB)`,
      });
      // Each download is its own click, so the browser never asks to allow several downloads.
      button.addEventListener('click', () => download(file.blob, file.name));
      return button;
    }),
  );
}

interface DialogParts {
  dialog: HTMLDialogElement;
  progress: HTMLProgressElement;
  progressText: HTMLElement;
  body: HTMLElement;
  exportButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

/** Hands the finished files to the user: one downloads at once, several get a button each. */
function deliver(files: ExportFile[], ui: DialogParts): void {
  const first = files[0];
  if (files.length === 1 && first) {
    download(first.blob, first.name);
    ui.dialog.close();
    toast(`Exported ${first.name} (${(first.blob.size / 1024 / 1024).toFixed(1)} MB).`);
    return;
  }
  ui.progress.hidden = true;
  ui.progressText.hidden = true;
  ui.body.append(fileButtons(files));
  ui.exportButton.hidden = true;
  ui.cancelButton.textContent = 'Done';
}

export function openExportDialog(
  store: Store,
  getPrefs: () => Prefs,
  savePrefs: (p: Prefs) => void,
): void {
  const dialog = byId<HTMLDialogElement>('export-dialog');
  const opened = store.get();
  const { sheet } = opened;
  const opts: ExportOptions = {
    ...getPrefs().exportOptions,
    fileName: defaultFileName(sheet, new Date()),
  };
  const parts = splitForExport(sheet).parts.length;
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
    summary.textContent = summaryText(opened, opts);
    const blocker = blockerFor(sheet, opts);
    blockNotice.textContent = blocker ?? '';
    blockNotice.hidden = !blocker;
    exportButton.disabled = blocker !== null || running !== null;
    infoNotice.textContent = notesText(sheet, opts);
    const kind = outputKind(opts, parts);
    extension.textContent =
      kind === 'zip'
        ? '.zip'
        : kind === 'files'
          ? `-sheet-1-of-${parts}.${opts.format}`
          : `.${opts.format}`;
    options.byFormat();
  };
  const options = buildOptions(opts, refresh, { parts, preview: exportPreview(sheet) });
  const fileRow = optionRow('File name', el('div', { class: 'row' }, fileName, extension));
  const body = el(
    'div',
    { class: 'dialog-body' },
    el('h2', { id: 'export-title', text: 'Export for printing' }),
    el('p', { class: 'lead', text: 'Files at the exact print size, ready for the print shop.' }),
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
  );
  dialog.replaceChildren(body, el('div', { class: 'dialog-actions' }, cancelButton, exportButton));
  const ui: DialogParts = { dialog, progress, progressText, body, exportButton, cancelButton };

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
      deliver(await running.result, ui);
    } catch (error) {
      if (!(error instanceof ExportCancelled))
        toast(error instanceof Error ? error.message : String(error), 'error');
      progress.hidden = true;
      progressText.hidden = true;
      cancelButton.textContent = 'Cancel';
    } finally {
      running = null;
      if (cancelButton.textContent === 'Stop export') cancelButton.textContent = 'Cancel';
      refresh();
    }
  });

  refresh();
  dialog.showModal();
  exportButton.focus();
}
