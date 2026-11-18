/**
 * What an export produces and what its files are called. Pure, so the worker and the dialog
 * agree and tests can pin it down.
 */
import { contentLengthMm, sheetLengthMm } from '@/model/geometry';
import { filmLengthMm } from '@/model/pages';
import { formatCm } from '@/model/units';
import type { ExportOptions, Sheet } from '@/model/types';

/**
 * single: one file (one long sheet, or a split job with one non-empty sheet).
 * zip: one zip holding a file per sheet. pdf-pages: one PDF with a page per sheet.
 * files: a file per sheet, each downloaded with its own button.
 */
export type OutputKind = 'single' | 'zip' | 'pdf-pages' | 'files';

export function outputKind(
  opts: Pick<ExportOptions, 'format' | 'splitOutput'>,
  partCount: number,
): OutputKind {
  if (partCount <= 1) return 'single';
  // PNG has no pages, so "one PDF with pages" becomes a zip of PNGs.
  if (opts.format === 'png' && opts.splitOutput === 'pdf-pages') return 'zip';
  return opts.splitOutput;
}

/** `job-sheet-2-of-3.pdf` for a sheet of a split job, `job.pdf` for a single file. */
export function partFileName(
  base: string,
  part: { number: number; of: number },
  extension: string,
): string {
  if (part.of <= 1) return `${base}.${extension}`;
  return `${base}-sheet-${part.number}-of-${part.of}.${extension}`;
}

/** Two digits, as in 2026-03-07. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The suggested name, with the width and the length of film in it, e.g.
 * `printsheet-58cm-1.20m-2026-11-18`. For one long sheet the length is the file's real length
 * (designs past a fixed length make the file longer), so the name never understates what the
 * shop prints; for a split job it is the total of the sheets.
 */
export function defaultFileName(sheet: Sheet, date: Date): string {
  const lengthMm =
    sheet.settings.layout === 'single'
      ? Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs))
      : filmLengthMm(sheet);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const width = formatCm(sheet.settings.sheetWidthMm).replace('.0', '');
  return `printsheet-${width}cm-${(lengthMm / 1000).toFixed(2)}m-${day}`;
}
