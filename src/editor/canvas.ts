/**
 * The sheet on screen. Fabric.js draws and handles the mouse; the store stays the truth.
 *
 * Coordinates: one Fabric scene unit is one millimetre. The canvas element is only as big as the
 * visible area; a spacer in the scroll container has the zoomed sheet's size, and scrolling sets
 * the viewport transform. Nothing ever allocates a canvas the size of a 5 m sheet.
 *
 * Sync rules (from the CTO review):
 *  - Store → view writes absolute values only into objects that are not inside a multi-selection;
 *    when they are, the selection is dropped, values written, and the selection rebuilt.
 *  - View → store happens once per gesture, on `object:modified` (never while dragging).
 *  - Multi-selections only move. Single designs scale uniformly from the corners and rotate.
 *  - Selection events caused by our own sync are ignored (`syncing` guard).
 */
import {
  ActiveSelection,
  Canvas,
  FabricImage,
  Point,
  util,
  type FabricObject,
  type TMat2D,
} from 'fabric';
import { corners, footprint, sheetLengthMm, contentLengthMm, type Box } from '@/model/geometry';
import { normalizeAngle, updateDesigns } from '@/model/ops';
import { formatCm } from '@/model/units';
import type { Design, Sheet } from '@/model/types';
import { loadPreview, readyPreview } from '@/image/previews';
import type { Store } from '@/store/store';
import type { Prefs } from '@/prefs';

/** Screen pixels per millimetre at 100% zoom (CSS 96 px per inch). */
export const PX_PER_MM = 96 / 25.4;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
const MARGIN_PX = 48;
const SNAP_PX = 6;
const ACCENT = '#0086b3';

interface DesignObject extends FabricImage {
  designId?: string;
}

export interface CanvasView {
  zoom(): number;
  setZoom(zoom: number, anchor?: { x: number; y: number }): void;
  fitWidth(): void;
  render(): void;
  /** Scene corners of a design's on-screen object (for tests and checks). */
  objectCorners(id: string): Array<{ x: number; y: number }> | null;
  onZoomChange(fn: (zoom: number) => void): void;
  onViewChange(fn: () => void): void;
  /** The viewport transform (screen px from scene mm), read by the rulers. */
  transform(): TMat2D;
}

interface Guide {
  axis: 'x' | 'y';
  at: number;
}

