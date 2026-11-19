import { PLACEMENT_DPI, type Design, type ImageAsset, type Point, type Sheet } from '@/model/types';
import { MM_PER_INCH, pxToMm } from '@/model/units';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type DpiLevel = 'good' | 'ok' | 'low';

/** The four corners of a design's rotated rectangle, clockwise from top-left. */
export function corners(d: Design): Point[] {
  const rad = (d.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = d.widthMm / 2;
  const hh = d.heightMm / 2;
  const local: Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return local.map((p) => ({
    x: d.xMm + p.x * cos - p.y * sin,
    y: d.yMm + p.x * sin + p.y * cos,
  }));
}

/** Axis-aligned bounds of the rotated rectangle: the space the design takes on the film. */
export function footprint(d: Design): Box {
  const pts = corners(d);
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Bounds of several designs together, or null when there are none. */
export function unionFootprint(designs: readonly Design[]): Box | null {
  if (designs.length === 0) return null;
  const boxes = designs.map(footprint);
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

/**
 * Film needed for the content: the lowest footprint edge, rounded up to the next centimetre.
 * A tiny epsilon keeps floating-point noise (100.0000000001) from adding a whole centimetre.
 */
export function contentLengthMm(designs: readonly Design[]): number {
  const box = unionFootprint(designs);
  if (!box) return 0;
  return Math.ceil(box.maxY / 10 - 1e-9) * 10;
}

/** The sheet's length: the content in auto mode, the typed length in fixed mode. */
export function sheetLengthMm(sheet: Sheet): number {
  return sheet.settings.lengthMode === 'fixed'
    ? sheet.settings.fixedLengthMm
    : contentLengthMm(sheet.designs);
}

/** Print sharpness at the placed size; the worse of the two axes. */
export function effectiveDpi(d: Design, asset: ImageAsset): number {
  const dpiX = asset.widthPx / (d.widthMm / MM_PER_INCH);
  const dpiY = asset.heightPx / (d.heightMm / MM_PER_INCH);
  return Math.min(dpiX, dpiY);
}

export function dpiLevel(dpi: number): DpiLevel {
  if (dpi >= 300) return 'good';
  if (dpi >= 150) return 'ok';
  return 'low';
}

/** A new image's size: its 300 DPI size, scaled down to fit the sheet width when wider. */
export function initialSize(
  asset: Pick<ImageAsset, 'widthPx' | 'heightPx' | 'vector'>,
  sheetWidthMm: number,
): { widthMm: number; heightMm: number } {
  // A vector carries its own print size; a pixel image is placed at 300 DPI.
  const widthMm = asset.vector?.sizeMm.w ?? pxToMm(asset.widthPx, PLACEMENT_DPI);
  const heightMm = asset.vector?.sizeMm.h ?? pxToMm(asset.heightPx, PLACEMENT_DPI);
  if (widthMm <= sheetWidthMm) return { widthMm, heightMm };
  const scale = sheetWidthMm / widthMm;
  return { widthMm: sheetWidthMm, heightMm: heightMm * scale };
}

function project(poly: readonly Point[], ax: number, ay: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const v = p.x * ax + p.y * ay;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** Separating-axis test for two convex polygons. */
function convexOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i] as Point;
      const p2 = poly[(i + 1) % poly.length] as Point;
      const ax = -(p2.y - p1.y);
      const ay = p2.x - p1.x;
      const [minA, maxA] = project(a, ax, ay);
      const [minB, maxB] = project(b, ax, ay);
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

function pointSegmentDistance(p: Point, s1: Point, s2: Point): number {
  const dx = s2.x - s1.x;
  const dy = s2.y - s1.y;
  const lenSq = dx * dx + dy * dy;
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s1.x) * dx + (p.y - s1.y) * dy) / lenSq));
  return Math.hypot(p.x - (s1.x + t * dx), p.y - (s1.y + t * dy));
}

/** Shortest distance between two convex polygons; 0 when they touch or overlap. */
export function polygonDistance(a: readonly Point[], b: readonly Point[]): number {
  if (convexOverlap(a, b)) return 0;
  let best = Infinity;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const p of from) {
      for (let i = 0; i < to.length; i++) {
        const d = pointSegmentDistance(p, to[i] as Point, to[(i + 1) % to.length] as Point);
        if (d < best) best = d;
      }
    }
  }
  return best;
}
