/**
 * "Add copies" from the action bar's menu: asks how many in a small dialog, so the user does not
 * have to go to the inspector for it. The copies follow the same rules as the inspector's (the
 * design limit, free space with the cutting gap).
 */
import { MAX_COPIES } from '@/model/arrange';
import { addCopies } from '@/editor/actions';
import { byId, el, readNumber } from '@/editor/dom';
import type { Store } from '@/store/store';

/** Asks how many copies of the design to add, then adds them. */
export function openCopiesDialog(store: Store, id: string, name: string): void {
  const dialog = byId<HTMLDialogElement>('copies-dialog');
  const count = el('input', {
    type: 'number',
    id: 'copies-count',
    min: '1',
    max: String(MAX_COPIES),
    step: '1',
    value: '1',
    inputmode: 'numeric',
    'aria-label': 'Number of copies',
  });
  const cancel = el('button', { class: 'btn btn-outline', type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => dialog.close());
  const form = el(
    'form',
    {},
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'copies-title', text: `Add copies of "${name}"` }),
      el('p', {
        class: 'lead',
        text: 'Copies go into free space on the sheet, keeping the cutting gap.',
      }),
      el('label', { class: 'field' }, el('span', { text: 'Number of copies' }), count),
    ),
    el(
      'div',
      { class: 'dialog-actions' },
      cancel,
      el('button', { class: 'btn btn-primary', type: 'submit', text: 'Add copies' }),
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (addCopies(store, id, name, Number(readNumber(count)))) dialog.close();
    else count.setAttribute('aria-invalid', 'true');
  });
  dialog.replaceChildren(form);
  dialog.showModal();
  count.select();
}
