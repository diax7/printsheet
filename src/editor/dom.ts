/**
 * Small DOM helpers. Text always goes in through textContent, never innerHTML, so names that
 * come from files (image names, project files) cannot inject markup.
 */

const PATHS: Record<string, string> = {
  add: 'M12 5v14M5 12h14',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  arrange: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
  export: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  'rotate-left': 'M3 2v6h6M3.5 13a9 9 0 1 0 2.1-9.4L3 8',
  'rotate-right': 'M21 2v6h-6M20.5 13a9 9 0 1 1-2.1-9.4L21 8',
  'flip-h': 'M12 3v18M8 7 3 12l5 5V7zM16 7l5 5-5 5V7z',
  'flip-v': 'M3 12h18M7 8l5-5 5 5H7zM7 16l5 5 5-5H7z',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  delete: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2',
  forward: 'M8 8h12v12H8zM4 4h12v4M4 4v12h4',
  back: 'M4 4h12v12H4zM8 16v4h12V8h-4',
  'align-left': 'M4 3v18M8 7h12v4H8zM8 14h7v4H8z',
  'align-center': 'M12 3v18M6 7h12v4H6zM8.5 14h7v4h-7z',
  'align-right': 'M20 3v18M4 7h12v4H4zM9 14h7v4H9z',
  'align-top': 'M3 4h18M7 8h4v12H7zM14 8h4v7h-4z',
  'align-middle': 'M3 12h18M7 6h4v12H7zM14 8.5h4v7h-4z',
  'align-bottom': 'M3 20h18M7 4h4v12H7zM14 9h4v7h-4z',
  'distribute-h': 'M4 3v18M20 3v18M9 8h6v8H9z',
  'distribute-v': 'M3 4h18M3 20h18M8 9h8v6H8z',
  warning: 'M12 3 2 21h20L12 3zM12 10v5M12 18h.01',
  close: 'M6 6l12 12M18 6 6 18',
  copies: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
};

/** An inline SVG icon (stroke style). Unknown names render nothing. */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const d = PATHS[name];
  if (d) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Put the icon named in `data-icon` at the start of every such element under `root`. */
export function hydrateIcons(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (element.querySelector('svg')) continue;
    element.prepend(icon(element.dataset['icon'] ?? ''));
  }
}

type Attrs = Record<string, string | number | boolean | undefined>;

/** Create an element with attributes and children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'text') element.textContent = String(value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The page is missing #${id}`);
  return element as T;
}

/** True while the user is typing in a field, so keyboard shortcuts stay out of the way. */
export function isTyping(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
}

export function toast(
  message: string,
  kind: 'info' | 'error' = 'info',
  timeoutMs = kind === 'error' ? 9000 : 3500,
): void {
  const host = byId('toasts');
  const close = el('button', { type: 'button', 'aria-label': 'Dismiss' }, icon('close'));
  const item = el(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', { text: message }),
    close,
  );
  const remove = (): void => item.remove();
  close.addEventListener('click', remove);
  host.append(item);
  window.setTimeout(remove, timeoutMs);
}

/** Read a number input; null when it is empty or not a number. */
export function readNumber(input: HTMLInputElement): number | null {
  const value = Number.parseFloat(input.value.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** Set an input's value unless the user is editing it right now (keeps the cursor in place). */
export function setInputValue(input: HTMLInputElement, value: string): void {
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
  input.removeAttribute('aria-invalid');
}

/** Ask a yes/no question in the app's own dialog. */
export function confirmDialog(
  title: string,
  message: string,
  confirmLabel: string,
  danger = false,
): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>('confirm-dialog');
  dialog.replaceChildren(
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { text: title }),
      el('p', { class: 'lead', text: message }),
    ),
    el(
      'form',
      { method: 'dialog', class: 'dialog-actions' },
      el('button', { class: 'btn btn-outline', value: 'cancel', type: 'submit', text: 'Cancel' }),
      el('button', {
        class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
        value: 'ok',
        type: 'submit',
        text: confirmLabel,
      }),
    ),
  );
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}
