/**
 * Autosave in the browser (IndexedDB). Images are stored once each under `asset:<id>`; the
 * layout is stored under `sheet` a moment after each change. Images that neither the sheet nor
 * the undo history use any more are removed after a successful save.
 *
 * A vector design's original file is stored once under `source:<sourceId>`, however many designs
 * (pages of one PDF) are cut from it.
 *
 * Several tabs share this storage. Two rules keep one tab from wrecking another's work: every save
 * rewrites any image or source file it uses that is missing from storage (whatever it wrote
 * before), and only the tab holding the "printsheet-autosave" lock deletes them.
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
import { formatVersion, PROJECT_VERSION } from '@/store/project-file';
import type { FileFormat, ImageAsset, Sheet, VectorSource } from '@/model/types';
import { isFileFormat } from '@/image/format';

const DB = 'printsheet';
const SHEET_KEY = 'sheet';
const ASSET_PREFIX = 'asset:';
const SOURCE_PREFIX = 'source:';

interface StoredAsset {
  id: string;
  name: string;
  blob: Blob;
  widthPx: number;
  heightPx: number;
  hasTransparency: boolean;
  format?: FileFormat;
  vector?: Omit<VectorSource, 'blob'>;
}

interface StoredSource {
  id: string;
  blob: Blob;
}

function toStored(a: ImageAsset): StoredAsset {
  const stored: StoredAsset = {
    id: a.id,
    name: a.name,
    blob: a.blob,
    widthPx: a.widthPx,
    heightPx: a.heightPx,
    hasTransparency: a.hasTransparency,
    ...(a.format ? { format: a.format } : {}),
  };
  if (a.vector) {
    const { blob: _blob, ...vector } = a.vector;
    stored.vector = vector;
  }
  return stored;
}

/** A stored image back in memory; a vector whose source file is gone stays a plain image. */
function fromStored(a: StoredAsset, sources: ReadonlyMap<string, Blob>): ImageAsset {
  const { format, vector, ...rest } = a;
  const blob = vector && sources.get(vector.sourceId);
  return {
    ...rest,
    ...(isFileFormat(format) ? { format } : {}),
    ...(vector && blob ? { vector: { ...vector, blob } } : {}),
  };
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
  /** The sheet just loaded is exactly what is stored: drop the save its loading scheduled. */
  adopt(): void;
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
  let lastOk = true;
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
    const fresh: Array<[string, StoredAsset | StoredSource]> = [];
    for (const id of new Set(sheet.designs.map((d) => d.assetId))) {
      const a = assets.get(id);
      if (!a) continue;
      const source = a.vector && SOURCE_PREFIX + a.vector.sourceId;
      if (a.vector && source && !stored.has(source) && !fresh.some(([k]) => k === source)) {
        fresh.push([source, { id: a.vector.sourceId, blob: a.vector.blob }]);
      }
      if (!stored.has(ASSET_PREFIX + id)) fresh.push([ASSET_PREFIX + id, toStored(a)]);
    }
    if (fresh.length) await setMany(fresh, store());
    await set(SHEET_KEY, { version: formatVersion(sheet, assets), sheet }, store());
    if (!mayDelete) return;
    const stale = [...stored].filter(
      (k) => k.startsWith(ASSET_PREFIX) && !keep.has(k.slice(ASSET_PREFIX.length)),
    );
    // A source file goes only when no kept image needs it. If a kept image is not in memory,
    // which source it needs is unknown here, so no source is removed this time.
    const keptSources = new Set<string>();
    let allKnown = true;
    for (const id of keep) {
      const a = assets.get(id);
      if (!a) allKnown = false;
      else if (a.vector) keptSources.add(a.vector.sourceId);
    }
    if (allKnown) {
      stale.push(
        ...[...stored].filter(
          (k) => k.startsWith(SOURCE_PREFIX) && !keptSources.has(k.slice(SOURCE_PREFIX.length)),
        ),
      );
    }
    for (const key of stale) await del(key, store());
  }

  return {
    schedule(sheet, assets, keep) {
      saved = false;
      if (paused) return;
      // "Saved" must not stay on screen while a newer change waits; a failure message stays up.
      if (lastOk) onStatus({ ok: true, message: 'Saving…' });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        chain = chain
          .then(() => save(sheet, assets, keep))
          .then(
            () => {
              saved = true;
              lastOk = true;
              onStatus({ ok: true, message: 'Saved in this browser' });
            },
            (error: unknown) => {
              lastOk = false;
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
      // A newer build may have saved a format this one would misread; refuse it, untouched.
      if ((stored.version ?? 1) > PROJECT_VERSION) {
        throw new Error('it was saved by a newer version of PrintSheet. Reload the page to update');
      }
      const all = (await keys(store())).map(String);
      const sources = new Map<string, Blob>();
      for (const k of all.filter((key) => key.startsWith(SOURCE_PREFIX))) {
        const s = (await get(k, store())) as StoredSource | undefined;
        if (s && s.blob instanceof Blob) sources.set(s.id, s.blob);
      }
      const assets = new Map<string, ImageAsset>();
      for (const k of all.filter((key) => key.startsWith(ASSET_PREFIX))) {
        const a = (await get(k, store())) as StoredAsset | undefined;
        if (a && a.blob instanceof Blob) assets.set(a.id, fromStored(a, sources));
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

    adopt() {
      window.clearTimeout(timer);
      saved = true;
    },
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
