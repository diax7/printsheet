/**
 * Autosave in the browser (IndexedDB). Images are stored once each under `asset:<id>`; the
 * layout is stored under `sheet` a moment after each change. Images that neither the sheet nor
 * the undo history use any more are removed after a successful save.
 *
 * Several tabs share this storage. Two rules keep one tab from wrecking another's work: every save
 * rewrites any image it uses that is missing from storage (whatever it wrote before), and only the
 * tab holding the "printsheet-autosave" lock deletes images.
 */
import {
  createStore as createIdbStore,
  del,
  get,
  keys,
  set,
  setMany,
  type UseStore,
} from 'idb-keyval';
import { validateSheetLenient } from '@/model/validate';
import type { ImageAsset, Sheet } from '@/model/types';

const DB = 'printsheet';
const SHEET_KEY = 'sheet';
const ASSET_PREFIX = 'asset:';

interface StoredAsset {
  id: string;
  name: string;
  blob: Blob;
  widthPx: number;
  heightPx: number;
  hasTransparency: boolean;
}

export interface Autosave {
  /** Save the layout soon; `assets` are written at once if they are new. */
  schedule(sheet: Sheet, assets: ReadonlyMap<string, ImageAsset>, keep: ReadonlySet<string>): void;
  /**
   * The saved sheet and its images, or null when nothing is saved. Designs that cannot be used
   * are left out and counted in `dropped`, so one bad design never loses the whole sheet.
   */
  load(): Promise<{ sheet: Sheet; assets: Map<string, ImageAsset>; dropped: number } | null>;
  /** Stop saving (after a failed restore, so the broken data is not overwritten). */
  pause(paused: boolean): void;
  /** True when every change so far is safely stored (nothing waiting, nothing failed). */
  isSaved(): boolean;
}

export function createAutosave(
  onStatus: (status: { ok: boolean; message: string }) => void,
  delayMs = 500,
): Autosave {
  let db: UseStore | null = null;
  const store = (): UseStore => (db ??= createIdbStore(DB, 'keyval'));
  let timer: number | undefined;
  let chain: Promise<void> = Promise.resolve();
  let saved = true;
  let paused = false;
  let mayDelete = false;
  // Only one tab cleans up images; the lock is held for the life of the tab.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    void navigator.locks.request('printsheet-autosave', { ifAvailable: true }, (lock) => {
      if (!lock) return undefined;
      mayDelete = true;
      return new Promise<void>(() => undefined);
    });
  }

  async function save(
    sheet: Sheet,
    assets: ReadonlyMap<string, ImageAsset>,
    keep: ReadonlySet<string>,
  ): Promise<void> {
    const stored = new Set((await keys(store())).map(String));
    const fresh: Array<[string, StoredAsset]> = [];
    for (const id of new Set(sheet.designs.map((d) => d.assetId))) {
      if (stored.has(ASSET_PREFIX + id)) continue;
      const a = assets.get(id);
      if (a)
        fresh.push([
          ASSET_PREFIX + id,
          {
            id,
            name: a.name,
            blob: a.blob,
            widthPx: a.widthPx,
            heightPx: a.heightPx,
            hasTransparency: a.hasTransparency,
          },
        ]);
    }
    if (fresh.length) await setMany(fresh, store());
    await set(SHEET_KEY, { version: 1, sheet }, store());
    if (!mayDelete) return;
    const stale = [...stored].filter(
      (k) => k.startsWith(ASSET_PREFIX) && !keep.has(k.slice(ASSET_PREFIX.length)),
    );
    for (const key of stale) await del(key, store());
  }

  return {
    schedule(sheet, assets, keep) {
      saved = false;
      if (paused) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        chain = chain
          .then(() => save(sheet, assets, keep))
          .then(
            () => {
              saved = true;
              onStatus({ ok: true, message: 'Saved in this browser' });
            },
            (error: unknown) => {
              const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
              onStatus({
                ok: false,
                message: quota
                  ? 'Not saved: the browser is out of storage space. Use Save to keep a project file.'
                  : `Not saved: ${error instanceof Error ? error.message : String(error)}. Use Save to keep a project file.`,
              });
            },
          );
      }, delayMs);
    },

    async load() {
      const stored = (await get(SHEET_KEY, store())) as
        | { version?: number; sheet?: unknown }
        | undefined;
      if (!stored?.sheet) return null;
      const assets = new Map<string, ImageAsset>();
      for (const key of await keys(store())) {
        const k = String(key);
        if (!k.startsWith(ASSET_PREFIX)) continue;
        const a = (await get(k, store())) as StoredAsset | undefined;
        if (a && a.blob instanceof Blob) assets.set(a.id, { ...a });
      }
      // One unusable design (malformed, or its image is gone) never loses the rest of the sheet.
      const { sheet, dropped } = validateSheetLenient(stored.sheet, new Set(assets.keys()));
      return { sheet, assets, dropped };
    },

    pause(value) {
      paused = value;
      if (value) window.clearTimeout(timer);
    },

    isSaved: () => saved,
  };
}

/** Ask the browser not to evict saved work under storage pressure. */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted()))
      await navigator.storage.persist();
  } catch {
    // Not supported here; autosave still works, it may just be evicted under pressure.
  }
}

/** Warn when another tab is open: both would write the same autosave. */
export function watchOtherTabs(onOtherTab: () => void): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('printsheet');
  channel.addEventListener('message', (event: MessageEvent<string>) => {
    if (event.data === 'hello') channel.postMessage('here');
    if (event.data === 'hello' || event.data === 'here') onOtherTab();
  });
  channel.postMessage('hello');
}
