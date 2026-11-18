import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { filterPaeth } from '@/export/png-filter';

/** Reference decoder for PNG filter type 4, written from the PNG specification. */
function unfilter(filtered: Uint8Array, width: number, rows: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(rows * stride);
  for (let y = 0; y < rows; y++) {
    expect(filtered[y * (stride + 1)]).toBe(4);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = ((filtered[y * (stride + 1) + 1 + x] ?? 0) + predictor) & 255;
    }
  }
  return out;
}

function pattern(width: number, rows: number, bpp: number): Uint8Array {
  const data = new Uint8Array(width * rows * bpp);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + Math.floor(i / 7)) % 256;
  return data;
}

describe('filterPaeth', () => {
  it.each([1, 3, 4])('round-trips every byte at %i bytes per pixel', (bpp) => {
    const data = pattern(13, 9, bpp);
    expect(unfilter(filterPaeth(data, 13, 9, bpp, null), 13, 9, bpp)).toEqual(data);
  });

  it('continues across strips when given the row above', () => {
    const data = pattern(11, 10, 4);
    const stride = 11 * 4;
    const whole = filterPaeth(data, 11, 10, 4, null);
    const top = filterPaeth(data.subarray(0, 4 * stride), 11, 4, 4, null);
    const rest = filterPaeth(
      data.subarray(4 * stride),
      11,
      6,
      4,
      data.subarray(3 * stride, 4 * stride),
    );
    expect(Uint8Array.from([...top, ...rest])).toEqual(whole);
  });

  it('makes a smooth image compress far better than unfiltered rows', () => {
    const width = 400;
    const rows = 400;
    const data = new Uint8Array(width * rows * 3);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < width; x++)
        data.set([x % 256, y % 256, (x + y) % 256], (y * width + x) * 3);
    }
    const plain = new Uint8Array(rows * (width * 3 + 1));
    for (let y = 0; y < rows; y++)
      plain.set(data.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
    const filtered = deflateSync(filterPaeth(data, width, rows, 3, null)).length;
    expect(filtered).toBeLessThan(deflateSync(plain).length / 4);
  });
});
