/**
 * One greedy placement in Real shape spacing: the designs go onto the sheet one by one, each in
 * the first spot where its ink keeps the cutting gap from everything already there, in the turn
 * that serves the layout best. The search in model/smart-arrange calls this many times with
 * different orders.
 */
import { footprint } from '@/model/geometry';
import type { ShapeMask } from '@/model/mask';
import { normalizeAngle } from '@/model/ops';
import { bandOf, bandsFor, fallbackTop, MAX_PAGES } from '@/model/pages';
import { CELL_MM, gapInCells, poseCells, type Raster } from '@/model/raster';
import { ShapePacker, type FoundSpot } from '@/model/shape-packer';
import type { Design, Sheet } from '@/model/types';

const EPS = 1e-6;

/** Quarter turns: what every design may try. Other angles only make a footprint larger. */
export const QUARTER_TURNS: readonly number[] = [0, 90, 180, 270];

/** How a placement chooses among a design's turns: lowest bottom edge, or highest top edge. */
export type Rule = 'bottom' | 'top';

/** One way to place a design: a turn, with its cells and the size of its footprint. */
interface Turn {
  angleDeg: number;
  raster: Raster;
  w: number;
  h: number;
}

interface Choice {
  turn: Turn;
  spot: FoundSpot;
}

export interface ShapeJob {
  sheet: Sheet;
  moving: readonly Design[];
  fixed: readonly Design[];
  masks: ReadonlyMap<string, ShapeMask>;
  /** Used for a design whose mask is missing: all ink, so it packs as its rectangle. */
  spare: ShapeMask;
  /** Turns each design may take, in degrees added to its own angle. */
  turns: readonly number[];
  /** True when the caller is out of time; the placement then stops and returns null. */
  expired: () => boolean;
}

export interface ShapeDecoder {
  /**
   * Places the moving designs in the given order.
   *
   * Args:
   *   order: Indexes into `moving`, in the order to place them.
   *   rule: How to choose among a design's turns.
   *   pins: Per design, the index of the one turn to use, or -1 to choose.
   *
   * Returns:
   *   The placed designs in the order of `moving`, or null when time ran out part-way.
   */
  decode(order: readonly number[], rule: Rule, pins: readonly number[]): Design[] | null;
}

/** Rows the packing can need: every moving design stacked, plus the fixed ones in its way. */
function rowLimitOf(job: ShapeJob): number {
  const s = job.sheet.settings;
  if (s.layout === 'split') return Math.ceil(bandOf(MAX_PAGES - 1, s).bottom / CELL_MM) + 1;
  const pad = s.gapMm + 4 * CELL_MM;
  let reach = pad;
  for (const d of job.moving) reach += Math.hypot(d.widthMm, d.heightMm) + pad;
  const boxes = job.fixed.map(footprint).toSorted((a, b) => a.minY - b.minY);
  for (const box of boxes) {
    if (box.minY > reach) break;
    reach += Math.max(0, box.maxY - Math.max(0, box.minY)) + pad;
  }
  return Math.ceil(reach / CELL_MM);
}

/** Prepares placements for one Arrange: turned shapes are worked out once and shared. */
export function shapeDecoder(job: ShapeJob): ShapeDecoder {
  const s = job.sheet.settings;
  const rowLimit = rowLimitOf(job);
  const known = new Map<string, Turn | null>();
  const maskOf = (d: Design): ShapeMask => job.masks.get(d.assetId) ?? job.spare;
  let lastRows = 256;

  /** The design turned by `delta` degrees, or null when that turn does not fit the sheet. */
  const turnOf = (d: Design, delta: number): Turn | null => {
    const angleDeg = normalizeAngle(d.angleDeg + delta);
    const key = `${d.assetId}|${d.widthMm}|${d.heightMm}|${angleDeg}|${d.flipX}|${d.flipY}`;
    const seen = known.get(key);
    if (seen !== undefined) return seen;
    const box = footprint({ ...d, angleDeg, xMm: 0, yMm: 0 });
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const fits = w <= s.sheetWidthMm + EPS && (s.layout !== 'split' || h <= s.pageLengthMm + EPS);
    // Rasterised with the footprint's corner on a cell corner, as every spot found will be.
    const posed = { ...d, angleDeg, xMm: w / 2, yMm: h / 2 };
    const turn = fits ? { angleDeg, raster: poseCells(posed, maskOf(d)).raster, w, h } : null;
    known.set(key, turn);
    return turn;
  };

  /** The best turn and spot for one design under the rule, or null when none fits. */
  const choose = (packer: ShapePacker, d: Design, rule: Rule, pin: number): Choice | null => {
    let best: Choice | null = null;
    let bestKey = Infinity;
    const deltas = pin >= 0 ? [job.turns[pin] as number] : job.turns;
    for (const delta of deltas) {
      const turn = turnOf(d, delta);
      if (!turn) continue;
      // A spot that cannot beat the best so far is not worth scanning for.
      const reach = rule === 'bottom' ? bestKey - turn.h : bestKey;
      const spot = packer.find(turn.raster, turn.w, turn.h, Math.floor(reach / CELL_MM + EPS));
      if (!spot) continue;
      const key = spot.y * CELL_MM + (rule === 'bottom' ? turn.h : 0);
      if (key < bestKey - EPS || (best && key < bestKey + EPS && spot.x < best.spot.x)) {
        best = { turn, spot };
        bestKey = key;
      }
    }
    return best;
  };

  const place = (
    packer: ShapePacker,
    d: Design,
    placed: Design[],
    choice: Choice | null,
  ): Design => {
    if (choice) {
      const { angleDeg, raster, w, h } = choice.turn;
      const spot = packer.settle(raster, choice.spot);
      return { ...d, angleDeg, xMm: spot.x * CELL_MM + w / 2, yMm: spot.y * CELL_MM + h / 2 };
    }
    // Nowhere to go: below everything, or on the next unused sheet, where a warning shows it.
    const box = footprint(d);
    const top = fallbackTop({ ...job.sheet, designs: [...job.fixed, ...placed] });
    return { ...d, xMm: d.xMm - box.minX, yMm: d.yMm - box.minY + top };
  };

  return {
    decode(order, rule, pins) {
      const gap = gapInCells(s.gapMm);
      const packer = new ShapePacker(s.sheetWidthMm, gap, CELL_MM, rowLimit, bandsFor(s), lastRows);
      for (const d of job.fixed) packer.add(poseCells(d, maskOf(d)));
      const placed: Design[] = [];
      const byIndex = new Map<number, Design>();
      for (const index of order) {
        if (job.expired()) return null;
        const d = job.moving[index] as Design;
        const next = place(packer, d, placed, choose(packer, d, rule, pins[index] ?? -1));
        packer.add(poseCells(next, maskOf(d)));
        placed.push(next);
        byIndex.set(index, next);
      }
      lastRows = packer.usedRows;
      return job.moving.map((_, i) => byIndex.get(i) as Design);
    },
  };
}
