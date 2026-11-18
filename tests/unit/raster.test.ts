import { describe, expect, it } from 'vitest';
import { corners, polygonDistance } from '@/model/geometry';
import { buildMaskCells, fullMask, maskSize, MASK_MAX_SIDE, type ShapeMask } from '@/model/mask';
import {
  CELL_MM,
  gapInCells,
  grow,
  inkTooClose,
  overlaps,
  poseCells,
  reachAt,
  type Posed,
} from '@/model/raster';
import type { Design, Point } from '@/model/types';
import { design, L_SHAPE, maskOf, randomMask, rng } from './shapes';

/** True when the grid cell holding the sheet point (x, y) is set in a posed raster. */
function cellSet(pose: Posed, x: number, y: number): boolean {
  const c = Math.floor(x / CELL_MM) - pose.x;
  const r = Math.floor(y / CELL_MM) - pose.y;
  const { raster } = pose;
  if (c < 0 || r < 0 || c >= raster.cols || r >= raster.rows) return false;
  return (((raster.bits[r * raster.stride + (c >> 5)] as number) >>> (c & 31)) & 1) === 1;
}

/** The sheet position of a point given in mask cells (u across, v down), as the PDF draws it. */
function toSheet(d: Design, mask: ShapeMask, u: number, v: number): Point {
  const lx = (u / mask.cols - 0.5) * d.widthMm * (d.flipX ? -1 : 1);
  const ly = (v / mask.rows - 0.5) * d.heightMm * (d.flipY ? -1 : 1);
  const rad = (d.angleDeg * Math.PI) / 180;
  return {
    x: d.xMm + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: d.yMm + lx * Math.sin(rad) + ly * Math.cos(rad),
  };
}

/** The four sheet corners of every ink cell of a design. */
function inkQuads(d: Design, mask: ShapeMask): Point[][] {
  const quads: Point[][] = [];
  for (let r = 0; r < mask.rows; r++) {
    for (let c = 0; c < mask.cols; c++) {
      if (!mask.cells[r * mask.cols + c]) continue;
      quads.push([
        toSheet(d, mask, c, r),
        toSheet(d, mask, c + 1, r),
        toSheet(d, mask, c + 1, r + 1),
        toSheet(d, mask, c, r + 1),
      ]);
    }
  }
  return quads;
}

/** The real distance between the ink of two designs: the closest pair of ink cells. */
function inkDistance(a: Design, ma: ShapeMask, b: Design, mb: ShapeMask): number {
  let best = Infinity;
  const qb = inkQuads(b, mb);
  for (const p of inkQuads(a, ma)) {
    for (const q of qb) best = Math.min(best, polygonDistance(p, q));
  }
  return best;
}

const FLIPS = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const;

describe('masks', () => {
  it('keeps the image shape and caps the long side', () => {
    expect(maskSize(100, 50)).toEqual({ cols: 100, rows: 50 });
    expect(maskSize(4096, 1024)).toEqual({ cols: MASK_MAX_SIDE, rows: 128 });
    expect(maskSize(1, 9000)).toEqual({ cols: 1, rows: MASK_MAX_SIDE });
  });

  it('sets a cell for a single faint pixel', () => {
    const m = buildMaskCells(2000, 1000, (x, y) => (x === 1999 && y === 0 ? 1 : 0));
    const set = [...m.cells].flatMap((v, i) => (v ? [i] : []));
    expect(set).toEqual([m.cols - 1]);
  });

  it('gives a pixel that lies across two cells to both', () => {
    // 768 pixels onto 512 cells: pixel 1 covers cell 0 from 2/3 on and cell 1 up to 1/3.
    const m = buildMaskCells(768, 1, (x) => (x === 1 ? 255 : 0));
    expect(m.cols).toBe(512);
    expect([m.cells[0], m.cells[1], m.cells[2]]).toEqual([1, 1, 0]);
  });

  it('counts the ink above and left of every corner in its table', () => {
    const { sum, cols } = L_SHAPE;
    const at = (c: number, r: number): number => sum[r * (cols + 1) + c] as number;
    expect([at(0, 0), at(1, 1), at(4, 3), at(1, 4), at(4, 4)]).toEqual([0, 1, 3, 4, 7]);
    expect(fullMask().sum.at(-1)).toBe(1);
  });
});

describe('poseCells', () => {
  it('covers every ink point at every 15° and with flips', () => {
    const rand = rng(7);
    for (let angle = 0; angle < 360; angle += 15) {
      for (const [flipX, flipY] of FLIPS) {
        const mask = randomMask(rand, 3 + Math.floor(rand() * 9), 3 + Math.floor(rand() * 9), 0.4);
        const d = design('d', 'a', 20 + rand() * 60, 20 + rand() * 60, {
          xMm: 100 + rand() * 50,
          yMm: 100 + rand() * 50,
          angleDeg: angle,
          flipX,
          flipY,
        });
        const pose = poseCells(d, mask);
        const missed: string[] = [];
        for (let r = 0; r < mask.rows; r++) {
          for (let c = 0; c < mask.cols; c++) {
            if (!mask.cells[r * mask.cols + c]) continue;
            // A fine lattice of points strictly inside the ink cell.
            for (let i = 0; i < 6; i++) {
              for (let j = 0; j < 6; j++) {
                const p = toSheet(d, mask, c + (i + 0.5) / 6, r + (j + 0.5) / 6);
                if (!cellSet(pose, p.x, p.y)) missed.push(`${angle}° cell ${c},${r}`);
              }
            }
          }
        }
        expect(missed).toEqual([]);
      }
    }
  });

  it('leaves the empty corner of an L empty', () => {
    const pose = poseCells(design('d', 'l', 40, 40), L_SHAPE);
    expect(cellSet(pose, 30, 10)).toBe(false);
    expect(cellSet(pose, 5, 10)).toBe(true);
    expect(cellSet(pose, 30, 35)).toBe(true);
  });

  it('puts the ink of a flipped design on the other side', () => {
    const pose = poseCells(design('d', 'l', 40, 40, { flipX: true }), L_SHAPE);
    expect(cellSet(pose, 35, 10)).toBe(true);
    expect(cellSet(pose, 10, 10)).toBe(false);
  });

  it('shares one raster between equal designs on grid positions', () => {
    const a = poseCells(design('a', 'l', 40, 30, { xMm: 20, yMm: 15 }), L_SHAPE);
    const b = poseCells(design('b', 'l', 40, 30, { xMm: 220, yMm: 115 }), L_SHAPE);
    expect(b.raster).toBe(a.raster);
    expect([b.x - a.x, b.y - a.y]).toEqual([200, 100]);
  });

  it('snaps a corner that floating point left a hair off the grid', () => {
    const a = poseCells(design('a', 'l', 40, 30, { xMm: 20, yMm: 15 }), L_SHAPE);
    const b = poseCells(design('b', 'l', 40, 30, { xMm: 20 + 1e-10, yMm: 15 - 1e-10 }), L_SHAPE);
    expect(b.raster).toBe(a.raster);
    expect([b.x, b.y]).toEqual([a.x, a.y]);
  });
});

