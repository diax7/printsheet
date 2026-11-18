import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '@/store/store';
import { DEFAULT_SETTINGS, MAX_DESIGNS, type Design, type Sheet } from '@/model/types';

const toasts: string[] = [];
vi.mock('@/editor/dom', () => ({ toast: (message: string) => toasts.push(message) }));
const { flip, moveLeavingCopies, sheetFix, toggleLock } = await import('@/editor/actions');

function design(id: string, over: Partial<Design> = {}): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
    xMm: 50,
    yMm: 50,
    widthMm: 100,
    heightMm: 100,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
    ...over,
  };
}

const sheetOf = (designs: Design[], settings = DEFAULT_SETTINGS): Sheet => ({
  designs,
  settings: { ...settings },
});

beforeEach(() => {
  toasts.length = 0;
});

describe('moveLeavingCopies (Alt + drag)', () => {
  it('moves the originals and leaves unlocked copies where they were, in one undo step', () => {
    const before = sheetOf([design('a'), design('b', { xMm: 200, angleDeg: 30 })]);
    const store = createStore(before);
    moveLeavingCopies(
      store,
      new Map([
        ['a', { xMm: 80, yMm: 90 }],
        ['b', { xMm: 230, yMm: 90 }],
      ]),
    );
    const { sheet, selection } = store.get();
    expect(sheet.designs).toHaveLength(4);
    expect(sheet.designs.find((d) => d.id === 'a')).toMatchObject({ xMm: 80, yMm: 90 });
    const copies = sheet.designs.filter((d) => d.id !== 'a' && d.id !== 'b');
    expect(copies.map((c) => [c.xMm, c.yMm, c.angleDeg, c.locked])).toEqual([
      [50, 50, 0, false],
      [200, 50, 30, false],
    ]);
    // The moved originals stay selected, as they are what the hand is holding.
    expect(selection.toSorted()).toEqual(['a', 'b']);
    store.undo();
    expect(store.get().sheet).toEqual(before);
  });

  it('puts each copy just under its original in the stacking order, not on top', () => {
    const store = createStore(sheetOf([design('a'), design('b'), design('c')]));
    moveLeavingCopies(store, new Map([['b', { xMm: 90 }]]));
    const ids = store.get().sheet.designs.map((d) => d.id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe('a');
    expect(ids[2]).toBe('b');
    expect(ids[3]).toBe('c');
    expect(store.get().sheet.designs[1]).toMatchObject({ xMm: 50, locked: false });
  });

  it('only moves when the sheet has no room for the copies, and says why', () => {
    const full = Array.from({ length: MAX_DESIGNS }, (_, i) => design(`d${i}`));
    const store = createStore(sheetOf(full));
    moveLeavingCopies(store, new Map([['d0', { xMm: 70, yMm: 70 }]]));
    expect(store.get().sheet.designs).toHaveLength(MAX_DESIGNS);
    expect(store.get().sheet.designs[0]).toMatchObject({ xMm: 70, yMm: 70 });
    expect(toasts[0]).toContain(`at most ${MAX_DESIGNS} designs`);
  });
});

describe('toggleLock', () => {
  it('locks all when none is locked, and unlocks all when any is', () => {
    const store = createStore(sheetOf([design('a'), design('b', { locked: true }), design('c')]));
    toggleLock(store, ['a', 'c']);
    expect(store.get().sheet.designs.map((d) => d.locked)).toEqual([true, true, true]);
    toggleLock(store, ['a', 'b']);
    expect(store.get().sheet.designs.map((d) => d.locked)).toEqual([false, false, true]);
  });
});

describe('sheetFix', () => {
  it('offers "Move onto the sheet" for a design past the edge', () => {
    const store = createStore(sheetOf([design('a', { xMm: 560 })]));
    const fix = sheetFix(store, ['a'], new Set(['a']));
    expect(fix?.label).toBe('Move onto the sheet');
    fix?.run();
    expect(store.get().sheet.designs[0]?.xMm).toBeCloseTo(580 - 50, 6);
  });

  it('offers "Move onto a sheet" for a design across a split, and nothing when all is well', () => {
    const settings = { ...DEFAULT_SETTINGS, layout: 'split' as const, pageLengthMm: 300 };
    const crossing = design('a', { yMm: 300 });
    const store = createStore(sheetOf([crossing, design('b')], settings));
    expect(sheetFix(store, ['a', 'b'], new Set())?.label).toBe('Move onto a sheet');
    expect(sheetFix(store, ['b'], new Set())).toBeNull();
  });
});

describe('flip', () => {
  it('flips from the design as it is now, not as it was when the button was made', () => {
    const store = createStore(sheetOf([design('a', { flipY: true })]));
    flip(store, 'a', 'y');
    expect(store.get().sheet.designs[0]?.flipY).toBe(false);
    flip(store, 'a', 'x');
    flip(store, 'a', 'x');
    expect(store.get().sheet.designs[0]?.flipX).toBe(false);
  });

  it('leaves a locked design alone', () => {
    const store = createStore(sheetOf([design('a', { locked: true })]));
    flip(store, 'a', 'x');
    expect(store.get().sheet.designs[0]?.flipX).toBe(false);
  });
});
