/**
 * Free-spot search for bottom-left fill. Given boxes already on the sheet, find the highest,
 * then leftmost, spot where a w × h box keeps `gap` from all of them and stays inside `width`.
 *
 * Candidate rows are y = 0 and each box's bottom + gap, tried top to bottom. A sweep keeps the
 * "active" boxes, those whose extent (grown by the gap) overlaps the new box's vertical band, so
 * each row only looks at its neighbours. Within a row the active boxes are swept in x to find the
 * leftmost opening wide enough. The first opening found is the answer.
 */
import type { Box } from '@/model/geometry';

const EPS = 1e-6;

/** Insert into an ascending array, keeping it sorted. */
function insertSorted<T>(list: T[], item: T, key: (t: T) => number): void {
  const k = key(item);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid] as T) <= k) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

export class Packer {
  /** Boxes sorted by top edge. */
  private readonly byTop: Box[] = [];
  /** Candidate rows, ascending. */
  private readonly rows: number[] = [0];

  constructor(
    private readonly width: number,
    private readonly gap: number,
    initial: readonly Box[] = [],
  ) {
    for (const box of initial) this.add(box);
  }

  add(box: Box): void {
    insertSorted(this.byTop, box, (b) => b.minY);
    insertSorted(this.rows, box.maxY + this.gap, (y) => y);
  }

  /** The best spot for a w × h box, or null when it is wider than the sheet. */
  find(w: number, h: number): Box | null {
    if (w > this.width + EPS) return null;
    const gap = this.gap;
    let next = 0;
    let active: Box[] = [];
    let previousRow = -Infinity;
    for (const y of this.rows) {
      if (y - previousRow < EPS) continue;
      previousRow = y;
      const bandBottom = y + h + gap;
      while (next < this.byTop.length && (this.byTop[next] as Box).minY < bandBottom - EPS) {
        active.push(this.byTop[next] as Box);
        next++;
      }
      active = active.filter((b) => b.maxY + gap > y + EPS);
      const x = leftmostOpening(active, w, this.width, gap);
      if (x !== null) return { minX: x, minY: y, maxX: x + w, maxY: y + h };
    }
    return null;
  }
}

/** Leftmost x where [x, x + w] keeps the gap from every active box and fits in [0, width]. */
function leftmostOpening(
  active: readonly Box[],
  w: number,
  width: number,
  gap: number,
): number | null {
  const blocked = active
    .map((b) => [b.minX - gap, b.maxX + gap] as const)
    .toSorted((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of blocked) {
    if (start >= cursor + w - EPS) break;
    if (end > cursor) cursor = end;
  }
  return cursor + w <= width + EPS ? cursor : null;
}
