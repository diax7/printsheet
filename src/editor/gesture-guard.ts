/**
 * Calling off a Fabric gesture half way: when a second finger lands on a design being dragged,
 * the drag becomes a pinch; when the browser cuts a touch off, the drag stops. Fabric still ends
 * its transform its own way, but that end must not be saved: the store keeps where the design
 * was, and the canvas is drawn from the store again once Fabric is done.
 */
import type { Canvas } from 'fabric';

export interface GestureGuard {
  /** Calls off the running gesture: its end is not committed, and the view is redrawn after. */
  cancel(): void;
  /** True between `cancel()` and the end of that gesture. */
  suppressing(): boolean;
  /**
   * Between gestures: anything a lost touch left behind (a call-off whose gesture never ended,
   * or a transform still running) is ended unsaved, and the view is redrawn from the store now.
   */
  settle(): void;
}

export function mountGestureGuard(canvas: Canvas, redraw: () => void): GestureGuard {
  let suppress = false;
  // Fabric has no public way to ask whether it is transforming; its own events tell.
  let transforming = false;
  canvas.on('before:transform', () => {
    transforming = true;
  });
  canvas.on('mouse:up', () => {
    transforming = false;
    if (!suppress) return;
    suppress = false;
    // After Fabric has finished its own work for this event (see the canvas's commit).
    queueMicrotask(redraw);
  });
  return {
    cancel: () => {
      suppress = true;
    },
    suppressing: () => suppress,
    settle() {
      if (!suppress && !transforming) return;
      if (transforming) {
        suppress = true;
        canvas.endCurrentTransform();
        transforming = false;
        // A touch Fabric never saw end leaves its finger id behind, and Fabric would ignore the
        // next touch as not its main one. It is a Fabric internal, cleared here because Fabric
        // has no handling of a cancelled touch.
        delete (canvas as unknown as { mainTouchId?: number }).mainTouchId;
      }
      suppress = false;
      redraw();
    },
  };
}
