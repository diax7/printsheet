/**
 * Free-spot search for Real shape spacing. The sheet is a grid of bits: every cell closer than
 * the cutting gap to ink already placed is taken. A design fits where none of its own cells is
 * taken, so its rectangle may overlap another design's rectangle as long as the ink keeps the
 * gap.
 *
 * The search runs on a coarser copy of the grid first (a coarse cell is taken when any cell in
 * it is, and a design's coarse shape covers all its cells, so "free" on the coarse grid always
 * means free on the fine one). The first free coarse spot, top to bottom then left to right, is
 * then slid up and left one fine cell at a time until it touches something. Large designs use a
 * coarser copy than small ones: the scan is what costs time, and a large design loses little by
 * starting from a rougher spot.
 *
 * Taken cells only ever grow, so a spot refused once stays refused: each shape remembers how far
 * its scan got and the next copy starts there.
 */
import type { Band } from '@/model/pages';
import { emptyRaster, grownPose, orRow, rowsMeet, type Posed, type Raster } from '@/model/raster';

/** Coarse grids, as fine cells per coarse cell. Each must divide 32. */
const FACTORS = [2, 4, 8] as const;
/** A shape uses the coarsest grid on which its short side is still this many cells. */
const MIN_COARSE_SIDE = 12;
/** ...and on which it still has this many places to try across the sheet. */
const MIN_COARSE_STEPS = 16;
const SNAP = 1e-6;

export interface Spot {
  x: number;
  y: number;
}

/** A free spot as the scan found it, with the top of its sheet (it may slide up to there). */
export interface FoundSpot extends Spot {
  minY: number;
}

