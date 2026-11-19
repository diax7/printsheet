import {
  corners,
  dpiLevel,
  effectiveDpi,
  footprint,
  polygonDistance,
  type Box,
  sheetLengthMm,
  contentLengthMm,
} from '@/model/geometry';
import { fullMask, type ShapeMask } from '@/model/mask';
import { offSheetReason, onDifferentPages, type OffSheetReason } from '@/model/pages';
import { inkTooClose, poseCells, type Posed } from '@/model/raster';
import {
  MAX_SHEET_LENGTH_MM,
  type Design,
  type ImageAsset,
  type Point,
  type Sheet,
} from '@/model/types';
import { formatCm } from '@/model/units';

export type IssueKind =
  | 'low-dpi'
  | 'ok-dpi'
  | 'no-transparency'
  | 'outside'
  | 'off-sheet'
  | 'too-close'
  | 'past-length';

export interface Issue {
  kind: IssueKind;
  otherId?: string;
}

/** Tolerance for "touching the edge": a design flush with the edge is not outside. */
const EDGE_EPSILON_MM = 0.01;

/** True when the design's footprint crosses the left, right or top edge of the sheet. */
export function isOutside(d: Design, sheetWidthMm: number): boolean {
  const box = footprint(d);
  return (
    box.minX < -EDGE_EPSILON_MM ||
    box.minY < -EDGE_EPSILON_MM ||
    box.maxX > sheetWidthMm + EDGE_EPSILON_MM
  );
}

export type Masks = ReadonlyMap<string, ShapeMask>;

/** The last answer per sheet: views ask again on every render, and sheets never change. */
const remembered = new WeakMap<
  Sheet,
  {
    assets: ReadonlyMap<string, ImageAsset>;
    masks: Masks | undefined;
    issues: Map<string, Issue[]>;
  }
>();

/**
 * Every problem on the sheet, keyed by design id. Designs with no issue are absent.
 *
 * Args:
 *   sheet: The sheet to check.
 *   assets: The images, for the sharpness and transparency checks.
 *   masks: Ink masks by asset id. With Real shape spacing the "too close" check measures
 *     between ink outlines; a design whose mask is missing counts as its whole rectangle.
 */
export function findIssues(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
  masks?: Masks,
): Map<string, Issue[]> {
  const known = remembered.get(sheet);
  if (known && known.assets === assets && known.masks === masks) return known.issues;
  const issues = computeIssues(sheet, assets, masks);
  remembered.set(sheet, { assets, masks, issues });
  return issues;
}

function computeIssues(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
  masks: Masks | undefined,
): Map<string, Issue[]> {
  const result = new Map<string, Issue[]>();
  const add = (id: string, issue: Issue): void => {
    const list = result.get(id) ?? [];
    list.push(issue);
    result.set(id, list);
  };
  const { sheetWidthMm, lengthMode, fixedLengthMm, layout } = sheet.settings;

  for (const d of sheet.designs) {
    const asset = assets.get(d.assetId);
    // A vector is drawn afresh at print size, so it is sharp at any size.
    if (asset && !asset.vector) {
      const level = dpiLevel(effectiveDpi(d, asset));
      if (level === 'low') add(d.id, { kind: 'low-dpi' });
      if (level === 'ok') add(d.id, { kind: 'ok-dpi' });
    }
    if (asset) {
      if (!asset.hasTransparency) add(d.id, { kind: 'no-transparency' });
    }
    const box = footprint(d);
    if (isOutside(d, sheetWidthMm)) add(d.id, { kind: 'outside' });
    if (layout === 'split' && offSheetReason(d, sheet.settings)) add(d.id, { kind: 'off-sheet' });
    // The fixed length belongs to one long sheet; a split job's sheets have their own length.
    if (
      layout === 'single' &&
      lengthMode === 'fixed' &&
      box.maxY > fixedLengthMm + EDGE_EPSILON_MM
    ) {
      add(d.id, { kind: 'past-length' });
    }
  }

  for (const [a, b] of tooClosePairs(sheet, masks)) {
    add(a, { kind: 'too-close', otherId: b });
    add(b, { kind: 'too-close', otherId: a });
  }
  return result;
}

interface Swept {
  d: Design;
  order: number;
  box: Box;
  poly: Point[];
  /** The design's ink cells, worked out the first time a pair needs them. */
  pose?: Posed;
}

/** Stands in for a mask that is not there yet: all ink, so the design counts as its rectangle. */
const ALL_INK = fullMask();

/**
 * True when the ink of two designs may be closer than the gap. Their rectangles are already
 * known to be: ink never leaves its rectangle, so rectangles a gap apart need no second look.
 * A design without a mask yet counts as all ink, exactly as the shape packer places it.
 */
