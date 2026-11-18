/**
 * The one collision primitive behind Real shape spacing. The "too close" check and the shape
 * packer both call it, so they agree by construction: a layout the packer makes cannot trip the
 * check.
 *
 * Everything happens on one grid anchored at the sheet's top-left corner, with square cells of
 * `cellMm`. A design becomes the set of grid cells its ink can touch (never fewer: each cell is
 * mapped back into the design's mask and set when any mask cell under it has ink). The distance
 * between two cells is the distance between their squares, which is never more than the distance
 * between the ink inside them. Two designs are too close when some pair of their cells is closer
 * than the cutting gap, so a pair that really is too close is never missed; a pair may be
 * reported up to about a cell early.
 *
 * Rasters are rows of bits (32 columns per word), so testing two designs is a few word ANDs per
 * row instead of a loop over cells.
 */
import { footprint } from '@/model/geometry';
import type { ShapeMask } from '@/model/mask';
import type { Design } from '@/model/types';

/** Grid cell size in mm. Smaller is tighter and slower; the masks are about 1 mm themselves. */
export const CELL_MM = 1;

/** A footprint corner this close to a grid line (in cells) is treated as on it. */
const SNAP = 1e-6;
/** Shrinks each cell's shadow in the mask by a hair, so ink that only touches a cell's edge
 * (zero area) does not set it. */
const TOUCH = 1e-6;
const EPSILON_MM = 0.01;

/** A block of cells as rows of bits: bit `c & 31` of word `r * stride + (c >> 5)`. */
export interface Raster {
  cols: number;
  rows: number;
  stride: number;
  bits: Uint32Array;
}

/** A raster placed on the grid: its top-left cell is (x, y). */
export interface Posed {
  raster: Raster;
  x: number;
  y: number;
}

export function emptyRaster(cols: number, rows: number): Raster {
  const stride = Math.max(1, Math.ceil(cols / 32));
  return { cols, rows, stride, bits: new Uint32Array(stride * rows) };
}

/**
 * ORs a row of `src`, moved `shift` columns to the right (left when negative), into a row of
 * `dst`. Columns that fall outside `dst` are dropped.
 */
export function orRow(
  dst: Uint32Array,
  dstAt: number,
  dstStride: number,
  src: Uint32Array,
  srcAt: number,
  srcStride: number,
  shift: number,
): void {
  const word = shift >> 5;
  const bit = shift & 31;
  for (let k = 0; k < srcStride; k++) {
    const v = src[srcAt + k] as number;
    if (v === 0) continue;
    const t = k + word;
    if (t >= 0 && t < dstStride) dst[dstAt + t] = (dst[dstAt + t] as number) | (v << bit);
    if (bit !== 0 && t + 1 >= 0 && t + 1 < dstStride) {
      dst[dstAt + t + 1] = (dst[dstAt + t + 1] as number) | (v >>> (32 - bit));
    }
  }
}

/** True when a row of `src`, moved `shift` columns to the right, shares a set bit with `dst`. */
export function rowsMeet(
  dst: Uint32Array,
  dstAt: number,
  dstStride: number,
  src: Uint32Array,
  srcAt: number,
  srcStride: number,
  shift: number,
): boolean {
  const word = shift >> 5;
  const bit = shift & 31;
  for (let k = 0; k < srcStride; k++) {
    const v = src[srcAt + k] as number;
    if (v === 0) continue;
    const t = k + word;
    if (t >= 0 && t < dstStride && ((dst[dstAt + t] as number) & (v << bit)) !== 0) return true;
    if (
      bit !== 0 &&
      t + 1 >= 0 &&
      t + 1 < dstStride &&
      ((dst[dstAt + t + 1] as number) & (v >>> (32 - bit))) !== 0
    ) {
      return true;
    }
  }
  return false;
}

/** True when two posed rasters share a cell. */
export function overlaps(a: Posed, b: Posed): boolean {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.raster.rows, b.y + b.raster.rows);
  if (a.x >= b.x + b.raster.cols || b.x >= a.x + a.raster.cols) return false;
  for (let y = top; y < bottom; y++) {
    const hit = rowsMeet(
      a.raster.bits,
      (y - a.y) * a.raster.stride,
      a.raster.stride,
      b.raster.bits,
      (y - b.y) * b.raster.stride,
      b.raster.stride,
      b.x - a.x,
    );
    if (hit) return true;
  }
  return false;
}

/**
 * How far, in whole cells, a cell's neighbourhood "closer than the gap" reaches sideways on the
 * row `dj` cells away, or -1 when that row is out of reach. Cells (di, dj) apart are
 * `cell * hypot(max(0, |di| - 1), max(0, |dj| - 1))` apart: the distance between their squares.
 * A gap of zero still reaches the cell itself, so designs never share a cell.
 */
