/**
 * Finger gestures on the sheet. Mouse and pen are left to Fabric as before.
 *
 * A finger on the chosen design or its handles belongs to Fabric: it moves, scales or rotates
 * the design. Any other finger belongs to the app: a tap chooses the design under it (or lets go
 * of the choice on empty canvas), a drag pans the sheet (on a design too: dense gang sheets have
 * little empty canvas), and a long press chooses the design and opens its menu. Two fingers pinch
 * to zoom around their midpoint and pan; a second finger on a design being dragged calls the drag
 * off, so the design goes back where it was.
 *
 * Fabric reads touch events (`touchstart` on the canvas, `touchmove`/`touchend` on the
 * document), not pointer events, so the app watches pointer events and keeps the touch events of
 * its own gestures from Fabric. It also cancels them, which stops the browser's mouse events
 * after a tap from reaching Fabric. Pointer events are only watched, never stopped: other parts
 * of the page listen to them. Who owns a touch is decided on its first event, a pointerdown or a
 * touchstart: Chromium sends pointer events first, and WebKit may not.
 */
import type { CanvasView } from '@/editor/canvas';
import { isTyping } from '@/editor/dom';
import {
  LONG_PRESS_MS,
  cancelsLongPress,
  distance,
  midpoint,
  pinchZoom,
  releaseKind,
  startsPan,
  type Spot,
} from '@/editor/gesture-maths';
import type { Store } from '@/store/store';

export interface TouchDeps {
  view: CanvasView;
  store: Store;
  /** The element holding the canvas. */
  surface: HTMLElement;
  /** The sheet's scroll box: pinch anchors are measured from it, and it takes focus. */
  scroller: HTMLElement;
  /** Opens the chosen design's menu at a page point. */
  openMore(at: Spot): void;
}

/** Who handles the current fingers: nobody yet, Fabric, or the app. */
type Owner = 'none' | 'fabric' | 'app';

interface Gesture {
  owner: Owner;
  fingers: Map<number, Spot>;
  start: (Spot & { time: number; target: string | null }) | null;
  panning: boolean;
  /** A long press fired or a pinch ended: the remaining fingers do nothing until they lift. */
  done: boolean;
  /** The sheet point (mm) under the fingers' midpoint when the pinch began, kept under it. */
  pinch: { distance: number; zoom: number; anchor: Spot } | null;
  /** A second finger (or a cancelled touch) called Fabric's drag off. */
  fabricCalledOff: boolean;
  timer: number;
  /** Where and when the first finger landed, so its second event does not start again. */
  began: (Spot & { time: number }) | null;
}

/** The pointerdown and touchstart of one finger come this close together. */
const SAME_TOUCH_MS = 50;
const SAME_TOUCH_PX = 10;

const idle = (): Gesture => ({
  owner: 'none',
  fingers: new Map(),
  start: null,
  panning: false,
  done: false,
  pinch: null,
  fabricCalledOff: false,
  timer: 0,
  began: null,
});

const spotOf = (event: PointerEvent): Spot => ({ x: event.clientX, y: event.clientY });

/** True for the touch events Fabric must not see. */
function keptFromFabric(g: Gesture, event: TouchEvent): boolean {
  if (g.owner === 'app') return true;
  if (g.owner !== 'fabric') return false;
  if (!g.fabricCalledOff) return event.type === 'touchstart' && event.touches.length > 1;
  // Fabric still has to see the last finger lift, or its drag would never end.
  const lastLift = event.type === 'touchend' && event.touches.length === 0;
  return !lastLift;
}

/** The gesture state with what it acts on; `g` is replaced when a new gesture begins. */
interface Ctx {
  deps: TouchDeps;
  g: Gesture;
}

function reset(ctx: Ctx): void {
  window.clearTimeout(ctx.g.timer);
  ctx.g = idle();
}

/** The sheet point (mm) under a page point. */
function toScene(deps: TouchDeps, at: Spot): Spot {
  const v = deps.view.transform();
  const box = deps.surface.getBoundingClientRect();
  return { x: (at.x - box.left - v[4]) / v[0], y: (at.y - box.top - v[5]) / v[3] };
}

