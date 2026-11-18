import { describe, expect, it } from 'vitest';
import { menuTop } from '@/editor/menu';

// A 200 px menu in an 800 px window, under or over a button from y 400 to 432.
const button = { top: 400, bottom: 432 };
const VIEW = 800;

describe('menuTop', () => {
  it('opens below the button by default', () => {
    expect(menuTop(button, 200, VIEW, 'below')).toBe(438);
  });

  it('opens above the button when asked (the bar sits above the selection)', () => {
    expect(menuTop(button, 200, VIEW, 'above')).toBe(194);
  });

  it('goes to the other side when the preferred side has no room', () => {
    expect(menuTop({ top: 700, bottom: 732 }, 200, VIEW, 'below')).toBe(494);
    expect(menuTop({ top: 100, bottom: 132 }, 200, VIEW, 'above')).toBe(138);
  });

  it('stays inside the window when neither side has room', () => {
    expect(menuTop({ top: 300, bottom: 332 }, 700, VIEW, 'below')).toBe(92);
  });
});
