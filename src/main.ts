/**
 * Boot: restore the saved sheet, mount the views, and wire the toolbar, keyboard, paste, drop,
 * autosave and project files.
 */
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is imported for its side effect.
import '@/styles.css';
import { moveOntoSheets } from '@/model/arrange';
import { footprint, initialSize, unionFootprint } from '@/model/geometry';
import { addDesigns, roomForDesigns, updateDesigns } from '@/model/ops';
import {
  DEFAULT_SETTINGS,
  MAX_DESIGNS,
  type Design,
  type ImageAsset,
  type Sheet,
  type Spacing,
} from '@/model/types';
import { mountCanvas } from '@/editor/canvas';
import { drawRulers } from '@/editor/rulers';
import { mountPanel } from '@/editor/panel';
import { mountInspector } from '@/editor/inspector';
import { deleteUnlocked, duplicateSelected, newId } from '@/editor/actions';
import { openExportDialog } from '@/editor/export-dialog';
import { byId, confirmDialog, el, hydrateIcons, isTyping, toast } from '@/editor/dom';
import { importFiles } from '@/image/import';
import { createMaskLoader } from '@/image/masks';
import { mountArrange } from '@/editor/arrange-run';
import { evictPreviews, loadPreview } from '@/image/previews';
import { allPresets, loadPrefs, savePrefs, type Background, type Prefs } from '@/prefs';
import { createStore } from '@/store/store';
import { createAutosave, requestPersistence, watchOtherTabs } from '@/store/persist';
import { parseProject, serializeProject, PROJECT_EXTENSION } from '@/store/project-file';
import { download } from '@/export/client';
import { safeFileName } from '@/editor/export-dialog';
import { Packer } from '@/model/packer';
import { bandsFor, fallbackTop } from '@/model/pages';
import { mountLayoutControls } from '@/editor/layout-controls';
import { mountActionBar } from '@/editor/action-bar';
import { mountSpacePan } from '@/editor/space-pan';
import { mountShortcutsKey } from '@/editor/shortcuts';
import { mountTopbar } from '@/editor/topbar';
import { mountPhoneShell } from '@/editor/phone-shell';

const emptySheet = (settings = DEFAULT_SETTINGS): Sheet => ({
  designs: [],
  settings: { ...settings },
});

let prefs: Prefs = loadPrefs();
const getPrefs = (): Prefs => prefs;
function setPrefs(next: Prefs): void {
  prefs = next;
  if (!savePrefs(prefs)) toast('Your settings could not be remembered in this browser.', 'error');
  renderAll();
}

/** A new sheet measures the cutting gap the way the user last chose (rectangles at first). */
const newSheetSpacing = (): Spacing => prefs.spacing ?? DEFAULT_SETTINGS.spacing;

const store = createStore(emptySheet({ ...DEFAULT_SETTINGS, spacing: newSheetSpacing() }));
const maskLoader = createMaskLoader(store);
const arrange = mountArrange({ store, masks: maskLoader, getAllowRotate: () => prefs.allowRotate });
hydrateIcons(document);