/** The page point over a sheet point (mm). */
function toPage(deps: TouchDeps, at: Spot): Spot {
  const v = deps.view.transform();
  const box = deps.surface.getBoundingClientRect();
  return { x: box.left + at.x * v[0] + v[4], y: box.top + at.y * v[3] + v[5] };
}

function longPress(ctx: Ctx): void {
  ctx.g.done = true;
  const start = ctx.g.start;
  if (!start?.target) return;
  // Its own menu: the design is chosen first, so the menu acts on it.
  ctx.deps.store.setSelection([start.target]);
  ctx.deps.openMore(start);
}

/** True when this is the other first event (pointer or touch) of the finger already begun. */
function sameFinger(g: Gesture, at: Spot): boolean {
  const began = g.began;
  if (g.owner === 'none' || !began) return false;
  return performance.now() - began.time < SAME_TOUCH_MS && distance(began, at) < SAME_TOUCH_PX;
}

/** A first finger: Fabric's when it lands on the chosen design or its handles, else the app's. */
function begin(ctx: Ctx, at: Spot): void {
  if (sameFinger(ctx.g, at)) return;
  reset(ctx);
  const { view, scroller } = ctx.deps;
  // Anything a lost touch left behind (a drag never ended) goes first, unsaved.
  view.settleGesture();
  const g = ctx.g;
  g.began = { ...at, time: performance.now() };
  if (view.touchLandsOnSelection(at.x, at.y)) {
    g.owner = 'fabric';
    return;
  }
  g.owner = 'app';
  // The cancelled touch does not move focus: a field in a sheet must still let go.
  if (isTyping()) scroller.focus({ preventScroll: true });
  g.start = { ...at, time: performance.now(), target: view.targetAt(at.x, at.y) };
  if (g.start.target) g.timer = window.setTimeout(() => longPress(ctx), LONG_PRESS_MS);
}

function startPinch(ctx: Ctx): void {
  const g = ctx.g;
  window.clearTimeout(g.timer);
  if (g.owner === 'fabric' && !g.fabricCalledOff) {
    ctx.deps.view.cancelGesture();
    g.fabricCalledOff = true;
  }
  const [a, b] = [...g.fingers.values()];
  if (!a || !b) return;
  const anchor = toScene(ctx.deps, midpoint(a, b));
  g.pinch = { distance: distance(a, b), zoom: ctx.deps.view.zoom(), anchor };
}

function movePinch(ctx: Ctx): void {
  const { view, scroller } = ctx.deps;
  const [a, b] = [...ctx.g.fingers.values()];
  const pinch = ctx.g.pinch;
  if (!a || !b || !pinch) return;
  const mid = midpoint(a, b);
  const box = scroller.getBoundingClientRect();
  view.setZoom(pinchZoom(pinch.zoom, pinch.distance, distance(a, b)), {
    x: mid.x - box.left,
    y: mid.y - box.top,
  });
  // Then the point first under the fingers goes back under them, measured from the start each
  // time so the rounding of scroll positions does not add up over a long pinch.
  const now = toPage(ctx.deps, pinch.anchor);
  view.panBy(now.x - mid.x, now.y - mid.y);
}

function moveOne(ctx: Ctx, from: Spot, to: Spot): void {
  const g = ctx.g;
  const start = g.start;
  if (g.owner !== 'app' || g.done || !start) return;
  const moved = distance(start, to);
  if (cancelsLongPress(moved)) window.clearTimeout(g.timer);
  if (g.panning) ctx.deps.view.panBy(from.x - to.x, from.y - to.y);
  else if (startsPan(moved)) {
    g.panning = true;
    ctx.deps.view.panBy(start.x - to.x, start.y - to.y);
  }
}

/** The last finger lifted: a tap chooses the design under it, or lets go on empty canvas. */
function finish(ctx: Ctx, at: Spot): void {
  const g = ctx.g;
  const start = g.start;
  const tapped =
    g.owner === 'app' &&
    start &&
    !g.done &&
    !g.panning &&
    releaseKind(distance(start, at), performance.now() - start.time) === 'tap';
  if (tapped) ctx.deps.store.setSelection(start.target ? [start.target] : []);
  reset(ctx);
}

