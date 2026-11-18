/**
 * The top bar's own behaviour: the film length readout (always in sight, as it is what the film
 * costs) and, below 1100 px wide, the File button that shows New, Open and Save in a drop-down.
 * The drop-down holds the very same buttons, so their ids and handlers do not change; CSS
 * decides whether they sit in the bar or in the drop-down.
 */
import { filmLengthMm } from '@/model/pages';
import { byId } from '@/editor/dom';
import type { Store } from '@/store/store';

/**
 * The File drop-down is deliberately a disclosure (a button with aria-expanded that shows a group
 * of the existing buttons), not a role="menu": the same New, Open and Save buttons sit in the bar
 * on wider windows, keep their ids, and are reached with Tab like any button.
 */
function mountFileMenu(): void {
  const toggle = byId<HTMLButtonElement>('file-menu');
  const group = byId('file-group');
  const actions = byId('file-actions');
  const setOpen = (open: boolean): void => {
    group.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => {
    const open = !group.classList.contains('open');
    setOpen(open);
    if (open) actions.querySelector<HTMLButtonElement>('button')?.focus();
  });
  // Choosing an entry closes the drop-down; so do Escape and a click anywhere else.
  actions.addEventListener('click', () => setOpen(false));
  group.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !group.classList.contains('open')) return;
    event.stopPropagation();
    setOpen(false);
    toggle.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!group.contains(event.target as Node)) setOpen(false);
  });
  group.addEventListener('focusout', (event) => {
    if (!group.contains(event.relatedTarget as Node | null)) setOpen(false);
  });
}

/** Wires the top bar; call `render()` whenever the sheet changes. */
export function mountTopbar(store: Store): { render(): void } {
  mountFileMenu();
  const meters = byId('top-film-meters');
  return {
    render() {
      // The same figure as the panel's: no film for an empty sheet (a fixed length included).
      const sheet = store.get().sheet;
      const length = sheet.designs.length ? filmLengthMm(sheet) : 0;
      meters.textContent = (length / 1000).toFixed(2);
    },
  };
}
