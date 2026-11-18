import { describe, expect, it } from 'vitest';
import { bleedTransparent, BLEED_DEPTH } from '@/export/bleed';

function rgbaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return Array.from(data.subarray(i, i + 4));
}

describe('bleedTransparent', () => {
  it('gives each fully transparent pixel the colour of the nearest visible one, alpha kept', () => {
    // 5×1: red, then three transparent black pixels, then blue.
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255,
    ]);
    bleedTransparent(data, 5, 1);
    expect(rgbaAt(data, 5, 1, 0)).toEqual([255, 0, 0, 0]);
    expect(rgbaAt(data, 5, 3, 0)).toEqual([0, 0, 255, 0]);
    expect(rgbaAt(data, 5, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('fills every transparent pixel that shares an 8×8 JPEG block with a visible pixel', () => {
    const width = 48;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [x, y] of [
      [0, 0],
      [23, 17],
      [47, 39],
      [31, 8],
    ] as const) {
      data.set([10, 200, 30, 255], (y * width + x) * 4);
    }
    bleedTransparent(data, width, height);
    for (const [bx, by] of [
      [0, 0],
      [16, 16],
      [40, 32],
      [24, 8],
    ] as const) {
      for (let y = by; y < by + 8; y++) {
        for (let x = bx; x < bx + 8; x++) {
          expect(rgbaAt(data, width, x, y).slice(0, 3)).toEqual([10, 200, 30]);
        }
      }
    }
    expect(BLEED_DEPTH).toBeGreaterThanOrEqual(14);
  });

  it('keeps the colour and alpha of visible pixels, even faint ones', () => {
    const data = new Uint8ClampedArray([200, 100, 50, 1, 0, 0, 0, 0]);
    bleedTransparent(data, 2, 1);
    expect(rgbaAt(data, 2, 0, 0)).toEqual([200, 100, 50, 1]);
    expect(rgbaAt(data, 2, 1, 0)).toEqual([200, 100, 50, 0]);
  });

  it('leaves a fully transparent image unchanged', () => {
    const data = new Uint8ClampedArray(3 * 2 * 4);
    bleedTransparent(data, 3, 2);
    expect(data.every((v) => v === 0)).toBe(true);
  });

  it('rejects pixel data of the wrong size', () => {
    expect(() => bleedTransparent(new Uint8ClampedArray(12), 2, 2)).toThrow(/size/);
  });
});
