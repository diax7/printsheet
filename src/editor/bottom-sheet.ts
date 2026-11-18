/**
 * A phone bottom sheet: a panel that slides up over the lower part of the sheet without blocking
 * it (role="dialog", aria-modal="false"), so the design stays visible and tappable above it.
 *
 * Opening moves focus to the sheet's heading; closing gives focus back to the bar button that
 * opened it (or to the sheet when that button is gone). It closes with its Close button, Escape,
 * or a swipe down on the drag handle. Its height is capped by CSS at about half the screen; its
 * body scrolls on its own.
 */
import { byId, el, icon, isTyping } from '@/editor/dom';
import { dragCloses } from '@/editor/sheet-maths';

export interface BottomSheet {
  readonly element: HTMLElement;
  /** Where the sheet's content goes. */
  readonly body: HTMLElement;
  /** Shows the sheet; `returnFocus` names where focus goes when it closes. */
  open(returnFocus: () => HTMLElement | null): void;
  close(): void;
  isOpen(): boolean;
  setTitle(text: string): void;
}

export interface BottomSheetOptions {
  id: string;
  title: string;
  /** Called after the sheet is shown (and laid out), and after it is hidden. */
  onOpen?(): void;
  onClose?(): void;
}

/** Follows a drag on the handle; a long enough pull closes the sheet, a short one snaps back. */
function wireDrag(handle: HTMLElement, sheet: HTMLElement, close: () => void): void {
  let startY: number | null = null;
  const pulled = (event: PointerEvent): number => Math.max(0, event.clientY - (startY ?? 0));
  handle.addEventListener('pointerdown', (event) => {
    startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (startY !== null) sheet.style.setProperty('--sheet-drag', `${pulled(event)}px`);
  });
  const end = (event: PointerEvent): void => {
    if (startY === null) return;
    const closes = dragCloses(pulled(event), sheet.offsetHeight);
    startY = null;
    sheet.style.removeProperty('--sheet-drag');
    if (closes) close();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', () => {
    startY = null;
    sheet.style.removeProperty('--sheet-drag');
  });
}

const noButton = (): HTMLElement | null => null;

/** Builds a closed sheet; the caller puts `element` in the page. */
export function createBottomSheet(options: BottomSheetOptions): BottomSheet {
  const titleId = `${options.id}-title`;
  const heading = el('h2', { id: titleId, tabindex: '-1', text: options.title });
  const closeButton = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close' },
    icon('close'),
  );
  const handle = el('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
  const body = el('div', { class: 'sheet-body' });
  const element = el(
    'section',
    {
      class: 'bottom-sheet',
      id: options.id,
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': titleId,
      hidden: true,
    },
    handle,
    el('div', { class: 'sheet-head' }, heading, closeButton),
    body,
  );
  // Set by each open(); until then there is no button to go back to.
  let returnFocus: () => HTMLElement | null = noButton;

  function close(): void {
    if (element.hidden) return;
    const hadFocus = element.contains(document.activeElement);
    element.hidden = true;
    element.style.removeProperty('--sheet-drag');
    if (hadFocus) {
      const target = returnFocus();
      (target?.offsetParent ? target : byId('scroller')).focus({ preventScroll: true });
    }
    options.onClose?.();
  }

  closeButton.addEventListener('click', close);
  element.addEventListener('keydown', (event) => {
    // Escape in a field only leaves the field (the editor's own rule); elsewhere it closes.
    if (event.key !== 'Escape' || isTyping()) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  wireDrag(handle, element, close);

  return {
    element,
    body,
    open(focusBack) {
      returnFocus = focusBack;
      element.hidden = false;
      heading.focus({ preventScroll: true });
      options.onOpen?.();
    },
    close,
    isOpen: () => !element.hidden,
    setTitle(text) {
      heading.textContent = text;
    },
  };
}
