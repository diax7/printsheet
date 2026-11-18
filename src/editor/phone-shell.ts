/**
 * The phone layout (820 px wide and less): one screen with the top bar, the sheet and a bottom
 * bar; the panels open as bottom sheets.
 *
 * One UI, moved, not copied: the controls a computer shows in its panels and top bar are the
 * same elements here, moved into the sheets when the window becomes narrow and put back when it
 * becomes wide again. They keep their ids and handlers, and the code that draws them
 * (`mountPanel`, `mountInspector`) does not know where they are. Nothing moves while the user is
 * typing in a field that would move; it moves once the field is left.
 */
import { createBottomSheet, type BottomSheet } from '@/editor/bottom-sheet';
import { closeMenu } from '@/editor/menu';
import { phoneBar, selectionMenu } from '@/editor/phone-bar';
import { openMenu } from '@/editor/menu';
import { revealOffset, scrollWithoutRoom, sheetLift } from '@/editor/sheet-maths';
import type { ActionBarDeps } from '@/editor/action-bar';
import { byId, el, isTyping } from '@/editor/dom';
import type { Store } from '@/store/store';

export const PHONE_QUERY = '(max-width: 820px)';

type SheetName = 'designs' | 'settings' | 'size' | 'more';

export interface PhoneShellDeps extends ActionBarDeps {
  /** The app's grid; the bottom bar and the sheets are added at its end. */
  app: HTMLElement;
  /** The stage, which shows the busy message on a phone. */
  stage: HTMLElement;
}

/** An element and where it goes on a phone; `marker` holds its place on a computer. */
interface Move {
  node: HTMLElement;
  into: HTMLElement;
  marker: Comment;
}

function find(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`The page is missing ${selector}`);
  return node;
}

/** A titled group inside the More sheet. */
function group(title: string): HTMLElement {
  return el('div', { class: 'sheet-group' }, el('h3', { text: title }));
}

/** Every element that moves, in the order it is put into its sheet. */
function plannedMoves(sheets: Record<SheetName, BottomSheet>, stage: HTMLElement): Move[] {
  const file = group('File');
  const view = el('div', { class: 'sheet-tools' });
  const viewGroup = group('View');
  viewGroup.append(view);
  const about = el('div', { class: 'sheet-group' });
  sheets.more.body.append(file, viewGroup, about);
  const plan: Array<[string, HTMLElement]> = [
    ['#inspector', sheets.size.body],
    ['.film', sheets.settings.body],
    ['section[aria-labelledby="sheet-heading"]', sheets.settings.body],
    ['.designs', sheets.designs.body],
    ['#file-actions', file],
    ['#save-status', file],
    ['#zoom-out', view],
    ['#zoom-value', view],
    ['#zoom-in', view],
    ['#zoom-fit', view],
    ['.bg-picker', view],
    ['#grid-toggle', view],
    ['#about', about],
    ['#busy', stage],
  ];
  return plan.map(([selector, into]) => ({
    node: find(selector),
    into,
    marker: document.createComment(`phone layout: ${selector}`),
  }));
}

/**
 * Multi-select on a phone (no Ctrl+click): a box on each row of the design list ticks that design
 * in or out, and Select all / Select none sits above the list. The boxes are drawn by the panel;
 * their clicks are caught here, before the list's own handler would choose only that design.
 */
function mountDesignChecks(store: Store, into: HTMLElement): { render(): void } {
  const list = byId('design-list');
  const all = el('button', { class: 'btn btn-outline', type: 'button', id: 'select-all' });
  into.append(el('div', { class: 'sheet-group sheet-tools' }, all));
  const everyId = (): string[] => store.get().sheet.designs.map((d) => d.id);
  const allChosen = (): boolean => {
    const { sheet, selection } = store.get();
    return sheet.designs.length > 0 && selection.length === sheet.designs.length;
  };
  all.addEventListener('click', () => store.setSelection(allChosen() ? [] : everyId()));
  list.addEventListener(
    'click',
    (event) => {
      const hit = (event.target as HTMLElement).closest('.design-check-hit');
      const box = hit?.querySelector<HTMLInputElement>('.design-check');
      const id = hit?.closest<HTMLElement>('[data-id]')?.dataset['id'];
      if (!box || !id) return;
      // Never the list's own click, which would choose only this design.
      event.stopPropagation();
      // A tap on the label around the box: the browser follows it with a click on the box.
      if (event.target !== box) return;
      const current = store.get().selection.filter((s) => s !== id);
      store.setSelection(box.checked ? [...current, id] : current);
      // The list was drawn again; keep focus on this design's box.
      list.querySelector<HTMLElement>(`[data-id="${id}"] .design-check`)?.focus();
    },
    { capture: true },
  );
  list.addEventListener(
    'keydown',
    (event) => {
      // Space ticks the box (its own click); the list's Enter and Space choose only one design.
      const onBox = (event.target as HTMLElement).classList.contains('design-check');
      if (onBox && (event.key === ' ' || event.key === 'Enter')) event.stopPropagation();
    },
    { capture: true },
  );
  return {
    render() {
      all.textContent = allChosen() ? 'Select none' : 'Select all';
      all.disabled = store.get().sheet.designs.length === 0;
    },
  };
}

const isField = (node: EventTarget | null): boolean =>
  node instanceof HTMLInputElement ||
  node instanceof HTMLSelectElement ||
  node instanceof HTMLTextAreaElement;

/**
 * The on-screen keyboard covers the bottom of the page without resizing it: open sheets rise by
 * the part it covers, so the field being typed in stays visible. Leaving a field scrolls the page
 * back to the top, where iPhone Safari may leave it after the keyboard closes.
 */
