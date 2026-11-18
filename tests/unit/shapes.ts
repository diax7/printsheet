/**
 * Synthetic shapes for the Real shape tests: masks drawn as text ('#' is ink), and a design
 * builder. No real artwork is ever used in tests.
 */
import { withSum, type ShapeMask } from '@/model/mask';
import { DEFAULT_SETTINGS, type Design, type Settings, type Sheet } from '@/model/types';

/** A mask from rows of text: '#' is ink, anything else is empty. */
export function maskOf(...rows: string[]): ShapeMask {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = new Uint8Array(cols * rows.length);
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === '#') cells[r * cols + c] = 1;
  });
  return withSum({ cols, rows: rows.length, cells });
}

/** An L: a full left column and a full bottom row, each a quarter of the size thick. */
export const L_SHAPE = maskOf('#...', '#...', '#...', '####');
/** A ring: ink around an empty middle. */
export const RING = maskOf('#####', '#...#', '#...#', '#...#', '#####');
/** A diagonal strip, like slanted lettering. */
export const SLASH = maskOf('....##', '...##.', '..##..', '.##...', '##....');
/** A right triangle with its right angle at the bottom-left. */
export const WEDGE = maskOf('#.....', '##....', '###...', '####..', '#####.', '######');

export const SHAPES: ReadonlyMap<string, ShapeMask> = new Map([
  ['l', L_SHAPE],
  ['ring', RING],
  ['slash', SLASH],
  ['wedge', WEDGE],
]);

export function design(
  id: string,
  assetId: string,
  w: number,
  h: number,
  over: Partial<Design> = {},
): Design {
  return {
    id,
    assetId,
    name: id,
    xMm: w / 2,
    yMm: h / 2,
    widthMm: w,
    heightMm: h,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
    ...over,
  };
}

export function sheetOf(designs: Design[], settings: Partial<Settings> = {}): Sheet {
  return { designs, settings: { ...DEFAULT_SETTINGS, spacing: 'shape', ...settings } };
}

/** Deterministic pseudo-random numbers so property tests are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A random mask of the given size with roughly `density` of its cells set, never empty. */
export function randomMask(
  rand: () => number,
  cols: number,
  rows: number,
  density = 0.5,
): ShapeMask {
  const cells = new Uint8Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = rand() < density ? 1 : 0;
  cells[Math.floor(rand() * cells.length)] = 1;
  return withSum({ cols, rows, cells });
}
