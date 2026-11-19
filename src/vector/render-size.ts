/**
 * How large to draw a vector for an export: once per image, at the largest copy on the sheet on
 * each axis, at the export's DPI, within the image limits. The exporters never enlarge an image,
 * so this is exactly the size they need for every copy.
 */
import { MAX_IMPORT_AREA, MAX_IMPORT_SIDE } from '@/image/limits';
import { mmToPx } from '@/model/units';
import type { Design, ExportOptions } from '@/model/types';

/**
 * The DPI vectors are drawn at for an export: the PNG's own DPI, or the PDF's quality limit,
 * with 300 when the PDF keeps images at their original size (a vector has none).
 */
export function vectorExportDpi(
  options: Pick<ExportOptions, 'format' | 'pngDpi' | 'pdfMaxDpi'>,
): number {
  if (options.format === 'png') return options.pngDpi;
  return options.pdfMaxDpi === 'original' ? 300 : options.pdfMaxDpi;
}

export interface RenderSize {
  widthPx: number;
  heightPx: number;
  /** Set when the limits made it smaller: the DPI it is drawn at instead. */
  clampedDpi?: number;
}

/** The size to draw `assetId` at for an export at `dpi`, or null when no design uses it. */
export function vectorRenderSize(
  designs: readonly Design[],
  assetId: string,
  dpi: number,
): RenderSize | null {
  const uses = designs.filter((d) => d.assetId === assetId);
  if (!uses.length) return null;
  const widthMm = Math.max(...uses.map((d) => d.widthMm));
  const heightMm = Math.max(...uses.map((d) => d.heightMm));
  const widthPx = mmToPx(widthMm, dpi);
  const heightPx = mmToPx(heightMm, dpi);
  const scale = Math.min(
    1,
    MAX_IMPORT_SIDE / widthPx,
    MAX_IMPORT_SIDE / heightPx,
    Math.sqrt(MAX_IMPORT_AREA / (widthPx * heightPx)),
  );
  if (scale >= 1) return { widthPx: Math.ceil(widthPx), heightPx: Math.ceil(heightPx) };
  return {
    widthPx: Math.max(1, Math.floor(widthPx * scale)),
    heightPx: Math.max(1, Math.floor(heightPx * scale)),
    clampedDpi: dpi * scale,
  };
}
