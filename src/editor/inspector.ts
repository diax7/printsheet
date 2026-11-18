/**
 * Right panel: everything about the selection. One design: name, exact size in cm (typed),
 * angle, flips, lock, copies, layer order, alignment to the sheet. Several: align, distribute,
 * duplicate, arrange, delete. Nothing selected: what to do next, and a way to the shortcuts.
 *
 * A locked design is read-only here: its size, angle, flips and position cannot change and it
 * cannot be deleted until it is unlocked.
 */
import { align, distribute, type AlignEdge } from '@/model/align';
import { MAX_COPIES } from '@/model/arrange';
import { findIssues, type Issue } from '@/model/checks';
import { dpiLevel, effectiveDpi, unionFootprint } from '@/model/geometry';
import { normalizeAngle, reorder, resizeKeepingCorner, rotateBy, updateDesign } from '@/model/ops';
import { formatCm } from '@/model/units';
import { MAX_SIZE_MM, MIN_SIZE_MM, type Design, type Sheet } from '@/model/types';
import { readyPreview } from '@/image/previews';
import {
  addCopies,
  deleteUnlocked,
  duplicateSelected,
  sheetFix,
  toggleLock,
} from '@/editor/actions';
import { byId, el, icon, readNumber, setInputValue, toast } from '@/editor/dom';
import { ISSUE_TEXT, isSerious } from '@/editor/panel';
import { openShortcuts } from '@/editor/shortcuts';
import type { Store } from '@/store/store';

interface Ctx {
  store: Store;
  commit(next: Sheet): void;
  getAllowRotate(): boolean;
  setAllowRotate(v: boolean): void;
  /** Starts Arrange for these designs (it runs in the background and commits when done). */
  arrange(ids: readonly string[]): void;
}

function iconButton(
  name: string,
  label: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const button = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, disabled },
    icon(name),
  );
  button.addEventListener('click', onClick);
  return button;
}

function textButton(
  name: string,
  label: string,
  onClick: () => void,
  cls = 'btn btn-outline',
  disabled = false,
): HTMLButtonElement {
  const button = el('button', { class: cls, type: 'button', disabled }, icon(name), label);
  button.addEventListener('click', onClick);
  return button;
}

function section(...children: Array<Node | null>): HTMLElement {
  return el('section', { class: 'inspector-section' }, ...children);
}

function alignRow(ctx: Ctx, ids: string[], single: boolean, disabled = false): HTMLElement {
  const edges: Array<[AlignEdge, string, string]> = [
    ['left', 'align-left', 'Align left'],
    ['center', 'align-center', 'Centre horizontally'],
    ['right', 'align-right', 'Align right'],
    ['top', 'align-top', 'Align top'],
    ['middle', 'align-middle', 'Centre vertically'],
    ['bottom', 'align-bottom', 'Align bottom'],
  ];
  return el(
    'div',
    { class: 'tool-row' },
    ...edges.map(([edge, iconName, label]) =>
      iconButton(
        iconName,
        `${label}${single ? ' on the sheet' : ''}`,
        () => ctx.commit(align(ctx.store.get().sheet, ids, edge)),
        disabled,
      ),
    ),
  );
}

/** The width or height typed in cm, if it gives a size within the limits; null otherwise. */
function typedSize(
  input: HTMLInputElement,
  current: Design,
  which: 'w' | 'h',
  keep: boolean,
): [number, number] | null {
  const cm = readNumber(input);
  if (cm === null || cm <= 0) return null;
  const mm = cm * 10;
  const ratio = current.heightMm / current.widthMm;
  const size: [number, number] =
    which === 'w'
      ? [mm, keep ? mm * ratio : current.heightMm]
      : [keep ? mm / ratio : current.widthMm, mm];
  return size.every((v) => v >= MIN_SIZE_MM && v <= MAX_SIZE_MM) ? size : null;
}