function mountKeyboardLift(sheets: readonly BottomSheet[]): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const lift = (): void => {
    const px = sheetLift(window.innerHeight, viewport.height, viewport.offsetTop);
    for (const sheet of sheets) sheet.element.style.setProperty('--sheet-lift', `${px}px`);
  };
  viewport.addEventListener('resize', lift);
  viewport.addEventListener('scroll', lift);
  for (const sheet of sheets) {
    sheet.element.addEventListener('focusout', (event) => {
      // Moving on to another field keeps the keyboard up: nothing to scroll back yet.
      if (isField(event.target) && !isField(event.relatedTarget)) window.scrollTo(0, 0);
    });
  }
}

function createSheets(onClose: () => void): Record<SheetName, BottomSheet> {
  return {
    designs: createBottomSheet({ id: 'sheet-designs', title: 'Designs', onClose }),
    settings: createBottomSheet({ id: 'sheet-settings', title: 'Sheet', onClose }),
    size: createBottomSheet({ id: 'sheet-size', title: 'Size', onClose }),
    more: createBottomSheet({ id: 'sheet-more', title: 'More', onClose }),
  };
}

/**
 * Takes away the extra scroll room, first bringing the scroll position inside what is left, so
 * the canvas follows one deliberate scroll instead of whatever the browser does when its content
 * shrinks.
 */
function dropSheetRoom(scroller: HTMLElement): void {
  const room = Number.parseFloat(scroller.style.getPropertyValue('--sheet-room')) || 0;
  const top = scrollWithoutRoom(
    scroller.scrollTop,
    scroller.scrollHeight,
    room,
    scroller.clientHeight,
  );
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  scroller.style.removeProperty('--sheet-room');
}

/** Scrolls the sheet so the selected design sits above an open bottom sheet. */
function revealSelection(deps: PhoneShellDeps, sheet: HTMLElement): void {
  const { store, view, scroller } = deps;
  // Room to scroll a design near the end of a short sheet up above the bottom sheet.
  scroller.style.setProperty('--sheet-room', `${sheet.offsetHeight}px`);
  requestAnimationFrame(() => {
    const screen = view.screenBox(store.get().selection);
    if (!screen) return;
    const dy = revealOffset(
      { top: screen.box.top, bottom: screen.box.bottom },
      { top: scroller.getBoundingClientRect().top, sheetTop: sheet.getBoundingClientRect().top },
    );
    if (dy > 0) view.panBy(0, dy);
  });
}

/**
 * Mounts the phone layout; it follows the window's width from then on. Returns a way to open the
 * selection's More menu at a point (a long press).
 */
export function mountPhoneShell(deps: PhoneShellDeps): {
  openMoreAt(at: { x: number; y: number }): void;
} {
  const { app, store, scroller } = deps;
  // With no sheet open, the extra scroll room for revealing a design goes away.
  const sheets = createSheets(() => {
    if (!Object.values(sheets).some((s) => s.isOpen())) dropSheetRoom(scroller);
  });
  const barElement = el('nav', { class: 'phone-bar', id: 'phone-bar', 'aria-label': 'Tools' });
  app.append(barElement, ...Object.values(sheets).map((s) => s.element));
  const checks = mountDesignChecks(store, sheets.designs.body);
  mountKeyboardLift(Object.values(sheets));
  const moves = plannedMoves(sheets, deps.stage);
  const query = matchMedia(PHONE_QUERY);
  let phone = false;

  const closeSheets = (): void => {
    for (const sheet of Object.values(sheets)) sheet.close();
  };
  const sizeTitle = (): string => (store.get().selection.length > 1 ? 'Selected designs' : 'Size');

  function toggleSheet(name: SheetName, opener: string): void {
    const sheet = sheets[name];
    if (sheet.isOpen()) return sheet.close();
    closeSheets();
    closeMenu();
    if (name === 'size') sheet.setTitle(sizeTitle());
    sheet.open(() => barElement.querySelector<HTMLElement>(`[data-action="${opener}"]`));
    revealSelection(deps, sheet.element);
  }
  const bar = phoneBar(barElement, deps, { toggleSheet });

  /** Puts every element where the window's width wants it, unless a field that moves is in use. */
  function sync(): void {
    const want = query.matches;
    if (want === phone) return;
    const active = document.activeElement;
    if (isTyping() && active && moves.some((m) => m.node.contains(active))) {
      active.addEventListener('focusout', () => setTimeout(sync), { once: true });
      return;
    }
    phone = want;
    closeMenu();
    if (phone) {
      for (const m of moves) {
        m.node.replaceWith(m.marker);
        m.into.append(m.node);
      }
      bar.render();
      checks.render();
    } else {
      closeSheets();
      bar.clear();
      for (const m of moves) m.marker.replaceWith(m.node);
    }
  }

  store.subscribe((state, previous) => {
    if (!phone) return;
    bar.render();
    checks.render();
    // A tap on empty canvas deselects: the sheet about the selection goes with it.
    if (state.selection.length === 0 && previous.selection.length > 0) sheets.size.close();
    else if (sheets.size.isOpen()) sheets.size.setTitle(sizeTitle());
  });
  query.addEventListener('change', sync);
  sync();
  return {
    openMoreAt(at) {
      const menu = selectionMenu(deps, { toggleSheet });
      if (!menu) return;
      openMenu({
        ...menu,
        at,
        returnFocus: barElement.querySelector<HTMLElement>('[data-action="more"]'),
        fallbackFocus: scroller,
        focusFirst: false,
      });
    },
  };
}
