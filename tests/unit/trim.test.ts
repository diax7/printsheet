import { describe, expect, it } from 'vitest';
import { hasTransparentPixelsIn, trimBounds } from '@/image/trim';

/** A w×h RGBA image, fully transparent, with the listed pixels set to the given alpha. */
function image(
  w: number,
  h: number,
  opaque: Array<[x: number, y: number, alpha?: number]>,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, alpha = 255] of opaque) data[(y * w + x) * 4 + 3] = alpha;
  return data;
}

function filled(w: number, h: number, alpha: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  return data;
}

describe('trimBounds', () => {
  it('finds the box around the visible pixels', () => {
    const px: Array<[number, number]> = [];
    for (let y = 2; y <= 4; y++) for (let x = 3; x <= 6; x++) px.push([x, y]);
    expect(trimBounds(image(10, 10, px), 10, 10)).toEqual({ x: 3, y: 2, w: 4, h: 3 });
  });

  it('returns null when every pixel is transparent', () => {
    expect(trimBounds(image(10, 10, []), 10, 10)).toBeNull();
  });

  it('keeps the whole image when the edges are visible', () => {
    expect(trimBounds(filled(7, 5, 255), 7, 5)).toEqual({ x: 0, y: 0, w: 7, h: 5 });
  });

  it('keeps a single visible pixel', () => {
    expect(trimBounds(image(10, 10, [[9, 0]]), 10, 10)).toEqual({ x: 9, y: 0, w: 1, h: 1 });
  });

  it('counts a faint pixel (alpha 1) as visible, because it still prints', () => {
    expect(trimBounds(image(4, 4, [[1, 2, 1]]), 4, 4)).toEqual({ x: 1, y: 2, w: 1, h: 1 });
  });

  it('spans pixels at opposite corners', () => {
    expect(
      trimBounds(
        image(5, 6, [
          [0, 5],
          [4, 0],
        ]),
        5,
        6,
      ),
    ).toEqual({ x: 0, y: 0, w: 5, h: 6 });
  });

  it('rejects a buffer that does not match the size', () => {
    expect(() => trimBounds(new Uint8ClampedArray(10), 2, 2)).toThrow(/size/);
  });
});

describe('hasTransparentPixelsIn the whole image', () => {
  it('is false for a fully opaque image', () => {
    expect(hasTransparentPixelsIn(filled(3, 3, 255), 3, { x: 0, y: 0, w: 3, h: 3 })).toBe(false);
  });

  it('is true when any pixel is not fully opaque', () => {
    const data = filled(3, 3, 255);
    data[4 * 4 + 3] = 254;
    expect(hasTransparentPixelsIn(data, 3, { x: 0, y: 0, w: 3, h: 3 })).toBe(true);
  });
});

describe('hasTransparentPixelsIn', () => {
  it('looks only inside the box', () => {
    // 4×4, fully opaque except one transparent pixel at (0, 0).
    const data = filled(4, 4, 255);
    data[3] = 0;
    expect(hasTransparentPixelsIn(data, 4, { x: 1, y: 1, w: 3, h: 3 })).toBe(false);
    expect(hasTransparentPixelsIn(data, 4, { x: 0, y: 0, w: 2, h: 2 })).toBe(true);
  });
});
