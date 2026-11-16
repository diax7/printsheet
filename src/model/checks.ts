import {
  corners,
  dpiLevel,
  effectiveDpi,
  footprint,
  polygonDistance,
  sheetLengthMm,
  contentLengthMm,
} from '@/model/geometry';
import { MAX_SHEET_LENGTH_MM, type Design, type ImageAsset, type Sheet } from '@/model/types';

export type IssueKind =
  | 'low-dpi'
  | 'ok-dpi'
  | 'no-transparency'
  | 'outside'
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

/** Every problem on the sheet, keyed by design id. Designs with no issue are absent. */
export function findIssues(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
): Map<string, Issue[]> {
  const result = new Map<string, Issue[]>();
  const add = (id: string, issue: Issue): void => {
    const list = result.get(id) ?? [];
    list.push(issue);
    result.set(id, list);
  };
  const { sheetWidthMm, lengthMode, fixedLengthMm } = sheet.settings;

  for (const d of sheet.designs) {
    const asset = assets.get(d.assetId);
    if (asset) {
      const level = dpiLevel(effectiveDpi(d, asset));
      if (level === 'low') add(d.id, { kind: 'low-dpi' });
      if (level === 'ok') add(d.id, { kind: 'ok-dpi' });
      if (!asset.hasTransparency) add(d.id, { kind: 'no-transparency' });
    }
    const box = footprint(d);
    if (isOutside(d, sheetWidthMm)) add(d.id, { kind: 'outside' });
    if (lengthMode === 'fixed' && box.maxY > fixedLengthMm + EDGE_EPSILON_MM) {
      add(d.id, { kind: 'past-length' });
    }
  }

  for (const [a, b] of tooClosePairs(sheet)) {
    add(a, { kind: 'too-close', otherId: b });
    add(b, { kind: 'too-close', otherId: a });
  }
  return result;
}

/**
 * Pairs of designs closer than the cutting gap. Sweep and prune: designs are sorted by the left
 * edge of their footprint, and a pair is only measured exactly when the footprints, grown by
 * the gap, overlap. That keeps hundreds of designs fast.
 */
function tooClosePairs(sheet: Sheet): Array<[string, string]> {
  const gap = sheet.settings.gapMm - EDGE_EPSILON_MM;
  const items = sheet.designs
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
      if (polygonDistance(p.poly, q.poly) < gap) {
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
  if (length > MAX_SHEET_LENGTH_MM) {
    return 'The sheet is longer than 5 m, the most one file can hold. Move some designs to a second sheet.';
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
  return null;
}