const canvasView = mountCanvas(
  store,
  getPrefs,
  (name) =>
    toast(
      `"${name}" could not be shown on screen. It is marked in red and will still be exported.`,
      'error',
    ),
  {
    scroller: byId('scroller'),
    viewport: byId('viewport'),
    spacer: byId('spacer'),
    canvasEl: byId<HTMLCanvasElement>('sheet-canvas'),
  },
);
const panel = mountPanel(store, getPrefs, {
  onPresetMenu: openPresetDialog,
  onSpacing: (spacing) => setPrefs({ ...prefs, spacing }),
});
const layoutControls = mountLayoutControls(store, {
  onCrossing: (ids) =>
    toast(
      `${ids.length} design${ids.length === 1 ? ' crosses' : 's cross'} a split between sheets.`,
      'info',
      12000,
      {
        label: `Move ${ids.length === 1 ? 'it' : 'them'} onto a sheet`,
        run: () => {
          const sheet = store.get().sheet;
          const next = moveOntoSheets(sheet, ids);
          if (next === sheet) toast('No sheet has room for them. Make the sheets longer.', 'error');
          else store.commit(next);
        },
      },
    ),
});
const inspector = mountInspector(
  store,
  () => prefs.allowRotate,
  (v) => setPrefs({ ...prefs, allowRotate: v }),
  (ids) => void arrange.run(ids),
);
const selectionDeps = {
  store,
  view: canvasView,
  overlay: byId('stage-overlay'),
  scroller: byId('scroller'),
  surface: byId('viewport'),
  arrange: (ids: readonly string[]) => void arrange.run(ids),
};
mountActionBar(selectionDeps);
mountPhoneShell({ ...selectionDeps, app: byId('app'), stage: byId('stage') });
mountSpacePan(canvasView, byId('viewport'));
mountShortcutsKey();
const topbar = mountTopbar(store);
const rulerTop = byId<HTMLCanvasElement>('ruler-top');
const rulerLeft = byId<HTMLCanvasElement>('ruler-left');
canvasView.onViewChange(() =>
  drawRulers(rulerTop, rulerLeft, canvasView.transform(), store.get().sheet.settings),
);

/* ---------- Status and rendering ---------- */

const saveStatus = byId('save-status');
const busy = byId('busy');
let saveFailing = false;
const autosave = createAutosave(({ ok, message }) => {
  saveStatus.textContent = message;
  saveStatus.className = ok ? '' : 'error';
  // A failing save must not go unnoticed: say it once, when it starts failing.
  if (!ok && !saveFailing) toast(message, 'error');
  saveFailing = !ok;
});

function renderAll(): void {
  const { sheet, selection } = store.get();
  panel.render();
  layoutControls.render();
  inspector.render();
  topbar.render();
  byId<HTMLButtonElement>('undo').disabled = !store.canUndo();
  byId<HTMLButtonElement>('redo').disabled = !store.canRedo();
  byId('empty-state').hidden = sheet.designs.length > 0;
  byId<HTMLButtonElement>('arrange').disabled = sheet.designs.length === 0;
  byId('selection-status').textContent = selection.length ? `${selection.length} selected` : '';
  for (const swatch of document.querySelectorAll<HTMLElement>('[data-bg]')) {
    swatch.setAttribute('aria-checked', String(swatch.dataset['bg'] === prefs.background));
  }
  byId('bg-custom')
    .closest('.swatch')
    ?.setAttribute('aria-checked', String(prefs.background === 'custom'));
  byId('grid-toggle').setAttribute('aria-pressed', String(prefs.grid));
  canvasView.render();
}

store.subscribe((state, previous) => {
  renderAll();
  if (state.sheet !== previous.sheet || state.assets !== previous.assets) {
    autosave.schedule(state.sheet, state.assets, store.referencedAssetIds());
  }
  // Images of a saved sheet come back without their ink masks; Real shape spacing needs them.
  if (state.sheet.settings.spacing === 'shape') maskLoader.want();
});

/* ---------- Adding images ---------- */

/** Place new designs in free space below or beside what is already there. */
function placeNewDesigns(sheet: Sheet, assets: ImageAsset[]): { sheet: Sheet; ids: string[] } {
  const { sheetWidthMm, gapMm } = sheet.settings;
  const packer = new Packer(
    sheetWidthMm,
    gapMm,
    sheet.designs.map(footprint),
    bandsFor(sheet.settings),
  );
  const added: Design[] = [];
  for (const asset of assets) {
    const size = initialSize(asset, sheetWidthMm);
    const spot = packer.find(size.widthMm, size.heightMm) ?? {
      minX: 0,
      minY: fallbackTop({ ...sheet, designs: [...sheet.designs, ...added] }),
      maxX: size.widthMm,
      maxY: 0,
    };
    const design: Design = {
      id: newId(),
      assetId: asset.id,
      name: asset.name,
      xMm: spot.minX + size.widthMm / 2,
      yMm: spot.minY + size.heightMm / 2,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      angleDeg: 0,
      flipX: false,
      flipY: false,
      locked: false,
    };
    added.push(design);
    packer.add(footprint(design));
  }
  return { sheet: addDesigns(sheet, added), ids: added.map((d) => d.id) };
}

