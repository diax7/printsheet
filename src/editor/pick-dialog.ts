/**
 * "Choose what to add" for a file that holds several designs (the pages of a PDF): a list with a
 * preview, a size and a tick for each, and an Add button that counts what is ticked. Closing it
 * any way (Cancel, Escape) adds nothing. Previews load a few at a time, so a long file opens at
 * once.
 */
import { byId, el } from '@/editor/dom';
import type { PickItem } from '@/image/import';

/** How many previews are drawn at the same time. */
const THUMBS_AT_ONCE = 3;

function pickRow(
  item: PickItem,
  onChange: () => void,
): { row: HTMLElement; box: HTMLInputElement; img: HTMLImageElement } {
  const box = el('input', { type: 'checkbox', checked: item.checked, 'aria-label': item.label });
  box.addEventListener('change', onChange);
  const img = el('img', { class: 'pick-thumb', alt: '' });
  const row = el(
    'label',
    { class: 'pick-row' },
    box,
    img,
    el(
      'span',
      { class: 'pick-text' },
      el('span', { class: 'pick-label', text: item.label }),
      el('span', { class: 'pick-detail', text: item.detail }),
      item.note ? el('span', { class: 'pick-note', text: item.note }) : null,
    ),
  );
  return { row, box, img };
}

/** Draw the previews in order, a few at a time, while the dialog is open. */
function loadThumbs(
  items: readonly PickItem[],
  imgs: readonly HTMLImageElement[],
  isOpen: () => boolean,
): void {
  let next = 0;
  const work = async (): Promise<void> => {
    while (next < items.length && isOpen()) {
      const i = next++;
      const thumb = items[i]?.thumb;
      const img = imgs[i];
      if (!thumb || !img) continue;
      try {
        img.src = await thumb();
      } catch {
        img.classList.add('pick-thumb-failed');
      }
    }
  };
  for (let i = 0; i < THUMBS_AT_ONCE; i++) void work();
}

/**
 * Ask which items to add. Resolves with the ticked ids, or null when the dialog was closed
 * without adding. At most `room` can be added (the room left on the sheet).
 */
export function pickItems(
  title: string,
  lead: string,
  items: readonly PickItem[],
  room: number,
): Promise<string[] | null> {
  const dialog = byId<HTMLDialogElement>('pick-dialog');
  const add = el('button', { class: 'btn btn-primary', type: 'submit', id: 'pick-add' });
  const cancel = el('button', { class: 'btn btn-outline', type: 'button', text: 'Cancel' });
  const over = el('p', { class: 'pick-over', role: 'status' });
  const rows = items.map((item) => pickRow(item, () => count()));
  const ticked = (): string[] =>
    items.filter((_, i) => rows[i]?.box.checked).map((item) => item.id);
  const count = (): void => {
    const n = ticked().length;
    add.textContent = n === 1 ? 'Add 1 design' : `Add ${n} designs`;
    add.disabled = n === 0 || n > room;
    over.textContent =
      n > room ? `The sheet has room for ${room} more design${room === 1 ? '' : 's'}.` : '';
  };
  const form = el(
    'form',
    {},
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'pick-title', text: title }),
      el('p', { class: 'lead', text: lead }),
      el('div', { class: 'pick-list' }, ...rows.map((r) => r.row)),
      over,
    ),
    el('div', { class: 'dialog-actions' }, cancel, add),
  );
  count();
  dialog.replaceChildren(form);
  return new Promise((resolve) => {
    let chosen: string[] | null = null;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      chosen = ticked();
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => resolve(chosen), { once: true });
    dialog.showModal();
    loadThumbs(
      items,
      rows.map((r) => r.img),
      () => dialog.open,
    );
    add.focus();
  });
}
