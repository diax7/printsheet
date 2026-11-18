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
 *  - Alt + drag leaves copies where the designs started (one commit with the move).
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
import { corners, footprint, type Box } from '@/model/geometry';
import { bandOf, pageCount, MAX_PAGES } from '@/model/pages';
import { drawMat, drawSheets, viewLengthMm } from '@/editor/film';
import { normalizeAngle, updateDesigns } from '@/model/ops';
import { formatCm } from '@/model/units';
import type { Design, Sheet } from '@/model/types';
import { moveLeavingCopies } from '@/editor/actions';
import { drawStayingCopies, mountAltDrag } from '@/editor/alt-drag';
import {
  designAt,
  screenBoxOf,
  touchLandsOnSelection,
  type ScreenBox,
} from '@/editor/canvas-geometry';
import { mountGestureGuard } from '@/editor/gesture-guard';
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

/** Space + drag panning: off, waiting for the mouse (grab cursor), or panning. */
export type PanMode = 'off' | 'ready' | 'panning';

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
  /** Where these designs are on the page (client px), or null when none of them exists. */
  screenBox(ids: readonly string[]): ScreenBox | null;
  /** The id of the topmost design under a page point, or null over empty sheet or mat. */
  targetAt(clientX: number, clientY: number): string | null;
  /**
   * True when a finger at this page point lands on the chosen design (or one of a chosen
   * group) or on its handles, so Fabric should move, scale or rotate it. Sizes the handles'
   * touch areas for the design's size on screen first.
   */
  touchLandsOnSelection(clientX: number, clientY: number): boolean;
  /** Calls off the running Fabric gesture without saving its result (a drag became a pinch). */
  cancelGesture(): void;
  /** Before a new touch: ends, unsaved, anything a lost touch left behind, and redraws. */
  settleGesture(): void;
  /** Scroll the sheet by screen pixels. */
  panBy(dx: number, dy: number): void;
  /** While panning, Fabric finds no targets and draws no selection box. */
  setPanMode(mode: PanMode): void;
  /** Called after every frame Fabric draws. */
  onRender(fn: () => void): void;
  /** Called when a drag, scale or rotate starts (true) and when the mouse is let go (false). */
  onGesture(fn: (active: boolean) => void): void;
}

interface Guide {
  axis: 'x' | 'y';
  at: number;
}

/** Horizontal edges a drag snaps to: the top, and each sheet's top and end in a split job. */
function sheetEdges(sheet: Sheet): number[] {
  if (sheet.settings.layout === 'single') return [0];
  const count = Math.min(pageCount(sheet) + 1, MAX_PAGES);
  return Array.from({ length: count }, (_, i) => bandOf(i, sheet.settings)).flatMap((b) => [
    b.top,
    b.bottom,
  ]);
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
    // The browser's own menu stays on empty canvas; over a design the action bar opens its menu.
    stopContextMenu: false,
  });
  canvas.fireMiddleClick = false;

  const objects = new Map<string, DesignObject>();
  const failedPreviews = new Set<string>();
  let zoom = 1;
  let syncing = false;
  let guides: Guide[] = [];
  const zoomListeners: Array<(z: number) => void> = [];
  const viewListeners: Array<() => void> = [];
  const renderListeners: Array<() => void> = [];
  const gestureListeners: Array<(active: boolean) => void> = [];
  let gestureActive = false;
  const altDrag = mountAltDrag(canvas, store);
  const guard = mountGestureGuard(canvas, () => sync());

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
      // A finger needs a bigger target than the drawn handle (resized to the design on touch).
      touchCornerSize: 44,
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
    const ys = [
      ...sheetEdges(sheet),
      ...others.flatMap((o) => [o.minY, o.maxY, o.minY - gap, o.maxY + gap]),
    ];
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
    if (syncing || guard.suppressing()) return;
    const patches = gesturePatches();
    const copy = altDrag.leaving();
    if (patches?.size)
      queueMicrotask(() =>
        copy
          ? moveLeavingCopies(store, patches)
          : store.commit(updateDesigns(store.get().sheet, patches)),
      );
  });
  const setGesture = (active: boolean): void => {
    if (gestureActive === active) return;
    gestureActive = active;
    for (const fn of gestureListeners) fn(active);
  };
  for (const name of ['object:moving', 'object:scaling', 'object:rotating'] as const)
    canvas.on(name, () => setGesture(true));
  canvas.on('mouse:up', () => {
    setGesture(false);
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
    const v = canvas.viewportTransform;
    ctx.save();
    ctx.setTransform(canvas.getRetinaScaling(), 0, 0, canvas.getRetinaScaling(), 0, 0);
    const view = {
      ctx,
      x0: v[4],
      y0: v[5],
      s: v[0],
      w: canvas.getWidth(),
      h: canvas.getHeight(),
      prefs: prefs(),
      sheetWidthMm: sheet.settings.sheetWidthMm,
    };
    drawMat(view);
    drawSheets(view, sheet);
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

  /** During an Alt + drag the store still holds where the designs started: draw them there. */
  function drawCopiesLeftBehind(ctx: CanvasRenderingContext2D): void {
    const ids = new Set(activeIds());
    const items = store
      .get()
      .sheet.designs.filter((d) => ids.has(d.id))
      .flatMap((d) => {
        const obj = objects.get(d.id);
        return obj ? [{ d, image: obj.getElement() }] : [];
      });
    drawStayingCopies(ctx, canvas.viewportTransform, canvas.getRetinaScaling(), items);
  }

  canvas.on('before:render', ({ ctx }) => {
    drawBackground(ctx);
    if (altDrag.leaving() && gestureActive) drawCopiesLeftBehind(ctx);
  });
  canvas.on('after:render', ({ ctx }) => {
    drawOverlay(ctx);
    for (const fn of renderListeners) fn();
  });

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
    screenBox: (ids) => screenBoxOf(canvas, canvasEl, store, ids),
    targetAt: (clientX, clientY) => designAt(canvas, canvasEl, store, { x: clientX, y: clientY }),
    touchLandsOnSelection: (clientX, clientY) =>
      touchLandsOnSelection(canvas, canvasEl, store, { x: clientX, y: clientY }),
    cancelGesture: () => guard.cancel(),
    settleGesture: () => guard.settle(),
    panBy(dx, dy) {
      scroller.scrollLeft += dx;
      scroller.scrollTop += dy;
    },
    setPanMode(mode) {
      canvas.skipTargetFind = mode !== 'off';
      canvas.selection = mode === 'off';
      canvas.defaultCursor = { off: 'default', ready: 'grab', panning: 'grabbing' }[mode];
      canvas.setCursor(canvas.defaultCursor);
    },
    onRender: (fn) => renderListeners.push(fn),
    onGesture: (fn) => gestureListeners.push(fn),
  };
}