/** Previews for the images; images whose preview cannot be made are left out with a message. */
async function withPreviews(assets: ImageAsset[]): Promise<ImageAsset[]> {
  const results = await Promise.allSettled(assets.map((a) => loadPreview(a)));
  for (const [i, a] of assets.entries()) {
    if (results[i]?.status === 'rejected')
      toast(`"${a.name}" could not be shown and was not added.`, 'error');
  }
  return assets.filter((_, i) => results[i]?.status === 'fulfilled');
}

async function addFiles(files: ReadonlyArray<{ blob: Blob; name: string }>): Promise<void> {
  if (files.length === 0) return;
  // Wait for the saved sheet to be restored, so new images are not replaced by it.
  await started;
  busy.hidden = false;
  busy.textContent = `Reading ${files.length} image${files.length === 1 ? '' : 's'}…`;
  try {
    const { assets, masks, errors } = await importFiles(files, (done, total) => {
      busy.textContent = `Reading images ${done} of ${total}…`;
    });
    for (const message of errors) toast(message, 'error');
    const room = roomForDesigns(store.get().sheet);
    const extra = assets.length - room;
    if (extra > 0) {
      toast(
        `A sheet holds at most ${MAX_DESIGNS} designs; ${extra} image${extra === 1 ? ' was' : 's were'} not added.`,
        'error',
      );
    }
    const usable = await withPreviews(assets.slice(0, room));
    if (usable.length === 0) return;
    store.addAssets(usable);
    store.addMasks(new Map([...masks].filter(([id]) => usable.some((a) => a.id === id))));
    const { sheet, ids } = placeNewDesigns(store.get().sheet, usable);
    store.commit(sheet, { selection: ids });
    const opaque = usable.filter((a) => !a.hasTransparency).length;
    if (opaque)
      toast(
        `${opaque} image${opaque === 1 ? ' has' : 's have'} no transparent background and will print as a solid rectangle.`,
        'error',
      );
  } catch (error) {
    toast(
      `Could not add the images: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  } finally {
    busy.hidden = true;
  }
}

const fileInput = byId<HTMLInputElement>('file-input');
for (const id of ['add-images', 'empty-add'])
  byId(id).addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])].map((f) => ({ blob: f, name: f.name }));
  fileInput.value = '';
  void addFiles(files);
});

const stage = document.querySelector<HTMLElement>('.stage');
const overlay = byId('drop-overlay');
let dragDepth = 0;
const hasFiles = (event: DragEvent): boolean =>
  [...(event.dataTransfer?.types ?? [])].includes('Files');
stage?.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  dragDepth++;
  overlay.hidden = false;
});
stage?.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.hidden = true;
});
stage?.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
stage?.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const files = [...(event.dataTransfer?.files ?? [])];
  const projects = files.filter((f) => f.name.toLowerCase().endsWith(PROJECT_EXTENSION));
  const first = projects[0];
  if (first) {
    // A project replaces the sheet, so images dropped with it would be lost: open only the project.
    if (files.length > 1)
      toast('A project file was dropped with other files. Only the project was opened.', 'error');
    void openProject(first);
    return;
  }
  void addFiles(files.map((f) => ({ blob: f, name: f.name })));
});
// Dropping outside the stage must not navigate away from the editor.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

document.addEventListener('paste', (event) => {
  if (isTyping()) return;
  const images = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item, i) => {
      const file = item.getAsFile();
      return file
        ? {
            blob: file,
            name: file.name && file.name !== 'image.png' ? file.name : `Pasted image ${i + 1}`,
          }
        : null;
    })
    .filter((x): x is { blob: File; name: string } => x !== null);
  if (images.length) {
    event.preventDefault();
    void addFiles(images);
  }
});

/* ---------- Toolbar ---------- */

byId('undo').addEventListener('click', () => store.undo());
byId('redo').addEventListener('click', () => store.redo());
const zoomValue = byId('zoom-value');
canvasView.onZoomChange((z) => {
  zoomValue.textContent = `${Math.round(z * 100)}%`;
});
byId('zoom-in').addEventListener('click', () => canvasView.setZoom(canvasView.zoom() * 1.25));
byId('zoom-out').addEventListener('click', () => canvasView.setZoom(canvasView.zoom() / 1.25));
zoomValue.addEventListener('click', () => canvasView.setZoom(1));
byId('zoom-fit').addEventListener('click', () => canvasView.fitWidth());
for (const swatch of document.querySelectorAll<HTMLElement>('[data-bg]')) {
  swatch.addEventListener('click', () =>
    setPrefs({ ...prefs, background: swatch.dataset['bg'] as Background }),
  );
}
const customColor = byId<HTMLInputElement>('bg-custom');
customColor.value = prefs.customColor;
customColor.addEventListener('input', () =>
  setPrefs({ ...prefs, background: 'custom', customColor: customColor.value }),
);
byId('grid-toggle').addEventListener('click', () => setPrefs({ ...prefs, grid: !prefs.grid }));
byId('arrange').addEventListener('click', () => {
  const { selection } = store.get();
  void arrange.run(selection.length > 1 ? selection : 'all');
});
byId('export').addEventListener('click', () => openExportDialog(store, getPrefs, setPrefs));

/* ---------- Project files ---------- */

async function openProject(file: Blob): Promise<void> {
  await started;
  try {
    const { sheet, assets, dropped } = await parseProject(file);
    if (
      store.get().sheet.designs.length &&
      !(await confirmDialog(
        'Open this project?',
        'The current sheet will be replaced. Save it first if you want to keep it.',
        'Open project',
      ))
    )
      return;
    await Promise.all([...assets.values()].map((a) => loadPreview(a)));
    autosave.pause(false);
    evictPreviews(new Set(assets.keys()));
    store.load(sheet, assets);
    toast('Project opened.');
    if (dropped) toast(droppedMessage(dropped, 'opened'), 'error');
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  }
}

const projectInput = byId<HTMLInputElement>('project-input');
byId('open-project').addEventListener('click', () => projectInput.click());
projectInput.addEventListener('change', () => {
  const file = projectInput.files?.[0];
  projectInput.value = '';
  if (file) void openProject(file);
});

async function saveProject(): Promise<void> {
  const { sheet, assets } = store.get();
  if (sheet.designs.length === 0) {
    toast('Add a design before saving a project.', 'error');
    return;
  }
  try {
    const blob = await serializeProject(sheet, assets);
    const date = new Date().toISOString().slice(0, 10);
    download(blob, `${safeFileName(`printsheet-${date}`)}${PROJECT_EXTENSION}`);
  } catch (error) {
    toast(
      `Could not save the project: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}
byId('save-project').addEventListener('click', () => void saveProject());

byId('new-sheet').addEventListener('click', async () => {
  if (
    store.get().sheet.designs.length &&
    !(await confirmDialog(
      'Start a new sheet?',
      'Everything on the current sheet will be removed. Save it first if you want to keep it.',
      'Start new sheet',
      true,
    ))
  )
    return;
  autosave.pause(false);
  evictPreviews(new Set());
  // A new sheet keeps the width, length mode and cutting gap you were using, and measures the
  // gap the way you last chose.
  store.load(emptySheet({ ...store.get().sheet.settings, spacing: newSheetSpacing() }), new Map());
});

/* ---------- Presets ---------- */

function openPresetDialog(): void {
  const dialog = byId<HTMLDialogElement>('preset-dialog');
  const width = store.get().sheet.settings.sheetWidthMm;
  const name = el('input', {
    type: 'text',
    id: 'preset-name',
    maxlength: '60',
    placeholder: 'For example: Shop roll',
    'aria-label': 'Preset name',
  });
  const save = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: `Save ${(width / 10).toFixed(1)} cm as a preset`,
  });
  save.addEventListener('click', () => {
    const label = name.value.trim();
    if (!label) {
      name.setAttribute('aria-invalid', 'true');
      name.focus();
      return;
    }
    setPrefs({
      ...prefs,
      presets: [
        ...prefs.presets,
        {
          id: `p-${crypto.randomUUID().slice(0, 8)}`,
          name: label.slice(0, 60),
          widthMm: width,
          builtIn: false,
        },
      ],
    });
    dialog.close();
    toast(`Saved preset "${label}".`);
  });
  const own = prefs.presets.map((p) => {
    const rename = el('input', {
      type: 'text',
      value: p.name,
      maxlength: '60',
      'aria-label': `Name of preset ${p.name}`,
    });
    rename.addEventListener('change', () => {
      const label = rename.value.trim();
      if (label)
        setPrefs({
          ...prefs,
          presets: prefs.presets.map((x) =>
            x.id === p.id ? { ...x, name: label.slice(0, 60) } : x,
          ),
        });
    });
    const remove = el('button', { class: 'btn btn-quiet', type: 'button', text: 'Delete' });
    remove.addEventListener('click', () => {
      setPrefs({ ...prefs, presets: prefs.presets.filter((x) => x.id !== p.id) });
      remove.closest('li')?.remove();
    });
    return el(
      'li',
      { class: 'row', style: 'margin-bottom:6px' },
      rename,
      el('span', { class: 'hint', text: `${(p.widthMm / 10).toFixed(1)} cm` }),
      remove,
    );
  });
  const close = el('button', { class: 'btn btn-outline', type: 'button', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  dialog.replaceChildren(
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'preset-title', text: 'Width presets' }),
      el('p', {
        class: 'lead',
        text: `Save the current width (${(width / 10).toFixed(1)} cm) to reuse it later.`,
      }),
      el('div', { class: 'row', style: 'margin-bottom:16px' }, name, save),
      own.length ? el('h2', { text: 'Your presets', style: 'font-size:14px' }) : null,
      own.length
        ? el('ul', { style: 'list-style:none;padding:0;margin:8px 0 0' }, ...own)
        : el('p', {
            class: 'hint',
            text: `Built-in: ${allPresets(prefs)
              .filter((p) => p.builtIn)
              .map((p) => p.name)
              .join(' and ')}.`,
          }),
    ),
    el('div', { class: 'dialog-actions' }, close),
  );
  dialog.showModal();
  name.focus();
}

