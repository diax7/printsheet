/**
 * The thresholds and arithmetic of finger gestures on the sheet (touch.ts), kept free of the DOM
 * so they can be tested on their own. Distances are CSS pixels, times milliseconds.
 */

export interface Spot {
  x: number;
  y: number;
}

/** A tap moves less than this and lasts less than `TAP_MS`. */
export const TAP_MOVE_PX = 10;
export const TAP_MS = 300;
/** Held this long on a design, a finger opens its menu... */
export const LONG_PRESS_MS = 600;
/** ...unless it moved further than this first. */
export const LONG_PRESS_MOVE_PX = 8;

export function distance(a: Spot, b: Spot): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Spot, b: Spot): Spot {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** A finger that has moved this far is panning (and is no longer a tap). */
export function startsPan(moved: number): boolean {
  return moved >= TAP_MOVE_PX;
}

export function cancelsLongPress(moved: number): boolean {
  return moved > LONG_PRESS_MOVE_PX;
}

/**
 * What a lifted single finger did, when it neither panned nor long-pressed: a tap when short and
 * still, otherwise nothing.
 */
export function releaseKind(moved: number, elapsed: number): 'tap' | 'none' {
  return moved < TAP_MOVE_PX && elapsed < TAP_MS ? 'tap' : 'none';
}

/** The zoom for a pinch: the starting zoom scaled by how far the fingers have spread. */
export function pinchZoom(startZoom: number, startDistance: number, nowDistance: number): number {
  return startDistance > 0 ? startZoom * (nowDistance / startDistance) : startZoom;
}
