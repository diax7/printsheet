/**
 * The PDF export. One page, exactly the sheet's size. Each image is embedded once (at its
 * original resolution, or reduced to the chosen limit) and every design that uses it is drawn
 * with its own transform, so the sheet is never flattened into one picture. Transparency is a
 * soft mask, so DTF software sees exactly where ink goes.
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
import type { CmykConverter } from '@/export/cmyk';
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

export type PdfOptions = Pick<ExportOptions, 'color' | 'pdfMaxDpi' | 'mirror' | 'fileName'>;

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

function splitAlpha(rgba: Uint8ClampedArray): { rgb: Uint8Array; alpha: Uint8Array } {
  const count = rgba.length / 4;
  const rgb = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = rgba[i * 4] ?? 0;
    rgb[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = rgba[i * 4 + 2] ?? 0;
    alpha[i] = rgba[i * 4 + 3] ?? 0;
  }
  return { rgb, alpha };
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
  const { rgb, alpha } = splitAlpha(rgba);
  const ctx = doc.context;
  const base = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    BitsPerComponent: 8,
  };
  let color: Uint8Array = rgb;
  if (opts.color === 'cmyk') {
    if (!deps.toCmyk) throw new Error('CMYK export needs the colour converter');
    color = deps.toCmyk(rgba);
  }
  const dict: Record<string, unknown> = {
    ...base,
    ColorSpace: opts.color === 'cmyk' ? 'DeviceCMYK' : 'DeviceRGB',
  };
  if (asset.hasTransparency) {
    dict['SMask'] = ctx.register(ctx.flateStream(alpha, { ...base, ColorSpace: 'DeviceGray' }));
  }
  return ctx.register(ctx.flateStream(color, dict as Parameters<typeof ctx.flateStream>[1]));
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

export async function buildPdf(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
  opts: PdfOptions,
  deps: PdfDeps,
): Promise<Uint8Array> {
  // updateMetadata: false stops pdf-lib from overwriting the producer with its own name on save.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setTitle(opts.fileName);
  doc.setProducer('PrintSheet');
  doc.setCreator('PrintSheet');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const lengthMm = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
  const page = doc.addPage([mmToPt(sheet.settings.sheetWidthMm), mmToPt(lengthMm)]);

  const byAsset = new Map<string, Design[]>();
  for (const d of sheet.designs) {
    if (!assets.has(d.assetId)) throw new Error(`The image for "${d.name}" is missing`);
    byAsset.set(d.assetId, [...(byAsset.get(d.assetId) ?? []), d]);
  }

  // Keep the PDFName itself: its text form starts with "/", and drawObject would add another.
  const names = new Map<string, PDFName>();
  let done = 0;
  for (const [assetId, placements] of byAsset) {
    const asset = assets.get(assetId) as ImageAsset;
    const ref = await embedImage(
      doc,
      asset,
      embedSize(asset, placements, opts.pdfMaxDpi),
      opts,
      deps,
    );
    names.set(assetId, page.node.newXObject('Im', ref));
    deps.onProgress?.(++done, byAsset.size);
  }

  drawDesigns(
    page,
    sheet.designs.map((design) => ({ design, name: names.get(design.assetId) as PDFName })),
    opts,
  );
  return doc.save();
}