/* ---------- About ---------- */

const REPO = 'https://github.com/diax7/printsheet';

/** A link that opens in a new tab and tells the other site nothing about this page. */
function link(href: string, text: string): HTMLAnchorElement {
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
}

byId('about').addEventListener('click', () => {
  const dialog = byId<HTMLDialogElement>('about-dialog');
  const close = el('button', { class: 'btn btn-outline', type: 'button', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  dialog.replaceChildren(
    el(
      'div',
      { class: 'dialog-body' },
      el('h2', { id: 'about-title', text: `PrintSheet ${__APP_VERSION__}` }),
      el('p', {
        class: 'lead',
        text: 'Lay out designs on a DTF film sheet with exact sizes, then export a print-ready PDF or PNG.',
      }),
      el('p', {
        text: 'Everything happens in this browser. Your images are never uploaded: the page has no server and cannot make network requests.',
      }),
      el(
        'p',
        {},
        'Free and open source under the MIT licence. Source code, instructions and the licences of the bundled libraries, typeface and colour profile: ',
        link(REPO, 'github.com/diax7/printsheet'),
        '.',
      ),
    ),
    el('div', { class: 'dialog-actions' }, close),
  );
  dialog.showModal();
});

/* ---------- Keyboard ---------- */

/** Move the selected, unlocked designs, stopping at the sheet edges like dragging does. */
function nudge(key: string, shift: boolean): void {
  const { sheet, selection } = store.get();
  const step = shift ? 10 : 1;
  let dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
  let dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
  const moving = sheet.designs.filter((d) => selection.includes(d.id) && !d.locked);
  // A design already over an edge can still move back.
  const box = unionFootprint(moving);
  if (box) {
    if (dx > 0) dx = Math.min(dx, Math.max(0, sheet.settings.sheetWidthMm - box.maxX));
    if (dx < 0) dx = Math.max(dx, Math.min(0, -box.minX));
    if (dy < 0) dy = Math.max(dy, Math.min(0, -box.minY));
  }
  const patches = new Map(moving.map((d) => [d.id, { xMm: d.xMm + dx, yMm: d.yMm + dy }]));
  if (patches.size) store.commit(updateDesigns(sheet, patches), { mergeKey: 'nudge' });
}

/** Shortcuts with Ctrl (or Cmd), by key. */
const CTRL_SHORTCUTS: Record<string, (shift: boolean) => void> = {
  z: (shift) => (shift ? store.redo() : store.undo()),
  y: () => store.redo(),
  a: () => store.setSelection(store.get().sheet.designs.map((d) => d.id)),
  d: () => duplicateSelected(store, store.get().selection),
  '=': () => canvasView.setZoom(canvasView.zoom() * 1.25),
  '+': () => canvasView.setZoom(canvasView.zoom() * 1.25),
  '-': () => canvasView.setZoom(canvasView.zoom() / 1.25),
  '0': () => canvasView.fitWidth(),
};

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const dialogOpen = document.querySelector('dialog[open]') !== null;
  const shortcut = mod ? CTRL_SHORTCUTS[key] : undefined;
  if (mod && key === 's') {
    event.preventDefault();
    void saveProject();
  } else if (isTyping()) {
    // Escape leaves the field, so the shortcuts work again.
    if (key === 'escape' && !dialogOpen) (document.activeElement as HTMLElement | null)?.blur();
  } else if (dialogOpen) {
    return;
  } else if (shortcut) {
    event.preventDefault();
    shortcut(event.shiftKey);
  } else if (key === 'delete' || key === 'backspace') {
    event.preventDefault();
    deleteUnlocked(store, store.get().selection);
  } else if (key === 'escape') {
    store.setSelection([]);
  } else if (key.startsWith('arrow') && store.get().selection.length) {
    event.preventDefault();
    nudge(key, event.shiftKey);
  }
});

