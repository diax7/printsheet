/**
 * One pop-up menu at a time (`role="menu"`), used by the action bar's More and Align buttons,
 * the right-click menu on a design and the top bar's File menu.
 *
 * Keyboard (WAI-ARIA menu pattern): arrows and Home/End move between items, Enter or Space runs
 * one, Escape and Tab close the menu. Escape puts focus back on the button that opened it. A menu
 * opened with the mouse leaves focus where it was, so after a click the arrow keys still move the
 * selected design; one opened from the keyboard focuses its first item.
 */
import { el, icon } from '@/editor/dom';

export interface MenuItem {
  label: string;
  icon?: string;
  /** Extra words for the tooltip, when the label alone is short. */
  title?: string;
  disabled?: boolean;
  run(): void;
}

/** A line between groups of items. */
export const SEPARATOR = 'separator';
export type MenuEntry = MenuItem | typeof SEPARATOR;

export interface MenuOptions {
  /** The menu's accessible name. */
  label: string;
  entries: readonly MenuEntry[];
  /** Under (or over) this button, or at a page point (right-click). */
  at: HTMLElement | { x: number; y: number };
  /** Where Escape puts focus back (the button that opened it). */
  returnFocus: HTMLElement | null;
  /** Where focus goes instead when `returnFocus` is not on screen (hidden, or a phone layout). */
  fallbackFocus?: HTMLElement;
  /** The side of the button to open on when both have room (below unless said). */
  prefer?: 'above' | 'below';
  /** Focus the first item at once (opened from the keyboard). */
  focusFirst: boolean;
  onClose?(): void;
}

interface Open {
  menu: HTMLElement;
  options: MenuOptions;
}

let current: Open | null = null;

const items = (menu: HTMLElement): HTMLButtonElement[] =>
  [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter((b) => !b.disabled);

function entryElement(entry: MenuEntry): HTMLElement {
  if (entry === SEPARATOR) return el('div', { role: 'separator', class: 'menu-sep' });
  const button = el(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      class: 'menu-item',
      tabindex: '-1',
      disabled: entry.disabled,
      title: entry.title,
    },
    entry.icon ? icon(entry.icon) : el('span', { class: 'menu-icon-space' }),
    el('span', { text: entry.label }),
  );
  // A mouse press must not move focus: it stays on the sheet, so arrows keep moving the design.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    closeMenu();
    entry.run();
  });
  return button;
}

const MARGIN_PX = 8;
// Clears the bar around the button (4 px of padding and a 1 px border) by 1 px.
const GAP_PX = 6;

/**
 * The menu's top edge: on the preferred side of the anchor (a button, or a point with no
 * height), on the other side when the preferred one has no room, and always inside the window.
 */
export function menuTop(
  anchor: { top: number; bottom: number },
  height: number,
  viewHeight: number,
  prefer: 'above' | 'below',
): number {
  const below = anchor.bottom + GAP_PX;
  const above = anchor.top - GAP_PX - height;
  const fitsBelow = below + height <= viewHeight - MARGIN_PX;
  const fitsAbove = above >= MARGIN_PX;
  let top = prefer === 'above' ? above : below;
  if (prefer === 'above' && !fitsAbove && fitsBelow) top = below;
  if (prefer === 'below' && !fitsBelow && fitsAbove) top = above;
  return Math.max(MARGIN_PX, Math.min(top, viewHeight - MARGIN_PX - height));
}

/** Next to the button or at the point, on the preferred side when it fits; inside the window. */
function position(menu: HTMLElement, options: MenuOptions): void {
  const { at, prefer = 'below' } = options;
  const anchor =
    at instanceof HTMLElement
      ? at.getBoundingClientRect()
      : { left: at.x, top: at.y, bottom: at.y };
  const width = menu.offsetWidth;
  const left = Math.max(MARGIN_PX, Math.min(anchor.left, window.innerWidth - MARGIN_PX - width));
  const top = menuTop(anchor, menu.offsetHeight, window.innerHeight, prefer);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/** Focus back to the opening button, or to the fallback when that button is not on screen. */
function giveFocusBack(options: MenuOptions): void {
  const target = options.returnFocus?.offsetParent ? options.returnFocus : options.fallbackFocus;
  target?.focus({ preventScroll: true });
}

/** Moves focus between the items with the arrow keys, Home and End (wrapping around). */
function moveFocus(menu: HTMLElement, key: string): void {
  const list = items(menu);
  if (list.length === 0) return;
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  const last = list.length - 1;
  const next: Record<string, number> = {
    ArrowDown: at < 0 || at === last ? 0 : at + 1,
    ArrowUp: at <= 0 ? last : at - 1,
    Home: 0,
    End: last,
  };
  list[next[key] ?? 0]?.focus();
}

const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

// While a menu is open its keys come first (capture phase), so the editor's own shortcuts (arrows
// move the design, Escape deselects) do not also run.
function onKeyDown(event: KeyboardEvent): void {
  if (!current) return;
  const { menu, options } = current;
  if (event.key === 'Escape' || event.key === 'Tab') {
    closeMenu();
    giveFocusBack(options);
  } else if (MOVE_KEYS.has(event.key)) {
    moveFocus(menu, event.key);
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function onPointerDown(event: PointerEvent): void {
  if (!current) return;
  const target = event.target as Node;
  const { menu, options } = current;
  if (menu.contains(target)) return;
  // A press on the opening button is that button's own toggle; leave it to the button.
  if (options.at instanceof HTMLElement && options.at.contains(target)) return;
  closeMenu();
}

/** Opens a menu, closing any other first. */
export function openMenu(options: MenuOptions): void {
  closeMenu();
  const menu = el(
    'div',
    { class: 'menu', role: 'menu', 'aria-label': options.label, id: 'popup-menu' },
    ...options.entries.map(entryElement),
  );
  document.body.append(menu);
  position(menu, options);
  current = { menu, options };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  if (options.focusFirst) items(menu)[0]?.focus();
}

/**
 * Closes the open menu, if any. Focus inside the menu goes back to the opening button, since an
 * item that disappears would otherwise drop focus on the page.
 */
export function closeMenu(): void {
  if (!current) return;
  const { menu, options } = current;
  current = null;
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  const hadFocus = menu.contains(document.activeElement);
  menu.remove();
  if (hadFocus) giveFocusBack(options);
  options.onClose?.();
}

/** True while the menu opened from this button is showing. */
export function isMenuOpenFrom(button: HTMLElement): boolean {
  return current?.options.at === button;
}
