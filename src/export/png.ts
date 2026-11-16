/**
 * Renders the sheet as a transparent PNG at a chosen DPI, strip by strip (see png-stream.ts).
 * Runs in the export worker. Each image is decoded only when the first strip that needs it is
 * reached, at the size it is printed, and released after the last strip that needs it.
 */
import { encodePng } from '@/export/png-stream';
import { contentLengthMm, footprint, sheetLengthMm } from '@/model/geometry';
import { mmToPx } from '@/model/units';
import type { Design, ImageAsset, Sheet } from '@/model/types';

/** Chromium canvases larger than this on a side come back blank instead of failing. */
export const MAX_CANVAS_SIDE = 32000;
/** Pixels per strip: keeps each strip's raw pixels around 64 MB. */
export const STRIP_AREA = 16_777_216;

export interface PngSize {
  widthPx: number;
  heightPx: number;
}

export function pngSize(sheet: Sheet, dpi: number): PngSize {
  const lengthMm = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
  return {
    widthPx: Math.round(mmToPx(sheet.settings.sheetWidthMm, dpi)),
    heightPx: Math.max(1, Math.round(mmToPx(lengthMm, dpi))),
  };
}

/** Why a PNG at this DPI cannot be made, or null when it can. */
export function pngBlocker(sheet: Sheet, dpi: number): string | null {
  const { widthPx } = pngSize(sheet, dpi);
  if (widthPx > MAX_CANVAS_SIDE) {
    return `At ${dpi} DPI the image would be ${widthPx} px wide, more than a browser can draw. Choose a lower DPI or export a PDF.`;
  }
  return null;
}

interface Placement {
  design: Design;
  top: number;
  bottom: number;
}

export async function renderPng(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
  opts: { dpi: number; mirror: boolean },
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const blocker = pngBlocker(sheet, opts.dpi);
  if (blocker) throw new Error(blocker);
  const { widthPx, heightPx } = pngSize(sheet, opts.dpi);
  const pxPerMm = opts.dpi / 25.4;
  const rowsPerStrip = Math.max(1, Math.min(heightPx, Math.floor(STRIP_AREA / widthPx)));

  const canvas = new OffscreenCanvas(widthPx, rowsPerStrip);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot draw the PNG here.');
  // Sentinel: an oversized canvas returns blank pixels instead of an error. Prove this one works.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(widthPx - 1, rowsPerStrip - 1, 1, 1);
  if (ctx.getImageData(widthPx - 1, rowsPerStrip - 1, 1, 1).data[3] !== 255) {
    throw new Error(
      'This sheet is too large for the browser to draw as one PNG. Choose a lower DPI or export a PDF.',
    );
  }

  const placements: Placement[] = sheet.designs.map((design) => {
    const box = footprint(design);
    return { design, top: Math.floor(box.minY * pxPerMm), bottom: Math.ceil(box.maxY * pxPerMm) };
  });
  const lastRow = new Map<string, number>();
  const neededPx = new Map<string, { w: number; h: number }>();
  for (const p of placements) {
    const id = p.design.assetId;
    lastRow.set(id, Math.max(lastRow.get(id) ?? 0, p.bottom));
    const n = neededPx.get(id) ?? { w: 0, h: 0 };
    neededPx.set(id, {
      w: Math.max(n.w, p.design.widthMm * pxPerMm),
      h: Math.max(n.h, p.design.heightMm * pxPerMm),
    });
  }

  const bitmaps = new Map<string, Promise<ImageBitmap>>();
  const bitmap = (assetId: string): Promise<ImageBitmap> => {
    const existing = bitmaps.get(assetId);
    if (existing) return existing;
    const asset = assets.get(assetId);
    if (!asset) throw new Error('An image used on the sheet is missing.');
    const need = neededPx.get(assetId) ?? { w: asset.widthPx, h: asset.heightPx };
    // Decode at the printed size when that is smaller than the original; never enlarge.
    const scale = Math.min(1, Math.max(need.w / asset.widthPx, need.h / asset.heightPx));
    const created =
      scale < 1
        ? createImageBitmap(asset.blob, {
            resizeWidth: Math.max(1, Math.ceil(asset.widthPx * scale)),
            resizeHeight: Math.max(1, Math.ceil(asset.heightPx * scale)),
            resizeQuality: 'high',
          })
        : createImageBitmap(asset.blob);
    bitmaps.set(assetId, created);
    return created;
  };

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  return encodePng({
    width: widthPx,
    height: heightPx,
    dpi: opts.dpi,
    rowsPerStrip,
    ...(onProgress ? { onProgress } : {}),
    renderStrip: async (y0, rows) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, widthPx, rowsPerStrip);
      for (const p of placements) {
        if (p.bottom < y0 || p.top >= y0 + rows) continue;
        const image = await bitmap(p.design.assetId);
        const d = p.design;
        if (opts.mirror) ctx.setTransform(-1, 0, 0, 1, widthPx, 0);
        else ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(0, -y0);
        ctx.scale(pxPerMm, pxPerMm);
        ctx.translate(d.xMm, d.yMm);
        ctx.rotate((d.angleDeg * Math.PI) / 180);
        ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
        ctx.drawImage(image, -d.widthMm / 2, -d.heightMm / 2, d.widthMm, d.heightMm);
      }
      // Release images no later strip needs.
      for (const [assetId, last] of lastRow) {
        if (last < y0 + rows && bitmaps.has(assetId)) {
          (await bitmaps.get(assetId))?.close();
          bitmaps.delete(assetId);
          lastRow.delete(assetId);
        }
      }
      return ctx.getImageData(0, 0, widthPx, rows).data;
    },
  }).finally(async () => {
    for (const pending of bitmaps.values()) (await pending.catch(() => null))?.close();
  });
}
