/**
 * Space + drag moves around the sheet, as in Photoshop, Figma and Canva. While Space is held the
 * cursor is a hand and Fabric finds no designs, and the press itself is caught before Fabric sees
 * it (capture phase), so panning never selects, deselects or moves a design.
 *
 * Space is left alone while a button, field or menu item has focus, where it has its own meaning
 * (pressing the button, typing a space).
 */
import { isTyping } from '@/editor/dom';
import type { CanvasView } from '@/editor/canvas';

/** True when Space should go to the focused control instead. */
function spaceBelongsToFocus(): boolean {
  const active = document.activeElement;
  if (isTyping()) return true;
  return active instanceof HTMLButtonElement || active?.getAttribute('role') === 'menuitem';
}

const isSpace = (event: KeyboardEvent): boolean => event.code === 'Space' || event.key === ' ';

/** Wires Space + drag panning on `surface` (the element that holds the canvas). */
export function mountSpacePan(view: CanvasView, surface: HTMLElement): void {
  let held = false;
  let last: { x: number; y: number } | null = null;

  const release = (): void => {
    held = false;
    last = null;
    view.setPanMode('off');
  };

  document.addEventListener('keydown', (event) => {
    if (!isSpace(event) || spaceBelongsToFocus() || document.querySelector('dialog[open]')) return;
    // The sheet's scroll box would also scroll a page down on Space.
    event.preventDefault();
    if (held) return;
    held = true;
    view.setPanMode('ready');
  });
  document.addEventListener('keyup', (event) => {
    if (isSpace(event) && held) release();
  });
  window.addEventListener('blur', () => {
    if (held) release();
  });

  surface.addEventListener(
    'pointerdown',
    (event) => {
      if (!held || event.button !== 0) return;
      // Cancelling the press also stops the mouse events Fabric listens to.
      event.preventDefault();
      event.stopPropagation();
      last = { x: event.clientX, y: event.clientY };
      surface.setPointerCapture(event.pointerId);
      view.setPanMode('panning');
    },
    { capture: true },
  );
  surface.addEventListener(
    'mousedown',
    (event) => {
      if (held) event.stopPropagation();
    },
    { capture: true },
  );
  surface.addEventListener('pointermove', (event) => {
    if (!last) return;
    view.panBy(last.x - event.clientX, last.y - event.clientY);
    last = { x: event.clientX, y: event.clientY };
  });
  const end = (): void => {
    if (!last) return;
    last = null;
    view.setPanMode(held ? 'ready' : 'off');
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
}
