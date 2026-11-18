/**
 * The floating action bar by the selection (PC), so the common actions are next to the design
 * instead of in the side panel: Duplicate, Delete, Lock, Rotate 90°, Flip and More for one
 * design; Duplicate, Delete, Lock all, Align and More for several. More holds the rest (flip
 * vertically, layer order, copies, putting designs back on the sheet, Arrange selection) and also
 * opens on a right-click over a design.
 *
 * It sits in an overlay over the sheet, below the selection, and flips above it near the bottom
 * of the view (placement maths in `bar-placement.ts`). It hides while a design is dragged,
 * scaled or rotated and when the selection is scrolled out of view. Keyboard: a toolbar with one
 * tab stop (roving tabindex, arrow keys), reached with Tab from the sheet or Alt+F10; showing it
 * never moves focus.
 *
 * Every action calls the same functions as the inspector, so both follow the same rules.
 */
import { align, distribute, type AlignEdge } from '@/model/align';
import { findIssues } from '@/model/checks';
import { reorder, rotateBy, type ReorderTarget } from '@/model/ops';
import type { Design } from '@/model/types';
import { deleteUnlocked, duplicateSelected, flip, sheetFix, toggleLock } from '@/editor/actions';
import { placeBar, type Rect } from '@/editor/bar-placement';
import type { CanvasView } from '@/editor/canvas';
import { openCopiesDialog } from '@/editor/copies-dialog';
import { el, icon } from '@/editor/dom';
import { closeMenu, isMenuOpenFrom, openMenu, SEPARATOR, type MenuEntry } from '@/editor/menu';
import type { Store } from '@/store/store';

export interface ActionBarDeps {
  store: Store;
  view: CanvasView;
  /** The layer over the sheet that holds the bar. */
  overlay: HTMLElement;
  /** The sheet's scroll box: the visible area, and where focus goes back to. */
  scroller: HTMLElement;
  /** The element around the canvas, for the right-click menu. */
  surface: HTMLElement;
  /** Starts Arrange for these designs. */
  arrange(ids: readonly string[]): void;
}

export interface BarButton {
  action: string;
  icon: string;
  label: string;
  title: string;
  disabled?: boolean;
  /** Opens a menu instead of acting at once. */
  menu?: () => { label: string; entries: MenuEntry[] };
  run?: () => void;
}

const selected = (store: Store): Design[] => {
  const { sheet, selection } = store.get();
  return sheet.designs.filter((d) => selection.includes(d.id));
};

export function singleButtons(deps: ActionBarDeps, d: Design): BarButton[] {
  const { store } = deps;
  const ids = [d.id];
  return [
    {
      action: 'duplicate',
      icon: 'duplicate',
      label: 'Duplicate',
      title: 'Duplicate (Ctrl+D)',
      run: () => duplicateSelected(store, ids),
    },
    {
      action: 'delete',
      icon: 'delete',
      label: 'Delete',
      title: d.locked ? 'Unlock to delete' : 'Delete (Delete key)',
      disabled: d.locked,
      run: () => deleteUnlocked(store, ids),
    },
    {
      action: 'lock',
      icon: d.locked ? 'unlock' : 'lock',
      label: d.locked ? 'Unlock' : 'Lock',
      title: d.locked ? 'Unlock, so it can be moved and changed' : 'Lock its position and size',
      run: () => toggleLock(store, ids),
    },
    {
      action: 'rotate',
      icon: 'rotate-right',
      label: 'Rotate 90°',
      title: 'Rotate 90° clockwise',
      disabled: d.locked,
      run: () => store.commit(rotateBy(store.get().sheet, ids, 90)),
    },
    {
      action: 'flip',
      icon: 'flip-h',
      label: 'Flip',
      title: 'Flip horizontally',
      disabled: d.locked,
      run: () => flip(store, d.id, 'x'),
    },
    moreButton(deps),
  ];
}

export function manyButtons(deps: ActionBarDeps, chosen: Design[]): BarButton[] {
  const { store } = deps;
  const ids = chosen.map((d) => d.id);
  const anyLocked = chosen.some((d) => d.locked);
  return [
    {
      action: 'duplicate',
      icon: 'duplicate',
      label: 'Duplicate',
      title: 'Duplicate (Ctrl+D)',
      run: () => duplicateSelected(store, ids),
    },
    {
      action: 'delete',
      icon: 'delete',
      label: 'Delete',
      title: 'Delete the unlocked ones (Delete key)',
      run: () => deleteUnlocked(store, ids),
    },
    {
      action: 'lock',
      icon: anyLocked ? 'unlock' : 'lock',
      label: anyLocked ? 'Unlock all' : 'Lock all',
      title: anyLocked ? 'Unlock them all' : 'Lock the position and size of them all',
      run: () => toggleLock(store, ids),
    },
    {
      action: 'align',
      icon: 'align-left',
      label: 'Align',
      title: 'Align or distribute them',
      menu: () => ({ label: 'Align', entries: alignEntries(store, ids) }),
    },
    moreButton(deps),
  ];
}

