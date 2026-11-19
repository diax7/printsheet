/**
 * "Choose what to add" for a file that holds several designs (the pages of a PDF, the layers of
 * a PSD): a list with a preview, a size and a tick for each, and an Add button that counts what
 * is ticked. A folder's row adds it merged, and opens to show its layers to tick one by one.
 * Closing the dialog any way (Cancel, Escape) adds nothing. Previews load a few at a time, and a
 * folder's only when it is opened, so even a large file opens at once.
 */
import { byId, el } from '@/editor/dom';
import type { PickItem } from '@/image/import';

/** How many previews are drawn at the same time. */
const THUMBS_AT_ONCE = 3;

interface Row {
  item: PickItem;
  box: HTMLInputElement;
  img: HTMLImageElement;
}

/** Previews drawn in the order asked for, a few at a time, while `isOpen()`. */
function thumbQueue(isOpen: () => boolean): (rows: readonly Row[]) => void {
  const queue: Row[] = [];
  let running = 0;
  const work = async (): Promise<void> => {
    running++;
    for (let row = queue.shift(); row && isOpen(); row = queue.shift()) {
      if (!row.item.thumb) continue;
      try {
        row.img.src = await row.item.thumb();
      } catch {
        row.img.classList.add('pick-thumb-failed');
      }
    }
    running--;
  };
  return (rows) => {
    queue.push(...rows);
    for (let i = running; i < THUMBS_AT_ONCE; i++) void work();
  };
}

/** The row for one item, and (for a folder) its layers' rows, hidden until opened. */
function rowsFor(
  item: PickItem,
  onChange: () => void,
  onOpen: (rows: Row[]) => void,
): { element: HTMLElement; rows: Row[] } {
  const box = el('input', {
    type: 'checkbox',
    checked: item.checked && !item.disabled,
    disabled: Boolean(item.disabled),
    'aria-label': item.label,
  });
  box.addEventListener('change', onChange);
  const img = el('img', { class: 'pick-thumb', alt: '' });
  const own: Row = { item, box, img };
  const text = el(
    'span',
    { class: 'pick-text' },
    el('span', { class: 'pick-label', text: item.label }),
    el('span', { class: 'pick-detail', text: item.detail }),
    item.note ? el('span', { class: 'pick-note', text: item.note }) : null,
  );
  const row = el(
    'label',
    { class: `pick-row${item.disabled ? ' pick-disabled' : ''}` },
    box,
    img,
    text,
  );
  if (!item.children?.length) return { element: row, rows: [own] };

  const inner = item.children.map((child) => rowsFor(child, onChange, onOpen));
  const nested = el(
    'div',
    { class: 'pick-children', hidden: true },
    ...inner.map((r) => r.element),
  );
  const toggle = el('button', {
    type: 'button',
    class: 'btn btn-outline pick-open',
    'aria-expanded': 'false',
    text: `Show ${item.children.length} layer${item.children.length === 1 ? '' : 's'}`,
  });
  let opened = false;
  toggle.addEventListener('click', () => {
    nested.hidden = !nested.hidden;
    toggle.setAttribute('aria-expanded', String(!nested.hidden));
    toggle.textContent = nested.hidden
      ? `Show ${item.children?.length ?? 0} layers`
      : 'Hide layers';
    if (!opened) onOpen(inner.map((r) => r.rows[0] as Row));
    opened = true;
  });
  text.append(toggle);
  return {
    element: el('div', { class: 'pick-group' }, row, nested),
    rows: [own, ...inner.flatMap((r) => r.rows)],
  };
}

/**
 * Ask which items to add. Resolves with the ticked ids (a folder's ticked layers included), or
 * null when the dialog was closed without adding. At most `room` can be added (the room left on
 * the sheet).
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
  const loadThumbs = thumbQueue(() => dialog.open);
  const groups = items.map((item) => rowsFor(item, () => count(), loadThumbs));
  const rows = groups.flatMap((g) => g.rows);
  const ticked = (): string[] => rows.filter((r) => r.box.checked).map((r) => r.item.id);
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
      el('div', { class: 'pick-list' }, ...groups.map((g) => g.element)),
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
    // Top-level rows first; a folder's layers when it is opened.
    loadThumbs(groups.map((g) => g.rows[0] as Row));
    add.focus();
  });
}