function sizeFields(ctx: Ctx, d: Design): HTMLElement {
  const field = (id: string, label: string, step: string): HTMLInputElement =>
    el('input', {
      type: 'number',
      step,
      inputmode: 'decimal',
      id,
      'aria-label': label,
      disabled: d.locked,
    });
  const w = field('insp-width', 'Width in cm', '0.1');
  const h = field('insp-height', 'Height in cm', '0.1');
  const a = field('insp-angle', 'Angle in degrees', '1');
  setInputValue(w, formatCm(d.widthMm));
  setInputValue(h, formatCm(d.heightMm));
  setInputValue(a, String(Math.round(d.angleDeg * 10) / 10));
  const keep = el('input', {
    type: 'checkbox',
    id: 'insp-ratio',
    checked: true,
    disabled: d.locked,
  });
  const apply = (which: 'w' | 'h'): void => {
    const input = which === 'w' ? w : h;
    const current = ctx.store.get().sheet.designs.find((x) => x.id === d.id);
    if (!current) return;
    const size = typedSize(input, current, which, keep.checked);
    if (!size) {
      input.setAttribute('aria-invalid', 'true');
      toast(`Enter a size from ${MIN_SIZE_MM / 10} to ${MAX_SIZE_MM / 10} cm.`, 'error');
      return;
    }
    ctx.commit(resizeKeepingCorner(ctx.store.get().sheet, d.id, size[0], size[1]));
  };
  w.addEventListener('change', () => apply('w'));
  h.addEventListener('change', () => apply('h'));
  a.addEventListener('change', () => {
    const deg = readNumber(a);
    if (deg === null) a.setAttribute('aria-invalid', 'true');
    else ctx.commit(updateDesign(ctx.store.get().sheet, d.id, { angleDeg: normalizeAngle(deg) }));
  });
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'grid-2' },
      el('label', { class: 'field' }, el('span', { text: 'Width (cm)' }), w),
      el('label', { class: 'field' }, el('span', { text: 'Height (cm)' }), h),
    ),
    el('label', { class: 'checkbox' }, keep, 'Keep proportions'),
    el(
      'label',
      { class: 'field', style: 'margin-top:10px' },
      el('span', { text: 'Angle (degrees)' }),
      a,
    ),
  );
}

function summarySection(ctx: Ctx, d: Design, issues: Issue[]): HTMLElement {
  const asset = ctx.store.get().assets.get(d.assetId);
  const preview = readyPreview(d.assetId);
  const dpi = asset ? effectiveDpi(d, asset) : 0;
  const kinds = [...new Set(issues.map((i) => i.kind))];
  const fix = sheetFix(ctx.store, [d.id], new Set(kinds.includes('outside') ? [d.id] : []));
  return section(
    el(
      'div',
      { class: 'preview-box' },
      preview ? el('img', { src: preview.thumbUrl, alt: `Preview of ${d.name}` }) : null,
    ),
    el('p', { class: 'big-size', text: `${formatCm(d.widthMm)} × ${formatCm(d.heightMm)} cm` }),
    asset
      ? el('p', {
          class: `hint dpi-text-${dpiLevel(dpi)}`,
          text: `${Math.round(dpi)} DPI at this size, from a ${asset.widthPx} × ${asset.heightPx} px image`,
        })
      : null,
    kinds.length
      ? el(
          'ul',
          { class: 'issues' },
          ...kinds.map((k) =>
            el('li', { class: isSerious(k) ? 'danger' : '', text: ISSUE_TEXT[k] }),
          ),
        )
      : null,
    fix ? textButton('arrange', fix.label, fix.run, 'btn btn-primary-soft', d.locked) : null,
  );
}

function detailsSection(ctx: Ctx, d: Design): HTMLElement {
  const name = el('input', {
    type: 'text',
    id: 'insp-name',
    maxlength: '120',
    'aria-label': 'Design name',
  });
  setInputValue(name, d.name);
  name.addEventListener('change', () => {
    const value = name.value.trim();
    if (value) ctx.commit(updateDesign(ctx.store.get().sheet, d.id, { name: value.slice(0, 120) }));
  });
  return section(
    el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
    sizeFields(ctx, d),
  );
}