function moreButton(deps: ActionBarDeps): BarButton {
  return {
    action: 'more',
    icon: 'more',
    label: 'More',
    title: 'More actions (or right-click the design)',
    menu: () => ({ label: 'More actions', entries: moreEntries(deps) }),
  };
}

export function alignEntries(store: Store, ids: string[]): MenuEntry[] {
  const edges: Array<[AlignEdge, string, string]> = [
    ['left', 'align-left', 'Align left'],
    ['center', 'align-center', 'Centre horizontally'],
    ['right', 'align-right', 'Align right'],
    ['top', 'align-top', 'Align top'],
    ['middle', 'align-middle', 'Centre vertically'],
    ['bottom', 'align-bottom', 'Align bottom'],
  ];
  // Distributing needs a design between two others; the tooltip says so only when it is off.
  const fewer = ids.length < 3;
  const distributeEntry = (
    label: string,
    axis: 'horizontal' | 'vertical',
    iconName: string,
  ): MenuEntry => ({
    label,
    icon: iconName,
    disabled: fewer,
    ...(fewer ? { title: 'Needs 3 or more designs' } : {}),
    run: () => store.commit(distribute(store.get().sheet, ids, axis)),
  });
  return [
    ...edges.map(([edge, iconName, label]) => ({
      label,
      icon: iconName,
      run: () => store.commit(align(store.get().sheet, ids, edge)),
    })),
    SEPARATOR,
    distributeEntry('Distribute horizontally', 'horizontal', 'distribute-h'),
    distributeEntry('Distribute vertically', 'vertical', 'distribute-v'),
  ];
}

/** "Move onto the sheet" (or "a sheet") for the unlocked designs that need it, if any do. */
function fixEntry(store: Store, chosen: Design[]): MenuEntry[] {
  const { sheet, assets, masks } = store.get();
  const ids = chosen.filter((d) => !d.locked).map((d) => d.id);
  const outside = new Set<string>();
  for (const [id, list] of findIssues(sheet, assets, masks))
    if (list.some((i) => i.kind === 'outside')) outside.add(id);
  const fix = sheetFix(store, ids, outside);
  return fix ? [SEPARATOR, { label: fix.label, icon: 'arrange', run: fix.run }] : [];
}

/** The More menu, worked out when it opens so it always matches the selection. */
export function moreEntries(deps: ActionBarDeps): MenuEntry[] {
  const { store } = deps;
  const chosen = selected(store);
  const d = chosen[0];
  if (chosen.length > 1)
    return [
      {
        label: 'Arrange selection',
        icon: 'arrange',
        title: 'Pack these designs to use less film',
        run: () => deps.arrange(chosen.map((x) => x.id)),
      },
      ...fixEntry(store, chosen),
    ];
  if (!d) return [];
  const order = (target: ReorderTarget): void =>
    store.commit(reorder(store.get().sheet, d.id, target));
  return [
    {
      label: 'Flip vertically',
      icon: 'flip-v',
      disabled: d.locked,
      run: () => flip(store, d.id, 'y'),
    },
    SEPARATOR,
    { label: 'Bring forward', icon: 'forward', run: () => order('forward') },
    { label: 'Send backward', icon: 'back', run: () => order('back') },
    { label: 'Bring to front', icon: 'forward', run: () => order('front') },
    { label: 'Send to back', icon: 'back', run: () => order('bottom') },
    SEPARATOR,
    { label: 'Add copies…', icon: 'copies', run: () => openCopiesDialog(store, d.id, d.name) },
    ...fixEntry(store, chosen),
  ];
}