function popcount(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** One bit per pair of bits of a word, set when the pair has a set bit: 16 bits. */
function blocksOf2(v: number): number {
  let m = (v | (v >>> 1)) & 0x55555555;
  m = (m | (m >>> 1)) & 0x33333333;
  m = (m | (m >>> 2)) & 0x0f0f0f0f;
  m = (m | (m >>> 4)) & 0x00ff00ff;
  return (m | (m >>> 8)) & 0xffff;
}

/** One bit per 4-bit block of a word, set when the block has a set bit: 8 bits. */
function blocksOf4(v: number): number {
  let m = (v | (v >>> 1) | (v >>> 2) | (v >>> 3)) & 0x11111111;
  m = (m | (m >>> 3)) & 0x03030303;
  m = (m | (m >>> 6)) & 0x000f000f;
  return (m | (m >>> 12)) & 0xff;
}

/** One bit per byte of a word, set when the byte has a set bit: 4 bits. */
function blocksOf8(v: number): number {
  const pairs = blocksOf4(v);
  return (
    ((pairs | (pairs >>> 1)) & 1) |
    ((((pairs >>> 2) | (pairs >>> 3)) & 1) << 1) |
    ((((pairs >>> 4) | (pairs >>> 5)) & 1) << 2) |
    ((((pairs >>> 6) | (pairs >>> 7)) & 1) << 3)
  );
}

/** Writes the coarse bits of one row of fine bits (already merged over the coarse cell's rows). */
function coarsenRow(
  fine: Uint32Array,
  fineStride: number,
  factor: number,
  out: Uint32Array,
  outAt: number,
  outStride: number,
): void {
  const perWord = 32 / factor;
  for (let k = 0; k < outStride; k++) out[outAt + k] = 0;
  for (let k = 0; k < fineStride; k++) {
    const v = fine[k] as number;
    if (v === 0) continue;
    const bit = k * perWord;
    const at = outAt + (bit >> 5);
    if (bit >> 5 >= outStride) break;
    const blocks = factor === 2 ? blocksOf2(v) : factor === 4 ? blocksOf4(v) : blocksOf8(v);
    out[at] = (out[at] as number) | (blocks << (bit & 31));
  }
}

/** ORs `count` rows of a grid, starting at `row`, into `merged`. */
function mergeRows(
  merged: Uint32Array,
  bits: Uint32Array,
  stride: number,
  row: number,
  count: number,
): void {
  merged.fill(0);
  for (let k = 0; k < count; k++) orRow(merged, 0, stride, bits, (row + k) * stride, stride, 0);
}

/** A shape on a coarse grid, with what the scan needs to refuse a row without testing it. */
interface CoarseShape {
  factor: number;
  raster: Raster;
  /** Cells in each row: a sheet row with fewer free cells cannot take that row. */
  counts: Uint16Array;
  /** The row with the most cells, tested first because it collides most often. */
  widest: number;
}

function coarsen(raster: Raster, factor: number): CoarseShape {
  const out = emptyRaster(Math.ceil(raster.cols / factor), Math.ceil(raster.rows / factor));
  const merged = new Uint32Array(raster.stride);
  const counts = new Uint16Array(out.rows);
  let widest = 0;
  for (let r = 0; r < out.rows; r++) {
    const from = r * factor;
    mergeRows(merged, raster.bits, raster.stride, from, Math.min(factor, raster.rows - from));
    coarsenRow(merged, raster.stride, factor, out.bits, r * out.stride, out.stride);
    let n = 0;
    for (let k = 0; k < out.stride; k++) n += popcount(out.bits[r * out.stride + k] as number);
    counts[r] = n;
    if (n > (counts[widest] as number)) widest = r;
  }
  return { factor, raster: out, counts, widest };
}

const coarseCache = new Map<number, WeakMap<Raster, CoarseShape>>(
  FACTORS.map((f) => [f, new WeakMap()]),
);

/**
 * A shape on the coarsest grid that still leaves it enough cells across its short side and
 * enough places to try across the sheet. A design with little room to spare sideways is thus
 * searched finely, which is what finds a nest with a millimetre or two of slack.
 */
function coarseOf(raster: Raster, maxX: number): CoarseShape {
  const side = Math.min(raster.cols, raster.rows);
  const factor =
    FACTORS.findLast((f) => side / f >= MIN_COARSE_SIDE && maxX / f >= MIN_COARSE_STEPS) ??
    FACTORS[0];
  const cache = coarseCache.get(factor) as WeakMap<Raster, CoarseShape>;
  let shape = cache.get(raster);
  if (!shape) {
    shape = coarsen(raster, factor);
    cache.set(raster, shape);
  }
  return shape;
}

/**
 * The cells of a shape that lead when it moves one cell up or one cell left, as a short list of
 * words. A shape in a free spot stays free after such a step when just these cells are free,
 * because every other cell moves onto a cell the shape already covered.
 */
interface Edge {
  count: number;
  rows: Uint16Array;
  words: Uint16Array;
  bits: Uint32Array;
}

function edgeOf(raster: Raster, lead: (r: number, k: number) => number): Edge {
  const rows: number[] = [];
  const words: number[] = [];
  const bits: number[] = [];
  for (let r = 0; r < raster.rows; r++) {
    for (let k = 0; k < raster.stride; k++) {
      const v = lead(r, k);
      if (v === 0) continue;
      rows.push(r);
      words.push(k);
      bits.push(v);
    }
  }
  return {
    count: rows.length,
    rows: Uint16Array.from(rows),
    words: Uint16Array.from(words),
    bits: Uint32Array.from(bits),
  };
}

const edgeCache = new WeakMap<Raster, { up: Edge; left: Edge }>();

function edgesOf(raster: Raster): { up: Edge; left: Edge } {
  let edges = edgeCache.get(raster);
  if (!edges) {
    const { bits, stride } = raster;
    const at = (r: number, k: number): number =>
      r < 0 || k < 0 ? 0 : (bits[r * stride + k] as number);
    edges = {
      // Cells with no cell of the shape right above them.
      up: edgeOf(raster, (r, k) => at(r, k) & ~at(r - 1, k)),
      // Cells with no cell of the shape right before them (the carry comes from the word before).
      left: edgeOf(raster, (r, k) => at(r, k) & ~((at(r, k) << 1) | (at(r, k - 1) >>> 31))),
    };
    edgeCache.set(raster, edges);
  }
  return edges;
}

/** The taken cells of the sheet at one coarse size. */
class CoarseGrid {
  readonly cols: number;
  readonly stride: number;
  taken = new Uint32Array(0);
  /** Free cells in each row; rows never written are wholly free. */
  freeCells = new Uint16Array(0);
  /**
   * A grid is only kept up to date once a shape has searched on it: a job of large designs
   * never pays for the fine copies.
   */
  inUse = false;

  constructor(
    readonly factor: number,
    fineCols: number,
  ) {
    this.cols = Math.ceil(fineCols / factor);
    this.stride = Math.max(1, Math.ceil(this.cols / 32));
  }

  resize(fineRows: number): void {
    const rows = fineRows / this.factor;
    const taken = new Uint32Array(rows * this.stride);
    taken.set(this.taken);
    const freeCells = new Uint16Array(rows).fill(this.cols);
    freeCells.set(this.freeCells);
    this.taken = taken;
    this.freeCells = freeCells;
  }

  /** Recomputes row `r` from the merged fine rows under it. */
  update(r: number, merged: Uint32Array, fineStride: number): void {
    const at = r * this.stride;
    coarsenRow(merged, fineStride, this.factor, this.taken, at, this.stride);
    let n = 0;
    for (let k = 0; k < this.stride; k++) n += popcount(this.taken[at + k] as number);
    this.freeCells[r] = Math.max(0, this.cols - n);
  }

  /** False when some row of the shape has more cells than the sheet row under it has free. */
  roomFor(shape: CoarseShape, y: number): boolean {
    const last = Math.min(shape.raster.rows, this.freeCells.length - y);
    for (let r = 0; r < last; r++) {
      if ((shape.counts[r] as number) > (this.freeCells[y + r] as number)) return false;
    }
    return true;
  }

  private rowFree(coarse: Raster, x: number, y: number, r: number): boolean {
    const at = (y + r) * this.stride;
    return !rowsMeet(this.taken, at, this.stride, coarse.bits, r * coarse.stride, coarse.stride, x);
  }

  free(shape: CoarseShape, x: number, y: number): boolean {
    const coarse = shape.raster;
    const last = Math.min(coarse.rows, this.freeCells.length - y);
    if (shape.widest < last && !this.rowFree(coarse, x, y, shape.widest)) return false;
    for (let r = 0; r < last; r++) {
      if (!this.rowFree(coarse, x, y, r)) return false;
    }
    return true;
  }
}

export class ShapePacker {
  private readonly cols: number;
  private readonly stride: number;
  /** Bits of the last word that are real columns; grown ink past the right edge is dropped. */
  private readonly lastWord: number;
  private rows = 0;
  private taken = new Uint32Array(0);
  private readonly grids: CoarseGrid[];
  private readonly merged: Uint32Array;
  /** Per shape, the first coarse row its scan has not yet refused. */
  private readonly scanned = new Map<Raster, number>();

  /**
   * Args:
   *   widthMm: Sheet width.
   *   gapCells: The cutting gap in cells (see `gapInCells`).
   *   cellMm: Grid cell size.
   *   rowLimit: Rows the search may use; ink further down is ignored.
   *   bands: The sheets of a split job, or null for one long sheet.
   *   firstRows: Rows to allocate at first.
   */
  constructor(
    private readonly widthMm: number,
    private readonly gapCells: number,
    private readonly cellMm: number,
    private readonly rowLimit: number,
    private readonly bands: readonly Band[] | null = null,
    private readonly firstRows = 256,
  ) {
    this.cols = Math.max(1, Math.ceil(widthMm / cellMm));
    this.stride = Math.ceil(this.cols / 32);
    this.lastWord = this.cols % 32 === 0 ? -1 : (1 << (this.cols % 32)) - 1;
    this.merged = new Uint32Array(this.stride);
    this.grids = FACTORS.map((f) => new CoarseGrid(f, this.cols));
  }

  /** Rows allocated so far: what the next packing of the same designs should start with. */
  get usedRows(): number {
    return this.rows;
  }

  /** Rows are allocated as the packing grows down, never for the whole possible length. */
  private ensureRows(rows: number): void {
    if (rows <= this.rows) return;
    const next = Math.ceil(Math.max(rows, this.rows * 2, this.firstRows) / 32) * 32;
    const taken = new Uint32Array(next * this.stride);
    taken.set(this.taken);
    this.taken = taken;
    this.rows = next;
    for (const grid of this.grids) grid.resize(next);
  }

  /** Marks every cell closer than the gap to this design's cells as taken. */
  add(pose: Posed): void {
    const g = grownPose(pose, this.gapCells);
    const top = Math.max(0, g.y);
    const bottom = Math.min(this.rowLimit, g.y + g.raster.rows);
    if (bottom <= top) return;
    this.ensureRows(bottom);
    const { bits, stride } = g.raster;
    for (let y = top; y < bottom; y++) {
      const at = y * this.stride;
      orRow(this.taken, at, this.stride, bits, (y - g.y) * stride, stride, g.x);
      const end = at + this.stride - 1;
      this.taken[end] = (this.taken[end] as number) & this.lastWord;
    }
    for (const grid of this.grids) if (grid.inUse) this.refresh(grid, top, bottom);
  }

  /** Brings a coarse grid up to date with the fine rows from `top` up to `bottom`. */
  private refresh(grid: CoarseGrid, top: number, bottom: number): void {
    const f = grid.factor;
    for (let r = Math.floor(top / f); r * f < bottom; r++) {
      mergeRows(this.merged, this.taken, this.stride, r * f, f);
      grid.update(r, this.merged, this.stride);
    }
  }

  /** The coarse grid a shape searches on, brought up to date the first time it is used. */
  private gridFor(shape: CoarseShape): CoarseGrid {
    const grid = this.grids.find((g) => g.factor === shape.factor) as CoarseGrid;
    if (!grid.inUse) {
      grid.inUse = true;
      this.refresh(grid, 0, this.rows);
    }
    return grid;
  }

  /** True when the raster, with its top-left cell at (x, y), touches no taken cell. */
  private free(raster: Raster, x: number, y: number): boolean {
    const last = Math.min(raster.rows, this.rows - y);
    const { bits, stride } = raster;
    for (let r = 0; r < last; r++) {
      if (rowsMeet(this.taken, (y + r) * this.stride, this.stride, bits, r * stride, stride, x)) {
        return false;
      }
    }
    return true;
  }

  /** True when the leading cells of a shape, with its top-left cell at (x, y), are free. */
  private edgeFree(edge: Edge, x: number, y: number): boolean {
    const word = x >> 5;
    const bit = x & 31;
    const { taken, stride } = this;
    for (let i = 0; i < edge.count; i++) {
      const row = y + (edge.rows[i] as number);
      if (row >= this.rows) break;
      const v = edge.bits[i] as number;
      const t = (edge.words[i] as number) + word;
      const at = row * stride + t;
      if (t < stride && ((taken[at] as number) & (v << bit)) !== 0) return false;
      if (bit !== 0 && t + 1 < stride && ((taken[at + 1] as number) & (v >>> (32 - bit))) !== 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Slides a spot from `find` up, then left, a cell at a time until neither is possible. Kept
   * apart from `find` so a caller comparing several turns only pays for the one it keeps.
   */
  settle(raster: Raster, spot: FoundSpot): Spot {
    const { minY } = spot;
    const { up, left } = edgesOf(raster);
    let { x, y } = spot;
    for (;;) {
      const before = x + y;
      while (y > minY && this.edgeFree(up, x, y - 1)) y--;
      while (x > 0 && this.edgeFree(left, x - 1, y)) x--;
      if (x + y === before) return { x, y };
    }
  }

  /**
   * The first free spot for a shape, top to bottom then left to right, on the coarse grid:
   * free, but up to a coarse cell from its neighbours until `settle` tightens it.
   *
   * Args:
   *   raster: The design's cells, with its footprint's top-left corner on a cell corner.
   *   widthMm: Footprint width; the footprint stays inside the sheet width.
   *   heightMm: Footprint height; in a split job the footprint stays inside one sheet.
   *   maxTop: Lowest row the spot's top may be on (a caller that already has a better spot).
   *
   * Returns:
   *   The top-left cell of the spot, or null when there is none.
   */
  find(raster: Raster, widthMm: number, heightMm: number, maxTop = Infinity): FoundSpot | null {
    const maxX = Math.floor((this.widthMm - widthMm) / this.cellMm + SNAP);
    if (maxX < 0) return null;
    const ranges = this.bands ?? [{ top: 0, bottom: Infinity }];
    for (const band of ranges) {
      const minY = Math.ceil(band.top / this.cellMm - SNAP);
      const bandMax = Math.floor((band.bottom - heightMm) / this.cellMm + SNAP);
      const maxY = Math.min(bandMax, this.rowLimit - raster.rows, maxTop);
      if (minY > maxTop) return null;
      if (maxY < minY) continue;
      const spot = this.findIn(raster, minY, maxY, maxX);
      if (spot) return { ...spot, minY };
    }
    return null;
  }

  /** Scans one sheet: its top row is tried cell by cell first, then the coarse grid. */
  private findIn(raster: Raster, minY: number, maxY: number, maxX: number): Spot | null {
    const shape = coarseOf(raster, maxX);
    const f = shape.factor;
    const grid = this.gridFor(shape);
    const firstRow = Math.ceil(minY / f);
    const lastRow = Math.floor(maxY / f);
    const lastCol = Math.floor(maxX / f);
    // A sheet's top is rarely on a coarse row, and a shape nearly as tall as its sheet may fit
    // on no coarse row at all: try the sheet's own top row.
    if (minY % f !== 0) {
      for (let x = 0; x <= maxX; x += f) {
        if (this.free(raster, x, minY)) return { x, y: minY };
      }
    }
    const start = Math.max(firstRow, this.scanned.get(raster) ?? 0);
    for (let y = start; y <= lastRow; y++) {
      if (!grid.roomFor(shape, y)) continue;
      for (let x = 0; x <= lastCol; x++) {
        if (grid.free(shape, x, y)) {
          this.scanned.set(raster, y);
          return { x: x * f, y: y * f };
        }
      }
    }
    this.scanned.set(raster, Math.max(start, lastRow + 1));
    return null;
  }
}
