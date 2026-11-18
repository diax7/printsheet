import { describe, expect, it } from 'vitest';
import {
  LONG_PRESS_MS,
  cancelsLongPress,
  distance,
  midpoint,
  pinchZoom,
  releaseKind,
  startsPan,
} from '@/editor/gesture-maths';

describe('a one-finger touch', () => {
  it('is a tap when short and still: under 10 px and 300 ms', () => {
    expect(releaseKind(0, 120)).toBe('tap');
    expect(releaseKind(9, 299)).toBe('tap');
  });

  it('is nothing when held still too long for a tap (a long press acts on its own timer)', () => {
    expect(releaseKind(3, 300)).toBe('none');
    expect(releaseKind(3, 900)).toBe('none');
  });

  it('pans once it has moved 10 px, and a moved finger is never a tap', () => {
    expect(startsPan(9.9)).toBe(false);
    expect(startsPan(10)).toBe(true);
    expect(releaseKind(10, 50)).toBe('none');
  });

  it('cancels a long press past 8 px of movement', () => {
    expect(LONG_PRESS_MS).toBe(600);
    expect(cancelsLongPress(8)).toBe(false);
    expect(cancelsLongPress(8.1)).toBe(true);
  });
});

describe('two fingers', () => {
  it('measures the distance and midpoint between them', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 130, y: 140 };
    expect(distance(a, b)).toBe(50);
    expect(midpoint(a, b)).toEqual({ x: 115, y: 120 });
  });

  it('zooms by how far the fingers spread from where they started', () => {
    expect(pinchZoom(0.5, 100, 200)).toBe(1);
    expect(pinchZoom(0.5, 100, 50)).toBe(0.25);
  });

  it('keeps the zoom when the fingers start on the same spot', () => {
    expect(pinchZoom(0.5, 0, 80)).toBe(0.5);
  });
});
