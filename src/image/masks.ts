/**
 * Ink masks for images that came back from a saved sheet or a project file. Masks are not
 * stored: they are worked out again from the image when Real shape spacing first needs them,
 * one image at a time in the import worker, and handed to the store as they arrive.
 */
import { readMask } from '@/image/import';
import type { Store } from '@/store/store';

export interface MaskLoader {
  /** Starts reading the masks the sheet's designs still lack; returns at once. */
  want(): void;
  /** Resolves when every design on the sheet has its mask, or its image could not be read. */
  ready(): Promise<void>;
}

export function createMaskLoader(store: Store): MaskLoader {
  const pending = new Map<string, Promise<void>>();
  /** Images that could not be read: not tried again, their designs pack as rectangles. */
  const failed = new Set<string>();

  function want(): void {
    const { sheet, assets, masks } = store.get();
    for (const assetId of new Set(sheet.designs.map((d) => d.assetId))) {
      const asset = assets.get(assetId);
      if (!asset || masks.has(assetId) || pending.has(assetId) || failed.has(assetId)) continue;
      const job = readMask(asset)
        .then(
          (mask) => store.addMasks(new Map([[assetId, mask]])),
          () => void failed.add(assetId),
        )
        .finally(() => pending.delete(assetId));
      pending.set(assetId, job);
    }
  }

  async function ready(): Promise<void> {
    want();
    while (pending.size > 0) {
      await Promise.all(pending.values());
      // A sheet loaded meanwhile may need other images.
      want();
    }
  }

  return { want, ready };
}