function lift(ctx: Ctx, event: PointerEvent): void {
  const g = ctx.g;
  if (event.pointerType !== 'touch' || !g.fingers.delete(event.pointerId)) return;
  window.clearTimeout(g.timer);
  if (g.fingers.size === 0) finish(ctx, spotOf(event));
  else if (g.pinch) {
    g.pinch = null;
    g.done = true;
  }
}

/** Follows the fingers through pointer events, which are watched only, never stopped. */
function watchFingers(ctx: Ctx): void {
  const { surface } = ctx.deps;
  const capture = { capture: true };
  surface.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType !== 'touch') return;
      // The first finger starts a new gesture (which forgets the last one), then is counted.
      if (ctx.g.fingers.size === 0) begin(ctx, spotOf(event));
      ctx.g.fingers.set(event.pointerId, spotOf(event));
      if (ctx.g.fingers.size === 2) startPinch(ctx);
    },
    capture,
  );
  surface.addEventListener(
    'pointermove',
    (event) => {
      const from = ctx.g.fingers.get(event.pointerId);
      if (event.pointerType !== 'touch' || !from) return;
      ctx.g.fingers.set(event.pointerId, spotOf(event));
      if (ctx.g.pinch && ctx.g.fingers.size >= 2) movePinch(ctx);
      else moveOne(ctx, from, spotOf(event));
    },
    capture,
  );
  surface.addEventListener('pointerup', (event) => lift(ctx, event), capture);
  surface.addEventListener(
    'pointercancel',
    (event) => {
      if (event.pointerType === 'touch') abandon(ctx, event.target, spotOf(event));
    },
    capture,
  );
}

/**
 * Fabric listens for no cancelled touches: hand it the end of its touch instead, so it ends its
 * transform (unsaved, as the gesture was called off) and forgets the finger.
 */
function endFabricTouch(target: EventTarget | null, at: Spot): void {
  if (!(target instanceof Element) || typeof Touch === 'undefined') return;
  let finger: Touch;
  try {
    finger = new Touch({ identifier: 0, target, clientX: at.x, clientY: at.y });
  } catch {
    // iPhone Safari has Touch but no usable constructor ("Illegal constructor"). Nothing is
    // lost: settleGesture() at the next touch ends the transform unsaved and clears the finger.
    return;
  }
  target.dispatchEvent(
    new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [finger],
    }),
  );
}

/** The browser cut the touch off: a Fabric drag goes back to where the store has it. */
function abandon(ctx: Ctx, target: EventTarget | null, at: Spot): void {
  try {
    if (ctx.g.owner === 'fabric') {
      ctx.deps.view.cancelGesture();
      ctx.g.fabricCalledOff = true;
      endFabricTouch(target, at);
    }
  } finally {
    // Whatever happened above, the cut-off finger is forgotten: a finger left behind would make
    // every later touch look like the second finger of a pinch.
    reset(ctx);
  }
}

const touchSpot = (event: TouchEvent): Spot => {
  const finger = event.changedTouches[0];
  return { x: finger?.clientX ?? 0, y: finger?.clientY ?? 0 };
};

/** Keeps the touch events of the app's own gestures from Fabric (and from the browser). */
function guardFabric(ctx: Ctx): void {
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    ctx.deps.surface.addEventListener(
      type,
      (event) => {
        if (type === 'touchcancel') return abandon(ctx, event.target, touchSpot(event));
        // The touch came before its pointer event: decide who owns it now, before Fabric sees it.
        if (type === 'touchstart' && ctx.g.fingers.size === 0) begin(ctx, touchSpot(event));
        if (!keptFromFabric(ctx.g, event)) return;
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
      },
      { capture: true, passive: false },
    );
  }
}

/**
 * A touch opens no browser menu (Android's long press) and not the right-click menu: the app's
 * own long press is the only menu a finger opens. A mouse right-click still opens it.
 */
function blockTouchMenus(): void {
  let lastPointerType = '';
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastPointerType = event.pointerType;
    },
    { capture: true },
  );
  window.addEventListener(
    'contextmenu',
    (event) => {
      if (lastPointerType !== 'touch') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
}

/** Wires the finger gestures on `deps.surface`. */
export function mountTouch(deps: TouchDeps): void {
  const ctx: Ctx = { deps, g: idle() };
  watchFingers(ctx);
  guardFabric(ctx);
  blockTouchMenus();
}
