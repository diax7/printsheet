/**
 * The phone's bottom bar, at thumb height. Its buttons follow the selection:
 *  - nothing selected: Add, Designs, Arrange, Sheet, More;
 *  - one design: Duplicate, Delete, Lock, Rotate, Size, More, Deselect;
 *  - several: Duplicate, Delete, Lock all, Align, More, Deselect.
 *
 * The selection's actions are the floating PC bar's own (`singleButtons`, `manyButtons`), so
 * both follow the same rules. Its More and Align are the same pop-up menus, opened upward from
 * the bar: they hold commands, while the sheets hold live controls (fields, swatches).
 */
import {
  manyButtons,
  moreEntries,
  singleButtons,
  type ActionBarDeps,
  type BarButton,
} from '@/editor/action-bar';
import { flip } from '@/editor/actions';
import { byId, el, icon } from '@/editor/dom';
import { closeMenu, isMenuOpenFrom, openMenu, SEPARATOR } from '@/editor/menu';
import type { Design } from '@/model/types';

/** What the bar's buttons open; the phone shell owns the sheets. */
export interface PhoneBarHandlers {
  /** Opens (or, when open, closes) a sheet; `opener` is the button's data-action. */
  toggleSheet(sheet: 'designs' | 'settings' | 'size' | 'more', opener: string): void;
}

/** The phone bar's buttons are described like the PC bar's. */
type PhoneButton = BarButton;

/** One of the PC bar's buttons, kept as it is (the bar shows its short label). */
function fromBar(specs: BarButton[], action: string): PhoneButton[] {
  const spec = specs.find((s) => s.action === action);
  return spec ? [spec] : [];
}

function deselect(deps: ActionBarDeps): PhoneButton {
  return {
    action: 'deselect',
    icon: 'close',
    label: 'Deselect',
    title: 'Deselect',
    run: () => deps.store.setSelection([]),
  };
}

function noneButtons(handlers: PhoneBarHandlers): PhoneButton[] {
  return [
    {
      action: 'add',
      icon: 'add',
      label: 'Add',
      title: 'Add images',
      run: () => byId('add-images').click(),
    },
    {
      action: 'designs',
      icon: 'list',
      label: 'Designs',
      title: 'The designs on the sheet',
      run: () => handlers.toggleSheet('designs', 'designs'),
    },
    {
      action: 'arrange',
      icon: 'arrange',
      label: 'Arrange',
      title: 'Pack designs to use less film',
      run: () => byId('arrange').click(),
    },
    {
      action: 'sheet',
      icon: 'sheet',
      label: 'Sheet',
      title: 'Width, gap and layout of the sheet',
      run: () => handlers.toggleSheet('settings', 'sheet'),
    },
    {
      action: 'more',
      icon: 'more',
      label: 'More',
      title: 'New, open, save, zoom and view',
      run: () => handlers.toggleSheet('more', 'more'),
    },
  ];
}

function oneButtons(deps: ActionBarDeps, handlers: PhoneBarHandlers, d: Design): PhoneButton[] {
  const specs = singleButtons(deps, d);
  const rotate = fromBar(specs, 'rotate').map((s) => ({ ...s, label: 'Rotate' }));
  return [
    ...fromBar(specs, 'duplicate'),
    ...fromBar(specs, 'delete'),
    ...fromBar(specs, 'lock'),
    ...rotate,
    {
      action: 'size',
      icon: 'resize',
      label: 'Size',
      title: 'Size, angle, name and copies',
      run: () => handlers.toggleSheet('size', 'size'),
    },
    {
      action: 'more',
      icon: 'more',
      label: 'More',
      title: 'Flip, layer order, copies',
      // The PC bar has Flip beside More; here it lives in More.
      menu: () => ({
        label: 'More actions',
        entries: [
          {
            label: 'Flip horizontally',
            icon: 'flip-h',
            disabled: d.locked,
            run: () => flip(deps.store, d.id, 'x'),
          },
          ...moreEntries(deps),
        ],
      }),
    },
    deselect(deps),
  ];
}

function severalButtons(
  deps: ActionBarDeps,
  handlers: PhoneBarHandlers,
  chosen: Design[],
): PhoneButton[] {
  const specs = manyButtons(deps, chosen);
  return [
    ...fromBar(specs, 'duplicate'),
    ...fromBar(specs, 'delete'),
    ...fromBar(specs, 'lock'),
    ...fromBar(specs, 'align'),
    {
      action: 'more',
      icon: 'more',
      label: 'More',
      title: 'Arrange selection and more options',
      // The inspector's view of several designs (quarter turns, distribute) has no bar button.
      menu: () => ({
        label: 'More actions',
        entries: [
          ...moreEntries(deps),
          SEPARATOR,
          {
            label: 'Turning and Distribute…',
            icon: 'more',
            run: () => handlers.toggleSheet('size', 'more'),
          },
        ],
      }),
    },
    deselect(deps),
  ];
}

function buttonFor(spec: PhoneButton, scroller: HTMLElement): HTMLButtonElement {
  const button = el(
    'button',
    {
      type: 'button',
      class: 'phone-btn',
      'data-action': spec.action,
      'aria-label': spec.label,
      title: spec.title,
      disabled: spec.disabled,
      'aria-haspopup': spec.menu ? 'menu' : undefined,
      'aria-expanded': spec.menu ? 'false' : undefined,
    },
    icon(spec.icon),
    el('span', { class: 'phone-btn-label', text: spec.label, 'aria-hidden': 'true' }),
  );
  button.addEventListener('click', (event) => {
    if (!spec.menu) return spec.run?.();
    if (isMenuOpenFrom(button)) return closeMenu();
    const { label, entries } = spec.menu();
    button.setAttribute('aria-expanded', 'true');
    openMenu({
      label,
      entries,
      at: button,
      prefer: 'above',
      returnFocus: button,
      fallbackFocus: scroller,
      focusFirst: event.detail === 0,
      onClose: () => button.setAttribute('aria-expanded', 'false'),
    });
  });
  return button;
}

/** The buttons for the current selection. */
function buttonsNow(deps: ActionBarDeps, handlers: PhoneBarHandlers): PhoneButton[] {
  const { sheet, selection } = deps.store.get();
  const chosen = sheet.designs.filter((d) => selection.includes(d.id));
  const first = chosen[0];
  if (chosen.length > 1) return severalButtons(deps, handlers, chosen);
  return first ? oneButtons(deps, handlers, first) : noneButtons(handlers);
}

/** The bottom bar in `container`; `render` rebuilds it when the selection changes. */
export function phoneBar(
  container: HTMLElement,
  deps: ActionBarDeps,
  handlers: PhoneBarHandlers,
): { render(): void; clear(): void } {
  let key = '';
  return {
    render() {
      const { sheet, selection } = deps.store.get();
      const next = JSON.stringify(
        sheet.designs.filter((d) => selection.includes(d.id)).map((d) => [d.id, d.locked]),
      );
      if (next === key) return;
      key = next;
      const active = document.activeElement;
      const refocus =
        active instanceof HTMLElement && container.contains(active) ? active.dataset['action'] : '';
      container.replaceChildren(
        ...buttonsNow(deps, handlers).map((spec) => buttonFor(spec, deps.scroller)),
      );
      if (refocus) container.querySelector<HTMLElement>(`[data-action="${refocus}"]`)?.focus();
    },
    clear() {
      key = '';
      container.replaceChildren();
    },
  };
}
