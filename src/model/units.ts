/** Unit conversions. 1 inch = 25.4 mm exactly; 1 PDF point = 1/72 inch. */

export const MM_PER_INCH = 25.4;

export function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * 72;
}

export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH;
}

/** Millimetres shown as centimetres with one decimal, e.g. 300 → "30.0". */
export function formatCm(mm: number): string {
  return (Math.round(mm) / 10).toFixed(1);
}

/** Millimetres shown as meters with two decimals, e.g. 1370 → "1.37 m". */
export function formatM(mm: number): string {
  return `${(mm / 1000).toFixed(2)} m`;
}