function buttonElement(spec: BarButton): HTMLButtonElement {
  const button = el(
    'button',
    {
      type: 'button',
      class: 'bar-btn',
      'data-action': spec.action,
      title: spec.title,
      'aria-label': spec.label,
      disabled: spec.disabled,
      tabindex: '-1',
      'aria-haspopup': spec.menu ? 'menu' : undefined,
      'aria-expanded': spec.menu ? 'false' : undefined,
    },
    icon(spec.icon),
    el('span', { class: 'bar-label', text: spec.label, 'aria-hidden': 'true' }),
  );
  // A mouse press does not take focus: it stays on the sheet, so the arrow keys still move the
  // design after a click on the bar.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}

/**
 * Opens the button's menu, or closes it when it is already open (the button toggles). A bar that
 * sits above the selection opens its menus upward, so they do not cover the design.
 */
function openFrom(
  button: HTMLButtonElement,
  spec: BarButton,
  keyboard: boolean,
  scroller: HTMLElement,
): void {
  if (!spec.menu) return;
  if (isMenuOpenFrom(button)) {
    closeMenu();
    return;
  }
  const { label, entries } = spec.menu();
  button.setAttribute('aria-expanded', 'true');
  openMenu({
    label,
    entries,
    at: button,
    prefer:
      button.closest<HTMLElement>('.action-bar')?.dataset['side'] === 'above' ? 'above' : 'below',
    returnFocus: button,
    fallbackFocus: scroller,
    focusFirst: keyboard,
    onClose: () => button.setAttribute('aria-expanded', 'false'),
  });
}

/** The bar's buttons, kept in step with the selection, with one tab stop (roving tabindex). */
function barContents(deps: ActionBarDeps, bar: HTMLElement): { render(): void } {
  let key = '';
  let idsKey = '';
  let rovingAction = 'duplicate';

  const buttons = (): HTMLButtonElement[] =>
    [...bar.querySelectorAll<HTMLButtonElement>('.bar-btn')].filter((b) => !b.disabled);

  /** Exactly one enabled button is in the tab order: the one last used, else the first. */
  function setRoving(action: string): void {
    const list = buttons();
    const target = list.find((b) => b.dataset['action'] === action) ?? list[0];
    rovingAction = target?.dataset['action'] ?? rovingAction;
    for (const b of bar.querySelectorAll<HTMLButtonElement>('.bar-btn'))
      b.tabIndex = b === target ? 0 : -1;
  }

  function specsFor(chosen: Design[]): BarButton[] {
    const first = chosen[0];
    if (chosen.length > 1) return manyButtons(deps, chosen);
    return first ? singleButtons(deps, first) : [];
  }

  /** Rebuilds the buttons when the selection or its lock changes; focus stays put. */
  function render(): void {
    const chosen = selected(deps.store);
    const next = JSON.stringify(chosen.map((d) => [d.id, d.locked]));
    if (next === key) return;
    key = next;
    // A menu belongs to the selection it was opened for.
    const nextIds = chosen.map((d) => d.id).join(',');
    if (nextIds !== idsKey) closeMenu();
    idsKey = nextIds;
    const active = document.activeElement;
    const refocus =
      active instanceof HTMLElement && bar.contains(active) ? active.dataset['action'] : undefined;
    bar.setAttribute(
      'aria-label',
      chosen.length > 1 ? `${chosen.length} selected designs` : 'Selected design',
    );
    bar.replaceChildren(
      ...specsFor(chosen).map((spec) => {
        const button = buttonElement(spec);
        button.addEventListener('click', (event) =>
          spec.menu ? openFrom(button, spec, event.detail === 0, deps.scroller) : spec.run?.(),
        );
        return button;
      }),
    );
    setRoving(rovingAction);
    if (refocus)
      buttons()
        .find((b) => b.dataset['action'] === refocus)
        ?.focus();
  }

  bar.addEventListener('focusin', (event) => {
    const action = (event.target as HTMLElement).dataset['action'];
    if (action) setRoving(action);
  });
  bar.addEventListener('keydown', (event) => onBarKey(event, buttons(), deps.scroller));
  return { render };
}

function hideBar(bar: HTMLElement, scroller: HTMLElement): void {
  if (bar.hidden) return;
  // Focus must not vanish with the bar: give it back to the sheet.
  if (bar.contains(document.activeElement)) scroller.focus({ preventScroll: true });
  bar.hidden = true;
}

/** Puts the bar by the selection, or hides it (no selection, mid-gesture, out of view). */
function placeOrHide(deps: ActionBarDeps, bar: HTMLElement, gesture: boolean): void {
  const { store, view, overlay, scroller } = deps;
  const ids = store.get().selection;
  const screen = gesture || ids.length === 0 ? null : view.screenBox(ids);
  if (!screen) return hideBar(bar, scroller);
  const origin = overlay.getBoundingClientRect();
  const shift = (r: Rect): Rect => ({
    left: r.left - origin.left,
    top: r.top - origin.top,
    right: r.right - origin.left,
    bottom: r.bottom - origin.top,
  });
  // Shown before measuring: a hidden bar has no size. Nothing is painted in between.
  bar.hidden = false;
  const placement = placeBar({
    box: shift(screen.box),
    reach: shift(screen.reach),
    bar: { width: bar.offsetWidth, height: bar.offsetHeight },
    area: { width: scroller.clientWidth, height: scroller.clientHeight },
  });
  if (!placement) return hideBar(bar, scroller);
  bar.style.transform = `translate(${Math.round(placement.left)}px, ${Math.round(placement.top)}px)`;
  bar.dataset['side'] = placement.side;
}

/** The wheel over the bar scrolls (with Ctrl, zooms) the sheet under it, as if it were not there. */
function passWheelThrough(bar: HTMLElement, scroller: HTMLElement): void {
  bar.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) scroller.dispatchEvent(new WheelEvent('wheel', event));
      else scroller.scrollBy(event.deltaX, event.deltaY);
    },
    { passive: false },
  );
}

