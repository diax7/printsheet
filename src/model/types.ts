/**
 * The sheet model. Every length is in millimetres; the screen is only a view of this.
 */

/**
 * An uploaded image after trimming. `blob` is the full-resolution trimmed PNG (8-bit sRGB, every
 * import is re-encoded through a canvas so PDF and PNG exports decode it the same way). A Blob,
 * not bytes: it posts to the export worker by reference and IndexedDB stores it natively.
 */
export interface ImageAsset {
  id: string;
  name: string;
  blob: Blob;
  widthPx: number;
  heightPx: number;
  /** False when the image has no transparent pixel at all (prints as a solid block). */
  hasTransparency: boolean;
}

/**
 * One placed copy of an asset. `xMm`/`yMm` is the centre, measured from the sheet's top-left
 * corner. Rotation is clockwise in degrees around the centre. Array order is stacking order.
 */
export interface Design {
  id: string;
  assetId: string;
  name: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  angleDeg: number;
  flipX: boolean;
  flipY: boolean;
  locked: boolean;
}

export type LengthMode = 'auto' | 'fixed';

export interface Settings {
  sheetWidthMm: number;
  lengthMode: LengthMode;
  fixedLengthMm: number;
  gapMm: number;
}

export interface Sheet {
  designs: Design[];
  settings: Settings;
}

export interface Preset {
  id: string;
  name: string;
  widthMm: number;
  builtIn: boolean;
}

export type PngDpi = 150 | 300 | 360 | 600;
export type PdfMaxDpi = 'original' | 600 | 300;

export interface ExportOptions {
  format: 'pdf' | 'png';
  color: 'rgb' | 'cmyk';
  pngDpi: PngDpi;
  pdfMaxDpi: PdfMaxDpi;
  mirror: boolean;
  fileName: string;
}

export interface Point {
  x: number;
  y: number;
}

export const MAX_SHEET_LENGTH_MM = 5000;
export const MIN_WIDTH_MM = 100;
/** 160 cm: wider than any DTF roll, and inside Chromium canvas limits at 600 DPI. */
export const MAX_WIDTH_MM = 1600;
export const PLACEMENT_DPI = 300;
/**
 * Limits shared by the editor and by validation, so everything the editor can make also reopens.
 * The smallest size covers a 1 px hairline shrunk to fit the narrowest sheet.
 */
export const MIN_SIZE_MM = 0.001;
export const MAX_SIZE_MM = 100_000;
export const MAX_DESIGNS = 5000;

export const DEFAULT_SETTINGS: Settings = {
  sheetWidthMm: 580,
  lengthMode: 'auto',
  fixedLengthMm: 1000,
  gapMm: 5,
};

export const BUILT_IN_PRESETS: readonly Preset[] = [
  { id: 'dtf-58', name: 'DTF 58 cm', widthMm: 580, builtIn: true },
  { id: 'dtf-60', name: 'DTF 60 cm', widthMm: 600, builtIn: true },
];