function arrangeSection(ctx: Ctx, d: Design): HTMLElement {
  const sheet = (): Sheet => ctx.store.get().sheet;
  return section(
    el('h2', { text: 'Arrange' }),
    el(
      'div',
      { class: 'tool-row' },
      iconButton(
        'rotate-left',
        'Rotate 90° left',
        () => ctx.commit(rotateBy(sheet(), [d.id], -90)),
        d.locked,
      ),
      iconButton(
        'rotate-right',
        'Rotate 90° right',
        () => ctx.commit(rotateBy(sheet(), [d.id], 90)),
        d.locked,
      ),
      iconButton(
        'flip-h',
        'Flip horizontally',
        () => ctx.commit(updateDesign(sheet(), d.id, { flipX: !d.flipX })),
        d.locked,
      ),
      iconButton(
        'flip-v',
        'Flip vertically',
        () => ctx.commit(updateDesign(sheet(), d.id, { flipY: !d.flipY })),
        d.locked,
      ),
      iconButton('forward', 'Bring forward', () => ctx.commit(reorder(sheet(), d.id, 'forward'))),
      iconButton('back', 'Send backward', () => ctx.commit(reorder(sheet(), d.id, 'back'))),
    ),
    el('p', { class: 'label', style: 'margin:10px 0 6px', text: 'Align on the sheet' }),
    alignRow(ctx, [d.id], true, d.locked),
    el(
      'div',
      { class: 'lock-row' },
      textButton(
        d.locked ? 'unlock' : 'lock',
        d.locked ? 'Unlock' : 'Lock position',
        () => toggleLock(ctx.store, [d.id]),
        'btn btn-quiet',
      ),
    ),
  );
}

function copiesSection(ctx: Ctx, d: Design): HTMLElement {
  const copies = el('input', {
    type: 'number',
    min: '1',
    max: String(MAX_COPIES),
    step: '1',
    value: '1',
    id: 'insp-copies',
    'aria-label': 'Number of copies',
  });
  return section(
    el('h2', { text: 'Copies' }),
    el(
      'div',
      { class: 'row' },
      copies,
      textButton('copies', 'Add copies', () => {
        if (!addCopies(ctx.store, d.id, d.name, Number(readNumber(copies))))
          copies.setAttribute('aria-invalid', 'true');
      }),
    ),
    el('p', {
      class: 'hint',
      text: 'Copies go into free space on the sheet, keeping the cutting gap.',
    }),
  );
}

function actionsSection(ctx: Ctx, ids: string[], locked: boolean): HTMLElement {
  return section(
    el(
      'div',
      { class: 'tool-row' },
      textButton('duplicate', 'Duplicate', () => duplicateSelected(ctx.store, ids)),
      textButton(
        'delete',
        'Delete',
        () => deleteUnlocked(ctx.store, ids),
        'btn btn-outline',
        locked,
      ),
    ),
    locked ? el('p', { class: 'hint', text: 'Unlock to delete.' }) : null,
  );
}

function renderSingle(ctx: Ctx, d: Design): HTMLElement {
  const { sheet, assets } = ctx.store.get();
  const issues = findIssues(sheet, assets, ctx.store.get().masks).get(d.id) ?? [];
  return el(
    'div',
    { class: 'inspector' },
    summarySection(ctx, d, issues),
    detailsSection(ctx, d),
    arrangeSection(ctx, d),
    copiesSection(ctx, d),
    actionsSection(ctx, [d.id], d.locked),
  );
}