/**
 * Mounts the bar in `deps.overlay`; it follows the store and the view from then on. Returns a way
 * to open the selection's More menu at a point (a long press on a touch screen).
 */
export function mountActionBar(deps: ActionBarDeps): {
  openMoreAt(at: { x: number; y: number }): void;
} {
  const { store, view, overlay, scroller } = deps;
  const bar = el('div', { class: 'action-bar', role: 'toolbar', id: 'action-bar', hidden: true });
  overlay.append(bar);
  const contents = barContents(deps, bar);
  let gesture = false;
  let frame = 0;
  // Many triggers can fire in one frame (a store change, a render, a scroll): place once.
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      placeOrHide(deps, bar, gesture);
    });
  };

  store.subscribe(() => {
    contents.render();
    schedule();
  });
  view.onRender(schedule);
  view.onZoomChange(() => {
    closeMenu();
    schedule();
  });
  view.onGesture((active) => {
    gesture = active;
    if (active) closeMenu();
    schedule();
  });
  scroller.addEventListener('scroll', () => {
    // The bar moves with the sheet; a menu left behind would point at nothing.
    closeMenu();
    schedule();
  });
  window.addEventListener('resize', schedule);
  passWheelThrough(bar, scroller);
  mountRightClick(deps, bar);
  mountAltF10(bar);
  contents.render();
  return { openMoreAt: (at) => openMoreMenu(deps, bar, at) };
}

/** Arrow keys, Home and End move along the bar; Escape goes back to the sheet. */
function onBarKey(event: KeyboardEvent, list: HTMLButtonElement[], scroller: HTMLElement): void {
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  const last = list.length - 1;
  const moves: Record<string, number> = {
    ArrowRight: at >= last ? 0 : at + 1,
    ArrowLeft: at <= 0 ? last : at - 1,
    Home: 0,
    End: last,
  };
  const target = moves[event.key];
  if (target !== undefined) list[target]?.focus();
  else if (event.key === 'Escape') scroller.focus({ preventScroll: true });
  else if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  // The editor's own keys (arrows move the design, Escape deselects) must not also run.
  event.preventDefault();
  event.stopPropagation();
}

/** A right-click on a design selects it (unless it is already selected) and opens More there. */
/** Opens the selection's More menu at a page point (a right-click, or a long press). */
function openMoreMenu(deps: ActionBarDeps, bar: HTMLElement, at: { x: number; y: number }): void {
  const more = bar.querySelector<HTMLButtonElement>('[data-action="more"]');
  more?.setAttribute('aria-expanded', 'true');
  openMenu({
    label: 'More actions',
    entries: moreEntries(deps),
    at,
    // On a phone, or with the bar out of view, More is not on screen: focus goes to the sheet.
    returnFocus: more,
    fallbackFocus: deps.scroller,
    focusFirst: false,
    onClose: () => more?.setAttribute('aria-expanded', 'false'),
  });
}

function mountRightClick(deps: ActionBarDeps, bar: HTMLElement): void {
  deps.surface.addEventListener('contextmenu', (event) => {
    const id = deps.view.targetAt(event.clientX, event.clientY);
    // Over empty sheet or mat the browser's own menu stays.
    if (!id) return;
    event.preventDefault();
    if (!deps.store.get().selection.includes(id)) deps.store.setSelection([id]);
    openMoreMenu(deps, bar, { x: event.clientX, y: event.clientY });
  });
}

/** Alt+F10 (the usual key for "go to the toolbar") moves focus onto the bar when it shows. */
function mountAltF10(bar: HTMLElement): void {
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.key !== 'F10' || bar.hidden || !bar.offsetParent) return;
    event.preventDefault();
    bar.querySelector<HTMLButtonElement>('.bar-btn[tabindex="0"]')?.focus();
  });
}
