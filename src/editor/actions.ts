/**
 * Editing actions shared by the inspector, the floating action bar, its menus and the keyboard,
 * so all of them follow the same rules: the design limit (everything made must also save and
 * reopen) and locked designs being protected from deletion.
 */
import { moveOntoSheets, placeCopies, MAX_COPIES } from '@/model/arrange';
import {
  duplicateDesigns,
  moveOntoSheet,
  removeDesigns,
  roomForDesigns,
  updateDesign,
  updateDesigns,
} from '@/model/ops';
import { offSheetReason } from '@/model/pages';
import { MAX_DESIGNS, type Design } from '@/model/types';
import { toast } from '@/editor/dom';
import type { Store } from '@/store/store';

/** A new design id (a full random UUID, so ids never collide even on huge sheets). */
export const newId = (): string => `d-${crypto.randomUUID()}`;

const LIMIT_MESSAGE = `A sheet holds at most ${MAX_DESIGNS} designs. Start a second sheet for the rest.`;

export function duplicateSelected(store: Store, ids: readonly string[]): void {
  const { sheet } = store.get();
  if (ids.length === 0) return;
  if (roomForDesigns(sheet) < ids.length) {
    toast(LIMIT_MESSAGE, 'error');
    return;
  }
  const result = duplicateDesigns(sheet, ids, newId);
  store.commit(result.sheet, { selection: result.newIds });
}

/** Add `count` copies of one design; returns false when the request was refused. */
export function addCopies(store: Store, id: string, name: string, count: number): boolean {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COPIES) {
    toast(`Enter a number of copies from 1 to ${MAX_COPIES}.`, 'error');
    return false;
  }
  const { sheet } = store.get();
  if (roomForDesigns(sheet) < count) {
    toast(LIMIT_MESSAGE, 'error');
    return false;
  }
  const result = placeCopies(sheet, id, count, newId);
  store.commit(result.sheet, { selection: [id, ...result.newIds] });
  toast(`Added ${count} ${count === 1 ? 'copy' : 'copies'} of "${name}".`);
  return true;
}

/** Delete the designs that are not locked; locked ones stay and the user is told. */
export function deleteUnlocked(store: Store, ids: readonly string[]): void {
  const { sheet } = store.get();
  const wanted = new Set(ids);
  const removable = sheet.designs.filter((d) => wanted.has(d.id) && !d.locked).map((d) => d.id);
  if (removable.length < wanted.size) toast('Locked designs were kept. Unlock them to delete.');
  if (removable.length) store.commit(removeDesigns(sheet, removable), { selection: [] });
}

/** Lock all the designs, or unlock them all when any of them is locked (one undo step). */
export function toggleLock(store: Store, ids: readonly string[]): void {
  const { sheet } = store.get();
  const anyLocked = sheet.designs.some((d) => d.locked && ids.includes(d.id));
  store.commit(updateDesigns(sheet, new Map(ids.map((id) => [id, { locked: !anyLocked }]))));
}

/**
 * Alt + drag: the dragged designs go where they were dropped and unlocked copies stay where they
 * started, in one commit, so one undo takes back both. Each copy goes just under its original in
 * the stacking order, so it overlaps its neighbours exactly as the original did. When the sheet
 * has no room for the copies, the designs still move and the user is told why no copy was made.
 */
export function moveLeavingCopies(
  store: Store,
  patches: ReadonlyMap<string, Partial<Design>>,
): void {
  const { sheet } = store.get();
  const moved = updateDesigns(sheet, patches);
  if (roomForDesigns(sheet) < patches.size) {
    toast(LIMIT_MESSAGE, 'error');
    store.commit(moved);
    return;
  }
  const designs = moved.designs.flatMap((d, i) => {
    const original = sheet.designs[i];
    return original && patches.has(d.id) ? [{ ...original, id: newId(), locked: false }, d] : [d];
  });
  store.commit({ ...moved, designs }, { selection: [...patches.keys()] });
}

/**
 * Mirror one design across its vertical (x) or horizontal (y) axis, reading it from the store
 * at the moment of the click; a locked design stays as it is.
 */
export function flip(store: Store, id: string, axis: 'x' | 'y'): void {
  const { sheet } = store.get();
  const d = sheet.designs.find((x) => x.id === id);
  if (!d || d.locked) return;
  store.commit(updateDesign(sheet, id, axis === 'x' ? { flipX: !d.flipX } : { flipY: !d.flipY }));
}

/** A button that puts designs back on the sheet: its label and what it does. */
export interface SheetFix {
  label: string;
  run(): void;
}

/**
 * The fix for designs that are not wholly on the sheet, or null when none is needed. A design
 * across a split between sheets gets "Move onto a sheet", which also fixes the top edge, so the
 * plain "Move onto the sheet" (for the side and top edges) is offered only when no design
 * crosses a split. `outside` holds the ids found past an edge (from the sheet checks).
 */
export function sheetFix(
  store: Store,
  ids: readonly string[],
  outside: ReadonlySet<string>,
): SheetFix | null {
  const { sheet } = store.get();
  const settings = sheet.settings;
  const chosen = sheet.designs.filter((d) => ids.includes(d.id));
  const crossing = chosen
    .filter((d) => settings.layout === 'split' && offSheetReason(d, settings) === 'crossing')
    .map((d) => d.id);
  if (crossing.length)
    return { label: 'Move onto a sheet', run: () => moveOntoASheet(store, crossing) };
  const over = chosen.filter((d) => outside.has(d.id)).map((d) => d.id);
  if (over.length === 0) return null;
  return {
    label: 'Move onto the sheet',
    run: () => store.commit(moveOntoSheet(store.get().sheet, over)),
  };
}

function moveOntoASheet(store: Store, ids: readonly string[]): void {
  const sheet = store.get().sheet;
  const next = moveOntoSheets(sheet, ids);
  if (next === sheet)
    toast(
      `No sheet has room for ${ids.length === 1 ? 'it' : 'them'}. Remove designs or make the sheets longer.`,
      'error',
    );
  else store.commit(next);
}
