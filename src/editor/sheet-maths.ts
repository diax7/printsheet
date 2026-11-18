/**
 * The arithmetic of the phone's bottom sheets, kept free of the DOM so it can be tested on its
 * own. All values are CSS pixels.
 */

/**
 * How far to lift an open sheet so the on-screen keyboard does not cover it: the part of the
 * page (layout viewport) below what is visible. The visible part is the visual viewport, which
 * the browser may also scroll down (`offsetTop`). Never negative: pinch zoom shrinks the visual
 * viewport without anything covering the page.
 */
export function sheetLift(innerHeight: number, viewportHeight: number, offsetTop: number): number {
  return Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop));
}

/** A sheet pulled down by its handle closes past a third of its height, or 100 px if less. */
export function dragCloses(dragged: number, sheetHeight: number): boolean {
  return dragged >= Math.min(100, sheetHeight / 3);
}

/** Space kept between a design and the sheet's top edge, or the top of the view. */
const CLEAR_PX = 16;

/**
 * How far to scroll the sheet up so the selected design sits above an open bottom sheet: zero
 * when it already does. A design taller than the room left keeps its top in view instead.
 */
export function revealOffset(
  design: { top: number; bottom: number },
  view: { top: number; sheetTop: number },
): number {
  const covered = design.bottom - (view.sheetTop - CLEAR_PX);
  if (covered <= 0) return 0;
  const roomAbove = design.top - (view.top + CLEAR_PX);
  return Math.max(0, Math.min(covered, roomAbove));
}

/**
 * Where the sheet's scroll box should be once the extra room an open bottom sheet added is taken
 * away: unchanged when it still fits, else at the new end.
 */
export function scrollWithoutRoom(
  scrollTop: number,
  scrollHeight: number,
  room: number,
  clientHeight: number,
): number {
  return Math.min(scrollTop, Math.max(0, scrollHeight - room - clientHeight));
}
