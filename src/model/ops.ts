/**
 * Pure sheet operations. Each takes a sheet and returns a new one; the input is never changed,
 * which is what makes undo/redo a simple stack of snapshots.
 */
import { footprint, unionFootprint } from '@/model/geometry';
import { MAX_DESIGNS, type Design, type Sheet } from '@/model/types';

export type ReorderTarget = 'forward' | 'back' | 'front' | 'bottom';

export function addDesign(sheet: Sheet, design: Design): Sheet {
  return { ...sheet, designs: [...sheet.designs, design] };
}

export function addDesigns(sheet: Sheet, designs: readonly Design[]): Sheet {
  return { ...sheet, designs: [...sheet.designs, ...designs] };
}

export function updateDesign(sheet: Sheet, id: string, patch: Partial<Omit<Design, 'id'>>): Sheet {
  return {
    ...sheet,
    designs: sheet.designs.map((d) => (d.id === id ? { ...d, ...patch } : d)),
  };
}

/** Apply several patches at once (one undo step for a multi-design gesture). */
export function updateDesigns(
  sheet: Sheet,
  patches: ReadonlyMap<string, Partial<Omit<Design, 'id'>>>,
): Sheet {
  return {
    ...sheet,
    designs: sheet.designs.map((d) => {
      const patch = patches.get(d.id);
      return patch ? { ...d, ...patch } : d;
    }),
  };
}

export function removeDesigns(sheet: Sheet, ids: readonly string[]): Sheet {
  const drop = new Set(ids);
  return { ...sheet, designs: sheet.designs.filter((d) => !drop.has(d.id)) };
}

/**
 * Copy the designs as a group, placed to the right of the group with the cutting gap when it
 * fits within the sheet width, otherwise directly below it.
 */
export function duplicateDesigns(
  sheet: Sheet,
  ids: readonly string[],
  newId: () => string,
): { sheet: Sheet; newIds: string[] } {
  const wanted = new Set(ids);
  const originals = sheet.designs.filter((d) => wanted.has(d.id));
  const box = unionFootprint(originals);
  if (!box) return { sheet, newIds: [] };
  const { gapMm, sheetWidthMm } = sheet.settings;
  const groupWidth = box.maxX - box.minX;
  const fitsRight = box.maxX + gapMm + groupWidth <= sheetWidthMm + 1e-6;
  const dx = fitsRight ? groupWidth + gapMm : 0;
  const dy = fitsRight ? 0 : box.maxY - box.minY + gapMm;
  const copies = originals.map((d) => ({
    ...d,
    id: newId(),
    xMm: d.xMm + dx,
    yMm: d.yMm + dy,
    locked: false,
  }));
  return { sheet: addDesigns(sheet, copies), newIds: copies.map((c) => c.id) };
}

/** Change stacking order: one step forward/back, or all the way to the front/bottom. */
export function reorder(sheet: Sheet, id: string, target: ReorderTarget): Sheet {
  const index = sheet.designs.findIndex((d) => d.id === id);
  const item = sheet.designs[index];
  if (!item) return sheet;
  const rest = sheet.designs.filter((d) => d.id !== id);
  const last = sheet.designs.length - 1;
  const destination = {
    forward: Math.min(index + 1, last),
    back: Math.max(index - 1, 0),
    front: last,
    bottom: 0,
  }[target];
  rest.splice(destination, 0, item);
  return { ...sheet, designs: rest };
}

export function normalizeAngle(deg: number): number {
  const a = ((deg % 360) + 360) % 360;
  return Math.abs(a - 360) < 1e-9 ? 0 : a;
}

/** Rotate unlocked designs by a number of degrees around their own centres. */
export function rotateBy(sheet: Sheet, ids: readonly string[], deltaDeg: number): Sheet {
  const wanted = new Set(ids);
  return {
    ...sheet,
    designs: sheet.designs.map((d) =>
      wanted.has(d.id) && !d.locked ? { ...d, angleDeg: normalizeAngle(d.angleDeg + deltaDeg) } : d,
    ),
  };
}

/** Shift a design so its footprint's left edge stays inside the sheet where it can. */
function keepInsideWidth(d: Design, sheetWidthMm: number): Design {
  const box = footprint(d);
  let dx = 0;
  if (box.maxX > sheetWidthMm) dx = sheetWidthMm - box.maxX;
  if (box.minX + dx < 0) dx = -box.minX;
  return dx === 0 ? d : { ...d, xMm: d.xMm + dx };
}

/**
 * Set a design's size the way people expect from typing it: the top-left corner of its footprint
 * stays put (instead of growing around the centre and off the sheet), then it slides left if it
 * would cross the right edge.
 */
export function resizeKeepingCorner(
  sheet: Sheet,
  id: string,
  widthMm: number,
  heightMm: number,
): Sheet {
  return {
    ...sheet,
    designs: sheet.designs.map((d) => {
      if (d.id !== id) return d;
      const before = footprint(d);
      const resized = { ...d, widthMm, heightMm };
      const after = footprint(resized);
      const anchored = {
        ...resized,
        xMm: resized.xMm + before.minX - after.minX,
        yMm: resized.yMm + before.minY - after.minY,
      };
      return keepInsideWidth(anchored, sheet.settings.sheetWidthMm);
    }),
  };
}

/**
 * Bring designs that cross an edge back onto the sheet: shrink (keeping proportions) any whose
 * footprint is wider than the sheet, then move them inside the side and top edges.
 */
export function moveOntoSheet(sheet: Sheet, ids: readonly string[]): Sheet {
  const wanted = new Set(ids);
  const width = sheet.settings.sheetWidthMm;
  return {
    ...sheet,
    designs: sheet.designs.map((d) => {
      if (!wanted.has(d.id)) return d;
      let next = d;
      const box = footprint(next);
      const span = box.maxX - box.minX;
      if (span > width) {
        const scale = width / span;
        next = { ...next, widthMm: next.widthMm * scale, heightMm: next.heightMm * scale };
      }
      next = keepInsideWidth(next, width);
      const top = footprint(next).minY;
      if (top < 0) next = { ...next, yMm: next.yMm - top };
      return next;
    }),
  };
}

/** How many more designs the sheet can hold before the design limit. */
export function roomForDesigns(sheet: Sheet): number {
  return Math.max(0, MAX_DESIGNS - sheet.designs.length);
}