export function reachAt(dj: number, gapCells: number): number {
  if (gapCells <= 0) return dj === 0 ? 0 : -1;
  const vy = Math.max(0, Math.abs(dj) - 1);
  if (vy >= gapCells) return -1;
  return Math.ceil(1 + Math.sqrt(gapCells * gapCells - vy * vy)) - 1;
}

/** The cutting gap in cells, less the same tolerance the rectangle check allows. */
export function gapInCells(gapMm: number, cellMm: number = CELL_MM): number {
  return Math.max(0, (gapMm - EPSILON_MM) / cellMm);
}

/**
 * Grows a raster to every cell closer than the gap to one of its cells. The result is `margin`
 * cells larger on every side; `overlaps(grown(a), b)` is exactly "a and b are too close".
 */
export function grow(raster: Raster, gapCells: number): { raster: Raster; margin: number } {
  const margin = Math.max(0, reachAt(0, gapCells));
  const out = emptyRaster(raster.cols + 2 * margin, raster.rows + 2 * margin);
  // spread[r] is the current row smeared r cells left and right, in the output's columns.
  const spread = Array.from({ length: margin + 1 }, () => new Uint32Array(out.stride));
  for (let j = 0; j < raster.rows; j++) {
    const at = j * raster.stride;
    for (let r = 0; r <= margin; r++) {
      const row = spread[r] as Uint32Array;
      if (r === 0) row.fill(0);
      else row.set(spread[r - 1] as Uint32Array);
      orRow(row, 0, out.stride, raster.bits, at, raster.stride, margin - r);
      if (r > 0) orRow(row, 0, out.stride, raster.bits, at, raster.stride, margin + r);
    }
    for (let dj = -margin; dj <= margin; dj++) {
      const reach = reachAt(dj, gapCells);
      if (reach < 0) continue;
      const from = spread[Math.min(reach, margin)] as Uint32Array;
      orRow(out.bits, (j + dj + margin) * out.stride, out.stride, from, 0, out.stride, 0);
    }
  }
  return { raster: out, margin };
}

/** The numbers that map a grid cell back into a design's mask. */
interface Inverse {
  cos: number;
  sin: number;
  /** Mask cells per mm along the design's own width and height (negative when flipped). */
  perMmU: number;
  perMmV: number;
  /** Half the size of a grid cell's shadow in the mask, in mask cells. */
  halfU: number;
  halfV: number;
}