/* ---------- Start ---------- */

byId('tab-banner-close').addEventListener('click', () => {
  byId('tab-banner').hidden = true;
});
watchOtherTabs(() => {
  byId('tab-banner').hidden = false;
});

/** Test hook: lets the browser tests compare what is on screen with the model. Read-only. */
Object.assign(window, {
  __printsheet: {
    state: () => store.get(),
    objectCorners: (id: string) => canvasView.objectCorners(id),
    zoom: () => canvasView.zoom(),
    /** Page coordinates of a sheet point in mm, so tests can drag with the real mouse. */
    toClient: (xMm: number, yMm: number) => {
      const v = canvasView.transform();
      const rect = byId('sheet-canvas').getBoundingClientRect();
      return { x: rect.left + xMm * v[0] + v[4], y: rect.top + yMm * v[3] + v[5] };
    },
  },
});

function droppedMessage(count: number, verb: string): string {
  return `${count} design${count === 1 ? '' : 's'} could not be ${verb} (damaged, or the image is missing). The rest of the sheet is here.`;
}

// Warn before leaving while a change has not been saved in the browser yet.
window.addEventListener('beforeunload', (event) => {
  if (store.get().sheet.designs.length && !autosave.isSaved()) event.preventDefault();
});

async function start(): Promise<void> {
  try {
    const saved = await autosave.load();
    if (saved && saved.sheet.designs.length) {
      await Promise.all(
        [...saved.assets.values()].map((a) => loadPreview(a).catch(() => undefined)),
      );
      store.load(saved.sheet, saved.assets);
      saveStatus.textContent = 'Restored your last sheet';
    } else if (saved) {
      store.load(emptySheet(saved.sheet.settings), new Map());
    }
    if (saved?.dropped) toast(droppedMessage(saved.dropped, 'restored'), 'error');
  } catch (error) {
    // Leave the saved data alone so nothing more is lost; saving resumes on New or Open.
    autosave.pause(true);
    saveStatus.textContent =
      'Autosave is paused, so the last saved sheet stays untouched. Use Open to work on a project file.';
    saveStatus.className = 'error';
    toast(
      `Your last sheet could not be restored: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
  void requestPersistence();
  renderAll();
  canvasView.fitWidth();
  document.body.dataset['ready'] = 'true';
}

const started = start();
