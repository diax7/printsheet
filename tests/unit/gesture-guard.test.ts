import { describe, expect, it } from 'vitest';
import type { Canvas } from 'fabric';
import { mountGestureGuard } from '@/editor/gesture-guard';

/** Just enough of a Fabric canvas: its events, and ending a transform. */
function fakeCanvas(): {
  canvas: Canvas;
  fire(name: string): void;
  ended: () => number;
} {
  const handlers = new Map<string, Array<() => void>>();
  let ended = 0;
  const canvas = {
    on(name: string, fn: () => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    endCurrentTransform() {
      ended++;
    },
  } as unknown as Canvas;
  return {
    canvas,
    fire: (name) => {
      for (const fn of handlers.get(name) ?? []) fn();
    },
    ended: () => ended,
  };
}

const tick = (): Promise<void> => new Promise((done) => queueMicrotask(done));

describe('mountGestureGuard', () => {
  it('suppresses the end of a called-off gesture and redraws after it', async () => {
    const fake = fakeCanvas();
    let redraws = 0;
    const guard = mountGestureGuard(fake.canvas, () => redraws++);
    fake.fire('before:transform');
    guard.cancel();
    expect(guard.suppressing()).toBe(true);
    fake.fire('mouse:up');
    expect(guard.suppressing()).toBe(false);
    await tick();
    expect(redraws).toBe(1);
  });

  it('settling with nothing left behind does nothing', () => {
    const fake = fakeCanvas();
    let redraws = 0;
    const guard = mountGestureGuard(fake.canvas, () => redraws++);
    guard.settle();
    expect(redraws).toBe(0);
    expect(fake.ended()).toBe(0);
  });

  it('settling clears a cancel whose gesture never ended, and redraws at once', () => {
    const fake = fakeCanvas();
    let redraws = 0;
    const guard = mountGestureGuard(fake.canvas, () => redraws++);
    guard.cancel();
    guard.settle();
    expect(guard.suppressing()).toBe(false);
    expect(redraws).toBe(1);
  });

  it('settling ends a transform a lost touch left running, unsaved', () => {
    const fake = fakeCanvas();
    let redraws = 0;
    let suppressedAtEnd = false;
    const guard = mountGestureGuard(fake.canvas, () => redraws++);
    fake.fire('before:transform');
    // The finger Fabric is still following: a lost touch never told it the finger is gone.
    Object.assign(fake.canvas, { mainTouchId: 3 });
    const end = fake.canvas.endCurrentTransform.bind(fake.canvas);
    fake.canvas.endCurrentTransform = () => {
      suppressedAtEnd = guard.suppressing();
      end();
    };
    guard.settle();
    expect(fake.ended()).toBe(1);
    expect(suppressedAtEnd).toBe(true);
    expect('mainTouchId' in fake.canvas).toBe(false);
    expect(guard.suppressing()).toBe(false);
    expect(redraws).toBe(1);
  });
});
