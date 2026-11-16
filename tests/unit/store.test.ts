import { describe, expect, it, vi } from 'vitest';
import { createStore } from '@/store/store';
import { updateDesign } from '@/model/ops';
import { DEFAULT_SETTINGS, type Design, type Sheet } from '@/model/types';

function design(id: string, x = 50): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
    xMm: x,
    yMm: 50,
    widthMm: 100,
    heightMm: 100,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
  };
}

const empty: Sheet = { designs: [], settings: { ...DEFAULT_SETTINGS } };

describe('store', () => {
  it('records each commit as one undo step', () => {
    const store = createStore(empty);
    store.commit({ ...empty, designs: [design('d1')] });
    store.commit(updateDesign(store.get().sheet, 'd1', { xMm: 80 }));
    expect(store.get().sheet.designs[0]?.xMm).toBe(80);
    store.undo();
    expect(store.get().sheet.designs[0]?.xMm).toBe(50);
    store.undo();
    expect(store.get().sheet.designs).toHaveLength(0);
    store.redo();
    expect(store.get().sheet.designs).toHaveLength(1);
  });

  it('merges quick repeated nudges into one undo step', () => {
    let now = 1000;
    const store = createStore({ ...empty, designs: [design('d1')] }, { now: () => now });
    for (let i = 1; i <= 5; i++) {
      now += 100;
      store.commit(updateDesign(store.get().sheet, 'd1', { xMm: 50 + i }), { mergeKey: 'nudge' });
    }
    expect(store.get().sheet.designs[0]?.xMm).toBe(55);
    store.undo();
    expect(store.get().sheet.designs[0]?.xMm).toBe(50);
  });

  it('starts a new step when the pause between nudges is long', () => {
    let now = 1000;
    const store = createStore({ ...empty, designs: [design('d1')] }, { now: () => now });
    store.commit(updateDesign(store.get().sheet, 'd1', { xMm: 51 }), { mergeKey: 'nudge' });
    now += 2000;
    store.commit(updateDesign(store.get().sheet, 'd1', { xMm: 52 }), { mergeKey: 'nudge' });
    store.undo();
    expect(store.get().sheet.designs[0]?.xMm).toBe(51);
  });

  it('drops selected ids that no longer exist after undo', () => {
    const store = createStore(empty);
    store.commit({ ...empty, designs: [design('d1')] }, { selection: ['d1'] });
    expect(store.get().selection).toEqual(['d1']);
    store.undo();
    expect(store.get().selection).toEqual([]);
  });

  it('notifies listeners with the previous state, and stops after unsubscribe', () => {
    const store = createStore({ ...empty, designs: [design('x')] });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setSelection(['x']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[1].selection).toEqual([]);
    off();
    store.setSelection([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the selection is unchanged', () => {
    const store = createStore({ ...empty, designs: [design('a'), design('b')] });
    store.setSelection(['a', 'b']);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSelection(['b', 'a']);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores selected ids that are not on the sheet', () => {
    const store = createStore(empty);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSelection(['ghost']);
    expect(store.get().selection).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a commit that changes nothing', () => {
    const store = createStore(empty);
    store.commit(store.get().sheet);
    expect(store.canUndo()).toBe(false);
  });

  it('replaces everything and forgets history on load', () => {
    const store = createStore(empty);
    store.commit({ ...empty, designs: [design('d1')] });
    store.load({ ...empty, designs: [design('d9')] }, new Map());
    expect(store.canUndo()).toBe(false);
    expect(store.get().sheet.designs[0]?.id).toBe('d9');
  });

  it('keeps every asset referenced by the sheet or by undo history', () => {
    const store = createStore(empty);
    store.commit({ ...empty, designs: [{ ...design('d1'), assetId: 'a1' }] });
    store.commit({ ...empty, designs: [{ ...design('d2'), assetId: 'a2' }] });
    expect([...store.referencedAssetIds()].toSorted()).toEqual(['a1', 'a2']);
  });
});