function inkCloser(p: Swept, q: Swept, gapMm: number, masks: Masks): boolean {
  p.pose ??= poseCells(p.d, masks.get(p.d.assetId) ?? ALL_INK);
  q.pose ??= poseCells(q.d, masks.get(q.d.assetId) ?? ALL_INK);
  return inkTooClose(p.pose, q.pose, gapMm);
}

/**
 * Pairs of designs closer than the cutting gap. Sweep and prune: designs are sorted by the left
 * edge of their footprint, and a pair is only measured exactly when the footprints, grown by
 * the gap, overlap. That keeps hundreds of designs fast.
 */
function tooClosePairs(sheet: Sheet, masks: Masks | undefined): Array<[string, string]> {
  const gap = sheet.settings.gapMm - EDGE_EPSILON_MM;
  const split = sheet.settings.layout === 'split';
  const shape = sheet.settings.spacing === 'shape' && masks !== undefined;
  const items: Swept[] = sheet.designs
    .map((d, order) => ({ d, order, box: footprint(d), poly: corners(d) }))
    .toSorted((p, q) => p.box.minX - q.box.minX);
  const pairs: Array<{ a: number; b: number; ids: [string, string] }> = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    if (!p) continue;
    for (let j = i + 1; j < items.length; j++) {
      const q = items[j];
      if (!q) continue;
      if (q.box.minX >= p.box.maxX + gap) break;
      if (q.box.minY >= p.box.maxY + gap || p.box.minY >= q.box.maxY + gap) continue;
      if (split && onDifferentPages(p.d, q.d, sheet.settings)) continue;
      if (polygonDistance(p.poly, q.poly) >= gap) continue;
      if (!shape || inkCloser(p, q, sheet.settings.gapMm, masks)) {
        const [first, second] = p.order < q.order ? [p, q] : [q, p];
        pairs.push({ a: first.order, b: second.order, ids: [first.d.id, second.d.id] });
      }
    }
  }
  // Stacking order, so the reported order does not depend on the sweep.
  return pairs.toSorted((x, y) => x.a - y.a || x.b - y.b).map((p) => p.ids);
}

/** Why the sheet cannot be exported right now, or null when it can. */
export function exportBlocker(sheet: Sheet): string | null {
  if (sheet.designs.length === 0) return 'The sheet is empty. Add at least one design.';
  const length = Math.max(sheetLengthMm(sheet), contentLengthMm(sheet.designs));
  // A split job's sheets are at most 5 m each by their settings; only one long sheet can pass it.
  if (sheet.settings.layout === 'single' && length > MAX_SHEET_LENGTH_MM) {
    return 'The sheet is longer than 5 m, the most one file can hold. Choose "Split into sheets" in the sheet settings.';
  }
  // A design over the edge would be printed cut off; that is a paid misprint, so it blocks.
  const outside = sheet.designs.filter((d) => isOutside(d, sheet.settings.sheetWidthMm));
  if (outside.length > 0) {
    const names = outside
      .slice(0, 3)
      .map((d) => `"${d.name}"`)
      .join(', ');
    const more = outside.length > 3 ? ` and ${outside.length - 3} more` : '';
    return `${names}${more} ${outside.length === 1 ? 'goes' : 'go'} past the edge of the sheet and would be cut off. Move or resize before exporting.`;
  }
  return sheet.settings.layout === 'split' ? offSheetBlocker(sheet) : null;
}

/** Why a split job cannot be exported because a design is on no sheet, or null. */
function offSheetBlocker(sheet: Sheet): string | null {
  const s = sheet.settings;
  const off = sheet.designs
    .map((d) => ({ d, reason: offSheetReason(d, s) }))
    .filter((x): x is { d: Design; reason: OffSheetReason } => x.reason !== null);
  if (off.length === 0) return null;
  // Moving cannot fix a design taller than a sheet, so that reason is reported first.
  const tall = off.find((x) => x.reason === 'too-tall');
  if (tall) {
    const box = footprint(tall.d);
    return `"${tall.d.name}" is ${formatCm(box.maxY - box.minY)} cm tall, longer than one sheet (${formatCm(s.pageLengthMm)} cm). Make the sheets longer or the design smaller.`;
  }
  const past = off.find((x) => x.reason === 'past-last');
  if (past) {
    return `"${past.d.name}" is past sheet 50, the most one job can hold. Move it onto an earlier sheet.`;
  }
  const crossing = off.filter((x) => x.reason === 'crossing');
  const names = crossing
    .slice(0, 3)
    .map((x) => `"${x.d.name}"`)
    .join(', ');
  const more = crossing.length > 3 ? ` and ${crossing.length - 3} more` : '';
  const verb = crossing.length === 1 ? 'crosses' : 'cross';
  return `${names}${more} ${verb} a split between sheets. Use "Move onto a sheet", or drag onto one sheet.`;
}
