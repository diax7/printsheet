import { describe, expect, it } from 'vitest';
import { History } from '@/store/history';

describe('History', () => {
  it('undoes and redoes in order', () => {
    const h = new History<number>(0);
    h.push(1);
    h.push(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(1);
    expect(h.redo()).toBe(2);
    expect(h.redo()).toBeNull();
  });

  it('clears the redo steps after a new change', () => {
    const h = new History<string>('a');
    h.push('b');
    h.undo();
    h.push('c');
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe('a');
  });

  it('keeps at most the configured number of steps', () => {
    const h = new History<number>(0, 3);
    for (let i = 1; i <= 10; i++) h.push(i);
    expect(h.undo()).toBe(9);
    expect(h.undo()).toBe(8);
    expect(h.undo()).toBe(7);
    expect(h.undo()).toBeNull();
  });

  it('reports whether undo and redo are possible', () => {
    const h = new History<number>(0);
    expect(h.canUndo).toBe(false);
    h.push(1);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
    h.undo();
    expect(h.canRedo).toBe(true);
  });

  it('starts over from a new present on reset', () => {
    const h = new History<number>(0);
    h.push(1);
    h.reset(5);
    expect(h.canUndo).toBe(false);
    expect(h.present).toBe(5);
  });
});