function renderMany(ctx: Ctx, ids: string[]): HTMLElement {
  const { sheet } = ctx.store.get();
  const chosen = sheet.designs.filter((d) => ids.includes(d.id));
  const box = unionFootprint(chosen);
  const allowRotate = el('input', { type: 'checkbox', checked: ctx.getAllowRotate() });
  allowRotate.addEventListener('change', () => ctx.setAllowRotate(allowRotate.checked));
  const anyLocked = chosen.some((d) => d.locked);
  const current = (): Sheet => ctx.store.get().sheet;
  return el(
    'div',
    { class: 'inspector' },
    section(
      el('p', { class: 'big-size', text: `${chosen.length} designs` }),
      box
        ? el('p', {
            class: 'hint',
            text: `Together ${formatCm(box.maxX - box.minX)} × ${formatCm(box.maxY - box.minY)} cm`,
          })
        : null,
    ),
    section(
      el('h2', { text: 'Align' }),
      alignRow(ctx, ids, false),
      el('p', {
        class: 'label',
        style: 'margin:10px 0 6px',
        text: 'Distribute evenly (3 or more)',
      }),
      el(
        'div',
        { class: 'tool-row' },
        iconButton(
          'distribute-h',
          'Distribute horizontally',
          () => ctx.commit(distribute(current(), ids, 'horizontal')),
          ids.length < 3,
        ),
        iconButton(
          'distribute-v',
          'Distribute vertically',
          () => ctx.commit(distribute(current(), ids, 'vertical')),
          ids.length < 3,
        ),
      ),
    ),
    section(
      el('h2', { text: 'Pack these designs' }),
      el(
        'label',
        { class: 'checkbox', style: 'margin-bottom:8px' },
        allowRotate,
        'Allow quarter turns to save film',
      ),
      textButton('arrange', 'Arrange selection', () => ctx.arrange(ids)),
    ),
    section(
      el(
        'div',
        { class: 'tool-row' },
        textButton('duplicate', 'Duplicate', () => duplicateSelected(ctx.store, ids)),
        textButton(anyLocked ? 'unlock' : 'lock', anyLocked ? 'Unlock all' : 'Lock all', () =>
          toggleLock(ctx.store, ids),
        ),
        textButton('delete', 'Delete', () => deleteUnlocked(ctx.store, ids)),
      ),
    ),
  );
}

function renderNone(): HTMLElement {
  const shortcuts = el('button', {
    class: 'btn btn-outline',
    type: 'button',
    id: 'show-shortcuts',
    text: 'Keyboard shortcuts',
    title: 'Keyboard shortcuts (?)',
  });
  shortcuts.addEventListener('click', openShortcuts);
  return el(
    'div',
    { class: 'inspector inspector-empty' },
    el('h2', { text: 'Nothing selected' }),
    el('p', {
      text: 'Click a design to see and change its exact size. Drag across the sheet to select several.',
    }),
    el('p', { text: 'Press ? to see every keyboard shortcut.' }),
    shortcuts,
  );
}

export function mountInspector(
  store: Store,
  getAllowRotate: () => boolean,
  setAllowRotate: (v: boolean) => void,
  arrange: (ids: readonly string[]) => void,
): { render(): void } {
  const host = byId('inspector');
  const ctx: Ctx = {
    store,
    commit: (next) => store.commit(next),
    getAllowRotate,
    setAllowRotate,
    arrange,
  };
  let lastKey = '';

  function render(): void {
    const { sheet, selection, assets, masks } = store.get();
    const chosen = sheet.designs.filter((d) => selection.includes(d.id));
    const issues = [...findIssues(sheet, assets, masks).entries()].filter(([id]) =>
      selection.includes(id),
    );
    const key = JSON.stringify([chosen, selection.length, issues, sheet.settings]);
    if (key === lastKey) return;
    lastKey = key;
    // Re-rendering replaces the inputs; put focus back in the field that had it.
    const active = document.activeElement;
    const focusedId = active instanceof HTMLElement && host.contains(active) ? active.id : '';
    const first = chosen[0];
    if (chosen.length === 1 && first) host.replaceChildren(renderSingle(ctx, first));
    else if (chosen.length > 1)
      host.replaceChildren(
        renderMany(
          ctx,
          chosen.map((d) => d.id),
        ),
      );
    else host.replaceChildren(renderNone());
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }

  return { render };
}
