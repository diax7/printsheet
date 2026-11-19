/**
 * Before an export starts, every vector design is drawn afresh from its original file at the
 * size it prints at, and that drawing stands in for its image in this export only. The export
 * workers then treat it like any image: they never enlarge, and this is the largest size needed.
 *
 * Runs on the main thread, where the browser can draw an SVG.
 */
import { ExportCancelled } from '@/export/client';
import { vectorRenderSize } from '@/vector/render-size';
import { svgSize } from '@/vector/svg-size';
import { BlankRenderError, cropViewBox, renderSvg } from '@/vector/svg';
import type { Design, ImageAsset, VectorSource } from '@/model/types';

/** Draw one vector at a pixel size, as a PNG. */
async function drawVector(
  vector: VectorSource,
  widthPx: number,
  heightPx: number,
  name: string,
): Promise<Blob> {
  if (vector.type !== 'svg')
    throw new Error(`"${name}" is a kind of vector this build cannot draw.`);
  const text = await vector.blob.text();
  const size = svgSize(text);
  if (!size) throw new Error(`"${name}" could not be read again for printing.`);
  const canvas = await renderSvg(
    text,
    cropViewBox(size.viewBox, vector.crop),
    widthPx,
    heightPx,
    name,
  );
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!png) throw new Error(`"${name}" could not be kept after drawing it for printing.`);
  return png;
}

/**
 * The asset drawn at print size, halving the size when the browser comes back blank (a phone's
 * canvas limit) down to the image already held. A note says when it is drawn below `dpi`.
 */
async function drawForPrint(
  asset: ImageAsset & { vector: VectorSource },
  designs: readonly Design[],
  dpi: number,
): Promise<{ asset: ImageAsset; note?: string }> {
  const wanted = vectorRenderSize(designs, asset.id, dpi);
  if (!wanted) return { asset };
  let { widthPx, heightPx } = wanted;
  let drawnDpi = wanted.clampedDpi ?? dpi;
  while (widthPx > asset.widthPx || heightPx > asset.heightPx) {
    try {
      const blob = await drawVector(asset.vector, widthPx, heightPx, asset.name);
      const note =
        drawnDpi < dpi - 0.5
          ? `"${asset.name}" was drawn at ${Math.round(drawnDpi)} DPI, the most this browser can hold.`
          : undefined;
      return { asset: { ...asset, blob, widthPx, heightPx }, ...(note ? { note } : {}) };
    } catch (error) {
      if (!(error instanceof BlankRenderError)) throw error;
      widthPx = Math.floor(widthPx / 2);
      heightPx = Math.floor(heightPx / 2);
      drawnDpi /= 2;
    }
  }
  // The image made at import is already this large: it is used as it is.
  return {
    asset,
    note: `"${asset.name}" could not be drawn larger here and prints from its ${asset.widthPx} × ${asset.heightPx} px image.`,
  };
}

/**
 * The assets for an export, with every vector drawn at print size, and a note for each one the
 * browser could not draw at the full DPI. Stops with `ExportCancelled` when `signal` aborts.
 */
export async function renderVectorsForExport(
  designs: readonly Design[],
  assets: readonly ImageAsset[],
  dpi: number,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<{ assets: ImageAsset[]; notes: string[] }> {
  const vectors = assets.filter((a) => a.vector).length;
  const out: ImageAsset[] = [];
  const notes: string[] = [];
  let done = 0;
  for (const asset of assets) {
    if (signal.aborted) throw new ExportCancelled();
    if (!asset.vector) {
      out.push(asset);
      continue;
    }
    onProgress(done, vectors);
    const drawn = await drawForPrint({ ...asset, vector: asset.vector }, designs, dpi);
    out.push(drawn.asset);
    if (drawn.note) notes.push(drawn.note);
    onProgress(++done, vectors);
  }
  if (signal.aborted) throw new ExportCancelled();
  return { assets: out, notes };
}