/** How much of the sheet the scroll area shows: the sheet plus room to drag designs below. */
function viewLengthMm(sheet: Sheet): number {
  const content = contentLengthMm(sheet.designs);
  const base =
    sheet.settings.lengthMode === 'fixed'
      ? Math.max(sheet.settings.fixedLengthMm, content)
      : content;
  return Math.max(base + 300, 600);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Scene box of the object being dragged (a design or a whole selection). */
function sceneBox(obj: FabricObject): Box {
  const pts = obj.getCoords();
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** A hatched red square shown where an image could not be drawn on screen. */
function placeholder(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(184, 50, 42, 0.25)';
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = '#b8322a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 60, 60);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(64, 64);
    ctx.moveTo(64, 0);
    ctx.lineTo(0, 64);
    ctx.stroke();
  }
  return c;
}

export function mountCanvas(
  store: Store,
  prefs: () => Prefs,
  onPreviewError: (name: string) => void,
  elements: {
    scroller: HTMLElement;
    viewport: HTMLElement;
    spacer: HTMLElement;
    canvasEl: HTMLCanvasElement;
  },
): CanvasView {
  const { scroller, viewport, spacer, canvasEl } = elements;
  const canvas = new Canvas(canvasEl, {
    selection: true,
    preserveObjectStacking: true,
    uniformScaling: true,
    enableRetinaScaling: true,
    renderOnAddRemove: false,
    selectionColor: 'rgba(0, 134, 179, 0.12)',
    selectionBorderColor: ACCENT,
    selectionLineWidth: 1,
  });
  canvas.fireMiddleClick = false;

  const objects = new Map<string, DesignObject>();
  const failedPreviews = new Set<string>();
  let zoom = 1;
  let syncing = false;
  let guides: Guide[] = [];
  const zoomListeners: Array<(z: number) => void> = [];
  const viewListeners: Array<() => void> = [];

  const scale = (): number => zoom * PX_PER_MM;

  function originX(sheet: Sheet): number {
    const sheetPx = sheet.settings.sheetWidthMm * scale();
    return sheetPx + 2 * MARGIN_PX < scroller.clientWidth
      ? (scroller.clientWidth - sheetPx) / 2
      : MARGIN_PX;
  }

  function updateViewport(): void {
    const sheet = store.get().sheet;
    const s = scale();
    canvas.setViewportTransform([
      s,
      0,
      0,
      s,
      originX(sheet) - scroller.scrollLeft,
      MARGIN_PX - scroller.scrollTop,
    ]);
    for (const fn of viewListeners) fn();
  }

  function resizeSpacer(): void {
    const sheet = store.get().sheet;
    const s = scale();
    const width = Math.max(sheet.settings.sheetWidthMm * s + 2 * MARGIN_PX, scroller.clientWidth);
    const height = viewLengthMm(sheet) * s + 2 * MARGIN_PX;
    spacer.style.width = `${width}px`;
    spacer.style.height = `${height}px`;
    spacer.style.marginTop = `-${viewport.offsetHeight}px`;
  }

  function resizeCanvas(): void {
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    viewport.style.width = `${width}px`;
    viewport.style.height = `${height}px`;
    canvas.setDimensions({ width, height });
    resizeSpacer();
    updateViewport();
    canvas.requestRenderAll();
  }

  /* ---------- Store → view ---------- */

  function applyDesign(obj: DesignObject, d: Design): void {
    const el = obj.getElement() as HTMLCanvasElement;
    obj.set({
      left: d.xMm,
      top: d.yMm,
      angle: d.angleDeg,
      flipX: d.flipX,
      flipY: d.flipY,
      scaleX: d.widthMm / el.width,
      scaleY: d.heightMm / el.height,
      lockMovementX: d.locked,
      lockMovementY: d.locked,
      lockRotation: d.locked,
      lockScalingX: d.locked,
      lockScalingY: d.locked,
      hasControls: !d.locked,
      hoverCursor: d.locked ? 'not-allowed' : 'move',
    });
    obj.setCoords();
  }

  function createObject(d: Design, element: HTMLCanvasElement): DesignObject {
    const obj = new FabricImage(element, {
      // Fabric 7 defaults to centre origins; set explicitly because the model's x/y is the centre.
      originX: 'center',
      originY: 'center',
      strokeWidth: 0,
      objectCaching: false,
      lockScalingFlip: true,
      lockSkewingX: true,
      lockSkewingY: true,
      centeredRotation: true,
      snapAngle: 15,
      snapThreshold: 3,
      cornerStyle: 'circle',
      cornerColor: '#ffffff',
      cornerStrokeColor: ACCENT,
      borderColor: ACCENT,
      transparentCorners: false,
      cornerSize: 11,
      padding: 0,
    }) as DesignObject;
    // Corners scale uniformly; the side handles would stretch the design, so they are hidden.
    obj.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
    obj.designId = d.id;
    applyDesign(obj, d);
    return obj;
  }

  function activeIds(): string[] {
    return canvas
      .getActiveObjects()
      .map((o) => (o as DesignObject).designId ?? '')
      .filter(Boolean);
  }

  function selectObjects(ids: readonly string[]): void {
    const selected = ids
      .map((id) => objects.get(id))
      .filter((o): o is DesignObject => o !== undefined);
    canvas.discardActiveObject();
    if (selected.length === 1) {
      canvas.setActiveObject(selected[0] as DesignObject);
    } else if (selected.length > 1) {
      // A group holding a locked design cannot be dragged (Fabric would move it with the rest).
      const anyLocked = store.get().sheet.designs.some((d) => d.locked && ids.includes(d.id));
      const group = new ActiveSelection(selected, {
        canvas,
        lockMovementX: anyLocked,
        lockMovementY: anyLocked,
        hoverCursor: anyLocked ? 'not-allowed' : 'move',
        // Multi-selections only move: no scaling or rotating a mixed group (that would skew).
        hasControls: false,
        lockRotation: true,
        lockScalingX: true,
        lockScalingY: true,
        borderColor: ACCENT,
      });
      canvas.setActiveObject(group);
    }
  }

  function sync(): void {
    const { sheet, selection } = store.get();
    syncing = true;
    try {
      const inGroup = canvas.getActiveObject() instanceof ActiveSelection;
      if (inGroup) canvas.discardActiveObject();

      const present = new Set(sheet.designs.map((d) => d.id));
      for (const [id, obj] of objects) {
        if (!present.has(id)) {
          canvas.remove(obj);
          objects.delete(id);
        }
      }
      const assets = store.get().assets;
      sheet.designs.forEach((d, index) => {
        let obj = objects.get(d.id);
        if (!obj) {
          const preview = readyPreview(d.assetId);
          if (!preview && !failedPreviews.has(d.assetId)) {
            const asset = assets.get(d.assetId);
            if (asset) {
              loadPreview(asset).then(
                () => sync(),
                () => {
                  failedPreviews.add(d.assetId);
                  onPreviewError(asset.name);
                  sync();
                },
              );
            }
            return;
          }
          // A design whose preview failed still prints, so it must still be visible: draw a
          // marked placeholder of the right size instead of leaving it off the screen.
          obj = createObject(d, preview ? preview.canvas : placeholder());
          objects.set(d.id, obj);
          canvas.add(obj);
        } else {
          applyDesign(obj, d);
        }
        if (canvas.getObjects().indexOf(obj) !== index) canvas.moveObjectTo(obj, index);
      });

      if (inGroup || !sameSet(activeIds(), selection)) selectObjects(selection);
    } finally {
      syncing = false;
    }
    resizeSpacer();
    updateViewport();
    canvas.requestRenderAll();
  }

  /* ---------- View → store ---------- */

  function designOf(obj: FabricObject): Design | undefined {
    const id = (obj as DesignObject).designId;
    return id ? store.get().sheet.designs.find((d) => d.id === id) : undefined;
  }

  /** The model change for the gesture that just ended, read from the canvas. */
  function gesturePatches(): Map<string, Partial<Design>> | null {
    const active = canvas.getActiveObject();
    if (!active) return null;
    const patches = new Map<string, Partial<Design>>();
    if (active instanceof ActiveSelection) {
      // Children carry positions relative to the group: map each centre through the group's
      // matrix. The group only moves, so angle, size and flips are unchanged.
      const m = active.calcTransformMatrix();
      for (const child of active.getObjects()) {
        const d = designOf(child);
        if (!d) continue;
        const centre = util.transformPoint(new Point(child.left, child.top), m);
        patches.set(d.id, { xMm: centre.x, yMm: centre.y });
      }
    } else {
      const d = designOf(active);
      if (!d) return null;
      const el = (active as FabricImage).getElement() as HTMLCanvasElement;
      patches.set(d.id, {
        xMm: active.left,
        yMm: active.top,
        angleDeg: normalizeAngle(active.angle),
        widthMm: el.width * active.scaleX,
        heightMm: el.height * active.scaleY,
      });
    }
    return patches;
  }

  /**
   * While dragging: snap to the sheet edges, to other designs' edges and to those edges plus the
   * cutting gap; then keep the footprint on the sheet (left, right, top).
   */
  function onMoving(target: FabricObject): void {
    const { sheet } = store.get();
    const moving = new Set(canvas.getActiveObjects().map((o) => (o as DesignObject).designId));
    const others = sheet.designs.filter((d) => !moving.has(d.id)).map(footprint);
    const gap = sheet.settings.gapMm;
    const tolerance = SNAP_PX / scale();
    // Fabric does not refresh cached corners during a drag; without this the box is stale.
    target.setCoords();
    const box = sceneBox(target);
    guides = [];

    const xs = [
      0,
      sheet.settings.sheetWidthMm,
      ...others.flatMap((o) => [o.minX, o.maxX, o.minX - gap, o.maxX + gap]),
    ];
    const ys = [0, ...others.flatMap((o) => [o.minY, o.maxY, o.minY - gap, o.maxY + gap])];
    const snap = (edges: number[], candidates: number[]): { delta: number; at: number } | null => {
      let best: { delta: number; at: number } | null = null;
      for (const edge of edges) {
        for (const c of candidates) {
          const delta = c - edge;
          if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < Math.abs(best.delta)))
            best = { delta, at: c };
        }
      }
      return best;
    };
    const sx = snap([box.minX, box.maxX, (box.minX + box.maxX) / 2], xs);
    const sy = snap([box.minY, box.maxY, (box.minY + box.maxY) / 2], ys);
    let dx = sx?.delta ?? 0;
    let dy = sy?.delta ?? 0;
    if (sx) guides.push({ axis: 'x', at: sx.at });
    if (sy) guides.push({ axis: 'y', at: sy.at });

    // Keep it on the sheet. A design wider than the sheet is held at the left edge.
    const width = sheet.settings.sheetWidthMm;
    if (box.maxX + dx > width) dx = width - box.maxX;
    if (box.minX + dx < 0) dx = -box.minX;
    if (box.minY + dy < 0) dy = -box.minY;
    target.set({ left: target.left + dx, top: target.top + dy });
    target.setCoords();
  }

  canvas.on('object:moving', ({ target }) => onMoving(target));
  canvas.on('object:modified', () => {
    guides = [];
    // Fabric fires this while it is still finishing the transform; committing right here makes
    // sync() drop and rebuild the selection mid-transform, which re-fires events in a loop.
    // Read the result now, commit just after Fabric is done. Events we caused are ignored.
    if (syncing) return;
    const patches = gesturePatches();
    if (patches?.size)
      queueMicrotask(() => store.commit(updateDesigns(store.get().sheet, patches)));
  });
  canvas.on('mouse:up', () => {
    if (guides.length) {
      guides = [];
      canvas.requestRenderAll();
    }
  });
  const onSelection = (): void => {
    if (!syncing) store.setSelection(activeIds());
  };
  canvas.on('selection:created', onSelection);
  canvas.on('selection:updated', onSelection);
  canvas.on('selection:cleared', onSelection);

  /* ---------- Drawing: mat, sheet, grid, labels ---------- */

  function drawBackground(ctx: CanvasRenderingContext2D): void {
    const { sheet } = store.get();
    const p = prefs();
    const v = canvas.viewportTransform;
    const s = v[0];
    const w = canvas.getWidth();
    const h = canvas.getHeight();
    ctx.save();
    ctx.setTransform(canvas.getRetinaScaling(), 0, 0, canvas.getRetinaScaling(), 0, 0);

    // Cutting mat with a centimetre grid that follows the sheet.
    ctx.fillStyle = '#2f5d50';
    ctx.fillRect(0, 0, w, h);
    const step = 10 * s;
    if (step >= 6) {
      ctx.lineWidth = 1;
      const startX = v[4] % step;
      const startY = v[5] % step;
      for (let x = startX, i = Math.round((startX - v[4]) / step); x < w; x += step, i++) {
        ctx.strokeStyle = i % 5 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
      }
      for (let y = startY, i = Math.round((startY - v[5]) / step); y < h; y += step, i++) {
        ctx.strokeStyle = i % 5 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }

    // The film.
    const sheetW = sheet.settings.sheetWidthMm * s;
    const filmLength = viewLengthMm(sheet);
    const x0 = v[4];
    const y0 = v[5];
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, sheetW, filmLength * s);
    ctx.shadowColor = 'transparent';
    if (p.background === 'transparent') {
      const cell = 8;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, sheetW, filmLength * s);
      ctx.clip();
      ctx.fillStyle = '#d9ddd6';
      const firstRow = Math.max(0, Math.floor(-y0 / cell));
      const lastRow = Math.ceil((h - y0) / cell);
      const cols = Math.ceil(sheetW / cell);
      for (let r = firstRow; r <= lastRow; r++) {
        for (let c = r % 2; c < cols; c += 2)
          ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
      }
      ctx.restore();
    } else {
      ctx.fillStyle =
        p.background === 'white' ? '#ffffff' : p.background === 'black' ? '#000000' : p.customColor;
      ctx.fillRect(x0, y0, sheetW, filmLength * s);
    }

    if (p.grid && step >= 4) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, sheetW, filmLength * s);
      ctx.clip();
      const dark = p.background === 'black';
      for (let mm = 10; mm < sheet.settings.sheetWidthMm; mm += 10) {
        ctx.strokeStyle = dark
          ? mm % 50
            ? 'rgba(255,255,255,0.12)'
            : 'rgba(255,255,255,0.25)'
          : mm % 50
            ? 'rgba(0,80,110,0.12)'
            : 'rgba(0,80,110,0.28)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x0 + mm * s) + 0.5, Math.max(y0, 0));
        ctx.lineTo(Math.round(x0 + mm * s) + 0.5, Math.min(y0 + filmLength * s, h));
        ctx.stroke();
      }
      for (let mm = 10; mm < filmLength; mm += 10) {
        const y = y0 + mm * s;
        if (y < 0 || y > h) continue;
        ctx.strokeStyle = dark
          ? mm % 50
            ? 'rgba(255,255,255,0.12)'
            : 'rgba(255,255,255,0.25)'
          : mm % 50
            ? 'rgba(0,80,110,0.12)'
            : 'rgba(0,80,110,0.28)';
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(y) + 0.5);
        ctx.lineTo(x0 + sheetW, Math.round(y) + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Where the film is cut: the end of the content (auto) or the fixed length.
    const cutMm = sheetLengthMm(sheet);
    if (cutMm > 0) {
      const y = y0 + cutMm * s;
      ctx.save();
      ctx.strokeStyle = sheet.settings.lengthMode === 'fixed' ? '#d6338a' : ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(x0 - 16, Math.round(y) + 0.5);
      ctx.lineTo(x0 + sheetW + 16, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `${(cutMm / 1000).toFixed(2)} m`;
      ctx.font = '600 11px Archivo, system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.roundRect(x0 + sheetW + 18, y - 9, tw + 12, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x0 + sheetW + 24, y + 4);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawOverlay(ctx: CanvasRenderingContext2D): void {
    const { sheet, selection } = store.get();
    const v = canvas.viewportTransform;
    const s = v[0];
    const toScreen = (x: number, y: number): [number, number] => [x * s + v[4], y * s + v[5]];
    ctx.save();
    ctx.setTransform(canvas.getRetinaScaling(), 0, 0, canvas.getRetinaScaling(), 0, 0);

    ctx.strokeStyle = '#d6338a';
    ctx.lineWidth = 1;
    for (const g of guides) {
      ctx.beginPath();
      if (g.axis === 'x') {
        const [x] = toScreen(g.at, 0);
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, canvas.getHeight());
      } else {
        const [, y] = toScreen(0, g.at);
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(canvas.getWidth(), Math.round(y) + 0.5);
      }
      ctx.stroke();
    }

    // Size label above the selection, live while dragging a handle.
    const active = canvas.getActiveObject();
    if (active && selection.length > 0) {
      active.setCoords();
      const box = sceneBox(active);
      let label: string;
      if (selection.length === 1 && !(active instanceof ActiveSelection)) {
        const el = (active as FabricImage).getElement() as HTMLCanvasElement;
        label = `${formatCm(el.width * active.scaleX)} × ${formatCm(el.height * active.scaleY)} cm`;
      } else {
        label = `${selection.length} designs, ${formatCm(box.maxX - box.minX)} × ${formatCm(box.maxY - box.minY)} cm`;
      }
      ctx.font = '600 12px Archivo, system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const [cx, top] = toScreen((box.minX + box.maxX) / 2, box.minY);
      const bx = cx - tw / 2 - 8;
      const by = Math.max(4, top - 30);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 16, 22, 11);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, bx + 8, by + 15);
    }

    // Outline designs that hang past the side edges, so the problem is visible on the sheet.
    ctx.strokeStyle = '#b8322a';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    for (const d of sheet.designs) {
      const box = footprint(d);
      if (box.minX < -0.01 || box.maxX > sheet.settings.sheetWidthMm + 0.01 || box.minY < -0.01) {
        const pts = corners(d).map((p) => toScreen(p.x, p.y));
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  canvas.on('before:render', ({ ctx }) => drawBackground(ctx));
  canvas.on('after:render', ({ ctx }) => drawOverlay(ctx));

  /* ---------- Zoom and scroll ---------- */

  function setZoom(next: number, anchor?: { x: number; y: number }): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const sheet = store.get().sheet;
    const ax = anchor?.x ?? scroller.clientWidth / 2;
    const ay = anchor?.y ?? scroller.clientHeight / 2;
    // The scene point under the anchor stays under it.
    const sceneX = (ax - (originX(sheet) - scroller.scrollLeft)) / scale();
    const sceneY = (ay - (MARGIN_PX - scroller.scrollTop)) / scale();
    zoom = clamped;
    resizeSpacer();
    const s = scale();
    scroller.scrollLeft = originX(sheet) + sceneX * s - ax;
    scroller.scrollTop = MARGIN_PX + sceneY * s - ay;
    updateViewport();
    canvas.requestRenderAll();
    for (const fn of zoomListeners) fn(zoom);
  }

  scroller.addEventListener('scroll', () => {
    updateViewport();
    canvas.requestRenderAll();
  });
  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      setZoom(zoom * Math.exp(-event.deltaY * 0.0015), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    { passive: false },
  );
  new ResizeObserver(() => resizeCanvas()).observe(scroller);

  store.subscribe((state, previous) => {
    if (
      state.sheet !== previous.sheet ||
      state.assets !== previous.assets ||
      state.selection !== previous.selection
    )
      sync();
  });

  resizeCanvas();
  sync();

  return {
    zoom: () => zoom,
    setZoom,
    fitWidth() {
      const width = store.get().sheet.settings.sheetWidthMm;
      setZoom((scroller.clientWidth - 2 * MARGIN_PX) / (width * PX_PER_MM));
      scroller.scrollTop = 0;
    },
    render() {
      resizeSpacer();
      updateViewport();
      canvas.requestRenderAll();
    },
    objectCorners(id) {
      const obj = objects.get(id);
      if (!obj) return null;
      // Absolute scene corners even inside a group: map the object's own corners through
      // its full transform.
      const m = obj.calcTransformMatrix();
      const el = obj.getElement() as HTMLCanvasElement;
      const hw = el.width / 2;
      const hh = el.height / 2;
      const local: Array<[number, number]> = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ];
      return local.map(([x, y]) => {
        const p = util.transformPoint(new Point(x, y), m);
        return { x: p.x, y: p.y };
      });
    },
    onZoomChange: (fn) => zoomListeners.push(fn),
    onViewChange: (fn) => viewListeners.push(fn),
    transform: () => canvas.viewportTransform,
  };
}
