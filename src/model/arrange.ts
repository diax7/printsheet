/**
 * Auto-arrange and add-copies, by bottom-left fill: each design goes to the highest, then
 * leftmost, free spot where its footprint keeps the cutting gap from everything already there.
 * Footprint boxes are compared, which is conservative for rotated designs (never closer than the
 * gap). Designs not being arranged (locked or unselected) are fixed obstacles.
 */
import { footprint, type Box } from '@/model/geometry';
import { normalizeAngle } from '@/model/ops';
import { Packer } from '@/model/packer';
import { bandsFor, fallbackTop, filmLengthMm, offSheetReason } from '@/model/pages';
import type { Design, Sheet } from '@/model/types';

export interface ArrangeOptions {
  allowRotate: boolean;
}

interface Size {
  w: number;
  h: number;
}

const EPS = 1e-6;

/** The most copies one "Add copies" can make; more is almost certainly a typing slip. */
export const MAX_COPIES = 500;

/** Move a design so its footprint's top-left lands on the spot. */
function moveTo(d: Design, spot: Box): Design {
  const fp = footprint(d);
  return { ...d, xMm: d.xMm + (spot.minX - fp.minX), yMm: d.yMm + (spot.minY - fp.minY) };
}

function sizeOf(d: Design): Size {
  const fp = footprint(d);
  return { w: fp.maxX - fp.minX, h: fp.maxY - fp.minY };
}

/** Place `items` one by one around `fixed`; returns the placed designs in input order. */
function fill(
  items: readonly Design[],
  fixed: readonly Design[],
  sheet: Sheet,
  rotate: boolean,
): Design[] {
  const { sheetWidthMm: width, gapMm: gap } = sheet.settings;
  const packer = new Packer(width, gap, fixed.map(footprint), bandsFor(sheet.settings));
  let lowest = Math.max(0, ...fixed.map((d) => footprint(d).maxY + gap));
  const order = items
    .map((d, index) => ({ d, index, size: sizeOf(d) }))
    .toSorted(
      (a, b) =>
        Math.max(b.size.w, b.size.h) - Math.max(a.size.w, a.size.h) ||
        b.size.h - a.size.h ||
        a.index - b.index,
    );
  const placed = new Map<number, Design>();
  for (const { d, index } of order) {
    const options = rotate ? [d, { ...d, angleDeg: normalizeAngle(d.angleDeg + 90) }] : [d];
    let best: { design: Design; spot: Box } | null = null;
    for (const option of options) {
      const size = sizeOf(option);
      const spot = packer.find(size.w, size.h);
      if (!spot) continue;
      if (
        !best ||
        spot.maxY < best.spot.maxY - EPS ||
        (Math.abs(spot.maxY - best.spot.maxY) < EPS && spot.minX < best.spot.minX)
      ) {
        best = { design: option, spot };
      }
    }
    // A design that fits nowhere is placed at the left edge below everything (one long sheet)
    // or at the top of the first sheet after those in use, where a warning points it out.
    const fallback =
      sheet.settings.layout === 'split'
        ? fallbackTop({ ...sheet, designs: [...fixed, ...placed.values()] })
        : lowest;
    const result = best
      ? moveTo(best.design, best.spot)
      : moveTo(d, { minX: 0, minY: fallback, maxX: 0, maxY: 0 });
    const box = footprint(result);
    packer.add(box);
    lowest = Math.max(lowest, box.maxY + gap);
    placed.set(index, result);
  }
  return items.map((_, i) => placed.get(i) as Design);
}

/**
 * Pack the chosen designs to save film. With rotation allowed, both the rotated and unrotated
 * packings are tried and the shorter one wins, so allowing rotation never makes it longer.
 */
export function autoArrange(
  sheet: Sheet,
  ids: readonly string[] | 'all',
  options: ArrangeOptions,
): Sheet {
  const wanted = ids === 'all' ? null : new Set(ids);
  const isMoving = (d: Design): boolean => !d.locked && (wanted === null || wanted.has(d.id));
  const moving = sheet.designs.filter(isMoving);
  const fixed = sheet.designs.filter((d) => !isMoving(d));
  if (moving.length === 0) return sheet;

  const candidates = [fill(moving, fixed, sheet, false)];
  if (options.allowRotate) candidates.push(fill(moving, fixed, sheet, true));
  // Fitting matters more than length: a short layout that leaves a design hanging off the edge,
  // or on no sheet of a split job, is not a valid print.
  const overflowOf = (placed: Design[]): number =>
    placed.filter(
      (d) =>
        footprint(d).maxX > sheet.settings.sheetWidthMm + EPS ||
        (sheet.settings.layout === 'split' && offSheetReason(d, sheet.settings) !== null),
    ).length;
  const lengthOf = (placed: Design[]): number =>
    filmLengthMm({ ...sheet, designs: [...fixed, ...placed] });
  const better = (a: Design[], b: Design[]): Design[] => {
    const overflow = overflowOf(b) - overflowOf(a);
    if (overflow !== 0) return overflow < 0 ? b : a;
    return lengthOf(b) < lengthOf(a) ? b : a;
  };
  const best = candidates.reduce(better);

  const byId = new Map(best.map((d) => [d.id, d]));
  return { ...sheet, designs: sheet.designs.map((d) => byId.get(d.id) ?? d) };
}

/** Add `count` copies of a design in the first free spots, keeping the cutting gap. */
export function placeCopies(
  sheet: Sheet,
  id: string,
  count: number,
  newId: () => string,
): { sheet: Sheet; newIds: string[] } {
  const original = sheet.designs.find((d) => d.id === id);
  if (!original || count < 1) return { sheet, newIds: [] };
  const copies = Array.from({ length: Math.min(count, MAX_COPIES) }, () => ({
    ...original,
    id: newId(),
    locked: false,
  }));
  const placed = fill(copies, sheet.designs, sheet, false);
  return {
    sheet: { ...sheet, designs: [...sheet.designs, ...placed] },
    newIds: placed.map((d) => d.id),
  };
}

/**
 * Moves the given designs that are on no sheet of a split job (across a split) into the first
 * free spots, leaving everything else where it is. The one-click fix after splitting a layout
 * placed by hand. Locked designs stay put.
 */
export function moveOntoSheets(sheet: Sheet, ids: readonly string[]): Sheet {
  const wanted = new Set(ids);
  const isMoving = (d: Design): boolean =>
    wanted.has(d.id) && !d.locked && offSheetReason(d, sheet.settings) !== null;
  const moving = sheet.designs.filter(isMoving);
  if (moving.length === 0) return sheet;
  const fixed = sheet.designs.filter((d) => !isMoving(d));
  const placed = fill(moving, fixed, sheet, false);
  // Nothing found room (every sheet full): leave the sheet as it was, so no empty undo step.
  if (placed.every((d) => offSheetReason(d, sheet.settings) !== null)) return sheet;
  const byId = new Map(placed.map((d) => [d.id, d]));
  return { ...sheet, designs: sheet.designs.map((d) => byId.get(d.id) ?? d) };
}
