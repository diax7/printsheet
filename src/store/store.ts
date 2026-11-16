/**
 * The app's single source of truth: the sheet (with undo history), the images, and the current
 * selection. Views subscribe and re-render from it; they change it only through these methods.
 */
import { History } from '@/store/history';
import type { ImageAsset, Sheet } from '@/model/types';

export interface AppState {
  sheet: Sheet;
  assets: ReadonlyMap<string, ImageAsset>;
  selection: readonly string[];
}

export type Listener = (state: AppState, previous: AppState) => void;

export interface CommitOptions {
  /** Selection to set together with the change (e.g. the designs just added). */
  selection?: readonly string[];
  /** Consecutive commits with the same key within MERGE_WINDOW_MS form one undo step. */
  mergeKey?: string;
}

export interface Store {
  get(): AppState;
  commit(next: Sheet, options?: CommitOptions): void;
  setSelection(ids: readonly string[]): void;
  addAssets(assets: readonly ImageAsset[]): void;
  load(sheet: Sheet, assets: ReadonlyMap<string, ImageAsset>): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Assets used by the sheet or by any state undo/redo can return to. */
  referencedAssetIds(): Set<string>;
  subscribe(listener: Listener): () => void;
}

const MERGE_WINDOW_MS = 600;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Keep only selected ids that still exist on the sheet. */
function liveSelection(sheet: Sheet, ids: readonly string[]): string[] {
  const present = new Set(sheet.designs.map((d) => d.id));
  return ids.filter((id) => present.has(id));
}

export function createStore(
  initial: Sheet,
  clock: { now: () => number } = { now: () => Date.now() },
): Store {
  const history = new History<Sheet>(initial);
  let state: AppState = { sheet: initial, assets: new Map(), selection: [] };
  let lastMerge: { key: string; at: number } | null = null;
  const listeners = new Set<Listener>();

  const emit = (next: AppState): void => {
    const previous = state;
    state = next;
    for (const listener of listeners) listener(state, previous);
  };

  const travel = (sheet: Sheet | null): void => {
    if (!sheet) return;
    lastMerge = null;
    emit({ ...state, sheet, selection: liveSelection(sheet, state.selection) });
  };

  return {
    get: () => state,

    commit(next, options = {}) {
      if (next === state.sheet) return;
      const now = clock.now();
      const merging =
        options.mergeKey !== undefined &&
        lastMerge !== null &&
        lastMerge.key === options.mergeKey &&
        now - lastMerge.at < MERGE_WINDOW_MS;
      if (merging) history.replace(next);
      else history.push(next);
      lastMerge = options.mergeKey === undefined ? null : { key: options.mergeKey, at: now };
      emit({
        ...state,
        sheet: next,
        selection: liveSelection(next, options.selection ?? state.selection),
      });
    },

    setSelection(ids) {
      const next = liveSelection(state.sheet, ids);
      if (sameIds(next, state.selection)) return;
      emit({ ...state, selection: next });
    },

    addAssets(assets) {
      const map = new Map(state.assets);
      for (const a of assets) map.set(a.id, a);
      emit({ ...state, assets: map });
    },

    load(sheet, assets) {
      history.reset(sheet);
      lastMerge = null;
      emit({ sheet, assets: new Map(assets), selection: [] });
    },

    undo: () => travel(history.undo()),
    redo: () => travel(history.redo()),
    canUndo: () => history.canUndo,
    canRedo: () => history.canRedo,

    referencedAssetIds() {
      const ids = new Set<string>();
      for (const sheet of history.all()) for (const d of sheet.designs) ids.add(d.assetId);
      return ids;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
