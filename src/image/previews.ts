/**
 * Screen previews: one downscaled canvas per image, shared by every copy on the sheet. The
 * screen never needs more than 2048 px per side; exports always use the full image.
 */
import type { ImageAsset } from '@/model/types';

export const PREVIEW_MAX_SIDE = 2048;
const THUMB_SIDE = 240;

export interface Preview {
  canvas: HTMLCanvasElement;
  /** Small PNG data URL for the design list and inspector. */
  thumbUrl: string;
}

const cache = new Map<string, Promise<Preview>>();
const ready = new Map<string, Preview>();

async function render(asset: ImageAsset, maxSide: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, maxSide / Math.max(asset.widthPx, asset.heightPx));
  const width = Math.max(1, Math.round(asset.widthPx * scale));
  const height = Math.max(1, Math.round(asset.heightPx * scale));
  const bitmap = await createImageBitmap(asset.blob, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** The preview for an asset, created once. */
export function loadPreview(asset: ImageAsset): Promise<Preview> {
  const existing = cache.get(asset.id);
  if (existing) return existing;
  const created = (async () => {
    const canvas = await render(asset, PREVIEW_MAX_SIDE);
    const thumb = await render(asset, THUMB_SIDE);
    const preview = { canvas, thumbUrl: thumb.toDataURL('image/png') };
    ready.set(asset.id, preview);
    return preview;
  })();
  created.catch(() => cache.delete(asset.id));
  cache.set(asset.id, created);
  return created;
}

/** The preview if it has finished loading. */
export function readyPreview(assetId: string): Preview | undefined {
  return ready.get(assetId);
}

/** Forget previews of images no longer in use (after opening a project or a new sheet). */
export function evictPreviews(keep: ReadonlySet<string>): void {
  for (const id of cache.keys()) {
    if (!keep.has(id)) {
      cache.delete(id);
      ready.delete(id);
    }
  }
}
