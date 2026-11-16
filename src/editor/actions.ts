/**
 * Editing actions shared by the inspector buttons and the keyboard, so both follow the same
 * rules: the design limit (everything made must also save and reopen) and locked designs being
 * protected from deletion.
 */
import { placeCopies, MAX_COPIES } from '@/model/arrange';
import { duplicateDesigns, removeDesigns, roomForDesigns } from '@/model/ops';
import { MAX_DESIGNS } from '@/model/types';
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
