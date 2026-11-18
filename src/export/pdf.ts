/**
 * The PDF export. One page per sheet, each exactly its sheet's size. Each image is embedded once (at its
 * original resolution, or reduced to the chosen limit) and every design that uses it is drawn
 * with its own transform, so the sheet is never flattened into one picture. Transparency is a
 * lossless soft mask, so DTF software sees exactly where ink goes. Colour is stored either
 * lossless or, in compact mode, as a high-quality JPEG (RGB, or Adobe-style CMYK).
 */
import {
  PDFDocument,
  type PDFName,
  type PDFPage,
  type PDFRef,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { bleedTransparent } from '@/export/bleed';
import type { CmykConverter } from '@/export/cmyk';
import { encodeJpeg } from '@/export/jpeg';
import { encodeJpegCmyk } from '@/export/jpeg-cmyk';
import { filterPaeth } from '@/export/png-filter';
import { sheetLengthMm, contentLengthMm } from '@/model/geometry';
import { mmToPt, mmToPx } from '@/model/units';
import type { Design, ExportOptions, ImageAsset, Sheet } from '@/model/types';

/** Returns the asset's RGBA pixels at the given size (resampled when smaller than the original). */
export type PixelSource = (
  asset: ImageAsset,
  width: number,
  height: number,
) => Promise<Uint8ClampedArray>;

export interface PdfDeps {
  pixels: PixelSource;
  toCmyk?: CmykConverter;
  onProgress?: (done: number, total: number) => void;
}

export type PdfOptions = Pick<
  ExportOptions,
  'color' | 'pdfMaxDpi' | 'pdfCompression' | 'mirror' | 'fileName'
>;

/** Pixel size to embed: the original, or smaller so the largest placement is at the limit. */
export function embedSize(
  asset: ImageAsset,
  placements: readonly Design[],
  maxDpi: PdfOptions['pdfMaxDpi'],
): {
  width: number;
  height: number;
} {
  if (maxDpi === 'original') return { width: asset.widthPx, height: asset.heightPx };
  let scale = 0;
  for (const d of placements) {
    scale = Math.max(
      scale,
      mmToPx(d.widthMm, maxDpi) / asset.widthPx,
      mmToPx(d.heightMm, maxDpi) / asset.heightPx,
    );
  }
  if (scale >= 1) return { width: asset.widthPx, height: asset.heightPx };
  return {
    width: Math.max(1, Math.round(asset.widthPx * scale)),
    height: Math.max(1, Math.round(asset.heightPx * scale)),
  };
}

/** The three colour channels, or the alpha channel, of RGBA pixels. */
function channels(rgba: Uint8ClampedArray, pick: 'rgb' | 'alpha'): Uint8Array {
  const count = rgba.length / 4;
  if (pick === 'alpha') {
    const alpha = new Uint8Array(count);
    for (let i = 0; i < count; i++) alpha[i] = rgba[i * 4 + 3] ?? 0;
    return alpha;
  }
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = rgba[i * 4] ?? 0;
    rgb[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = rgba[i * 4 + 2] ?? 0;
  }
  return rgb;
}

type ImageDict = Parameters<PDFDocument['context']['flateStream']>[1];

/**
 * A lossless image stream: rows PNG-filtered, then deflated, with the matching Predictor 15 so
 * readers undo the filter. Exactly the same samples, typically a third smaller than plain Flate.
 */
function losslessStream(
  doc: PDFDocument,
  samples: Uint8Array,
  bpp: number,
  dict: Record<string, unknown>,
): PDFRef {
  const width = dict['Width'] as number;
  const height = dict['Height'] as number;
  const filtered = filterPaeth(samples, width, height, bpp, null);
  const parms = { Predictor: 15, Colors: bpp, BitsPerComponent: 8, Columns: width };
  return doc.context.register(
    doc.context.flateStream(filtered, { ...dict, DecodeParms: parms } as ImageDict),
  );
}

async function embedImage(
  doc: PDFDocument,
  asset: ImageAsset,
  size: { width: number; height: number },
  opts: PdfOptions,
  deps: PdfDeps,
): Promise<PDFRef> {
  const { width, height } = size;
  const rgba = await deps.pixels(asset, width, height);
  if (rgba.length !== width * height * 4) {
    throw new Error(`Pixels for "${asset.name}" have the wrong size`);
  }
  const base = { Type: 'XObject', Subtype: 'Image', Width: width, Height: height };
  const dict: Record<string, unknown> = { ...base, BitsPerComponent: 8 };
  // The soft mask is always lossless, so the edge of every design stays exact.
  if (asset.hasTransparency) {
    dict['SMask'] = losslessStream(doc, channels(rgba, 'alpha'), 1, {
      ...dict,
      ColorSpace: 'DeviceGray',
    });
  }
  if (opts.color === 'cmyk') {
    if (!deps.toCmyk) throw new Error('CMYK export needs the colour converter');
    if (opts.pdfCompression !== 'compact') {
      return losslessStream(doc, deps.toCmyk(rgba), 4, { ...dict, ColorSpace: 'DeviceCMYK' });
    }
    // Same edge care as RGB: transparent pixels take the design's colour before JPEG coding.
    if (asset.hasTransparency) bleedTransparent(rgba, width, height);
    const jpeg = encodeJpegCmyk(deps.toCmyk(rgba), width, height);
    // Adobe CMYK JPEGs store inverted samples; this Decode array turns them back.
    const cmykDict = {
      ...dict,
      ColorSpace: 'DeviceCMYK',
      Filter: 'DCTDecode',
      Decode: [1, 0, 1, 0, 1, 0, 1, 0],
    };
    return doc.context.register(doc.context.stream(jpeg, cmykDict as ImageDict));
  }
  if (opts.pdfCompression === 'compact') {
    if (asset.hasTransparency) bleedTransparent(rgba, width, height);
    const jpeg = encodeJpeg(rgba, width, height);
    const jpegDict = { ...dict, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' };
    return doc.context.register(doc.context.stream(jpeg, jpegDict as ImageDict));
  }
  return losslessStream(doc, channels(rgba, 'rgb'), 3, { ...dict, ColorSpace: 'DeviceRGB' });
}

/**
 * The matrix that maps the image's unit square onto the design: move to the centre (PDF's y
 * axis points up, so y is flipped), rotate clockwise on the sheet, flip in the design's own
 * axes, scale to the printed size, and centre the unit square.
 */
export function designMatrix(
  d: Design,
  pageHeightPt: number,
): [number, number, number, number, number, number] {
  const rad = (-d.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = mmToPt(d.widthMm) * (d.flipX ? -1 : 1);
  const sy = mmToPt(d.heightMm) * (d.flipY ? -1 : 1);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const dd = cos * sy;
  const cx = mmToPt(d.xMm);
  const cy = pageHeightPt - mmToPt(d.yMm);
  return [a, b, c, dd, cx - 0.5 * a - 0.5 * c, cy - 0.5 * b - 0.5 * dd];
}

function drawDesigns(
  page: PDFPage,
  placed: ReadonlyArray<{ design: Design; name: PDFName }>,
  opts: PdfOptions,
): void {
  const { width, height } = page.getSize();
  const ops = [];
  if (opts.mirror) ops.push(pushGraphicsState(), concatTransformationMatrix(-1, 0, 0, 1, width, 0));
  for (const { design, name } of placed) {
    const [a, b, c, d, e, f] = designMatrix(design, height);
    ops.push(
      pushGraphicsState(),
      concatTransformationMatrix(a, b, c, d, e, f),
      drawObject(name),
      popGraphicsState(),
    );
  }
  if (opts.mirror) ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

/**
 * The PDF: one page per sheet (one page for one long sheet), each exactly its sheet's size. Each
 * image is embedded once for the whole file, at the resolution its largest placement on any page
 * needs, and every page that uses it refers to that one copy.
 *
 * Args:
 *   pages: The sheets, in page order (from `splitForExport` for a split job).
 *   assets: Every image the designs use.
 *   opts: Colour, compression, image limit, mirror and title.
 *   deps: Pixel reader, CMYK converter and progress callback.
 */
export async function buildPdf(
  pages: readonly Sheet[],
  assets: ReadonlyMap<string, ImageAsset>,
  opts: PdfOptions,
  deps: PdfDeps,
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('There is no sheet to put in the PDF.');
  // updateMetadata: false stops pdf-lib from overwriting the producer with its own name on save.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setTitle(opts.fileName);
  doc.setProducer('PrintSheet');
  doc.setCreator('PrintSheet');
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const byAsset = new Map<string, Design[]>();
  for (const d of pages.flatMap((p) => p.designs)) {
    if (!assets.has(d.assetId)) throw new Error(`The image for "${d.name}" is missing`);
    byAsset.set(d.assetId, [...(byAsset.get(d.assetId) ?? []), d]);
  }
  const refs = new Map<string, PDFRef>();
  let done = 0;
  for (const [assetId, placements] of byAsset) {
    const asset = assets.get(assetId) as ImageAsset;
    const size = embedSize(asset, placements, opts.pdfMaxDpi);
    refs.set(assetId, await embedImage(doc, asset, size, opts, deps));
    deps.onProgress?.(++done, byAsset.size);
  }

  for (const sheet of pages) {
    const lengthMm = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
    const page = doc.addPage([mmToPt(sheet.settings.sheetWidthMm), mmToPt(lengthMm)]);
    // Keep the PDFName itself: its text form starts with "/", and drawObject would add another.
    const names = new Map<string, PDFName>();
    for (const d of sheet.designs) {
      if (!names.has(d.assetId)) {
        names.set(d.assetId, page.node.newXObject('Im', refs.get(d.assetId) as PDFRef));
      }
    }
    drawDesigns(
      page,
      sheet.designs.map((design) => ({ design, name: names.get(design.assetId) as PDFName })),
      opts,
    );
  }
  return doc.save();
}
