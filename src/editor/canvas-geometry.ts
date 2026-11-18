/**
 * Where designs are on the page, for the views laid over the canvas (the action bar, the
 * right-click menu). The model gives the designs' boxes; Fabric adds the handles of the active
 * selection, which can stick out (the rotate handle).
 */
import { Intersection, Point, type Canvas, type FabricObject } from 'fabric';
import { corners } from '@/model/geometry';
import type { Design } from '@/model/types';
import type { Rect } from '@/editor/bar-placement';
import type { Store } from '@/store/store';

/** Where a selection is on the page, in client pixels. */
export interface ScreenBox {
  /** The designs' own box. */
  box: Rect;
  /** The box grown to take in the visible handles (the rotate handle can stick out). */
  reach: Rect;
}

function bounds(points: ReadonlyArray<{ x: number; y: number }>): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/** The box grown by the object's visible handles (Fabric gives them relative to the canvas). */
function withHandles(box: Rect, obj: FabricObject, offset: { x: number; y: number }): Rect {
  const radius = obj.cornerSize / 2;
  const reach = { ...box };
  for (const [key, c] of Object.entries(obj.oCoords)) {
    if (!obj.isControlVisible(key)) continue;
    reach.left = Math.min(reach.left, offset.x + c.x - radius);
    reach.top = Math.min(reach.top, offset.y + c.y - radius);
    reach.right = Math.max(reach.right, offset.x + c.x + radius);
    reach.bottom = Math.max(reach.bottom, offset.y + c.y + radius);
  }
  return reach;
}

/** True when the canvas's active selection is exactly these designs. */
function isActiveSelection(canvas: Canvas, ids: readonly string[]): boolean {
  const active = canvas
    .getActiveObjects()
    .map((o) => (o as FabricObject & { designId?: string }).designId);
  return active.length === ids.length && active.every((id) => id !== undefined && ids.includes(id));
}

/** Where these designs are on the page (client px), or null when none of them exists. */
export function screenBoxOf(
  canvas: Canvas,
  canvasEl: HTMLCanvasElement,
  store: Store,
  ids: readonly string[],
): ScreenBox | null {
  const chosen = store.get().sheet.designs.filter((d) => ids.includes(d.id));
  if (chosen.length === 0) return null;
  const v = canvas.viewportTransform;
  const rect = canvasEl.getBoundingClientRect();
  const box = bounds(
    chosen
      .flatMap(corners)
      .map((p) => ({ x: rect.left + p.x * v[0] + v[4], y: rect.top + p.y * v[3] + v[5] })),
  );
  const active = canvas.getActiveObject();
  if (!active?.hasControls || !isActiveSelection(canvas, ids)) return { box, reach: box };
  return { box, reach: withHandles(box, active, { x: rect.left, y: rect.top }) };
}

/** The id of the topmost design under a page point, or null over empty sheet or mat. */
export function designAt(
  canvas: Canvas,
  canvasEl: HTMLCanvasElement,
  store: Store,
  client: { x: number; y: number },
): string | null {
  const v = canvas.viewportTransform;
  const rect = canvasEl.getBoundingClientRect();
  const point = new Point(
    (client.x - rect.left - v[4]) / v[0],
    (client.y - rect.top - v[5]) / v[3],
  );
  const inside = (d: Design): boolean =>
    Intersection.isPointInPolygon(
      point,
      corners(d).map((c) => new Point(c.x, c.y)),
    );
  return store.get().sheet.designs.findLast(inside)?.id ?? null;
}