function inverseOf(d: Design, mask: ShapeMask, cellMm: number): Inverse {
  const rad = (d.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const half = (cellMm / 2) * (Math.abs(cos) + Math.abs(sin));
  const perMmU = mask.cols / d.widthMm;
  const perMmV = mask.rows / d.heightMm;
  return {
    cos,
    sin,
    perMmU: d.flipX ? -perMmU : perMmU,
    perMmV: d.flipY ? -perMmV : perMmV,
    halfU: half * perMmU,
    halfV: half * perMmV,
  };
}

/**
 * The steps i, from 0 to n - 1, at which `start + i * step` lies between `lo` and `hi`, as a
 * first and last index (first past last when there are none).
 */
function stepsWithin(
  start: number,
  step: number,
  lo: number,
  hi: number,
  n: number,
): [number, number] {
  if (Math.abs(step) < 1e-12) return start > lo && start < hi ? [0, n - 1] : [1, 0];
  const a = (lo - start) / step;
  const b = (hi - start) / step;
  // One step of slack each way: the cells at the ends are tested exactly by the caller.
  return [
    Math.max(0, Math.floor(Math.min(a, b)) - 1),
    Math.min(n - 1, Math.ceil(Math.max(a, b)) + 1),
  ];
}

/**
 * The cells a design's ink can touch, for a design whose footprint starts `fracX`, `fracY` cells
 * (each from 0 up to 1) inside its top-left grid cell. Each grid cell's square is turned back
 * into the design's own axes; the mask cells under its bounding box are tested together with
 * the summed-area table. Along a row of the grid the position in the mask moves by a fixed
 * step, and only the stretch of the row that can fall on the mask is visited.
 */
function rasterise(
  d: Design,
  mask: ShapeMask,
  cellMm: number,
  fracX: number,
  fracY: number,
): Raster {
  const box = footprint(d);
  const wCells = (box.maxX - box.minX) / cellMm;
  const hCells = (box.maxY - box.minY) / cellMm;
  const out = emptyRaster(
    Math.max(1, Math.ceil(fracX + wCells - SNAP)),
    Math.max(1, Math.ceil(fracY + hCells - SNAP)),
  );
  const inv = inverseOf(d, mask, cellMm);
  const { cols, rows, sum } = mask;
  const stride = cols + 1;
  const { halfU, halfV } = inv;
  const px0 = (0.5 - fracX - wCells / 2) * cellMm;
  const du = cellMm * inv.cos * inv.perMmU;
  const dv = -cellMm * inv.sin * inv.perMmV;
  for (let j = 0; j < out.rows; j++) {
    const py = (j + 0.5 - fracY - hCells / 2) * cellMm;
    const u0 = (px0 * inv.cos + py * inv.sin) * inv.perMmU + cols / 2;
    const v0 = (py * inv.cos - px0 * inv.sin) * inv.perMmV + rows / 2;
    const [uFirst, uLast] = stepsWithin(u0, du, -halfU, cols + halfU, out.cols);
    const [vFirst, vLast] = stepsWithin(v0, dv, -halfV, rows + halfV, out.cols);
    const last = Math.min(uLast, vLast);
    for (let i = Math.max(uFirst, vFirst); i <= last; i++) {
      const u = u0 + i * du;
      const v = v0 + i * dv;
      const c0 = Math.max(0, Math.floor(u - halfU + TOUCH));
      const c1 = Math.min(cols - 1, Math.ceil(u + halfU - TOUCH) - 1);
      const r0 = Math.max(0, Math.floor(v - halfV + TOUCH));
      const r1 = Math.min(rows - 1, Math.ceil(v + halfV - TOUCH) - 1);
      if (c0 > c1 || r0 > r1) continue;
      const ink =
        (sum[(r1 + 1) * stride + c1 + 1] as number) -
        (sum[r0 * stride + c1 + 1] as number) -
        (sum[(r1 + 1) * stride + c0] as number) +
        (sum[r0 * stride + c0] as number);
      if (ink === 0) continue;
      const at = j * out.stride + (i >> 5);
      out.bits[at] = (out.bits[at] as number) | (1 << (i & 31));
    }
  }
  return out;
}

/** Whole cells and the remainder of a coordinate, snapping onto a grid line it nearly touches. */
function splitCell(value: number): { whole: number; frac: number } {
  const nearest = Math.round(value);
  // Adding zero turns the -0 that rounding a tiny negative gives into 0.
  if (Math.abs(value - nearest) < SNAP) return { whole: nearest + 0, frac: 0 };
  const whole = Math.floor(value);
  return { whole, frac: value - whole };
}

/** Most rasters kept per mask; dragging a design makes a new one at every position. */
const CACHE_LIMIT = 256;
const cache = new WeakMap<ShapeMask, Map<string, Raster>>();
const grown = new WeakMap<Raster, { gapCells: number; raster: Raster; margin: number }>();

/**
 * The cells a design's ink can touch, on the sheet grid. Cached per mask by the design's size,
 * turn, flips and position within a cell, so equal designs on grid positions (everything the
 * shape packer places) share one raster wherever they are.
 */
export function poseCells(d: Design, mask: ShapeMask, cellMm: number = CELL_MM): Posed {
  const box = footprint(d);
  const x = splitCell(box.minX / cellMm);
  const y = splitCell(box.minY / cellMm);
  const key = `${d.widthMm}|${d.heightMm}|${d.angleDeg}|${d.flipX ? 1 : 0}${d.flipY ? 1 : 0}|${x.frac}|${y.frac}|${cellMm}`;
  let byKey = cache.get(mask);
  if (!byKey) {
    byKey = new Map();
    cache.set(mask, byKey);
  }
  let raster = byKey.get(key);
  if (!raster) {
    if (byKey.size >= CACHE_LIMIT) byKey.clear();
    raster = rasterise(d, mask, cellMm, x.frac, y.frac);
    byKey.set(key, raster);
  }
  return { raster, x: x.whole, y: y.whole };
}

/** A posed raster grown by the gap (see `grow`), remembered for the last gap asked for. */
export function grownPose(pose: Posed, gapCells: number): Posed {
  let entry = grown.get(pose.raster);
  if (!entry || entry.gapCells !== gapCells) {
    entry = { gapCells, ...grow(pose.raster, gapCells) };
    grown.set(pose.raster, entry);
  }
  return { raster: entry.raster, x: pose.x - entry.margin, y: pose.y - entry.margin };
}

/**
 * True when the ink of two designs may be closer than the cutting gap. Never false for a pair
 * that really is too close.
 */
export function inkTooClose(a: Posed, b: Posed, gapMm: number, cellMm: number = CELL_MM): boolean {
  if (gapMm - EPSILON_MM <= 0) return false;
  // Grow the smaller raster: fewer rows to smear.
  const [small, large] =
    a.raster.rows * a.raster.cols <= b.raster.rows * b.raster.cols ? [a, b] : [b, a];
  return overlaps(grownPose(small, gapInCells(gapMm, cellMm)), large);
}
