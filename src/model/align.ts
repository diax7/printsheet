/**
 * Align and distribute by footprint (the space a design takes on the film), so rotated designs
 * line up by what is actually printed. A single design aligns to the sheet (in a split job, to
 * its own sheet); several align to their combined bounds. Locked designs never move but still count as reference.
 */
import { contentLengthMm, footprint, unionFootprint, type Box } from '@/model/geometry';
import { bandHolding } from '@/model/pages';
import type { Design, Sheet } from '@/model/types';

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type Axis = 'horizontal' | 'vertical';

function shift(d: Design, box: Box, edge: AlignEdge, ref: Box): Design {
  switch (edge) {
    case 'left':
      return { ...d, xMm: d.xMm + (ref.minX - box.minX) };
    case 'right':
      return { ...d, xMm: d.xMm + (ref.maxX - box.maxX) };
    case 'center':
      return { ...d, xMm: d.xMm + ((ref.minX + ref.maxX) / 2 - (box.minX + box.maxX) / 2) };
    case 'top':
      return { ...d, yMm: d.yMm + (ref.minY - box.minY) };
    case 'bottom':
      return { ...d, yMm: d.yMm + (ref.maxY - box.maxY) };
    case 'middle':
      return { ...d, yMm: d.yMm + ((ref.minY + ref.maxY) / 2 - (box.minY + box.maxY) / 2) };
  }
}

/** What a single design aligns to: the whole sheet, or its own sheet in a split job. */
function sheetBox(sheet: Sheet, d: Design): Box {
  const s = sheet.settings;
  if (s.layout === 'split') {
    const band = bandHolding(d, s);
    return { minX: 0, minY: band.top, maxX: s.sheetWidthMm, maxY: band.bottom };
  }
  const maxY = s.lengthMode === 'fixed' ? s.fixedLengthMm : contentLengthMm(sheet.designs);
  return { minX: 0, minY: 0, maxX: s.sheetWidthMm, maxY };
}

export function align(sheet: Sheet, ids: readonly string[], edge: AlignEdge): Sheet {
  const wanted = new Set(ids);
  const selected = sheet.designs.filter((d) => wanted.has(d.id));
  if (selected.length === 0) return sheet;
  const first = selected[0] as Design;
  const ref = selected.length === 1 ? sheetBox(sheet, first) : (unionFootprint(selected) as Box);
  return {
    ...sheet,
    designs: sheet.designs.map((d) =>
      wanted.has(d.id) && !d.locked ? shift(d, footprint(d), edge, ref) : d,
    ),
  };
}

/**
 * Space three or more designs so the gaps between neighbouring footprints are equal. The first
 * and last designs along the axis stay where they are.
 */
export function distribute(sheet: Sheet, ids: readonly string[], axis: Axis): Sheet {
  const wanted = new Set(ids);
  const selected = sheet.designs.filter((d) => wanted.has(d.id));
  if (selected.length < 3) return sheet;
  const horizontal = axis === 'horizontal';
  const start = (b: Box): number => (horizontal ? b.minX : b.minY);
  const end = (b: Box): number => (horizontal ? b.maxX : b.maxY);
  const sorted = selected
    .map((d) => ({ d, box: footprint(d) }))
    .toSorted((a, b) => start(a.box) - start(b.box));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return sheet;
  const span = end(last.box) - start(first.box);
  const sizes = sorted.reduce((sum, s) => sum + (end(s.box) - start(s.box)), 0);
  const gap = (span - sizes) / (sorted.length - 1);
  const moved = new Map<string, Design>();
  let cursor = start(first.box);
  for (const { d, box } of sorted) {
    const delta = cursor - start(box);
    if (!d.locked && d !== first.d && d !== last.d) {
      moved.set(d.id, horizontal ? { ...d, xMm: d.xMm + delta } : { ...d, yMm: d.yMm + delta });
    }
    cursor += end(box) - start(box) + gap;
  }
  return { ...sheet, designs: sheet.designs.map((d) => moved.get(d.id) ?? d) };
}
