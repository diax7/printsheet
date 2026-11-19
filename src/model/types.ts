/**
 * The sheet model. Every length is in millimetres; the screen is only a view of this.
 */

/** The kinds of file a design can come from, for its badge. */
export const FILE_FORMATS = ['png', 'jpg', 'webp', 'gif', 'svg', 'pdf', 'ai', 'psd'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

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
  /** The kind of file it came from, for its badge; absent on images added before badges. */
  format?: FileFormat;
  /** For a vector design: the original file, drawn afresh at print size for every export. */
  vector?: VectorSource;
}

/** A region as fractions (0 to 1) of a whole page. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The original of a vector design. `blob` is shared by every design cut from the same file (one
 * per PDF page), and saved files store it once under `sourceId`.
 */
export interface VectorSource {
  type: 'svg' | 'pdf';
  /** Hash of the original file's bytes. */
  sourceId: string;
  blob: Blob;
  /** 1-based page (1 for an SVG). */
  page: number;
  /** The artwork's inked area on its page, so the border trimmed at import stays trimmed. */
  crop: Crop;
  /** The print size of that area, from the file's own units. */
  sizeMm: { w: number; h: number };
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
/** One long sheet, or the job split into sheets of `pageLengthMm` each. */
export type Layout = 'single' | 'split';
/** In a split job, the last sheet is cut after its designs or kept at the full length. */
export type LastPage = 'trim' | 'full';
/** How the cutting gap is measured: between rectangles, or between the ink outlines. */
export type Spacing = 'box' | 'shape';

export interface Settings {
  sheetWidthMm: number;
  /** Auto or Fixed length; applies to one long sheet only. */
  lengthMode: LengthMode;
  fixedLengthMm: number;
  gapMm: number;
  layout: Layout;
  pageLengthMm: number;
  lastPage: LastPage;
  spacing: Spacing;
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
/** Compact stores RGB colour as high-quality JPEG; lossless keeps every pixel. Alpha is always exact. */
export type PdfCompression = 'compact' | 'lossless';

/** How a split job is exported: a zip of files, one PDF with a page each, or separate files. */
export type SplitOutput = 'zip' | 'pdf-pages' | 'files';

export interface ExportOptions {
  format: 'pdf' | 'png';
  color: 'rgb' | 'cmyk';
  pngDpi: PngDpi;
  pdfMaxDpi: PdfMaxDpi;
  pdfCompression: PdfCompression;
  splitOutput: SplitOutput;
  mirror: boolean;
  fileName: string;
}

export interface Point {
  x: number;
  y: number;
}

export const MAX_SHEET_LENGTH_MM = 5000;
/** Shortest sheet in a split job. */
export const MIN_PAGE_LENGTH_MM = 100;
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
  layout: 'single',
  pageLengthMm: 1000,
  lastPage: 'trim',
  spacing: 'box',
};

export const BUILT_IN_PRESETS: readonly Preset[] = [
  { id: 'dtf-58', name: 'DTF 58 cm', widthMm: 580, builtIn: true },
  { id: 'dtf-60', name: 'DTF 60 cm', widthMm: 600, builtIn: true },
];
