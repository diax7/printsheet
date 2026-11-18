import { describe, expect, it } from 'vitest';
import { decode } from 'fast-png';
import { encodePng, crc32 } from '@/export/png-stream';

/** A deterministic RGBA pattern so every pixel can be checked after decoding. */
function pixel(x: number, y: number): [number, number, number, number] {
  return [(x * 7) % 256, (y * 3) % 256, (x + y) % 256, (x * y) % 256];
}

function strip(width: number, y0: number, rows: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y0 + r), (r * width + x) * 4);
  }
  return data;
}

async function encodeAndDecode(width: number, height: number, rowsPerStrip: number, dpi: number) {
  const calls: Array<[number, number]> = [];
  const blob = await encodePng({
    width,
    height,
    dpi,
    rowsPerStrip,
    renderStrip: async (y0, rows) => {
      calls.push([y0, rows]);
      return strip(width, y0, rows);
    },
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { png: decode(bytes), calls, bytes, blob };
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('encodePng', () => {
  it('produces a PNG whose pixels match what was rendered, strip by strip', async () => {
    const { png, calls, blob } = await encodeAndDecode(300, 1000, 128, 300);
    expect(blob.type).toBe('image/png');
    expect(png.width).toBe(300);
    expect(png.height).toBe(1000);
    expect(png.channels).toBe(4);
    expect(png.depth).toBe(8);
    for (const [x, y] of [
      [0, 0],
      [299, 0],
      [17, 127],
      [17, 128],
      [150, 640],
      [299, 999],
    ] as const) {
      const i = (y * 300 + x) * 4;
      expect(Array.from(png.data.slice(i, i + 4))).toEqual(pixel(x, y));
    }
    expect(calls).toHaveLength(8);
    expect(calls[7]).toEqual([896, 104]);
  });

  it('keeps every pixel exact across strip boundaries', async () => {
    const { png } = await encodeAndDecode(37, 50, 7, 300);
    expect(Array.from(png.data)).toEqual(Array.from(strip(37, 0, 50)));
  });

  it('compresses a smooth image to a small file', async () => {
    const width = 600;
    const height = 600;
    const blob = await encodePng({
      width,
      height,
      dpi: 300,
      rowsPerStrip: 64,
      renderStrip: async (y0, rows) => {
        const data = new Uint8ClampedArray(width * rows * 4);
        for (let r = 0; r < rows; r++) {
          for (let x = 0; x < width; x++) {
            const y = y0 + r;
            data.set([x % 256, y % 256, (x + y) % 256, 255], (r * width + x) * 4);
          }
        }
        return data;
      },
    });
    // Unfiltered this gradient deflates to about 150 KB; with row filters it is a few KB.
    expect(blob.size).toBeLessThan(40_000);
  });

  it('writes the resolution so the image opens at print size', async () => {
    const { png } = await encodeAndDecode(10, 10, 4, 300);
    expect(png.resolution).toEqual({ x: 11811, y: 11811, unit: 1 });
  });

  it('handles an image of a single row', async () => {
    const { png } = await encodeAndDecode(5, 1, 512, 150);
    expect(png.height).toBe(1);
    expect(Array.from(png.data.slice(16, 20))).toEqual(pixel(4, 0));
  });

  it('rejects a strip of the wrong size', async () => {
    await expect(
      encodePng({
        width: 4,
        height: 4,
        dpi: 300,
        rowsPerStrip: 2,
        renderStrip: async () => new Uint8ClampedArray(3),
      }),
    ).rejects.toThrow(/strip/);
  });

  it('rejects an empty image', async () => {
    await expect(
      encodePng({
        width: 0,
        height: 4,
        dpi: 300,
        rowsPerStrip: 2,
        renderStrip: async () => new Uint8ClampedArray(),
      }),
    ).rejects.toThrow(/size/);
  });
});
