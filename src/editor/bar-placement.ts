/**
 * Where the floating action bar goes, worked out from boxes alone so it can be tested without a
 * browser. All values are pixels in the stage's visible area (0, 0 is its top-left corner).
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface BarPlacement {
  left: number;
  top: number;
  /** Below the selection (the owner's choice), above it, or inside the view's bottom edge. */
  side: 'below' | 'above' | 'inside';
}

/** Space between the selection (or its lowest handle) and the bar under it. */
export const BELOW_GAP_PX = 10;
/**
 * When the bar flips above, its bottom edge stays this far above the selection's top: the size
 * label is drawn 8 to 30 px above it and Fabric's rotate handle about 40 px (plus its own
 * radius), so 72 px leaves both visible with room to aim at them.
 */
export const ABOVE_CLEARANCE_PX = 72;
/** The bar never touches the edges of the view. */
export const EDGE_PX = 8;

export interface BarInput {
  /** The selection's box on screen. */
  box: Rect;
  /** The same box grown to take in the selection's handles (the rotate handle can be below). */
  reach: Rect;
  bar: Size;
  area: Size;
}

function outOfView(box: Rect, area: Size): boolean {
  return box.bottom < 0 || box.top > area.height || box.right < 0 || box.left > area.width;
}

function verticalPlace(input: BarInput): Pick<BarPlacement, 'top' | 'side'> {
  const { box, reach, bar, area } = input;
  const below = reach.bottom + BELOW_GAP_PX;
  if (below + bar.height <= area.height - EDGE_PX) return { top: below, side: 'below' };
  const aboveBottom = Math.min(box.top - ABOVE_CLEARANCE_PX, reach.top - BELOW_GAP_PX);
  if (aboveBottom - bar.height >= EDGE_PX) return { top: aboveBottom - bar.height, side: 'above' };
  // A selection taller than the view: keep the bar on screen, over the selection's lower part.
  return { top: area.height - EDGE_PX - bar.height, side: 'inside' };
}

/**
 * The bar's position: below the selection when it fits, flipped above when it does not, centred
 * on the selection and kept inside the view. Null when the selection is wholly out of view.
 */
export function placeBar(input: BarInput): BarPlacement | null {
  const { box, bar, area } = input;
  if (outOfView(box, area)) return null;
  const centre = (box.left + box.right) / 2;
  const maxLeft = area.width - EDGE_PX - bar.width;
  const left = Math.max(EDGE_PX, Math.min(centre - bar.width / 2, maxLeft));
  return { left, ...verticalPlace(input) };
}