describe('distance between cells', () => {
  it('reaches neighbours by the distance between cell squares', () => {
    // Gap 5 cells: cells 5 apart in a row have squares 4 apart (closer); 6 apart are 5 (not).
    expect(reachAt(0, 5)).toBe(5);
    expect(reachAt(1, 5)).toBe(5);
    expect(reachAt(5, 5)).toBe(3);
    expect(reachAt(6, 5)).toBe(-1);
    expect(reachAt(0, 0)).toBe(0);
    expect(reachAt(1, 0)).toBe(-1);
  });

  it('grows a single cell to its neighbourhood', () => {
    const one = poseCells(design('d', 'a', 1, 1, { xMm: 0.5, yMm: 0.5 }), fullMask());
    // 1.2 cells: two cells away along a row or column is closer, two away diagonally is not.
    const { raster, margin } = grow(one.raster, 1.2);
    expect(margin).toBe(2);
    const row = (r: number): string =>
      Array.from(
        { length: raster.cols },
        (_, c) => ((raster.bits[r * raster.stride] as number) >>> c) & 1,
      ).join('');
    expect([0, 1, 2, 3, 4].map(row)).toEqual(['01110', '11111', '11111', '11111', '01110']);
  });

  it('never misses a pair whose ink is closer than the gap', () => {
    const rand = rng(11);
    let close = 0;
    let far = 0;
    for (let n = 0; n < 400; n++) {
      const ma = randomMask(rand, 1 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 5));
      const mb = randomMask(rand, 1 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 5));
      const a = design('a', 'a', 8 + rand() * 30, 8 + rand() * 30, {
        xMm: 60 + rand() * 20,
        yMm: 60 + rand() * 20,
        angleDeg: Math.floor(rand() * 24) * 15,
        flipX: rand() < 0.3,
      });
      const b = design('b', 'b', 8 + rand() * 30, 8 + rand() * 30, {
        xMm: 60 + rand() * 60,
        yMm: 60 + rand() * 60,
        angleDeg: rand() * 360,
        flipY: rand() < 0.3,
      });
      const gap = 1 + rand() * 9;
      const exact = inkDistance(a, ma, b, mb);
      const flagged = inkTooClose(poseCells(a, ma), poseCells(b, mb), gap);
      if (exact < gap - 0.02) {
        close++;
        expect(flagged, `case ${n}: exact ${exact} gap ${gap}`).toBe(true);
      }
      // And it is not wildly cautious: with three cells of slack nothing is reported.
      if (exact > gap + 3 * Math.SQRT2 * CELL_MM) {
        far++;
        expect(flagged, `case ${n}: exact ${exact} gap ${gap}`).toBe(false);
      }
    }
    expect(close).toBeGreaterThan(50);
    expect(far).toBeGreaterThan(50);
  });

  it('lets one L sit in the corner of another when the ink keeps the gap', () => {
    const a = design('a', 'l', 60, 60);
    // Turned half a turn, its ink is the top row and the right column.
    const b = design('b', 'l', 60, 60, { angleDeg: 180, xMm: 55, yMm: 5 });
    expect(polygonDistance(corners(a), corners(b))).toBe(0);
    expect(inkDistance(a, L_SHAPE, b, L_SHAPE)).toBeGreaterThanOrEqual(5);
    expect(inkTooClose(poseCells(a, L_SHAPE), poseCells(b, L_SHAPE), 5)).toBe(false);
    const touching = { ...b, xMm: 40, yMm: 20 };
    expect(inkTooClose(poseCells(a, L_SHAPE), poseCells(touching, L_SHAPE), 5)).toBe(true);
  });

  it('reports nothing with a gap of zero, like the rectangle check', () => {
    const a = poseCells(design('a', 'l', 40, 40), L_SHAPE);
    expect(inkTooClose(a, a, 0)).toBe(false);
    expect(gapInCells(0)).toBe(0);
  });

  it('finds overlap between posed rasters across word boundaries', () => {
    const wide = maskOf('#'.repeat(70));
    const a = poseCells(design('a', 'w', 70, 1, { xMm: 35, yMm: 0.5 }), wide);
    const b = poseCells(design('b', 'w', 70, 1, { xMm: 35 + 69, yMm: 0.5 }), wide);
    const c = poseCells(design('c', 'w', 70, 1, { xMm: 35 + 70, yMm: 0.5 }), wide);
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(a, c)).toBe(false);
  });
});
