/**
 * The keyboard shortcuts list, opened with "?" (or the button in the empty inspector). It lives
 * in a dialog so the inspector can stay about the selection.
 */
import { byId, el, isTyping } from '@/editor/dom';

const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['Ctrl+V', 'Paste an image'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+D', 'Duplicate'],
  ['Alt+drag', 'Duplicate: the copy stays, the design moves'],
  ['Delete', 'Remove'],
  ['Arrows', 'Move 1 mm (Shift: 1 cm)'],
  ['Space+drag', 'Move around the sheet'],
  ['Ctrl+wheel', 'Zoom'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z or Ctrl+Y', 'Redo'],
  ['Ctrl+S', 'Save project'],
  ['Alt+F10', 'Go to the buttons by the selected design'],
  ['Right-click', 'More actions for a design'],
  ['Escape', 'Deselect'],
  ['?', 'Show this list'],
];

/** Opens the shortcuts dialog. */
export function openShortcuts(): void {
  const dialog = byId<HTMLDialogElement>('shortcuts-dialog');
  const close = el('button', { class: 'btn btn-outline', type: 'button', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  dialog.replaceChildren(
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'shortcuts-title', text: 'Keyboard shortcuts' }),
      el(
        'dl',
        { class: 'kbd-list' },
        ...SHORTCUTS.flatMap(([keys, what]) => [
          el('dt', { text: keys }),
          el('dd', { text: what }),
        ]),
      ),
    ),
    el('div', { class: 'dialog-actions' }, close),
  );
  dialog.showModal();
}

/** "?" opens the list, unless the user is typing or another dialog is open. */
export function mountShortcutsKey(): void {
  document.addEventListener('keydown', (event) => {
    if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping() || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    openShortcuts();
  });
}
